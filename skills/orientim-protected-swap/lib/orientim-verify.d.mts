// Types for orientim-verify.mjs, the bundled agent verifier (source: ../src/verify.ts).
import type { Rpc, SolanaRpcApi } from '@solana/kit';

/**
 * Orientim's treasury wallet, pinned like the fee: unless the agent names another, Orientim's fee may go
 * here or nowhere, whatever the server says.
 */
export declare const ORIENTIM_TREASURY: 'ARzSA3sZGhf5t4UnYrmB3TWyZ5m3Wo1nA9zWBcoiTqLE';

/** The tolerance an agent may choose for its route: 0.1% to 15%, as on the page. */
export declare const MIN_SLIPPAGE_BPS: 10;
export declare const MAX_SLIPPAGE_BPS: 1500;
/** Above this price impact an agent refuses unless its owner allows more. */
export declare const DEFAULT_MAX_PRICE_IMPACT_BPS: 500;
/** Hard limits no intent can raise: the floor at most this far below Jupiter's price, bps. */
export declare const MAX_BELOW_BPS: 2000;
/** The most price impact any intent may accept, bps. */
export declare const MAX_PRICE_IMPACT_BPS: 2000;
/** Orientim's fee is never accepted above this, bps. */
export declare const MAX_FEE_BPS: 30;
/** The fee limit the check applies: the agent's own, never above MAX_FEE_BPS. */
export declare function feeLimitBps(maxFeeBps?: number): number;
export function isSlippageBps(v: unknown): v is number;

/** What the agent asked for, and the most it accepts. */
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
   * The tolerance the agent chose for its route, in bps (10 to 1500): the route may carry that much
   * and no more. Unset: 0.5%, or 3% on a Pump.fun bonding curve. From the agent's own intent only.
   */
  slippageBps?: number;
  /**
   * The most rent the route may keep, in lamports: what the wallet sends for a market's account,
   * less what closing it returns in the same transaction (default 0.001 SOL). A Pump.fun bonding
   * curve keeps about 0.00013 SOL of every buy for growing its own account.
   */
  maxRouteCostLamports?: number;
  /**
   * The most Orientim's fee may be in lamports when it is paid in SOL from the wallet (a swap between
   * two tokens neither of which can carry it). Required for such a swap; `ownSolFeeLimit` asks
   * Jupiter for it.
   */
  maxSolFeeLamports?: number;
  /**
   * One ceiling for all the SOL the swap may cost and not return, in lamports (optional): the network
   * fee the transaction can pay, rent the route keeps, and Orientim's fee when paid in SOL. A new output
   * account's rent is not in it: that account stays the wallet's own.
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
 * Runs Orientim's full verifier on the prepared transaction, with chain state read from `rpc` (the
 * agent's own RPC) and the policy held to `limits`, then simulates it there: nothing may stay under
 * the one-time key, in its own account or in a Pump.fun market's account in its name, and no account
 * the route opens may stay open. Returns the problems found; sign only when empty.
 */
export function verifyPrepared(prepared: PreparedSwap, limits: AgentLimits, rpc: Rpc<SolanaRpcApi>, opts?: { requestTimeoutMs?: number }): Promise<string[]>;

export type OwnQuoteArgs = {
  inputMint: string; outputMint: string; amountIn: string; taker: string;
  maxFeeBps?: number; maxBelowBps?: number; jupiterUrl?: string; apiKey?: string; fetchImpl?: typeof fetch;
  /** The tolerance the agent chose: without `maxBelowBps`, the floor sits that far below the price, and 1.5% more (2% on a curve). */
  slippageBps?: number;
  /** The input token's transfer fee now (`inputTransferFee`): the route is priced for what arrives. */
  inputTax?: { bps: number; maximum: bigint } | null;
};

/**
 * A floor of the agent's own: Jupiter's price for the amount Orientim will route, asked for directly,
 * less `maxBelowBps` (default 2%, or 5% on a Pump.fun bonding curve; with `slippageBps`, that and
 * 1.5% more). In base units, as a string.
 */
export function ownMinimum(args: OwnQuoteArgs): Promise<string>;

/** Jupiter's price, asked for directly: the agent's own floor, the price impact in bps, and whether the route is a Pump.fun curve. */
export function ownQuote(args: OwnQuoteArgs): Promise<{ minOut: string; outAmount: string; priceImpactBps: number; curve: boolean }>;

/**
 * Notes about the tokens themselves, read from the mint accounts on the agent's RPC: an issuer that
 * can freeze balances, or mint more (none for SOL, USDC and USDT). Never fails.
 */
export function tokenNotices(rpc: Rpc<SolanaRpcApi>, mints: readonly string[], timeoutMs?: number): Promise<string[]>;

/**
 * The transfer fee a Token-2022 input token charges in the current epoch, read on your RPC; null
 * when it charges none.
 */
export function inputTransferFee(rpc: Rpc<SolanaRpcApi>, mint: string, timeoutMs?: number): Promise<{ bps: number; maximum: bigint } | null>;

/**
 * The most Orientim's fee in SOL may be, from a price the agent asks Jupiter for itself: `maxFeeBps`
 * (default 30) of what `amountIn` of the input is worth in SOL, plus 2% for the price moving. In
 * lamports.
 */
export function ownSolFeeLimit(args: {
  inputMint: string; amountIn: string; taker: string;
  maxFeeBps?: number; jupiterUrl?: string; apiKey?: string; fetchImpl?: typeof fetch;
}): Promise<number>;

/**
 * The transactions of a node's last 300 rooted blocks, which it answers a status from before any
 * history or archive. "No record" proves nothing outside them.
 */
export declare const STATUS_CACHE_BLOCKS: 300n;

/**
 * Does one view of the chain prove that a transaction with no record in it never landed, and never
 * will? `coveredHeight`: a finalized height the answering node had reached; `reachHeight`: the highest
 * height it can have reached. The transaction can land in blocks `earliest` to `lastValid`.
 */
export function provesNeverLanded(
  view: { coveredHeight: bigint | null; reachHeight: bigint | null }, lastValid: bigint, earliest: bigint,
): boolean;

/** Has the window in which "no record" could prove anything about that transaction closed for good? */
export function pastProof(view: { coveredHeight: bigint | null }, earliest: bigint): boolean;
