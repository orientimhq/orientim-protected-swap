/**
 * Any change to an honest transaction, fuzzed: bytes flipped, set, inserted or cut anywhere in the
 * message, and instructions dropped, repeated, reordered, rewritten or added (several at once, so
 * attacks are combined, not only tried one at a time). Two promises must hold for every case:
 *
 * 1. the verifier answers with a verdict: it never throws, whatever the bytes are;
 * 2. when it accepts a changed transaction, the change cannot hurt the wallet. That is judged here
 *    independently of the verifier's own rules, by what the transaction does: the same two signers
 *    with the wallet paying; every instruction Orientim wrote unchanged; the route spending no more
 *    than the approved amount, with its own floor at the minimum, delivering where it must, and
 *    writing only to accounts the honest route wrote to; the network fee within its limit.
 *
 * Bytes a change may touch freely (the blockhash, which pools the route passes in which order) pass
 * both, as they must: the route is Jupiter's to lay out, and the checks after it are Orientim's.
 *
 * `npm run test:fuzz` runs 100,000 cases per property; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AccountRole, createNoopSigner, decompileTransactionMessage, getCompiledTransactionMessageDecoder,
  getTransactionMessagePriorityFeeLamports, isSignerRole, isWritableRole,
} from '@solana/kit';
import type { Address, Instruction, Transaction } from '@solana/kit';
import { getApproveInstruction, getCloseAccountInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import { getTransferSolInstruction } from '@solana-program/system';
import { COMPUTE_BUDGET_PROGRAM, compileProtectedSwap, JUPITER_PROGRAM, protectedInstructions, WSOL_MINT } from '@orientim/core';
import type { TxVersion } from '@orientim/core';
import { jupiterDestination, jupiterFloor, jupiterRouteArgs, verify } from '../src/index.ts';
import { BONK, compileRaw, cuIxs, LIFETIME, randomAddress, scenario, USDC, WIF } from './fixtures.ts';
import type { Scenario } from './fixtures.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 100_000 : 300));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 30;
const LAMPORTS_PER_SIGNATURE = 5_000n;

type Ix = { programAddress: Address; accounts: { address: Address; role: AccountRole }[]; data: Uint8Array };
type World = { sc: Scenario; version: TxVersion; tx: Transaction; honest: Ix[]; attacker: Address };

/** The instructions a message runs, with every account resolved, or null when they cannot be. */
function resolve(tx: Transaction, sc: Scenario): { ixs: Ix[]; signers: Address[]; payer: Address; priorityFee: bigint } | null {
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const msg = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: sc.snapshot.lookupTables as never });
    const ixs = (msg.instructions as readonly Instruction[]).map(ix => ({
      programAddress: ix.programAddress,
      accounts: (ix.accounts ?? []).map(a => ({ address: a.address, role: a.role })),
      data: Uint8Array.from((ix.data ?? []) as ArrayLike<number>),
    }));
    let priorityFee = 0n;
    if (compiled.version === 0) {
      const limit = ixs.find(ix => ix.programAddress === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 2);
      const price = ixs.find(ix => ix.programAddress === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 3);
      if (limit && price) {
        const units = BigInt(new DataView(limit.data.buffer).getUint32(1, true));
        priorityFee = (units * new DataView(price.data.buffer).getBigUint64(1, true) + 999_999n) / 1_000_000n;
      }
    } else {
      priorityFee = getTransactionMessagePriorityFeeLamports(msg as never) ?? 0n;
    }
    return {
      ixs, signers: compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts) as Address[],
      payer: compiled.staticAccounts[0] as Address, priorityFee,
    };
  } catch {
    return null;
  }
}

const same = (a: Ix, b: Ix) =>
  a.programAddress === b.programAddress && a.data.length === b.data.length && a.data.every((x, i) => x === b.data[i])
  && a.accounts.length === b.accounts.length
  // Who signs is compared; whether an account is writable is not, since a message marks an account
  // writable for all its instructions at once, and writing still needs the owner's program and a
  // signer. Where the route may write is judged on its own below.
  && a.accounts.every((x, i) => x.address === b.accounts[i].address && isSignerRole(x.role) === isSignerRole(b.accounts[i].role));

/** Why an accepted transaction could hurt the wallet, judged by what it does; null when it cannot. */
function harm(w: World, tx: Transaction): string | null {
  const { sc } = w;
  const p = sc.policy;
  const r = resolve(tx, sc);
  if (!r) return 'accepted a message whose accounts do not resolve';
  if (r.payer !== sc.W) return 'the wallet does not pay';
  if (r.signers.length !== 2 || !r.signers.includes(sc.W) || !r.signers.includes(sc.E.address)) return `signers ${r.signers.join(',')}`;
  if (LAMPORTS_PER_SIGNATURE * 2n + r.priorityFee > p.maxNetworkFeeLamports) return `network fee ${r.priorityFee}`;
  // Every instruction Orientim wrote, unchanged and on the same side of the route: the setup before
  // it, the checks and the cleanup after it. Their order within a side may differ (two accounts
  // created, say); an order the runtime would refuse only makes the transaction fail as a whole.
  const sides = (ixs: Ix[]) => {
    const rest = ixs.filter(ix => ix.programAddress !== COMPUTE_BUDGET_PROGRAM);
    const at = rest.findIndex(ix => ix.programAddress === JUPITER_PROGRAM);
    return at < 0 ? null : [rest.slice(0, at), rest.slice(at + 1).filter(ix => ix.programAddress !== JUPITER_PROGRAM)];
  };
  const now = sides(r.ixs);
  const before = sides(w.honest)!;
  if (!now) return 'no route';
  for (const k of [0, 1]) {
    const left = [...before[k]];
    for (const ix of now[k]) {
      const at = left.findIndex(x => same(x, ix));
      if (at < 0) return `an instruction Orientim did not write, or wrote elsewhere: ${ix.programAddress} ${Array.from(ix.data.slice(0, 1))}`;
      left.splice(at, 1);
    }
    // A hop's account is Jupiter's to need or not: when the route does not pass through it, it is
    // neither opened nor closed. Anything else missing, or a hop opened and never closed (its rent
    // would stay behind), is a change to what Orientim wrote.
    const hop = (ix: Ix) => sc.intermediates.map(x => x.ata).find(a => ix.accounts.some(acc => acc.address === a));
    for (const ix of left) {
      const ata = hop(ix);
      if (!ata) return 'an instruction Orientim wrote is missing';
      const stillThere = [...now[0], ...now[1]].some(x => hop(x) === ata);
      if (stillThere) return `the hop account ${ata} is opened or closed but not both`;
    }
  }
  const routes = r.ixs.filter(ix => ix.programAddress === JUPITER_PROGRAM);
  if (routes.length !== 1) return `${routes.length} routes`;
  const route = routes[0];
  const honestRoute = w.honest.find(ix => ix.programAddress === JUPITER_PROGRAM)!;
  // The wallet's own accounts are never the route's to touch, whatever their role: only the account
  // the output must reach, which the honest route names too.
  const walletAccounts = new Set<string>([sc.W, sc.wOther, ...(p.accounts.wIn ? [p.accounts.wIn] : [])]);
  const named = new Set(honestRoute.accounts.map(a => a.address));
  for (const a of route.accounts) {
    if (walletAccounts.has(a.address)) return `the route names the wallet's account ${a.address}`;
    if (isSignerRole(a.role) && a.address !== sc.E.address) return `the route has signer ${a.address}`;
    if (isWritableRole(a.role) && !named.has(a.address)) return `the route writes to ${a.address}, which the honest route never named`;
  }
  const args = jupiterRouteArgs(route.data);
  if (!args) return 'the route cannot be read';
  if (args.inAmount <= 0n || args.inAmount > p.swapAmount) return `the route spends ${args.inAmount}`;
  if (jupiterFloor(args) < p.minOut) return `the route's floor is ${jupiterFloor(args)}`;
  if (args.slippageBps > 300) return `the route tolerates ${args.slippageBps} bps`;
  const destination = jupiterDestination(route.data, route.accounts.map(a => a.address));
  if (destination !== (p.variant === 'A' ? p.accounts.eOut : p.accounts.wOut)) return `the route delivers to ${destination}`;
  return null;
}

const PAIRS: [Address, Address][] = [[USDC, WSOL_MINT], [WSOL_MINT, USDC], [USDC, BONK]];

async function world(pair: [Address, Address], version: TxVersion, fee: boolean, intermediates: number): Promise<World> {
  const sc = await scenario({ input: pair[0], output: pair[1], fee, intermediates, poolCount: 6 });
  const tx = compileProtectedSwap({
    policy: sc.policy, swapInstruction: sc.swapIx, intermediates: sc.intermediates, version,
    lifetime: LIFETIME, computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, priorityFeeLamports: 20_000n,
    lookupTables: version === 0 ? sc.lookupTables : undefined, outputBalanceBefore: sc.wOutBalance,
  }).transaction;
  const honest = resolve(tx, sc)!.ixs;
  return { sc, version, tx, honest, attacker: await randomAddress() };
}

describe('any change to an honest transaction', () => {
  // Worlds are built once: the case is the change, not the keys.
  const worlds: World[] = [];
  beforeAll(async () => {
    for (const pair of PAIRS) for (const version of [0, 1] as TxVersion[]) for (const fee of [true, false]) {
      worlds.push(await world(pair, version, fee, pair[1] === BONK ? 1 : 0));
    }
  });

  const byteEdit = fc.record({
    how: fc.constantFrom('xor', 'set', 'insert', 'cut'),
    at: fc.nat(),
    value: fc.integer({ min: 0, max: 255 }),
  });

  it('bytes changed anywhere: a verdict every time, and nothing harmful accepted', async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat(), fc.array(byteEdit, { minLength: 1, maxLength: 4 }), async (pick, edits) => {
        const w = worlds[pick % worlds.length];
        let bytes = Array.from(w.tx.messageBytes);
        for (const e of edits) {
          const i = e.at % (bytes.length + (e.how === 'insert' ? 1 : 0));
          if (e.how === 'xor') bytes[i] ^= e.value || 1;
          else if (e.how === 'set') bytes[i] = e.value;
          else if (e.how === 'insert') bytes.splice(i, 0, e.value);
          else if (bytes.length > 1) bytes.splice(i, 1);
        }
        const tx = { ...w.tx, messageBytes: Uint8Array.from(bytes) as never };
        const v = await verify(tx, w.sc.policy, w.sc.snapshot);
        if (v.ok) expect(harm(w, tx)).toBeNull();
        else expect(v.violations.length).toBeGreaterThan(0);
      }),
      PARAMS,
    );
  }, TIMEOUT);

  // What an attacker who rebuilds the transaction can do with the instruction list, several at once.
  const ixEdit = fc.record({
    how: fc.constantFrom(
      'drop', 'repeat', 'swap', 'approve', 'stealSol', 'stealTokens', 'closeToAttacker', 'reroute', 'amount', 'role', 'routeArgs',
    ),
    a: fc.nat(),
    b: fc.nat(),
    amount: fc.bigInt({ min: 1n, max: 2n ** 64n - 1n }),
  });

  it('instructions dropped, repeated, reordered, rewritten or added, several at once: nothing harmful accepted', async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat(), fc.array(ixEdit, { minLength: 1, maxLength: 4 }), async (pick, edits) => {
        const w = worlds[pick % worlds.length];
        const { sc } = w;
        const p = sc.policy;
        const W = createNoopSigner(sc.W);
        const E = createNoopSigner(sc.E.address);
        let ixs: Instruction[] = protectedInstructions({ policy: p, swapInstruction: sc.swapIx, intermediates: sc.intermediates });
        const victims = [sc.W, sc.E.address, w.attacker, sc.wOther, p.accounts.eIn, ...(p.accounts.wIn ? [p.accounts.wIn] : []), ...(p.accounts.wOut ? [p.accounts.wOut] : [])];
        for (const e of edits) {
          const i = e.a % ixs.length;
          const j = e.b % ixs.length;
          switch (e.how) {
            case 'drop': if (ixs.length > 1) ixs.splice(i, 1); break;
            case 'repeat': ixs.splice(j, 0, ixs[i]); break;
            case 'swap': [ixs[i], ixs[j]] = [ixs[j], ixs[i]]; break;
            case 'approve':
              ixs.splice(j, 0, getApproveInstruction({ source: p.accounts.wIn ?? sc.wOther, delegate: w.attacker, owner: W, amount: e.amount }));
              break;
            case 'stealSol': ixs.splice(j, 0, getTransferSolInstruction({ source: W, destination: w.attacker, amount: e.amount })); break;
            case 'stealTokens':
              ixs.splice(j, 0, getTransferCheckedInstruction({ source: sc.wOther, mint: WIF, destination: w.attacker, authority: W, amount: e.amount, decimals: 6 }));
              break;
            case 'closeToAttacker': ixs.splice(j, 0, getCloseAccountInstruction({ account: p.accounts.eIn, destination: w.attacker, owner: E })); break;
            case 'reroute': {
              // One account of an instruction replaced by another the attacker would like there.
              const ix = ixs[i];
              if (!ix.accounts?.length) break;
              const k = e.b % ix.accounts.length;
              const accounts = [...ix.accounts];
              accounts[k] = { ...accounts[k], address: victims[Number(e.amount % BigInt(victims.length))] };
              ixs[i] = { ...ix, accounts };
              break;
            }
            case 'amount': {
              // Any eight bytes of an instruction's data replaced by another number.
              const ix = ixs[i];
              const data = Uint8Array.from((ix.data ?? []) as ArrayLike<number>);
              if (data.length < 9) break;
              new DataView(data.buffer).setBigUint64(1 + (e.b % (data.length - 8)), e.amount, true);
              ixs[i] = { ...ix, data };
              break;
            }
            case 'role': {
              const ix = ixs[i];
              if (!ix.accounts?.length) break;
              const k = e.b % ix.accounts.length;
              const accounts = [...ix.accounts];
              accounts[k] = { ...accounts[k], role: [AccountRole.READONLY, AccountRole.WRITABLE, AccountRole.READONLY_SIGNER, AccountRole.WRITABLE_SIGNER][Number(e.amount % 4n)] };
              ixs[i] = { ...ix, accounts };
              break;
            }
            case 'routeArgs': {
              // The route's amount in, quote and tolerance, as a lying builder would set them.
              const at = ixs.findIndex(ix => ix.programAddress === JUPITER_PROGRAM);
              if (at < 0) break;
              const data = Uint8Array.from(ixs[at].data as ArrayLike<number>);
              const v = new DataView(data.buffer);
              const field = e.b % 3;
              if (field === 0) v.setBigUint64(8, e.amount, true);
              else if (field === 1) v.setBigUint64(16, e.amount, true);
              else v.setUint16(24, Number(e.amount % 10_001n), true);
              ixs[at] = { ...ixs[at], data };
              break;
            }
          }
        }
        let tx: Transaction;
        try {
          tx = compileRaw(sc.W, w.version === 0 ? [...cuIxs(), ...ixs] : ixs, w.version, w.version === 0 ? sc.lookupTables : undefined);
        } catch {
          return; // a list that cannot even be compiled is never signed
        }
        const v = await verify(tx, p, sc.snapshot);
        if (v.ok) expect(harm(w, tx)).toBeNull();
      }),
      PARAMS,
    );
  }, TIMEOUT);
});
