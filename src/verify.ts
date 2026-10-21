/**
 * Client-side verification of a prepared swap before the wallet signs.
 *
 * Runs the full verifier (rules R1–R7) on the exact transaction bytes, against chain state from the
 * agent's own RPC and a policy checked against the agent's intent and limits. A compromised server
 * can refuse or delay a swap, but cannot get the wallet to sign one that moves more than the approved amount.
 *
 * It also enforces what the rules cannot: an agent-supplied price floor (`minOut`), so a server cannot
 * route through a pool it controls, and a simulation proving nothing is left under the one-time key.
 */
import {
  fetchAddressesForLookupTables, getCompiledTransactionMessageDecoder, getTransactionDecoder, isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
} from '@solana/kit';
import type { Address, Rpc, SolanaRpcApi, Transaction } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { JUPITER_PROGRAM, PUMP_AMM_PROGRAM, PUMP_CURVE_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from '@orientimhq/core/constants';
import type { ChainSnapshot, Policy } from '@orientimhq/core/types';
import { balancesAfterSimulation, notOlderThan, readAccounts } from '@orientimhq/solana';
import { hasPermanentDelegate, hasTransferFee, hasTransferHookAuthority, isBondingCurveRoute, jupiterRouteArgs, routeAccountFor, transferFeeOf, transferFeeOn, verify } from '@orientimhq/verifier';
import type { TransferFee } from '@orientimhq/verifier';

/** Expiry proofs used by `confirm`. */
export { pastProof, provesNeverLanded, STATUS_CACHE_BLOCKS } from '@orientimhq/solana';

/** Orientim's treasury. Unless the agent sets another, the fee may go only here or nowhere. */
export const ORIENTIM_TREASURY = 'ARzSA3sZGhf5t4UnYrmB3TWyZ5m3Wo1nA9zWBcoiTqLE';

/** Allowed range for an agent-chosen slippage tolerance: 0.1% to 15%. */
export const MIN_SLIPPAGE_BPS = 10;
export const MAX_SLIPPAGE_BPS = 1_500;
/** Default maximum price impact, in bps. */
export const DEFAULT_MAX_PRICE_IMPACT_BPS = 500;
/** Default slippage: 0.5%, or 3% on a Pump.fun bonding curve. */
export const DEFAULT_SLIPPAGE_BPS = 50;
export const CURVE_SLIPPAGE_BPS = 300;
/** Clamp range for `slippageBps: "auto"` (Jupiter's RTSE estimate). */
export const AUTO_MIN_SLIPPAGE_BPS = 50;
export const AUTO_MAX_SLIPPAGE_BPS = 300;

/** Derives Jupiter's RTSE slippage estimate from a quote, clamped to the auto range. */
export function autoSlippageBps(r: { outAmount?: string; otherAmountThreshold?: string }): number {
  if (!/^\d{1,20}$/.test(r.outAmount ?? '') || !/^\d{1,20}$/.test(r.otherAmountThreshold ?? '')) return AUTO_MIN_SLIPPAGE_BPS;
  const out = BigInt(r.outAmount!);
  const threshold = BigInt(r.otherAmountThreshold!);
  if (out <= 0n || threshold <= 0n || threshold >= out) return AUTO_MIN_SLIPPAGE_BPS;
  // Round to nearest: the threshold was already rounded down.
  const bps = Number(((out - threshold) * 20_000n + out) / (2n * out));
  return Math.min(AUTO_MAX_SLIPPAGE_BPS, Math.max(AUTO_MIN_SLIPPAGE_BPS, bps));
}
/**
 * Hard limits that no intent or input can raise, so a misled agent cannot be talked into selling for nothing.
 * Changing them requires editing these constants.
 */
export const MAX_BELOW_BPS = 2_000;
export const MAX_PRICE_IMPACT_BPS = 2_000;
export const MAX_FEE_BPS = 30;
/** Orientim's current fee and the default limit; any increase is refused unless `maxFeeBps` allows it. */
export const DEFAULT_FEE_BPS = 25;
/** Effective fee limit: `maxFeeBps` capped at `MAX_FEE_BPS`, else `DEFAULT_FEE_BPS`. */
export const feeLimitBps = (maxFeeBps?: number) =>
  Number.isInteger(maxFeeBps) && (maxFeeBps as number) >= 0 ? Math.min(maxFeeBps as number, MAX_FEE_BPS) : DEFAULT_FEE_BPS;
export const isSlippageBps = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= MIN_SLIPPAGE_BPS && v <= MAX_SLIPPAGE_BPS;
/** An intent parameter is out of range. A usage error (CLI exit code 2), not a swap refusal. */
export class IntentError extends Error {
  override name = 'IntentError';
}
const usageError = (message: string) => new IntentError(message);
/** Runs an RPC read, rethrowing any failure as a retryable `RpcUnavailableError` rather than a verdict. */
export async function readOnYourRpc<T>(read: () => Promise<T>, what: string): Promise<T> {
  try {
    return await read();
  } catch (e) {
    const failed = new Error(`the chain state could not be read from your RPC (${what}): ${e instanceof Error && e.name === 'TimeoutError' ? 'no answer in time' : 'the read failed'}. Try again in a moment.`);
    failed.name = 'RpcUnavailableError';
    throw failed;
  }
}
/** Whether a problem reports an RPC failure rather than a fault in the transaction. */
export const isRpcFailure = (problem: string) => /^the (chain state could not be read from|swap could not be simulated on) your RPC/.test(problem);
/** Formats a Jupiter refusal with status and error code only; Jupiter's prose is never repeated. */
const jupiterRefusal = (status: number, asked: string, apiKey?: string, busy = false, code: string | null = null) =>
  `Jupiter answered ${status}${busy && status === 400 ? ' (busy)' : ''}${code ? ` (${code})` : ''} when asked for ${asked}`
  + (status === 429 && !apiKey ? ' (without JUPITER_API_KEY Jupiter allows very few requests: set one, from portal.jup.ag)' : '');

/** Jupiter 400 bodies that indicate a transient upstream failure rather than a trade refusal. */
const JUPITER_TRANSIENT_400 = /quote failed|not been updated|failed to get quotes?|timed? ?out|try again|oracle|stale|expired|temporarily unavailable|no matching liquidity|"500: /i;

/** Trade-level refusals, mapped to codes when Jupiter returns none. */
const JUPITER_REFUSALS: [RegExp, string][] = [
  [/no routes? found|could not find any route/i, 'NO_ROUTES_FOUND'],
  [/missing token program|not tradable|token not found/i, 'TOKEN_NOT_TRADABLE'],
  [/cannot be same as/i, 'SAME_MINT'],
  [/insufficient liquidity/i, 'INSUFFICIENT_LIQUIDITY'],
];

/** Extracts a safe error code from a Jupiter error body, or null. */
function jupiterErrorCode(body: string): string | null {
  try {
    const json = JSON.parse(body) as { errorCode?: unknown; code?: unknown };
    const code = json?.errorCode ?? json?.code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(code)) return code;
  } catch {
    // Not JSON; fall back to pattern matching.
  }
  return JUPITER_REFUSALS.find(([said]) => said.test(body))?.[1] ?? null;
}

/** Per-preparation Jupiter budget: remaining requests (retries included) and a `performance.now()` deadline. */
export type JupiterBudget = { asks: number; until: number };

/** Default request and time budget for one preparation. */
export const PREPARATION_ASKS = 48;
export const PREPARATION_MS = 110_000;

/** A preparation exhausted its `JupiterBudget`. Nothing was signed; it is safe to retry. */
export class BudgetSpentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetSpentError';
  }
}

/** Creates a new `JupiterBudget`. */
export function preparationBudget(asks = PREPARATION_ASKS, ms = PREPARATION_MS): JupiterBudget {
  return { asks, until: performance.now() + ms };
}

/** Remaining time in ms, or Infinity without a budget. */
export function timeLeftOf(budget: JupiterBudget | undefined): number {
  return budget ? budget.until - performance.now() : Infinity;
}

/** Longest rate-limit wait when no budget deadline applies. */
const MAX_RATE_LIMIT_WAIT_MS = 10_000;

/** In-process rate-limit reset times per Jupiter key, shared by concurrent swaps. */
const limitedUntil = new Map<string, number>();

/** Milliseconds until a 429 rate limit resets, from Retry-After or x-ratelimit-reset; null if absent. */
export function rateLimitResetMs(headers: Headers, now = Date.now()): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    if (/^\d{1,6}$/.test(retryAfter.trim())) return Number(retryAfter) * 1000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const reset = headers.get('x-ratelimit-reset')?.trim();
  if (reset && /^\d{1,16}(\.\d+)?$/.test(reset)) {
    const v = Number(reset);
    if (v > 1e12) return Math.max(0, v - now);
    if (v > 1e9) return Math.max(0, v * 1000 - now);
    return v * 1000;
  }
  return null;
}

/** Whether a fetch error means no usable response (timeout, network error, non-JSON body). */
const noAnswer = (e: unknown) => {
  const err = e as Error | undefined;
  return err?.name === 'TimeoutError' || err?.name === 'SyntaxError' || (err?.name === 'TypeError' && /fetch failed|network|terminated|socket/i.test(err.message));
};

/**
 * Fetches from Jupiter, retrying up to three times on 429, 5xx or transient 400 so upstream hiccups are
 * not read as trade refusals. Other errors throw immediately.
 */
async function askJupiter(
  url: string, asked: string, apiKey: string | undefined, fetchImpl: typeof fetch | undefined, budget?: JupiterBudget,
): Promise<unknown> {
  const id = apiKey ?? '';
  const timeLeft = () => timeLeftOf(budget);
  const outOfTime = () => new BudgetSpentError(`Preparing this swap took longer than a swap may (${PREPARATION_MS / 1000} s) while Jupiter was asked for ${asked}. Nothing was signed; try again in a moment.`);
  /** Waits `ms`, or throws if that would exceed the deadline or maximum pause. */
  const pause = async (ms: number, why: () => Error) => {
    if (ms <= 0) return;
    if (ms > Math.min(timeLeft(), budget ? Infinity : MAX_RATE_LIMIT_WAIT_MS)) throw why();
    await new Promise(r => setTimeout(r, ms));
  };
  const limitedFor = (ms: number) => () => new Error(`${jupiterRefusal(429, asked, apiKey)}: your Jupiter key is limited for another ${Math.ceil(ms / 1000)} s. Nothing was signed; try again then.`);
  for (let attempt = 0; ; attempt++) {
    const waitLimit = (limitedUntil.get(id) ?? 0) - Date.now();
    await pause(waitLimit, limitedFor(waitLimit));
    if (budget) {
      if (budget.asks <= 0) throw new BudgetSpentError(`Preparing this swap would take more asks of your Jupiter key than one preparation may make (${PREPARATION_ASKS}, retries included), when asked for ${asked}. Nothing was signed; try again in a moment, or a smaller amount.`);
      if (timeLeft() <= 0) throw outOfTime();
      budget.asks--;
    }
    let res: Response;
    let answer: { json: unknown } | null = null;
    try {
      res = await (fetchImpl ?? fetch)(url, {
        headers: apiKey ? { 'x-api-key': apiKey } : {}, signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(15_000, timeLeft())))),
      });
      if (res.ok) answer = { json: JSON.parse(await res.text()) };
    } catch (e) {
      // Treat no response like a 5xx and retry within the budget.
      if (!noAnswer(e)) throw e;
      if (attempt < 3) {
        await pause(400 * 2 ** attempt, outOfTime);
        continue;
      }
      const silent = new Error(`Jupiter did not answer in time, or answered something unreadable (busy), when asked for ${asked}, four times. Nothing was signed; try again in a moment.`);
      // Reported as a timeout so callers retry rather than treat it as a verdict.
      silent.name = 'TimeoutError';
      throw silent;
    }
    if (answer) return answer.json;
    const body = await res.text().catch(() => '');
    // A "missing token program" inside a wrapped 500 is index lag on a new token, so it is retried.
    const lagging = /"500: /.test(body) && /missing token program/i.test(body);
    const busy = res.status === 429 || res.status >= 500
      || (res.status === 400 && JUPITER_TRANSIENT_400.test(body) && (lagging || !JUPITER_REFUSALS.some(([said]) => said.test(body))));
    const reset = res.status === 429 ? rateLimitResetMs(res.headers) : null;
    if (reset !== null) limitedUntil.set(id, Math.max(limitedUntil.get(id) ?? 0, Date.now() + reset));
    if (busy && attempt < 3) {
      const backoff = 400 * 2 ** attempt;
      // Honor Jupiter's reset time, but never wait less than the backoff.
      await pause(Math.max(backoff, reset ?? 0), reset !== null && reset > backoff ? limitedFor(reset) : outOfTime);
      continue;
    }
    throw new Error(jupiterRefusal(res.status, asked, apiKey, busy, jupiterErrorCode(body)));
  }
}

/** A Jupiter build request the server asks the agent to fetch with its own key. */
export type RouteRequest = {
  inputMint: string; outputMint: string; amount: string; taker: string; slippageBps: number; maxAccounts: number;
  mode?: 'fast'; destinationTokenAccount?: string; excludeDexes?: string[];
};

/** Jupiter's response to a `RouteRequest`, or `noRoute` when none was found. */
export type FetchedRoute = { params: RouteRequest; response?: unknown; noRoute?: boolean };

/** Maximum route requests fetched per prepare round. */
export const MAX_ROUTE_REQUESTS_PER_ROUND = 8;

/**
 * Fetches server-requested routes with the agent's Jupiter key, which never leaves the process.
 * Requests not for this swap are refused so the server cannot spend the agent's quota on other trades.
 */
export async function fetchRoutes(
  requests: unknown, swap: { inputMint: string; outputMint: string; amountIn: string; taker: string },
  opts: { apiKey?: string; fetchImpl?: typeof fetch; jupiterUrl?: string; budget?: JupiterBudget } = {},
): Promise<FetchedRoute[]> {
  const checked = routeRequestsFor(requests, swap);
  const out: FetchedRoute[] = [];
  // Sequential, to avoid bursting the key's quota.
  for (const params of checked) {
    // SOL wrapping is done by Orientim's instructions, not Jupiter's.
    const url = new URL(opts.jupiterUrl ?? 'https://api.jup.ag/swap/v2/build');
    const query: Record<string, string> = {
      inputMint: params.inputMint, outputMint: params.outputMint, amount: params.amount, taker: params.taker,
      slippageBps: String(params.slippageBps), maxAccounts: String(params.maxAccounts), wrapAndUnwrapSol: 'false',
      ...(params.destinationTokenAccount ? { destinationTokenAccount: params.destinationTokenAccount } : {}),
      ...(params.excludeDexes?.length ? { excludeDexes: params.excludeDexes.join(',') } : {}),
      ...(params.mode ? { mode: params.mode } : {}),
    };
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    try {
      out.push({ params, response: await askJupiter(url.toString(), 'a route for Orientim to protect', opts.apiKey, opts.fetchImpl, opts.budget) });
    } catch (e) {
      const message = (e as Error).message;
      // Only a non-busy 400 means no route; auth errors and busy responses abort the swap.
      if (/^Jupiter answered 400(?! \(busy\))/.test(message)) {
        out.push({ params, noRoute: true });
        continue;
      }
      throw e;
    }
  }
  return out;
}

/** Validates every route request against this swap before any is fetched; throws on the first mismatch. */
export function routeRequestsFor(
  requests: unknown, swap: { inputMint: string; outputMint: string; amountIn: string; taker: string },
): RouteRequest[] {
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_ROUTE_REQUESTS_PER_ROUND) {
    throw new Error(`Orientim asked for routes this skill does not fetch: ${Array.isArray(requests) ? requests.length : 'not a list of'} request(s). Nothing was signed.`);
  }
  const out: RouteRequest[] = [];
  for (const r of requests as Partial<RouteRequest>[]) {
    const ok = !!r && r.inputMint === swap.inputMint && r.outputMint === swap.outputMint && r.taker === swap.taker
      && typeof r.amount === 'string' && /^\d{1,20}$/.test(r.amount) && BigInt(r.amount) > 0n && BigInt(r.amount) <= BigInt(swap.amountIn)
      && Number.isInteger(r.slippageBps) && r.slippageBps! >= 1 && r.slippageBps! <= 10_000
      && Number.isInteger(r.maxAccounts) && r.maxAccounts! >= 8 && r.maxAccounts! <= 64
      && (r.mode === undefined || r.mode === 'fast')
      && (r.destinationTokenAccount === undefined || (typeof r.destinationTokenAccount === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.destinationTokenAccount)))
      && (r.excludeDexes === undefined || (Array.isArray(r.excludeDexes) && r.excludeDexes.length <= 64
        && r.excludeDexes.every(d => typeof d === 'string' && /^[\w .()-]{1,64}$/.test(d))));
    if (!ok) throw new Error('Orientim asked for a route that is not one for this swap; this skill fetches only those. Nothing was signed.');
    out.push({
      inputMint: r.inputMint!, outputMint: r.outputMint!, amount: r.amount!, taker: r.taker!, slippageBps: r.slippageBps!, maxAccounts: r.maxAccounts!,
      ...(r.mode ? { mode: 'fast' as const } : {}),
      ...(r.destinationTokenAccount ? { destinationTokenAccount: r.destinationTokenAccount } : {}),
      ...(r.excludeDexes?.length ? { excludeDexes: [...r.excludeDexes] } : {}),
    });
  }
  return out;
}

/** Canonical key for a route request, independent of `excludeDexes` order. */
export function routeRequestKey(r: RouteRequest): string {
  return JSON.stringify([
    r.inputMint, r.outputMint, r.amount, r.taker, r.slippageBps, r.maxAccounts, r.mode ?? null,
    r.destinationTokenAccount ?? null, [...(r.excludeDexes ?? [])].sort(),
  ]);
}

/** The agent's intent and limits that a prepared swap is checked against. */
export type AgentLimits = {
  /** The agent's wallet (fee payer and first signer). */
  owner: string;
  inputMint: string;
  outputMint: string;
  /** Total input debited, fee included, in base units. */
  amountIn: string;
  /** Minimum output in base units. Must come from the agent's own price (e.g. `ownMinimum`), never the server. */
  minOut: string;
  /** Maximum Orientim fee in bps (default 25, capped at 30). */
  maxFeeBps?: number;
  /** Maximum network fee in lamports (default 0.001 SOL). */
  maxNetworkFeeLamports?: number;
  /** Fee recipient; defaults to `ORIENTIM_TREASURY`. Set only for another Orientim deployment. */
  treasury?: string;
  /** Route slippage in bps chosen by the agent; defaults to 0.5% (3% on a Pump.fun curve). */
  slippageBps?: number;
  /** Owner's slippage ceiling (`OwnerPolicy.maxSlippageBps`), enforced on every Jupiter route in the signed bytes. */
  maxSlippageCeilingBps?: number;
  /** Maximum non-refunded rent the route may keep, in lamports (default 0.001 SOL). */
  maxRouteCostLamports?: number;
  /** Maximum fee in lamports when paid in SOL from the wallet; required then, since the server sets that price. See `ownSolFeeLimit`. */
  maxSolFeeLamports?: number;
  /** Cap on total non-refunded SOL cost in lamports: network fee, kept rent, and any SOL-denominated fee. */
  maxSolCostLamports?: number;
};

/** The fields of a `/api/v1/prepare` response that verification reads. */
export type PreparedSwap = {
  transaction: string;
  messageSha256: string;
  temporaryAuthority: string;
  policy: Record<string, unknown>;
  /** Slot the server built at; a slightly lagging RPC is waited for so it does not report spurious problems. */
  contextSlot?: string;
  /** Stated costs; the network fee is checked against what the bytes can pay. */
  costs?: { networkFeeLamports?: unknown };
};

/** Prefix for problems where the server's stated figures differ from the transaction it built. */
export const CERTIFICATE_MISMATCH = 'certificate-mismatch';

/** Maximum slot lead of the server over your RPC that is still waited for. */
export const MAX_SLOT_LEAD = 150n;
/** How long to wait for your RPC to reach the server's slot. */
export const SLOT_WAIT_MS = 6_000;

/** Polls until your RPC reaches `slot` or `SLOT_WAIT_MS` passes; returns the highest slot seen. */
async function slotReached(rpc: Rpc<SolanaRpcApi>, slot: bigint, timeoutMs: number): Promise<bigint> {
  const deadline = Date.now() + SLOT_WAIT_MS;
  let seen = 0n;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400));
    try {
      const now = await rpc.getSlot({ commitment: 'confirmed' }).send({ abortSignal: AbortSignal.timeout(timeoutMs) });
      if (now > seen) seen = now;
      if (now >= slot) return now;
    } catch {
      // Retry until the deadline.
    }
  }
  return seen;
}

/** The fee in lamports when it is denominated in SOL (any side), otherwise 0. */
export function solFeeOf(p: { feeSide: string | null; inputMint: string; outputMint: string; fee: bigint }): bigint {
  const inSol = p.feeSide === 'sol'
    || (p.feeSide === 'input' && p.inputMint === WSOL_MINT)
    || (p.feeSide === 'output' && p.outputMint === WSOL_MINT);
  return inSol ? p.fee : 0n;
}

const BIGINT_FIELDS = ['minOut', 'takerRent', 'routeRefund', 'amountIn', 'feeBps', 'fee', 'swapAmount', 'maxNetworkFeeLamports'] as const;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isAddress = (v: unknown) => typeof v === 'string' && ADDRESS.test(v);
/** Allowed shape of each server-supplied policy field; strict so no server prose reaches the agent via problems. */
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

/** Echoes a server value only if it is an address. */
const shown = (v: unknown) => (typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : '(not an address)');
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');

/** Verifies a prepared swap and returns the problems found; sign only if empty. `rpc` must be the agent's own. */
export async function verifyPrepared(
  prepared: PreparedSwap, limits: AgentLimits, rpc: Rpc<SolanaRpcApi>, opts: { requestTimeoutMs?: number } = {},
): Promise<string[]> {
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

  // The policy is server-supplied, so check it against the agent's intent before the verifier uses it.
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
  // A wallet-paid SOL fee is priced by the server, so it needs the agent's own limit.
  if (p.feeSide === 'sol') {
    if (limits.maxSolFeeLamports === undefined) {
      problems.push('the Orientim fee is paid in SOL at a price the check cannot see: hold it with maxSolFeeLamports from ownSolFeeLimit, which asks Jupiter (a higher limit only in the owner\'s own words)');
    } else if (p.fee > BigInt(limits.maxSolFeeLamports)) {
      problems.push(`the Orientim fee in SOL is ${p.fee} lamports, above your limit of ${limits.maxSolFeeLamports}`);
    }
  }
  const routeCost = p.takerRent - p.routeRefund;
  const maxRouteCost = BigInt(limits.maxRouteCostLamports ?? 1_000_000);
  if (routeCost > maxRouteCost) {
    problems.push(`the route keeps ${routeCost} lamports of rent that do not come back, above your limit of ${maxRouteCost} (maxRouteCostLamports)`);
  }
  // An output-side fee reduces what the wallet keeps.
  const keeps = p.feeSide === 'output' ? p.minOut - p.fee : p.minOut;
  if (!/^\d{1,20}$/.test(limits.minOut ?? '') || BigInt(limits.minOut) === 0n) {
    problems.push('no minimum of your own: take minOut from ownMinimum, which asks Jupiter (a lower one only in the user\'s own words)');
  } else if (keeps < BigInt(limits.minOut)) {
    problems.push(`the minimum ${keeps} is below yours, ${limits.minOut}`);
  }

  // Read all referenced, derived and one-time-key accounts from the agent's RPC.
  let snapshot: ChainSnapshot;
  let snapshotAddresses: Address[] = [];
  const underKey = await underKeyOf(p.ephemeral);
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes) as unknown as {
      staticAccounts: Address[];
      addressTableLookups?: { lookupTableAddress: Address; writableIndexes: number[]; readonlyIndexes: number[] }[];
    };
    const lookups = compiled.addressTableLookups ?? [];
    // Reads below use this slot as a floor so the snapshot is never older than the check.
    const stated = typeof prepared.contextSlot === 'string' && /^\d{1,20}$/.test(prepared.contextSlot) ? BigInt(prepared.contextSlot) : undefined;
    const tables = (minContextSlot?: bigint) => notOlderThan(() => fetchAddressesForLookupTables(lookups.map(l => l.lookupTableAddress), rpc as never, {
      abortSignal: AbortSignal.timeout(timeoutMs), ...(minContextSlot !== undefined ? { minContextSlot } : {}),
    }), minContextSlot) as Promise<Record<string, readonly Address[]>>;
    let [lookupTables, floor] = lookups.length || stated !== undefined
      ? await Promise.all([
        lookups.length ? tables() : Promise.resolve({} as Record<string, readonly Address[]>),
        // Without lookup tables, a failed slot read is tolerated.
        rpc.getSlot({ commitment: 'confirmed' }).send({ abortSignal: AbortSignal.timeout(timeoutMs) })
          .catch((e: unknown) => { if (lookups.length) throw e; return undefined; }),
      ])
      : [{} as Record<string, readonly Address[]>, undefined];
    // Briefly wait for a lagging RPC to reach the server's slot.
    if (stated !== undefined && floor !== undefined && stated > floor && stated - floor <= MAX_SLOT_LEAD) {
      const reached = await slotReached(rpc, stated, timeoutMs);
      if (reached > floor) {
        floor = reached;
        if (lookups.length) lookupTables = await tables(floor);
      }
    }
    const resolved = lookups.flatMap(l =>
      [...l.writableIndexes, ...l.readonlyIndexes].map(i => lookupTables[l.lookupTableAddress]?.[i]).filter((a): a is Address => !!a));
    const derived = Object.values(p.accounts).filter((a): a is Address => !!a);
    const addresses = [
      ...compiled.staticAccounts, ...resolved, ...derived, p.inputMint, p.outputMint, p.ephemeral,
      ...(p.treasury ? [p.treasury] : []), ...underKey,
    ];
    const { accounts, slot } = await readAccounts(rpc as never, addresses, { timeoutMs, ...(floor !== undefined ? { minContextSlot: floor } : {}) });
    snapshot = { accounts, lookupTables, slot };
    snapshotAddresses = [...compiled.staticAccounts, ...resolved];
  } catch (e) {
    return [...problems, `the chain state could not be read from your RPC: ${(e as Error).message}`];
  }

  if (limits.slippageBps !== undefined && !isSlippageBps(limits.slippageBps)) {
    return [...problems, `slippageBps must be a whole number of bps from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}`];
  }
  // Slippage comes from the agent or verifier defaults, never the server.
  const verdict = await verify(transaction, p, snapshot, limits.slippageBps !== undefined ? { maxSlippageBps: limits.slippageBps } : {});
  for (const v of verdict.violations) problems.push(`${v.rule}: ${v.detail}`);
  if (limits.maxSlippageCeilingBps !== undefined) problems.push(...routesAboveCeiling(transaction.messageBytes, limits.maxSlippageCeilingBps));
  // The stated network fee is shown to the user, so it must not understate what the bytes can pay.
  const statedFee = prepared.costs?.networkFeeLamports;
  if (typeof statedFee === 'string' && /^\d{1,20}$/.test(statedFee) && verdict.networkFeeLamports !== undefined && BigInt(statedFee) < verdict.networkFeeLamports) {
    problems.push(`${CERTIFICATE_MISMATCH}: the network fee stated is ${statedFee} lamports; the transaction can pay up to ${verdict.networkFeeLamports}`);
  }
  if (limits.maxSolCostLamports !== undefined && verdict.networkFeeLamports !== undefined) {
    const solCost = verdict.networkFeeLamports + routeCost + solFeeOf(p);
    if (solCost > BigInt(limits.maxSolCostLamports)) {
      problems.push(`the swap may cost ${solCost} lamports of SOL that do not come back, above your limit of ${limits.maxSolCostLamports} (maxSolCostLamports)`);
    }
  }
  // Accounts the route creates, excluding the wallet's output account and the treasury.
  const exists = (a: Address) => { const s = snapshot.accounts.get(a); return !!s && (s.lamports > 0n || s.data.length > 0); };
  const keep = new Set<string>([p.accounts.wOut, p.treasury].filter((a): a is Address => !!a));
  const fresh = [...new Set(snapshotAddresses)].filter(a => !exists(a) && !keep.has(a));
  problems.push(...await leftUnderKey(prepared.transaction, transaction, underKey, snapshot, rpc, timeoutMs, fresh));
  return problems;
}

/** Program and data of each instruction, for v0 and v1 compiled messages. */
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

/** Problems for Jupiter routes above the owner's slippage ceiling. Programs are static accounts, so lookup tables cannot hide one. */
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

/** Accounts whose value E could later claim: E, its Pump market accounts and their cashback token accounts. */
async function underKeyOf(key: Address): Promise<Address[]> {
  const markets = await Promise.all([PUMP_CURVE_PROGRAM, PUMP_AMM_PROGRAM].map(program => routeAccountFor(program, key)));
  const cashback = await Promise.all(markets.flatMap(owner => [WSOL_MINT, USDC_MINT].map(async mint =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM }))[0])));
  return [key, ...markets, ...cashback];
}

/** Delay before re-simulating a failed transaction. */
const SIMULATION_RETRY_MS = 1_200;

/** Failing program and error code from simulation logs; log text is untrusted and never echoed. */
function failingProgram(logs: readonly string[] | null | undefined): string {
  for (const line of logs ?? []) {
    const m = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: custom program error: 0x([0-9a-f]{1,8})$/i.exec(line);
    if (m) return ` (program ${m[1]}, error ${parseInt(m[2], 16)})`;
  }
  return '';
}

/**
 * Simulates the swap and reports lamports left under the one-time key, its market accounts, or any
 * account the route opens, since a server that can derive the key could collect them.
 */
async function leftUnderKey(
  wire: string, transaction: Transaction, underKey: readonly Address[], snapshot: ChainSnapshot,
  rpc: Rpc<SolanaRpcApi>, timeoutMs = 10_000, fresh: readonly Address[] = [],
): Promise<string[]> {
  const opened = fresh.filter(a => !underKey.includes(a));
  try {
    // Balances come from `postBalances`; some providers cap `accounts.addresses` at two.
    // A node behind the snapshot slot is retried briefly.
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
    // Prices can move per slot, so a failed simulation is retried once.
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
    // Unnamed accounts cannot change, so fall back to the snapshot; unread ones are unknown.
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
 * Arguments for `ownQuote`. The floor is Jupiter's output less `maxBelowBps`: by default 2% (5% on a
 * Pump.fun curve), or `slippageBps` plus 1.5% (2% on a curve).
 */
export type OwnQuoteArgs = {
  inputMint: string; outputMint: string; amountIn: string; taker: string;
  maxFeeBps?: number; maxBelowBps?: number; jupiterUrl?: string; apiKey?: string; fetchImpl?: typeof fetch;
  /** Budget of the enclosing preparation, if any. */
  budget?: JupiterBudget;
  /** Agent-chosen route slippage (`AgentLimits.slippageBps`). */
  slippageBps?: number;
  /** Use Jupiter's slippage estimate (`autoSlippageBps`) instead of `slippageBps`. */
  autoSlippage?: boolean;
  /** Owner ceilings that clamp default or estimated values. Explicit values above them are the caller's to refuse. */
  ceilings?: { maxSlippageBps?: number; maxBelowBps?: number };
  /** Input token transfer fee (`inputTransferFee`), so the quote is priced on what actually arrives. */
  inputTax?: TransferFee | null;
  /** Accept a quote without a price impact (`OwnerPolicy.allowUnknownPriceImpact`); otherwise it is refused. */
  allowUnknownImpact?: boolean;
};

/** Returns the agent's own `minOut` (via `ownQuote`), throwing if price impact exceeds `maxPriceImpactBps` (default 5%). */
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

/** Quotes Jupiter directly for the routed amount: the agent's floor, price impact, and whether it uses a Pump.fun curve. */
export async function ownQuote(args: OwnQuoteArgs): Promise<{
  minOut: string; outAmount: string; priceImpactBps: number | null; curve: boolean;
  /** Slippage to build at when it differs from the default. */
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
  const r = (await askJupiter(url.toString(), 'your own price', args.apiKey, args.fetchImpl, args.budget)) as {
    inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string; otherAmountThreshold?: string; priceImpactPct?: string | number;
    swapInstruction?: { accounts?: { pubkey: string; isWritable?: boolean }[] };
  };
  if (r.inputMint !== args.inputMint || r.outputMint !== args.outputMint || r.inAmount !== routed.toString() || !/^\d{1,20}$/.test(r.outAmount ?? '')) {
    throw new Error('Jupiter answered for another trade when asked for your own price');
  }
  // Same curve detection as the verifier, so the floor is only widened for real curve routes.
  const accounts = Array.isArray(r.swapInstruction?.accounts) ? r.swapInstruction.accounts : [];
  const curve = await isBondingCurveRoute(accounts.map(a => ({ address: a.pubkey, isWritable: a.isWritable === true })), args.inputMint, args.outputMint);
  // Chosen or estimated slippage, clamped to the owner's ceiling.
  const ceiling = args.ceilings?.maxSlippageBps;
  let slippage = args.slippageBps ?? (args.autoSlippage ? (curve ? CURVE_SLIPPAGE_BPS : autoSlippageBps(r)) : undefined);
  if (ceiling !== undefined) {
    const effective = slippage ?? (curve ? CURVE_SLIPPAGE_BPS : DEFAULT_SLIPPAGE_BPS);
    if (effective > ceiling) slippage = ceiling;
  }
  const defaultBelow = slippage !== undefined ? slippage + (curve ? 200 : 150) : (curve ? 500 : 200);
  const belowCeiling = args.ceilings?.maxBelowBps;
  const below = BigInt(args.maxBelowBps ?? (belowCeiling !== undefined && defaultBelow > belowCeiling ? belowCeiling : Math.min(defaultBelow, MAX_BELOW_BPS)));
  // A missing price impact is refused, never read as zero, unless the owner allows it.
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

/** SOL, USDC and USDT keep authorities by design; flagging them would train agents to ignore notices. */
const QUIET_MINTS = new Set<string>([WSOL_MINT, USDC_MINT, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

/** Issuer powers over a mint. `wellKnown` marks SOL, USDC and USDT. */
export type TokenPowers = { freezeAuthority: boolean; mintAuthority: boolean; permanentDelegate: boolean; transferHookAuthority: boolean; wellKnown: boolean };
/** Issuer powers per mint, or `unavailable` if the mints could not be read (never reported as no risk). */
export type TokenRisk =
  | { status: 'known'; tokens: Record<string, TokenPowers | { exists: false }> }
  | { status: 'unavailable'; reason: string };

/** Reads issuer powers for each mint from your RPC. */
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
        transferHookAuthority: s.owner === TOKEN_2022_PROGRAM && hasTransferHookAuthority(s.data),
        wellKnown: QUIET_MINTS.has(m),
      };
    }
    return { status: 'known', tokens };
  } catch (e) {
    return { status: 'unavailable', reason: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'read-failed' };
  }
}

/** Human-readable notices about issuer powers. An unreadable mint yields a notice, never silence. */
export async function tokenNotices(rpc: Rpc<SolanaRpcApi>, mints: readonly string[], timeoutMs = 10_000): Promise<string[]> {
  return noticesOf(await tokenRisk(rpc, mints, timeoutMs));
}

/** `tokenNotices` for an existing `tokenRisk` result. */
export function noticesOf(risk: TokenRisk): string[] {
  if (risk.status === 'unavailable') return ["the tokens' mint accounts could not be read on your RPC: what their issuers can do is unknown"];
  const notes: string[] = [];
  for (const [m, t] of Object.entries(risk.tokens)) {
    if (!('wellKnown' in t) || t.wellKnown) continue;
    const name = `${m.slice(0, 4)}…${m.slice(-4)}`;
    if (t.permanentDelegate) notes.push(`${name} has a permanent delegate: its issuer can move or burn your balance at any time`);
    if (t.freezeAuthority) notes.push(`${name} has a freeze authority: its issuer can freeze your balance`);
    if (t.mintAuthority) notes.push(`${name} can still be minted by its issuer`);
    if (t.transferHookAuthority) notes.push(`${name} has a transfer-hook authority: its issuer can later add code that runs on every transfer`);
  }
  return notes;
}

/** Slots before epoch end within which a swap may land in the next epoch (allows for skipped slots and an aged blockhash). */
export const EPOCH_EDGE_SLOTS = 450n;

/** The worse of two transfer fees: the larger rate and the larger cap. */
export function higherTransferFee(a: TransferFee | null, b: TransferFee | null): TransferFee | null {
  if (!a) return b;
  if (!b) return a;
  return { bps: Math.max(a.bps, b.bps), maximum: a.maximum > b.maximum ? a.maximum : b.maximum };
}

/**
 * Token-2022 transfer fee of the input mint, or null if none. Near an epoch boundary it returns the
 * higher of the current and next epoch's fees, since the swap may land in either.
 */
export async function inputTransferFee(rpc: Rpc<SolanaRpcApi>, mint: string, timeoutMs = 10_000): Promise<TransferFee | null> {
  const state = (await readOnYourRpc(() => readAccounts(rpc as never, [mint as Address], { timeoutMs }), 'the input token')).accounts.get(mint);
  if (!state || state.owner !== TOKEN_2022_PROGRAM || !hasTransferFee(state.data)) return null;
  const info = await readOnYourRpc(() => rpc.getEpochInfo({ commitment: 'confirmed' }).send({ abortSignal: AbortSignal.timeout(timeoutMs) }), 'the epoch');
  const epoch = BigInt(info.epoch);
  const now = transferFeeOf(state.data, epoch);
  // Without epoch position info, assume not near the boundary.
  const { slotIndex, slotsInEpoch } = info as { slotIndex?: bigint | number; slotsInEpoch?: bigint | number };
  const near = slotIndex !== undefined && slotsInEpoch !== undefined && BigInt(slotsInEpoch) - BigInt(slotIndex) <= EPOCH_EDGE_SLOTS;
  return near ? higherTransferFee(now, transferFeeOf(state.data, epoch + 1n)) : now;
}

/** Agent-priced limit in lamports for a wallet-paid SOL fee: `maxFeeBps` of the input's SOL value, plus 2% for price movement. */
export async function ownSolFeeLimit(args: {
  inputMint: string; amountIn: string; taker: string;
  maxFeeBps?: number; jupiterUrl?: string; apiKey?: string; fetchImpl?: typeof fetch; budget?: JupiterBudget;
}): Promise<number> {
  const url = new URL(args.jupiterUrl ?? 'https://api.jup.ag/swap/v2/build');
  const query = {
    inputMint: args.inputMint, outputMint: 'So11111111111111111111111111111111111111112', amount: args.amountIn,
    taker: args.taker, slippageBps: '50', maxAccounts: '64',
  };
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const r = (await askJupiter(url.toString(), 'the value of your swap in SOL', args.apiKey, args.fetchImpl, args.budget)) as { inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string };
  if (r.inputMint !== args.inputMint || r.outputMint !== query.outputMint || r.inAmount !== args.amountIn || !/^\d{1,20}$/.test(r.outAmount ?? '')) {
    throw new Error('Jupiter answered for another trade when asked for the value of your swap in SOL');
  }
  const fee = (BigInt(r.outAmount!) * BigInt(feeLimitBps(args.maxFeeBps))) / 10_000n;
  const limit = fee + fee / 50n;
  if (limit > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('the fee in SOL for this amount is beyond an exact limit: only the owner can set maxSolFeeLamports for it');
  return Number(limit);
}
