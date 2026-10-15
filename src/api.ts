/**
 * The Orientim agent API as the client sees it: what an agent asks for (`Intent`), what Orientim answers
 * (`Prepared`, `Finalized`), its errors, and the call that prepares a swap (AGENT-API.md).
 */
import { createSolanaRpc } from '@solana/kit';
import { DIGITS } from './util.ts';
import { BudgetSpentError, fetchRoutes, PREPARATION_MS, preparationBudget, routeRequestKey, routeRequestsFor, timeLeftOf } from './verify.ts';
import type { FetchedRoute, JupiterBudget } from './verify.ts';

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
   * its enforced cap, rent the route keeps, and Orientim's fee whenever it is in SOL, from SOL sold,
   * SOL bought or the wallet's own (optional). The SOL the swap itself sells is not a cost.
   */
  maxSolCostLamports?: number;
  /** A gap to the open market the user already accepted, from a `costs-more` answer (bps, as a string). */
  acceptCostBps?: string;
  /**
   * The route's slippage tolerance, as the owner or bot chooses it: how far below the quote the
   * swap may fill, 10 to 1500 bps. Unset: 0.5%, or 3% on a Pump.fun bonding curve. `"auto"`: the
   * tolerance Jupiter estimates for this trade, from 0.5% to 3% (3% on a curve). The route is built
   * at it, and the check holds the route to it; your own floor follows it (1.5% below, 2% on a curve).
   * Never above the owner's `maxSlippageBps` (`OwnerPolicy`): a chosen one above it is refused, a
   * default or an estimate above it is lowered to it.
   */
  slippageBps?: number | 'auto';
  /** Opt in to Jupiter's beta fast route search when the deployment enables it. */
  routingMode?: 'standard' | 'fast';
  /**
   * The most this amount may move the market, in bps (default 500: 5%). Above it the swap is refused
   * before anything is prepared (`PriceImpactError`): the mark of thin liquidity, as when a token's
   * pool is being drained. Show this to the owner before an interactive swap.
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
  /** Blocks left in the transaction's life when prepare answered (150 at most, about a minute). */
  blocksLeft?: string;
  /** The slot Orientim read the chain at to build it: the check reads your RPC at least that recent. */
  contextSlot?: string;
  /**
   * `fee` is in `feeMint`: SOL first, then USDC or USDT, on whichever side; otherwise the input token.
   * `minOut` is what the wallet keeps at least, after a fee taken from the output.
   */
  amounts: { amountIn: string; fee: string; feeMint?: string; feeBps: string; swapAmount: string; quotedOut: string; minOut: string; priceImpactPct?: number | null };
  /**
   * `keptSolLamports`: the SOL the swap costs and does not return (the network fee, rent the route
   * keeps, Orientim's fee when paid in SOL). A new output account's rent is apart: it stays the wallet's.
   */
  costs: { networkFeeLamports: string; outputAccountRentLamports: string; routeRentLamports: string; routeRefundLamports: string; keptSolLamports?: string; routeKeptLamports?: string; orientimFeeSolLamports?: string };
  certificate: {
    messageSha256: string; wallet: string; temporaryAuthority: string;
    input: { mint: string; totalDebit: string; orientimFee: string };
    output: { mint: string; minimumOutput: string; orientimFee?: string };
    /** Orientim's fee when it is paid in SOL from the wallet; 0 otherwise. */
    solFee?: { lamports: string; destination: string | null };
  };
  /** The route's slippage tolerance the transaction was built at, in bps; the check holds it to yours. */
  slippageBps?: number;
  /** What the transaction was built against; held to your intent by the check, never trusted. */
  policy: Record<string, unknown>;
};

/** What finalize answers. Its word is not evidence: the outcome is read from the chain. */
/**
 * Your own way of sending the fully signed swap: a staked RPC, a sender service, a bundle with a tip
 * of its own. It gets the transaction as base64 and sends it; it is called at once, then every few
 * seconds until the swap lands or its lifetime passes (the same bytes land only once). An error it
 * throws is not taken as "not sent": the chain says what happened. The transaction's bytes cannot be
 * changed; a service that needs a tip inside the transaction cannot be used, one that takes a tip in
 * a transaction of its own beside it can.
 */
export type SendTransaction = (signedTransaction: string) => Promise<unknown>;

/**
 * A `SendTransaction` that sends through a Solana RPC of your choice (a staked connection, a sender
 * service that speaks sendTransaction), without its preflight and without retries of its own: the
 * swap is sent again every few seconds until it lands or expires, and the chain says the outcome.
 */
export function rpcSender(url: string, timeoutMs = 10_000): SendTransaction {
  const rpc = createSolanaRpc(url);
  return wire => rpc.sendTransaction(wire as never, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send({ abortSignal: AbortSignal.timeout(timeoutMs) });
}

export type Finalized = {
  signature: string;
  /** `signed`: finalize asked with `send: false`; Orientim signed and sent nothing, the agent sends it. */
  status: 'sent' | 'unknown' | 'rejected' | 'signed';
  refusal?: string;
  /** For a `network` refusal: the simulation's error behind it, as JSON. Read with `networkCause`, never shown as it came. */
  transactionError?: string;
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

/**
 * The data fields an error may carry to the agent, each with the one shape it may take. Any other
 * field, or a value of another shape, is dropped: an error's fields reach a model, so a server must
 * not be able to write prose into them.
 */
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
  // routes-needed: what Orientim asks the skill to fetch with the agent's own Jupiter key (fetchRoutes checks each).
  session: v => typeof v === 'string' && v.length <= 2_000 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v),
  taker: v => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v),
  requests: v => Array.isArray(v) && v.length <= 8 && v.every(r => !!r && typeof r === 'object' && !Array.isArray(r)),
};

/** An error's data fields, as ERROR_FIELDS allows them; nothing else. */
export function errorDetails(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, allowed] of Object.entries(ERROR_FIELDS)) if (Object.hasOwn(body, k) && allowed(body[k])) out[k] = body[k];
  return out;
}

/** The fields of a prepare answer the skill reads or shows; any other field is dropped. */
export const PREPARED_FIELDS = [
  'ticket', 'transaction', 'messageSha256', 'wallet', 'temporaryAuthority', 'version', 'lastValidBlockHeight', 'blocksLeft', 'contextSlot',
  'amounts', 'costs', 'notices', 'tokens', 'slippageBps', 'route', 'certificate', 'policy',
] as const;

/** The fields of `amounts` and `costs` the skill reads or shows (`Prepared`); any other is dropped. */
export const AMOUNT_FIELDS = ['amountIn', 'fee', 'feeMint', 'feeBps', 'swapAmount', 'quotedOut', 'minOut', 'priceImpactPct'] as const;
export const COST_FIELDS = [
  'networkFeeLamports', 'outputAccountRentLamports', 'routeRentLamports', 'routeRefundLamports', 'keptSolLamports', 'routeKeptLamports',
  'orientimFeeSolLamports', 'breakdown', 'tokenTax',
] as const;

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
    this.body = errorDetails((e.body ?? {}) as Record<string, unknown>);
    this.serverMessage = untrustedLine(e.message);
    this.retryAfter = e.retryAfter ?? null;
  }
}

export type Fetch = typeof fetch;

/**
 * This copy of @orientimhq/swap, as its package.json says. Sent with every call to Orientim (x-orientim-skill), so
 * that a change old copies cannot follow (a commitment level Solana retires, a new Jupiter format) is
 * answered with "update the skill" (426 skill-outdated) instead of failing in some other way.
 */
export const SKILL_VERSION = '2.1.1';

/** Seconds to wait from an answer's Retry-After header; null without one. */
export const retryAfterOf = (res: Response) => {
  const after = Number(res.headers.get('retry-after'));
  return Number.isFinite(after) && after > 0 ? after : null;
};

/** Orientim's answer as JSON. A page that is not JSON (a proxy's error page) is no answer from Orientim. */
export async function answerOf<T>(res: Response): Promise<{ error?: { code: string; message: string } } & T> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new OrientimApiError({
      status: res.status, code: res.status >= 500 ? 'unavailable' : 'http', message: res.statusText, body: {}, retryAfter: retryAfterOf(res),
    });
  }
}

/**
 * How long a prepare is waited for: longer than Orientim takes at most to answer one (45 s), so a slow
 * build still ends in its answer rather than a second prepare.
 */
export const PREPARE_WAIT_MS = 60_000;
/** The rounds of a prepare whose routes the agent brings, and the routes it may carry in all. */
const MAX_ROUTE_ROUNDS = 10;
const MAX_ROUTES = 24;

/**
 * Orientim's prepare. With the agent's own Jupiter key, Orientim asks for the routes it needs (409
 * `routes-needed`), the agent fetches them from Jupiter with that key, which never leaves this
 * process, and prepares again with every route it has, until the swap is built. A deployment that
 * does not know `ownRoutes` builds the swap itself as before. Without a key, Orientim builds with its own.
 *
 * The one-time key the first round names is the one every round and the swap itself must name; the
 * routes are counted before they are fetched, each fetched once; and the rounds, routes and pauses
 * share one deadline and one budget of asks of the agent's key. A swap that needs more routes or
 * rounds than that is prepared with Orientim's own key, as without the agent's.
 */
export async function preparedByOrientim(
  fetchImpl: Fetch, apiUrl: string, apiKey: string, body: Record<string, unknown>, timeoutMs: number,
  own: {
    jupiterApiKey?: string; ownRoutes?: boolean; budget?: JupiterBudget;
    /**
     * The agent's own minimum (and the tolerance it resolved), still being asked of Jupiter: the
     * first round of own routes goes without it, and every later round carries it.
     */
    floor?: Promise<Record<string, unknown>>;
  },
): Promise<Prepared> {
  const url = `${apiUrl}/api/v1/prepare`;
  // The preparation's one budget: no call to Orientim runs past it, the one that falls back to
  // Orientim's own routes included.
  const budget = own.budget ?? preparationBudget();
  const prepare = async (payload: unknown): Promise<Prepared> => {
    const left = timeLeftOf(budget);
    if (left <= 0) throw outOfPreparationTime();
    // The call ends at the preparation's own end when that comes first.
    const cutByBudget = left < timeoutMs;
    try {
      return await call<Prepared>(fetchImpl, url, apiKey, payload, Math.max(1, Math.floor(Math.min(timeoutMs, left))));
    } catch (e) {
      // Cut short by the time the preparation had left, not by Orientim: said as that.
      if ((e as Error)?.name === 'TimeoutError' && cutByBudget) throw outOfPreparationTime();
      throw e;
    }
  };
  // The agent's own minimum, once it is known; until then only a first round goes out.
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
      // A deployment that wants the minimum in the first round too: asked again with it.
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
      // Each request once, and the budget counted before any is fetched.
      const fresh = new Map(routeRequestsFor(asked.requests, swap(taker)).map(r => [routeRequestKey(r), r] as const));
      for (const k of fetched.keys()) fresh.delete(k);
      if (fresh.size === 0) throw new Error('Orientim asked again for routes it was already sent. Nothing was signed; try again in a moment.');
      // A swap that needs more routes than one prepare may fetch (a large amount, tried at narrower
      // routes): Orientim builds it with its own key, as without your key.
      if (fetched.size + fresh.size > MAX_ROUTES) return prepare(await withFloor());
      // The routes and the agent's own minimum, asked of Jupiter at the same time.
      const [routes] = await Promise.all([fetchRoutes([...fresh.values()], swap(taker), { apiKey: own.jupiterApiKey, fetchImpl, budget }), withFloor()]);
      for (const r of routes) fetched.set(routeRequestKey(r.params), r);
      continue;
    }
    // Never a swap built before the agent's own minimum was sent (a deployment that would build one).
    if (floor === null) throw new Error("Orientim built a swap before the agent's own minimum was sent. Nothing was signed.");
    // The swap is built around the one-time key the routes were fetched for, or the routes were not used.
    if (taker !== undefined && prepared.temporaryAuthority !== taker) {
      throw new Error('Orientim built this swap around another one-time key than the one it asked routes for. Nothing was signed.');
    }
    return prepared;
  }
  // Still asking after every round a prepare may take: Orientim builds it with its own key instead.
  return prepare(await withFloor());
}

/** The preparation ran out of its time (PREPARATION_MS) before the swap could be signed. */
export const outOfPreparationTime = () =>
  new BudgetSpentError(`Preparing this swap took longer than a swap may (${PREPARATION_MS / 1000} s). Nothing was signed; try again in a moment.`);

/** Each call to Orientim ends within `timeoutMs`: an answer that never comes is no answer. */
export async function call<T>(fetchImpl: Fetch, url: string, key: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-orientim-skill': SKILL_VERSION },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await answerOf<T>(res);
  if (!res.ok) {
    throw new OrientimApiError({
      status: res.status, code: json.error?.code ?? 'http', message: json.error?.message ?? res.statusText, body: json.error ?? {},
      retryAfter: retryAfterOf(res),
    });
  }
  return json;
}

/**
 * The command's own setup cannot be used: the owner's policy file, the state directory it names, or
 * the wallet's keypair file. A configuration error: exit 2 from `orientim swap`, as a usage error is.
 */
export class ConfigError extends Error {}
