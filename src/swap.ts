/**
 * A protected swap through the Orientim agent API, end to end: prepare → verify → sign as the wallet →
 * finalize → confirm, with every chain read on your own RPC. Needs @solana/kit 8 and nothing else:
 * the verifier is in this package (./verify.ts).
 *
 * The check before signing is the point. Orientim's server builds the transaction, so the agent runs
 * Orientim's full verifier on the exact bytes, against chain state from its own RPC, with the policy
 * held to its own intent and limits. A compromised server, relay or impostor URL can then refuse or
 * delay a swap, never make the wallet sign one that moves more than the approved amount. The price
 * is held to a floor of the agent's own: `--min-out`, or one this module asks Jupiter for itself.
 *
 * After signing, the chain is the only witness. The transaction's id is the wallet's own signature,
 * known before finalize; the outcome is read for that id on your RPC, whatever finalize answers or
 * fails to answer, so a lost answer or a lying server can neither fake a success nor start a second
 * swap while the first one could still land.
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
import { CERTIFICATE_MISMATCH, DEFAULT_MAX_PRICE_IMPACT_BPS, feeLimitBps, inputTransferFee, isRpcFailure, isSlippageBps, MAX_BELOW_BPS, MAX_FEE_BPS, MAX_PRICE_IMPACT_BPS, MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS, noticesOf, ownQuote, ownSolFeeLimit, preparationBudget, timeLeftOf, tokenRisk, verifyPrepared } from './verify.ts';
import type { JupiterBudget, TokenRisk } from './verify.ts';

/**
 * The steps `onTiming` reports for a preparation, each from its own start to its own end (some run
 * at the same time), and `readyToSign`, the whole wait until a checked transaction is ready to sign.
 */
export type TimedPhase = 'ownFloor' | 'apiPrepare' | 'localVerification' | 'tokenRisk' | 'readyToSign';


/**
 * What to check before signing. First that Orientim's answer agrees with itself and with what you
 * asked for; then the full verifier on the exact bytes, with chain state from `rpc`, which must be
 * your own RPC. Returns the problems found; sign only when there are none.
 */
export async function checkPrepared(
  p: Prepared, intent: Intent, rpc: Rpc<SolanaRpcApi>,
  /** `slippageCeilingBps`: the owner's `maxSlippageBps`, held on the signed bytes (never from the intent). */
  opts: { requestTimeoutMs?: number; slippageCeilingBps?: number } = {},
): Promise<string[]> {
  // Every number in the answer is checked here, before the wallet signs, including those only shown
  // once the swap is sent: nothing Orientim sends can make the report of a sent swap fail, and a
  // report that fails invites a second swap.
  const digits = (v: unknown) => typeof v === 'string' && /^\d{1,20}$/.test(v);
  const malformed = [
    ...(['amountIn', 'fee', 'feeBps', 'swapAmount', 'quotedOut', 'minOut'] as const).filter(k => !digits(p.amounts?.[k])).map(k => `amounts.${k}`),
    ...(['networkFeeLamports', 'outputAccountRentLamports', 'routeRentLamports', 'routeRefundLamports'] as const)
      .filter(k => !digits(p.costs?.[k])).map(k => `costs.${k}`),
    ...(['keptSolLamports', 'routeKeptLamports', 'orientimFeeSolLamports'] as const)
      .filter(k => p.costs?.[k] !== undefined && !digits(p.costs[k])).map(k => `costs.${k}`),
    ...(p.amounts?.feeMint !== undefined && !(typeof p.amounts.feeMint === 'string' && BASE58.test(p.amounts.feeMint)) ? ['amounts.feeMint'] : []),
    // null: Jupiter did not state it (unknown, not none).
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
  // The fee is in the input token, or taken from the output (SOL, USDC or USDT): a share of what is
  // paid in, or of the minimum that comes out, never more than your limit of either. Paid in SOL
  // from the wallet, it is held to your own price by the verifier's check (maxSolFeeLamports).
  const inSol = (p.policy as { feeSide?: unknown }).feeSide === 'sol';
  const onOutput = p.amounts.feeMint !== undefined && p.amounts.feeMint === intent.outputMint && p.amounts.feeMint !== intent.inputMint;
  const base = onOutput ? BigInt(p.amounts.minOut) + BigInt(p.amounts.fee) : BigInt(intent.amountIn);
  const maxFee = (base * BigInt(feeLimitBps(intent.maxFeeBps))) / 10_000n;
  const stated = BigInt(p.certificate.input.orientimFee) + BigInt(p.certificate.output.orientimFee ?? '0') + BigInt(p.certificate.solFee?.lamports ?? '0');
  if (!inSol && BigInt(p.amounts.fee) > maxFee) problems.push(`the Orientim fee ${p.amounts.fee} is above ${maxFee}`);
  if (stated !== BigInt(p.amounts.fee)) problems.push(`${CERTIFICATE_MISMATCH}: the fee the certificate states differs from the one in amounts`);
  if (p.certificate.output.minimumOutput !== p.amounts.minOut) problems.push(`${CERTIFICATE_MISMATCH}: the enforced minimum differs from the one stated`);
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
    problems.push(`${CERTIFICATE_MISMATCH}: the amounts stated differ from the policy the transaction is checked against`);
  }
  if (intent.minOut && /^\d{1,20}$/.test(intent.minOut) && BigInt(p.amounts.minOut) < BigInt(intent.minOut)) {
    problems.push(`the minimum ${p.amounts.minOut} is below yours, ${intent.minOut}`);
  }
  if (BigInt(p.costs.networkFeeLamports) > BigInt(intent.maxNetworkFeeLamports ?? 1_000_000)) problems.push(`the network fee ${p.costs.networkFeeLamports} is above your limit`);
  // Every figure the answer states beside the bytes is the policy's own, so that nothing reported
  // after the swap (what arrived, what it cost) rests on a number only the server vouched for.
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
  // The answer's own claims are not evidence: what the bytes do is decided by the verifier.
  // "auto" is resolved to a number before prepare (`ownFloor`): the route is held to that number.
  if (intent.slippageBps === 'auto') return [...problems, 'slippageBps is "auto": check against the number of bps the swap was prepared with'];
  problems.push(...await verifyPrepared(p, {
    ...intent, slippageBps: intent.slippageBps, minOut: intent.minOut ?? '',
    ...(opts.slippageCeilingBps !== undefined ? { maxSlippageCeilingBps: opts.slippageCeilingBps } : {}),
  }, rpc, { requestTimeoutMs: opts.requestTimeoutMs }));
  return problems;
}

/**
 * This amount would move the market more than `maxPriceImpactBps`: refused before anything was
 * prepared or signed. Usually thin liquidity; a smaller amount, or a limit raised by the owner.
 */
export class PriceImpactError extends Error {
  readonly impactBps: number;
  readonly limitBps: number;
  constructor(impactBps: number, limitBps: number) {
    super(`Price impact is ${(impactBps / 100).toFixed(2)}%, above the limit of ${(limitBps / 100).toFixed(2)}%: this amount would move the market too much. Nothing was sent.`);
    this.impactBps = impactBps;
    this.limitBps = limitBps;
  }
}

/**
 * The intent itself cannot be used: a figure outside what the skill allows (a slippage tolerance, a
 * price impact limit, a fee limit or a minimum). A usage error, not a refusal of this swap: the
 * `orientim` commands exit 2. Nothing was prepared.
 */
export class IntentError extends Error {
  override name = 'IntentError';
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
  `Order ${id} was tried before, and this order book has no reclaimOrder, so two workers could both retry it. Add reclaimOrder to the book (createFileStore has it), then retry with the same id. Nothing was prepared.`;

/**
 * The minimum a caller asked for sits further below Jupiter's own price than `MAX_BELOW_BPS` allows:
 * refused before anything was prepared. A misled agent cannot sell for nothing.
 */
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
 * Your floor and the market's price impact, from a price asked of Jupiter directly, whatever the
 * intent says. Without `minOut`, the floor is Jupiter's price
 * less `maxBelowBps`; with one, it may be higher than that, never more than `MAX_BELOW_BPS` (or the
 * owner's `maxBelowBps`) below the market. The price impact is held to `maxPriceImpactBps`, itself at
 * most `MAX_PRICE_IMPACT_BPS` and the owner's own. `slippageBps` is the tolerance to build the route
 * at: the intent's, Jupiter's estimate on `"auto"`, or the owner's ceiling where Orientim's default is
 * above it; undefined leaves Orientim's default.
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
  });
  // The price is asked while the input's transfer fee is read: almost no token charges one, and one
  // that does is priced again for what reaches the route.
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

/** The intent with the tolerance `ownFloor` resolved: a number, or none for Orientim's default. */
export function withTolerance<T extends Intent | Omit<Intent, 'owner'>>(intent: T, slippageBps: number | undefined): T {
  const { slippageBps: _asked, ...rest } = intent;
  return (slippageBps !== undefined ? { ...rest, slippageBps } : rest) as T;
}

/** A prepared swap that passed the check, with the intent and limits it was checked against. */
/**
 * `tokenRisk`: what each token's issuer can do (a permanent delegate, a freeze or mint authority), or
 * `unavailable` when it could not be read; `notices` says the same in words (`tokenNotices`).
 */
export type Checked = { prepared: Prepared; intent: Intent; notices?: string[]; tokenRisk?: TokenRisk };

/**
 * Prepare and check: your own floor (asked of Jupiter when you set none), Orientim's answer, and the
 * full check on the exact bytes with chain state from your RPC. Throws on anything to refuse; sign
 * only the transaction this returns. A price that moved or a costlier route is not accepted
 * silently: Orientim's answer is an error that says so.
 */
export async function prepareChecked(args: {
  apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; owner: string; intent: Omit<Intent, 'owner'>;
  fetchImpl?: Fetch; jupiterApiKey?: string; requestTimeoutMs?: number;
  /** Optional diagnostics. Exceptions from this observer never change the signing decision. */
  onTiming?: (phase: TimedPhase | 'sign' | 'finalize', ms: number) => void;
  /** The owner's limits here: the ceilings on tolerance, floor and price impact, and whether a swap may go on without a price impact. */
  policy?: OwnerCeilings;
  /**
   * Routes from Jupiter with your own key (`jupiterApiKey`), which never leaves this process; on by
   * default with a key. false: Orientim builds with its own key, as without one.
   */
  ownRoutes?: boolean;
  /** The preparation's budget of Jupiter asks and time (110 s); a new one by default. */
  budget?: JupiterBudget;
}): Promise<Checked> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const owner = args.owner;
  // One budget for the whole preparation, from the agent's own quote to the last check before
  // signing: every ask of Jupiter counts against it, and no step runs past its time. What happens
  // after signing (finalize, the wait for an outcome) is not part of it.
  const budget = args.budget ?? preparationBudget();
  const within = (ms: number | undefined) => {
    const left = timeLeftOf(budget);
    if (left <= 0) throw outOfPreparationTime();
    return Math.max(1, Math.floor(Math.min(ms ?? 10_000, left)));
  };
  // Each step is timed from its own start to its own end: the agent's quote and the first round
  // run at the same time, and so do the check and the tokens' risk, so their times overlap and do
  // not add up. readyToSign is the whole wait, from the start to a transaction ready to sign. They
  // are reported in this order once the preparation ends, refused or not, with the steps that ran.
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
    // Settled early, so that a refusal the code below has not awaited yet is not left unhandled.
    floor.catch(() => undefined);
    // The tolerance as resolved: "auto" becomes Jupiter's estimate, and the check holds the route to it.
    const resolved = (o: Awaited<typeof floor>): Intent => withTolerance({ ...args.intent, owner, minOut: o.minOut }, o.slippageBps);
    const fieldsOf = (i: Intent) => ({ ...(i.minOut ? { minOut: i.minOut } : {}), ...(i.slippageBps !== undefined ? { slippageBps: i.slippageBps } : {}) });
    const body = {
      owner, inputMint: args.intent.inputMint, outputMint: args.intent.outputMint, amountIn: args.intent.amountIn,
      ...(args.intent.acceptCostBps ? { acceptCostBps: args.intent.acceptCostBps } : {}),
      ...(args.intent.routingMode === 'fast' ? { routingMode: 'fast' } : {}),
      ...(args.intent.version !== undefined ? { version: args.intent.version } : {}),
    };
    // With the agent's own routes, the first round only learns which routes to bring and needs no
    // minimum: it goes out while the agent asks Jupiter for its own price. Not with "auto", whose
    // tolerance, still unknown, names the routes.
    const parallel = !!args.jupiterApiKey && args.ownRoutes !== false && args.intent.slippageBps !== 'auto';
    // What the later rounds carry, settled early too: a refusal of the agent's own (its limits, its
    // price impact, Jupiter's) may come while the first round is still out, and must not be left
    // unhandled, which would end the agent's process.
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
      // The agent's own refusal (its floor, its price impact, its owner's limits) says more than
      // whatever Orientim answered meanwhile.
      await floor;
      throw e;
    }
    const own = await floor;
    const intent = resolved(own);
    // The route Orientim built moves the market no more than the limit either: a costlier route, once
    // approved, may move it more than the market's own best one did. Orientim's word can only refuse here.
    const routeImpact = prepared.amounts?.priceImpactPct;
    if (typeof routeImpact === 'number' && Number.isFinite(routeImpact) && Math.round(routeImpact * 10_000) > own.maxPriceImpactBps) {
      throw new PriceImpactError(Math.round(routeImpact * 10_000), own.maxPriceImpactBps);
    }
    // A fee in SOL from the wallet: held to a price of your own, asked of Jupiter here.
    await holdSolFee(intent, prepared, { fetchImpl, jupiterApiKey: args.jupiterApiKey, budget });
    // The check and the tokens' risk are read from your RPC at the same time: neither needs the other.
    const riskRead = timeOf('tokenRisk', tokenRisk(args.rpc, [intent.inputMint, intent.outputMint], within(args.requestTimeoutMs ?? 10_000)));
    riskRead.catch(() => undefined);
    const problems = await timeOf('localVerification', checkPrepared(prepared, intent, args.rpc, { requestTimeoutMs: within(args.requestTimeoutMs), slippageCeilingBps: args.policy?.maxSlippageBps }));
    if (problems.length) {
      const refused = new Error(`Not signing: ${problems.join('; ')}`);
      // Your RPC did not answer: nothing is wrong with the transaction, and the check may run again.
      if (problems.every(isRpcFailure)) refused.name = 'RpcUnavailableError';
      throw refused;
    }
    const risk = await riskRead;
    // Checked to the end within its time, or not signed: a check that ran past it is not taken.
    if (timeLeftOf(budget) <= 0) throw outOfPreparationTime();
    durations.set('readyToSign', performance.now() - started);
    return { prepared: preparedData(prepared), intent, notices: noticesOf(risk), tokenRisk: risk };
  } finally {
    report();
  }
}

/**
 * A checked answer as it travels on: only the fields the skill reads, and only their data, never
 * prose a server slipped into them. The transaction itself was decoded and checked, so it is kept
 * whole whatever its length (a v1 transaction may run past `dataOnly`'s longest string).
 */
export function preparedData(prepared: Prepared): Prepared {
  const known: Record<string, unknown> = {};
  for (const k of PREPARED_FIELDS) if (Object.hasOwn(prepared, k)) known[k] = (prepared as Record<string, unknown>)[k];
  // Inside amounts and costs too, only the fields the skill knows: nothing else the server adds.
  const only = (value: unknown, fields: readonly string[]) => {
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(fields.filter(k => Object.hasOwn(value, k)).map(k => [k, (value as Record<string, unknown>)[k]]));
  };
  if (Object.hasOwn(known, 'amounts')) known.amounts = only(known.amounts, AMOUNT_FIELDS);
  if (Object.hasOwn(known, 'costs')) known.costs = only(known.costs, COST_FIELDS);
  // The fields the skill shows but never checks keep their exact shape or go: a string with no
  // spaces is still words to a model, so none of them may carry text of the server's choosing.
  for (const [field, shape] of Object.entries(SHOWN_SHAPES)) {
    if (Object.hasOwn(known, field) && !shape(known[field])) delete known[field];
  }
  const costs = known.costs as Record<string, unknown> | undefined;
  if (costs && typeof costs === 'object') {
    if (Object.hasOwn(costs, 'breakdown') && !breakdownShape(costs.breakdown)) delete costs.breakdown;
    if (Object.hasOwn(costs, 'tokenTax') && !tokenTaxShape(costs.tokenTax)) delete costs.tokenTax;
  }
  return { ...(dataOnly(known) as Prepared), transaction: prepared.transaction };
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exactly = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const digitsOf = (v: unknown) => typeof v === 'string' && DIGITS.test(v);
const partShape = (v: unknown) => plain(v) && exactly(v, ['mint', 'amount']) && typeof v.mint === 'string' && BASE58.test(v.mint) && digitsOf(v.amount);
const ISSUER_POWERS = ['freezeAuthority', 'mintAuthority', 'permanentDelegate'] as const;
const powersShape = (v: unknown) => plain(v) && exactly(v, ISSUER_POWERS) && Object.values(v).every(x => typeof x === 'boolean');
/** costs.breakdown: amounts and mints, nothing else. */
const breakdownShape = (v: unknown) => plain(v)
  && exactly(v, ['principal', 'orientimFee', 'networkFeeLamports', 'rentReturnedLamports', 'rentKeptLamports'])
  && (v.principal === undefined || partShape(v.principal)) && (v.orientimFee === undefined || partShape(v.orientimFee))
  && ['networkFeeLamports', 'rentReturnedLamports', 'rentKeptLamports'].every(k => v[k] === undefined || digitsOf(v[k]));
/** costs.tokenTax: null, or the input's transfer fee in bps and what it adds. */
const tokenTaxShape = (v: unknown) => v === null
  || (plain(v) && exactly(v, ['inputBps', 'extraOnInput']) && Number.isInteger(v.inputBps) && (v.inputBps as number) >= 0
    && (v.inputBps as number) <= 10_000 && digitsOf(v.extraOnInput));
const SHOWN_SHAPES: Readonly<Record<string, (v: unknown) => boolean>> = {
  notices: v => plain(v) && Object.keys(v).length <= 8
    && Object.entries(v).every(([k, x]) => /^[a-z][A-Za-z]{0,31}$/.test(k) && typeof x === 'boolean'),
  tokens: v => plain(v) && exactly(v, ['input', 'output']) && Object.values(v).every(powersShape),
  // Jupiter's names for the markets the route crosses: short names, never sentences.
  route: v => Array.isArray(v) && v.length <= 8 && v.every(x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9 .+()-]{0,31}$/.test(x)),
  // The tolerance the route was built at: a whole number of bps, nothing else.
  slippageBps: v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000,
};

/**
 * Orientim's fee when it is paid in SOL from the wallet, held to a price of your own: always the
 * limit `ownSolFeeLimit` asks Jupiter for (0.3% of what the amount is worth in SOL, and 2%), or a
 * lower one the intent sets. An intent cannot raise it: a limit it names above that price is
 * lowered to it, and one that is not a whole number of lamports is refused. Sets
 * `intent.maxSolFeeLamports`; nothing for a fee paid in either token.
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
 * What actually arrived in the wallet, read from the confirmed transaction on your RPC, in base units
 * of the output; null when it cannot be read. For SOL, what the wallet gained, with the network fee
 * and the market's account fee (less its refund) added back, since neither is swap output. Never fails.
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
          // The route's rent, from the policy the verifier held the bytes to, never from the answer's costs.
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
      // Not readable yet, or the RPC failed: asked again below.
    }
    await wait(opts.pollMs ?? 500);
  }
  return null;
}

/**
 * What arrived against the quote, net of a fee taken from the output: better, or well below the
 * quote, and whether that is within `tolerance` (such as `1%`). Empty otherwise.
 */
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
  /** Send the swap your own way (`SendTransaction`); Orientim then signs and sends nothing. */
  sendTransaction?: SendTransaction;
  /**
   * Called before finalize with what to keep (see `Signed`). Unattended, persist it durably here
   * (`createFileStore`): if this throws, nothing is finalized.
   */
  onSigned?: (signed: Signed) => void | Promise<void>;
  /** How long to wait for an outcome, in ms; `unknown` after that (default 3 minutes). */
  maxWaitMs?: number;
  /** How long one call to Orientim or to your RPC may take, in ms (default 30 s and 10 s). */
  requestTimeoutMs?: number;
  /** An RPC with the full history, that the owner names: a second proof of expiry (`confirm`). */
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
  // The transaction's id is your wallet's signature, known from bytes you signed yourself.
  const signature = getSignatureFromTransaction(mine);
  const height = BigInt(await args.rpc.getBlockHeight({ commitment: 'confirmed' }).send({ abortSignal: AbortSignal.timeout(args.requestTimeoutMs ?? 10_000) }));
  const stated = BigInt(prepared.lastValidBlockHeight);
  if (stated - height < MIN_BLOCKS_TO_FINALIZE) {
    throw new Error(`Not finalizing: only ${stated - height} blocks are left before this swap expires, too few to land. This call sent nothing; prepare it again (a swap an earlier call finalized is settled with resumeSigned or recoverPending, not here).`);
  }
  // The stated lifetime ends further past your RPC's height than a blockhash lives, with the margin:
  // your RPC trails the network by more than LAG_BLOCKS (the last block kept below would come too
  // early, and a swap that can still land could be taken for expired), or the answer overstates it.
  if (stated - height > 150n + LAG_BLOCKS) {
    throw new Error(`Not finalizing: the transaction's stated lifetime ends ${stated - height} blocks past your RPC's height, more blocks than any blockhash lives (150, and ${LAG_BLOCKS} of margin). Your RPC trails the network, or the answer overstates the lifetime. This call sent nothing; use an RPC that keeps up, then prepare again.`);
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

/** Jupiter's swap program: its own error 6001 is the slippage limit being exceeded. */
const JUPITER_SWAP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const ERROR_NAME = /^[A-Za-z]{3,40}$/;

/**
 * The simulation's error behind a refusal by the network's own check, in words, or undefined when
 * it is not one of the shapes a simulation gives. The error came from Orientim, so it is read only
 * as those shapes and the program it names is taken from the transaction you signed, never from
 * the answer. `failureCause` reads the error of a transaction that landed and failed the same way.
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

/**
 * Why a transaction that landed failed, in words, from the error your RPC gave with its status, or
 * undefined when it is not a shape the chain gives. Read as `networkCause` reads a simulation's.
 */
export function failureCause(err: unknown, transaction: Transaction): string | undefined {
  try {
    const raw = JSON.stringify(err, (_, v) => typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= 0n ? Number(v) : undefined) : v);
    return typeof raw === 'string' ? networkCause(raw, transaction) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finalize asked for a kept swap, then its outcome read on your RPC. Asked once more when no answer
 * came back, or none that reads (the same bytes can land only once). A refusal (4xx) is not asked
 * again: it says this request sent nothing, and the chain says the rest.
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
      // With a sender of your own, Orientim signs and sends nothing (send: false): yours sends it.
      done = await call<Finalized>(fetchImpl, `${args.apiUrl}/api/v1/finalize`, args.apiKey, {
        ticket: signed.ticket, signedTransaction: signed.signedTransaction, ...(args.sendTransaction ? { send: false } : {}),
      }, args.requestTimeoutMs);
    } catch (e) {
      if (e instanceof OrientimApiError && e.status < 500) refused = e;
      else if (attempt === 0) await wait(args.pollMs ?? 1_000);
    }
  }
  // Bytes from the server are re-broadcast only when they are this very transaction, signed by E.
  const bytes = done?.signedTransaction && await isThisTransaction(done.signedTransaction, mine, temporaryAuthority)
    ? done.signedTransaction : undefined;
  let chainError: unknown;
  const outcome = await confirm(args.rpc, signature, signed.lastValidBlockHeight, {
    signedTransaction: bytes, pollMs: args.pollMs, maxWaitMs: args.maxWaitMs, requestTimeoutMs: args.requestTimeoutMs, earliestHeight: signed.signedHeight,
    archive: args.archive, temporaryAuthority, ...(args.sendTransaction ? { send: args.sendTransaction } : {}),
    onFailed: err => { chainError = err; },
  });
  // Kept or not, the caller decides what to do with a pending record: an unknown outcome stays pending.
  const refusal = refused ? refused.code : done?.status === 'rejected' ? safeCode(done.refusal ?? 'network') : undefined;
  const cause = outcome === 'failed' ? failureCause(chainError, mine)
    : refusal === 'network' && done?.transactionError ? networkCause(done.transactionError, mine) : undefined;
  // Refused by Orientim, and the chain shows it can no longer land: that refusal is what happened.
  if (outcome === 'expired' && refusal) return { signature, outcome: 'rejected', refusal, ...(cause ? { cause } : {}) };
  return { signature, outcome, ...(refusal ? { refusal } : {}), ...(cause ? { cause } : {}) };
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
  fetchImpl?: Fetch; pollMs?: number; maxWaitMs?: number; requestTimeoutMs?: number; archive?: Rpc<SolanaRpcApi>;
  sendTransaction?: SendTransaction;
}): Promise<{ signature: string; outcome: Outcome | 'rejected'; refusal?: string; cause?: string }> {
  const mine = getTransactionDecoder().decode(Buffer.from(args.signed.signedTransaction, 'base64'));
  if (getSignatureFromTransaction(mine) !== args.signed.signature) throw new Error('The kept record does not carry its own transaction. Nothing was sent.');
  return askAndConfirm(args, args.signed, mine, temporaryAuthorityOf(args.signed.signedTransaction) ?? '');
}

/**
 * The whole flow: `prepareChecked`, the wallet's signature, `finalizeSigned`. See those for what
 * each step refuses and what each outcome means.
 */
export async function protectedSwap(args: {
  apiUrl: string; apiKey: string; rpc: Rpc<SolanaRpcApi>; wallet: WalletSigner; intent: Omit<Intent, 'owner'>;
  fetchImpl?: Fetch; pollMs?: number; jupiterApiKey?: string;
  /** Routes from Jupiter with `jupiterApiKey` (default with a key); false: Orientim builds with its own key. */
  ownRoutes?: boolean;
  /** Optional per-phase durations; never receives keys, mints or transaction bytes. */
  onTiming?: (phase: TimedPhase | 'sign' | 'finalize', ms: number) => void;
  /**
   * Called before finalize with what to keep (see `Signed`). Unattended, persist it durably here
   * (`createFileStore`): if this throws, nothing is finalized.
   */
  onSigned?: (signed: Signed) => void | Promise<void>;
  /** How long to wait for an outcome, in ms; `unknown` after that (default 3 minutes). */
  maxWaitMs?: number;
  /** How long one call to Orientim or to your RPC may take, in ms (default 30 s and 10 s). */
  requestTimeoutMs?: number;
  /** An RPC with the full history, that the owner names: a second proof of expiry (`confirm`). */
  archive?: Rpc<SolanaRpcApi>;
  /** Send the swap your own way (`SendTransaction`): Orientim signs it and sends nothing. */
  sendTransaction?: SendTransaction;
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
  /** Where every swap is recorded before it is kept, policy or not, for a daily limit to count. */
  spends?: SpendLog;
}): Promise<{
  signature: string; outcome: Outcome | 'rejected'; prepared: Prepared; refusal?: string; cause?: string; bookkeepingError?: string;
  /** Notes about the tokens (`tokenNotices`), for whoever decides what to buy. */
  notices: string[];
  /** What each token's issuer can do, or `unavailable` (`tokenRisk`). */
  tokenRisk?: TokenRisk;
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
  const spend = { owner, inputMint: args.intent.inputMint, outputMint: args.intent.outputMint, amountIn: args.intent.amountIn };
  if (args.policy) await checkPolicy(args.policy, spend, args.spends);
  const { prepared, notices = [], tokenRisk: risk } = await prepareChecked({ ...args, owner });
  const signStarted = performance.now();
  const signedTransaction = await signAsWallet(args.wallet, prepared.transaction);
  try { args.onTiming?.('sign', Math.round(performance.now() - signStarted)); } catch { /* diagnostics only */ }
  const finalizeStarted = performance.now();
  const result = await finalizeSigned({
    ...args, prepared, signedTransaction,
    // Taken before finalize: the order, atomically when it is new, and the wallet's one pending
    // swap, checked again after it is kept so that two runs racing each other both stand down rather
    // than both send. A process that stops here finds it pending on its next start.
    onSigned: async signed => {
      const kept: Signed = { ...signed, ...(id ? { intentId: id } : {}) };
      // Counted again with what the last 24 hours spent, and recorded before the swap is kept: once
      // kept it may be sent, so it counts whatever its outcome. Every swap is recorded, with a policy
      // or without: a daily limit set later counts the wallet's swaps of the last 24 hours, all of them.
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
        // Refused before it was kept: never sent, so it does not count against the day.
        if (counted) await args.spends?.forgetSpend?.(signed.signature).catch(() => undefined);
        throw e;
      }
      await args.onSigned?.(kept);
    },
  });
  try { args.onTiming?.('finalize', Math.round(performance.now() - finalizeStarted)); } catch { /* diagnostics only */ }
  // What arrived, read from the chain once the swap confirmed: never a reason to fail.
  const got = result.outcome === 'confirmed'
    ? await receivedFor(args.rpc, result.signature, prepared, { requestTimeoutMs: args.requestTimeoutMs, pollMs: args.pollMs })
    : null;
  const told = { ...result, notices, ...(risk ? { tokenRisk: risk } : {}), ...(got !== null ? { received: got.toString() } : {}) };
  // What happened on the chain is the answer; a record that could not be updated is said beside it,
  // never in its place.
  try {
    if (orders) await settleOrder(orders, id!, { signature: result.signature, state: result.outcome === 'unknown' ? 'pending' : result.outcome });
    // The chain proves it moved nothing: its share of the day comes back.
    if (movedNothing(result.outcome)) await args.spends?.forgetSpend?.(result.signature);
    if (args.pending && result.outcome !== 'unknown') await args.pending.remove(result.signature);
  } catch (e) {
    return { ...told, bookkeepingError: e instanceof Error ? e.message : String(e) };
  }
  return told;
}
