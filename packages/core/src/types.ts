import type { Address } from '@solana/kit';

export type TxVersion = 0 | 1;

/** A: SPL -> SOL, B: SOL -> SPL, C: SPL -> SPL (plan, section 5). */
export type Variant = 'A' | 'B' | 'C';

/** Which side of the swap the Orientim fee is taken from, or `sol` from the wallet; see `Policy.feeSide`. */
export type FeeSide = 'input' | 'output' | 'sol';

/** What the user asked for: "swap `amountIn` of `inputMint` for `outputMint`". */
export type Intent = {
  owner: Address;
  inputMint: Address;
  outputMint: Address;
  /** q, in base units of the input token. The Orientim fee is taken inside it. */
  amountIn: bigint;
};

export type OrientimConfig = {
  /** 25n = 0.25%, the product's fee. */
  feeBps: bigint;
  /** Fee recipient wallet. When null the fee is 0 (test mode). */
  treasury: Address | null;
  /** F_max: upper bound for base + priority fee paid by W. */
  maxNetworkFeeLamports: bigint;
  jupiterProgram: Address;
};

export type PolicyAccounts = {
  /** ATA(E, inputMint): the only account the swap may spend from. */
  eIn: Address;
  /** ATA(E, WSOL) when the output is SOL (variant A). */
  eOut: Address | null;
  /** ATA(W, inputMint) when the input is SPL. */
  wIn: Address | null;
  /** ATA(W, outputMint) when the output is SPL. */
  wOut: Address | null;
  /**
   * Where the fee goes: the treasury wallet when the fee is in SOL, otherwise the treasury's account
   * for the fee's token (the input token, or USDC or USDT on the output). Null when fee-free.
   */
  feeDestination: Address | null;
  /**
   * The account a Pump.fun market opens in E's name (PDA["user_volume_accumulator", E]) and that
   * program's event authority, when Orientim closes it after the swap; null otherwise.
   */
  routeAccount: Address | null;
  routeEventAuthority: Address | null;
};

export type Policy = {
  owner: Address;
  ephemeral: Address;
  inputMint: Address;
  outputMint: Address;
  /**
   * Which token program owns each mint: the classic one or Token-2022. Taken from the chain, never
   * from a token list, and re-derived by the verifier from the same snapshot.
   */
  inputTokenProgram: Address;
  outputTokenProgram: Address;
  /**
   * Whether the input mint charges a transfer fee. Such a fee is withheld in the receiving
   * account, and an account with withheld fees cannot be closed, so the cleanup harvests them to
   * the mint first. Read from the chain and re-derived by the verifier.
   */
  inputTransferFee: boolean;
  inputDecimals: number;
  outputDecimals: number;
  /**
   * The minimum output Orientim itself enforces after the swap, in base units of the
   * output token. Set from the chosen route's quoted floor; 0 until a route is chosen, and the
   * verifier rejects 0.
   */
  minOut: bigint;
  /**
   * Lamports W sends E before the swap, because the route opens an account in E's name and E holds
   * nothing (Pump's per-buyer account). Measured in simulation so that E spends all of it; 0 for
   * almost every route. The external program can reach this on top of the approved amount.
   */
  takerRent: bigint;
  /**
   * Lamports the route's account under E returns when Orientim closes it after the swap, sent on to W
   * in the same transaction: most of `takerRent` comes back. 0 when there is none.
   */
  routeRefund: bigint;
  /** The Pump program that owns that account; null when there is none. */
  routeRefundProgram: Address | null;
  amountIn: bigint;
  feeBps: bigint;
  /**
   * Which side the fee comes from, the way Jupiter takes its own: SOL first, then USDC and USDT, on
   * whichever side of the swap they are; otherwise the input token. On the input side the fee is
   * `feeBps` of `amountIn`, paid before the swap. On the output side it is `feeBps` of `minOut`,
   * paid after the minimum is checked, so the wallet keeps at least `minOut - fee`.
   *
   * `sol`: a pair that neither token can carry the fee for (no SOL, USDC or USDT on it, and no
   * treasury account for its input) pays it in SOL from the wallet, before the swap: `feeBps` of
   * what the swap is worth in SOL, priced by whoever built the policy when it was built. The
   * verifier cannot see a price, so this amount is checked against the agent's own price (the
   * skill), never taken on the builder's word.
   *
   * Null when the swap is fee-free: the treasury can receive nothing (test mode, no wallet yet), or
   * the swap could not be priced in SOL.
   */
  feeSide: FeeSide | null;
  /**
   * In base units of the token of `feeSide`: the input token, or the output token (lamports for
   * SOL); lamports for `sol`.
   */
  fee: bigint;
  /** What the route is given: `amountIn` less a fee on the input. */
  swapAmount: bigint;
  /** Null in test mode, and when the treasury can receive the fee in neither token. */
  treasury: Address | null;
  maxNetworkFeeLamports: bigint;
  jupiterProgram: Address;
  variant: Variant;
  accounts: PolicyAccounts;
};

/**
 * A token account owned by E that the route uses as an intermediate hop. `transferFee` says
 * whether its mint taxes transfers, in which case the withheld amount is harvested before the
 * account is closed, exactly as for E_in.
 */
export type IntermediateAta = { ata: Address; mint: Address; tokenProgram: Address; transferFee?: boolean };

export type AccountState = { owner: Address; lamports: bigint; data: Uint8Array };

/**
 * Everything the verifier needs from the chain, fetched beforehand so that `verify` itself makes
 * no network calls. A missing or null entry means the account does not exist.
 */
export type ChainSnapshot = {
  accounts: ReadonlyMap<string, AccountState | null>;
  /** The slot the accounts were read at, so a certificate can name the state it was checked against. */
  slot?: bigint;
  /** v0 only: lookup table contents as read from the RPC (never from Jupiter). */
  lookupTables: Readonly<Record<string, readonly Address[]>>;
};

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7';
export type Violation = { rule: RuleId; detail: string };
/**
 * `networkFeeLamports`: the most the transaction can pay in network fees (signatures and priority),
 * as R4 read it; absent when the check stopped before R4.
 */
export type Verdict = { ok: boolean; violations: Violation[]; networkFeeLamports?: bigint };
