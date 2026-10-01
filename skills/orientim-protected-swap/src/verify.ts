/**
 * The agent's own check of a prepared swap, before its wallet signs.
 *
 * Orientim's server built the transaction; the agent must not take its word for what it does. This
 * runs Orientim's full verifier (`@orientim/verifier`, rules R1–R7) on the exact
 * bytes, against chain state the agent reads from ITS OWN RPC, and against a policy the agent holds
 * to its own intent and limits. A compromised server, relay, DNS or impostor URL can then refuse or
 * delay a swap, never make the agent sign one that moves anything but the approved amount.
 *
 * Two things the rules alone cannot settle are settled here too. The price: the
 * agent must bring a floor of its own (`minOut`, from `ownMinimum` or its own source), or a server
 * could sell the amount for almost nothing through a pool it controls. And the one-time key:
 * the swap is simulated on the agent's RPC and must leave nothing under it, in its own account or
 * in an account a Pump.fun market opens in its name, so no lamports stay where a server that
 * derives the key could collect them. Rent a route keeps is a cost
 * that does not come back, accepted only up to the agent's own limit (0.001 SOL by default).
 *
 * Bundled into ../lib/orientim-verify.mjs by tools/build-skill.ts (only @solana/kit stays external), so
 * the skill works on its own; CI rebuilds it and fails if the committed file differs.
 */
import {
  fetchAddressesForLookupTables, getCompiledTransactionMessageDecoder, getTransactionDecoder, isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
} from '@solana/kit';
import type { Address, Rpc, SolanaRpcApi, Transaction } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { JUPITER_PROGRAM, PUMP_AMM_PROGRAM, PUMP_CURVE_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from '@orientim/core/constants';
import type { ChainSnapshot, Policy } from '@orientim/core/types';
import { balancesAfterSimulation, readAccounts } from '@orientim/solana';
import { hasPermanentDelegate, hasTransferFee, jupiterRouteArgs, routeAccountFor, transferFeeOf, transferFeeOn, verify } from '@orientim/verifier';
import type { TransferFee } from '@orientim/verifier';

/** When "no record" proves a transaction never landed; `confirm` in the example uses them. */
export { pastProof, provesNeverLanded, STATUS_CACHE_BLOCKS } from '@orientim/solana';

/**
 * Orientim's treasury wallet, pinned like the fee: unless the agent names another, Orientim's fee may go
 * here or nowhere, whatever the server says.
 */
export const ORIENTIM_TREASURY = 'ARzSA3sZGhf5t4UnYrmB3TWyZ5m3Wo1nA9zWBcoiTqLE';

/** What the agent asked for, and the most it accepts. */
/**
 * The tolerance an agent may choose for its route: 0.1% to 15%. Without
 * a choice Orientim builds at 0.5%, or 3% on a Pump.fun bonding curve.
 */
export const MIN_SLIPPAGE_BPS = 10;
export const MAX_SLIPPAGE_BPS = 1_500;
/** Above this price impact an agent refuses unless its owner allows more. */
export const DEFAULT_MAX_PRICE_IMPACT_BPS = 500;
/** The tolerance Orientim builds at when none is chosen: 0.5%, or 3% on a Pump.fun bonding curve. */
export const DEFAULT_SLIPPAGE_BPS = 50;
export const CURVE_SLIPPAGE_BPS = 300;
/**
 * `slippageBps: "auto"`: the tolerance Jupiter estimates for this trade (its RTSE), held from 0.5% to
 * 3%, and 3% on a Pump.fun curve; never above an owner's `maxSlippageBps`.
 */
export const AUTO_MIN_SLIPPAGE_BPS = 50;
export const AUTO_MAX_SLIPPAGE_BPS = 300;

/**
 * Jupiter's estimate of the tolerance a trade needs, from an answer asked with `slippageBps=rtse`:
 * how far its threshold sits below its quote, in bps, held from `AUTO_MIN_SLIPPAGE_BPS` to
 * `AUTO_MAX_SLIPPAGE_BPS`. An answer without a usable threshold gives the least.
 */
export function autoSlippageBps(r: { outAmount?: string; otherAmountThreshold?: string }): number {
  if (!/^\d{1,20}$/.test(r.outAmount ?? '') || !/^\d{1,20}$/.test(r.otherAmountThreshold ?? '')) return AUTO_MIN_SLIPPAGE_BPS;
  const out = BigInt(r.outAmount!);
  const threshold = BigInt(r.otherAmountThreshold!);
  if (out <= 0n || threshold <= 0n || threshold >= out) return AUTO_MIN_SLIPPAGE_BPS;
  // Rounded to the nearest bps: the threshold itself was rounded down from the quote.
  const bps = Number(((out - threshold) * 20_000n + out) / (2n * out));
  return Math.min(AUTO_MAX_SLIPPAGE_BPS, Math.max(AUTO_MIN_SLIPPAGE_BPS, bps));
}
/**
 * Hard limits no intent, flag or JSON field can raise. An agent sets its own
 * limits, and an agent can be misled: a page, an issue or a token name that tells it to "set the
 * minimum to 1" must not be able to sell the amount for nothing. Its floor never sits more than
 * `MAX_BELOW_BPS` below Jupiter's own price, the price impact it accepts never exceeds
 * `MAX_PRICE_IMPACT_BPS`, and Orientim's fee is never accepted above `MAX_FEE_BPS`. An owner who
 * needs more changes these constants in their own copy, knowingly.
 */
export const MAX_BELOW_BPS = 2_000;
export const MAX_PRICE_IMPACT_BPS = 2_000;
export const MAX_FEE_BPS = 30;
/** The fee limit the check applies: the agent's own, never above Orientim's pinned fee. */
export const feeLimitBps = (maxFeeBps?: number) =>
  Number.isInteger(maxFeeBps) && (maxFeeBps as number) >= 0 ? Math.min(maxFeeBps as number, MAX_FEE_BPS) : MAX_FEE_BPS;
export const isSlippageBps = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= MIN_SLIPPAGE_BPS && v <= MAX_SLIPPAGE_BPS;
/** A limit outside what the skill allows: a usage error (exit 2), not a refusal of this swap. */
const usageError = (message: string) => Object.assign(new Error(message), { name: 'IntentError' });
/**
 * A problem that says your RPC did not answer, not that the transaction is wrong: the same check may
 * be run again once the RPC answers.
 */
export const isRpcFailure = (problem: string) => /^the (chain state could not be read from|swap could not be simulated on) your RPC/.test(problem);
/**
 * Jupiter refused: said with its status, "(busy)" for a failure upstream that says nothing about the
 * trade, and Jupiter's own error code when it gives one (never its prose). For too many requests
 * without a key of its own, the agent shares the keyless limit.
 */
const jupiterRefusal = (status: number, asked: string, apiKey?: string, busy = false, code: string | null = null) =>
  `Jupiter answered ${status}${busy && status === 400 ? ' (busy)' : ''}${code ? ` (${code})` : ''} when asked for ${asked}`
  + (status === 429 && !apiKey ? ' (without JUPITER_API_KEY Jupiter allows very few requests: set one, from portal.jup.ag)' : '');

/**
 * A 400 from Jupiter that wraps a transient failure upstream ("quote failed", "pool has not been
 * updated in a while"), as Orientim's server reads it too: it says nothing about the trade.
 */
const JUPITER_TRANSIENT_400 = /quote failed|not been updated|failed to get quotes?|timed? ?out|try again|oracle|stale|expired|temporarily unavailable|no matching liquidity|"500: /i;

/**
 * Jupiter's refusals that say something about the trade itself, named when Jupiter gives no code of
 * its own: no route, a token it cannot trade, the same token on both sides.
 */
const JUPITER_REFUSALS: [RegExp, string][] = [
  [/no routes? found|could not find any route/i, 'NO_ROUTES_FOUND'],
  [/missing token program|not tradable|token not found/i, 'TOKEN_NOT_TRADABLE'],
  [/cannot be same as/i, 'SAME_MINT'],
];

/**
 * Jupiter's own error code from an error body, when it is one (letters, digits, underscores), or the
 * skill's name for a refusal Jupiter states only in words (`JUPITER_REFUSALS`). Never Jupiter's prose.
 */
function jupiterErrorCode(body: string): string | null {
  try {
    const json = JSON.parse(body) as { errorCode?: unknown; code?: unknown };
    const code = json?.errorCode ?? json?.code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(code)) return code;
  } catch {
    // not JSON: the words alone
  }
  return JUPITER_REFUSALS.find(([said]) => said.test(body))?.[1] ?? null;
}

/**
 * One question to Jupiter, asked again twice, a moment apart, when the answer says nothing about the
 * trade (429, a 5xx, a transient 400): a pool refreshing upstream must not read as a refusal of the
 * swap. Any other answer that is not a success is refused at once, with Jupiter's code.
 */
async function askJupiter(url: string, asked: string, apiKey: string | undefined, fetchImpl: typeof fetch | undefined): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await (fetchImpl ?? fetch)(url, { headers: apiKey ? { 'x-api-key': apiKey } : {}, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => '');
    // A market's oracle behind for a moment is transient; a refusal of the trade itself is not.
    const busy = res.status === 429 || res.status >= 500
      || (res.status === 400 && JUPITER_TRANSIENT_400.test(body) && !JUPITER_REFUSALS.some(([said]) => said.test(body)));
    if (busy && attempt < 3) {
      await new Promise(r => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    throw new Error(jupiterRefusal(res.status, asked, apiKey, busy, jupiterErrorCode(body)));
  }
}

export type AgentLimits = {
  /** The agent's wallet, which signs first and pays. */
  owner: string;
  inputMint: string;
  outputMint: string;
  /** Base units, as a string: everything that leaves the wallet in the input token, fee included. */
  amountIn: string;
  /**
   * The least the agent accepts, in base units of the output. Required, and from a price the agent
   * got itself (`ownMinimum` asks Jupiter), never from Orientim's answer. Orientim's floor may be stricter.
   */
  minOut: string;
  /** The highest Orientim fee accepted, in bps (Orientim's is 30: anything above is refused by default). */
  maxFeeBps?: number;
  /** The most the transaction may cost in network fees, in lamports (default 0.001 SOL). */
  maxNetworkFeeLamports?: number;
  /**
   * The only wallet the fee may go to (or nowhere). Orientim's own (`ORIENTIM_TREASURY`) unless set; set it
   * only to use another Orientim deployment.
   */
  treasury?: string;
  /**
   * The tolerance the agent chose for its route, in bps (`MIN_SLIPPAGE_BPS` to `MAX_SLIPPAGE_BPS`):
   * the route may carry that much and no more. Unset: 0.5%, or 3% on a Pump.fun bonding curve. It
   * comes from the agent's own intent, never from Orientim's answer.
   */
  slippageBps?: number;
  /**
   * The owner's ceiling on the route's tolerance, in bps (`OwnerPolicy.maxSlippageBps`): no Jupiter
   * route in the transaction may carry more, whatever the default for its kind. It holds on the bytes
   * that are signed, so a route that turns out to trade on a Pump.fun curve (3% by default) is held
   * to it even when the agent's own quote was an ordinary route. From the owner's file only.
   */
  maxSlippageCeilingBps?: number;
  /**
   * The most rent the route may keep, in lamports: what the wallet sends for a market's account,
   * less what closing it returns in the same transaction (default 0.001 SOL). A Pump.fun bonding
   * curve keeps about 0.00013 SOL of every buy for growing its own account.
   */
  maxRouteCostLamports?: number;
  /**
   * The most Orientim's fee may be in lamports when it is paid in SOL from the wallet: a swap between
   * two tokens neither of which can carry it pays `feeBps` of its value in SOL, at a price the rules
   * cannot see. Required for such a swap; `ownSolFeeLimit` asks Jupiter for it.
   */
  maxSolFeeLamports?: number;
  /**
   * One ceiling for all the SOL the swap may cost and not return, in lamports: the network fee the transaction can pay (its compute budget, as the verifier
   * reads it), rent the route keeps, and Orientim's fee whenever it is in SOL (`solFeeOf`: taken from
   * SOL sold, from SOL bought, or paid from the wallet). A new output account's rent is not in it:
   * that account stays the wallet's own; nor is the SOL the swap itself sells.
   */
  maxSolCostLamports?: number;
};

/** The parts of a /api/v1/prepare answer the check reads. */
export type PreparedSwap = {
  transaction: string;
  messageSha256: string;
  temporaryAuthority: string;
  policy: Record<string, unknown>;
};

/**
 * Orientim's fee in lamports when it is in SOL, whichever side it is taken from: from SOL the swap
 * sells (`feeSide` input), from SOL it buys (output), or from the wallet for a pair that cannot carry
 * it (sol). 0 when the fee is in another token.
 */
export function solFeeOf(p: { feeSide: string | null; inputMint: string; outputMint: string; fee: bigint }): bigint {
  const inSol = p.feeSide === 'sol'
    || (p.feeSide === 'input' && p.inputMint === WSOL_MINT)
    || (p.feeSide === 'output' && p.outputMint === WSOL_MINT);
  return inSol ? p.fee : 0n;
}

const BIGINT_FIELDS = ['minOut', 'takerRent', 'routeRefund', 'amountIn', 'feeBps', 'fee', 'swapAmount', 'maxNetworkFeeLamports'] as const;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isAddress = (v: unknown) => typeof v === 'string' && ADDRESS.test(v);
/**
 * Every other field of a policy the verifier reads, with the one shape it may take. A policy comes
 * from the server, and the verifier repeats some of its fields in the problems it finds, which reach
 * the agent: a field of any other shape (prose above all) makes the whole policy malformed.
 */
const POLICY_SHAPE: Readonly<Record<string, (v: unknown) => boolean>> = {
  owner: isAddress, ephemeral: isAddress, inputMint: isAddress, outputMint: isAddress,
  inputTokenProgram: isAddress, outputTokenProgram: isAddress, jupiterProgram: isAddress,
  inputTransferFee: v => typeof v === 'boolean',
  inputDecimals: v => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255,
  outputDecimals: v => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255,
  routeRefundProgram: v => v === null || isAddress(v),
  treasury: v => v === null || isAddress(v),
  feeSide: v => v === null || v === 'input' || v === 'output' || v === 'sol',
  variant: v => v === 'A' || v === 'B' || v === 'C',
};
const ACCOUNT_FIELDS = ['eIn', 'eOut', 'wIn', 'wOut', 'feeDestination', 'routeAccount', 'routeEventAuthority'] as const;

function policyOf(json: Record<string, unknown>): Policy | null {
  try {
    const accounts = json.accounts as Record<string, unknown> | null | undefined;
    if (!accounts || typeof accounts !== 'object') return null;
    for (const k of ACCOUNT_FIELDS) if (!(accounts[k] === null || accounts[k] === undefined || isAddress(accounts[k]))) return null;
    if (!isAddress(accounts.eIn)) return null;
    for (const [k, fits] of Object.entries(POLICY_SHAPE)) if (!fits(json[k])) return null;
    // Only the fields named here reach the verifier.
    const p: Record<string, unknown> = { accounts: Object.fromEntries(ACCOUNT_FIELDS.map(k => [k, accounts[k] ?? null])) };
    for (const k of Object.keys(POLICY_SHAPE)) p[k] = json[k];
    for (const k of BIGINT_FIELDS) {
      if (typeof json[k] !== 'string' || !/^\d{1,20}$/.test(json[k] as string)) return null;
      p[k] = BigInt(json[k] as string);
    }
    return p as unknown as Policy;
  } catch {
    return null;
  }
}

/** A value from the server, shown in a problem only as an address; anything else is not repeated. */
const shown = (v: unknown) => (typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : '(not an address)');
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');

/**
 * The problems found, or an empty list. Sign only when it is empty. `rpc` must be the agent's own
 * RPC, not one Orientim provides: the check is worth what the chain state it reads is worth.
 */
export async function verifyPrepared(
  prepared: PreparedSwap, limits: AgentLimits, rpc: Rpc<SolanaRpcApi>, opts: { requestTimeoutMs?: number } = {},
): Promise<string[]> {
  // Every read on your RPC ends in time: one that never answers is a problem, not a wait.
  const timeoutMs = opts.requestTimeoutMs ?? 10_000;
  const problems: string[] = [];
  let transaction;
  try {
    transaction = getTransactionDecoder().decode(Buffer.from(prepared.transaction, 'base64'));
  } catch {
    return ['the transaction cannot be decoded'];
  }
  const digest = hex(await crypto.subtle.digest('SHA-256', new Uint8Array(transaction.messageBytes)));
  if (digest !== prepared.messageSha256) problems.push('the message does not hash to messageSha256');

  // The policy comes from the server too, so every part of it that matters is held to the agent's
  // own intent and limits before the verifier uses it.
  const p = policyOf(prepared.policy);
  if (!p) return [...problems, 'the policy is malformed'];
  if (p.owner !== limits.owner) problems.push(`the policy is for wallet ${shown(p.owner)}, not yours`);
  if (p.inputMint !== limits.inputMint || p.outputMint !== limits.outputMint) problems.push('the policy is for other tokens');
  if (p.amountIn !== BigInt(limits.amountIn)) problems.push(`the policy debits ${p.amountIn}, not ${limits.amountIn}`);
  if (p.jupiterProgram !== JUPITER_PROGRAM) problems.push(`the swap program is ${shown(p.jupiterProgram)}, not Jupiter`);
  if (p.ephemeral !== prepared.temporaryAuthority) problems.push('the one-time key differs from the one stated');
  if (p.feeBps > BigInt(feeLimitBps(limits.maxFeeBps))) problems.push(`the fee of ${p.feeBps} bps is above your limit`);
  if (p.treasury !== null && p.treasury !== (limits.treasury || ORIENTIM_TREASURY)) problems.push(`the fee goes to ${shown(p.treasury)}, not Orientim's treasury`);
  if (p.maxNetworkFeeLamports > BigInt(limits.maxNetworkFeeLamports ?? 1_000_000)) {
    problems.push(`the network fee may reach ${p.maxNetworkFeeLamports} lamports, above your limit`);
  }
  // A fee in SOL from the wallet is priced by the server; the agent holds it to a price of its own.
  if (p.feeSide === 'sol') {
    if (limits.maxSolFeeLamports === undefined) {
      problems.push('the Orientim fee is paid in SOL at a price the check cannot see: hold it with maxSolFeeLamports from ownSolFeeLimit, which asks Jupiter (a higher limit only in the owner\'s own words)');
    } else if (p.fee > BigInt(limits.maxSolFeeLamports)) {
      problems.push(`the Orientim fee in SOL is ${p.fee} lamports, above your limit of ${limits.maxSolFeeLamports}`);
    }
  }
  // Rent that does not come back is a cost of its own, apart from the network fee.
  const routeCost = p.takerRent - p.routeRefund;
  const maxRouteCost = BigInt(limits.maxRouteCostLamports ?? 1_000_000);
  if (routeCost > maxRouteCost) {
    problems.push(`the route keeps ${routeCost} lamports of rent that do not come back, above your limit of ${maxRouteCost} (maxRouteCostLamports)`);
  }
  // What the wallet keeps: the enforced minimum, less a fee taken from the output (like Jupiter's,
  // Orientim takes its fee in SOL first, then USDC or USDT, on whichever side of the swap they are).
  const keeps = p.feeSide === 'output' ? p.minOut - p.fee : p.minOut;
  if (!/^\d{1,20}$/.test(limits.minOut ?? '') || BigInt(limits.minOut) === 0n) {
    problems.push('no minimum of your own: take minOut from ownMinimum, which asks Jupiter (a lower one only in the user\'s own words)');
  } else if (keeps < BigInt(limits.minOut)) {
    problems.push(`the minimum ${keeps} is below yours, ${limits.minOut}`);
  }

  // Chain state from the agent's own RPC: every account the message names, resolved through its
  // lookup tables, the accounts the policy derives, and what is under the one-time key.
  let snapshot: ChainSnapshot;
  let snapshotAddresses: Address[] = [];
  const underKey = await underKeyOf(p.ephemeral);
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes) as unknown as {
      staticAccounts: Address[];
      addressTableLookups?: { lookupTableAddress: Address; writableIndexes: number[]; readonlyIndexes: number[] }[];
    };
    const lookups = compiled.addressTableLookups ?? [];
    const lookupTables: Record<string, readonly Address[]> = lookups.length
      ? await fetchAddressesForLookupTables(lookups.map(l => l.lookupTableAddress), rpc as never, { abortSignal: AbortSignal.timeout(timeoutMs) })
      : {};
    const resolved = lookups.flatMap(l =>
      [...l.writableIndexes, ...l.readonlyIndexes].map(i => lookupTables[l.lookupTableAddress]?.[i]).filter((a): a is Address => !!a));
    const derived = Object.values(p.accounts).filter((a): a is Address => !!a);
    const addresses = [
      ...compiled.staticAccounts, ...resolved, ...derived, p.inputMint, p.outputMint, p.ephemeral,
      ...(p.treasury ? [p.treasury] : []), ...underKey,
    ];
    const { accounts, slot } = await readAccounts(rpc as never, addresses, { timeoutMs });
    snapshot = { accounts, lookupTables, slot };
    snapshotAddresses = [...compiled.staticAccounts, ...resolved];
  } catch (e) {
    return [...problems, `the chain state could not be read from your RPC: ${(e as Error).message}`];
  }

  if (limits.slippageBps !== undefined && !isSlippageBps(limits.slippageBps)) {
    return [...problems, `slippageBps must be a whole number of bps from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}`];
  }
  // The route's tolerance is the agent's own choice, or the verifier's defaults: never the server's.
  const verdict = await verify(transaction, p, snapshot, limits.slippageBps !== undefined ? { maxSlippageBps: limits.slippageBps } : {});
  for (const v of verdict.violations) problems.push(`${v.rule}: ${v.detail}`);
  // The owner's ceiling, on the bytes that are signed: every Jupiter route, whatever its kind.
  if (limits.maxSlippageCeilingBps !== undefined) problems.push(...routesAboveCeiling(transaction.messageBytes, limits.maxSlippageCeilingBps));
  if (limits.maxSolCostLamports !== undefined && verdict.networkFeeLamports !== undefined) {
    const solCost = verdict.networkFeeLamports + routeCost + solFeeOf(p);
    if (solCost > BigInt(limits.maxSolCostLamports)) {
      problems.push(`the swap may cost ${solCost} lamports of SOL that do not come back, above your limit of ${limits.maxSolCostLamports} (maxSolCostLamports)`);
    }
  }
  // Every account the transaction names that did not exist before it: what the route opens, besides
  // the wallet's own output account (and the treasury, which receives but is never created here).
  const exists = (a: Address) => { const s = snapshot.accounts.get(a); return !!s && (s.lamports > 0n || s.data.length > 0); };
  const keep = new Set<string>([p.accounts.wOut, p.treasury].filter((a): a is Address => !!a));
  const fresh = [...new Set(snapshotAddresses)].filter(a => !exists(a) && !keep.has(a));
  // Simulated on state not older than the snapshot just read.
  problems.push(...await leftUnderKey(prepared.transaction, transaction, underKey, snapshot, rpc, timeoutMs, fresh));
  return problems;
}

/**
 * Each instruction's program and data, from a compiled message of either version: v0 lists
 * instructions; v1 lists instruction headers and payloads.
 */
function compiledInstructions(messageBytes: Transaction['messageBytes']): { program: Address | undefined; data?: Uint8Array }[] {
  const m = getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as {
    staticAccounts: Address[];
    instructions?: { programAddressIndex: number; data?: Uint8Array }[];
    instructionHeaders?: { programAccountIndex: number }[];
    instructionPayloads?: { instructionData?: Uint8Array }[];
  };
  if (m.instructions) return m.instructions.map(ix => ({ program: m.staticAccounts[ix.programAddressIndex], data: ix.data }));
  return (m.instructionHeaders ?? []).map((h, i) => ({ program: m.staticAccounts[h.programAccountIndex], data: m.instructionPayloads?.[i]?.instructionData }));
}

/**
 * Every Jupiter route in the message that tolerates more than the owner's `ceiling`, as problems. A
 * program is always a static account, so no lookup table can hide the route from this reading.
 */
function routesAboveCeiling(messageBytes: Transaction['messageBytes'], ceiling: number): string[] {
  if (!isSlippageBps(ceiling)) return [`the owner's maxSlippageBps must be a whole number of bps from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}`];
  return compiledInstructions(messageBytes)
    .filter(ix => ix.program === JUPITER_PROGRAM)
    .map(ix => jupiterRouteArgs(ix.data ?? new Uint8Array()))
    .filter(args => !args || args.slippageBps > ceiling)
    .map(args => (args
      ? `the Jupiter route tolerates ${args.slippageBps} bps, above the owner's limit of ${ceiling} (maxSlippageBps)`
      : 'a Jupiter instruction is not a route the check can read against the owner\'s maxSlippageBps'));
}

/**
 * E, each Pump market's account in E's name, and the token accounts those hold cashback in (WSOL,
 * or USDC on a USDC-quoted market): a claim E could make later is value under E too.
 */
async function underKeyOf(key: Address): Promise<Address[]> {
  const markets = await Promise.all([PUMP_CURVE_PROGRAM, PUMP_AMM_PROGRAM].map(program => routeAccountFor(program, key)));
  const cashback = await Promise.all(markets.flatMap(owner => [WSOL_MINT, USDC_MINT].map(async mint =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM }))[0])));
  return [key, ...markets, ...cashback];
}

/** The wait before a failed simulation is asked once more (about three slots). */
const SIMULATION_RETRY_MS = 1_200;

/**
 * The program that failed in a simulation and its error code, from the logs: only an address and a
 * number, never a program's own words (a route's program writes its logs, and they reach the agent).
 */
function failingProgram(logs: readonly string[] | null | undefined): string {
  for (const line of logs ?? []) {
    const m = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: custom program error: 0x([0-9a-f]{1,8})$/i.exec(line);
    if (m) return ` (program ${m[1]}, error ${parseInt(m[2], 16)})`;
  }
  return '';
}

/**
 * What stays behind after the swap, simulated on the agent's own RPC: under the one-time key, in the
 * account each Pump.fun market opens in its name, and in any other account the route opens. Every
 * lamport the wallet sends E (a market's account rent) must be spent by the route or come back in the
 * same transaction; a server that stated more than the route needs, a smaller refund, or a market
 * account left open would otherwise leave lamports under a key it can derive. An account the route opens and leaves open may hold a claim tied to E
 * whatever market it belongs to, so none may stay. An account that does not exist
 * afterwards holds nothing; an answer that does not report the accounts proves nothing, and is refused.
 */
async function leftUnderKey(
  wire: string, transaction: Transaction, underKey: readonly Address[], snapshot: ChainSnapshot,
  rpc: Rpc<SolanaRpcApi>, timeoutMs = 10_000, fresh: readonly Address[] = [],
): Promise<string[]> {
  const opened = fresh.filter(a => !underKey.includes(a));
  try {
    // Every account's balance after the swap comes from `postBalances`, matched to the accounts the
    // transaction names: `accounts.addresses` is limited to two on some providers.
    // A node behind the snapshot's slot says so: it catches up in a slot or two, so it is asked again.
    const simulate = () => rpc
      .simulateTransaction(wire as never, {
        encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
        ...((snapshot.slot ?? 0n) > 0n ? { minContextSlot: snapshot.slot } : {}),
      })
      .send({ abortSignal: AbortSignal.timeout(timeoutMs) });
    const settled = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await simulate();
        } catch (e) {
          if (attempt >= 4 || !isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED)) throw e;
          await new Promise(r => setTimeout(r, 400));
        }
      }
    };
    // A route that fails now may pass a moment later: a market whose price is set each slot by its
    // maker, or a price that moved past the tolerance and back. It is simulated once more, and only a
    // simulation that succeeds is read; one that fails twice is refused.
    let { value } = await settled();
    if (value.err) {
      await new Promise(r => setTimeout(r, SIMULATION_RETRY_MS));
      ({ value } = await settled());
    }
    if (value.err) {
      return [`the swap fails in simulation on your RPC, twice: ${JSON.stringify(value.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}${failingProgram(value.logs)}`];
    }
    const balances = balancesAfterSimulation(transaction, value as never, snapshot.lookupTables);
    if (typeof balances === 'string') return [`the simulation on your RPC cannot show what the one-time key holds after the swap: ${balances}`];
    // An account the transaction does not name cannot change in it: it holds what the snapshot read,
    // and only a snapshot that read it proves it empty.
    const heldAfter = (a: Address): bigint | null => {
      const after = balances.get(a);
      if (after !== undefined) return after;
      if (!snapshot.accounts.has(a)) return null;
      return snapshot.accounts.get(a)?.lamports ?? 0n;
    };
    const problems: string[] = [];
    const unknown = [...underKey, ...opened].filter(a => heldAfter(a) === null);
    if (unknown.length) return [`what ${unknown.length} account(s) under the one-time key hold after the swap could not be read`];
    const held = heldAfter(underKey[0])!;
    if (held !== 0n) problems.push(`the one-time key would keep ${held} lamports after the swap`);
    const inMarkets = underKey.slice(1).reduce((sum, a) => sum + heldAfter(a)!, 0n);
    if (inMarkets !== 0n) problems.push(`a market account under the one-time key would keep ${inMarkets} lamports after the swap`);
    const left = opened.filter(a => heldAfter(a) !== 0n);
    if (left.length) problems.push(`the route would leave open ${left.length} account(s) it creates (${left.join(', ')}), holding lamports no one returns`);
    return problems;
  } catch (e) {
    return [`the swap could not be simulated on your RPC: ${(e as Error).message}`];
  }
}

/**
 * A floor of the agent's own, from a price it asks Jupiter for itself: the
 * output for the amount Orientim will route (after its fee), less `maxBelowBps`. By default 2%, or 5%
 * when the route trades on a Pump.fun bonding curve, which Orientim quotes at 3%: enough for Orientim's
 * tolerance, its narrower routes and a few seconds of movement, and far from "almost nothing". With
 * `slippageBps`, the tolerance the agent chose and 1.5% more (2% on a curve).
 * Without `apiKey`, Jupiter allows a request every two seconds.
 */
export type OwnQuoteArgs = {
  inputMint: string; outputMint: string; amountIn: string; taker: string;
  maxFeeBps?: number; maxBelowBps?: number; jupiterUrl?: string; apiKey?: string; fetchImpl?: typeof fetch;
  /**
   * The tolerance the agent chose for its route (`AgentLimits.slippageBps`). Without `maxBelowBps`,
   * the floor then sits that far below Jupiter's price, and 1.5% more (2% on a Pump.fun curve) for
   * the quote to differ between two asks.
   */
  slippageBps?: number;
  /**
   * Ask Jupiter how much tolerance this trade needs (`autoSlippageBps`) instead of `slippageBps`:
   * the answer's `slippageBps` is then that estimate, and the floor follows it as it follows a chosen one.
   */
  autoSlippage?: boolean;
  /**
   * The owner's ceilings (`OwnerPolicy`): the route's tolerance never above `maxSlippageBps` (a
   * default or an estimate above it is lowered to it; the answer's `slippageBps` then says so), and
   * the floor never further below the price than `maxBelowBps` (a default further below is raised
   * to it). A chosen tolerance or `maxBelowBps` above them is the caller's to refuse.
   */
  ceilings?: { maxSlippageBps?: number; maxBelowBps?: number };
  /**
   * The transfer fee the input token charges now (`inputTransferFee`), if any: such a token keeps a
   * cut of the transfer into the temporary account, so the route is priced for what arrives there.
   * Without it, the floor of a taxing token would sit above what any honest route can deliver.
   */
  inputTax?: TransferFee | null;
  /**
   * Only the owner's word (`OwnerPolicy.allowUnknownPriceImpact`): an answer without a price impact
   * is then accepted, with `priceImpactBps` null. Otherwise it is refused, never read as none.
   */
  allowUnknownImpact?: boolean;
};

/**
 * A floor of the agent's own (`ownQuote`), for a swap within the price impact limit: an amount that
 * moves the market more than `maxPriceImpactBps` (default 5%, at most 20%) is refused here, as the
 * example and `orientim-verify` refuse it, so that a bot built on `ownMinimum` and `verifyPrepared`
 * keeps that check. `verifyPrepared` itself checks the bytes against your limits, not the market.
 */
export async function ownMinimum(args: OwnQuoteArgs & { maxPriceImpactBps?: number }): Promise<string> {
  const limit = args.maxPriceImpactBps ?? DEFAULT_MAX_PRICE_IMPACT_BPS;
  if (!(Number.isInteger(limit) && limit >= 0 && limit <= MAX_PRICE_IMPACT_BPS)) {
    throw usageError(`maxPriceImpactBps must be a whole number of bps from 0 to ${MAX_PRICE_IMPACT_BPS}. Nothing was sent.`);
  }
  const own = await ownQuote(args);
  if (own.priceImpactBps !== null && own.priceImpactBps > limit) {
    throw new Error(`Price impact is ${(own.priceImpactBps / 100).toFixed(2)}%, above the limit of ${(limit / 100).toFixed(2)}%: this amount would move the market too much. Nothing was sent.`);
  }
  return own.minOut;
}

/**
 * Jupiter's price for the amount Orientim will route, asked for directly: the agent's own floor
 * (`minOut`, base units), how far this amount moves the market (`priceImpactBps`), and whether the
 * route trades on a Pump.fun bonding curve. A large price impact is the mark of thin liquidity, as
 * when a token's pool is drained: the check refuses it (`DEFAULT_MAX_PRICE_IMPACT_BPS`).
 */
export async function ownQuote(args: OwnQuoteArgs): Promise<{
  minOut: string; outAmount: string; priceImpactBps: number | null; curve: boolean;
  /** The tolerance to build the route at, when it is not Orientim's default: chosen, estimated, or the owner's ceiling. */
  slippageBps?: number;
}> {
  if (args.maxBelowBps !== undefined && !(Number.isInteger(args.maxBelowBps) && args.maxBelowBps >= 0 && args.maxBelowBps <= MAX_BELOW_BPS)) {
    throw usageError(`maxBelowBps must be a whole number of bps from 0 to ${MAX_BELOW_BPS}: a floor further below the market is not accepted. Nothing was sent.`);
  }
  const amount = BigInt(args.amountIn);
  const afterFee = amount - (amount * BigInt(feeLimitBps(args.maxFeeBps))) / 10_000n;
  const routed = args.inputTax ? afterFee - transferFeeOn(afterFee, args.inputTax) : afterFee;
  const url = new URL(args.jupiterUrl ?? 'https://api.jup.ag/swap/v2/build');
  const query = {
    inputMint: args.inputMint, outputMint: args.outputMint, amount: routed.toString(), taker: args.taker,
    slippageBps: args.autoSlippage ? 'rtse' : '50', maxAccounts: '64',
  };
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const r = (await askJupiter(url.toString(), 'your own price', args.apiKey, args.fetchImpl)) as {
    inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string; otherAmountThreshold?: string; priceImpactPct?: string | number;
    swapInstruction?: { accounts?: { pubkey: string }[] };
  };
  if (r.inputMint !== args.inputMint || r.outputMint !== args.outputMint || r.inAmount !== routed.toString() || !/^\d{1,20}$/.test(r.outAmount ?? '')) {
    throw new Error('Jupiter answered for another trade when asked for your own price');
  }
  const curve = r.swapInstruction?.accounts?.some(a => a.pubkey === PUMP_CURVE_PROGRAM) ?? false;
  // The tolerance: chosen, or estimated on "auto" (3% on a curve, as Orientim's default there), and
  // never above the owner's ceiling. Undefined leaves Orientim's default, which is within it.
  const ceiling = args.ceilings?.maxSlippageBps;
  let slippage = args.slippageBps ?? (args.autoSlippage ? (curve ? CURVE_SLIPPAGE_BPS : autoSlippageBps(r)) : undefined);
  if (ceiling !== undefined) {
    const effective = slippage ?? (curve ? CURVE_SLIPPAGE_BPS : DEFAULT_SLIPPAGE_BPS);
    if (effective > ceiling) slippage = ceiling;
  }
  const defaultBelow = slippage !== undefined ? slippage + (curve ? 200 : 150) : (curve ? 500 : 200);
  const belowCeiling = args.ceilings?.maxBelowBps;
  const below = BigInt(args.maxBelowBps ?? (belowCeiling !== undefined && defaultBelow > belowCeiling ? belowCeiling : Math.min(defaultBelow, MAX_BELOW_BPS)));
  // The price impact is a hard limit: an answer without it, or with one that is not a number, is
  // refused rather than read as none, unless the owner said to go on without it.
  const impact = typeof r.priceImpactPct === 'number' || (typeof r.priceImpactPct === 'string' && r.priceImpactPct.trim() !== '')
    ? Number(r.priceImpactPct) : NaN;
  if (!Number.isFinite(impact) && !args.allowUnknownImpact) {
    throw new Error('Jupiter answered without a price impact when asked for your own price: how much this amount moves the market is unknown');
  }
  return {
    minOut: ((BigInt(r.outAmount!) * (10_000n - below)) / 10_000n).toString(),
    outAmount: r.outAmount!,
    priceImpactBps: !Number.isFinite(impact) ? null : impact > 0 ? Math.round(impact * 10_000) : 0,
    curve,
    ...(slippage !== undefined ? { slippageBps: slippage } : {}),
  };
}

/** Stablecoins and SOL keep authorities by design; a note on every swap of them would teach agents to skip notes. */
const QUIET_MINTS = new Set<string>([WSOL_MINT, USDC_MINT, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

/**
 * What the agent should know about the tokens themselves, read from the mint accounts on its own RPC:
 * an issuer that can freeze balances, or mint more. The prepare response carries the same notes. Orientim
 * protects the wallet, not the value of what is bought. Never fails: an unreadable mint gives no note.
 */
/** What a mint lets its issuer do, read on your RPC. `wellKnown`: SOL, USDC or USDT, which keep these powers by design. */
export type TokenPowers = { freezeAuthority: boolean; mintAuthority: boolean; permanentDelegate: boolean; wellKnown: boolean };
/**
 * The issuer's powers over each token, or `unavailable` when the mint accounts could not be read:
 * a failed read is never reported as no risk. A Token-2022 permanent delegate can move or burn any
 * holder's balance; a freeze authority can freeze it; a mint authority can mint more.
 */
export type TokenRisk =
  | { status: 'known'; tokens: Record<string, TokenPowers | { exists: false }> }
  | { status: 'unavailable'; reason: string };

export async function tokenRisk(rpc: Rpc<SolanaRpcApi>, mints: readonly string[], timeoutMs = 10_000): Promise<TokenRisk> {
  const asked = [...new Set(mints)];
  try {
    const { accounts } = await readAccounts(rpc as never, asked as Address[], { timeoutMs });
    const tokens: Record<string, TokenPowers | { exists: false }> = {};
    for (const m of asked) {
      const s = accounts.get(m);
      if (!s || s.data.length < 82 || (s.owner !== TOKEN_PROGRAM && s.owner !== TOKEN_2022_PROGRAM)) {
        tokens[m] = { exists: false };
        continue;
      }
      const view = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength);
      tokens[m] = {
        freezeAuthority: view.getUint32(46, true) === 1,
        mintAuthority: view.getUint32(0, true) === 1,
        permanentDelegate: s.owner === TOKEN_2022_PROGRAM && hasPermanentDelegate(s.data),
        wellKnown: QUIET_MINTS.has(m),
      };
    }
    return { status: 'known', tokens };
  } catch (e) {
    return { status: 'unavailable', reason: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'read-failed' };
  }
}

/**
 * Notes about the tokens themselves, from `tokenRisk`: an issuer that can move or burn your balance,
 * freeze it, or mint more (none for SOL, USDC and USDT, which keep them by design). When the mints
 * could not be read, one note says so: unknown is never reported as nothing to note.
 */
export async function tokenNotices(rpc: Rpc<SolanaRpcApi>, mints: readonly string[], timeoutMs = 10_000): Promise<string[]> {
  return noticesOf(await tokenRisk(rpc, mints, timeoutMs));
}

/** `tokenNotices` from a `tokenRisk` already read. */
export function noticesOf(risk: TokenRisk): string[] {
  if (risk.status === 'unavailable') return ["the tokens' mint accounts could not be read on your RPC: what their issuers can do is unknown"];
  const notes: string[] = [];
  for (const [m, t] of Object.entries(risk.tokens)) {
    if (!('wellKnown' in t) || t.wellKnown) continue;
    const name = `${m.slice(0, 4)}…${m.slice(-4)}`;
    if (t.permanentDelegate) notes.push(`${name} has a permanent delegate: its issuer can move or burn your balance at any time`);
    if (t.freezeAuthority) notes.push(`${name} has a freeze authority: its issuer can freeze your balance`);
    if (t.mintAuthority) notes.push(`${name} can still be minted by its issuer`);
  }
  return notes;
}

/**
 * The transfer fee a Token-2022 input token charges in the current epoch, read on your RPC; null
 * when it charges none (a classic token, or no TransferFeeConfig). For `ownMinimum`'s `inputTax`.
 */
export async function inputTransferFee(rpc: Rpc<SolanaRpcApi>, mint: string, timeoutMs = 10_000): Promise<TransferFee | null> {
  const state = (await readAccounts(rpc as never, [mint as Address], { timeoutMs })).accounts.get(mint);
  if (!state || state.owner !== TOKEN_2022_PROGRAM || !hasTransferFee(state.data)) return null;
  // Which of the two fee settings applies depends on the epoch, as the token program decides it.
  const { epoch } = await rpc.getEpochInfo({ commitment: 'confirmed' }).send({ abortSignal: AbortSignal.timeout(timeoutMs) });
  return transferFeeOf(state.data, BigInt(epoch));
}

/**
 * The most Orientim's fee in SOL may be for a swap that neither token can carry the fee for, from a
 * price the agent asks Jupiter for itself: `maxFeeBps` (default 30) of what `amountIn` of the input
 * is worth in SOL, plus 2% for the price moving between the server's quote and this one. In
 * lamports.
 */
export async function ownSolFeeLimit(args: {
  inputMint: string; amountIn: string; taker: string;
  maxFeeBps?: number; jupiterUrl?: string; apiKey?: string; fetchImpl?: typeof fetch;
}): Promise<number> {
  const url = new URL(args.jupiterUrl ?? 'https://api.jup.ag/swap/v2/build');
  const query = {
    inputMint: args.inputMint, outputMint: 'So11111111111111111111111111111111111111112', amount: args.amountIn,
    taker: args.taker, slippageBps: '50', maxAccounts: '64',
  };
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const r = (await askJupiter(url.toString(), 'the value of your swap in SOL', args.apiKey, args.fetchImpl)) as { inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string };
  if (r.inputMint !== args.inputMint || r.outputMint !== query.outputMint || r.inAmount !== args.amountIn || !/^\d{1,20}$/.test(r.outAmount ?? '')) {
    throw new Error('Jupiter answered for another trade when asked for the value of your swap in SOL');
  }
  const fee = (BigInt(r.outAmount!) * BigInt(feeLimitBps(args.maxFeeBps))) / 10_000n;
  const limit = fee + fee / 50n;
  // A limit beyond what a Number holds exactly is refused rather than rounded.
  if (limit > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('the fee in SOL for this amount is beyond an exact limit: only the owner can set maxSolFeeLamports for it');
  return Number(limit);
}
