import { describe, expect, it } from 'vitest';
import {
  AccountRole, address, generateKeyPairSigner, getAddressEncoder, getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import {
  AuthorityType, getApproveInstruction, getCloseAccountInstruction, getSetAuthorityInstruction,
} from '@solana-program/token';
import { getAssignInstruction, getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner } from '@solana/kit';
import {
  compileProtectedSwap, JUPITER_PROGRAM, MAX_TAKER_RENT_LAMPORTS, protectedInstructions, PUMP_AMM_PROGRAM, PUMP_CURVE_PROGRAM,
  routeAccountOf, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, withTakerRent, WSOL_MINT,
} from '@orientim/core';
import type { AccountState, RuleId, TxVersion } from '@orientim/core';
import { verify } from '../src/index.ts';
import { BONK, compileRaw, cuIxs, honest, JUP, LIFETIME, randomAddress, routeV2Data, scenario, USDC } from './fixtures.ts';
import type { Scenario } from './fixtures.ts';

const rules = (v: { violations: { rule: RuleId }[] }) => [...new Set(v.violations.map(x => x.rule))];

async function compileHonest(s: Scenario, version: TxVersion) {
  return compileProtectedSwap({
    policy: s.policy, swapInstruction: s.swapIx, intermediates: s.intermediates, version, lifetime: LIFETIME,
    computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, priorityFeeLamports: 20_000n,
    lookupTables: version === 0 ? s.lookupTables : undefined, outputBalanceBefore: s.wOutBalance,
  }).transaction;
}

/** Compile a mutated instruction list with the same shape the honest compiler uses. */
const mutated = (s: Scenario, ixs: Instruction[], version: TxVersion = 0, alt = version === 0) =>
  compileRaw(s.W, version === 0 ? [...cuIxs(), ...ixs] : ixs, version, alt ? s.lookupTables : undefined);

const swapIndex = (ixs: Instruction[]) => ixs.findIndex(ix => ix.programAddress === JUPITER_PROGRAM);

const withSwapAccounts = (s: Scenario, extra: { address: Address; role: AccountRole }[]) => {
  const ixs = honest(s);
  const i = swapIndex(ixs);
  ixs[i] = { ...ixs[i], accounts: [...(ixs[i].accounts ?? []), ...extra] };
  return ixs;
};

describe('honest protected swaps are accepted', () => {
  const cases: [string, Parameters<typeof scenario>[0]][] = [
    ['A: USDC → SOL', {}],
    ['B: SOL → USDC', { input: WSOL_MINT, output: USDC }],
    ['C: USDC → BONK', { input: USDC, output: BONK }],
    ['no fee (test mode)', { fee: false }],
    ['no fee account: fee waived', { feeAccountExists: false }],
    ['two intermediate accounts', { input: USDC, output: BONK, intermediates: 2 }],
  ];
  for (const [name, opts] of cases) {
    for (const version of [0, 1] as const) {
      it(`${name}, v${version}`, async () => {
        const s = await scenario(opts);
        const verdict = await verify(await compileHonest(s, version), s.policy, s.snapshot);
        expect(verdict.violations).toEqual([]);
        expect(verdict.ok).toBe(true);
      });
    }
  }
});

describe('T2: mutation catalogue (plan, section 9)', () => {
  it('M1: W in the swap instruction → R1', async () => {
    const s = await scenario();
    const v = await verify(mutated(s, withSwapAccounts(s, [{ address: s.W, role: AccountRole.WRITABLE }])), s.policy, s.snapshot);
    expect(rules(v)).toContain('R1');
  });

  it("M2: W's input token account hidden in an ALT → R1", async () => {
    const s = await scenario();
    s.lookupTables[s.lookupTable].push(s.policy.accounts.wIn!);
    const tx = mutated(s, withSwapAccounts(s, [{ address: s.policy.accounts.wIn!, role: AccountRole.READONLY }]));
    const v = await verify(tx, s.policy, s.snapshot);
    expect(rules(v)).toContain('R1');
  });

  it("M3: W's input token account passed directly → R1", async () => {
    const s = await scenario();
    const tx = mutated(s, withSwapAccounts(s, [{ address: s.policy.accounts.wIn!, role: AccountRole.WRITABLE }]), 1);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R1');
  });

  it("M4: another of W's token accounts (WIF) via an ALT → R1", async () => {
    const s = await scenario();
    s.lookupTables[s.lookupTable].push(s.wOther);
    const tx = mutated(s, withSwapAccounts(s, [{ address: s.wOther, role: AccountRole.WRITABLE }]));
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R1');
  });

  it('M5: an added Approve → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    ixs.splice(1, 0, getApproveInstruction({ source: s.policy.accounts.wIn!, delegate: s.E.address, owner: createNoopSigner(s.W), amount: 10n ** 12n }));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it("M6: SetAuthority on one of W's accounts → R2", async () => {
    const s = await scenario();
    const attacker = await randomAddress();
    const ixs = honest(s);
    ixs.push(getSetAuthorityInstruction({ owned: s.wOther, owner: createNoopSigner(s.W), authorityType: AuthorityType.AccountOwner, newAuthority: attacker }));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('M7: CloseAccount to the attacker → R2', async () => {
    const s = await scenario();
    const attacker = await randomAddress();
    const ixs = honest(s).map(ix =>
      ix.data?.[0] === 9 && ix.accounts?.[0].address === s.policy.accounts.eIn
        ? getCloseAccountInstruction({ account: s.policy.accounts.eIn, destination: attacker, owner: createNoopSigner(s.E.address) })
        : ix,
    );
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('M8: the input transfer is q − f + 1 → R2', async () => {
    const s = await scenario();
    const evil = { ...s.policy, swapAmount: s.policy.swapAmount + 1n };
    const tx = compileProtectedSwap({
      policy: evil, swapInstruction: s.swapIx, intermediates: [], version: 0, lifetime: LIFETIME,
      computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, lookupTables: s.lookupTables,
    }).transaction;
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R2');
  });

  it('M9: a program other than Jupiter as the swap → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    const i = swapIndex(ixs);
    ixs[i] = { ...ixs[i], programAddress: await randomAddress() };
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('M10: two untrusted instructions → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    ixs.splice(swapIndex(ixs), 0, s.swapIx);
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('M11: E already exists on chain with a balance → R3', async () => {
    const s = await scenario();
    (s.snapshot.accounts as Map<string, unknown>).set(s.E.address, { owner: s.W, lamports: 5_000_000n, data: new Uint8Array() });
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R3');
  });

  it('M12: an extreme compute unit price → R4', async () => {
    const s = await scenario();
    const tx = compileRaw(s.W, [...cuIxs(1_400_000, 10_000_000n), ...honest(s)], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R4');
  });

  it('M13: missing compute unit limit (v0) → R4', async () => {
    const s = await scenario();
    const tx = compileRaw(s.W, [cuIxs()[1], ...honest(s)], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R4');
  });

  it('M14a: the E_in close is missing → R5', async () => {
    const s = await scenario();
    const ixs = honest(s).filter(ix => !(ix.data?.[0] === 9 && ix.accounts?.[0].address === s.policy.accounts.eIn));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R5');
  });

  it('M14b: a v0 transaction over 1232 bytes → R5', async () => {
    const s = await scenario({ poolCount: 40 });
    const tx = mutated(s, honest(s), 0, false);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R5');
  });

  it('M15a: a third signer → R6', async () => {
    const s = await scenario();
    const tx = mutated(s, withSwapAccounts(s, [{ address: await randomAddress(), role: AccountRole.READONLY_SIGNER }]));
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R6');
  });

  it('M15b: someone else pays the fee → R6', async () => {
    const s = await scenario();
    const tx = compileRaw(await randomAddress(), [...cuIxs(), ...honest(s)], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R6');
  });

  it('M16: the mint belongs to another token program than the policy says → R2', async () => {
    const s = await scenario();
    (s.snapshot.accounts as Map<string, unknown>).set(USDC, { owner: TOKEN_2022_PROGRAM, lamports: 1n, data: new Uint8Array(82) });
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R2');
  });

  it('M17: an account loaded twice, statically and through an ALT → R5', async () => {
    const s = await scenario();
    const honestTx = await compileHonest(s, 0);
    const compiled = getCompiledTransactionMessageDecoder().decode(honestTx.messageBytes) as unknown as {
      staticAccounts: Address[];
      addressTableLookups?: { lookupTableAddress: Address; writableIndexes: number[]; readonlyIndexes: number[] }[];
    };
    // The last static account, loaded a second time as the very last lookup entry: no instruction
    // refers to it, so nothing else in the message shifts and only the duplicate is wrong.
    const dup = compiled.staticAccounts[compiled.staticAccounts.length - 1];
    s.lookupTables[s.lookupTable].push(dup);
    const index = s.lookupTables[s.lookupTable].length - 1;
    const lookups = compiled.addressTableLookups ?? [];
    const last = lookups[lookups.length - 1];
    if (last && last.lookupTableAddress === s.lookupTable) last.readonlyIndexes = [...last.readonlyIndexes, index];
    else lookups.push({ lookupTableAddress: s.lookupTable, writableIndexes: [], readonlyIndexes: [index] });
    compiled.addressTableLookups = lookups;
    const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled as never);
    const tx = { ...honestTx, messageBytes } as typeof honestTx;
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R5');
  });
});

/**
 * Token-2022 (phase 3). A mint is swappable only with extensions that cannot touch the swap; the
 * addresses, the transfers and the closes must all use the program the mint really belongs to.
 */
describe('Token-2022', () => {
  const t22 = (extensions: [number, number][]) => scenario({
    input: USDC, output: BONK, inputProgram: TOKEN_2022_PROGRAM, outputProgram: TOKEN_PROGRAM,
    inputExtensions: extensions,
  });

  it('an honest swap of a Token-2022 token with metadata only passes every rule', async () => {
    const s = await t22([[18, 64], [19, 120]]);
    const verdict = await verify(await compileHonest(s, 0), s.policy, s.snapshot);
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('a declared transfer hook with no program set runs no code, so it is accepted', async () => {
    const s = await t22([[18, 64], [14, 64]]);
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).ok).toBe(true);
  });

  it('a transfer hook with a real program → R7', async () => {
    const s = await t22([[14, 64]]);
    const mint = s.snapshot.accounts.get(USDC)!;
    mint.data[166 + 4 + 32] = 7; // a non-zero program id
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R7');
  });

  // The delegates the real tokens use, read from mainnet on 2026-09-22: PYUSD and USDG share an
  // ordinary key; the xStocks use a program-derived address.
  const PYUSD_DELEGATE = Uint8Array.from(getAddressEncoder().encode(address('2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk')));
  const XSTOCKS_DELEGATE = Uint8Array.from(getAddressEncoder().encode(address('5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq')));
  const withDelegate = async (delegate: Uint8Array) => {
    const s = await t22([[12, 32]]);
    s.snapshot.accounts.get(USDC)!.data.set(delegate, 166 + 4);
    return s;
  };

  it('a permanent delegate that is an ordinary key can act only by signing, so it is accepted', async () => {
    const s = await withDelegate(PYUSD_DELEGATE);
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).violations).toEqual([]);
  });

  it('a permanent delegate that a program can sign for → R7', async () => {
    const s = await withDelegate(XSTOCKS_DELEGATE);
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R7');
  });

  it('new accounts that start initialized change nothing, so the default-state extension is accepted', async () => {
    const s = await t22([[6, 1]]);
    s.snapshot.accounts.get(USDC)!.data[166 + 4] = 1; // AccountState::Initialized
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).violations).toEqual([]);
  });

  it('the fee on confidential transfers never touches a public one, so it is accepted', async () => {
    const s = await t22([[4, 65], [16, 129]]);
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).violations).toEqual([]);
  });

  it('PYUSD\'s own set of extensions passes every rule', async () => {
    const s = await t22([[3, 32], [12, 32], [1, 108], [4, 65], [16, 129], [14, 64], [18, 64], [19, 174]]);
    const mint = s.snapshot.accounts.get(USDC)!.data;
    mint.set(PYUSD_DELEGATE, 166 + 4 + 32 + 4); // after MintCloseAuthority
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).violations).toEqual([]);
  });

  it.each([
    ['accounts frozen by default', 6, 1, 2],
    ['a default state that is not a state at all', 6, 1, 0],
  ])('%s → R7', async (_name, type, length, state) => {
    const s = await t22([[type, length]]);
    s.snapshot.accounts.get(USDC)!.data[166 + 4] = state;
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R7');
  });

  it.each([
    ['a default-state extension of the wrong size', 6, 2],
    ['a permanent-delegate extension of the wrong size', 12, 31],
    ['a confidential-fee extension of the wrong size', 16, 128],
    ['an interest-bearing mint', 10, 52],
    ['a scaled UI amount', 25, 24],
    ['a pausable mint', 26, 33],
    ['an extension nobody has read yet', 250, 8],
  ])('%s → R7', async (_name, type, length) => {
    const s = await t22([[18, 64], [type, length]]);
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R7');
  });

  it('the output side works the same way', async () => {
    const s = await scenario({
      input: USDC, output: BONK, outputProgram: TOKEN_2022_PROGRAM, outputExtensions: [[18, 64]],
    });
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).ok).toBe(true);
  });

  it('a token that taxes its transfers is accepted, with the withheld fees harvested before the close', async () => {
    const s = await t22([[18, 64], [1, 108]]);
    expect(s.policy.inputTransferFee).toBe(true);
    const verdict = await verify(await compileHonest(s, 0), s.policy, s.snapshot);
    expect(verdict.violations).toEqual([]);
  });

  it('without the harvest, the temporary account could not be closed → R5', async () => {
    const s = await t22([[18, 64], [1, 108]]);
    const ixs = honest(s).filter(ix => !(ix.data?.[0] === 26)); // drop HarvestWithheldTokensToMint
    const tx = compileRaw(s.W, [...cuIxs(), ...ixs], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R5');
  });

  it('harvesting after the close is refused → R5', async () => {
    const s = await t22([[18, 64], [1, 108]]);
    const ixs = honest(s);
    const at = ixs.findIndex(ix => ix.data?.[0] === 26);
    ixs.splice(at + 2, 0, ...ixs.splice(at, 1)); // move the harvest past the close
    const tx = compileRaw(s.W, [...cuIxs(), ...ixs], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R5');
  });

  it('a policy that hides the transfer fee → R2', async () => {
    const s = await t22([[18, 64], [1, 108]]);
    const lying = { ...s.policy, inputTransferFee: false };
    expect(rules(await verify(await compileHonest(s, 0), lying, s.snapshot))).toContain('R2');
  });

  it('an extension whose declared length disagrees with the program layout → R7', async () => {
    const s = await t22([[18, 64], [14, 32]]); // a transfer hook is 64 bytes, never 32
    expect(rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot))).toContain('R7');
  });

  it('bytes left over after the last extension → R7, unless they are zeros, where nothing can be read', async () => {
    const withTail = async (tail: number[]) => {
      const s = await t22([[18, 64]]);
      const mint = s.snapshot.accounts.get(USDC)!;
      const padded = { ...mint, data: new Uint8Array(mint.data.length + tail.length) };
      padded.data.set(mint.data);
      padded.data.set(tail, mint.data.length);
      (s.snapshot.accounts as Map<string, unknown>).set(USDC, padded);
      return rules(await verify(await compileHonest(s, 0), s.policy, s.snapshot));
    };
    expect(await withTail([14, 0, 64])).toContain('R7');
    expect(await withTail([0, 0, 0])).not.toContain('R7');
  });

  it('a Token-2022 swap compiled with the classic program is refused', async () => {
    const s = await t22([[18, 64]]);
    // The policy is honest, but the transaction is built as if the mint were a classic token.
    const classic = { ...s.policy, inputTokenProgram: TOKEN_PROGRAM };
    const tx = compileRaw(s.W, [...cuIxs(), ...protectedInstructions({
      policy: classic, swapInstruction: s.swapIx, intermediates: s.intermediates, outputBalanceBefore: s.wOutBalance,
    })], 0, s.lookupTables);
    expect((await verify(tx, s.policy, s.snapshot)).ok).toBe(false);
  });
});

describe('more attacks', () => {
  it('a SOL transfer from W to the attacker → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    ixs.splice(2, 0, getTransferSolInstruction({ source: createNoopSigner(s.W), destination: await randomAddress(), amount: 1n }));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('System Assign of W → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    ixs.push(getAssignInstruction({ account: createNoopSigner(s.W), programAddress: await randomAddress() }));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('a ComputeBudget instruction inside a v1 transaction → R4', async () => {
    const s = await scenario();
    const tx = compileRaw(s.W, [cuIxs()[0], ...honest(s)], 1);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R4');
  });

  it('an intermediate account that is created but never closed → R5', async () => {
    const s = await scenario({ input: USDC, output: BONK, intermediates: 1 });
    const mid = s.intermediates[0].ata;
    const ixs = honest(s).filter(ix => !(ix.data?.[0] === 9 && ix.accounts?.[0].address === mid));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R5');
  });

  it('a swap placed before the input transfer → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    const [swap] = ixs.splice(swapIndex(ixs), 1);
    ixs.unshift(swap);
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('an ALT the verifier cannot resolve → R1', async () => {
    const s = await scenario();
    const tx = await compileHonest(s, 0);
    const v = await verify(tx, s.policy, { ...s.snapshot, lookupTables: {} });
    expect(rules(v)).toContain('R1');
  });

  it('a policy whose fee does not match the config → R2', async () => {
    const s = await scenario();
    const tx = await compileHonest(s, 0);
    const v = await verify(tx, { ...s.policy, fee: s.policy.fee - 1n, swapAmount: s.policy.swapAmount + 1n }, s.snapshot);
    expect(rules(v)).toContain('R2');
  });

  it('the fee transfer redirected to another account → R2', async () => {
    const s = await scenario();
    const evil = { ...s.policy, accounts: { ...s.policy.accounts, feeDestination: await randomAddress() } };
    const tx = compileProtectedSwap({
      policy: evil, swapInstruction: s.swapIx, intermediates: [], version: 1, lifetime: LIFETIME,
      computeUnitLimit: 400_000, priorityFeeLamports: 20_000n,
    }).transaction;
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R2');
  });

  it('a signer other than E owning a temporary account', async () => {
    const s = await scenario();
    const other = await generateKeyPairSigner();
    const ixs = honest(s).map(ix =>
      ix.data?.[0] === 9 && ix.accounts?.[0].address === s.policy.accounts.eIn
        ? getCloseAccountInstruction({ account: s.policy.accounts.eIn, destination: s.W, owner: createNoopSigner(other.address) })
        : ix,
    );
    const v = await verify(mutated(s, ixs), s.policy, s.snapshot);
    expect(v.ok).toBe(false);
    expect(rules(v)).toEqual(expect.arrayContaining(['R2', 'R6']));
  });
});

describe('rent a route needs the temporary key to pay (PumpSwap)', () => {
  // PumpSwap opens a per-buyer account and charges its rent to the buyer, which here is E.
  const RENT = 1_346_200n;
  const withRent = async (opts: Parameters<typeof scenario>[0] = {}) => {
    const s = await scenario(opts);
    return { ...s, policy: withTakerRent(s.policy, RENT) };
  };
  const rentTransfer = (s: Awaited<ReturnType<typeof withRent>>, lamports: bigint, to: Address = s.E.address) =>
    getTransferSolInstruction({ source: createNoopSigner(s.W), destination: to, amount: lamports });

  for (const [name, opts] of [
    ['A: token → SOL', {}], ['B: SOL → token', { input: WSOL_MINT, output: USDC }], ['C: token → token', { input: USDC, output: BONK }],
  ] as const) {
    for (const version of [0, 1] as const) {
      it(`exactly the measured rent to E is accepted, ${name}, v${version}`, async () => {
        const s = await withRent(opts);
        expect((await verify(await compileHonest(s, version), s.policy, s.snapshot)).violations).toEqual([]);
      });
    }
  }

  it('one lamport more than the policy states → R2', async () => {
    const s = await withRent();
    const ixs = honest(s).map(ix => (ix.programAddress === '11111111111111111111111111111111' && ix.accounts?.[1].address === s.E.address
      ? rentTransfer(s, RENT + 1n) : ix));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('the rent sent to anyone but E → R2', async () => {
    const s = await withRent();
    const other = await randomAddress();
    const ixs = honest(s).map(ix => (ix.programAddress === '11111111111111111111111111111111' && ix.accounts?.[1].address === s.E.address
      ? rentTransfer(s, RENT, other) : ix));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('SOL for E when the policy states none → R2', async () => {
    const s = await scenario();
    const ixs = honest(s);
    ixs.splice(swapIndex(ixs), 0, getTransferSolInstruction({ source: createNoopSigner(s.W), destination: s.E.address, amount: RENT }));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('the rent the policy states, but missing from the transaction → R4', async () => {
    const s = await withRent();
    const ixs = honest(s).filter(ix => !(ix.programAddress === '11111111111111111111111111111111' && ix.accounts?.[1].address === s.E.address));
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R4');
  });

  it('the rent sent after the swap → R2', async () => {
    const s = await withRent();
    const ixs = honest(s);
    const at = ixs.findIndex(ix => ix.programAddress === '11111111111111111111111111111111' && ix.accounts?.[1].address === s.E.address);
    const [rent] = ixs.splice(at, 1);
    ixs.splice(swapIndex(ixs) + 1, 0, rent);
    expect(rules(await verify(mutated(s, ixs), s.policy, s.snapshot))).toContain('R2');
  });

  it('a policy asking for more than the ceiling → R4, whatever the transaction says', async () => {
    const s = await scenario();
    const policy = { ...s.policy, takerRent: MAX_TAKER_RENT_LAMPORTS + 1n };
    const ixs = honest({ ...s, policy });
    expect(rules(await verify(mutated(s, ixs), policy, s.snapshot))).toContain('R4');
  });

  it('the certificate states the rent, so the page can show it', async () => {
    const s = await withRent();
    const { certify } = await import('../src/index.ts');
    const c = await certify(await compileHonest(s, 0), s.policy, s.snapshot);
    expect(c.ok && c.certificate.routeRentLamports).toBe(RENT);
  });
});

const details = (v: { violations: { detail: string }[] }) => v.violations.map(x => x.detail);

describe('each load-bearing check has a test of its own', () => {
  it('W in the swap is refused by its own check, also when W is in the snapshot as it is in production', async () => {
    const s = await scenario();
    (s.snapshot.accounts as Map<string, AccountState | null>).set(s.W, { owner: SYSTEM_PROGRAM, lamports: 5_000_000_000n, data: new Uint8Array() });
    const v = await verify(mutated(s, withSwapAccounts(s, [{ address: s.W, role: AccountRole.READONLY }])), s.policy, s.snapshot);
    expect(details(v)).toContain('the wallet is passed to the external program');
  });

  it('E as the fee payer is refused by the fee-payer check (the signer set alone would pass)', async () => {
    const s = await scenario();
    const v = await verify(compileRaw(s.E.address, [...cuIxs(), ...honest(s)], 0, s.lookupTables), s.policy, s.snapshot);
    expect(details(v)).toContain('the fee payer is not the wallet');
  });

  it('the minimum-output check placed before the swap is refused', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    const ixs = honest(s);
    const floor = ixs.findIndex(ix => ix.programAddress === TOKEN_PROGRAM && ix.data?.[0] === 12
      && ix.accounts?.[0].address === s.policy.accounts.wOut && ix.accounts?.[2].address === s.policy.accounts.wOut);
    const [check] = ixs.splice(floor, 1);
    ixs.splice(swapIndex(ixs), 0, check);
    const v = await verify(mutated(s, ixs), s.policy, s.snapshot);
    expect(details(v)).toContain('minOutCheck must run after the swap');
  });
});

describe("Jupiter's own floor is read from its instruction", () => {
  const withData = (s: Scenario, data: Uint8Array, extra: { address: Address; role: AccountRole }[] = []) => {
    const ixs = withSwapAccounts(s, extra);
    const i = swapIndex(ixs);
    ixs[i] = { ...ixs[i], data };
    return ixs;
  };
  const check = async (make: (s: Scenario) => Uint8Array, opts: { curve?: boolean; maxSlippageBps?: number } = {}) => {
    const s = await scenario();
    const extra = opts.curve ? [{ address: PUMP_CURVE_PROGRAM, role: AccountRole.READONLY }] : [];
    if (opts.curve) (s.snapshot.accounts as Map<string, AccountState | null>).set(PUMP_CURVE_PROGRAM, { owner: SYSTEM_PROGRAM, lamports: 1n, data: new Uint8Array(36) });
    return verify(mutated(s, withData(s, make(s), extra)), s.policy, s.snapshot, { maxSlippageBps: opts.maxSlippageBps });
  };
  const set = (d: Uint8Array, at: number, bytes: number, value: number) => {
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (bytes === 2) v.setUint16(at, value, true);
    return d;
  };

  const sharedData = (s: Scenario) => {
    const plain = routeV2Data(s.policy.swapAmount, s.policy.minOut * 2n);
    const d = new Uint8Array(plain.length + 1);
    d.set([0xd1, 0x98, 0x53, 0x93, 0x7c, 0xfe, 0xd8, 0xe9, 7], 0);
    d.set(plain.subarray(8), 9);
    return d;
  };
  type Meta = { address: Address; role: AccountRole };
  // shared_accounts_route_v2's own layout (Jupiter's IDL): the destination is account 5.
  // Its program's own accounts are stood in for by pools the snapshot knows.
  const sharedAccounts = (accounts: readonly Meta[], s: Scenario): Meta[] => {
    const [authority, source, userDestination, inMint, outMint, inProgram, outProgram, destination, events, program, ...rest] = accounts;
    return [
      { address: s.pools[0], role: AccountRole.READONLY }, authority, source,
      { address: s.pools[1], role: AccountRole.WRITABLE }, { address: s.pools[2], role: AccountRole.WRITABLE },
      destination.address === JUPITER_PROGRAM ? userDestination : destination,
      inMint, outMint, inProgram, outProgram, events, program, ...rest,
    ];
  };
  /** The honest swap with its Jupiter accounts rearranged, and optionally its data replaced. */
  const rearranged = async (
    opts: Parameters<typeof scenario>[0],
    arrange: (accounts: Meta[], s: Scenario) => Meta[] | Promise<Meta[]>,
    data?: (s: Scenario) => Uint8Array,
  ) => {
    const s = await scenario(opts);
    const ixs = honest(s);
    const i = swapIndex(ixs);
    ixs[i] = { ...ixs[i], accounts: await arrange([...(ixs[i].accounts ?? [])] as Meta[], s), ...(data ? { data: data(s) } : {}) };
    return verify(mutated(s, ixs), s.policy, s.snapshot);
  };
  const TOKEN_OUT = { input: USDC, output: BONK };

  it('an honest route passes; so does the shared-accounts form of it', async () => {
    expect((await check(s => routeV2Data(s.policy.swapAmount, s.policy.minOut * 2n))).violations).toEqual([]);
    expect((await rearranged({}, sharedAccounts, sharedData)).violations).toEqual([]);
    expect((await rearranged(TOKEN_OUT, sharedAccounts, sharedData)).violations).toEqual([]);
  });

  it("the route must deliver to the wallet's own output account, where Jupiter measures its floor", async () => {
    const elsewhere = async (a: Meta[]) => { a[7] = { address: await randomAddress(), role: AccountRole.WRITABLE }; return a; };
    expect(details(await rearranged(TOKEN_OUT, elsewhere)).join()).toContain("not to the wallet's output account");
    // Jupiter may also name the wallet's account as its user destination and leave the optional one out.
    const asUserDestination = (a: Meta[]) => {
      a[2] = a[7];
      a[7] = { address: JUPITER_PROGRAM, role: AccountRole.READONLY };
      return a;
    };
    expect((await rearranged(TOKEN_OUT, asUserDestination)).violations).toEqual([]);
    const sharedElsewhere = async (a: Meta[], sc: Scenario) => { const x = sharedAccounts(a, sc); x[5] = { address: await randomAddress(), role: AccountRole.WRITABLE }; return x; };
    expect(details(await rearranged(TOKEN_OUT, sharedElsewhere, sharedData)).join()).toContain("not to the wallet's output account");
  });

  it('for SOL, the route must deliver to the temporary output account', async () => {
    const elsewhere = async (a: Meta[]) => { a[2] = { address: await randomAddress(), role: AccountRole.WRITABLE }; return a; };
    expect(details(await rearranged({}, elsewhere)).join()).toContain('not to the temporary output account');
    // The optional destination, when set, is where the output goes: E's account at index 2 is then not enough.
    const optional = async (a: Meta[]) => { a[7] = { address: await randomAddress(), role: AccountRole.WRITABLE }; return a; };
    expect(details(await rearranged({}, optional)).join()).toContain('not to the temporary output account');
    const cut = (a: Meta[]) => a.slice(0, 9);
    expect(details(await rearranged({}, cut)).join()).toContain('an unreadable account');
  });

  it('any other instruction of Jupiter is refused, so a new format stops swaps instead of passing unread', async () => {
    const v = await check(() => new Uint8Array([229, 23, 203, 151, 122, 227, 173, 42, 1, 2, 3, 4]));
    expect(details(v).join()).toContain('not a route Orientim can read');
  });

  it('a tolerance above 0.5% is refused, and above 3% on a bonding curve', async () => {
    expect(details(await check(s => routeV2Data(s.policy.swapAmount, s.policy.minOut * 2n, 51))).join()).toContain('tolerates 51 bps');
    expect(details(await check(s => routeV2Data(s.policy.swapAmount, s.policy.minOut * 2n, 10_000))).join()).toContain('tolerates 10000 bps');
    expect((await check(s => routeV2Data(s.policy.swapAmount, s.policy.minOut * 2n, 300), { curve: true })).violations).toEqual([]);
    expect(details(await check(s => routeV2Data(s.policy.swapAmount, s.policy.minOut * 2n, 301), { curve: true })).join()).toContain('tolerates 301 bps');
  });

  it('a tolerance the person chose on the page is the ceiling instead, on any route, and never above 15%', async () => {
    const at = (bps: number, chosen: number, curve = false) =>
      check(s => routeV2Data(s.policy.swapAmount, s.policy.minOut * 2n, bps), { curve, maxSlippageBps: chosen });
    expect((await at(1_000, 1_000)).violations).toEqual([]);
    expect(details(await at(1_001, 1_000)).join()).toContain('tolerates 1001 bps, above 1000');
    expect((await at(1_500, 20_000)).violations).toEqual([]);
    expect(details(await at(1_501, 20_000)).join()).toContain('tolerates 1501 bps, above 1500');
    // Chosen below the usual ceiling: a curve route is held to it as well.
    expect(details(await at(300, 100, true)).join()).toContain('tolerates 300 bps, above 100');
    // Not a number of bps: the usual ceilings hold.
    expect(details(await at(51, Number.NaN)).join()).toContain('tolerates 51 bps, above 50');
  });

  it('a quote below the minimum output is refused: Jupiter would enforce less than Orientim promised', async () => {
    const v = await check(s => routeV2Data(s.policy.swapAmount, s.policy.minOut - 1n));
    expect(details(v).join()).toContain('below the minimum output');
  });

  it("a minimum above Jupiter's own floor is refused, though its quote covers it", async () => {
    // Quoted one unit above the minimum at 0.5%: Jupiter would let through 0.5% less than Orientim
    // promised, and a deposit arriving with the swap could make up the rest in the balance check.
    expect(details(await check(s => routeV2Data(s.policy.swapAmount, s.policy.minOut + 1n, 50))).join()).toContain("own floor");
    // The same quote with the tolerance tightened until its floor reaches the minimum passes.
    expect((await check(s => routeV2Data(s.policy.swapAmount, s.policy.minOut + 1n, 0))).violations).toEqual([]);
  });

  it('a platform fee or positive slippage taken by the route is refused', async () => {
    expect(details(await check(s => set(routeV2Data(s.policy.swapAmount, s.policy.minOut * 2n), 26, 2, 5))).join()).toContain('platform fee');
    expect(details(await check(s => set(routeV2Data(s.policy.swapAmount, s.policy.minOut * 2n), 28, 2, 5))).join()).toContain('positive slippage');
  });

  it('an amount in above what the temporary account holds, or zero, is refused', async () => {
    expect(details(await check(s => routeV2Data(s.policy.swapAmount + 1n, s.policy.minOut * 2n))).join()).toContain('outside the approved');
    expect(details(await check(s => routeV2Data(0n, s.policy.minOut * 2n))).join()).toContain('outside the approved');
  });
});

describe("Orientim's own accounts are never loaded from a lookup table", () => {
  for (const [name, pick] of [
    ['W_out', (s: Scenario) => s.policy.accounts.wOut!],
    ['E_in', (s: Scenario) => s.policy.accounts.eIn],
    ["Orientim's fee account", (s: Scenario) => s.policy.accounts.feeDestination!],
  ] as const) {
    it(`${name} in a table the message uses is refused`, async () => {
      const s = await scenario({ input: USDC, output: BONK });
      s.lookupTables[s.lookupTable].push(pick(s));
      const v = await verify(mutated(s, honest(s)), s.policy, s.snapshot);
      expect(details(v).join()).toContain('is loaded from a lookup table');
    });
  }

  it('the compiler keeps them in the message even when a table lists them, and the result passes', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    s.lookupTables[s.lookupTable].push(s.policy.accounts.wOut!, s.policy.accounts.eIn, s.policy.accounts.feeDestination!);
    const v = await verify(await compileHonest(s, 0), s.policy, s.snapshot);
    expect(v.violations).toEqual([]);
  });
});

describe("the account a Pump market opens for E: closed last, its rent sent on to W", () => {
  const RENT = 1_346_200n;
  const refunded = (program: Address = PUMP_CURVE_PROGRAM, input: Address = WSOL_MINT, output: Address = BONK) =>
    scenario({ input, output, routeRefund: { program, lamports: RENT } });
  /** The close of the route's account and the transfer of its lamports to W: the last two instructions. */
  const tail = (ixs: Instruction[]) => ({ close: ixs.length - 2, refund: ixs.length - 1 });

  for (const [market, program] of [['the bonding curve', PUMP_CURVE_PROGRAM], ['PumpSwap', PUMP_AMM_PROGRAM]] as const) {
    for (const version of [0, 1] as const) {
      it(`an honest swap through ${market} passes, v${version}`, async () => {
        const s = await refunded(program);
        const v = await verify(await compileHonest(s, version), s.policy, s.snapshot);
        expect(v.violations).toEqual([]);
      });
    }
  }

  it('also on a sale into SOL, where E_out is closed before it', async () => {
    const s = await refunded(PUMP_CURVE_PROGRAM, BONK, WSOL_MINT);
    expect((await verify(await compileHonest(s, 0), s.policy, s.snapshot)).violations).toEqual([]);
  });

  it('the lamports sent to anyone but W are refused', async () => {
    const s = await refunded();
    const ixs = honest(s);
    const attacker = await randomAddress();
    ixs[tail(ixs).refund] = getTransferSolInstruction({ source: createNoopSigner(s.E.address), destination: attacker, amount: RENT });
    expect(details(await verify(mutated(s, ixs), s.policy, s.snapshot)).join()).toContain('unexpected SOL transfer');
  });

  it('another amount is refused', async () => {
    const s = await refunded();
    const ixs = honest(s);
    ixs[tail(ixs).refund] = getTransferSolInstruction({ source: createNoopSigner(s.E.address), destination: s.W, amount: RENT - 1n });
    expect(details(await verify(mutated(s, ixs), s.policy, s.snapshot)).join()).toContain('unexpected SOL transfer');
  });

  it("an account that is not E's own for that market is refused", async () => {
    const s = await refunded();
    const ixs = honest(s);
    const { close } = tail(ixs);
    const other = await routeAccountOf(PUMP_CURVE_PROGRAM, await randomAddress());
    ixs[close] = { ...ixs[close], accounts: ixs[close].accounts!.map((x, i) => (i === 1 ? { ...x, address: other } : x)) };
    expect(details(await verify(mutated(s, ixs), s.policy, s.snapshot)).join()).toContain('a Pump account closed that the policy does not name');
  });

  it('closed while E still owns a token account (before E_in is closed) is refused', async () => {
    const s = await refunded();
    const ixs = honest(s);
    const [close, refund] = ixs.splice(ixs.length - 2, 2);
    const closeEIn = ixs.findIndex(ix => ix.programAddress === TOKEN_PROGRAM && ix.data?.[0] === 9 && ix.accounts?.[0].address === s.policy.accounts.eIn);
    ixs.splice(closeEIn, 0, close, refund);
    expect(details(await verify(mutated(s, ixs), s.policy, s.snapshot)).join()).toContain('while E still owns a token account');
  });

  it('the lamports sent on before the account is closed are refused', async () => {
    const s = await refunded();
    const ixs = honest(s);
    const { close, refund } = tail(ixs);
    [ixs[close], ixs[refund]] = [ixs[refund], ixs[close]];
    expect(details(await verify(mutated(s, ixs), s.policy, s.snapshot)).join()).toContain('sent on before its account is closed');
  });

  it('the close without the refund is refused', async () => {
    const s = await refunded();
    const ixs = honest(s);
    ixs.pop();
    expect(details(await verify(mutated(s, ixs), s.policy, s.snapshot)).join()).toContain('routeRefund');
  });

  it('a Pump close the policy does not state is refused', async () => {
    const withIt = await refunded();
    const s = await scenario({ input: WSOL_MINT, output: BONK });
    const extra = honest(withIt).at(-2)!;
    // The same close, for this swap's E.
    const account = await routeAccountOf(PUMP_CURVE_PROGRAM, s.E.address);
    const ixs = [...honest(s), {
      ...extra,
      accounts: extra.accounts!.map((x, i) => (i === 0 ? { ...x, address: s.E.address } : i === 1 ? { ...x, address: account } : x)),
    }];
    expect(details(await verify(mutated(s, ixs), s.policy, s.snapshot)).join()).toContain('a Pump account closed that the policy does not name');
  });

  it('any other Pump instruction outside the route is refused', async () => {
    const s = await refunded();
    const ixs = honest(s);
    const { close } = tail(ixs);
    ixs[close] = { ...ixs[close], data: new Uint8Array([...ixs[close].data!, 0]) };
    expect(details(await verify(mutated(s, ixs), s.policy, s.snapshot)).join()).toContain('a Pump instruction other than closing');
  });

  it('a refund from a program that is not a Pump market, or above the rent ceiling, is refused', async () => {
    const s = await refunded();
    const tx = await compileHonest(s, 0);
    const notPump = { ...s.policy, routeRefundProgram: await randomAddress() };
    expect(details(await verify(tx, notPump, s.snapshot)).join()).toContain('not a Pump market');
    const tooMuch = { ...s.policy, routeRefund: MAX_TAKER_RENT_LAMPORTS + 1n };
    expect(rules(await verify(tx, tooMuch, s.snapshot))).toContain('R4');
  });
});

describe("the fee, taken like Jupiter's: SOL first, then USDC and USDT, otherwise the input token", () => {
  const feeIndex = (ixs: Instruction[], s: Scenario) => ixs.findIndex(ix => {
    const d = ix.data;
    const to = ix.accounts?.[ix.programAddress === SYSTEM_PROGRAM ? 1 : 2]?.address;
    return !!d && to === s.policy.accounts.feeDestination && ix.programAddress !== JUPITER_PROGRAM;
  });

  it('a sale into SOL pays in SOL, from the wallet after E_out has paid out, as the last instruction', async () => {
    const s = await scenario({ input: BONK, output: WSOL_MINT, feeAccountExists: false });
    expect(s.policy.feeSide).toBe('output');
    expect(s.policy.swapAmount).toBe(s.policy.amountIn);
    expect(s.policy.fee).toBe((s.policy.minOut * s.policy.feeBps) / 10_000n);
    expect(s.policy.accounts.feeDestination).toBe(s.treasury);
    for (const version of [0, 1] as const) expect((await verify(await compileHonest(s, version), s.policy, s.snapshot)).violations).toEqual([]);
    const ixs = honest(s);
    expect(feeIndex(ixs, s)).toBe(ixs.length - 1);
  });

  it('a sale into USDC pays in USDC, from W_out after its minimum is checked', async () => {
    const s = await scenario({ input: BONK, output: USDC, feeAccountExists: false, outputFeeAccountExists: true });
    expect(s.policy.feeSide).toBe('output');
    for (const version of [0, 1] as const) expect((await verify(await compileHonest(s, version), s.policy, s.snapshot)).violations).toEqual([]);
  });

  it('SOL comes first on either side; USDC before the input token; the input token when it is all there is', async () => {
    expect((await scenario({ input: USDC, output: WSOL_MINT })).policy.feeSide).toBe('output');
    expect((await scenario({ input: WSOL_MINT, output: USDC, outputFeeAccountExists: true })).policy.feeSide).toBe('input');
    expect((await scenario({ input: JUP, output: USDC, outputFeeAccountExists: true })).policy.feeSide).toBe('output');
    expect((await scenario({ input: JUP, output: BONK })).policy.feeSide).toBe('input');
    expect((await scenario({ input: JUP, output: BONK, feeAccountExists: false })).policy.feeSide).toBeNull();
    // Without a treasury wallet, SOL cannot be received and the next token in line pays.
    expect((await scenario({ input: USDC, output: WSOL_MINT, treasuryWalletReady: false })).policy.feeSide).toBe('input');
  });

  it('a fee on the output moved before the swap, or before the minimum check, is refused', async () => {
    for (const opts of [{ input: BONK, output: WSOL_MINT, feeAccountExists: false }, { input: BONK, output: USDC, feeAccountExists: false, outputFeeAccountExists: true }]) {
      const s = await scenario(opts);
      const ixs = honest(s);
      const [fee] = ixs.splice(feeIndex(ixs, s), 1);
      const early = [...ixs];
      early.splice(swapIndex(ixs), 0, fee);
      expect(details(await verify(mutated(s, early), s.policy, s.snapshot)).join()).toContain('the fee on the output must follow');
      const beforeCheck = [...ixs];
      beforeCheck.splice(swapIndex(ixs) + 1, 0, fee);
      expect(details(await verify(mutated(s, beforeCheck), s.policy, s.snapshot)).join()).toContain('the fee on the output must follow');
    }
  });

  it('a fee on the output that is larger, or goes elsewhere, is refused', async () => {
    const s = await scenario({ input: BONK, output: WSOL_MINT, feeAccountExists: false });
    const ixs = honest(s);
    const at = feeIndex(ixs, s);
    const W = createNoopSigner(s.W);
    const larger = [...ixs];
    larger[at] = getTransferSolInstruction({ source: W, destination: s.policy.accounts.feeDestination!, amount: s.policy.fee + 1n });
    expect(rules(await verify(mutated(s, larger), s.policy, s.snapshot))).toContain('R2');
    const elsewhere = [...ixs];
    elsewhere[at] = getTransferSolInstruction({ source: W, destination: await randomAddress(), amount: s.policy.fee });
    expect(rules(await verify(mutated(s, elsewhere), s.policy, s.snapshot))).toContain('R2');
  });

  it('a pair neither token of which can carry the fee pays it in SOL, from the wallet, before the swap', async () => {
    const s = await scenario({ input: JUP, output: BONK, feeAccountExists: false, solFee: 1_234_567n });
    expect(s.policy.feeSide).toBe('sol');
    expect(s.policy.fee).toBe(1_234_567n);
    expect(s.policy.swapAmount).toBe(s.policy.amountIn);
    expect(s.policy.accounts.feeDestination).toBe(s.treasury);
    for (const version of [0, 1] as const) expect((await verify(await compileHonest(s, version), s.policy, s.snapshot)).violations).toEqual([]);
    const ixs = honest(s);
    expect(feeIndex(ixs, s)).toBeLessThan(swapIndex(ixs));
  });

  it('a fee in SOL that is larger, goes elsewhere, comes after the swap, or is left out, is refused', async () => {
    const s = await scenario({ input: JUP, output: BONK, feeAccountExists: false, solFee: 1_234_567n });
    const ixs = honest(s);
    const at = feeIndex(ixs, s);
    const W = createNoopSigner(s.W);
    const larger = [...ixs];
    larger[at] = getTransferSolInstruction({ source: W, destination: s.policy.accounts.feeDestination!, amount: s.policy.fee + 1n });
    expect(rules(await verify(mutated(s, larger), s.policy, s.snapshot))).toContain('R2');
    const elsewhere = [...ixs];
    elsewhere[at] = getTransferSolInstruction({ source: W, destination: await randomAddress(), amount: s.policy.fee });
    expect(rules(await verify(mutated(s, elsewhere), s.policy, s.snapshot))).toContain('R2');
    const late = [...ixs];
    const [fee] = late.splice(at, 1);
    late.splice(swapIndex(late) + 1, 0, fee);
    expect(details(await verify(mutated(s, late), s.policy, s.snapshot)).join()).toContain('feeTransfer must run before the swap');
    const left = ixs.filter((_, i) => i !== at);
    expect((await verify(mutated(s, left), s.policy, s.snapshot)).ok).toBe(false);
  });

  it('a fee in SOL is only for a pair without SOL, and without a price or a treasury wallet the pair is fee-free', async () => {
    const a = await scenario({ input: BONK, output: WSOL_MINT, feeAccountExists: false });
    const solSide = { ...a.policy, feeSide: 'sol' as const };
    expect(details(await verify(await compileHonest(a, 0), solSide, a.snapshot)).join()).toContain('only for a swap with no SOL');
    expect((await scenario({ input: JUP, output: BONK, feeAccountExists: false })).policy.feeSide).toBeNull();
    expect((await scenario({ input: JUP, output: BONK, feeAccountExists: false, solFee: 5n, treasuryWalletReady: false })).policy.feeSide).toBeNull();
    // A token the treasury holds an account for still pays in that token, exactly.
    expect((await scenario({ input: JUP, output: BONK, solFee: 5n })).policy.feeSide).toBe('input');
  });

  it('a policy that takes the fee from an output other than SOL, USDC or USDT, or states another amount, is refused', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    const outputSide = { ...s.policy, feeSide: 'output' as const, swapAmount: s.policy.amountIn, fee: (s.policy.minOut * s.policy.feeBps) / 10_000n };
    expect(details(await verify(await compileHonest(s, 0), outputSide, s.snapshot)).join()).toContain('only in SOL, USDC or USDT');
    const a = await scenario({ input: BONK, output: WSOL_MINT, feeAccountExists: false });
    const wrong = { ...a.policy, fee: a.policy.fee + 1n };
    expect(details(await verify(await compileHonest(a, 0), wrong, a.snapshot)).join()).toContain('policy amounts are inconsistent');
    const sideless = { ...a.policy, feeSide: null };
    expect(details(await verify(await compileHonest(a, 0), sideless, a.snapshot)).join()).toContain('treasury without a fee side');
  });
});
