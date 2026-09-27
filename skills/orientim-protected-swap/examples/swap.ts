/**
 * A protected swap through the Orientim agent API, end to end: prepare → verify → sign as the wallet →
 * finalize → confirm, with every chain read on your own RPC. Needs @solana/kit 8 and nothing else:
 * the verifier ships with the skill (../lib/orientim-verify.mjs).
 *
 * The check before signing is the point. Orientim's server builds the transaction, so the agent runs
 * Orientim's full verifier on the exact bytes, against chain state from its own RPC, with the policy
 * held to its own intent and limits. A compromised server, relay or impostor URL can then refuse or
 * delay a swap, never make the wallet sign one that moves more than the approved amount. The price
 * is held to a floor of the agent's own: `--min-out`, or one this script asks Jupiter for itself.
 *
 * After signing, the chain is the only witness. The transaction's id is the wallet's own signature,
 * known before finalize; the outcome is read for that id on your RPC, whatever finalize answers or
 * fails to answer, so a lost answer or a lying server can neither fake a success nor start a second
 * swap while the first one could still land.
 *
 *   ORIENTIM_API_URL=https://<orientim host>  ORIENTIM_API_KEY=ori_...  SOLANA_RPC_URL=https://<your rpc>
 *   ORIENTIM_WALLET_KEYPAIR=/path/to/keypair.json   (a solana-keygen file; never paste a key in a prompt)
 *                                                a wallet held by a signing service: see signerFromSignBytes
 *                                                and signerFromSignTransaction; bots in other languages:
 *                                                bin/orientim-verify.mjs
 *   ORIENTIM_TREASURY=<address>                     (optional: only for another Orientim deployment;
 *                                                Orientim's own treasury is pinned in the skill)
 *   JUPITER_API_KEY=...                          (for your own price: Jupiter throttles keyless calls after one or two)
 *   ORIENTIM_POLICY=/path/to/policy.json         (optional: the owner's limits per swap and per day; see OwnerPolicy)
 *
 *   node swap.ts --in <mint> --out <mint> --amount <base units> --id <order id> [--slippage-bps N] [--max-price-impact-bps N]
 *                [--min-out <base units>] [--max-below-bps N] [--max-fee-bps 30] [--max-route-cost-lamports N] [--accept-cost-bps N] [--v1]
 *   (without --slippage-bps the tolerance is automatic: 0.5%, or 3% on a Pump.fun curve; above 5% price impact, refused)
 *   node swap.ts ... --owner <address> --dry-run      prepare and verify only: nothing is signed
 *
 * Unattended, the command line keeps every signed swap in a state directory (ORIENTIM_STATE_DIR or
 * --state, default ./.orientim-state) before finalize, settles what a stopped run left there before it
 * starts another, and holds a lock per wallet so that two workers never swap from it at once.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKeyPairSignerFromBytes, createSolanaRpc, getCompiledTransactionMessageDecoder, getPublicKeyFromAddress,
  getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder, verifySignature,
} from '@solana/kit';
import type { Address, Rpc, SignatureBytes, SignatureDictionary, SolanaRpcApi, Transaction, TransactionPartialSigner } from '@solana/kit';
import {
  DEFAULT_MAX_PRICE_IMPACT_BPS, feeLimitBps, inputTransferFee, isSlippageBps, MAX_BELOW_BPS, MAX_PRICE_IMPACT_BPS, MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS,
  ownQuote, ownSolFeeLimit, pastProof,
  provesNeverLanded, tokenNotices, verifyPrepared,
} from '../lib/orientim-verify.mjs';

export type Intent = {
  owner: string;
  inputMint: string;
  outputMint: string;
  /** Base units, as a string. */
  amountIn: string;
  /**
   * Your own floor for the output, base units; Orientim never enforces less. Required by the check;
   * `protectedSwap` asks Jupiter for one when it is missing (see `ownMinimum`).
   */
  minOut?: string;
  /**
   * For the floor asked of Jupiter: how far below its price, in bps (default 2%, 5% on a Pump.fun curve;
   * with `slippageBps`, that tolerance and 1.5% more, 2% on a curve).
   */
  maxBelowBps?: number;
  /** The highest Orientim fee you accept, in bps (Orientim's is 30: anything above is refused by default). */
  maxFeeBps?: number;
  /** The highest network fee you accept, in lamports. */
  maxNetworkFeeLamports?: number;
  /** The only wallet the fee may go to: Orientim's own (pinned in the skill) unless set. */
  treasury?: string;
  /** The most market rent that does not come back you accept, in lamports (default 0.001 SOL). */
  maxRouteCostLamports?: number;
  /**
   * The most Orientim's fee may be when it is paid in SOL from the wallet (a swap between two tokens
   * neither of which can carry it). `protectedSwap` asks Jupiter for your own when it is missing.
   */
  maxSolFeeLamports?: number;
  /**
   * One ceiling for all the SOL the swap may cost and not return, in lamports: the network fee up to
   * its enforced cap, rent the route keeps, and Orientim's fee when paid in SOL (optional).
   */
  maxSolCostLamports?: number;
  /** A gap to the open market the user already accepted, from a `costs-more` answer (bps, as a string). */
  acceptCostBps?: string;
  /**
   * The route's slippage tolerance, as a person chooses it on the page: how far below the quote the
   * swap may fill, 10 to 1500 bps. Unset: 0.5%, or 3% on a Pump.fun bonding curve. The route is built
   * at it, and the check holds the route to it; your own floor follows it (1.5% below, 2% on a curve).
   */
  slippageBps?: number;
  /**
   * The most this amount may move the market, in bps (default 500: 5%). Above it the swap is refused
   * before anything is prepared (`PriceImpactError`): the mark of thin liquidity, as when a token's
   * pool is being drained. The page asks a person at the same point.
   */
  maxPriceImpactBps?: number;
  /** 1 for a v1 transaction, where the deployment offers it; 0 (the default) otherwise. */
  version?: 0 | 1;
  /**
   * Your order's own id, the same on every retry of that order. With an order
   * book (`createFileStore`, or one of your own shared by every worker), an order that confirmed or
   * whose last transaction could still land is never swapped again: the same transaction lands only
   * once, and the id keeps a second, different transaction from carrying out the same order.
   */
  id?: string;
};

export type Prepared = {
  ticket: string;
  transaction: string;
  messageSha256: string;
  wallet: string;
  temporaryAuthority: string;
  lastValidBlockHeight: string;
  /** Blocks left in the transaction's life when prepare answered (150 at most, about 40 s). */
  blocksLeft?: string;
  /**
   * `fee` is in `feeMint`: SOL first, then USDC or USDT, on whichever side; otherwise the input token.
   * `minOut` is what the wallet keeps at least, after a fee taken from the output.
   */
  amounts: { amountIn: string; fee: string; feeMint?: string; feeBps: string; swapAmount: string; quotedOut: string; minOut: string; priceImpactPct?: number };
  /**
   * `keptSolLamports`: the SOL the swap costs and does not return (the network fee, rent the route
   * keeps, Orientim's fee when paid in SOL). A new output account's rent is apart: it stays the wallet's.
   */
  costs: { networkFeeLamports: string; outputAccountRentLamports: string; routeRentLamports: string; routeRefundLamports: string; keptSolLamports?: string };
  certificate: {
    messageSha256: string; wallet: string; temporaryAuthority: string;
    input: { mint: string; totalDebit: string; orientimFee: string };
    output: { mint: string; minimumOutput: string; orientimFee?: string };
    /** Orientim's fee when it is paid in SOL from the wallet; 0 otherwise. */
    solFee?: { lamports: string; destination: string | null };
  };
  /** What the transaction was built against; held to your intent by the check, never trusted. */
  policy: Record<string, unknown>;
};

/** What finalize answers. Its word is not evidence: the example reads the outcome from the chain. */
export type Finalized = {
  signature: string;
  status: 'sent' | 'unknown' | 'rejected';
  refusal?: string;
  signedTransaction?: string;
  lastValidBlockHeight: string;
};

export type ApiError = { status: number; code: string; message: string; body: Record<string, unknown>; retryAfter?: number | null };

/**
 * What each error code means, in the skill's own words. An agent reads an error to
 * decide what to do next, so the words it reads are these, never the server's: a compromised server
 * or relay could otherwise write instructions into an error ("call transfer ..."). The server's own
 * text is kept apart, cut to one short line, as `serverMessage`, and marked as untrusted.
 */
export const ERROR_MEANINGS: Readonly<Record<string, string>> = {
  'price-moved': 'The market no longer meets your minimum. Ask the user before preparing again with minOut set to newMinOut.',
  'costs-more': 'The protected route costs more than the open market. Ask the user; to accept, prepare again with acceptCostBps set to gapBps.',
  'output-balance-changed': 'Your balance of the output token changed since prepare, so nothing was signed. Settle what may still land, then prepare again.',
  busy: 'Orientim is busy. Wait the Retry-After seconds, then try again.',
  unavailable: 'Orientim is unavailable. Wait the Retry-After seconds, then try again.',
  'rate-limited': 'Too many requests. Wait the Retry-After seconds, then try again.',
  expired: 'The transaction expired before it was signed by Orientim. Settle what may still land, then prepare again.',
  'route-format': 'Jupiter changed its format and Orientim cannot read it yet. Wait at least the Retry-After seconds.',
  paused: 'Orientim has paused swaps; funds are not affected. Try later.',
  'fee-unavailable': 'Orientim cannot collect its fee on this swap right now, so it built nothing. Wait the Retry-After seconds.',
  'amount-too-small': 'The amount is below the smallest swap Orientim takes. Swap a larger amount.',
  'skill-outdated': 'This copy of the skill is too old. Replace the skill folder with the current one.',
  'transaction-changed': 'The signed transaction differs from the one prepared. Sign exactly what prepare returned.',
  'wallet-changed-transaction': 'The wallet changed the transaction or did not sign it. Sign exactly what prepare returned.',
  'unsupported-token': 'This token cannot be swapped safely now.',
  'no-route': 'No protected route was found for this swap now.',
  'insufficient-sol': 'The wallet does not hold enough SOL for this swap.',
  'insufficient-balance': 'The wallet does not hold enough of the input token.',
  'simulation-failed': 'The swap failed in simulation, so nothing was built.',
  'bad-request': 'Orientim could not read the request.',
  unauthorized: 'The API key was refused.',
  'not-found': 'Orientim does not know this request.',
};

const CODE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** An error code as data: Orientim's own shape, or `other`. */
export const safeCode = (code: unknown) => (typeof code === 'string' && CODE.test(code) ? code : 'other');
/** Text from a server, as one short printable line, for a person to read: never instructions. */
export const untrustedLine = (text: unknown) =>
  typeof text === 'string' ? text.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
/**
 * Only data: numbers, booleans, null, and strings with no spaces or control characters (amounts,
 * addresses, base64, codes), in objects and arrays of the same. Anything else, prose included, is
 * dropped. What a server sends reaches the agent through this.
 */
export function dataOnly(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return /^[\x21-\x7e]{0,4096}$/.test(value) ? value : undefined;
  if (depth > 6) return undefined;
  if (Array.isArray(value)) return value.map(v => dataOnly(v, depth + 1)).filter(v => v !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const kept = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(k) ? dataOnly(v, depth + 1) : undefined;
      if (kept !== undefined) out[k] = kept;
    }
    return out;
  }
  return undefined;
}

export class OrientimApiError extends Error {
  readonly status: number;
  /** Orientim's error code, or `other` for one it does not have. */
  readonly code: string;
  /** The answer's data fields only (`newMinOut`, `gapBps`, `signature`...): no prose. */
  readonly body: Record<string, unknown>;
  /** The server's own words, one short line: untrusted, for a person to read, never to act on. */
  readonly serverMessage: string;
  /** Seconds to wait before asking again, from the answer's Retry-After header; null without one. */
  readonly retryAfter: number | null;
  constructor(e: ApiError) {
    const code = safeCode(e.code);
    super(`${Number(e.status) || 0} ${code}: ${ERROR_MEANINGS[code] ?? 'Orientim refused this request; this request signed and sent nothing.'}`);
    this.status = Number(e.status) || 0;
    this.code = code;
    const { message: _message, code: _code, ...data } = (e.body ?? {}) as Record<string, unknown>;
    this.body = dataOnly(data) as Record<string, unknown>;
    this.serverMessage = untrustedLine(e.message);
    this.retryAfter = e.retryAfter ?? null;
  }
}

type Fetch = typeof fetch;

/**
 * This copy of the skill, as its package.json says. Sent with every call to Orientim (x-orientim-skill), so
 * that a change old copies cannot follow (a commitment level Solana retires, a new Jupiter format) is
 * answered with "update the skill" (426 skill-outdated) instead of failing in some other way.
 */
export const SKILL_VERSION = '1.3.2';

/** Each call to Orientim ends within `timeoutMs`: an answer that never comes is no answer. */
async function call<T>(fetchImpl: Fetch, url: string, key: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-orientim-skill': SKILL_VERSION },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json()) as { error?: { code: string; message: string } } & T;
  if (!res.ok) {
    const after = Number(res.headers.get('retry-after'));
    throw new OrientimApiError({
      status: res.status, code: json.error?.code ?? 'http', message: json.error?.message ?? res.statusText, body: json.error ?? {},
      retryAfter: Number.isFinite(after) && after > 0 ? after : null,
    });
  }
  return json;
}

/**
 * Is `message` Orientim's API-key message for `address`, from the host of `apiUrl`, and nothing else?
 * A wallet's signature over bytes a server chose could, for bytes shaped like a transaction, be a
 * signature for that transaction: so only this exact text, for this wallet and this host, is ever
 * signed (AGENT-API.md, "API access").
 */
export function isApiKeyMessage(message: unknown, apiUrl: string, address: string): message is string {
  if (typeof message !== 'string' || message.length > 1_000 || !/^[\x20-\x7e\n]+$/.test(message)) return false;
  const lines = message.split('\n');
  return lines[0] === `${new URL(apiUrl).host} wants you to sign in with your Solana account:`
    && lines[1] === address && lines[2] === ''
    && lines[3] === 'Get an Orientim API key for this wallet. Signing costs nothing and gives no access to your funds.'
    && lines.slice(4).every(l => l === '' || /^(URI|Version|Chain ID|Nonce|Issued At|Expiration Time): \S+$/.test(l));
}

/** The message to sign for an API key, checked first (`isApiKeyMessage`). */
export async function apiKeyChallenge(args: { apiUrl: string; address: string; fetchImpl?: Fetch; requestTimeoutMs?: number }): Promise<{ message: string; challenge: string }> {
  const base = args.apiUrl.replace(/\/+$/, '');
  const res = await (args.fetchImpl ?? fetch)(`${base}/api/v1/keys/challenge?wallet=${encodeURIComponent(args.address)}`, {
    headers: { 'x-orientim-skill': SKILL_VERSION }, signal: AbortSignal.timeout(args.requestTimeoutMs ?? 30_000),
  });
  const json = (await res.json()) as { message?: unknown; challenge?: unknown; error?: { code: string; message: string } };
  if (!res.ok) throw new OrientimApiError({ status: res.status, code: json.error?.code ?? 'http', message: json.error?.message ?? res.statusText, body: json.error ?? {} });
  if (!isApiKeyMessage(json.message, base, args.address) || typeof json.challenge !== 'string') {
    throw new Error('Orientim answered with a message that is not its API-key message for this wallet. Nothing was signed.');
  }
  return { message: json.message, challenge: json.challenge };
}

/** Sends the signed challenge; the key comes back, bound to the wallet that signed it. */
export async function redeemApiKey(args: {
  apiUrl: string; message: string; challenge: string; signature: Uint8Array | string; fetchImpl?: Fetch; requestTimeoutMs?: number;
}): Promise<{ key: string; wallet: string; expiresAt: string }> {
  const signature = typeof args.signature === 'string' ? args.signature : Buffer.from(args.signature).toString('base64');
  const res = await (args.fetchImpl ?? fetch)(`${args.apiUrl.replace(/\/+$/, '')}/api/v1/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orientim-skill': SKILL_VERSION },
    body: JSON.stringify({ message: args.message, challenge: args.challenge, signature }),
    signal: AbortSignal.timeout(args.requestTimeoutMs ?? 30_000),
  });
  const json = (await res.json()) as { key?: string; wallet?: string; expiresAt?: string; error?: { code: string; message: string } };
  if (!res.ok || typeof json.key !== 'string') {
    throw new OrientimApiError({ status: res.status, code: json.error?.code ?? 'http', message: json.error?.message ?? res.statusText, body: json.error ?? {} });
  }
  return { key: json.key, wallet: json.wallet ?? '', expiresAt: json.expiresAt ?? '' };
}

/**
 * An API key for this wallet, at once (AGENT-API.md, "API access"): the wallet signs Orientim's
 * message, checked first, and nothing else. The key prepares swaps for this wallet only.
 */
export async function requestApiKey(args: {
  apiUrl: string; address: string; signMessage: (message: Uint8Array) => Promise<Uint8Array>; fetchImpl?: Fetch; requestTimeoutMs?: number;
}): Promise<{ key: string; wallet: string; expiresAt: string }> {
  const { message, challenge } = await apiKeyChallenge(args);
  const signature = await args.signMessage(new TextEncoder().encode(message));
  return redeemApiKey({ ...args, message, challenge, signature });
}

/** An address, as Solana writes one. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * What to check before signing. First that Orientim's answer agrees with itself and with what you
 * asked for; then the full verifier on the exact bytes, with chain state from `rpc`, which must be
 * your own RPC. Returns the problems found; sign only when there are none.
 */
export async function checkPrepared(p: Prepared, intent: Intent, rpc: Rpc<SolanaRpcApi>, opts: { requestTimeoutMs?: number } = {}): Promise<string[]> {
  // Every number in the answer is checked here, before the wallet signs, including those only shown
  // once the swap is sent: nothing Orientim sends can make the report of a sent swap fail, and a
  // report that fails invites a second swap.
  const digits = (v: unknown) => typeof v === 'string' && /^\d{1,20}$/.test(v);
  const malformed = [
    ...(['amountIn', 'fee', 'feeBps', 'swapAmount', 'quotedOut', 'minOut'] as const).filter(k => !digits(p.amounts?.[k])).map(k => `amounts.${k}`),
    ...(['networkFeeLamports', 'outputAccountRentLamports', 'routeRentLamports', 'routeRefundLamports'] as const)
      .filter(k => !digits(p.costs?.[k])).map(k => `costs.${k}`),
    ...(p.costs?.keptSolLamports !== undefined && !digits(p.costs.keptSolLamports) ? ['costs.keptSolLamports'] : []),
    ...(p.amounts?.feeMint !== undefined && !(typeof p.amounts.feeMint === 'string' && BASE58.test(p.amounts.feeMint)) ? ['amounts.feeMint'] : []),
    ...(p.amounts?.priceImpactPct !== undefined && !Number.isFinite(Number(p.amounts.priceImpactPct)) ? ['amounts.priceImpactPct'] : []),
    ...(!digits(p.lastValidBlockHeight) ? ['lastValidBlockHeight'] : []),
    ...(p.blocksLeft !== undefined && !digits(p.blocksLeft) ? ['blocksLeft'] : []),
    ...(['totalDebit', 'orientimFee'] as const).filter(k => !digits(p.certificate?.input?.[k])).map(k => `certificate.input.${k}`),
    ...(!digits(p.certificate?.output?.minimumOutput) ? ['certificate.output.minimumOutput'] : []),
  ];
  if (malformed.length) return [`the answer's numbers are malformed: ${malformed.join(', ')}`];
  const problems: string[] = [];
  const tx = getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64'));
  const digest = hex(await crypto.subtle.digest('SHA-256', new Uint8Array(tx.messageBytes)));
  if (digest !== p.messageSha256 || p.certificate.messageSha256 !== digest) problems.push('the message does not hash to messageSha256');
  const signers = Object.keys(tx.signatures).sort();
  if (signers.join() !== [intent.owner, p.temporaryAuthority].sort().join()) problems.push(`unexpected signers: ${signers.join(', ')}`);
  const feePayer = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts[0];
  if (feePayer !== intent.owner) problems.push(`the fee payer is ${feePayer}, not your wallet`);
  if (p.wallet !== intent.owner || p.certificate.wallet !== intent.owner) problems.push('the transaction is for another wallet');
  if (p.certificate.input.mint !== intent.inputMint || p.certificate.output.mint !== intent.outputMint) problems.push('the tokens differ from the ones asked for');
  if (p.amounts.amountIn !== intent.amountIn || p.certificate.input.totalDebit !== intent.amountIn) {
    problems.push(`the wallet would pay ${p.certificate.input.totalDebit}, not ${intent.amountIn}`);
  }
  // The fee is in the input token, or taken from the output (SOL, USDC or USDT): a share of what is
  // paid in, or of the minimum that comes out, never more than your limit of either. Paid in SOL
  // from the wallet, it is held to your own price by the verifier's check (maxSolFeeLamports).
  const inSol = (p.policy as { feeSide?: unknown }).feeSide === 'sol';
  const onOutput = p.amounts.feeMint !== undefined && p.amounts.feeMint === intent.outputMint && p.amounts.feeMint !== intent.inputMint;
  const base = onOutput ? BigInt(p.amounts.minOut) + BigInt(p.amounts.fee) : BigInt(intent.amountIn);
  const maxFee = (base * BigInt(feeLimitBps(intent.maxFeeBps))) / 10_000n;
  const stated = BigInt(p.certificate.input.orientimFee) + BigInt(p.certificate.output.orientimFee ?? '0') + BigInt(p.certificate.solFee?.lamports ?? '0');
  if (!inSol && BigInt(p.amounts.fee) > maxFee) problems.push(`the Orientim fee ${p.amounts.fee} is above ${maxFee}`);
  if (stated !== BigInt(p.amounts.fee)) problems.push('the fee the certificate states differs from the one in amounts');
  if (p.certificate.output.minimumOutput !== p.amounts.minOut) problems.push('the enforced minimum differs from the one stated');
  // The amounts shown are the policy's own, the one the verifier holds the bytes to: the fee, what
  // is routed, and the minimum the wallet keeps.
  const policy = p.policy as Record<string, unknown>;
  const whole = (v: unknown) => (typeof v === 'string' && /^\d{1,20}$/.test(v) ? BigInt(v) : null);
  const [enforced, policyFee, routed] = [whole(policy.minOut), whole(policy.fee), whole(policy.swapAmount)];
  if (enforced === null || policyFee === null || routed === null) problems.push('the policy is malformed');
  else if (
    BigInt(p.amounts.minOut) !== (policy.feeSide === 'output' ? enforced - policyFee : enforced)
    || BigInt(p.amounts.fee) !== policyFee || BigInt(p.amounts.swapAmount) !== routed
  ) {
    problems.push('the amounts stated differ from the policy the transaction is checked against');
  }
  if (intent.minOut && /^\d{1,20}$/.test(intent.minOut) && BigInt(p.amounts.minOut) < BigInt(intent.minOut)) {
    problems.push(`the minimum ${p.amounts.minOut} is below yours, ${intent.minOut}`);
  }
  if (BigInt(p.costs.networkFeeLamports) > BigInt(intent.maxNetworkFeeLamports ?? 1_000_000)) problems.push(`the network fee ${p.costs.networkFeeLamports} is above your limit`);
  // The answer's own claims are not evidence: what the bytes do is decided by the verifier.
  problems.push(...await verifyPrepared(p, { ...intent, minOut: intent.minOut ?? '' }, rpc, opts));
  return problems;
}

/**
 * The transaction lives 150 blocks, about 40 s. Finalize only with this many
 * left, so that it can still land; otherwise prepare again.
 */
export const MIN_BLOCKS_TO_FINALIZE = 30n;

/**
 * How far your RPC may trail the one Orientim read the blockhash from, in blocks. The last block the
 * transaction can land in is taken on your own clock with this margin, never from the server alone.
 */
export const LAG_BLOCKS = 25n;

/**
 * The last block a kept swap can land in. Its blockhash lives 150 blocks and is older than the height
 * the wallet signed at, so a stated block beyond that bound (a record a server overstated before this
 * check existed) cannot hold the wallet's next swap back for good.
 */
export function lastBlockOf(s: { lastValidBlockHeight: bigint; signedHeight?: bigint }): bigint {
  if (s.signedHeight === undefined) return s.lastValidBlockHeight;
  const bound = s.signedHeight + 150n + LAG_BLOCKS;
  return s.lastValidBlockHeight < bound ? s.lastValidBlockHeight : bound;
}

/**
 * The wallet: whatever signs a transaction for one address the way @solana/kit's signers do. A
 * `KeyPairSigner` from a keypair file is one; a wallet held by a signing service is another, through
 * `signerFromSignBytes` or `signerFromSignTransaction`. Only its signature for its own address is
 * used, and only once it verifies against the exact message that was checked.
 */
export type WalletSigner = TransactionPartialSigner;

export async function signAsWallet(wallet: WalletSigner, transaction: string): Promise<string> {
  const tx = getTransactionDecoder().decode(Buffer.from(transaction, 'base64'));
  const [signatures] = await wallet.signTransactions([tx as never]);
  const signature = signatures?.[wallet.address];
  if (!signature || !await verifySignature(await getPublicKeyFromAddress(wallet.address), signature, tx.messageBytes)) {
    throw new Error(`Not sending: the wallet returned no valid signature from ${wallet.address} for this transaction.`);
  }
  return Buffer.from(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, [wallet.address]: signature } })).toString('base64');
}

/**
 * A wallet held by a service that signs raw bytes with its ed25519 key (a KMS or HSM, or a signing
 * service's raw-payload call): `sign` receives the transaction's message and returns the 64-byte
 * signature. The message is all that leaves your process, and it is the one the check verified.
 */
export function signerFromSignBytes(address: string, sign: (message: Uint8Array) => Promise<Uint8Array>): WalletSigner {
  return {
    address: address as Address,
    signTransactions: transactions => Promise.all(transactions.map(async tx =>
      ({ [address]: (await sign(new Uint8Array(tx.messageBytes))) as SignatureBytes }) as SignatureDictionary)),
  };
}

/**
 * A wallet held by a service that signs whole transactions and hands them back without sending
 * them (base64 in, base64 out). Its answer counts only when it is this very transaction: a service
 * that changes one byte (a priority fee, a new blockhash, an instruction of its own) is refused, since
 * Orientim co-signs only the message it built and your check verified. A service that can only sign
 * and send cannot be used: Orientim's signature comes last.
 */
export function signerFromSignTransaction(address: string, sign: (transaction: string) => Promise<string>): WalletSigner {
  return {
    address: address as Address,
    signTransactions: transactions => Promise.all(transactions.map(async tx => {
      const back = getTransactionDecoder().decode(Buffer.from(await sign(Buffer.from(getTransactionEncoder().encode(tx)).toString('base64')), 'base64'));
      if (!sameBytes(back.messageBytes, tx.messageBytes)) throw new Error('The signing service changed the transaction. Nothing was signed or sent.');
      const signature = back.signatures[address as Address];
      if (!signature) throw new Error(`The signing service returned no signature from ${address}. Nothing was sent.`);
      return { [address]: signature } as SignatureDictionary;
    })),
  };
}

/**
 * `expired`: it did not land and can no longer land. `unknown`: no outcome could be proven; it may
 * be on chain, so look it up before any new swap (`resolvePending` once you have).
 */
export type Outcome = 'confirmed' | 'failed' | 'expired' | 'unknown';

type StatusState = { confirmationStatus?: string | null; err?: unknown } | null;

/**
 * One look at the chain: the signature's status from full history, with the finalized height the
 * answering node had reached and the highest height it can have reached (see `provesNeverLanded`).
 */
async function lookUp(rpc: Rpc<SolanaRpcApi>, signature: string, bounded: () => { abortSignal: AbortSignal }) {
  // The finalized slot and height in one answer, then the full history from a node that had reached that slot.
  const finalized = await rpc.getEpochInfo({ commitment: 'finalized' }).send(bounded());
  const { context, value: [status] } = await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send(bounded());
  const height = (finalized as { blockHeight?: bigint | number }).blockHeight;
  const ahead = BigInt(context.slot) - BigInt(finalized.absoluteSlot);
  const covered = height !== undefined && ahead >= 0n;
  return {
    status: (status ?? null) as StatusState,
    view: { coveredHeight: covered ? BigInt(height) : null, reachHeight: covered ? BigInt(height) + ahead : null },
  };
}

/**
 * Settles one transaction on your own RPC, by its signature, until it lands, can no longer land, or
 * `maxWaitMs` passes. With `signedTransaction` (the fully signed bytes, checked to be this very
 * transaction), it re-broadcasts every few seconds: the same bytes land at most once. Only a confirmed
 * status is an outcome, since an error seen at `processed` may be on a fork.
 *
 * `expired` needs one coherent view, twice: a finalized height past the lifetime, no record in the
 * full history from a node that had reached that height's slot, and that node's status cache still
 * holding every block the transaction could have landed in, from `earliestHeight` (your RPC's height
 * when you signed) on. Older than that, "no record" may only mean a pruned history or an archive that
 * failed, so the outcome stays `unknown` and is returned as soon as that is clear.
 * Without `earliestHeight` nothing is proven expired. Every request is bounded by what is left of
 * `maxWaitMs`, so one that never answers cannot hold the agent past it.
 */
export async function confirm(
  rpc: Rpc<SolanaRpcApi>,
  signature: string,
  lastValidBlockHeight: bigint,
  opts: { signedTransaction?: string; pollMs?: number; maxWaitMs?: number; requestTimeoutMs?: number; earliestHeight?: bigint } = {},
): Promise<Outcome> {
  const pollMs = opts.pollMs ?? 1_000;
  const deadline = Date.now() + (opts.maxWaitMs ?? 180_000);
  const bounded = () => ({ abortSignal: AbortSignal.timeout(Math.max(1, Math.min(opts.requestTimeoutMs ?? 10_000, deadline - Date.now()))) });
  const settled = (s: { confirmationStatus?: string | null } | null | undefined) =>
    !!s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized');
  const earliest = opts.earliestHeight;
  let pastLifetime = false;
  let empty = 0;
  let unprovable = 0;
  let lastSend = 0;
  while (Date.now() < deadline) {
    // A failed read says nothing about the transaction: keep reading until the deadline.
    try {
      if (!pastLifetime) {
        const [status] = (await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: false }).send(bounded())).value;
        if (settled(status)) return status!.err ? 'failed' : 'confirmed';
        if ((await rpc.getBlockHeight({ commitment: 'confirmed' }).send(bounded())) > lastValidBlockHeight) pastLifetime = true;
        else if (opts.signedTransaction && Date.now() - lastSend > 3_000) {
          lastSend = Date.now();
          await rpc.sendTransaction(opts.signedTransaction as never, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send(bounded()).catch(() => undefined);
        }
      } else {
        // It can no longer be included: one coherent view of the full history.
        const { status: late, view } = await lookUp(rpc, signature, bounded);
        if (settled(late)) return late!.err ? 'failed' : 'confirmed';
        if (!late && earliest !== undefined && provesNeverLanded(view, lastValidBlockHeight, earliest) && ++empty >= 2) return 'expired';
        // Past the window in which "no record" proves anything, waiting longer proves nothing either.
        const over = view.coveredHeight !== null && view.coveredHeight > lastValidBlockHeight;
        if (!late && over && (earliest === undefined || pastProof(view, earliest)) && ++unprovable >= 2) return 'unknown';
      }
    } catch {
      // keep reading
    }
    await wait(Math.max(0, Math.min(pastLifetime ? pollMs * 2 : pollMs, deadline - Date.now())));
  }
  return 'unknown';
}

/** Is `wire` the very transaction your wallet signed, now carrying a valid signature from E too? */
async function isThisTransaction(wire: string, mine: Transaction, temporaryAuthority: string): Promise<boolean> {
  try {
    const tx = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
    if (!sameBytes(tx.messageBytes, mine.messageBytes)) return false;
    if (getSignatureFromTransaction(tx) !== getSignatureFromTransaction(mine)) return false;
    const e = tx.signatures[temporaryAuthority as Address];
    return !!e && await verifySignature(await getPublicKeyFromAddress(temporaryAuthority as Address), e, tx.messageBytes);
  } catch {
    return false;
  }
}

/**
 * What to keep before finalize: with it, a process that stops can still find out what happened, and
 * ask finalize again with the same ticket and bytes (the same transaction lands at most once).
 */
export type Signed = {
  signature: string;
  lastValidBlockHeight: bigint;
  ticket: string;
  /** The transaction as your wallet signed it, base64. */
  signedTransaction: string;
  messageSha256: string;
  /** When it was signed, in ms since the epoch. */
  signedAt: number;
  /** The order it carries out (`Intent.id`), if it has one. */
  intentId?: string;
  /** The wallet that signed it: one swap per wallet may be pending at a time. */
  owner?: string;
  /**
   * Your RPC's block height when it was signed: nothing sent after it can land below it. What lets
   * "no record" prove the swap expired (see `confirm`); a record without it stays unknown until
   * settled by hand (`resolvePending`).
   */
  signedHeight?: bigint;
};

/** What happened to an order: its last transaction, and that transaction's state. */
export type OrderRecord = { signature: string; state: 'pending' | 'confirmed' | 'failed' | 'expired' | 'rejected' };

/**
 * Where each order's outcome is kept, by `Intent.id`. `claimOrder` must be atomic across every worker
 * that may take the same order: it records the order only if nothing is recorded for it yet.
 * `reclaimOrder` is the same for a retry: it records the new attempt only if `prior`, an attempt that
 * failed or expired, is still the one recorded, so two workers retrying one order cannot both send
 * it. The file store does both with exclusive creates; workers on several machines need a shared
 * store (a database row, a compare-and-set key) with the same calls. A book without `reclaimOrder`
 * cannot retry an order safely, so a retry with it is refused: give the retry a new id instead.
 */
export type OrderBook = {
  order(id: string): Promise<OrderRecord | null>;
  recordOrder(id: string, record: OrderRecord): Promise<void>;
  claimOrder(id: string, record: OrderRecord): Promise<boolean>;
  reclaimOrder?(id: string, prior: OrderRecord, record: OrderRecord): Promise<boolean>;
};

/**
 * Takes order `id` for a new attempt: atomically when nothing is recorded for it yet, and, after an
 * attempt that failed or expired, only while that attempt is still the one recorded. False when
 * another worker took it first, or when the book cannot retry safely.
 */
export async function takeOrder(orders: OrderBook, id: string, prior: OrderRecord | null, record: OrderRecord): Promise<boolean> {
  if (!prior) return orders.claimOrder(id, record);
  return orders.reclaimOrder ? orders.reclaimOrder(id, prior, record) : false;
}

/**
 * This amount would move the market more than `maxPriceImpactBps`: refused before anything was
 * prepared or signed. Usually thin liquidity; a smaller amount, or a limit raised by the owner.
 */
export class PriceImpactError extends Error {
  readonly impactBps: number;
  readonly limitBps: number;
  constructor(impactBps: number, limitBps: number) {
    super(`Price impact is ${(impactBps / 100).toFixed(2)}%, above the limit of ${(limitBps / 100).toFixed(2)}%: this amount would move the market too much. Nothing was prepared or signed.`);
    this.impactBps = impactBps;
    this.limitBps = limitBps;
  }
}

/** This order already confirmed, or its last transaction may still land: it is not swapped again. */
export class OrientimOrderError extends Error {
  readonly id: string;
  readonly record: OrderRecord;
  constructor(id: string, record: OrderRecord) {
    super(record.state === 'confirmed'
      ? `Order ${id} already swapped: ${record.signature}. Nothing new was prepared.`
      : `Order ${id} has a transaction that may still land (${record.signature}): settle it first. Nothing new was prepared.`);
    this.id = id;
    this.record = record;
  }
}

const orderIsOpen = (r: OrderRecord | null): r is OrderRecord => !!r && (r.state === 'confirmed' || r.state === 'pending');

/** Why a retry is refused by an order book that cannot take an order again atomically. */
export const retryRefused = (id: string) =>
  `Order ${id} was tried before, and this order book has no reclaimOrder, so two workers could both retry it. Give the retry a new id, or add reclaimOrder to the book. Nothing was prepared.`;

/** The wallet a kept record was signed by: named in it, or read from its transaction's fee payer. */
function ownerOfRecord(s: Signed): string | null {
  if (s.owner) return s.owner;
  try {
    return getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(s.signedTransaction, 'base64')).messageBytes).staticAccounts[0];
  } catch {
    return null;
  }
}

/**
 * Swaps from `owner` whose transaction may still land, other than `except`. A record whose wallet
 * cannot be read counts for every wallet: it is settled first, not guessed about.
 */
export async function pendingFor(store: PendingStore, owner: string, except?: string): Promise<string[]> {
  return (await store.list())
    .filter(s => s.signature !== except && (ownerOfRecord(s) ?? owner) === owner)
    .map(s => s.signature);
}

/**
 * An earlier swap from this wallet may still land: nothing new is sent until it is settled
 * (`recoverPending`), whether or not the two share an order id.
 */
export class PendingSwapError extends Error {
  readonly signatures: string[];
  constructor(signatures: string[]) {
    super(`An earlier swap from this wallet may still land (${signatures.join(', ')}): settle it first. Nothing new was sent.`);
    this.signatures = signatures;
  }
}

/**
 * The owner's own limits on what the wallet may spend, from a file only the owner writes
 * (`ORIENTIM_POLICY`), never from the intent: a misled agent, or one that lost its context after a
 * restart, cannot raise them by asking. Amounts are base units of the input token, as strings. A mint
 * not listed in `maxAmountIn` is not swapped from at all.
 */
export type OwnerPolicy = {
  /** Per input mint: the most one swap may spend. */
  maxAmountIn: Record<string, string>;
  /**
   * Per input mint: the most all swaps from one wallet signed in the last 24 hours may spend together.
   * A swap counts once signed and kept, whether it lands or not: a failed or expired one frees its
   * share only when its 24 hours pass.
   */
  maxAmountInPerDay?: Record<string, string>;
};

const DAY_MS = 24 * 60 * 60_000;

/** Reads and checks the owner's policy file: anything it does not understand is refused, not ignored. */
export function loadPolicy(path: string): OwnerPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`The owner's policy ${path} cannot be read as JSON: ${e instanceof Error ? e.message : String(e)}. Nothing was prepared.`);
  }
  const bad = (why: string) => new Error(`The owner's policy ${path} ${why}. Nothing was prepared.`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('is not a JSON object');
  const known = ['maxAmountIn', 'maxAmountInPerDay'];
  const unknown = Object.keys(raw).filter(k => !known.includes(k));
  if (unknown.length) throw bad(`has fields it does not know: ${unknown.join(', ')}`);
  const limits = (name: string, value: unknown): Record<string, string> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(`needs ${name} as {"<mint>": "<base units>"}`);
    for (const [mint, amount] of Object.entries(value)) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw bad(`names ${JSON.stringify(mint)} in ${name}, which is not a mint address`);
      if (typeof amount !== 'string' || !/^\d{1,20}$/.test(amount)) throw bad(`needs ${name}.${mint} as a whole number of base units, in a string`);
    }
    return value as Record<string, string>;
  };
  const policy = raw as Record<string, unknown>;
  return {
    maxAmountIn: limits('maxAmountIn', policy.maxAmountIn),
    ...(policy.maxAmountInPerDay !== undefined ? { maxAmountInPerDay: limits('maxAmountInPerDay', policy.maxAmountInPerDay) } : {}),
  };
}

/** The swap is outside the owner's policy: refused before anything was prepared or sent. */
export class PolicyError extends Error {
  readonly code: 'mint-not-allowed' | 'amount-over-limit' | 'daily-limit';
  readonly limit?: string;
  readonly spent?: string;
  constructor(code: PolicyError['code'], message: string, figures: { limit?: string; spent?: string } = {}) {
    super(`${message} The limit is the owner's (ORIENTIM_POLICY); only the owner may change it. Nothing was prepared or sent.`);
    this.code = code;
    Object.assign(this, figures);
  }
}

/** Where the swaps a policy counts per day are kept: the file store keeps them beside the swaps. */
export type SpendLog = {
  /** What swaps from `owner` in `mint` signed since `since` (ms) spent, other than `except`. */
  spentSince(owner: string, mint: string, since: number, except?: string): Promise<bigint>;
  recordSpend(entry: { signature: string; owner: string; mint: string; amountIn: string; at: number }): Promise<void>;
};

/**
 * Holds one swap to the owner's policy: the mint must be listed, the amount within the per-swap
 * limit, and, with a daily limit, this amount and what the last 24 hours spent within it. A daily
 * limit needs `spends`; without it the swap is refused rather than let through uncounted.
 */
export async function checkPolicy(
  policy: OwnerPolicy, swap: { owner: string; inputMint: string; amountIn: string }, spends?: SpendLog, except?: string,
): Promise<void> {
  const amount = BigInt(swap.amountIn);
  const most = policy.maxAmountIn[swap.inputMint];
  if (most === undefined) throw new PolicyError('mint-not-allowed', `The owner's policy does not allow swapping from ${swap.inputMint}.`);
  if (amount > BigInt(most)) {
    throw new PolicyError('amount-over-limit', `${swap.amountIn} is above the owner's limit of ${most} per swap from ${swap.inputMint}.`, { limit: most });
  }
  const daily = policy.maxAmountInPerDay?.[swap.inputMint];
  if (daily === undefined) return;
  if (!spends) throw new PolicyError('daily-limit', 'The owner\'s policy sets a daily limit, and no record of earlier swaps is kept to count it against.', { limit: daily });
  const spent = await spends.spentSince(swap.owner, swap.inputMint, Date.now() - DAY_MS, except);
  if (spent + amount > BigInt(daily)) {
    throw new PolicyError('daily-limit', `${swap.amountIn} more would bring the last 24 hours to ${spent + amount}, above the owner's daily limit of ${daily} from ${swap.inputMint}.`, { limit: daily, spent: spent.toString() });
  }
}

/** Where signed swaps wait for their outcome. Unattended, it must survive the process. */
export type PendingStore = {
  put(signed: Signed): Promise<void>;
  remove(signature: string): Promise<void>;
  list(): Promise<Signed[]>;
};

/**
 * Pending swaps as files in `dir`, one per signature, each written to a temporary file, flushed to
 * disk and renamed into place, so a record is either whole or absent.
 */
export function createFileStore(dir: string): PendingStore & OrderBook & SpendLog {
  mkdirSync(dir, { recursive: true });
  const file = (signature: string) => join(dir, `pending-${signature}.json`);
  // An id is the caller's text: its hash names the file, and the record keeps the id itself.
  const orderFile = (id: string) => join(dir, `order-${createHash('sha256').update(id).digest('hex').slice(0, 40)}.json`);
  const writeDurably = (path: string, text: string, flag: 'w' | 'wx') => {
    const fd = openSync(path, flag);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const readOrder = (id: string): OrderRecord | null => {
    try {
      const { signature, state } = JSON.parse(readFileSync(orderFile(id), 'utf8')) as OrderRecord;
      return { signature, state };
    } catch {
      return null;
    }
  };
  const writeOrder = (id: string, record: OrderRecord) => {
    const temporary = `${orderFile(id)}.tmp`;
    writeDurably(temporary, JSON.stringify({ id, ...record }), 'w');
    renameSync(temporary, orderFile(id));
  };
  return {
    async order(id) {
      return readOrder(id);
    },
    async recordOrder(id, record) {
      writeOrder(id, record);
    },
    async claimOrder(id, record) {
      try {
        writeDurably(orderFile(id), JSON.stringify({ id, ...record }), 'wx');
        return true;
      } catch {
        return false;
      }
    },
    async reclaimOrder(id, prior, record) {
      // One retry per earlier attempt: the worker that creates this marker first takes the order.
      try {
        writeDurably(`${orderFile(id)}.retry-${prior.signature}`, '', 'wx');
      } catch {
        return false;
      }
      const now = readOrder(id);
      if (!now || now.signature !== prior.signature || now.state !== prior.state) return false;
      writeOrder(id, record);
      return true;
    },
    async put(s) {
      const temporary = `${file(s.signature)}.tmp`;
      const fd = openSync(temporary, 'w');
      try {
        writeSync(fd, JSON.stringify({
          ...s, lastValidBlockHeight: s.lastValidBlockHeight.toString(),
          ...(s.signedHeight !== undefined ? { signedHeight: s.signedHeight.toString() } : {}),
        }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, file(s.signature));
    },
    async remove(signature) {
      rmSync(file(signature), { force: true });
    },
    async spentSince(owner, mint, since, except) {
      let spent = 0n;
      for (const f of readdirSync(dir).filter(f => f.startsWith('spend-') && f.endsWith('.json'))) {
        const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { signature: string; owner: string; mint: string; amountIn: string; at: number };
        if (s.owner === owner && s.mint === mint && s.at >= since && s.signature !== except) spent += BigInt(s.amountIn);
      }
      return spent;
    },
    async recordSpend(entry) {
      const path = join(dir, `spend-${entry.signature}.json`);
      writeDurably(`${path}.tmp`, JSON.stringify(entry), 'w');
      renameSync(`${path}.tmp`, path);
    },
    async list() {
      return readdirSync(dir).filter(f => f.startsWith('pending-') && f.endsWith('.json')).map(f => {
        const json = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Omit<Signed, 'lastValidBlockHeight' | 'signedHeight'> & { lastValidBlockHeight: string; signedHeight?: string };
        return {
          ...json, lastValidBlockHeight: BigInt(json.lastValidBlockHeight),
          ...(json.signedHeight !== undefined ? { signedHeight: BigInt(json.signedHeight) } : {}),
        } as Signed;
      });
    },
  };
}

/**
 * Settles the swaps a stopped run left in `store`, each by its own signature on your RPC, and removes
 * those whose outcome is final. Returns what is still unknown: while anything is, start no new swap
 * for the same intent. A swap that "no record" can no longer prove expired stays unknown
 * however long ago it was sent: look it up in a full history, then `resolvePending`.
 * An outcome whose record could not be updated is returned all the same, beside the error, and its
 * pending record stays for the next run.
 */
export async function recoverPending(
  store: PendingStore, rpc: Rpc<SolanaRpcApi>, opts: { pollMs?: number; maxWaitMs?: number; orders?: OrderBook } = {},
): Promise<{ settled: { signature: string; outcome: Outcome }[]; unknown: string[]; bookkeepingErrors: { signature: string; error: string }[] }> {
  const settled: { signature: string; outcome: Outcome }[] = [];
  const unknown: string[] = [];
  const bookkeepingErrors: { signature: string; error: string }[] = [];
  for (const s of await store.list()) {
    const outcome = await confirm(rpc, s.signature, lastBlockOf(s), { ...opts, earliestHeight: s.signedHeight });
    if (outcome === 'unknown') {
      unknown.push(s.signature);
      continue;
    }
    settled.push({ signature: s.signature, outcome });
    try {
      // The order learns its outcome before the record that says it was pending goes away.
      if (s.intentId && opts.orders) await opts.orders.recordOrder(s.intentId, { signature: s.signature, state: outcome });
      await store.remove(s.signature);
    } catch (e) {
      bookkeepingErrors.push({ signature: s.signature, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { settled, unknown, bookkeepingErrors };
}

/**
 * Settles by hand a kept swap whose outcome the chain can no longer prove (`unknown` long after it was
 * sent: see `confirm`), once you have looked its signature up in a full history, such as an explorer.
 * The chain's own answer comes first: a status your RPC still has is used instead of yours. Refused
 * while the transaction could still land, and while it is seen but not settled.
 */
export async function resolvePending(
  store: PendingStore, rpc: Rpc<SolanaRpcApi>, signature: string, outcome: 'confirmed' | 'failed' | 'expired',
  opts: { orders?: OrderBook; requestTimeoutMs?: number } = {},
): Promise<{ signature: string; outcome: 'confirmed' | 'failed' | 'expired'; by: 'chain' | 'you' }> {
  const kept = (await store.list()).find(s => s.signature === signature);
  if (!kept) throw new Error(`No kept swap has the signature ${signature}. Nothing was changed.`);
  const bounded = () => ({ abortSignal: AbortSignal.timeout(opts.requestTimeoutMs ?? 10_000) });
  const { status, view } = await lookUp(rpc, signature, bounded);
  const onChain = status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
    ? (status.err ? 'failed' as const : 'confirmed' as const) : null;
  if (!onChain && status) throw new Error(`The network has seen ${signature} but not settled it yet: wait and recover again. Nothing was changed.`);
  if (!onChain && (view.coveredHeight === null || view.coveredHeight <= lastBlockOf(kept))) {
    throw new Error(`${signature} can still land until block ${lastBlockOf(kept)}: recover it instead. Nothing was changed.`);
  }
  const settledAs = onChain ?? outcome;
  if (kept.intentId && opts.orders) await opts.orders.recordOrder(kept.intentId, { signature, state: settledAs });
  await store.remove(signature);
  return { signature, outcome: settledAs, by: onChain ? 'chain' : 'you' };
}

/**
 * One worker per wallet at a time, across processes sharing `dir`: the lock file is created only if
 * it does not exist, and names its holder with a token of its own. A lock older than `staleMs` is
 * left by a process that died: it is moved aside, which only one process can do, and only if it is
 * still the stale lock that was judged, then taken. The release deletes the lock only while it still
 * carries this holder's token, so a worker whose lock was taken over never removes its successor's.
 * Keep `staleMs` above the longest swap (`maxWaitMs` and its requests).
 * Workers on other machines need a shared store with a lock of its own.
 */
export function acquireLock(dir: string, owner: string, staleMs = 10 * 60_000): () => void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `lock-${owner}`);
  const token = randomUUID();
  const busy = () => new Error(`Another swap from ${owner} is running (lock ${path}); nothing was started.`);
  const tokenAt = (file: string): string | null => {
    try {
      return (JSON.parse(readFileSync(file, 'utf8')) as { token?: string }).token ?? null;
    } catch {
      return null;
    }
  };
  const take = () => {
    const fd = openSync(path, 'wx');
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  try {
    take();
  } catch {
    let judged: string | null;
    try {
      if (Date.now() - statSync(path).mtimeMs < staleMs) throw busy();
      judged = tokenAt(path);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Another swap')) throw e;
      throw busy(); // gone or unreadable in between: another worker is at it
    }
    const aside = `${path}.stale-${token}`;
    try {
      renameSync(path, aside); // atomic: one worker moves it, every other one finds it gone
    } catch {
      throw busy();
    }
    if (tokenAt(aside) !== judged) {
      // What was moved is a fresh lock another worker took after this one judged the old one stale.
      try {
        renameSync(aside, path);
      } catch {
        // its holder releases nothing that is not its own; the next stale check clears it
      }
      throw busy();
    }
    rmSync(aside, { force: true });
    try {
      take();
    } catch {
      throw busy();
    }
  }
  return () => {
    if (tokenAt(path) === token) rmSync(path, { force: true });
  };
}

/**
 * The minimum a caller asked for sits further below Jupiter's own price than `MAX_BELOW_BPS` allows:
 * refused before anything was prepared. A misled agent cannot sell for nothing.
 */
export class FloorError extends Error {
  readonly minOut: string;
  readonly lowest: string;
  constructor(minOut: string, lowest: string) {
    super(`The minimum ${minOut} is more than ${MAX_BELOW_BPS / 100}% below the market's own price; the lowest accepted is ${lowest}. Nothing was prepared or signed.`);
    this.minOut = minOut;
    this.lowest = lowest;
  }
}

/**
 * Your floor and the market's price impact, from a price asked of Jupiter directly, whatever the
 * intent says. Without `minOut`, the floor is Jupiter's price
 * less `maxBelowBps`; with one, it may be higher than that, never more than `MAX_BELOW_BPS` below
 * the market. The price impact is held to `maxPriceImpactBps`, itself at most `MAX_PRICE_IMPACT_BPS`.
 */
export async function ownFloor(
  intent: Intent, deps: { rpc: Rpc<SolanaRpcApi>; fetchImpl?: Fetch; jupiterApiKey?: string; requestTimeoutMs?: number },
): Promise<{ minOut: string; priceImpactBps: number }> {
  const maxImpact = intent.maxPriceImpactBps ?? DEFAULT_MAX_PRICE_IMPACT_BPS;
  if (!(Number.isInteger(maxImpact) && maxImpact >= 0 && maxImpact <= MAX_PRICE_IMPACT_BPS)) {
    throw new Error(`maxPriceImpactBps must be a whole number of bps from 0 to ${MAX_PRICE_IMPACT_BPS}. Nothing was prepared.`);
  }
  if (intent.maxFeeBps !== undefined && feeLimitBps(intent.maxFeeBps) !== intent.maxFeeBps) {
    throw new Error(`maxFeeBps may be at most ${feeLimitBps()}, Orientim's pinned fee. Nothing was prepared.`);
  }
  if (intent.minOut !== undefined && !/^\d{1,20}$/.test(intent.minOut)) throw new Error('minOut must be a whole number of base units, as a string. Nothing was prepared.');
  const own = await ownQuote({
    inputMint: intent.inputMint, outputMint: intent.outputMint, amountIn: intent.amountIn, taker: intent.owner,
    maxFeeBps: intent.maxFeeBps, maxBelowBps: intent.maxBelowBps, slippageBps: intent.slippageBps, apiKey: deps.jupiterApiKey, fetchImpl: deps.fetchImpl,
    inputTax: await inputTransferFee(deps.rpc, intent.inputMint, deps.requestTimeoutMs),
  });
  if (own.priceImpactBps > maxImpact) throw new PriceImpactError(own.priceImpactBps, maxImpact);
  if (intent.minOut === undefined) return { minOut: own.minOut, priceImpactBps: own.priceImpactBps };
  const lowest = (BigInt(own.outAmount) * BigInt(10_000 - MAX_BELOW_BPS)) / 10_000n;
  if (BigInt(intent.minOut) < lowest) throw new FloorError(intent.minOut, lowest.toString());
  return { minOut: intent.minOut, priceImpactBps: own.priceImpactBps };
}

/** A prepared swap that passed the check, with the intent and limits it was checked against. */
/** `notices`: what to know about the tokens themselves (`tokenNotices`): an issuer that can freeze or mint. */
export type Checked = { prepared: Prepared; intent: Intent; notices?: string[] };

/**
 * Prepare and check: your own floor (asked of Jupiter when you set none), Orientim's answer, and the
 * full check on the exact bytes with chain state from your RPC. Throws on anything to refuse; sign
 * only the transaction this returns. A price that moved or a costlier route is not accepted
 * silently: Orientim's answer is an error that says so.
 */
export async function prepareChecked(args: {
  apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; owner: string; intent: Omit<Intent, 'owner'>;
  fetchImpl?: Fetch; jupiterApiKey?: string; requestTimeoutMs?: number;
}): Promise<Checked> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const owner = args.owner;
  const { slippageBps } = args.intent;
  if (slippageBps !== undefined && !isSlippageBps(slippageBps)) {
    throw new Error(`slippageBps must be a whole number of bps from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}. Nothing was prepared.`);
  }
  const own = await ownFloor({ ...args.intent, owner }, { rpc: args.rpc, fetchImpl, jupiterApiKey: args.jupiterApiKey, requestTimeoutMs: args.requestTimeoutMs });
  const minOut = own.minOut;
  const intent: Intent = { ...args.intent, owner, minOut };
  const prepared = await call<Prepared>(fetchImpl, `${args.apiUrl}/api/v1/prepare`, args.apiKey, {
    owner: intent.owner, inputMint: intent.inputMint, outputMint: intent.outputMint, amountIn: intent.amountIn,
    ...(intent.minOut ? { minOut: intent.minOut } : {}),
    ...(intent.acceptCostBps ? { acceptCostBps: intent.acceptCostBps } : {}),
    ...(slippageBps !== undefined ? { slippageBps } : {}),
    ...(intent.version !== undefined ? { version: intent.version } : {}),
  }, args.requestTimeoutMs);
  // A fee in SOL from the wallet: held to a price of your own, asked of Jupiter here.
  if ((prepared.policy as { feeSide?: unknown }).feeSide === 'sol' && intent.maxSolFeeLamports === undefined) {
    intent.maxSolFeeLamports = await ownSolFeeLimit({
      inputMint: intent.inputMint, amountIn: intent.amountIn, taker: owner, maxFeeBps: intent.maxFeeBps, apiKey: args.jupiterApiKey, fetchImpl,
    });
  }
  const problems = await checkPrepared(prepared, intent, args.rpc, { requestTimeoutMs: args.requestTimeoutMs });
  if (problems.length) throw new Error(`Not signing: ${problems.join('; ')}`);
  // Checked: from here on only its data travels, never prose a server slipped into it.
  return { prepared: dataOnly(prepared) as Prepared, intent, notices: await tokenNotices(args.rpc, [intent.inputMint, intent.outputMint], args.requestTimeoutMs ?? 10_000) };
}

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * What actually arrived in the wallet, read from the confirmed transaction on your RPC, in base units
 * of the output; null when it cannot be read. For SOL, what the wallet gained, with the network fee
 * and the market's account fee (less its refund) added back, since neither is swap output. Never fails.
 */
export async function receivedFor(
  rpc: Rpc<SolanaRpcApi>, signature: string, prepared: Pick<Prepared, 'wallet' | 'costs' | 'certificate'> & { version?: number },
  opts: { requestTimeoutMs?: number; tries?: number; pollMs?: number } = {},
): Promise<bigint | null> {
  const outputMint = prepared.certificate.output.mint;
  if (typeof (rpc as { getTransaction?: unknown }).getTransaction !== 'function') return null;
  for (let i = 0; i < (opts.tries ?? 3); i++) {
    try {
      const tx = await rpc
        .getTransaction(signature as never, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: prepared.version ?? 0 } as never)
        .send({ abortSignal: AbortSignal.timeout(opts.requestTimeoutMs ?? 10_000) });
      const meta = (tx as unknown as { meta?: {
        fee: bigint | number; preBalances: readonly (bigint | number)[]; postBalances: readonly (bigint | number)[];
        preTokenBalances?: readonly TokenBalance[] | null; postTokenBalances?: readonly TokenBalance[] | null;
      } | null } | null)?.meta;
      if (meta) {
        if (outputMint === SOL_MINT) {
          const [before, after] = [meta.preBalances[0], meta.postBalances[0]];
          if (before === undefined || after === undefined) return null;
          return BigInt(after) - BigInt(before) + BigInt(meta.fee)
            + BigInt(prepared.costs.routeRentLamports ?? '0') - BigInt(prepared.costs.routeRefundLamports ?? '0');
        }
        const mine = (list: readonly TokenBalance[] | null | undefined) => (list ?? []).filter(b => b.mint === outputMint && b.owner === prepared.wallet);
        const after = mine(meta.postTokenBalances);
        if (!after.length) return null;
        const before = new Map(mine(meta.preTokenBalances).map(b => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
        return after.reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount) - (before.get(b.accountIndex) ?? 0n), 0n);
      }
    } catch {
      // Not readable yet, or the RPC failed: asked again below.
    }
    await wait(opts.pollMs ?? 1_000);
  }
  return null;
}

/**
 * What arrived against the quote, net of a fee taken from the output, as the page says it: better, or
 * well below the quote and within the tolerance. Empty otherwise.
 */
export function fillAgainstQuote(received: bigint, expected: bigint, tolerance: string): string {
  if (expected <= 0n) return '';
  const bps = Number(((received - expected) * 10_000n) / expected);
  const pct = (b: number) => `${(Math.abs(b) / 100).toFixed(Math.abs(b) < 100 ? 2 : 1)}%`;
  if (bps >= 5) return `${pct(bps)} better than quoted.`;
  if (bps <= -100 && tolerance) return `Filled ${pct(bps)} below the quote, within your ${tolerance} tolerance.`;
  return '';
}

/**
 * Finalize a transaction your wallet signed, then read its outcome on your RPC for the signature
 * your wallet made, never taken from finalize: `rejected` means Orientim refused to send it and the
 * chain shows it can no longer land; `expired`, that it did not land; `unknown`, that no outcome could
 * be read in time. Only after `rejected` or `expired` is a new swap for the same intent safe; after
 * `unknown`, check `signature` first. `signedTransaction` must be the checked transaction, unchanged,
 * with a valid signature from the wallet.
 */
export async function finalizeSigned(args: {
  apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; prepared: Prepared; signedTransaction: string;
  fetchImpl?: Fetch; pollMs?: number;
  /**
   * Called before finalize with what to keep (see `Signed`). Unattended, persist it durably here
   * (`createFileStore`): if this throws, nothing is finalized.
   */
  onSigned?: (signed: Signed) => void | Promise<void>;
  /** How long to wait for an outcome, in ms; `unknown` after that (default 3 minutes). */
  maxWaitMs?: number;
  /** How long one call to Orientim or to your RPC may take, in ms (default 30 s and 10 s). */
  requestTimeoutMs?: number;
}): Promise<{ signature: string; outcome: Outcome | 'rejected'; prepared: Prepared; refusal?: string }> {
  const { prepared, signedTransaction } = args;
  const mine = getTransactionDecoder().decode(Buffer.from(signedTransaction, 'base64'));
  const built = getTransactionDecoder().decode(Buffer.from(prepared.transaction, 'base64'));
  if (!sameBytes(mine.messageBytes, built.messageBytes)) throw new Error('Not finalizing: this is not the transaction Orientim prepared. Nothing was sent.');
  const own = mine.signatures[prepared.wallet as Address];
  if (!own || !await verifySignature(await getPublicKeyFromAddress(prepared.wallet as Address), own, mine.messageBytes)) {
    throw new Error(`Not finalizing: the transaction carries no valid signature from ${prepared.wallet}. Nothing was sent.`);
  }
  // The transaction's id is your wallet's signature, known from bytes you signed yourself.
  const signature = getSignatureFromTransaction(mine);
  const height = BigInt(await args.rpc.getBlockHeight({ commitment: 'confirmed' }).send({ abortSignal: AbortSignal.timeout(args.requestTimeoutMs ?? 10_000) }));
  const stated = BigInt(prepared.lastValidBlockHeight);
  if (stated - height < MIN_BLOCKS_TO_FINALIZE) {
    throw new Error(`Not finalizing: only ${stated - height} blocks are left before this swap expires, too few to land. This call sent nothing; prepare it again (a swap an earlier call finalized is settled with resumeSigned or recoverPending, not here).`);
  }
  // The last block it can land in, on your own clock: its blockhash is older than this height and
  // lives 150 blocks, so a server that states less cannot end the wait while it could still land.
  // Nor can one that states more make the wallet wait for a block no blockhash reaches, which would
  // report the swap unknown and hold the wallet's next swap back for good: the server's figure is
  // never kept, only this one.
  const lastValid = height + 150n + LAG_BLOCKS;
  const signed: Signed = {
    signature, lastValidBlockHeight: lastValid, ticket: prepared.ticket, signedTransaction, messageSha256: prepared.messageSha256, signedAt: Date.now(),
    owner: prepared.wallet, signedHeight: height,
  };
  await args.onSigned?.(signed);
  return { ...await askAndConfirm(args, signed, mine, prepared.temporaryAuthority), prepared };
}

/**
 * Finalize asked for a kept swap, then its outcome read on your RPC. Asked once more when no answer
 * came back, or none that reads (the same bytes can land only once). A refusal (4xx) is not asked
 * again: it says this request sent nothing, and the chain says the rest.
 */
async function askAndConfirm(
  args: { apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; fetchImpl?: Fetch; pollMs?: number; maxWaitMs?: number; requestTimeoutMs?: number },
  signed: Signed, mine: Transaction, temporaryAuthority: string,
): Promise<{ signature: string; outcome: Outcome | 'rejected'; refusal?: string }> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const { signature } = signed;
  let done: Finalized | null = null;
  let refused: OrientimApiError | null = null;
  for (let attempt = 0; attempt < 2 && !done && !refused; attempt++) {
    try {
      done = await call<Finalized>(fetchImpl, `${args.apiUrl}/api/v1/finalize`, args.apiKey, { ticket: signed.ticket, signedTransaction: signed.signedTransaction }, args.requestTimeoutMs);
    } catch (e) {
      if (e instanceof OrientimApiError && e.status < 500) refused = e;
      else if (attempt === 0) await wait(args.pollMs ?? 1_000);
    }
  }
  // Bytes from the server are re-broadcast only when they are this very transaction, signed by E.
  const bytes = done?.signedTransaction && await isThisTransaction(done.signedTransaction, mine, temporaryAuthority)
    ? done.signedTransaction : undefined;
  const outcome = await confirm(args.rpc, signature, signed.lastValidBlockHeight, {
    signedTransaction: bytes, pollMs: args.pollMs, maxWaitMs: args.maxWaitMs, requestTimeoutMs: args.requestTimeoutMs, earliestHeight: signed.signedHeight,
  });
  // Kept or not, the caller decides what to do with a pending record: an unknown outcome stays pending.
  const refusal = refused ? refused.code : done?.status === 'rejected' ? safeCode(done.refusal ?? 'network') : undefined;
  // Refused by Orientim, and the chain shows it can no longer land: that refusal is what happened.
  if (outcome === 'expired' && refusal) return { signature, outcome: 'rejected', refusal };
  return { signature, outcome, ...(refusal ? { refusal } : {}) };
}

/**
 * A swap kept before an earlier finalize (see `Signed`), asked again: no check meant for a first
 * send applies, since the transaction may already have been sent. Orientim is asked
 * to finalize the same bytes once more (it looks the transaction up first, and the same bytes land
 * only once), and the outcome is read on your RPC for the kept signature. Always answers with that
 * signature and its outcome.
 */
export async function resumeSigned(args: {
  apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; signed: Signed;
  fetchImpl?: Fetch; pollMs?: number; maxWaitMs?: number; requestTimeoutMs?: number;
}): Promise<{ signature: string; outcome: Outcome | 'rejected'; refusal?: string }> {
  const mine = getTransactionDecoder().decode(Buffer.from(args.signed.signedTransaction, 'base64'));
  if (getSignatureFromTransaction(mine) !== args.signed.signature) throw new Error('The kept record does not carry its own transaction. Nothing was sent.');
  // E is the transaction's other signer: the wallet pays, so it signs first, and there are exactly two.
  const message = getCompiledTransactionMessageDecoder().decode(mine.messageBytes);
  const signers = message.staticAccounts.slice(0, message.header.numSignerAccounts);
  const temporaryAuthority = signers.find(a => a !== signers[0]) ?? '';
  return askAndConfirm(args, args.signed, mine, temporaryAuthority);
}

/**
 * The whole flow: `prepareChecked`, the wallet's signature, `finalizeSigned`. See those for what
 * each step refuses and what each outcome means.
 */
export async function protectedSwap(args: {
  apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; wallet: WalletSigner; intent: Omit<Intent, 'owner'>;
  fetchImpl?: Fetch; pollMs?: number; jupiterApiKey?: string;
  /**
   * Called before finalize with what to keep (see `Signed`). Unattended, persist it durably here
   * (`createFileStore`): if this throws, nothing is finalized.
   */
  onSigned?: (signed: Signed) => void | Promise<void>;
  /** How long to wait for an outcome, in ms; `unknown` after that (default 3 minutes). */
  maxWaitMs?: number;
  /** How long one call to Orientim or to your RPC may take, in ms (default 30 s and 10 s). */
  requestTimeoutMs?: number;
  /** Where orders are kept by `intent.id` (see `OrderBook`); without an id or a book, not used. */
  orders?: OrderBook;
  /**
   * Where signed swaps are kept until settled (`createFileStore`). With it, the swap is recorded
   * before finalize and removed once its outcome is final, and nothing is sent while another swap
   * from this wallet may still land.
   */
  pending?: PendingStore;
  /**
   * The owner's limits (`loadPolicy`): checked before anything is prepared, and again, with what the
   * last 24 hours spent, just before finalize. A daily limit needs `spends` (`createFileStore`).
   */
  policy?: OwnerPolicy;
  spends?: SpendLog;
}): Promise<{
  signature: string; outcome: Outcome | 'rejected'; prepared: Prepared; refusal?: string; bookkeepingError?: string;
  /** Notes about the tokens (`tokenNotices`), for whoever decides what to buy. */
  notices: string[];
  /** Base units of the output that arrived, read from the confirmed transaction; absent when unreadable. */
  received?: string;
}> {
  const id = args.intent.id;
  const orders = id ? args.orders : undefined;
  const owner = args.wallet.address;
  // An order that confirmed, or whose transaction may still land, is not swapped again.
  const prior = orders ? await orders.order(id!) : null;
  if (orderIsOpen(prior)) throw new OrientimOrderError(id!, prior);
  if (prior && !orders!.reclaimOrder) throw new Error(retryRefused(id!));
  // Nor is anything prepared while another swap from this wallet may still land.
  const waiting = args.pending ? await pendingFor(args.pending, owner) : [];
  if (waiting.length) throw new PendingSwapError(waiting);
  // The owner's limits, from their own file: nothing the intent says can raise them.
  const spend = { owner, inputMint: args.intent.inputMint, amountIn: args.intent.amountIn };
  if (args.policy) await checkPolicy(args.policy, spend, args.spends);
  const { prepared, notices = [] } = await prepareChecked({ ...args, owner });
  const signedTransaction = await signAsWallet(args.wallet, prepared.transaction);
  const result = await finalizeSigned({
    ...args, prepared, signedTransaction,
    // Taken before finalize: the order, atomically when it is new, and the wallet's one pending
    // swap, checked again after it is kept so that two runs racing each other both stand down rather
    // than both send. A process that stops here finds it pending on its next start.
    onSigned: async signed => {
      const kept: Signed = { ...signed, ...(id ? { intentId: id } : {}) };
      // Counted again with what the last 24 hours spent, and recorded before the swap is kept: once
      // kept it may be sent, so it counts whatever its outcome.
      if (args.policy) {
        await checkPolicy(args.policy, spend, args.spends, signed.signature);
        await args.spends?.recordSpend({ signature: signed.signature, owner, mint: spend.inputMint, amountIn: spend.amountIn, at: Date.now() });
      }
      if (args.pending) {
        const others = await pendingFor(args.pending, owner, signed.signature);
        if (others.length) throw new PendingSwapError(others);
        await args.pending.put(kept);
        const raced = await pendingFor(args.pending, owner, signed.signature);
        if (raced.length) {
          await args.pending.remove(signed.signature);
          throw new PendingSwapError(raced);
        }
      }
      if (orders) {
        const record: OrderRecord = { signature: signed.signature, state: 'pending' };
        if (!await takeOrder(orders, id!, prior, record)) {
          await args.pending?.remove(signed.signature);
          throw new OrientimOrderError(id!, (await orders.order(id!)) ?? record);
        }
      }
      await args.onSigned?.(kept);
    },
  });
  // What arrived, read from the chain once the swap confirmed: never a reason to fail.
  const got = result.outcome === 'confirmed'
    ? await receivedFor(args.rpc, result.signature, prepared, { requestTimeoutMs: args.requestTimeoutMs, pollMs: args.pollMs })
    : null;
  const told = { ...result, notices, ...(got !== null ? { received: got.toString() } : {}) };
  // What happened on the chain is the answer; a record that could not be updated is said beside it,
  // never in its place.
  try {
    if (orders) await orders.recordOrder(id!, { signature: result.signature, state: result.outcome === 'unknown' ? 'pending' : result.outcome });
    if (args.pending && result.outcome !== 'unknown') await args.pending.remove(result.signature);
  } catch (e) {
    return { ...told, bookkeepingError: e instanceof Error ? e.message : String(e) };
  }
  return told;
}

// --- command line
const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const need = (name: string) => process.env[name] ?? (console.error(`Set ${name}.`), process.exit(2));
  const [inputMint, outputMint, amountIn] = [flag('in'), flag('out'), flag('amount')];
  if (!inputMint || !outputMint || !amountIn) {
    console.error('usage: node swap.ts --in <mint> --out <mint> --amount <base units> --id <order id> [--slippage-bps N] [--max-price-impact-bps N] [--min-out N] [--max-below-bps N] [--max-fee-bps N] [--max-route-cost-lamports N] [--accept-cost-bps N] [--v1] [--state <dir>] [--owner <address> --dry-run]');
    process.exit(2);
  }
  const apiUrl = need('ORIENTIM_API_URL').replace(/\/+$/, '');
  const apiKey = need('ORIENTIM_API_KEY');
  const intent = {
    inputMint, outputMint, amountIn, minOut: flag('min-out'), treasury: process.env.ORIENTIM_TREASURY || undefined,
    maxFeeBps: flag('max-fee-bps') ? Number(flag('max-fee-bps')) : undefined,
    maxBelowBps: flag('max-below-bps') ? Number(flag('max-below-bps')) : undefined,
    slippageBps: flag('slippage-bps') ? Number(flag('slippage-bps')) : undefined,
    maxPriceImpactBps: flag('max-price-impact-bps') ? Number(flag('max-price-impact-bps')) : undefined,
    maxRouteCostLamports: flag('max-route-cost-lamports') ? Number(flag('max-route-cost-lamports')) : undefined,
    acceptCostBps: flag('accept-cost-bps'),
    version: process.argv.includes('--v1') ? 1 as const : undefined,
    id: flag('id'),
  };
  const jupiterApiKey = process.env.JUPITER_API_KEY || undefined;
  if (!jupiterApiKey) console.error('JUPITER_API_KEY is not set: Jupiter throttles keyless calls, and your own floor may not be priced.');
  // Your own RPC: the verification is worth what the chain state it reads is worth.
  const rpc = createSolanaRpc(need('SOLANA_RPC_URL'));

  if (process.argv.includes('--dry-run')) {
    const owner = flag('owner') ?? (console.error('--dry-run needs --owner <address>.'), process.exit(2));
    const own = await ownFloor({ ...intent, owner }, { rpc, jupiterApiKey });
    const minOut = own.minOut;
    const prepared = await call<Prepared>(fetch, `${apiUrl}/api/v1/prepare`, apiKey, {
      owner, inputMint, outputMint, amountIn, minOut,
      ...(intent.acceptCostBps ? { acceptCostBps: intent.acceptCostBps } : {}), ...(intent.version ? { version: 1 } : {}),
      ...(intent.slippageBps !== undefined ? { slippageBps: intent.slippageBps } : {}),
    });
    const maxSolFeeLamports = (prepared.policy as { feeSide?: unknown }).feeSide === 'sol'
      ? await ownSolFeeLimit({ inputMint, amountIn, taker: owner, maxFeeBps: intent.maxFeeBps, apiKey: jupiterApiKey })
      : undefined;
    const problems = await checkPrepared(prepared, { ...intent, owner, minOut, maxSolFeeLamports }, rpc);
    console.log(JSON.stringify({
      yourFloor: minOut, priceImpactBps: own.priceImpactBps, amounts: prepared.amounts, costs: prepared.costs, blocksLeft: prepared.blocksLeft, problems,
      notices: await tokenNotices(rpc, [inputMint, outputMint]),
    }, null, 2));
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  // Every real swap names its order, the same on every retry: run twice after a lost answer, the
  // second run is told the order already swapped instead of swapping again.
  if (!intent.id) {
    console.error('Give the order an id: --id <order id>, the same on every retry of this order, so that it is never swapped twice. Nothing was started.');
    process.exit(2);
  }
  // The owner's limits, read before the key: a policy that cannot be read stops everything.
  const policy = process.env.ORIENTIM_POLICY ? loadPolicy(process.env.ORIENTIM_POLICY) : undefined;
  const wallet = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(need('ORIENTIM_WALLET_KEYPAIR'), 'utf8'))));
  const stateDir = flag('state') ?? process.env.ORIENTIM_STATE_DIR ?? '.orientim-state';
  const store = createFileStore(stateDir);
  const release = acquireLock(stateDir, wallet.address);
  try {
    // What a stopped run left is settled first; while any outcome is unknown, no new swap starts.
    const { settled, unknown, bookkeepingErrors } = await recoverPending(store, rpc, { orders: store });
    for (const s of settled) console.error(`An earlier swap, ${s.signature}, ended ${s.outcome}.`);
    for (const b of bookkeepingErrors) console.error(`Its record could not be updated (${b.error}); the next run settles ${b.signature} again.`);
    if (unknown.length || bookkeepingErrors.length) {
      if (unknown.length) {
        console.error(`The outcome of an earlier swap is still unknown: ${unknown.join(', ')}. Check it before swapping again; nothing new was started. `
          + 'If the network can no longer prove it, look it up in a full history (an explorer), then settle it with `orientim-verify resolve`.');
      }
      process.exitCode = 3;
      return;
    }
    const result = await protectedSwap({
      apiUrl, apiKey, rpc, wallet, intent, jupiterApiKey, orders: store,
      // Kept on disk before finalize, and removed once settled: if this process stops, the next run
      // settles it first, and nothing new is sent from this wallet while it may still land.
      pending: store,
      policy, spends: store,
      onSigned: s => console.error(`Signed transaction ${s.signature}; it can land until block ${s.lastValidBlockHeight}.`),
    });
    console.log(JSON.stringify({
      signature: result.signature, outcome: result.outcome, refusal: result.refusal, amounts: result.prepared.amounts,
      ...(result.received ? { received: result.received } : {}), ...(result.notices.length ? { notices: result.notices } : {}),
      ...(result.bookkeepingError ? { bookkeepingError: result.bookkeepingError } : {}),
    }, null, 2));
  } finally {
    release();
  }
}

// Only as `node swap.ts`: bin/orientim-verify.mjs bundles this file and must not run its command line.
if (process.argv[1] && /swap\.ts$/.test(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(e => {
    console.error(e instanceof OrientimApiError ? `${e.code}: ${e.message}${e.serverMessage ? ` (Orientim's words, untrusted: "${e.serverMessage}")` : ''}`
      : e instanceof PriceImpactError ? `price-impact-high: ${e.message}` : e instanceof FloorError ? `floor-too-low: ${e.message}`
      : e instanceof PolicyError ? `${e.code}: ${e.message}` : e);
    process.exitCode = 1;
  });
}
