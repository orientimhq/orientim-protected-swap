import { getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, getTransactionDecoder, verifySignature } from '@solana/kit';
import type { Address, Transaction } from '@solana/kit';
import { ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS, LAMPORTS_PER_SIGNATURE } from '@orientim/core/constants';
import type { Verdict, Violation } from '@orientim/core/types';

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** Lighthouse, the assertion program Phantom may add to a transaction before it signs. */
export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95' as Address;
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
/**
 * Lighthouse instructions 2 to 15 only read accounts and fail the transaction when an assertion
 * does not hold. 0 and 1 write and close Lighthouse's own memory accounts, and 16 and 17 read
 * compression trees; none of those is accepted.
 */
const ASSERTION_FIRST = 2;
const ASSERTION_LAST = 15;
/** SetComputeUnitLimit (2, u32) may rise by this much, for the assertions' own compute. */
const SET_CU_LIMIT = 2;
const SET_CU_PRICE = 3;
/** How far a wallet may raise the compute limit for the assertions it adds (a builder leaves room for it). */
export const MAX_ADDED_COMPUTE_UNITS = 50_000;

/** A Lighthouse instruction that only asserts (kinds 2 to 15), by its data. */
export function isLighthouseAssertion(data: ArrayLike<number>): boolean {
  return data.length > 0 && data[0]! >= ASSERTION_FIRST && data[0]! <= ASSERTION_LAST;
}

type Compiled = {
  version: 'legacy' | 0 | 1;
  header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
  staticAccounts: readonly Address[];
  lifetimeToken?: string;
  instructions: readonly { programAddressIndex: number; accountIndices?: readonly number[]; data?: ArrayLike<number> }[];
  addressTableLookups?: readonly { lookupTableAddress: Address; writableIndexes: readonly number[]; readonlyIndexes: readonly number[] }[];
};

/** Each account key of a message by name: a static address, or a lookup table and its index. */
function accountNames(m: Compiled): string[] {
  const names: string[] = [...m.staticAccounts];
  for (const l of m.addressTableLookups ?? []) for (const i of l.writableIndexes) names.push(`${l.lookupTableAddress}#w${i}`);
  for (const l of m.addressTableLookups ?? []) for (const i of l.readonlyIndexes) names.push(`${l.lookupTableAddress}#r${i}`);
  return names;
}

/** Signer and writable, for a static account at `i`. */
function staticRole(m: Compiled, i: number): string {
  const { numSignerAccounts: signers, numReadonlySignerAccounts: roSigners, numReadonlyNonSignerAccounts: ro } = m.header;
  if (i < signers) return i < signers - roSigners ? 'signer-writable' : 'signer';
  return i < m.staticAccounts.length - ro ? 'writable' : 'readonly';
}

const u32At = (data: ArrayLike<number>, at: number) =>
  (data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16) | (data[at + 3]! << 24)) >>> 0;
const u64At = (data: ArrayLike<number>, at: number) => BigInt(u32At(data, at)) | (BigInt(u32At(data, at + 4)) << 32n);

type Resolved = { program: string | undefined; accounts: (string | undefined)[]; data: number[] };

/** The most a v0 message can pay in network fees, read as R4 reads it: signatures and priority. */
function networkFee(signers: number, instructions: Resolved[]): bigint {
  const budget = (kind: number, length: number) =>
    instructions.find(ix => ix.program === COMPUTE_BUDGET && ix.data[0] === kind && ix.data.length === length);
  const limit = budget(SET_CU_LIMIT, 5);
  const price = budget(SET_CU_PRICE, 9);
  const priority = limit && price ? (BigInt(u32At(limit.data, 1)) * u64At(price.data, 1) + 999_999n) / 1_000_000n : 0n;
  return LAMPORTS_PER_SIGNATURE * BigInt(signers) + priority;
}

/**
 * Whether `returned` is `original` with only Lighthouse assertions added, as Phantom may do: the
 * same signers in the same order, the same fee payer, lifetime and lookup tables, every original
 * account in the same role, new accounts read-only, the original instructions unchanged and in
 * order, and a compute limit raised by at most MAX_ADDED_COMPUTE_UNITS while the network fee stays
 * within `maxFee`. Returns what differs, or nothing when the change is only that.
 */
function onlyAssertionsAdded(original: Compiled, returned: Compiled, maxFee: bigint): string | null {
  if (original.version !== returned.version || original.version === 1) return 'the message version or format changed';
  if (original.lifetimeToken !== returned.lifetimeToken) return 'the blockhash changed';
  const { header: a } = original;
  const { header: b } = returned;
  if (a.numSignerAccounts !== b.numSignerAccounts || a.numReadonlySignerAccounts !== b.numReadonlySignerAccounts) return 'the signers changed';
  for (let i = 0; i < a.numSignerAccounts; i++) if (original.staticAccounts[i] !== returned.staticAccounts[i]) return 'the signers changed';
  if (JSON.stringify(original.addressTableLookups ?? []) !== JSON.stringify(returned.addressTableLookups ?? [])) return 'the lookup tables changed';

  const position = new Map(returned.staticAccounts.map((k, i) => [k as string, i]));
  if (position.size !== returned.staticAccounts.length) return 'an account is listed twice';
  for (let i = 0; i < original.staticAccounts.length; i++) {
    const j = position.get(original.staticAccounts[i]!);
    if (j === undefined) return 'an account was removed';
    if (staticRole(original, i) !== staticRole(returned, j)) return 'an account changed its signer or writable role';
  }
  const known = new Set<string>(original.staticAccounts);
  for (let j = 0; j < returned.staticAccounts.length; j++) {
    if (!known.has(returned.staticAccounts[j]!) && staticRole(returned, j) !== 'readonly') return 'an added account is writable or a signer';
  }

  const namesA = accountNames(original);
  const namesB = accountNames(returned);
  const resolve = (names: string[], ix: Compiled['instructions'][number]): Resolved => ({
    program: names[ix.programAddressIndex],
    accounts: (ix.accountIndices ?? []).map(k => names[k]),
    data: Array.from(ix.data ?? []),
  });
  const kept = returned.instructions.map(ix => resolve(namesB, ix));
  const added = kept.filter(ix => ix.program === LIGHTHOUSE_PROGRAM);
  if (!added.length) return 'the wallet changed an instruction';
  for (const ix of added) {
    if (!isLighthouseAssertion(ix.data)) return 'the wallet added a Lighthouse instruction that is not an assertion';
    if (ix.accounts.some(k => k === undefined)) return 'an added instruction names an account the message does not have';
  }
  const rest = kept.filter(ix => ix.program !== LIGHTHOUSE_PROGRAM);
  const before = original.instructions.map(ix => resolve(namesA, ix));
  if (rest.length !== before.length) return 'the wallet added or removed an instruction';
  for (let i = 0; i < before.length; i++) {
    const [x, y] = [before[i]!, rest[i]!];
    if (x.program !== y.program || JSON.stringify(x.accounts) !== JSON.stringify(y.accounts)) return 'the wallet changed an instruction';
    if (JSON.stringify(x.data) === JSON.stringify(y.data)) continue;
    const limit = x.program === COMPUTE_BUDGET && x.data.length === 5 && y.data.length === 5 && x.data[0] === SET_CU_LIMIT && y.data[0] === SET_CU_LIMIT;
    if (!limit) return 'the wallet changed an instruction';
    const [from, to] = [u32At(x.data, 1), u32At(y.data, 1)];
    if (to < from || to - from > MAX_ADDED_COMPUTE_UNITS) return 'the wallet changed the compute limit';
  }
  // A higher compute limit at the same price costs more: the fee is held to the same limit as before.
  const fee = networkFee(b.numSignerAccounts, rest);
  if (fee > maxFee) return `the network fee would be up to ${fee} lamports, above ${maxFee}`;
  return null;
}

/**
 * R6, second half: what the wallet returns must be the verified message, byte for byte, carrying
 * a valid signature from W and no signature from E. Only then does E sign last.
 *
 * With `acceptAssertions`, a message that differs only by Lighthouse assertions the wallet added
 * (onlyAssertionsAdded) is accepted too, and its signature is checked over that message. Every
 * assertion can only make the transaction fail; the verified instructions are left as they were.
 * `maxNetworkFeeLamports` is the policy's F_max, which a raised compute limit must stay within
 * (never above ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS).
 */
export async function verifyWalletReturn(
  original: Transaction,
  returnedBytes: Uint8Array,
  owner: Address,
  ephemeral: Address,
  options: { acceptAssertions?: boolean; maxNetworkFeeLamports?: bigint } = {},
): Promise<Verdict & { transaction: Transaction | null }> {
  const violations: Violation[] = [];
  const fail = (detail: string) => void violations.push({ rule: 'R6', detail });

  let returned: Transaction;
  try {
    returned = getTransactionDecoder().decode(returnedBytes);
  } catch {
    fail('the wallet returned a transaction that cannot be decoded');
    return { ok: false, violations, transaction: null };
  }

  let signedMessage = original.messageBytes;
  if (!sameBytes(returned.messageBytes, original.messageBytes)) {
    let why: string | null = 'the wallet changed the transaction message';
    if (options.acceptAssertions) {
      try {
        const decode = getCompiledTransactionMessageDecoder();
        const asked = options.maxNetworkFeeLamports ?? ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS;
        const maxFee = asked < ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS ? asked : ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS;
        why = onlyAssertionsAdded(decode.decode(original.messageBytes) as Compiled, decode.decode(returned.messageBytes) as Compiled, maxFee);
      } catch {
        why = 'the wallet returned a message that cannot be decoded';
      }
    }
    if (why) fail(why);
    else signedMessage = returned.messageBytes;
  }
  const signers = Object.keys(returned.signatures);
  if (signers.length !== 2 || !signers.includes(owner) || !signers.includes(ephemeral)) {
    fail('the returned transaction has unexpected signers');
  }
  const ownerSignature = returned.signatures[owner];
  if (!ownerSignature) {
    fail('the wallet did not sign');
  } else if (!(await verifySignature(await getPublicKeyFromAddress(owner), ownerSignature, signedMessage))) {
    fail("the wallet's signature does not match the verified message");
  }
  if (returned.signatures[ephemeral]) fail('the temporary key was already signed by someone else');

  const ok = violations.length === 0;
  return { ok, violations, transaction: ok ? returned : null };
}
