import { findAssociatedTokenPda } from '@solana-program/token';
import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import {
  BPS_DENOMINATOR, FEE_TOKENS, MAX_TAKER_RENT_LAMPORTS, PUMP_AMM_PROGRAM, PUMP_CURVE_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM, WSOL_MINT,
} from './constants.ts';
import type { OrientimConfig, FeeSide, Intent, Policy, Variant } from './types.ts';

/** Token amount of a classic SPL token account (offset 64), or 0 for a missing account. */
export function tokenAmountOf(data: Uint8Array | null | undefined): bigint {
  if (!data || data.length < 72) return 0n;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

/**
 * The size of a new associated token account for this mint, as the token program allocates it, so
 * the rent shown before signing is the rent that will be charged. A classic account is 165 bytes.
 * A Token-2022 one adds an account-type byte, the ImmutableOwner marker the ATA program always
 * sets, and one account-side extension for each mint extension that needs one: a transfer fee
 * withholds into the account (8 bytes), a transfer hook marks it (1), a non-transferable or
 * pausable mint flags it (0). Checked against mainnet in T12: PYUSD and USDG 187, CASH 175.
 */
export function tokenAccountSizeFor(program: Address, mintData: Uint8Array | null | undefined): number {
  if (program !== TOKEN_2022_PROGRAM) return TOKEN_ACCOUNT_SIZE;
  const ACCOUNT_SIDE: Record<number, number> = { 1: 8, 9: 0, 14: 1, 26: 0 };
  let size = TOKEN_ACCOUNT_SIZE + 1 + 4; // account type, then ImmutableOwner's empty entry
  if (mintData && mintData.length > TOKEN_ACCOUNT_SIZE && mintData[TOKEN_ACCOUNT_SIZE] === 1) {
    const view = new DataView(mintData.buffer, mintData.byteOffset, mintData.byteLength);
    for (let at = TOKEN_ACCOUNT_SIZE + 1; at + 4 <= mintData.length; ) {
      const type = view.getUint16(at, true);
      if (type === 0) break;
      if (ACCOUNT_SIDE[type] !== undefined) size += 4 + ACCOUNT_SIDE[type];
      at += 4 + view.getUint16(at + 2, true);
    }
  }
  // The token program never lets an account be the size of a multisig, which is 355 bytes; it
  // pads such an account by the width of one extension type.
  return size === 355 ? size + 2 : size;
}

export async function ataOf(owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
  return pda;
}

export function variantOf(inputMint: Address, outputMint: Address): Variant {
  if (outputMint === WSOL_MINT) return 'A';
  if (inputMint === WSOL_MINT) return 'B';
  return 'C';
}

export function feeFor(amountIn: bigint, config: Pick<OrientimConfig, 'feeBps' | 'treasury'>): bigint {
  return config.treasury ? (amountIn * config.feeBps) / BPS_DENOMINATOR : 0n;
}

/**
 * Which side of the swap the fee is taken from, the way Jupiter takes its own: SOL first, then USDC,
 * then USDT, on whichever side of the swap they are, when the treasury can receive them; otherwise
 * the input token, when it can; otherwise SOL from the wallet, when the swap could be priced in SOL
 * (`sol`); otherwise none. A memecoin sold for SOL pays in SOL, which the treasury can always
 * receive, where it could never hold an account for every new token; a swap between two such
 * tokens pays in SOL too, at its value.
 */
export function feeSideFor(
  inputMint: Address, outputMint: Address, canReceive: { input: boolean; output: boolean; sol?: boolean },
): FeeSide | null {
  for (const mint of FEE_TOKENS) {
    if (inputMint === mint && canReceive.input) return 'input';
    if (outputMint === mint && canReceive.output) return 'output';
  }
  if (canReceive.input) return 'input';
  // No token of the swap can carry it: the fee is paid in SOL from the wallet (see `Policy.feeSide`).
  return canReceive.sol ? 'sol' : null;
}

/** A fee on the output: `feeBps` of the minimum Orientim enforces, never of more than will surely arrive. */
export function outputFeeFor(minOut: bigint, feeBps: bigint): bigint {
  return (minOut * feeBps) / BPS_DENOMINATOR;
}

/** What the wallet keeps at least: the enforced minimum, less a fee taken from the output. */
export function minimumReceived(policy: Pick<Policy, 'minOut' | 'fee' | 'feeSide'>): bigint {
  return policy.feeSide === 'output' ? policy.minOut - policy.fee : policy.minOut;
}

/**
 * The least minimum a swap must enforce so that the wallet keeps `received` after a fee of `feeBps`
 * on the output. ceil(received × 10,000 / (10,000 − feeBps)) always suffices, but the fee rounds
 * down, so a unit less sometimes does too; the least is taken.
 */
export function minimumForReceived(received: bigint, feeBps: bigint): bigint {
  const keep = BPS_DENOMINATOR - feeBps;
  let gross = (received * BPS_DENOMINATOR + keep - 1n) / keep;
  // What the wallet keeps never falls as the minimum rises, so stepping down stops at the least.
  while (gross > 0n && gross - 1n - outputFeeFor(gross - 1n, feeBps) >= received) gross--;
  return gross;
}

export class PolicyError extends Error {}

/** The policy with the minimum output of the chosen route; a fee on the output follows it. */
export function withMinOut(policy: Policy, minOut: bigint): Policy {
  if (minOut <= 0n) throw new PolicyError('The route guarantees no minimum output');
  const fee = policy.feeSide === 'output' ? outputFeeFor(minOut, policy.feeBps) : policy.fee;
  return { ...policy, minOut, fee };
}

/** The policy with the rent the chosen route needs E to pay; see `Policy.takerRent`. */
export function withTakerRent(policy: Policy, takerRent: bigint): Policy {
  if (takerRent < 0n || takerRent > MAX_TAKER_RENT_LAMPORTS) throw new PolicyError('Route rent outside the allowed range');
  return { ...policy, takerRent };
}

const seed = (s: string) => new TextEncoder().encode(s);

/** The account a Pump market opens for a buyer: PDA["user_volume_accumulator", buyer] of that program. */
export async function routeAccountOf(program: Address, buyer: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: program, seeds: [seed('user_volume_accumulator'), getAddressEncoder().encode(buyer)] }))[0];
}

/** An Anchor program's event authority, PDA["__event_authority"], which its instructions pass to themselves. */
export async function eventAuthorityOf(program: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: program, seeds: [seed('__event_authority')] }))[0];
}

export type RouteRefund = { program: Address; account: Address; eventAuthority: Address; lamports: bigint };

/**
 * The policy with the route's account under E closed after the swap and `lamports` sent on to W,
 * or with none. Only Pump's two programs open such an account.
 */
export function withRouteRefund(policy: Policy, refund: RouteRefund | null): Policy {
  if (!refund) {
    return { ...policy, routeRefund: 0n, routeRefundProgram: null, accounts: { ...policy.accounts, routeAccount: null, routeEventAuthority: null } };
  }
  if (refund.program !== PUMP_CURVE_PROGRAM && refund.program !== PUMP_AMM_PROGRAM) throw new PolicyError('Only a Pump market opens an account Orientim closes');
  if (refund.lamports <= 0n || refund.lamports > MAX_TAKER_RENT_LAMPORTS) throw new PolicyError('Route refund outside the allowed range');
  return {
    ...policy, routeRefund: refund.lamports, routeRefundProgram: refund.program,
    accounts: { ...policy.accounts, routeAccount: refund.account, routeEventAuthority: refund.eventAuthority },
  };
}

/** Turns an intent into the exact policy the compiler builds and the verifier enforces (plan, section 1). */
export async function buildPolicy(args: {
  intent: Intent;
  ephemeral: Address;
  inputDecimals: number;
  outputDecimals: number;
  config: OrientimConfig;
  /** The token program that owns each mint, as read from the chain. Classic SPL by default. */
  inputTokenProgram?: Address;
  outputTokenProgram?: Address;
  /** Whether the input mint charges a Token-2022 transfer fee, as read from the chain. */
  inputTransferFee?: boolean;
  /**
   * Whether ATA(treasury, inputMint) already exists on chain (and is not frozen). When the treasury
   * can receive the fee in neither token, the swap is fee-free: Orientim never makes the user pay rent
   * for Orientim's own account. Not read for SOL, which the treasury wallet receives.
   */
  feeAccountExists: boolean;
  /** The same for ATA(treasury, outputMint); only USDC and USDT are charged on the output as tokens. */
  outputFeeAccountExists?: boolean;
  /**
   * Whether the treasury wallet exists and can receive SOL. A transfer that would open it below the
   * rent minimum is refused by the runtime, so the fee is then taken in another token or not at all.
   * True by default.
   */
  treasuryWalletReady?: boolean;
  /** Minimum output Orientim enforces; usually set later from the chosen route (see `withMinOut`). */
  minOut?: bigint;
  /**
   * The fee in lamports when no token of the swap can carry it: `feeBps` of what the swap is worth
   * in SOL, priced by the caller. Without it (or at 0) such a swap is fee-free.
   */
  solFee?: bigint;
}): Promise<Policy> {
  const { intent, ephemeral, config } = args;
  if (intent.inputMint === intent.outputMint) throw new PolicyError('Input and output token are the same');
  if (intent.amountIn <= 0n) throw new PolicyError('Amount must be above zero');
  if (ephemeral === intent.owner) throw new PolicyError('The temporary key must differ from the wallet');

  const variant = variantOf(intent.inputMint, intent.outputMint);
  // Wrapped SOL is always a classic token, whatever the caller was told.
  const inProgram = intent.inputMint === WSOL_MINT ? TOKEN_PROGRAM : args.inputTokenProgram ?? TOKEN_PROGRAM;
  const outProgram = intent.outputMint === WSOL_MINT ? TOKEN_PROGRAM : args.outputTokenProgram ?? TOKEN_PROGRAM;
  // SOL goes to the treasury wallet itself, which needs no token account; a token needs one.
  const wallet = args.treasuryWalletReady ?? true;
  const feeSide = config.treasury
    ? feeSideFor(intent.inputMint, intent.outputMint, {
      input: intent.inputMint === WSOL_MINT ? wallet : args.feeAccountExists,
      output: intent.outputMint === WSOL_MINT ? wallet : args.outputFeeAccountExists ?? false,
      sol: wallet && (args.solFee ?? 0n) > 0n,
    })
    : null;
  const treasury = feeSide ? config.treasury : null;
  const minOut = args.minOut ?? 0n;
  const fee = feeSide === 'input' ? feeFor(intent.amountIn, { feeBps: config.feeBps, treasury })
    : feeSide === 'output' ? outputFeeFor(minOut, config.feeBps)
      : feeSide === 'sol' ? args.solFee! : 0n;
  const swapAmount = intent.amountIn - (feeSide === 'input' ? fee : 0n);
  if (swapAmount <= 0n) throw new PolicyError('Amount is too small to cover the fee');

  const feeMint = feeSide === 'input' ? intent.inputMint : feeSide === 'output' ? intent.outputMint : WSOL_MINT;
  const feeDestination = !feeSide ? null
    : feeMint === WSOL_MINT ? treasury : await ataOf(treasury!, feeMint, feeSide === 'input' ? inProgram : outProgram);

  return {
    owner: intent.owner,
    ephemeral,
    inputMint: intent.inputMint,
    outputMint: intent.outputMint,
    inputTokenProgram: inProgram,
    outputTokenProgram: outProgram,
    inputTransferFee: args.inputTransferFee ?? false,
    inputDecimals: args.inputDecimals,
    outputDecimals: args.outputDecimals,
    minOut,
    takerRent: 0n,
    routeRefund: 0n,
    routeRefundProgram: null,
    amountIn: intent.amountIn,
    feeBps: config.feeBps,
    feeSide,
    fee,
    swapAmount,
    treasury,
    maxNetworkFeeLamports: config.maxNetworkFeeLamports,
    jupiterProgram: config.jupiterProgram,
    variant,
    accounts: {
      eIn: await ataOf(ephemeral, intent.inputMint, inProgram),
      eOut: variant === 'A' ? await ataOf(ephemeral, WSOL_MINT) : null,
      wIn: variant === 'B' ? null : await ataOf(intent.owner, intent.inputMint, inProgram),
      wOut: variant === 'A' ? null : await ataOf(intent.owner, intent.outputMint, outProgram),
      feeDestination,
      routeAccount: null,
      routeEventAuthority: null,
    },
  };
}
