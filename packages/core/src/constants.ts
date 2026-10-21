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
 * Tokens the fee is taken in first, in order, on either side of the swap. Otherwise the fee is in the
 * input token, or in SOL from the wallet (`sol`); a swap whose fee cannot be collected is refused.
 */
export const FEE_TOKENS: readonly string[] = [WSOL_MINT, USDC_MINT, USDT_MINT];

export const LEGACY_SIZE_LIMIT = 1232;
export const V1_SIZE_LIMIT = 4096;
export const V1_MAX_ACCOUNTS = 64;
export const MAX_COMPUTE_UNITS = 1_400_000;
/** Base fee per signature; a cluster parameter that R4 assumes is unchanged. */
export const LAMPORTS_PER_SIGNATURE = 5000n;
export const TOKEN_ACCOUNT_SIZE = 165;
/** Size of a Token-2022 associated token account, including the ImmutableOwner extension. */
export const TOKEN_2022_ACCOUNT_SIZE = 170;
export const MINT_SIZE = 82;
/** Maximum intermediate ATA(E, m) accounts a route may use. */
export const MAX_INTERMEDIATE_ACCOUNTS = 4;
export const BPS_DENOMINATOR = 10_000n;

// Ceilings enforced regardless of the policy, so a compromised server cannot exceed them.
export const MAX_FEE_BPS = 30n; // 0.3%.
export const ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS = 1_000_000n; // 0.001 SOL.
/** Maximum rent W may send E for an account the route opens, too little to fund a swap. */
export const MAX_TAKER_RENT_LAMPORTS = 5_000_000n; // 0.005 SOL.
/** Maximum rent the route may keep after refunds, so little SOL is stranded under E. */
export const MAX_ROUTE_KEPT_LAMPORTS = 1_000_000n; // 0.001 SOL.
/** Default maximum on-chain slippage of a Jupiter route. */
export const MAX_ROUTE_SLIPPAGE_BPS = 50;
/** Default maximum slippage of a route on a Pump.fun bonding curve. */
export const MAX_CURVE_SLIPPAGE_BPS = 300;
/** Maximum slippage a caller may choose (15%). */
export const MAX_CHOSEN_SLIPPAGE_BPS = 1_500;
/** Pump.fun bonding-curve program. */
export const PUMP_CURVE_PROGRAM = address('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
/** PumpSwap AMM program. */
export const PUMP_AMM_PROGRAM = address('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
/** Discriminator of Pump's close_user_volume_accumulator: [user (signer), account, event authority, program]. */
export const CLOSE_USER_VOLUME_ACCUMULATOR = [249, 69, 164, 218, 150, 103, 84, 138] as const;
export const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;

/** Upper bound on token account rent, for display when the RPC cannot answer. */
export const TOKEN_ACCOUNT_RENT_UPPER_BOUND_LAMPORTS = 2_039_280n;
