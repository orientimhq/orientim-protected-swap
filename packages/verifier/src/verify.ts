import {
  decompileTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getCompiledTransactionMessageDecoder,
  getTransactionMessageComputeUnitLimit,
  getTransactionMessageLoadedAccountsDataSizeLimit,
  getTransactionMessagePriorityFeeLamports,
  getTransactionSize,
  isOffCurveAddress,
  TRANSACTION_CONFIG_COMPUTE_UNIT_LIMIT_BIT_MASK,
  TRANSACTION_CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT_MASK,
  TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK,
} from '@solana/kit';
import type { Address, Transaction } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS, BPS_DENOMINATOR, JUPITER_PROGRAM, LAMPORTS_PER_SIGNATURE, LEGACY_SIZE_LIMIT,
  MAX_CHOSEN_SLIPPAGE_BPS, MAX_COMPUTE_UNITS, MAX_CURVE_SLIPPAGE_BPS, MAX_ROUTE_KEPT_LAMPORTS, MAX_ROUTE_SLIPPAGE_BPS, MAX_TAKER_RENT_LAMPORTS, PUMP_AMM_PROGRAM, PUMP_CURVE_PROGRAM,
  FEE_TOKENS, MAX_FEE_BPS, MAX_INTERMEDIATE_ACCOUNTS, MAX_LOADED_ACCOUNTS_DATA_SIZE, MINT_SIZE, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM, V1_MAX_ACCOUNTS,
  V1_SIZE_LIMIT, WSOL_MINT,
} from '@orientim/core/constants';
import type { AccountState, ChainSnapshot, Policy, RuleId, Verdict, Violation } from '@orientim/core/types';
import { parseInstruction } from './parse.ts';
import type { Account, Parsed, RawInstruction } from './parse.ts';

// NOTE: this module must not import the compiler or the policy builder (plan, section 10):
// it re-derives every expectation itself so that a compiler bug cannot hide from it. Economic
// limits (fee, F_max) are checked against constants.ts, never only against the policy.
//
// WHY THE GUARANTEE HOLDS: the load-bearing rule is R6, not R1. R6 pins the
// signer set to exactly {W, E}, and R1 keeps W out of the external instruction, so W never signs
// there: every asset whose movement needs W's signature (SPL transfers, SOL, stake, closes,
// authorities) is out of reach even if its account were passed. R1's address filter only has to
// cover what moves WITHOUT W's signature: token accounts with a pre-existing delegate, and W_out,
// which is made safe by a trusted Revoke. Relaxing R1 or R6 requires re-reading this note.

const ata = async (owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];

const addressBytes = (a: Address) => getAddressEncoder().encode(a);
const seed = (s: string) => new TextEncoder().encode(s);
/** The account a Pump market opens for E, and the program's event authority, derived here, not read. */
export const routeAccountFor = async (program: Address, E: Address) =>
  (await getProgramDerivedAddress({ programAddress: program, seeds: [seed('user_volume_accumulator'), addressBytes(E)] }))[0];
const eventAuthorityFor = async (program: Address) =>
  (await getProgramDerivedAddress({ programAddress: program, seeds: [seed('__event_authority')] }))[0];

function isTokenAccountOwnedBy(state: AccountState, owner: Address): boolean {
  if (state.owner !== TOKEN_PROGRAM && state.owner !== TOKEN_2022_PROGRAM) return false;
  if (state.data.length < TOKEN_ACCOUNT_SIZE) return false;
  const want = addressBytes(owner);
  for (let i = 0; i < 32; i++) if (state.data[32 + i] !== want[i]) return false;
  return true;
}

const exists = (s: AccountState | null | undefined) => !!s && (s.lamports > 0n || s.data.length > 0);

const u32At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
const u64At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
/** Token balance of a token account in the snapshot; 0 when it does not exist yet. */
const tokenBalance = (s: AccountState | null | undefined) => (s && s.data.length >= 72 ? u64At(s.data, 64) : 0n);
/** The account's state byte at offset 108 of an SPL token account: 2 is frozen. */
const isFrozen = (s: AccountState | null | undefined) =>
  !!s && s.data.length >= TOKEN_ACCOUNT_SIZE && s.data[108] === 2;
/** COption<close_authority> tag at offset 129 of an SPL token account. */
const hasCloseAuthority = (s: AccountState | null | undefined) =>
  !!s && s.data.length >= TOKEN_ACCOUNT_SIZE && u32At(s.data, 129) === 1;

/**
 * Token-2022 mint extensions a protected swap can live with. Everything else is refused, including
 * any extension this list does not know: an extension changes what a transfer does, and what we
 * have not read, we do not allow.
 *
 * Left out on purpose: pausable and non-transferable (a third party can stop the swap),
 * interest-bearing and scaled UI amount (we would show a different number than the wallet),
 * memo-required (every incoming transfer would need one more instruction). Three more are allowed
 * only in a form that cannot act inside the transaction — transfer fee, permanent delegate and
 * default account state; see `unsupportedExtension`.
 */
const ALLOWED_MINT_EXTENSIONS = new Set([
  3, // MintCloseAuthority: usable only at zero supply
  4, // ConfidentialTransferMint: ordinary public transfers still work
  // ConfidentialTransferFee: the fee on confidential transfers only. A public transfer never
  // touches it, and the account-side amount it adds starts at zero and stays there.
  16,
  14, // TransferHook, but only with no program set - see below
  18, 19, // MetadataPointer, TokenMetadata
  20, 21, 22, 23, // Group and member pointers
]);

/**
 * The byte length each extension we interpret must declare. A length that disagrees with the
 * program's own layout means we are not reading what we think we are reading, so the mint is
 * refused rather than parsed further. Extensions of variable size - metadata and
 * the group ones - are not listed here.
 */
const EXTENSION_LENGTH: Record<number, number> = {
  1: 108, // TransferFeeConfig: two authorities, the withheld amount, two fee schedules
  3: 32, // MintCloseAuthority
  6: 1, // DefaultAccountState: the state new accounts start in
  12: 32, // PermanentDelegate
  14: 64, // TransferHook: authority and program id
  16: 129, // ConfidentialTransferFeeConfig: authority, ElGamal key, harvest flag, withheld ciphertext
  18: 64, // MetadataPointer: authority and address
  20: 64, // GroupPointer
  22: 64, // GroupMemberPointer
};

const EXTENSION_NAMES: Record<number, string> = {
  1: 'transfer fee', 6: 'accounts frozen by default', 8: 'memo required on transfer',
  9: 'non-transferable', 10: 'interest-bearing', 12: 'permanent delegate', 25: 'scaled UI amount',
  26: 'pausable',
  // Added to Token-2022 in 2025–2026. Refused like any extension not reviewed yet;
  // 24 and 28 do not act on public transfers and may be allowed after a review of their code.
  24: 'confidential mint and burn', 27: 'pausable accounts', 28: 'permissioned burn',
};

/**
 * The first extension that makes a Token-2022 mint unusable for a protected swap, or null. The
 * extension area starts after the account-type byte at offset 165 (a mint is padded to the size of
 * a token account first).
 */
/** A mint's transfer fee for the current epoch, or null when it charges none. */
export type TransferFee = { bps: number; maximum: bigint };

/**
 * Reads the TransferFeeConfig extension. Its value holds two authorities (32 bytes each), the
 * withheld amount, and then the older and newer fee, each `{ epoch: u64, maximum: u64, bps: u16 }`.
 * The newer one applies once its epoch has arrived, exactly as the token program decides it.
 */
export function transferFeeOf(data: Uint8Array, epoch: bigint): TransferFee | null {
  if (data.length <= TOKEN_ACCOUNT_SIZE || data[TOKEN_ACCOUNT_SIZE] !== 1) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = TOKEN_ACCOUNT_SIZE + 1; at + 4 <= data.length; ) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    const value = at + 4;
    if (type === 0) break;
    if (type === 1) {
      if (length < 108 || value + 108 > data.length) return null;
      const read = (from: number) => ({
        epoch: view.getBigUint64(from, true),
        maximum: view.getBigUint64(from + 8, true),
        bps: view.getUint16(from + 16, true),
      });
      const older = read(value + 72);
      const newer = read(value + 90);
      const active = epoch >= newer.epoch ? newer : older;
      return active.bps === 0 ? null : { bps: active.bps, maximum: active.maximum };
    }
    at = value + length;
  }
  return null;
}

/** What the token program withholds on a transfer of `amount`: rounded up, never above the cap. */
export function transferFeeOn(amount: bigint, fee: TransferFee): bigint {
  const raw = (amount * BigInt(fee.bps) + 9_999n) / 10_000n;
  return raw > fee.maximum ? fee.maximum : raw;
}

export function hasTransferFee(data: Uint8Array): boolean {
  if (data.length <= TOKEN_ACCOUNT_SIZE || data[TOKEN_ACCOUNT_SIZE] !== 1) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = TOKEN_ACCOUNT_SIZE + 1; at + 4 <= data.length; ) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (type === 0) break;
    if (type === 1) return true;
    at = at + 4 + length;
  }
  return false;
}

/**
 * `allowTransferFee` is set for swap and intermediate mints whose temporary accounts are harvested
 * before they are closed. Output accounts belong to the user and do not need to be closed.
 */
/** Does this mint have an issuer that can move or burn its balance anywhere (extension 12, set)? */
export function hasPermanentDelegate(data: Uint8Array): boolean {
  if (data.length <= TOKEN_ACCOUNT_SIZE || data[TOKEN_ACCOUNT_SIZE] !== 1) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = TOKEN_ACCOUNT_SIZE + 1; at + 4 <= data.length; ) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    const value = at + 4;
    if (type === 0) break;
    if (type === 12) return value + 32 <= data.length && data.subarray(value, value + 32).some(b => b !== 0);
    at = value + length;
  }
  return false;
}

const addressDecoder = getAddressDecoder();

export function unsupportedExtension(data: Uint8Array, options: { allowTransferFee?: boolean } = {}): string | null {
  if (data.length === MINT_SIZE) return null;
  if (data.length <= TOKEN_ACCOUNT_SIZE || data[TOKEN_ACCOUNT_SIZE] !== 1) return 'malformed extension area';
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nonZero = (from: number, to: number) => data.subarray(from, to).some(b => b !== 0);
  for (let at = TOKEN_ACCOUNT_SIZE + 1; ; ) {
    if (at === data.length) break; // the area ends exactly where the last extension does
    // Zeros to the end are padding, which the token program finds nothing in. Anything else after an
    // empty type is refused: the token program does not stop there, it steps over it two bytes at a
    // time and keeps reading, so an entry written after a gap would act on every transfer while this
    // loop never saw it.
    const padding = () => !nonZero(at, data.length);
    if (at + 4 > data.length) return padding() ? null : 'malformed extension area'; // a header cut in half
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    const value = at + 4;
    if (type === 0) return padding() ? null : 'malformed extension area';
    if (value + length > data.length) return 'malformed extension';
    const expected = EXTENSION_LENGTH[type];
    if (expected !== undefined && length !== expected) return `extension ${type} with a length of ${length}, not ${expected}`;
    // A declared hook with no program set runs no code at all, which is what the largest
    // Token-2022 tokens do; a real program is refused.
    if (type === 14) {
      if (length < 64 || nonZero(value + 32, value + 64)) return 'transfer hook';
    } else if (type === 1) {
      if (!options.allowTransferFee) return 'transfer fee';
    } else if (type === 12) {
      // A permanent delegate may move or burn any balance of this token in any account, without
      // the owner. A delegate off the ed25519 curve is a program-derived address, which its program
      // can sign for through invoke_signed, and that program could be a hop in the route: refused.
      // One on the curve is not thereby harmless (a Token-program multisig can have program-derived
      // signers, for instance), so this rule is not what protects the user. Inside the transaction
      // such a delegate can reach only the accounts of this mint the route was given: E's, which
      // are the route's anyway, and W_out, whose minimum-output check counts every token taken out
      // (SECURITY.md). What the issuer can do outside the transaction is the token's own nature:
      // it holds in every wallet, is disclosed to the user, and is not Orientim's to grant.
      if (nonZero(value, value + 32) && isOffCurveAddress(addressDecoder.decode(data.subarray(value, value + 32)))) {
        return 'permanent delegate controlled by a program';
      }
    } else if (type === 6) {
      // New accounts, Orientim's temporary ones included, start in this state. Frozen, they could never
      // receive the swap; initialized, the extension changes nothing a transfer does.
      if (data[value] !== 1) return 'accounts frozen by default';
    } else if (!ALLOWED_MINT_EXTENSIONS.has(type)) {
      return EXTENSION_NAMES[type] ?? `unknown extension ${type}`;
    }
    at = value + length;
  }
  return null;
}

/**
 * Does this token account require a memo before every incoming transfer (extension 8)? Such an
 * account would make the swap's own transfer fail, so the pipeline refuses it up front rather than
 * letting four route repairs discover it. Account extensions sit after the account-type byte, as
 * on a mint, but with AccountType::Account.
 */
export function memoRequired(data: Uint8Array): boolean {
  if (data.length <= TOKEN_ACCOUNT_SIZE || data[TOKEN_ACCOUNT_SIZE] !== 2) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = TOKEN_ACCOUNT_SIZE + 1; at + 4 <= data.length; ) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (type === 0) break;
    const value = at + 4;
    // MemoTransfer is a one-byte PodBool. The extension may remain present after the owner disables
    // it, so its presence alone does not mean incoming transfers require a memo. Malformed forms
    // fail closed: accepting one would let a supposedly supported output fail only after signing.
    if (type === 8) return length !== 1 || value >= data.length || data[value] !== 0;
    if (value + length > data.length) return true;
    at = value + length;
  }
  return false;
}

/**
 * The arguments of Jupiter's route instruction that decide what Jupiter enforces on chain. Its program stops the swap when this instruction's output is below `quotedOutAmount` less
 * `slippageBps`, whatever the destination held before: a second floor that does not depend on the
 * balance Orientim read from the RPC. Read here so that a forged answer cannot switch it off.
 *
 *   route_v2:                 [8 discriminator][in u64][quoted out u64][slippage u16][platform fee u16][positive slippage u16][route plan]
 *   shared_accounts_route_v2: the same after a one-byte id
 *
 * Read off /swap/v2/build answers on 23 September 2026 (the amounts and tolerance at these offsets
 * matched the JSON for 0.5% and 3% routes), and confirmed the same day against the program's own
 * IDL on chain (account C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa). Any other instruction of
 * Jupiter's is refused, so a change of format stops swaps rather than letting an unread one through.
 */
export type JupiterRouteArgs = {
  inAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  platformFeeBps: number;
  positiveSlippageBps: number;
  /** Where `slippageBps` sits in the instruction data, for a builder that tightens it. */
  slippageOffset: number;
};
const ROUTE_V2 = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];
const SHARED_ACCOUNTS_ROUTE_V2 = [0xd1, 0x98, 0x53, 0x93, 0x7c, 0xfe, 0xd8, 0xe9];

export function jupiterRouteArgs(data: ArrayLike<number>): JupiterRouteArgs | null {
  const d = Uint8Array.from(data);
  const starts = (disc: number[]) => d.length >= 8 && disc.every((b, i) => d[i] === b);
  const base = starts(ROUTE_V2) ? 8 : starts(SHARED_ACCOUNTS_ROUTE_V2) ? 9 : -1;
  // The fixed arguments, then at least the length of the route plan.
  if (base < 0 || d.length < base + 22 + 4) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    inAmount: v.getBigUint64(base, true),
    quotedOutAmount: v.getBigUint64(base + 8, true),
    slippageBps: v.getUint16(base + 16, true),
    platformFeeBps: v.getUint16(base + 18, true),
    positiveSlippageBps: v.getUint16(base + 20, true),
    slippageOffset: base + 16,
  };
}

/**
 * The least a Jupiter route lets through: its quote less its tolerance, rounded down. Jupiter's
 * program checks what its instruction delivered to the destination against this, so it holds
 * whatever else arrives in that account.
 */
export function jupiterFloor(args: Pick<JupiterRouteArgs, 'quotedOutAmount' | 'slippageBps'>): bigint {
  return (args.quotedOutAmount * BigInt(10_000 - args.slippageBps)) / 10_000n;
}

/**
 * The account Jupiter's route delivers to, which is the account its floor is measured on. From the program's IDL on chain:
 *
 *   route_v2:                 [0] authority, [1] source, [2] user destination, ..., [7] destination (optional)
 *   shared_accounts_route_v2: [0] program authority, [1] authority, [2] source, ..., [5] destination
 *
 * An optional account left out is passed as the program's own address, and route_v2 then delivers to
 * its user destination. Null for any other instruction, or too few accounts.
 */
export function jupiterDestination(data: ArrayLike<number>, accounts: readonly Address[]): Address | null {
  const d = Uint8Array.from(data);
  const starts = (disc: number[]) => d.length >= 8 && disc.every((b, i) => d[i] === b);
  if (starts(ROUTE_V2) && accounts.length >= 10) return accounts[7] === JUPITER_PROGRAM ? accounts[2] : accounts[7];
  if (starts(SHARED_ACCOUNTS_ROUTE_V2) && accounts.length >= 12) return accounts[5];
  return null;
}

const V1_ALLOWED_CONFIG =
  TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK |
  TRANSACTION_CONFIG_COMPUTE_UNIT_LIMIT_BIT_MASK |
  TRANSACTION_CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT_MASK;

type Slot =
  | 'cuLimit' | 'cuPrice' | 'createEIn' | 'createEOut' | 'createWOut' | 'revokeWOut'
  | 'createIntermediate' | 'transferIn' | 'feeTransfer' | 'takerRent' | 'sync' | 'minOutCheck' | 'harvestEIn' | 'harvestIntermediate'
  | 'closeEIn' | 'closeEOut'
  | 'closeIntermediate' | 'closeRouteAccount' | 'routeRefund';

const BEFORE_SWAP: Slot[] = [
  'createEIn', 'createEOut', 'createWOut', 'revokeWOut', 'createIntermediate', 'transferIn', 'takerRent', 'sync',
];
const AFTER_SWAP: Slot[] = [
  'minOutCheck', 'harvestEIn', 'harvestIntermediate', 'closeEIn', 'closeEOut', 'closeIntermediate', 'closeRouteAccount', 'routeRefund',
];
/** Orientim's own cleanup of E's token accounts, all of which must be done before the route's account is closed. */
const OWN_CLEANUP: Slot[] = ['minOutCheck', 'harvestEIn', 'harvestIntermediate', 'closeEIn', 'closeEOut', 'closeIntermediate'];

/**
 * The 7 rules (R1–R7), checked on the exact bytes the wallet will sign.
 * Pure: every chain fact comes from `snapshot`, fetched beforehand.
 */
export type VerifyOptions = {
  /**
   * The tolerance an agent chose in its own intent (`slippageBps`), in bps,
   * for a route of any kind; at most MAX_CHOSEN_SLIPPAGE_BPS (15%). Unset, a route may carry 0.5%, or
   * 3% on a Pump.fun bonding curve. It is always the caller's own choice, never Orientim's answer.
   */
  maxSlippageBps?: number;
};

export async function verify(transaction: Transaction, policy: Policy, snapshot: ChainSnapshot, opts: VerifyOptions = {}): Promise<Verdict> {
  const violations: Violation[] = [];
  const fail = (rule: RuleId, detail: string) => void violations.push({ rule, detail });
  const p = policy;
  const W = p.owner;
  const E = p.ephemeral;
  // The variant follows from the mints; the policy's label is checked, never trusted.
  const variant = p.outputMint === WSOL_MINT ? 'A' : p.inputMint === WSOL_MINT ? 'B' : 'C';
  if (p.variant !== variant) fail('R2', `policy variant ${p.variant} does not match the mints (${variant})`);
  const A = variant === 'A';
  const B = variant === 'B';

  // Which token program owns each mint is a fact of the chain, so it is read from the snapshot and
  // the policy is only checked against it. Wrapped SOL is always classic.
  const programOf = (mint: Address): Address | null => {
    const state = snapshot.accounts.get(mint);
    if (!state) return null;
    return state.owner === TOKEN_PROGRAM || state.owner === TOKEN_2022_PROGRAM ? state.owner : null;
  };
  const chainInput = programOf(p.inputMint);
  const chainOutput = programOf(p.outputMint);
  if (chainInput && chainInput !== p.inputTokenProgram) fail('R2', 'the input token program does not match the mint');
  if (chainOutput && chainOutput !== p.outputTokenProgram) fail('R2', 'the output token program does not match the mint');
  const inputProgram = chainInput ?? p.inputTokenProgram;
  const outputProgram = chainOutput ?? p.outputTokenProgram;
  const inputMintState = snapshot.accounts.get(p.inputMint);
  const inputFee = !!inputMintState && inputProgram === TOKEN_2022_PROGRAM && hasTransferFee(inputMintState.data);
  if (inputMintState && p.inputTransferFee !== inputFee) {
    fail('R2', `policy says the input mint ${p.inputTransferFee ? 'charges' : 'does not charge'} a transfer fee, the mint says otherwise`);
  }

  // Re-derive the policy's numbers and accounts instead of trusting them. The fee is taken on one
  // side (like Jupiter's: SOL first, then USDC and USDT, otherwise the input token): on the input,
  // feeBps of the amount, before the swap; on the output, feeBps of the enforced minimum, after it,
  // and only in SOL, USDC or USDT. A pair without SOL pays in SOL from the wallet instead (`sol`),
  // before the swap, at a price the verifier cannot see: that amount is the policy's own statement,
  // held to a price of the agent's own (the skill).
  if (p.feeSide !== null && p.feeSide !== 'input' && p.feeSide !== 'output' && p.feeSide !== 'sol') fail('R2', 'the policy names no fee side Orientim knows');
  if ((p.treasury === null) !== (p.feeSide === null)) fail('R2', 'the policy has a treasury without a fee side, or the other way round');
  if (p.feeSide === 'output' && !FEE_TOKENS.includes(p.outputMint)) fail('R2', 'a fee on the output is taken only in SOL, USDC or USDT');
  if (p.feeSide === 'sol' && (A || B)) fail('R2', 'a fee in SOL from the wallet is only for a swap with no SOL on either side');
  if (p.feeSide === 'sol' && p.fee < 0n) fail('R2', 'policy amounts are inconsistent');
  const expectedFee = !p.treasury ? 0n
    : p.feeSide === 'output' ? (p.minOut * p.feeBps) / BPS_DENOMINATOR
      : p.feeSide === 'sol' ? p.fee : (p.amountIn * p.feeBps) / BPS_DENOMINATOR;
  const feeOnInput = p.feeSide === 'input' ? p.fee : 0n;
  if (p.fee !== expectedFee || p.swapAmount + feeOnInput !== p.amountIn || p.swapAmount <= 0n) {
    fail('R2', 'policy amounts are inconsistent');
  }
  if (p.inputMint === p.outputMint) fail('R2', 'input and output token are the same');
  if (p.feeBps < 0n || p.feeBps > MAX_FEE_BPS) fail('R2', `fee of ${p.feeBps} bps is above the maximum of ${MAX_FEE_BPS}`);
  if (p.maxNetworkFeeLamports > ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS) {
    fail('R4', `configured network fee limit ${p.maxNetworkFeeLamports} is above the absolute maximum`);
  }
  if (p.minOut <= 0n) fail('R2', 'the policy has no minimum output');
  // Decimals come from the mints in the snapshot, not from token metadata.
  for (const [mint, decimals, side] of [[p.inputMint, p.inputDecimals, 'input'], [p.outputMint, p.outputDecimals, 'output']] as const) {
    const state = snapshot.accounts.get(mint);
    if (state && state.data.length >= MINT_SIZE && state.data[44] !== decimals) {
      fail('R2', `${side} decimals ${decimals} do not match the mint (${state.data[44]})`);
    }
  }
  // The account a Pump market opened in E's name, closed after the swap with its lamports sent on to
  // W. Only Pump's two programs, only in the amount the policy states, never above the
  // rent ceiling. Handing E's signature to Pump's program is safe only because, when it runs, E owns
  // no token account any more (checked below): it can reach the lamports it returns, nothing of W's.
  const refundProgram = p.routeRefundProgram;
  if (refundProgram !== null && refundProgram !== PUMP_CURVE_PROGRAM && refundProgram !== PUMP_AMM_PROGRAM) {
    fail('R2', `route refund from ${refundProgram}, which is not a Pump market`);
  }
  if ((p.routeRefund > 0n) !== (refundProgram !== null)) fail('R2', 'policy route refund and its program disagree');
  if (p.routeRefund < 0n || p.routeRefund > MAX_TAKER_RENT_LAMPORTS) {
    fail('R4', `route refund ${p.routeRefund} lamports is outside 0..${MAX_TAKER_RENT_LAMPORTS}`);
  }
  const refunds = refundProgram !== null && (refundProgram === PUMP_CURVE_PROGRAM || refundProgram === PUMP_AMM_PROGRAM);
  const expected = {
    routeAccount: refunds ? await routeAccountFor(refundProgram!, E) : null,
    routeEventAuthority: refunds ? await eventAuthorityFor(refundProgram!) : null,
    eIn: await ata(E, p.inputMint, inputProgram),
    eOut: A ? await ata(E, WSOL_MINT) : null,
    wIn: B ? null : await ata(W, p.inputMint, inputProgram),
    wOut: A ? null : await ata(W, p.outputMint, outputProgram),
    feeDestination: !p.treasury || !p.feeSide ? null
      : p.feeSide === 'sol' ? p.treasury
      : p.feeSide === 'input' ? (B ? p.treasury : await ata(p.treasury, p.inputMint, inputProgram))
      : A ? p.treasury : await ata(p.treasury, p.outputMint, outputProgram),
  };
  const acc = p.accounts;
  if (
    acc.eIn !== expected.eIn || acc.eOut !== expected.eOut || acc.wIn !== expected.wIn ||
    acc.wOut !== expected.wOut || acc.feeDestination !== expected.feeDestination
    || (acc.routeAccount ?? null) !== expected.routeAccount || (acc.routeEventAuthority ?? null) !== expected.routeEventAuthority
  ) {
    fail('R2', 'policy accounts do not match their derivation');
  }
  const { eIn, eOut, wIn, wOut, feeDestination } = expected;
  // Minimum-output check: a self-transfer on the account that receives the output.
  const minOut = A
    ? { account: eOut, authority: E, mint: WSOL_MINT, decimals: 9, amount: p.minOut, program: TOKEN_PROGRAM } // E_out is fresh (R3)
    : {
        account: wOut, authority: W, mint: p.outputMint, decimals: p.outputDecimals, program: outputProgram,
        amount: tokenBalance(snapshot.accounts.get(wOut!)) + p.minOut,
      };

  // Decode the exact message bytes. v0 lookups resolve only from the snapshot (read from the RPC).
  let compiled: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>;
  let msg: ReturnType<typeof decompileTransactionMessage>;
  try {
    compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    msg = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: snapshot.lookupTables as never });
  } catch (e) {
    fail('R1', `message accounts cannot be resolved: ${(e as Error).message}`);
    return { ok: false, violations };
  }
  // An index past the accounts the message loads decodes without an error but names no account;
  // such bytes are refused here, as a verdict, rather than failing later with an exception.
  const unnamed = (msg.instructions as readonly RawInstruction[]).some(ix =>
    typeof ix.programAddress !== 'string' || (ix.accounts ?? []).some(a => typeof a?.address !== 'string'));
  if (unnamed) {
    fail('R1', 'an instruction names an account the message does not load');
    return { ok: false, violations };
  }
  const version = compiled.version;
  if (version !== 0 && version !== 1) fail('R5', `unsupported transaction version ${String(version)}`);

  // R5: every account the message loads appears once. The runtime refuses a message that loads the
  // same address twice (statically and through a lookup table, say), but the rules compare resolved
  // addresses, so the verifier refuses it itself rather than leaning on the runtime.
  const loaded: string[] = [...compiled.staticAccounts];
  const lookups = (compiled as { addressTableLookups?: readonly { lookupTableAddress: string; writableIndexes: readonly number[]; readonlyIndexes: readonly number[] }[] }).addressTableLookups ?? [];
  for (const l of lookups) {
    const table = snapshot.lookupTables[l.lookupTableAddress] ?? [];
    for (const i of [...l.writableIndexes, ...l.readonlyIndexes]) loaded.push(table[i]);
  }
  if (loaded.some(a => typeof a !== 'string')) {
    fail('R1', 'a lookup names an account its table does not hold');
    return { ok: false, violations };
  }
  if (new Set(loaded).size !== loaded.length) fail('R5', 'the message loads the same account more than once');

  // R6: W pays, and the only signers are W and E.
  const numSigners = compiled.header.numSignerAccounts;
  const signers = compiled.staticAccounts.slice(0, numSigners);
  if (compiled.staticAccounts[0] !== W) fail('R6', 'the fee payer is not the wallet');
  if (!(signers.length === 2 && signers.includes(W) && signers.includes(E))) {
    fail('R6', `unexpected signers: ${signers.join(', ')}`);
  }

  const instructions = msg.instructions as readonly RawInstruction[];
  const parsed: Parsed[] = instructions.map(ix => parseInstruction(ix));
  parsed.forEach((x, i) => {
    if (x.kind === 'invalid') fail('R2', `instruction ${i}: ${x.reason}`);
  });

  // Exactly one untrusted instruction, and it is Jupiter.
  const externals = parsed.flatMap((x, i) => (x.kind === 'external' ? [{ x, i }] : []));
  if (externals.length !== 1) fail('R2', `expected 1 external instruction, found ${externals.length}`);
  for (const { x } of externals) {
    if (x.program !== p.jupiterProgram) fail('R2', `external program ${x.program} is not Jupiter`);
  }
  const swapIndex = externals.length ? externals[0].i : -1;

  // Jupiter's own floor, read from its instruction rather than trusted. Applied to
  // Jupiter's program only: tests that stand a hostile program in its place have no such format.
  for (const { x } of externals) {
    if (x.kind !== 'external' || x.program !== JUPITER_PROGRAM) continue;
    const args = jupiterRouteArgs(x.data);
    if (!args) {
      fail('R2', 'the Jupiter instruction is not a route Orientim can read (route_v2 or shared_accounts_route_v2)');
      continue;
    }
    const curve = x.accounts.some(a => a.address === PUMP_CURVE_PROGRAM);
    const chosen = opts.maxSlippageBps;
    const maxSlippage = chosen !== undefined && Number.isInteger(chosen) && chosen >= 0
      ? Math.min(chosen, MAX_CHOSEN_SLIPPAGE_BPS)
      : curve ? MAX_CURVE_SLIPPAGE_BPS : MAX_ROUTE_SLIPPAGE_BPS;
    if (args.platformFeeBps !== 0 || args.positiveSlippageBps !== 0) {
      fail('R2', `the Jupiter route takes a platform fee (${args.platformFeeBps} bps) or positive slippage (${args.positiveSlippageBps} bps)`);
    }
    if (args.slippageBps > maxSlippage) fail('R2', `the Jupiter route tolerates ${args.slippageBps} bps, above ${maxSlippage}`);
    // Jupiter's own floor covers the whole minimum, not only its quote: Orientim's check counts the
    // account's balance, which a deposit or another swap arriving at the same time also raises,
    // while Jupiter's counts only what this route delivered.
    const floor = jupiterFloor(args);
    if (floor < p.minOut) {
      fail('R2', `the Jupiter route's own floor is ${floor} (${args.quotedOutAmount} less ${args.slippageBps} bps), below the minimum output ${p.minOut}`);
    }
    if (args.inAmount <= 0n || args.inAmount > p.swapAmount) {
      fail('R2', `the Jupiter route spends ${args.inAmount}, outside the approved ${p.swapAmount}`);
    }
    // Jupiter's floor protects the user only if it is measured on the account the output must reach:
    // the wallet's own output account, or E's temporary one for SOL. Then the floor holds whatever
    // the RPC said that account held before.
    const destination = jupiterDestination(x.data, x.accounts.map(a => a.address));
    const expected = A ? eOut : wOut;
    if (destination !== expected) {
      fail('R2', `the Jupiter route delivers to ${destination ?? 'an unreadable account'}, not to ${A ? 'the temporary output account' : "the wallet's output account"}`);
    }
  }

  // Intermediate ATA(E, m) accounts: allowed only as matched create + close pairs.
  const intermediates = new Map<string, { tokenProgram: Address; mint: Address; created: number; closed: number; fee: boolean; harvested?: number }>();
  for (const x of parsed) {
    if (x.kind !== 'createAta' || x.owner !== E || x.ata === eIn || x.ata === eOut) continue;
    if (x.mint === p.inputMint || (A && x.mint === WSOL_MINT)) continue;
    if (x.ata === (await ata(E, x.mint, x.tokenProgram))) {
      const state = snapshot.accounts.get(x.mint);
      const fee = !!state && state.owner === TOKEN_2022_PROGRAM && hasTransferFee(state.data);
      intermediates.set(x.ata, { tokenProgram: x.tokenProgram, mint: x.mint, created: 0, closed: 0, fee });
    }
  }

  // R2: every trusted instruction must fill one expected slot, with the exact accounts and amounts.
  const slots = new Map<Slot, number[]>();
  const put = (s: Slot, i: number) => slots.set(s, [...(slots.get(s) ?? []), i]);
  for (const [i, x] of parsed.entries()) {
    switch (x.kind) {
      case 'cuLimit':
        if (version === 1) fail('R4', 'ComputeBudget instruction in a v1 transaction');
        else if (x.units > MAX_COMPUTE_UNITS) fail('R4', `compute unit limit ${x.units} above maximum`);
        else put('cuLimit', i);
        break;
      case 'cuPrice':
        if (version === 1) fail('R4', 'ComputeBudget instruction in a v1 transaction');
        else put('cuPrice', i);
        break;
      case 'createAta': {
        if (x.payer !== W) { fail('R2', `instruction ${i}: account creation not paid by the wallet`); break; }
        if (x.tokenProgram === inputProgram && x.owner === E && x.mint === p.inputMint && x.ata === eIn) put('createEIn', i);
        else if (A && x.tokenProgram === TOKEN_PROGRAM && x.owner === E && x.mint === WSOL_MINT && x.ata === eOut) put('createEOut', i);
        else if (!A && x.tokenProgram === outputProgram && x.owner === W && x.mint === p.outputMint && x.ata === wOut) put('createWOut', i);
        else if (intermediates.has(x.ata)) { intermediates.get(x.ata)!.created++; put('createIntermediate', i); }
        else fail('R2', `instruction ${i}: unexpected account creation for ${x.owner}`);
        break;
      }
      case 'transferChecked': {
        const ours = x.program === inputProgram && x.source === wIn && x.mint === p.inputMint &&
          x.authority === W && x.decimals === p.inputDecimals;
        const floor = x.program === minOut.program && x.source === minOut.account && x.destination === minOut.account &&
          x.mint === minOut.mint && x.authority === minOut.authority && x.decimals === minOut.decimals;
        // A fee on a token output comes out of W_out, by W, to the treasury's account for that token.
        const outputFee = p.feeSide === 'output' && !A && p.fee > 0n && x.program === outputProgram && x.source === wOut
          && x.mint === p.outputMint && x.authority === W && x.decimals === p.outputDecimals
          && x.destination === feeDestination && x.amount === p.fee;
        if (ours && x.destination === eIn && x.amount === p.swapAmount) put('transferIn', i);
        else if (ours && p.feeSide === 'input' && p.fee > 0n && x.destination === feeDestination && x.amount === p.fee) put('feeTransfer', i);
        else if (outputFee) put('feeTransfer', i);
        else if (floor && x.amount === minOut.amount) put('minOutCheck', i);
        else if (floor) fail('R2', `instruction ${i}: minimum-output check for ${x.amount}, expected ${minOut.amount}`);
        else fail('R2', `instruction ${i}: unexpected token transfer of ${x.amount}`);
        break;
      }
      case 'systemTransfer':
        if (B && x.from === W && x.to === eIn && x.lamports === p.swapAmount) put('transferIn', i);
        else if (B && p.feeSide === 'input' && p.fee > 0n && x.from === W && x.to === feeDestination && x.lamports === p.fee) put('feeTransfer', i);
        // A fee on a SOL output: from the wallet, which E_out has paid out to, to the treasury wallet.
        else if (A && p.feeSide === 'output' && p.fee > 0n && x.from === W && x.to === feeDestination && x.lamports === p.fee) put('feeTransfer', i);
        // A fee in SOL for a pair without SOL: from the wallet to the treasury wallet, before the swap.
        else if (p.feeSide === 'sol' && p.fee > 0n && x.from === W && x.to === feeDestination && x.lamports === p.fee) put('feeTransfer', i);
        else if (p.takerRent > 0n && x.from === W && x.to === E && x.lamports === p.takerRent) put('takerRent', i);
        else if (p.routeRefund > 0n && x.from === E && x.to === W && x.lamports === p.routeRefund) put('routeRefund', i);
        else fail('R2', `instruction ${i}: unexpected SOL transfer of ${x.lamports} lamports`);
        break;
      case 'syncNative':
        if (B && x.account === eIn) put('sync', i);
        else fail('R2', `instruction ${i}: unexpected SyncNative`);
        break;
      case 'harvest': {
        // Only a temporary account of ours, and only to its own mint: harvesting moves nothing of
        // the user's, but an unexpected account here would be an instruction we did not intend.
        const hop = x.sources.length === 1 ? intermediates.get(x.sources[0]) : undefined;
        if (x.program === inputProgram && x.mint === p.inputMint && x.sources.length === 1 && x.sources[0] === eIn) {
          put('harvestEIn', i);
        } else if (hop && hop.fee && x.program === hop.tokenProgram && x.mint === hop.mint) {
          hop.harvested = (hop.harvested ?? 0) + 1;
          put('harvestIntermediate', i);
        } else fail('R2', `instruction ${i}: unexpected harvest of withheld fees`);
        break;
      }
      case 'revoke':
        if (!A && x.program === outputProgram && x.source === wOut && x.owner === W) put('revokeWOut', i);
        else fail('R2', `instruction ${i}: unexpected Revoke`);
        break;
      case 'close': {
        if (x.destination !== W || x.owner !== E) { fail('R2', `instruction ${i}: account closed to someone other than the wallet`); break; }
        const mid = intermediates.get(x.account);
        if (x.program === inputProgram && x.account === eIn) put('closeEIn', i);
        else if (A && x.program === TOKEN_PROGRAM && x.account === eOut) put('closeEOut', i);
        else if (mid && mid.tokenProgram === x.program) { mid.closed++; put('closeIntermediate', i); }
        else fail('R2', `instruction ${i}: unexpected CloseAccount`);
        break;
      }
      case 'closeRouteAccount':
        if (
          p.routeRefund > 0n && x.program === refundProgram && x.user === E
          && x.account === expected.routeAccount && x.eventAuthority === expected.routeEventAuthority
        ) put('closeRouteAccount', i);
        else fail('R2', `instruction ${i}: a Pump account closed that the policy does not name`);
        break;
      default:
        break;
    }
  }

  const count = (s: Slot) => slots.get(s)?.length ?? 0;
  const need = (s: Slot, n: number, rule: RuleId = 'R2') => {
    if (count(s) !== n) fail(rule, `expected ${n} × ${s}, found ${count(s)}`);
  };
  need('createEIn', 1);
  need('transferIn', 1);
  need('closeEIn', 1, 'R5');
  if (A) {
    need('createEOut', 1);
    need('closeEOut', 1, 'R5');
  } else {
    need('createWOut', 1);
    need('revokeWOut', 1);
  }
  need('minOutCheck', 1);
  need('harvestEIn', p.inputTransferFee ? 1 : 0, 'R5');
  if (B) need('sync', 1);
  need('feeTransfer', p.fee > 0n ? 1 : 0);
  // SOL for E is rent for an account the route opens in E's name, never money to swap with: it is
  // capped, and the external program can take at most this on top of the approved amount.
  need('takerRent', p.takerRent > 0n ? 1 : 0, 'R4');
  need('closeRouteAccount', p.routeRefund > 0n ? 1 : 0, 'R5');
  need('routeRefund', p.routeRefund > 0n ? 1 : 0, 'R5');
  if (p.takerRent < 0n || p.takerRent > MAX_TAKER_RENT_LAMPORTS) {
    fail('R4', `route rent ${p.takerRent} lamports is outside 0..${MAX_TAKER_RENT_LAMPORTS}`);
  }
  // Rent goes to E only to be spent or returned: what is neither refunded nor allowed to be kept could
  // stay under E, where only the server could reach it.
  if (p.takerRent - p.routeRefund > MAX_ROUTE_KEPT_LAMPORTS) {
    fail('R4', `the route keeps ${p.takerRent - p.routeRefund} lamports of the rent sent to E, above ${MAX_ROUTE_KEPT_LAMPORTS}`);
  }
  if (version === 0) { need('cuLimit', 1, 'R4'); need('cuPrice', 1, 'R4'); }
  for (const [address, m] of intermediates) {
    if (m.created !== 1 || m.closed !== 1) fail('R5', `intermediate account ${address} is not created and closed exactly once`);
    // A taxing mint withholds in every account that receives it, and such an account cannot close.
    if (m.fee && (m.harvested ?? 0) !== 1) fail('R5', `intermediate account ${address} of a taxing mint is not harvested exactly once`);
  }
  if (intermediates.size > MAX_INTERMEDIATE_ACCOUNTS) {
    fail('R5', `${intermediates.size} intermediate accounts, above the maximum of ${MAX_INTERMEDIATE_ACCOUNTS}`);
  }

  // Order: setup before the swap, cleanup after it.
  if (swapIndex >= 0) {
    for (const s of BEFORE_SWAP) for (const i of slots.get(s) ?? []) if (i > swapIndex) fail('R2', `${s} must run before the swap`);
    for (const s of AFTER_SWAP) for (const i of slots.get(s) ?? []) if (i < swapIndex) fail('R5', `${s} must run after the swap`);
    // A fee on the input is setup; a fee on the output comes out of what arrived: after the minimum
    // check, and for SOL after E_out has paid out to the wallet, so the wallet keeps minOut - fee.
    for (const i of slots.get('feeTransfer') ?? []) {
      if (p.feeSide !== 'output') {
        if (i > swapIndex) fail('R2', 'feeTransfer must run before the swap');
        continue;
      }
      const first = [...(slots.get('minOutCheck') ?? []), ...(A ? slots.get('closeEOut') ?? [] : [])];
      if (i < swapIndex || first.some(j => j > i)) {
        fail('R5', `the fee on the output must follow the minimum check${A ? ' and the close of E_out' : ''}`);
      }
    }
  }
  const first = (s: Slot) => slots.get(s)?.[0] ?? -1;
  if (first('createEIn') > first('transferIn')) fail('R2', 'the input account is funded before it is created');
  if (B && first('transferIn') > first('sync')) fail('R2', 'SyncNative runs before the SOL transfer');
  if (!A && first('createWOut') > first('revokeWOut')) fail('R2', 'W_out is revoked before it is created');
  if (A && first('minOutCheck') > first('closeEOut')) fail('R5', 'the minimum-output check runs after E_out is closed');
  if (p.inputTransferFee && first('harvestEIn') > first('closeEIn')) fail('R5', 'withheld fees are harvested after E_in is closed');
  if (count('closeRouteAccount')) {
    const at = first('closeRouteAccount');
    const lastOwn = Math.max(-1, ...OWN_CLEANUP.flatMap(s => slots.get(s) ?? []));
    if (at < lastOwn) fail('R5', "the route's account is closed while E still owns a token account");
    if (first('routeRefund') < at) fail('R5', "the route's lamports are sent on before its account is closed");
  }

  // R1: the external program never receives W or any of W's token accounts except W_out.
  // (Sufficient only together with R6: see the note at the top of this file.)
  for (const { x } of externals) {
    if (x.kind !== 'external') continue;
    for (const a of x.accounts as readonly Account[]) {
      if (a.address === W) { fail('R1', 'the wallet is passed to the external program'); continue; }
      if (a.address === wIn) { fail('R1', "the wallet's input token account is passed to the external program"); continue; }
      if (a.address === feeDestination || a.address === p.treasury) {
        fail('R1', "Orientim's fee account is passed to the external program");
        continue;
      }
      if (a.address === wOut) continue;
      if (!snapshot.accounts.has(a.address)) { fail('R1', `external account ${a.address} missing from the snapshot`); continue; }
      const state = snapshot.accounts.get(a.address);
      if (state && isTokenAccountOwnedBy(state, W)) fail('R1', `the wallet's token account ${a.address} is passed to the external program`);
    }
  }

  // W_out is handed to the external program. A delegate is removed by the trusted Revoke; a close
  // authority cannot be, so such an account is refused.
  if (wOut) {
    if (!snapshot.accounts.has(wOut)) fail('R1', 'W_out missing from the snapshot');
    else if (hasCloseAuthority(snapshot.accounts.get(wOut))) fail('R1', 'W_out has a close authority set');
  }
  // A frozen token account of the wallet can neither send nor receive: the swap could only fail on
  // chain. It is refused here, with the reason, instead of failing in the simulation.
  if (wIn && isFrozen(snapshot.accounts.get(wIn))) fail('R1', "the wallet's input token account is frozen");
  if (wOut && isFrozen(snapshot.accounts.get(wOut))) fail('R1', "the wallet's output token account is frozen");

  // Orientim's own accounts are named in the message itself, never loaded from a lookup table: a table is read from the RPC, and an address that resolves differently on chain than in
  // the snapshot would redirect a trusted transfer. Jupiter's tables hold pools, never these.
  const fromTables = new Set(loaded.slice(compiled.staticAccounts.length));
  const own: [string, Address | null][] = [
    ['W_in', wIn], ['W_out', wOut], ['E_in', eIn], ['E_out', eOut], ["Orientim's fee account", feeDestination],
    ['the treasury', p.treasury], ["the route's account", expected.routeAccount],
    ...[...intermediates.keys()].map(k => ['an intermediate account', k as Address] as [string, Address]),
  ];
  for (const [label, address] of own) {
    if (address && fromTables.has(address)) fail('R1', `${label} is loaded from a lookup table`);
  }

  // R3: E and its accounts are fresh.
  const fresh: [string, Address | null][] = [['E', E], ['E_in', eIn], ['E_out', eOut], ...[...intermediates.keys()].map(k => ['intermediate', k as Address] as [string, Address])];
  for (const [label, address] of fresh) {
    if (!address) continue;
    if (!snapshot.accounts.has(address)) fail('R3', `${label} missing from the snapshot`);
    else if (exists(snapshot.accounts.get(address))) fail('R3', `${label} already exists on chain`);
  }

  // R4: maximum network fee paid by W.
  const signatureFee = LAMPORTS_PER_SIGNATURE * BigInt(numSigners);
  let priorityFee = 0n;
  if (version === 0) {
    const limit = parsed[first('cuLimit')];
    const price = parsed[first('cuPrice')];
    if (limit?.kind === 'cuLimit' && price?.kind === 'cuPrice') {
      priorityFee = (BigInt(limit.units) * price.microLamports + 999_999n) / 1_000_000n;
    }
  } else if (version === 1) {
    // The v1 config is an allowlist, like v0's instructions.
    const mask = (compiled as unknown as { configMask?: number }).configMask ?? 0;
    if (mask & ~V1_ALLOWED_CONFIG) fail('R4', `unexpected fields in the v1 message config (mask ${mask})`);
    const units = getTransactionMessageComputeUnitLimit(msg as never) ?? 0;
    if (units > MAX_COMPUTE_UNITS) fail('R4', `compute unit limit ${units} above maximum`);
    const loaded = getTransactionMessageLoadedAccountsDataSizeLimit(msg as never) ?? 0;
    if (loaded > MAX_LOADED_ACCOUNTS_DATA_SIZE) fail('R4', `loaded accounts data size limit ${loaded} above maximum`);
    priorityFee = getTransactionMessagePriorityFeeLamports(msg as never) ?? 0n;
  }
  const feeLimit = p.maxNetworkFeeLamports < ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS
    ? p.maxNetworkFeeLamports
    : ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS;
  if (signatureFee + priorityFee > feeLimit) {
    fail('R4', `network fee up to ${signatureFee + priorityFee} lamports, above ${feeLimit}`);
  }

  // R5: one transaction within the size limits.
  const size = getTransactionSize(transaction);
  const limit = version === 1 ? V1_SIZE_LIMIT : LEGACY_SIZE_LIMIT;
  if (size > limit) fail('R5', `transaction is ${size} bytes, limit ${limit}`);
  if (version === 1 && compiled.staticAccounts.length > V1_MAX_ACCOUNTS) fail('R5', `${compiled.staticAccounts.length} accounts, limit ${V1_MAX_ACCOUNTS}`);

  // R7 for hops: a Token-2022 intermediate mint must be in the snapshot and carry
  // only extensions a protected swap can live with. Classic SPL hops need no check.
  for (const m of intermediates.values()) {
    if (m.tokenProgram !== TOKEN_2022_PROGRAM) continue;
    const state = snapshot.accounts.get(m.mint);
    const risky = state && state.owner === TOKEN_2022_PROGRAM
      ? unsupportedExtension(state.data, { allowTransferFee: true })
      : 'missing mint';
    if (risky) fail('R7', `intermediate mint ${m.mint}: ${risky}`);
  }

  // R7: both mints are token mints Orientim can isolate - classic SPL (WSOL included), or Token-2022
  // with none of the extensions that would break the guarantee.
  for (const mint of [p.inputMint, p.outputMint]) {
    const state = snapshot.accounts.get(mint);
    if (!state) { fail('R7', `mint ${mint} not found`); continue; }
    if (state.owner === TOKEN_PROGRAM) continue;
    if (state.owner !== TOKEN_2022_PROGRAM) { fail('R7', `mint ${mint} is not a token mint`); continue; }
    const bad = unsupportedExtension(state.data, { allowTransferFee: true });
    if (bad) fail('R7', `mint ${mint}: ${bad}`);
  }

  return { ok: violations.length === 0, violations, networkFeeLamports: signatureFee + priorityFee };
}
