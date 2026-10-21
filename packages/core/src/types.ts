import type { Address } from '@solana/kit';

/** Solana transaction version. */
export type TxVersion = 0 | 1;

/** A: SPL -> SOL, B: SOL -> SPL, C: SPL -> SPL. */
export type Variant = 'A' | 'B' | 'C';

/** The side the fee is taken from, or `sol` from the wallet. */
export type FeeSide = 'input' | 'output' | 'sol';

/** A request to swap `amountIn` of `inputMint` for `outputMint`. */
export type Intent = {
  owner: Address;
  inputMint: Address;
  outputMint: Address;
  /** Base units of the input token, fee included. */
  amountIn: bigint;
};

/** Deployment configuration. */
export type OrientimConfig = {
  /** Fee in bps; 25n is 0.25%. */
  feeBps: bigint;
  /** Fee recipient wallet; null disables the fee (test mode). */
  treasury: Address | null;
  /** Upper bound on base and priority fees paid by W. */
  maxNetworkFeeLamports: bigint;
  jupiterProgram: Address;
};

/** Accounts the policy names, each re-derived by the verifier. */
export type PolicyAccounts = {
  /** ATA(E, inputMint): the only account the swap may spend from. */
  eIn: Address;
  /** ATA(E, WSOL) when the output is SOL (variant A). */
  eOut: Address | null;
  /** ATA(W, inputMint) when the input is SPL. */
  wIn: Address | null;
  /** ATA(W, outputMint) when the output is SPL. */
  wOut: Address | null;
  /** The treasury wallet for SOL fees, otherwise its token account; null when fee-free. */
  feeDestination: Address | null;
  /** The Pump route account opened for E and its program's event authority, when closed after the swap. */
  routeAccount: Address | null;
  routeEventAuthority: Address | null;
};

/** The exact swap a transaction must carry out: what the verifier enforces. */
export type Policy = {
  owner: Address;
  ephemeral: Address;
  inputMint: Address;
  outputMint: Address;
  /** Token program of each mint, read from the chain. */
  inputTokenProgram: Address;
  outputTokenProgram: Address;
  /** Whether the input mint charges a transfer fee, so E_in is harvested before close. */
  inputTransferFee: boolean;
  inputDecimals: number;
  outputDecimals: number;
  /** Minimum output enforced after the swap, in base units; the verifier rejects 0. */
  minOut: bigint;
  /** Lamports W sends E for rent of a route account; reachable by the route beyond the approved amount. */
  takerRent: bigint;
  /** Lamports returned to W when the route account is closed after the swap. */
  routeRefund: bigint;
  /** The Pump program that owns the route account. */
  routeRefundProgram: Address | null;
  amountIn: bigint;
  feeBps: bigint;
  /**
   * `input`: `feeBps` of `amountIn` before the swap. `output`: `feeBps` of `minOut` after the check.
   * `sol`: SOL from the wallet at a caller-supplied price the verifier cannot check. Null when fee-free.
   */
  feeSide: FeeSide | null;
  /** In base units of the `feeSide` token, or lamports for SOL. */
  fee: bigint;
  /** `amountIn` less any input fee. */
  swapAmount: bigint;
  /** Null when fee-free. */
  treasury: Address | null;
  maxNetworkFeeLamports: bigint;
  jupiterProgram: Address;
  variant: Variant;
  accounts: PolicyAccounts;
};

/** An intermediate token account of E; `transferFee` accounts are harvested before close. */
export type IntermediateAta = { ata: Address; mint: Address; tokenProgram: Address; transferFee?: boolean };

/** An account as read from the chain. */
export type AccountState = { owner: Address; lamports: bigint; data: Uint8Array };

/** Chain state for `verify`, fetched beforehand; a missing or null entry means no account. */
export type ChainSnapshot = {
  accounts: ReadonlyMap<string, AccountState | null>;
  /** The slot the accounts were read at. */
  slot?: bigint;
  /** Lookup table contents read from the RPC, never from Jupiter. */
  lookupTables: Readonly<Record<string, readonly Address[]>>;
};

/** A verifier rule. */
export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7';
/** A failed rule and why. */
export type Violation = { rule: RuleId; detail: string };
/** The verifier's result; `networkFeeLamports` is the maximum network fee, when R4 was reached. */
export type Verdict = { ok: boolean; violations: Violation[]; networkFeeLamports?: bigint };
