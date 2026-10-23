/** Client types and calls for the Orientim agent API. */
import { createSolanaRpc } from '@solana/kit';
import { DIGITS } from './util.ts';
import { BudgetSpentError, fetchRoutes, PREPARATION_MS, preparationBudget, routeRequestKey, routeRequestsFor, timeLeftOf } from './verify.ts';
import type { FetchedRoute, JupiterBudget } from './verify.ts';

/** A swap request from an agent. */
export type Intent = {
  owner: string;
  inputMint: string;
  outputMint: string;
  /** Base units, as a string. */
  amountIn: string;
  /** Minimum output in base units; required by the check, derived from Jupiter when omitted. */
  minOut?: string;
  /** Margin below Jupiter's price for a derived `minOut`, in bps. */
  maxBelowBps?: number;
  /** Highest accepted Orientim fee in bps (default 25, max 30). */
  maxFeeBps?: number;
  /** Highest accepted network fee, in lamports. */
  maxNetworkFeeLamports?: number;
  /** The only allowed fee destination; defaults to Orientim's pinned treasury. */
  treasury?: string;
  /** Highest accepted non-refundable route rent, in lamports (default 0.001 SOL). */
  maxRouteCostLamports?: number;
  /** Highest accepted Orientim fee when paid in SOL from the wallet, in lamports. */
  maxSolFeeLamports?: number;
  /** Optional ceiling on all non-returned SOL costs (network fee, kept rent, SOL fee), in lamports. */
  maxSolCostLamports?: number;
  /** Market gap the user accepted after a `costs-more` error, in bps. */
  acceptCostBps?: string;
  /**
   * Route slippage tolerance, 10 to 1500 bps, or `"auto"` for Jupiter's estimate. Capped by the
   * owner's `maxSlippageBps`: an explicit value above it is refused.
   */
  slippageBps?: number | 'auto';
  /** Opt in to Jupiter's beta fast route search when the deployment enables it. */
  routingMode?: 'standard' | 'fast';
  /** Highest accepted price impact in bps (default 500); above it the swap is refused with `PriceImpactError`. */
  maxPriceImpactBps?: number;
  /** Transaction version; 1 only where the deployment supports it. */
  version?: 0 | 1;
  /**
   * Stable order id, reused on every retry. With an order book, an order that confirmed or may still
   * land is never swapped again by a different transaction.
   */
  id?: string;
};

/** Orientim's prepare response. */
export type Prepared = {
  ticket: string;
  transaction: string;
  messageSha256: string;
  wallet: string;
  temporaryAuthority: string;
  lastValidBlockHeight: string;
  /** Blocks left before expiry at prepare time (at most 150). */
  blocksLeft?: string;
  /** Slot the transaction was built at; the check requires the RPC to be at least this recent. */
  contextSlot?: string;
  /** `fee` is denominated in `feeMint`; `minOut` is the wallet's minimum after any output-side fee. */
  amounts: { amountIn: string; fee: string; feeMint?: string; feeBps: string; swapAmount: string; quotedOut: string; minOut: string; priceImpactPct?: number | null };
  /** `keptSolLamports` is the non-returned SOL cost; output account rent is excluded. */
  costs: { networkFeeLamports: string; outputAccountRentLamports: string; routeRentLamports: string; routeRefundLamports: string; keptSolLamports?: string; routeKeptLamports?: string; orientimFeeSolLamports?: string };
  certificate: {
    messageSha256: string; wallet: string; temporaryAuthority: string;
    input: { mint: string; totalDebit: string; orientimFee: string };
    output: { mint: string; minimumOutput: string; orientimFee?: string };
    /** Orientim's fee when paid in SOL from the wallet. */
    solFee?: { lamports: string; destination: string | null };
  };
  /** Slippage tolerance the transaction was built at, in bps. */
  slippageBps?: number;
  /** Server-reported policy; untrusted, checked against the intent. */
  policy: Record<string, unknown>;
};

/**
 * Custom sender for the signed base64 transaction, called repeatedly until it lands or expires.
 * A thrown error does not mean "not sent"; the outcome is read from the chain.
 */
export type SendTransaction = (signedTransaction: string) => Promise<unknown>;

/** A `SendTransaction` over a Solana RPC, with preflight and RPC-side retries disabled. */
export function rpcSender(url: string, timeoutMs = 10_000): SendTransaction {
  const rpc = createSolanaRpc(url);
  return wire => rpc.sendTransaction(wire as never, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send({ abortSignal: AbortSignal.timeout(timeoutMs) });
}

/** Orientim's finalize response. Not evidence of the outcome, which is read from the chain. */
export type Finalized = {
  signature: string;
  /** `signed`: requested with `send: false`; the agent sends the transaction. */
  status: 'sent' | 'unknown' | 'rejected' | 'signed';
  refusal?: string;
  /** Simulation error JSON for a `network` refusal; read via `networkCause`, never shown raw. */
  transactionError?: string;
  signedTransaction?: string;
  lastValidBlockHeight: string;
};

export type ApiError = { status: number; code: string; message: string; body: Record<string, unknown>; retryAfter?: number | null };

/**
 * Client-side text for each error code. Agents read these, never the server's text, so a compromised
 * server cannot inject instructions; server text is kept separately as untrusted `serverMessage`.
 */
export const ERROR_MEANINGS: Readonly<Record<string, string>> = {
  'price-moved': 'The best route that fits in one protected transaction no longer meets your minimum: the price moved, or the route that meets it is too big. Ask the user before preparing again with minOut set to newMinOut, or try a smaller amount.',
  'routes-needed': 'Orientim needs routes fetched from Jupiter with your own key; the skill does this itself. Prepare again.',
  'bad-session': 'The routes session expired or belongs to another swap. Prepare again from the start.',
  'costs-more': 'The protected route costs more than the open market. Ask the user; to accept, prepare again with acceptCostBps set to gapBps.',
  'output-balance-changed': 'Your balance of the output token changed since prepare, so nothing was signed. Settle what may still land, then prepare again.',
  'output-in-flight': 'Another swap into the same output account is signed and has not landed or expired yet, so nothing was signed. Wait the Retry-After seconds, then finalize again.',
  busy: "Jupiter or Orientim's Solana RPC is busy. Wait the Retry-After seconds, then try again.",
  unavailable: "Orientim, Jupiter or Orientim's Solana RPC did not answer. Wait the Retry-After seconds, then try again.",
  'rate-limited': 'Too many requests. Wait the Retry-After seconds, then try again.',
  expired: 'The transaction expired before it was signed by Orientim. Settle what may still land, then prepare again.',
  'route-format': 'Jupiter changed its format and Orientim cannot read it yet. Wait at least the Retry-After seconds.',
  paused: 'Orientim has paused swaps; funds are not affected. Try later.',
  'fee-unavailable': 'Orientim cannot collect its fee on this swap right now, so it built nothing. Wait the Retry-After seconds.',
  'amount-too-small': 'The amount is below the smallest swap Orientim takes. Swap a larger amount, or sell your whole balance of the token, which is allowed at any size.',
  'skill-outdated': 'This copy of the skill is too old for Orientim. Update it: use @orientimhq/swap@<minimum or later> (in an MCP client, in its configuration, or the current orientim.mcpb).',
  'transaction-changed': 'The signed transaction differs from the one prepared. Sign exactly what prepare returned.',
  'wallet-changed-transaction': 'The wallet changed the transaction or did not sign it. Sign exactly what prepare returned.',
  'unsupported-token': 'This token cannot be swapped safely now.',
  'no-route': 'No protected route was found for this swap now. Try a smaller amount, or once more a little later; if it is refused again, stop: the token may have no liquidity left, or its route does not fit in one transaction.',
  'insufficient-sol': 'The wallet may not hold enough SOL for this swap: Orientim estimates the most it needs while it runs, including deposits that come back.',
  'wallet-empty': 'The wallet holds less than the least a wallet needs for an API key (0.01 SOL unless Orientim set another amount). Fund it, then ask again.',
  'bad-signature': "Orientim did not accept the signed key message: the signature does not match it, or the challenge expired or is not Orientim's. Ask for a new challenge and sign it.",
  'insufficient-balance': 'The wallet does not hold enough of the input token.',
  'simulation-failed': 'The swap failed in simulation, so nothing was built.',
  'bad-request': 'Orientim could not read the request.',
  unauthorized: 'The API key was refused: missing, unknown, expired or revoked. Get a new one for this wallet (requestApiKey, or orientim key-challenge then key).',
  'wrong-wallet': 'This API key belongs to another wallet: a key prepares swaps for its own wallet only. Use this wallet\'s own key (requestApiKey, or orientim key-challenge then key).',
  'invalid-ticket': 'Orientim did not issue this ticket to this API key. Finalize with the ticket prepare returned, under the same key.',
  'not-enabled': 'This deployment does not offer what was asked (such as a v1 transaction). Ask without it.',
  'bad-quote': 'Orientim could not use the quote it got for this swap, so it built nothing. Try again in a moment.',
  'verification-failed': "Orientim's own verifier refused the transaction it built, so nothing was built or signed.",
  'token-data-mismatch': 'The token data Orientim read does not agree with the chain, so it built nothing. Try again in a moment.',
  'output-account-restricted': "The wallet's account for the output token is frozen or restricted, so this swap cannot be made safely.",
  'input-account-restricted': "The wallet's account for the input token is frozen or restricted, so this swap cannot be made safely.",
  internal: 'Orientim failed on its side; this request signed and sent nothing. Try again in a moment.',
};

/** Allowed error fields and their shapes; anything else is dropped so a server cannot inject prose. */
const ERROR_FIELDS: Readonly<Record<string, (v: unknown) => boolean>> = {
  newMinOut: v => typeof v === 'string' && DIGITS.test(v),
  newOutAmount: v => typeof v === 'string' && DIGITS.test(v),
  gapBps: v => (typeof v === 'string' && DIGITS.test(v)) || (typeof v === 'number' && Number.isInteger(v) && v >= 0),
  outAmount: v => typeof v === 'string' && DIGITS.test(v),
  baselineOut: v => typeof v === 'string' && DIGITS.test(v),
  requiresApproval: v => typeof v === 'boolean',
  signature: v => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(v),
  lastValidBlockHeight: v => typeof v === 'string' && DIGITS.test(v),
  minimum: v => typeof v === 'string' && (DIGITS.test(v) || /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v)),
  balanceAtPrepare: v => typeof v === 'string' && DIGITS.test(v),
  balanceNow: v => typeof v === 'string' && DIGITS.test(v),
  // Fields of a `routes-needed` error.
  session: v => typeof v === 'string' && v.length <= 2_000 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v),
  taker: v => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v),
  requests: v => Array.isArray(v) && v.length <= 8 && v.every(isRouteRequestShape),
};

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Strict shape check for a route request; no free-text fields are allowed. */
function isRouteRequestShape(r: unknown): boolean {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  const q = r as Record<string, unknown>;
  const known: Readonly<Record<string, (v: unknown) => boolean>> = {
    inputMint: v => typeof v === 'string' && ADDRESS.test(v),
    outputMint: v => typeof v === 'string' && ADDRESS.test(v),
    taker: v => typeof v === 'string' && ADDRESS.test(v),
    destinationTokenAccount: v => typeof v === 'string' && ADDRESS.test(v),
    amount: v => typeof v === 'string' && /^\d{1,20}$/.test(v),
    slippageBps: v => Number.isInteger(v),
    maxAccounts: v => Number.isInteger(v),
    mode: v => v === 'fast',
    excludeDexes: v => Array.isArray(v) && v.length <= 64 && v.every(d => typeof d === 'string' && /^[\w .()-]{1,64}$/.test(d)),
  };
  return Object.keys(q).every(k => Object.hasOwn(known, k) && known[k](q[k]));
}

/** Returns only the error fields allowed by `ERROR_FIELDS`. */
export function errorDetails(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, allowed] of Object.entries(ERROR_FIELDS)) if (Object.hasOwn(body, k) && allowed(body[k])) out[k] = body[k];
  return out;
}

/** Prepare response fields that are kept; others are dropped. */
export const PREPARED_FIELDS = [
  'ticket', 'transaction', 'messageSha256', 'wallet', 'temporaryAuthority', 'version', 'lastValidBlockHeight', 'blocksLeft', 'contextSlot',
  'amounts', 'costs', 'notices', 'tokens', 'slippageBps', 'route', 'certificate', 'policy',
] as const;

/** Fields kept from `amounts` and `costs`. */
export const AMOUNT_FIELDS = ['amountIn', 'fee', 'feeMint', 'feeBps', 'swapAmount', 'quotedOut', 'minOut', 'priceImpactPct'] as const;
export const COST_FIELDS = [
  'networkFeeLamports', 'outputAccountRentLamports', 'routeRentLamports', 'routeRefundLamports', 'keptSolLamports', 'routeKeptLamports',
  'orientimFeeSolLamports', 'breakdown', 'tokenTax',
] as const;

const CODE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Returns the code if it is well-formed, otherwise `other`. */
export const safeCode = (code: unknown) => (typeof code === 'string' && CODE.test(code) ? code : 'other');
/** Reduces untrusted server text to one short printable line. */
export const untrustedLine = (text: unknown) =>
  typeof text === 'string' ? text.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
/** Keeps only data values (numbers, booleans, null, spaceless strings) so server prose never reaches the agent. */
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

/** An error response from Orientim, with untrusted parts sanitized. */
export class OrientimApiError extends Error {
  readonly status: number;
  /** Error code, or `other` if unrecognized. */
  readonly code: string;
  /** Allowed data fields only. */
  readonly body: Record<string, unknown>;
  /** Server message, untrusted; for display only. */
  readonly serverMessage: string;
  /** Retry-After in seconds, or null. */
  readonly retryAfter: number | null;
  constructor(e: ApiError) {
    const code = safeCode(e.code);
    super(`${Number(e.status) || 0} ${code}: ${ERROR_MEANINGS[code] ?? 'Orientim refused this request; this request signed and sent nothing.'}`);
    this.status = Number(e.status) || 0;
    this.code = code;
    this.body = errorDetails((e.body ?? {}) as Record<string, unknown>);
    this.serverMessage = untrustedLine(e.message);
    this.retryAfter = e.retryAfter ?? null;
  }
}

export type Fetch = typeof fetch;

/** Package version, sent as `x-orientim-skill` so outdated clients get a clear `skill-outdated` error. */
export const SKILL_VERSION = '3.0.1';

/** Parses Retry-After in seconds, or null. */
export const retryAfterOf = (res: Response) => {
  const after = Number(res.headers.get('retry-after'));
  return Number.isFinite(after) && after > 0 ? after : null;
};

/** Error code for a response without one, such as a proxy error page. */
const codeOfStatus = (status: number) => (status === 429 ? 'rate-limited' : status >= 500 ? 'unavailable' : 'http');

/** Parses a response as JSON; a non-JSON body throws `OrientimApiError`. */
export async function answerOf<T>(res: Response): Promise<{ error?: { code: string; message: string } } & T> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new OrientimApiError({
      status: res.status, code: codeOfStatus(res.status), message: res.statusText, body: {}, retryAfter: retryAfterOf(res),
    });
  }
}

/** Prepare timeout; exceeds the server's 45 s maximum so a slow build is not retried. */
export const PREPARE_WAIT_MS = 60_000;
/** Limits for agent-fetched route rounds and total routes. */
const MAX_ROUTE_ROUNDS = 10;
const MAX_ROUTES = 24;

/**
 * Calls Orientim's prepare. With an agent Jupiter key, answers `routes-needed` rounds by fetching
 * routes locally (the key never leaves this process), falling back to Orientim's routes past the limits.
 */
export async function preparedByOrientim(
  fetchImpl: Fetch, apiUrl: string, apiKey: string, body: Record<string, unknown>, timeoutMs: number,
  own: {
    jupiterApiKey?: string; ownRoutes?: boolean; budget?: JupiterBudget;
    /** Pending agent minimum; sent from the second round on. */
    floor?: Promise<Record<string, unknown>>;
  },
): Promise<Prepared> {
  const url = `${apiUrl}/api/v1/prepare`;
  const budget = own.budget ?? preparationBudget();
  const prepare = async (payload: unknown): Promise<Prepared> => {
    const left = timeLeftOf(budget);
    if (left <= 0) throw outOfPreparationTime();
    const cutByBudget = left < timeoutMs;
    try {
      return await call<Prepared>(fetchImpl, url, apiKey, payload, Math.max(1, Math.floor(Math.min(timeoutMs, left))));
    } catch (e) {
      // Report a budget cutoff as such, not as a server timeout.
      if ((e as Error)?.name === 'TimeoutError' && cutByBudget) throw outOfPreparationTime();
      throw e;
    }
  };
  let floor: Record<string, unknown> | null = own.floor ? null : {};
  const withFloor = async () => {
    floor ??= await own.floor!;
    return { ...body, ...floor };
  };
  if (!own.jupiterApiKey || own.ownRoutes === false) return prepare(await withFloor());
  const fetched = new Map<string, FetchedRoute>();
  let session: string | undefined;
  let taker: string | undefined;
  const swap = (named: string) => ({ inputMint: String(body.inputMint), outputMint: String(body.outputMint), amountIn: String(body.amountIn), taker: named });
  for (let round = 0; round < MAX_ROUTE_ROUNDS; round++) {
    let prepared: Prepared;
    try {
      prepared = await prepare({ ...body, ...(floor ?? {}), ownRoutes: true, ...(session ? { session } : {}), routes: [...fetched.values()] });
    } catch (e) {
      // Some deployments require the minimum in the first round.
      if (floor === null && e instanceof OrientimApiError && e.code === 'bad-request') {
        await withFloor();
        continue;
      }
      if (!(e instanceof OrientimApiError) || e.code !== 'routes-needed') throw e;
      const asked = e.body as { session?: unknown; taker?: unknown; requests?: unknown };
      if (typeof asked.session !== 'string' || asked.session.length > 2_000 || typeof asked.taker !== 'string') {
        throw new Error('Orientim asked for routes without a session or a one-time key. Nothing was signed.');
      }
      if (taker !== undefined && asked.taker !== taker) {
        throw new Error('Orientim named another one-time key for this swap than in its first round. Nothing was signed.');
      }
      taker = asked.taker;
      session = asked.session;
      // Dedupe and count requests before fetching any.
      const fresh = new Map(routeRequestsFor(asked.requests, swap(taker)).map(r => [routeRequestKey(r), r] as const));
      for (const k of fetched.keys()) fresh.delete(k);
      if (fresh.size === 0) throw new Error('Orientim asked again for routes it was already sent. Nothing was signed; try again in a moment.');
      if (fetched.size + fresh.size > MAX_ROUTES) return prepare(await withFloor());
      const [routes] = await Promise.all([fetchRoutes([...fresh.values()], swap(taker), { apiKey: own.jupiterApiKey, fetchImpl, budget }), withFloor()]);
      for (const r of routes) fetched.set(routeRequestKey(r.params), r);
      continue;
    }
    // Reject a swap built before the agent's minimum was sent.
    if (floor === null) throw new Error("Orientim built a swap before the agent's own minimum was sent. Nothing was signed.");
    // The swap must use the one-time key the routes were fetched for.
    if (taker !== undefined && prepared.temporaryAuthority !== taker) {
      throw new Error('Orientim built this swap around another one-time key than the one it asked routes for. Nothing was signed.');
    }
    return prepared;
  }
  return prepare(await withFloor());
}

/** Error for a preparation that exceeded `PREPARATION_MS`. */
export const outOfPreparationTime = () =>
  new BudgetSpentError(`Preparing this swap took longer than a swap may (${PREPARATION_MS / 1000} s). Nothing was signed; try again in a moment.`);

/** POSTs to Orientim with a timeout and throws `OrientimApiError` on a non-2xx response. */
export async function call<T>(fetchImpl: Fetch, url: string, key: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  let res: Response;
  let json: { error?: { code: string; message: string } } & T;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-orientim-skill': SKILL_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    json = await answerOf<T>(res);
  } catch (e) {
    if ((e as Error)?.name !== 'TimeoutError') throw e;
    // Keep the TimeoutError name so callers treat it as no answer.
    const silent = new Error(`Orientim did not answer in time (${Math.ceil(timeoutMs / 1000)} s) when asked at ${new URL(url).pathname}. Try again in a moment.`);
    silent.name = 'TimeoutError';
    throw silent;
  }
  if (!res.ok) {
    throw new OrientimApiError({
      status: res.status, code: json.error?.code ?? codeOfStatus(res.status), message: json.error?.message ?? res.statusText, body: json.error ?? {},
      retryAfter: retryAfterOf(res),
    });
  }
  return json;
}

/** Unusable local setup (policy file, state directory or keypair); `orientim swap` exits with code 2. */
export class ConfigError extends Error {}
