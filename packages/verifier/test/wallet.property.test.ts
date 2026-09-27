/**
 * What a wallet may hand back, fuzzed: an honest v0 message, with or without lookup tables, is
 * changed by a random list of edits and signed by the wallet. verifyWalletReturn with
 * acceptAssertions must accept it exactly when the edits are only what Phantom may do:
 * - Lighthouse assertions (kinds 2 to 15) added anywhere, on any account the message has or on new
 *   read-only ones;
 * - the compute limit raised by at most 50,000 units;
 * - accounts reordered within their own non-signer group.
 * Anything else (another Lighthouse kind, a new writable account, a changed price, blockhash,
 * instruction or order, a dropped instruction, a role changed, signers reordered) is refused, and
 * without acceptAssertions only the exact message is accepted.
 *
 * `npm run test:fuzz` runs 100,000 cases; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  generateKeyPairSigner, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder,
  getTransactionEncoder, partiallySignTransaction,
} from '@solana/kit';
import type { Address, KeyPairSigner, Transaction } from '@solana/kit';
import { compileProtectedSwap } from '@orientim/core';
import { LIGHTHOUSE_PROGRAM, verifyWalletReturn } from '../src/index.ts';
import { LIFETIME, scenario } from './fixtures.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 100_000 : 300));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 5;

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

type Ix = { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array };
type Compiled = {
  version: 0;
  header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
  staticAccounts: Address[];
  lifetimeToken: string;
  instructions: Ix[];
  addressTableLookups?: { lookupTableAddress: Address; writableIndexes: number[]; readonlyIndexes: number[] }[];
};

type Base = { owner: KeyPairSigner; E: Address; tx: Transaction; spare: Address[] };

/** Two honest messages, compiled once: one with lookup tables, one without. */
async function bases(): Promise<Base[]> {
  const out: Base[] = [];
  for (const tables of [true, false]) {
    const owner = await generateKeyPairSigner();
    const s = await scenario({ owner });
    const { transaction } = compileProtectedSwap({
      policy: s.policy, swapInstruction: s.swapIx, intermediates: s.intermediates, version: 0, lifetime: LIFETIME,
      computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, outputBalanceBefore: s.wOutBalance,
      ...(tables ? { lookupTables: s.lookupTables } : {}),
    });
    const spare = await Promise.all(Array.from({ length: 4 }, async () => (await generateKeyPairSigner()).address));
    out.push({ owner, E: s.E.address, tx: transaction, spare });
  }
  return out;
}

const decode = (tx: Transaction) => structuredClone(getCompiledTransactionMessageDecoder().decode(tx.messageBytes)) as unknown as Compiled;
const encode = (m: Compiled) => new Uint8Array(getCompiledTransactionMessageEncoder().encode(m as never));
const wire = (tx: Transaction) => new Uint8Array(getTransactionEncoder().encode(tx));

/** Every index at or after `at` moves by `by`: static accounts after it, and lookup-table accounts. */
function shift(m: Compiled, at: number, by: number) {
  for (const ix of m.instructions) {
    if (ix.programAddressIndex >= at) ix.programAddressIndex += by;
    ix.accountIndices = ix.accountIndices?.map(i => (i >= at ? i + by : i));
  }
}

/** Adds a static non-signer and returns its index. */
function addStatic(m: Compiled, key: Address, writable: boolean): number {
  const at = writable ? m.staticAccounts.length - m.header.numReadonlyNonSignerAccounts : m.staticAccounts.length;
  shift(m, at, 1);
  m.staticAccounts.splice(at, 0, key);
  if (!writable) m.header.numReadonlyNonSignerAccounts++;
  return at;
}

const totalAccounts = (m: Compiled) =>
  m.staticAccounts.length + (m.addressTableLookups ?? []).reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);

const isBudget = (m: Compiled, ix: Ix, kind: number) => m.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET && ix.data?.[0] === kind;

type Edit =
  | { op: 'lighthouse'; kind: number; picks: number[]; fresh: number; at: number; tail: number[] }
  | { op: 'freshWritable'; kind: number; at: number }
  | { op: 'cuLimit'; delta: number }
  | { op: 'cuPrice'; delta: number }
  | { op: 'flip'; which: number; at: number; xor: number }
  | { op: 'drop'; which: number }
  | { op: 'swap'; a: number; b: number }
  | { op: 'blockhash'; byte: number }
  | { op: 'role'; more: boolean }
  | { op: 'permute'; group: 'writable' | 'readonly'; seed: number }
  | { op: 'signers' };

const edit: fc.Arbitrary<Edit> = fc.oneof(
  { weight: 6, arbitrary: fc.record({
    op: fc.constant('lighthouse' as const), kind: fc.integer({ min: 0, max: 20 }), picks: fc.array(fc.nat(), { maxLength: 4 }),
    fresh: fc.integer({ min: 0, max: 2 }), at: fc.nat(), tail: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 24 }),
  }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('freshWritable' as const), kind: fc.integer({ min: 2, max: 15 }), at: fc.nat() }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('cuLimit' as const), delta: fc.integer({ min: -20_000, max: 120_000 }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('cuPrice' as const), delta: fc.integer({ min: 1, max: 1_000_000 }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('flip' as const), which: fc.nat(), at: fc.nat(), xor: fc.integer({ min: 1, max: 255 }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('drop' as const), which: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('swap' as const), a: fc.nat(), b: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('blockhash' as const), byte: fc.integer({ min: 1, max: 255 }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('role' as const), more: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('permute' as const), group: fc.constantFrom('writable' as const, 'readonly' as const), seed: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('signers' as const) }) },
);

/**
 * Applies the edits and says whether each one is of a kind Phantom may make. The original
 * instructions are tracked by identity, so an edit that happens to change nothing is not blamed.
 */
function apply(base: Base, edits: Edit[]): { m: Compiled; allowed: boolean; assertions: number } {
  const m = decode(base.tx);
  const originals = new Set(m.instructions);
  let allowed = true;
  let assertions = 0;
  let spare = 0;
  let raised = 0;
  const originalKeys = new Set<string>(m.staticAccounts);
  const initial = decode(base.tx);
  const initialOrder = [...m.instructions];
  // What each original instruction was, by account and program address, to compare at the end.
  const namesOf = (c: Compiled) => [
    ...c.staticAccounts,
    ...(c.addressTableLookups ?? []).flatMap(l => l.writableIndexes.map(i => `${l.lookupTableAddress}#w${i}`)),
    ...(c.addressTableLookups ?? []).flatMap(l => l.readonlyIndexes.map(i => `${l.lookupTableAddress}#r${i}`)),
  ];
  const described = (c: Compiled, ix: Ix) => {
    const n = namesOf(c);
    return { program: n[ix.programAddressIndex], accounts: (ix.accountIndices ?? []).map(i => n[i]), data: [...(ix.data ?? [])] };
  };
  const before = new Map(initialOrder.map((ix, k) => [ix, described(initial, initial.instructions[k]!)]));
  const role = (c: Compiled, key: string) => {
    const i = c.staticAccounts.indexOf(key as Address);
    const { numSignerAccounts: sg, numReadonlySignerAccounts: rs, numReadonlyNonSignerAccounts: ro } = c.header;
    return i < sg ? (i < sg - rs ? 'sw' : 's') : i < c.staticAccounts.length - ro ? 'w' : 'r';
  };
  const fresh = () => base.spare[spare++ % base.spare.length]!;
  const originalList = () => m.instructions.filter(ix => originals.has(ix));
  const lighthouseIndex = () => {
    const i = m.staticAccounts.indexOf(LIGHTHOUSE_PROGRAM);
    return i >= 0 ? i : addStatic(m, LIGHTHOUSE_PROGRAM, false);
  };

  for (const e of edits) {
    switch (e.op) {
      case 'lighthouse': {
        const program = lighthouseIndex();
        const accounts = e.picks.map(p => p % totalAccounts(m));
        for (let k = 0; k < e.fresh; k++) {
          const key = fresh();
          const existing = m.staticAccounts.indexOf(key);
          const i = existing >= 0 ? existing : addStatic(m, key, false);
          // The program's index may have moved when an account was added before it.
          accounts.push(i);
        }
        const ix: Ix = { programAddressIndex: m.staticAccounts.indexOf(LIGHTHOUSE_PROGRAM), accountIndices: accounts, data: Uint8Array.from([e.kind, ...e.tail]) };
        expect(program).toBeGreaterThan(0);
        m.instructions.splice(e.at % (m.instructions.length + 1), 0, ix);
        if (e.kind < 2 || e.kind > 15) allowed = false;
        assertions++;
        break;
      }
      case 'freshWritable': {
        const key = fresh();
        if (m.staticAccounts.includes(key)) break;
        const i = addStatic(m, key, true);
        lighthouseIndex();
        m.instructions.splice(e.at % (m.instructions.length + 1), 0, {
          programAddressIndex: m.staticAccounts.indexOf(LIGHTHOUSE_PROGRAM), accountIndices: [m.staticAccounts.indexOf(key)], data: Uint8Array.from([e.kind]),
        });
        expect(i).toBeGreaterThan(0);
        allowed = false;
        assertions++;
        break;
      }
      case 'cuLimit': {
        const ix = m.instructions.find(i => isBudget(m, i, 2));
        if (!ix || e.delta === 0) break;
        const data = Uint8Array.from(ix.data!);
        const view = new DataView(data.buffer);
        view.setUint32(1, view.getUint32(1, true) + e.delta, true);
        ix.data = data;
        // Edits add up: the limit is compared with the original, not with the last edit.
        raised += e.delta;
        break;
      }
      case 'cuPrice': {
        const ix = m.instructions.find(i => isBudget(m, i, 3));
        if (!ix) break;
        const data = Uint8Array.from(ix.data!);
        const view = new DataView(data.buffer);
        view.setBigUint64(1, view.getBigUint64(1, true) + BigInt(e.delta), true);
        ix.data = data;
        allowed = false;
        break;
      }
      case 'flip': {
        const list = originalList().filter(ix => !isBudget(m, ix, 2) && !isBudget(m, ix, 3) && (ix.data?.length ?? 0) > 0);
        if (!list.length) break;
        const ix = list[e.which % list.length]!;
        const data = Uint8Array.from(ix.data!);
        data[e.at % data.length] ^= e.xor;
        ix.data = data;
        break;
      }
      case 'drop': {
        const list = originalList();
        const ix = list[e.which % list.length]!;
        m.instructions.splice(m.instructions.indexOf(ix), 1);
        originals.delete(ix);
        allowed = false;
        break;
      }
      case 'swap': {
        const list = originalList();
        const [a, b] = [list[e.a % list.length]!, list[e.b % list.length]!];
        if (a === b || JSON.stringify(a) === JSON.stringify(b)) break;
        const [i, j] = [m.instructions.indexOf(a), m.instructions.indexOf(b)];
        [m.instructions[i], m.instructions[j]] = [b, a];
        break;
      }
      case 'blockhash': {
        // A different base58 blockhash: one character replaced by another of the alphabet.
        const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        const at = e.byte % m.lifetimeToken.length;
        const c = m.lifetimeToken[at]!;
        const next = alphabet[(alphabet.indexOf(c) + 1 + (e.byte % 57)) % 58]!;
        if (next === c) break;
        m.lifetimeToken = m.lifetimeToken.slice(0, at) + next + m.lifetimeToken.slice(at + 1);
        break;
      }
      case 'role': {
        // Moves the boundary between writable and read-only non-signers by one: one account changes role.
        const { numSignerAccounts: signers, numReadonlyNonSignerAccounts: ro } = m.header;
        const writable = m.staticAccounts.length - signers - ro;
        if (e.more ? writable === 0 : ro === 0) break;
        // Only an original account changing role is the edit meant here.
        const flips = m.staticAccounts[e.more ? m.staticAccounts.length - ro - 1 : m.staticAccounts.length - ro]!;
        if (!originalKeys.has(flips)) break;
        m.header.numReadonlyNonSignerAccounts += e.more ? 1 : -1;
        break;
      }
      case 'permute': {
        const { numSignerAccounts: signers, numReadonlyNonSignerAccounts: ro } = m.header;
        const [from, to] = e.group === 'writable' ? [signers, m.staticAccounts.length - ro] : [m.staticAccounts.length - ro, m.staticAccounts.length];
        if (to - from < 2) break;
        const order = Array.from({ length: to - from }, (_, k) => from + k);
        let s = e.seed;
        for (let k = order.length - 1; k > 0; k--) {
          s = (s * 1103515245 + 12345) >>> 0;
          const r = s % (k + 1);
          [order[k], order[r]] = [order[r]!, order[k]!];
        }
        const moved = new Map(order.map((old, k) => [old, from + k]));
        m.staticAccounts = m.staticAccounts.map((key, i) => (moved.has(i) ? m.staticAccounts[order[i - from]!]! : key));
        const where = (i: number) => moved.get(i) ?? i;
        for (const ix of m.instructions) {
          ix.programAddressIndex = where(ix.programAddressIndex);
          ix.accountIndices = ix.accountIndices?.map(where);
        }
        break;
      }
      case 'signers': {
        // W and E trade places in the message.
        if (m.header.numSignerAccounts < 2) break;
        const a = m.staticAccounts[0]!;
        m.staticAccounts[0] = m.staticAccounts[1]!;
        m.staticAccounts[1] = a;
        for (const ix of m.instructions) {
          const w = (i: number) => (i === 0 ? 1 : i === 1 ? 0 : i);
          ix.programAddressIndex = w(ix.programAddressIndex);
          ix.accountIndices = ix.accountIndices?.map(w);
        }
        break;
      }
    }
  }
  if (raised < 0 || raised > 50_000) allowed = false;
  // Edits that can undo each other are judged by where they ended.
  if (m.lifetimeToken !== initial.lifetimeToken) allowed = false;
  for (let i = 0; i < initial.header.numSignerAccounts; i++) if (m.staticAccounts[i] !== initial.staticAccounts[i]) allowed = false;
  if (m.header.numSignerAccounts !== initial.header.numSignerAccounts) allowed = false;
  for (const key of originalKeys) if (role(m, key) !== role(initial, key)) allowed = false;
  const kept = initialOrder.filter(ix => originals.has(ix));
  const now = m.instructions.filter(ix => originals.has(ix));
  if (kept.some((ix, k) => JSON.stringify(described(m, now[k]!)) !== JSON.stringify(before.get(ix)))) {
    // A changed original is allowed only as the compute limit, judged by `raised` above.
    const changed = kept.filter((ix, k) => JSON.stringify(described(m, now[k]!)) !== JSON.stringify(before.get(ix)));
    if (changed.some(ix => !(isBudget(initial, initial.instructions[initialOrder.indexOf(ix)]!, 2)))) allowed = false;
  }
  return { m, allowed, assertions };
}

describe('what a wallet may add before it signs (Lighthouse), fuzzed', () => {
  it('is accepted exactly when every change is one Phantom may make, and at least one assertion was added', async () => {
    const all = await bases();
    const seen = { acceptedChanged: 0, refused: 0 };
    await fc.assert(fc.asyncProperty(fc.nat({ max: all.length - 1 }), fc.array(edit, { minLength: 1, maxLength: 5 }), async (b, edits) => {
      const base = all[b]!;
      const { m, allowed, assertions } = apply(base, edits);
      let messageBytes: Uint8Array;
      try {
        messageBytes = encode(m);
      } catch {
        // An edit list that leaves no valid message (a wallet could not send it either).
        return;
      }
      const same = messageBytes.length === base.tx.messageBytes.length && messageBytes.every((x, i) => x === base.tx.messageBytes[i]);
      const changed = { ...base.tx, messageBytes } as unknown as Transaction;
      const signed = await partiallySignTransaction([base.owner.keyPair], changed);

      const lenient = await verifyWalletReturn(base.tx, wire(signed), base.owner.address, base.E, { acceptAssertions: true });
      const strict = await verifyWalletReturn(base.tx, wire(signed), base.owner.address, base.E);
      const expected = same || (allowed && assertions > 0);
      if (lenient.ok !== expected) {
        throw new Error(`accepted=${lenient.ok}, expected ${expected} for ${JSON.stringify(edits)}: ${JSON.stringify(lenient.violations)}`);
      }
      expect(strict.ok).toBe(same);
      if (lenient.ok) {
        // What E would sign is exactly what the wallet signed.
        expect([...lenient.transaction!.messageBytes]).toEqual([...messageBytes]);
        if (!same) seen.acceptedChanged++;
      } else {
        seen.refused++;
      }
    }), PARAMS);
    // Both sides of the rule were reached, so neither is passing vacuously.
    expect(seen.acceptedChanged).toBeGreaterThan(0);
    expect(seen.refused).toBeGreaterThan(0);
  }, TIMEOUT);
});
