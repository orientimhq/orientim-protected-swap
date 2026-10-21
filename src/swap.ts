/**
 * End-to-end protected swap: prepare, verify locally, sign, finalize, confirm on your own RPC.
 *
 * The server builds the transaction, so the exact bytes are verified against your own RPC and intent
 * before signing: a compromised server can refuse or delay a swap but never make the wallet sign more
 * than approved. After signing, the outcome is read from the chain by the wallet's own signature, so
 * a lost or false finalize answer cannot fake success or trigger a second swap.
 */
import { getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, getSignatureFromTransaction, getTransactionDecoder, verifySignature } from '@solana/kit';
import type { Address, Rpc, SolanaRpcApi, Transaction } from '@solana/kit';
import { AMOUNT_FIELDS, call, COST_FIELDS, dataOnly, OrientimApiError, outOfPreparationTime, PREPARE_WAIT_MS, PREPARED_FIELDS, preparedByOrientim, safeCode } from './api.ts';
import type { Fetch, Finalized, Intent, Prepared, SendTransaction } from './api.ts';
import { confirm, isThisTransaction, LAG_BLOCKS, MIN_BLOCKS_TO_FINALIZE, signAsWallet, temporaryAuthorityOf } from './chain.ts';
import type { Outcome, WalletSigner } from './chain.ts';
import { checkPolicy, PolicyError } from './policy.ts';
import type { OwnerCeilings, OwnerPolicy, SpendLog } from './policy.ts';
import { movedNothing, pendingFor, PendingSwapError, settleOrder, takeOrder } from './store.ts';
import type { OrderBook, OrderRecord, PendingStore, Signed } from './store.ts';
import { BASE58, DIGITS, hex, sameBytes, wait } from './util.ts';
import { CERTIFICATE_MISMATCH, DEFAULT_MAX_PRICE_IMPACT_BPS, feeLimitBps, inputTransferFee, IntentError, isRpcFailure, isSlippageBps, MAX_BELOW_BPS, MAX_FEE_BPS, MAX_PRICE_IMPACT_BPS, MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS, noticesOf, ownQuote, ownSolFeeLimit, preparationBudget, readOnYourRpc, timeLeftOf, tokenRisk, verifyPrepared } from './verify.ts';
import type { JupiterBudget, TokenRisk } from './verify.ts';

/** Preparation phases reported by `onTiming`; phases may overlap, `readyToSign` is the total. */
export type TimedPhase = 'ownFloor' | 'apiPrepare' | 'localVerification' | 'tokenRisk' | 'readyToSign';

/**
 * Checks a prepare response for consistency with itself and the intent, then runs the full verifier
 * on the exact bytes against `rpc` (your own). Returns the problems found; sign only when empty.
 */
export async function checkPrepared(
  p: Prepared, intent: Intent, rpc: Rpc<SolanaRpcApi>,
  /** `slippageCeilingBps` is the owner's `maxSlippageBps`, never taken from the intent. */
  opts: { requestTimeoutMs?: number; slippageCeilingBps?: number } = {},
): Promise<string[]> {
  // Validate every number before signing, including display-only ones: a report that fails after
  // sending could invite a second swap.
  const digits = (v: unknown) => typeof v === 'string' && /^\d{1,20}$/.test(v);
  const malformed = [
    ...(['amountIn', 'fee', 'feeBps', 'swapAmount', 'quotedOut', 'minOut'] as const).filter(k => !digits(p.amounts?.[k])).map(k => `amounts.${k}`),
    ...(['networkFeeLamports', 'outputAccountRentLamports', 'routeRentLamports', 'routeRefundLamports'] as const)
      .filter(k => !digits(p.costs?.[k])).map(k => `costs.${k}`),
    ...(['keptSolLamports', 'routeKeptLamports', 'orientimFeeSolLamports'] as const)
      .filter(k => p.costs?.[k] !== undefined && !digits(p.costs[k])).map(k => `costs.${k}`),
    ...(p.amounts?.feeMint !== undefined && !(typeof p.amounts.feeMint === 'string' && BASE58.test(p.amounts.feeMint)) ? ['amounts.feeMint'] : []),
    // null means unknown, not zero.
    ...(p.amounts?.priceImpactPct != null && !(typeof p.amounts.priceImpactPct === 'number' && Number.isFinite(p.amounts.priceImpactPct)) ? ['amounts.priceImpactPct'] : []),
    ...(!digits(p.lastValidBlockHeight) ? ['lastValidBlockHeight'] : []),
    ...(p.blocksLeft !== undefined && !digits(p.blocksLeft) ? ['blocksLeft'] : []),
    ...(p.contextSlot !== undefined && !digits(p.contextSlot) ? ['contextSlot'] : []),
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
  // Token-side fees are capped by `maxFeeBps`; SOL-side fees are capped by the verifier (`maxSolFeeLamports`).
  const inSol = (p.policy as { feeSide?: unknown }).feeSide === 'sol';
  const onOutput = p.amounts.feeMint !== undefined && p.amounts.feeMint === intent.outputMint && p.amounts.feeMint !== intent.inputMint;
  const base = onOutput ? BigInt(p.amounts.minOut) + BigInt(p.amounts.fee) : BigInt(intent.amountIn);
  const maxFee = (base * BigInt(feeLimitBps(intent.maxFeeBps))) / 10_000n;
  const stated = BigInt(p.certificate.input.orientimFee) + BigInt(p.certificate.output.orientimFee ?? '0') + BigInt(p.certificate.solFee?.lamports ?? '0');
  if (!inSol && BigInt(p.amounts.fee) > maxFee) problems.push(`the Orientim fee ${p.amounts.fee} is above ${maxFee}`);
  if (stated !== BigInt(p.amounts.fee)) problems.push(`${CERTIFICATE_MISMATCH}: the fee the certificate states differs from the one in amounts`);
  if (p.certificate.output.minimumOutput !== p.amounts.minOut) problems.push(`${CERTIFICATE_MISMATCH}: the enforced minimum differs from the one stated`);
  // Displayed amounts must match the policy the verifier checks the bytes against.
  const policy = p.policy as Record<string, unknown>;
  const whole = (v: unknown) => (typeof v === 'string' && /^\d{1,20}$/.test(v) ? BigInt(v) : null);
  const [enforced, policyFee, routed] = [whole(policy.minOut), whole(policy.fee), whole(policy.swapAmount)];
  if (enforced === null || policyFee === null || routed === null) problems.push('the policy is malformed');
  else if (
    BigInt(p.amounts.minOut) !== (policy.feeSide === 'output' ? enforced - policyFee : enforced)
    || BigInt(p.amounts.fee) !== policyFee || BigInt(p.amounts.swapAmount) !== routed
  ) {
    problems.push(`${CERTIFICATE_MISMATCH}: the amounts stated differ from the policy the transaction is checked against`);
  }
  if (intent.minOut && /^\d{1,20}$/.test(intent.minOut) && BigInt(p.amounts.minOut) < BigInt(intent.minOut)) {
    problems.push(`the minimum ${p.amounts.minOut} is below yours, ${intent.minOut}`);
  }
  if (BigInt(p.costs.networkFeeLamports) > BigInt(intent.maxNetworkFeeLamports ?? 1_000_000)) problems.push(`the network fee ${p.costs.networkFeeLamports} is above your limit`);
  // Displayed costs must also match the policy, so post-swap reports never rest on unverified figures.
  const [takerRent, routeRefund, feeBps] = [whole(policy.takerRent), whole(policy.routeRefund), whole(policy.feeBps)];
  if (takerRent === null || routeRefund === null || feeBps === null || policyFee === null) problems.push('the policy is malformed');
  else {
    const feeMint = policy.feeSide === 'output' ? policy.outputMint : policy.feeSide === 'sol' ? SOL_MINT : policy.inputMint;
    const solFee = feeMint === SOL_MINT ? policyFee : 0n;
    const kept = takerRent - routeRefund;
    const stated: [string, string | undefined, bigint | string][] = [
      ['costs.routeRentLamports', p.costs.routeRentLamports, takerRent],
      ['costs.routeRefundLamports', p.costs.routeRefundLamports, routeRefund],
      ['costs.routeKeptLamports', p.costs.routeKeptLamports, kept],
      ['costs.orientimFeeSolLamports', p.costs.orientimFeeSolLamports, solFee],
      ['costs.keptSolLamports', p.costs.keptSolLamports, BigInt(p.costs.networkFeeLamports) + kept + solFee],
      ['amounts.feeBps', p.amounts.feeBps, policyFee === 0n ? 0n : feeBps],
      ['amounts.feeMint', p.amounts.feeMint, String(feeMint)],
    ];
    const differ = stated.filter(([, v, want], i) => (i < 2 || v !== undefined) && v !== String(want)).map(([k]) => k);
    if (differ.length) problems.push(`${CERTIFICATE_MISMATCH}: the figures stated differ from the policy the transaction is checked against: ${differ.join(', ')}`);
  }
  // "auto" must be resolved to a number (`ownFloor`) before checking.
  if (intent.slippageBps === 'auto') return [...problems, 'slippageBps is "auto": check against the number of bps the swap was prepared with'];
  problems.push(...await verifyPrepared(p, {
    ...intent, slippageBps: intent.slippageBps, minOut: intent.minOut ?? '',
    ...(opts.slippageCeilingBps !== undefined ? { maxSlippageCeilingBps: opts.slippageCeilingBps } : {}),
  }, rpc, { requestTimeoutMs: opts.requestTimeoutMs }));
  return problems;
}

/** The swap's price impact exceeds `maxPriceImpactBps`; refused before anything is signed. */
export class PriceImpactError extends Error {
  readonly impactBps: number;
  readonly limitBps: number;
  constructor(impactBps: number, limitBps: number) {
    super(`Price impact is ${(impactBps / 100).toFixed(2)}%, above the limit of ${(limitBps / 100).toFixed(2)}%: this amount would move the market too much. Nothing was sent.`);
    this.impactBps = impactBps;
    this.limitBps = limitBps;
  }
}

export { IntentError } from './verify.ts';

/** The order already confirmed or may still land, so it is not swapped again. */
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

/** Message for a retry refused because the order book lacks atomic `reclaimOrder`. */
export const retryRefused = (id: string) =>
  `Order ${id} was tried before, and this order book has no reclaimOrder, so two workers could both retry it. Add reclaimOrder to the book (createFileStore has it), then retry with the same id. Nothing was prepared.`;

/** The requested `minOut` is further below Jupiter's price than `MAX_BELOW_BPS` allows. */
export class FloorError extends Error {
  readonly minOut: string;
  readonly lowest: string;
  constructor(minOut: string, lowest: string, belowBps = MAX_BELOW_BPS) {
    super(`The minimum ${minOut} is more than ${belowBps / 100}% below the market's own price; the lowest accepted is ${lowest}. Nothing was sent.`);
    this.minOut = minOut;
    this.lowest = lowest;
  }
}

/**
 * Validates the intent and derives the output floor, price impact and slippage from an independent
 * Jupiter quote. A caller `minOut` may not sit more than `MAX_BELOW_BPS` (or the owner's limit) below it.
 */
export async function ownFloor(
  intent: Intent,
  deps: { rpc: Rpc<SolanaRpcApi>; fetchImpl?: Fetch; jupiterApiKey?: string; requestTimeoutMs?: number; policy?: OwnerCeilings; budget?: JupiterBudget },
): Promise<{ minOut: string; outAmount: string; priceImpactBps: number | null; maxPriceImpactBps: number; slippageBps?: number }> {
  if (intent.routingMode !== undefined && intent.routingMode !== 'standard' && intent.routingMode !== 'fast') {
    throw new IntentError('routingMode must be standard or fast. Nothing was sent.');
  }
  if (intent.inputMint === intent.outputMint) throw new IntentError('inputMint and outputMint are the same token: there is nothing to swap. Nothing was sent.');
  const auto = intent.slippageBps === 'auto';
  if (intent.slippageBps !== undefined && !auto && !isSlippageBps(intent.slippageBps)) {
    throw new IntentError(`slippageBps must be "auto" or a whole number of bps from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}. Nothing was sent.`);
  }
  const owner = deps.policy ?? {};
  const chosen = auto ? undefined : intent.slippageBps as number | undefined;
  if (chosen !== undefined && owner.maxSlippageBps !== undefined && chosen > owner.maxSlippageBps) {
    throw new PolicyError('slippage-over-limit', `A slippage tolerance of ${chosen} bps is above the owner's limit of ${owner.maxSlippageBps}.`, { limit: String(owner.maxSlippageBps) });
  }
  if (intent.maxBelowBps !== undefined && owner.maxBelowBps !== undefined && intent.maxBelowBps > owner.maxBelowBps) {
    throw new PolicyError('floor-over-limit', `A floor ${intent.maxBelowBps} bps below the market is further than the owner's limit of ${owner.maxBelowBps}.`, { limit: String(owner.maxBelowBps) });
  }
  const maxImpact = intent.maxPriceImpactBps ?? Math.min(DEFAULT_MAX_PRICE_IMPACT_BPS, owner.maxPriceImpactBps ?? DEFAULT_MAX_PRICE_IMPACT_BPS);
  if (!(Number.isInteger(maxImpact) && maxImpact >= 0 && maxImpact <= MAX_PRICE_IMPACT_BPS)) {
    throw new IntentError(`maxPriceImpactBps must be a whole number of bps from 0 to ${MAX_PRICE_IMPACT_BPS}. Nothing was sent.`);
  }
  if (owner.maxPriceImpactBps !== undefined && maxImpact > owner.maxPriceImpactBps) {
    throw new PolicyError('impact-over-limit', `A price impact limit of ${maxImpact} bps is above the owner's limit of ${owner.maxPriceImpactBps}.`, { limit: String(owner.maxPriceImpactBps) });
  }
  if (intent.maxFeeBps !== undefined && feeLimitBps(intent.maxFeeBps) !== intent.maxFeeBps) {
    throw new IntentError(`maxFeeBps must be a whole number of bps from 0 to ${MAX_FEE_BPS}, the most Orientim's fee may ever be. Nothing was sent.`);
  }
  if (intent.minOut !== undefined && !/^\d{1,20}$/.test(intent.minOut)) throw new IntentError('minOut must be a whole number of base units, as a string. Nothing was sent.');
  for (const [name, v] of [
    ['maxNetworkFeeLamports', intent.maxNetworkFeeLamports], ['maxRouteCostLamports', intent.maxRouteCostLamports], ['maxSolFeeLamports', intent.maxSolFeeLamports],
  ] as const) {
    if (v !== undefined && !(Number.isSafeInteger(v) && v >= 0)) throw new IntentError(`${name} must be a whole number of lamports. Nothing was sent.`);
  }
  const quoteFor = (inputTax: Awaited<ReturnType<typeof inputTransferFee>>) => ownQuote({
    inputMint: intent.inputMint, outputMint: intent.outputMint, amountIn: intent.amountIn, taker: intent.owner,
    maxFeeBps: intent.maxFeeBps, maxBelowBps: intent.maxBelowBps, slippageBps: chosen, autoSlippage: auto, apiKey: deps.jupiterApiKey, fetchImpl: deps.fetchImpl, budget: deps.budget,
    ceilings: { maxSlippageBps: owner.maxSlippageBps, maxBelowBps: owner.maxBelowBps },
    inputTax,
    allowUnknownImpact: owner.allowUnknownPriceImpact === true,
    rpc: deps.rpc,
  });
  // Quote in parallel with the transfer-fee read; requote only if the input token charges a fee.
  const [tax, untaxed] = await Promise.allSettled([inputTransferFee(deps.rpc, intent.inputMint, deps.requestTimeoutMs), quoteFor(null)]);
  if (tax.status === 'rejected') throw tax.reason;
  const own = tax.value && tax.value.bps > 0 ? await quoteFor(tax.value) : untaxed.status === 'fulfilled' ? untaxed.value : (() => { throw untaxed.reason; })();
  if (own.priceImpactBps !== null && own.priceImpactBps > maxImpact) throw new PriceImpactError(own.priceImpactBps, maxImpact);
  const tolerance = own.slippageBps !== undefined ? { slippageBps: own.slippageBps } : {};
  if (intent.minOut === undefined) return { minOut: own.minOut, outAmount: own.outAmount, priceImpactBps: own.priceImpactBps, maxPriceImpactBps: maxImpact, ...tolerance };
  const belowBps = owner.maxBelowBps ?? MAX_BELOW_BPS;
  const lowest = (BigInt(own.outAmount) * BigInt(10_000 - belowBps)) / 10_000n;
  if (BigInt(intent.minOut) < lowest) {
    if (owner.maxBelowBps !== undefined && owner.maxBelowBps < MAX_BELOW_BPS) {
      throw new PolicyError('floor-over-limit', `The minimum ${intent.minOut} is more than ${belowBps / 100}% below the market's own price, the owner's limit; the lowest accepted is ${lowest}.`, { limit: String(belowBps) });
    }
    throw new FloorError(intent.minOut, lowest.toString());
  }
  return { minOut: intent.minOut, outAmount: own.outAmount, priceImpactBps: own.priceImpactBps, maxPriceImpactBps: maxImpact, ...tolerance };
}

/** Returns the intent with `slippageBps` replaced by the resolved value, or removed when undefined. */
export function withTolerance<T extends Intent | Omit<Intent, 'owner'>>(intent: T, slippageBps: number | undefined): T {
  const { slippageBps: _asked, ...rest } = intent;
  return (slippageBps !== undefined ? { ...rest, slippageBps } : rest) as T;
}

/** A prepared swap that passed the check, with the resolved intent and token issuer risk. */
export type Checked = { prepared: Prepared; intent: Intent; notices?: string[]; tokenRisk?: TokenRisk };

/** Prepares a swap and fully checks it; throws on any refusal. Sign only the returned transaction. */
export async function prepareChecked(args: {
  apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; owner: string; intent: Omit<Intent, 'owner'>;
  fetchImpl?: Fetch; jupiterApiKey?: string; requestTimeoutMs?: number;
  /** Optional diagnostics. Exceptions from this observer never change the signing decision. */
  onTiming?: (phase: TimedPhase | 'sign' | 'finalize', ms: number) => void;
  /** Owner ceilings on slippage, floor and price impact. */
  policy?: OwnerCeilings;
  /** Fetch routes locally with `jupiterApiKey` (default when a key is set); false uses Orientim's key. */
  ownRoutes?: boolean;
  /** Shared time and Jupiter request budget for the preparation. */
  budget?: JupiterBudget;
}): Promise<Checked> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const owner = args.owner;
  const budget = args.budget ?? preparationBudget();
  const within = (ms: number | undefined) => {
    const left = timeLeftOf(budget);
    if (left <= 0) throw outOfPreparationTime();
    return Math.max(1, Math.floor(Math.min(ms ?? 10_000, left)));
  };
  const started = performance.now();
  const durations = new Map<TimedPhase, number>();
  const timeOf = <T>(phase: TimedPhase, work: Promise<T>, from = performance.now()): Promise<T> => {
    work.then(() => { durations.set(phase, performance.now() - from); }, () => undefined);
    return work;
  };
  const report = () => {
    for (const phase of ['ownFloor', 'apiPrepare', 'localVerification', 'tokenRisk', 'readyToSign'] as const) {
      const ms = durations.get(phase);
      if (ms !== undefined) try { args.onTiming?.(phase, Math.round(ms)); } catch { /* diagnostics cannot veto a swap */ }
    }
  };
  try {
    const floor = timeOf('ownFloor', ownFloor({ ...args.intent, owner }, {
      rpc: args.rpc, fetchImpl, jupiterApiKey: args.jupiterApiKey, requestTimeoutMs: within(args.requestTimeoutMs), policy: args.policy, budget,
    }), started);
    // Avoid an unhandled rejection before it is awaited.
    floor.catch(() => undefined);
    const resolved = (o: Awaited<typeof floor>): Intent => withTolerance({ ...args.intent, owner, minOut: o.minOut }, o.slippageBps);
    const fieldsOf = (i: Intent) => ({ ...(i.minOut ? { minOut: i.minOut } : {}), ...(i.slippageBps !== undefined ? { slippageBps: i.slippageBps } : {}) });
    const body = {
      owner, inputMint: args.intent.inputMint, outputMint: args.intent.outputMint, amountIn: args.intent.amountIn,
      ...(args.intent.acceptCostBps ? { acceptCostBps: args.intent.acceptCostBps } : {}),
      ...(args.intent.routingMode === 'fast' ? { routingMode: 'fast' } : {}),
      ...(args.intent.version !== undefined ? { version: args.intent.version } : {}),
    };
    // The first own-routes round needs no minimum, so it runs in parallel with the quote, except with
    // "auto", whose tolerance determines the routes.
    const parallel = !!args.jupiterApiKey && args.ownRoutes !== false && args.intent.slippageBps !== 'auto';
    // An unhandled rejection here would crash the process.
    const ownFields = parallel ? floor.then(o => fieldsOf(resolved(o))) : undefined;
    ownFields?.catch(() => undefined);
    let prepared: Prepared;
    try {
      prepared = await timeOf('apiPrepare', preparedByOrientim(fetchImpl, args.apiUrl, args.apiKey, {
        ...body,
        ...(parallel && typeof args.intent.slippageBps === 'number' ? { slippageBps: args.intent.slippageBps } : {}),
        ...(parallel ? {} : fieldsOf(resolved(await floor))),
      }, args.requestTimeoutMs ?? PREPARE_WAIT_MS, {
        jupiterApiKey: args.jupiterApiKey, ownRoutes: args.ownRoutes, budget,
        ...(ownFields ? { floor: ownFields } : {}),
      }));
    } catch (e) {
      // Prefer the local refusal over the server's error.
      await floor;
      throw e;
    }
    const own = await floor;
    const intent = resolved(own);
    // The built route may have more impact than the best market route; the server's figure can only refuse.
    const routeImpact = prepared.amounts?.priceImpactPct;
    if (typeof routeImpact === 'number' && Number.isFinite(routeImpact) && Math.round(routeImpact * 10_000) > own.maxPriceImpactBps) {
      throw new PriceImpactError(Math.round(routeImpact * 10_000), own.maxPriceImpactBps);
    }
    await holdSolFee(intent, prepared, { fetchImpl, jupiterApiKey: args.jupiterApiKey, budget });
    const riskRead = timeOf('tokenRisk', tokenRisk(args.rpc, [intent.inputMint, intent.outputMint], within(args.requestTimeoutMs ?? 10_000)));
    riskRead.catch(() => undefined);
    const problems = await timeOf('localVerification', checkPrepared(prepared, intent, args.rpc, { requestTimeoutMs: within(args.requestTimeoutMs), slippageCeilingBps: args.policy?.maxSlippageBps }));
    if (problems.length) {
      const refused = new Error(`Not signing: ${problems.join('; ')}`);
      // RPC-only failures are retryable; the transaction itself is not at fault.
      if (problems.every(isRpcFailure)) refused.name = 'RpcUnavailableError';
      throw refused;
    }
    const risk = await riskRead;
    // A check that finished past the budget is not accepted.
    if (timeLeftOf(budget) <= 0) throw outOfPreparationTime();
    durations.set('readyToSign', performance.now() - started);
    return { prepared: preparedData(prepared), intent, notices: noticesOf(risk), tokenRisk: risk };
  } finally {
    report();
  }
}

/**
 * Strips a checked response to known fields and data-only values so server prose never reaches a
 * model. The verified transaction is kept intact regardless of length.
 */
export function preparedData(prepared: Prepared): Prepared {
  const known: Record<string, unknown> = {};
  for (const k of PREPARED_FIELDS) if (Object.hasOwn(prepared, k)) known[k] = (prepared as Record<string, unknown>)[k];
  const only = (value: unknown, fields: readonly string[]) => {
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(fields.filter(k => Object.hasOwn(value, k)).map(k => [k, (value as Record<string, unknown>)[k]]));
  };
  if (Object.hasOwn(known, 'amounts')) known.amounts = only(known.amounts, AMOUNT_FIELDS);
  if (Object.hasOwn(known, 'costs')) known.costs = only(known.costs, COST_FIELDS);
  // Display-only fields must match an exact shape or are dropped, so they cannot carry server text.
  if (Array.isArray(known.route)) known.route = known.route.filter(isMarketName).slice(0, 8);
  for (const [field, shape] of Object.entries(SHOWN_SHAPES)) {
    if (Object.hasOwn(known, field) && !shape(known[field])) delete known[field];
  }
  const costs = known.costs as Record<string, unknown> | undefined;
  if (costs && typeof costs === 'object') {
    if (Object.hasOwn(costs, 'breakdown') && !breakdownShape(costs.breakdown)) delete costs.breakdown;
    if (Object.hasOwn(costs, 'tokenTax') && !tokenTaxShape(costs.tokenTax)) delete costs.tokenTax;
  }
  // Market names contain spaces, which `dataOnly` would drop; the route is already shape-checked.
  const route = Array.isArray(known.route) ? { route: known.route } : {};
  return { ...(dataOnly(known) as Prepared), ...route, transaction: prepared.transaction };
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exactly = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const digitsOf = (v: unknown) => typeof v === 'string' && DIGITS.test(v);
const partShape = (v: unknown) => plain(v) && exactly(v, ['mint', 'amount']) && typeof v.mint === 'string' && BASE58.test(v.mint) && digitsOf(v.amount);
const ISSUER_POWERS = ['freezeAuthority', 'mintAuthority', 'permanentDelegate'] as const;
const powersShape = (v: unknown) => plain(v) && exactly(v, ISSUER_POWERS) && Object.values(v).every(x => typeof x === 'boolean');
/** Shape of `costs.breakdown`. */
const breakdownShape = (v: unknown) => plain(v)
  && exactly(v, ['principal', 'orientimFee', 'networkFeeLamports', 'rentReturnedLamports', 'rentKeptLamports'])
  && (v.principal === undefined || partShape(v.principal)) && (v.orientimFee === undefined || partShape(v.orientimFee))
  && ['networkFeeLamports', 'rentReturnedLamports', 'rentKeptLamports'].every(k => v[k] === undefined || digitsOf(v[k]));
/** Shape of `costs.tokenTax`. */
const tokenTaxShape = (v: unknown) => v === null
  || (plain(v) && exactly(v, ['inputBps', 'extraOnInput']) && Number.isInteger(v.inputBps) && (v.inputBps as number) >= 0
    && (v.inputBps as number) <= 10_000 && digitsOf(v.extraOnInput));
/** A short Jupiter market name, never a sentence. */
const isMarketName = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9 .+()-]{0,31}$/.test(x);
const SHOWN_SHAPES: Readonly<Record<string, (v: unknown) => boolean>> = {
  notices: v => plain(v) && Object.keys(v).length <= 8
    && Object.entries(v).every(([k, x]) => /^[a-z][A-Za-z]{0,31}$/.test(k) && typeof x === 'boolean'),
  tokens: v => plain(v) && exactly(v, ['input', 'output']) && Object.values(v).every(powersShape),
  route: v => Array.isArray(v) && v.length <= 8 && v.every(isMarketName),
  slippageBps: v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000,
};

/**
 * For a SOL-side fee, sets `intent.maxSolFeeLamports` to the lower of the intent's value and the limit
 * from `ownSolFeeLimit`; the intent can only lower it. No-op for token-side fees.
 */
export async function holdSolFee(
  intent: Intent, prepared: Pick<Prepared, 'policy'>, deps: { fetchImpl?: Fetch; jupiterApiKey?: string; budget?: JupiterBudget },
): Promise<void> {
  if ((prepared.policy as { feeSide?: unknown } | undefined)?.feeSide !== 'sol') return;
  const given = intent.maxSolFeeLamports;
  if (given !== undefined && !(Number.isSafeInteger(given) && given >= 0)) {
    throw new IntentError('maxSolFeeLamports must be a whole number of lamports. Nothing was sent.');
  }
  const own = await ownSolFeeLimit({
    inputMint: intent.inputMint, amountIn: intent.amountIn, taker: intent.owner, maxFeeBps: intent.maxFeeBps, apiKey: deps.jupiterApiKey, fetchImpl: deps.fetchImpl,
    budget: deps.budget,
  });
  intent.maxSolFeeLamports = given === undefined ? own : Math.min(own, given);
}

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Output received by the wallet in base units, read from the confirmed transaction, or null. For SOL,
 * network fee and net route rent are added back. Never throws.
 */
export async function receivedFor(
  rpc: Rpc<SolanaRpcApi>, signature: string, prepared: Pick<Prepared, 'wallet' | 'certificate' | 'policy'> & { version?: number },
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
          // Rent comes from the verified policy, not the response's costs.
          const whole = (v: unknown) => (typeof v === 'string' && /^\d{1,20}$/.test(v) ? BigInt(v) : null);
          const [rent, refund] = [whole(prepared.policy?.takerRent), whole(prepared.policy?.routeRefund)];
          if (rent === null || refund === null) return null;
          return BigInt(after) - BigInt(before) + BigInt(meta.fee) + rent - refund;
        }
        const mine = (list: readonly TokenBalance[] | null | undefined) => (list ?? []).filter(b => b.mint === outputMint && b.owner === prepared.wallet);
        const after = mine(meta.postTokenBalances);
        if (!after.length) return null;
        const before = new Map(mine(meta.preTokenBalances).map(b => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
        return after.reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount) - (before.get(b.accountIndex) ?? 0n), 0n);
      }
    } catch {
      // Retried below.
    }
    await wait(opts.pollMs ?? 500);
  }
  return null;
}

/** Describes a fill notably better or worse than the quote, relative to `tolerance` (e.g. `1%`); empty otherwise. */
export function fillAgainstQuote(received: bigint, expected: bigint, tolerance: string): string {
  if (expected <= 0n) return '';
  const bps = Number(((received - expected) * 10_000n) / expected);
  const pct = (b: number) => `${(Math.abs(b) / 100).toFixed(Math.abs(b) < 100 ? 2 : 1)}%`;
  if (bps >= 5) return `${pct(bps)} better than quoted.`;
  if (bps > -100) return '';
  const allowed = /^(\d+(?:\.\d+)?)%$/.exec(tolerance.trim());
  if (allowed && -bps <= Number(allowed[1]) * 100) return `Filled ${pct(bps)} below the quote, within your ${tolerance} tolerance.`;
  return `Filled ${pct(bps)} below the quote.`;
}

/**
 * Finalizes a wallet-signed transaction and reads its outcome on your RPC. A new swap for the same
 * intent is safe only after `rejected` or `expired`; after `unknown`, check `signature` first.
 */
export async function finalizeSigned(args: {
  apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; prepared: Prepared; signedTransaction: string;
  fetchImpl?: Fetch; pollMs?: number;
  /** Custom sender; Orientim then does not send. */
  sendTransaction?: SendTransaction;
  /** Called before finalize; persist the record durably here. If it throws, nothing is finalized. */
  onSigned?: (signed: Signed) => void | Promise<void>;
  /** Outcome wait in ms before returning `unknown` (default 3 minutes). */
  maxWaitMs?: number;
  /** Per-request timeout in ms. */
  requestTimeoutMs?: number;
  /** Full-history RPC used as a second proof of expiry. */
  archive?: Rpc<SolanaRpcApi>;
}): Promise<{ signature: string; outcome: Outcome | 'rejected'; prepared: Prepared; refusal?: string; cause?: string }> {
  const { prepared, signedTransaction } = args;
  const mine = getTransactionDecoder().decode(Buffer.from(signedTransaction, 'base64'));
  const built = getTransactionDecoder().decode(Buffer.from(prepared.transaction, 'base64'));
  if (!sameBytes(mine.messageBytes, built.messageBytes)) throw new Error('Not finalizing: this is not the transaction Orientim prepared. Nothing was sent.');
  const own = mine.signatures[prepared.wallet as Address];
  if (!own || !await verifySignature(await getPublicKeyFromAddress(prepared.wallet as Address), own, mine.messageBytes)) {
    throw new Error(`Not finalizing: the transaction carries no valid signature from ${prepared.wallet}. Nothing was sent.`);
  }
  const signature = getSignatureFromTransaction(mine);
  const height = BigInt(await readOnYourRpc(() => args.rpc.getBlockHeight({ commitment: 'confirmed' }).send({ abortSignal: AbortSignal.timeout(args.requestTimeoutMs ?? 10_000) }), 'the block height'));
  const stated = BigInt(prepared.lastValidBlockHeight);
  if (stated - height < MIN_BLOCKS_TO_FINALIZE) {
    throw new Error(`Not finalizing: only ${stated - height} blocks are left before this swap expires, too few to land. This call sent nothing; prepare it again (a swap an earlier call finalized is settled with resumeSigned or recoverPending, not here).`);
  }
  // A lifetime beyond 150 blocks plus margin means a lagging RPC or an overstated answer; either
  // could make a live swap look expired.
  if (stated - height > 150n + LAG_BLOCKS) {
    throw new Error(`Not finalizing: the transaction's stated lifetime ends ${stated - height} blocks past your RPC's height, more blocks than any blockhash lives (150, and ${LAG_BLOCKS} of margin). Your RPC trails the network, or the answer overstates the lifetime. This call sent nothing; use an RPC that keeps up, then prepare again.`);
  }
  // Derive the expiry locally; the server's figure is never stored, so it cannot shorten or extend the wait.
  const lastValid = height + 150n + LAG_BLOCKS;
  const signed: Signed = {
    signature, lastValidBlockHeight: lastValid, ticket: prepared.ticket, signedTransaction, messageSha256: prepared.messageSha256, signedAt: Date.now(),
    owner: prepared.wallet, signedHeight: height,
  };
  await args.onSigned?.(signed);
  return { ...await askAndConfirm(args, signed, mine, prepared.temporaryAuthority), prepared };
}

/** Jupiter's swap program; its error 6001 means slippage exceeded. */
const JUPITER_SWAP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const ERROR_NAME = /^[A-Za-z]{3,40}$/;

/**
 * Describes a simulation error from a `network` refusal, or undefined for unknown shapes. The input
 * is untrusted: only known shapes are read, and the program comes from the signed transaction.
 */
export function networkCause(raw: string, transaction: Transaction): string | undefined {
  let err: unknown;
  try {
    if (raw.length > 300) return undefined;
    err = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof err === 'string') {
    if (!ERROR_NAME.test(err)) return undefined;
    if (err === 'BlockhashNotFound') return "the network no longer knew the transaction's blockhash (it had expired)";
    if (err === 'InsufficientFundsForFee') return 'the wallet could not pay the network fee';
    return `the network's check failed with ${err}`;
  }
  const failed = (err as { InstructionError?: unknown } | null)?.InstructionError;
  if (!Array.isArray(failed) || failed.length !== 2 || !Number.isInteger(failed[0]) || failed[0] < 0 || failed[0] > 64) return undefined;
  const [index, detail] = failed as [number, unknown];
  const custom = (detail as { Custom?: unknown } | null)?.Custom;
  const named = typeof detail === 'string' && ERROR_NAME.test(detail) ? detail : undefined;
  if (named === undefined && !(Number.isInteger(custom) && (custom as number) >= 0 && (custom as number) < 2 ** 32)) return undefined;
  let program: string | undefined;
  try {
    // v0 lists instructions; v1 lists instruction headers.
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes) as unknown as {
      staticAccounts: string[]; instructions?: { programAddressIndex: number }[]; instructionHeaders?: { programAccountIndex: number }[];
    };
    const at = message.instructions?.[index]?.programAddressIndex ?? message.instructionHeaders?.[index]?.programAccountIndex;
    program = at === undefined ? undefined : message.staticAccounts[at];
  } catch {
    program = undefined;
  }
  if (program === JUPITER_SWAP_PROGRAM && custom === 6001) return 'the price moved beyond your slippage tolerance (Jupiter error 6001, the route now gives less than your minimum)';
  const where = program ? `instruction ${index} (program ${program})` : `instruction ${index}`;
  if (named === 'InsufficientFunds') return `${where} reported insufficient funds for what it moves`;
  return named ? `${where} failed with ${named}` : `${where} failed with its own error code ${custom}`;
}

/** Describes why a landed transaction failed, from the RPC status error; see `networkCause`. */
export function failureCause(err: unknown, transaction: Transaction): string | undefined {
  try {
    const raw = JSON.stringify(err, (_, v) => typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= 0n ? Number(v) : undefined) : v);
    return typeof raw === 'string' ? networkCause(raw, transaction) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Calls finalize, retrying once on no or unreadable answer (the same bytes land at most once), then
 * confirms on chain. A 4xx refusal is not retried.
 */
async function askAndConfirm(
  args: {
    apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; fetchImpl?: Fetch; pollMs?: number; maxWaitMs?: number; requestTimeoutMs?: number; archive?: Rpc<SolanaRpcApi>;
    sendTransaction?: SendTransaction;
  },
  signed: Signed, mine: Transaction, temporaryAuthority: string,
): Promise<{ signature: string; outcome: Outcome | 'rejected'; refusal?: string; cause?: string }> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const { signature } = signed;
  let done: Finalized | null = null;
  let refused: OrientimApiError | null = null;
  for (let attempt = 0; attempt < 2 && !done && !refused; attempt++) {
    try {
      done = await call<Finalized>(fetchImpl, `${args.apiUrl}/api/v1/finalize`, args.apiKey, {
        ticket: signed.ticket, signedTransaction: signed.signedTransaction, ...(args.sendTransaction ? { send: false } : {}),
      }, args.requestTimeoutMs);
    } catch (e) {
      if (e instanceof OrientimApiError && e.status < 500) refused = e;
      else if (attempt === 0) await wait(args.pollMs ?? 1_000);
    }
  }
  // Rebroadcast server bytes only if they are this exact transaction.
  const bytes = done?.signedTransaction && await isThisTransaction(done.signedTransaction, mine, temporaryAuthority)
    ? done.signedTransaction : undefined;
  let chainError: unknown;
  const outcome = await confirm(args.rpc, signature, signed.lastValidBlockHeight, {
    signedTransaction: bytes, pollMs: args.pollMs, maxWaitMs: args.maxWaitMs, requestTimeoutMs: args.requestTimeoutMs, earliestHeight: signed.signedHeight,
    archive: args.archive, temporaryAuthority, ...(args.sendTransaction ? { send: args.sendTransaction } : {}),
    onFailed: err => { chainError = err; },
  });
  const refusal = refused ? refused.code : done?.status === 'rejected' ? safeCode(done.refusal ?? 'network') : undefined;
  const cause = outcome === 'failed' ? failureCause(chainError, mine)
    : refusal === 'network' && done?.transactionError ? networkCause(done.transactionError, mine) : undefined;
  if (outcome === 'expired' && refusal) return { signature, outcome: 'rejected', refusal, ...(cause ? { cause } : {}) };
  return { signature, outcome, ...(refusal ? { refusal } : {}), ...(cause ? { cause } : {}) };
}

/**
 * Re-finalizes a persisted swap and confirms it on chain. First-send checks are skipped since the
 * transaction may already have been sent.
 */
export async function resumeSigned(args: {
  apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; signed: Signed;
  fetchImpl?: Fetch; pollMs?: number; maxWaitMs?: number; requestTimeoutMs?: number; archive?: Rpc<SolanaRpcApi>;
  sendTransaction?: SendTransaction;
}): Promise<{ signature: string; outcome: Outcome | 'rejected'; refusal?: string; cause?: string }> {
  const mine = getTransactionDecoder().decode(Buffer.from(args.signed.signedTransaction, 'base64'));
  if (getSignatureFromTransaction(mine) !== args.signed.signature) throw new Error('The kept record does not carry its own transaction. Nothing was sent.');
  return askAndConfirm(args, args.signed, mine, temporaryAuthorityOf(args.signed.signedTransaction) ?? '');
}

/** Full flow: `prepareChecked`, wallet signing, `finalizeSigned`, then bookkeeping. */
export async function protectedSwap(args: {
  apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; wallet: WalletSigner; intent: Omit<Intent, 'owner'>;
  fetchImpl?: Fetch; pollMs?: number; jupiterApiKey?: string;
  /** Fetch routes locally with `jupiterApiKey` (default when a key is set). */
  ownRoutes?: boolean;
  /** Optional per-phase durations; never receives keys, mints or transaction bytes. */
  onTiming?: (phase: TimedPhase | 'sign' | 'finalize', ms: number) => void;
  /** Called before finalize; persist the record durably here. If it throws, nothing is finalized. */
  onSigned?: (signed: Signed) => void | Promise<void>;
  /** Outcome wait in ms before returning `unknown` (default 3 minutes). */
  maxWaitMs?: number;
  /** Per-request timeout in ms. */
  requestTimeoutMs?: number;
  /** Full-history RPC used as a second proof of expiry. */
  archive?: Rpc<SolanaRpcApi>;
  /** Custom sender; Orientim then does not send. */
  sendTransaction?: SendTransaction;
  /** Order book keyed by `intent.id`. */
  orders?: OrderBook;
  /** Pending store; blocks new swaps while another from this wallet may still land. */
  pending?: PendingStore;
  /** Owner limits, checked before prepare and again before finalize. Daily limits need `spends`. */
  policy?: OwnerPolicy;
  /** Spend log; every swap is recorded so later daily limits count it. */
  spends?: SpendLog;
}): Promise<{
  signature: string; outcome: Outcome | 'rejected'; prepared: Prepared; refusal?: string; cause?: string; bookkeepingError?: string;
  /** Token notices. */
  notices: string[];
  /** Token issuer risk, or `unavailable`. */
  tokenRisk?: TokenRisk;
  /** Output received in base units, when readable. */
  received?: string;
}> {
  const id = args.intent.id;
  const orders = id ? args.orders : undefined;
  const owner = args.wallet.address;
  const prior = orders ? await orders.order(id!) : null;
  if (orderIsOpen(prior)) throw new OrientimOrderError(id!, prior);
  if (prior && !orders!.reclaimOrder) throw new Error(retryRefused(id!));
  const waiting = args.pending ? await pendingFor(args.pending, owner) : [];
  if (waiting.length) throw new PendingSwapError(waiting);
  const spend = { owner, inputMint: args.intent.inputMint, outputMint: args.intent.outputMint, amountIn: args.intent.amountIn };
  if (args.policy) await checkPolicy(args.policy, spend, args.spends);
  const { prepared, notices = [], tokenRisk: risk } = await prepareChecked({ ...args, owner });
  const signStarted = performance.now();
  const signedTransaction = await signAsWallet(args.wallet, prepared.transaction);
  try { args.onTiming?.('sign', Math.round(performance.now() - signStarted)); } catch { /* diagnostics only */ }
  const finalizeStarted = performance.now();
  const result = await finalizeSigned({
    ...args, prepared, signedTransaction,
    // Pending is re-checked after `put` so two racing runs both stand down rather than both send.
    onSigned: async signed => {
      const kept: Signed = { ...signed, ...(id ? { intentId: id } : {}) };
      // Record the spend before keeping the swap: once kept it may be sent.
      let counted = false;
      if (args.policy) await checkPolicy(args.policy, spend, args.spends, signed.signature);
      if (args.spends) {
        await args.spends.recordSpend({ signature: signed.signature, owner, mint: spend.inputMint, amountIn: spend.amountIn, at: Date.now() });
        counted = true;
      }
      try {
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
      } catch (e) {
        // Never sent, so the spend is released.
        if (counted) await args.spends?.forgetSpend?.(signed.signature).catch(() => undefined);
        throw e;
      }
      await args.onSigned?.(kept);
    },
  });
  try { args.onTiming?.('finalize', Math.round(performance.now() - finalizeStarted)); } catch { /* diagnostics only */ }
  const got = result.outcome === 'confirmed'
    ? await receivedFor(args.rpc, result.signature, prepared, { requestTimeoutMs: args.requestTimeoutMs, pollMs: args.pollMs })
    : null;
  const told = { ...result, notices, ...(risk ? { tokenRisk: risk } : {}), ...(got !== null ? { received: got.toString() } : {}) };
  // A bookkeeping failure is reported beside the on-chain outcome, never in place of it.
  try {
    if (orders) await settleOrder(orders, id!, { signature: result.signature, state: result.outcome === 'unknown' ? 'pending' : result.outcome });
    if (movedNothing(result.outcome)) await args.spends?.forgetSpend?.(result.signature);
    if (args.pending && result.outcome !== 'unknown') await args.pending.remove(result.signature);
  } catch (e) {
    return { ...told, bookkeepingError: e instanceof Error ? e.message : String(e) };
  }
  return told;
}
