import { address } from '@solana/kit';

export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');
export const JUPITER_PROGRAM = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

/** Native SOL is always handled as wrapped SOL (WSOL) inside the protected transaction. */
export const WSOL_MINT = address('So11111111111111111111111111111111111111112');
export const USDC_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const USDT_MINT = address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
/**
 * The tokens the Orientim fee is taken in first, on whichever side of the swap they are, the way
 * Jupiter takes its own: SOL, then USDC, then USDT. Otherwise the fee is in the input token when the
 * treasury has an account for it, and otherwise in SOL from the wallet at the swap's value (`sol`).
 * A swap whose fee cannot be collected is refused (`fee-unavailable`); only a test deployment,
 * without a treasury, is fee-free.
 */
export const FEE_TOKENS: readonly string[] = [WSOL_MINT, USDC_MINT, USDT_MINT];

export const LEGACY_SIZE_LIMIT = 1232;
export const V1_SIZE_LIMIT = 4096;
export const V1_MAX_ACCOUNTS = 64;
export const MAX_COMPUTE_UNITS = 1_400_000;
/**
 * Base fee per signature. A cluster parameter, not a constant of nature: if it ever changes, R4
 * would understate the fee. The pipeline also cross-checks with the RPC's getFeeForMessage.
 */
export const LAMPORTS_PER_SIGNATURE = 5000n;
export const TOKEN_ACCOUNT_SIZE = 165;
/**
 * A Token-2022 associated account: the base account, the account-type byte and an ImmutableOwner
 * extension header, which the ATA program always adds. Only its rent differs from a classic one.
 */
export const TOKEN_2022_ACCOUNT_SIZE = 170;
export const MINT_SIZE = 82;
/** Intermediate ATA(E, m) accounts a route may use. Real routes use 0 to 2. */
export const MAX_INTERMEDIATE_ACCOUNTS = 4;
export const BPS_DENOMINATOR = 10_000n;

// Ceilings the verifier enforces whatever the configuration says. The fee and
// F_max reach the browser from the deployment; these limits do not, so a compromised backend or a
// config bug cannot push past them.
export const MAX_FEE_BPS = 100n; // 1% ceiling; the current product fee is 0.25%
export const ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS = 1_000_000n; // 0.001 SOL
/**
 * The most W may send E for rent of an account the route opens in E's name. Both of Pump.fun's
 * markets open one per buyer (1,346,200 lamports in September 2026), and the bonding curve may add
 * 132,080 for growing the curve's own account. A route that needs more is refused; a route that
 * wants SOL to spend, not to rent with, cannot fit under it.
 */
export const MAX_TAKER_RENT_LAMPORTS = 5_000_000n; // 0.005 SOL
/**
 * The most of that rent the route may keep: what W sends E for rent, less what closing the market's
 * account returns in the same transaction. A Pump.fun bonding curve keeps 132,080 lamports for growing
 * its own account; anything else the route opens must be closed again. Without this bound, rent with
 * no refund could leave up to MAX_TAKER_RENT_LAMPORTS under a key only the server can derive.
 */
export const MAX_ROUTE_KEPT_LAMPORTS = 1_000_000n; // 0.001 SOL
/**
 * The most tolerance a Jupiter route may carry on chain. Jupiter's program stops the
 * swap when this instruction delivers less than its quoted amount less this tolerance, whatever the
 * destination held before, so it is a floor independent of the RPC. The verifier reads it from the
 * instruction: 0.5%, or 3% when the route trades on a Pump.fun bonding curve.
 */
export const MAX_ROUTE_SLIPPAGE_BPS = 50;
export const MAX_CURVE_SLIPPAGE_BPS = 300;
/**
 * The most tolerance an agent or its owner may choose (`slippageBps`): 15%. The agent API and the
 * skill's check ask the verifier for the number in the agent's own intent, never for more than this. Without a choice,
 * routes keep the two ceilings above.
 */
export const MAX_CHOSEN_SLIPPAGE_BPS = 1_500;
/** Pump.fun's bonding-curve program: a route through it is priced on the curve. */
export const PUMP_CURVE_PROGRAM = address('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
/** PumpSwap, the market a Pump.fun token moves to after its curve. */
export const PUMP_AMM_PROGRAM = address('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
/**
 * close_user_volume_accumulator, the same Anchor discriminator in both Pump programs' IDLs: closes
 * the account a Pump market opens for every buyer and returns its lamports to the buyer, who in a
 * Orientim swap is E. Accounts: [user (signer), account, event authority, program].
 */
export const CLOSE_USER_VOLUME_ACCUMULATOR = [249, 69, 164, 218, 150, 103, 84, 138] as const;
export const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;

/**
 * Rent-exempt minimum of a 165-byte token account before the 2026 rent reduction (now 1,488,440).
 * Only an upper bound for display when the RPC cannot answer: the live value comes from
 * getMinimumBalanceForRentExemption.
 */
export const TOKEN_ACCOUNT_RENT_UPPER_ORIENTIM_LAMPORTS = 2_039_280n;
