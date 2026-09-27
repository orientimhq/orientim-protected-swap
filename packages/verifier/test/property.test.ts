import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AccountRole, createNoopSigner } from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import {
  AuthorityType, getApproveInstruction, getCloseAccountInstruction, getSetAuthorityInstruction, getTransferCheckedInstruction,
} from '@solana-program/token';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  compileProtectedSwap, JUPITER_PROGRAM, protectedInstructions, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT,
} from '@orientim/core';
import type { TxVersion } from '@orientim/core';
import { verify } from '../src/index.ts';
import { BONK, compileRaw, cuIxs, LIFETIME, randomAddress, scenario, USDC, WIF } from './fixtures.ts';
import type { Scenario } from './fixtures.ts';

// `npm run test:fuzz` (vitest --mode fuzz) runs 100,000 cases per property; ORIENTIM_FUZZ_RUNS overrides.
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? ((import.meta as { env?: { MODE?: string } }).env?.MODE === 'fuzz' ? 100_000 : 150));
// About 22 ms per case on a laptop (20,000 cases took ~440 s per property): the time limit grows
// with the number of cases, so `npm run test:fuzz` (100,000) is not cut off.
const TIMEOUT = 60_000 + RUNS * 50;
// A shard of the fuzz workflow runs its own cases: one seed per shard (.github/workflows/fuzz.yml).
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const PAIRS: [Address, Address][] = [[USDC, WSOL_MINT], [WSOL_MINT, USDC], [USDC, BONK]];

// Token-2022 extension sets a protected swap can live with, and ones it must refuse (section 0f).
const ALLOWED_EXTENSIONS: [number, number][][] = [
  [], [[18, 64]], [[18, 64], [19, 120]], [[14, 64]], [[3, 32], [18, 64]], [[4, 97]], [[20, 64], [21, 80]],
  // An empty permanent-delegate slot names nobody; a confidential-transfer fee never touches a public transfer.
  [[12, 32]], [[4, 65], [16, 129]],
];
// A transfer fee is not here: the swap's own mints may charge one, because the cleanup harvests
// the withheld amount before closing the temporary account. The fixtures fill every value with
// zeros, so the default-state entry here means "uninitialized", which is refused. A permanent
// delegate is exercised with real keys in verifier.test.ts, since an empty one names nobody.
const REFUSED_EXTENSIONS: [number, number][] = [
  [6, 1], [8, 1], [9, 0], [10, 52], [12, 31], [16, 128], [25, 24], [26, 33], [250, 8],
];

const shape = fc.record({
  pair: fc.constantFrom(...PAIRS),
  version: fc.constantFrom<TxVersion>(0, 1),
  fee: fc.boolean(),
  feeAccountExists: fc.boolean(),
  intermediates: fc.integer({ min: 0, max: 2 }),
  poolCount: fc.integer({ min: 1, max: 20 }),
  token2022: fc.boolean(),
  extensions: fc.constantFrom(...ALLOWED_EXTENSIONS, [[18, 64], [1, 108]] as [number, number][]),
});

type Shape = {
  pair: [Address, Address]; version: TxVersion; fee: boolean; feeAccountExists: boolean;
  intermediates: number; poolCount: number; token2022: boolean; extensions: [number, number][];
};

const build = (s: Shape) =>
  scenario({
    input: s.pair[0], output: s.pair[1], fee: s.fee, feeAccountExists: s.feeAccountExists,
    intermediates: s.intermediates, poolCount: s.poolCount,
    // Wrapped SOL stays classic whatever the shape says; the fixture takes care of that.
    inputProgram: s.token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
    outputProgram: s.token2022 ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM,
    inputExtensions: s.extensions,
    outputExtensions: s.extensions,
  });

const compile = (sc: Scenario, ixs: Instruction[], version: TxVersion, cu = cuIxs()) =>
  compileRaw(sc.W, version === 0 ? [...cu, ...ixs] : ixs, version, version === 0 ? sc.lookupTables : undefined);

describe('T3: property tests', () => {
  it('a Token-2022 mint with an extension we refuse never passes', async () => {
    await fc.assert(
      fc.asyncProperty(shape, fc.constantFrom(...REFUSED_EXTENSIONS), fc.boolean(), async (s, refused, onInput) => {
        // Wrapped SOL is always classic, so put the refused extension on the side that is a token.
        const side = s.pair[0] === WSOL_MINT ? false : s.pair[1] === WSOL_MINT ? true : onInput;
        const sc = await scenario({
          input: s.pair[0], output: s.pair[1], fee: s.fee, feeAccountExists: s.feeAccountExists,
          intermediates: s.intermediates, poolCount: s.poolCount,
          inputProgram: side ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
          outputProgram: side ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM,
          inputExtensions: side ? [[18, 64], refused] : [[18, 64]],
          outputExtensions: side ? [[18, 64]] : [[18, 64], refused],
        });
        const tx = compileProtectedSwap({
          policy: sc.policy, swapInstruction: sc.swapIx, intermediates: sc.intermediates, version: s.version,
          lifetime: LIFETIME, computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, priorityFeeLamports: 20_000n,
          lookupTables: s.version === 0 ? sc.lookupTables : undefined, outputBalanceBefore: sc.wOutBalance,
        }).transaction;
        const v = await verify(tx, sc.policy, sc.snapshot);
        expect(v.violations.some(x => x.rule === 'R7')).toBe(true);
      }),
      PARAMS,
    );
  }, TIMEOUT);

  it('every honest shape the compiler produces is accepted', async () => {
    await fc.assert(
      fc.asyncProperty(shape, async s => {
        const sc = await build(s);
        const tx = compileProtectedSwap({
          policy: sc.policy, swapInstruction: sc.swapIx, intermediates: sc.intermediates, version: s.version,
          lifetime: LIFETIME, computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, priorityFeeLamports: 20_000n,
          lookupTables: s.version === 0 ? sc.lookupTables : undefined, outputBalanceBefore: sc.wOutBalance,
        }).transaction;
        const v = await verify(tx, sc.policy, sc.snapshot);
        expect(v.violations).toEqual([]);
      }),
      PARAMS,
    );
  }, TIMEOUT);

  const attack = fc.record({
    kind: fc.constantFrom(
      'approve', 'setAuthority', 'stealTokens', 'stealSol', 'closeToAttacker', 'walletInSwap',
      'inputTokenInSwap', 'otherTokenInSwap', 'changeSwapAmount', 'changeFee', 'hugeFee',
      'secondExternal', 'dropRequired', 'ephemeralExists', 'thirdSigner',
    ),
    position: fc.nat(),
    amount: fc.bigInt({ min: 1n, max: 10n ** 15n }),
    viaLookupTable: fc.boolean(),
  });

  it('every attack is rejected', async () => {
    await fc.assert(
      fc.asyncProperty(shape, attack, async (s, a) => {
        const sc = await build(s);
        const p = sc.policy;
        const W = createNoopSigner(sc.W);
        const E = createNoopSigner(sc.E.address);
        const attacker = await randomAddress();
        let ixs = protectedInstructions({ policy: p, swapInstruction: sc.swapIx, intermediates: sc.intermediates });
        const swapAt = () => ixs.findIndex(ix => ix.programAddress === JUPITER_PROGRAM);
        const insert = (ix: Instruction) => ixs.splice(a.position % (ixs.length + 1), 0, ix);
        const addToSwap = (address: Address, role: AccountRole) => {
          if (a.viaLookupTable && s.version === 0 && role !== AccountRole.READONLY_SIGNER) sc.lookupTables[sc.lookupTable].push(address);
          const i = swapAt();
          ixs[i] = { ...ixs[i], accounts: [...(ixs[i].accounts ?? []), { address, role }] };
        };
        let cu = cuIxs();

        switch (a.kind) {
          case 'approve':
            insert(getApproveInstruction({ source: p.accounts.wIn ?? sc.wOther, delegate: attacker, owner: W, amount: a.amount }));
            break;
          case 'setAuthority':
            insert(getSetAuthorityInstruction({ owned: sc.wOther, owner: W, authorityType: AuthorityType.AccountOwner, newAuthority: attacker }));
            break;
          case 'stealTokens':
            insert(getTransferCheckedInstruction({ source: sc.wOther, mint: WIF, destination: attacker, authority: W, amount: a.amount, decimals: 6 }));
            break;
          case 'stealSol':
            insert(getTransferSolInstruction({ source: W, destination: attacker, amount: a.amount }));
            break;
          case 'closeToAttacker':
            ixs = ixs.map(ix =>
              ix.data?.[0] === 9 && ix.accounts?.[0].address === p.accounts.eIn
                ? getCloseAccountInstruction({ account: p.accounts.eIn, destination: attacker, owner: E })
                : ix);
            break;
          case 'walletInSwap':
            addToSwap(sc.W, AccountRole.WRITABLE);
            break;
          case 'inputTokenInSwap':
            addToSwap(p.accounts.wIn ?? sc.wOther, AccountRole.WRITABLE);
            break;
          case 'otherTokenInSwap':
            addToSwap(sc.wOther, AccountRole.WRITABLE);
            break;
          case 'changeSwapAmount': {
            const evil = { ...p, swapAmount: p.swapAmount + a.amount };
            ixs = protectedInstructions({ policy: evil, swapInstruction: sc.swapIx, intermediates: sc.intermediates });
            break;
          }
          case 'changeFee': {
            if (p.fee === 0n) {
              insert(getTransferSolInstruction({ source: W, destination: attacker, amount: a.amount }));
            } else {
              const evil = { ...p, fee: p.fee + a.amount };
              ixs = protectedInstructions({ policy: evil, swapInstruction: sc.swapIx, intermediates: sc.intermediates });
            }
            break;
          }
          case 'hugeFee':
            if (s.version === 0) cu = cuIxs(1_400_000, 1_000_000n + a.amount);
            else {
              const tx = compileRaw(sc.W, ixs, 1, undefined, { priorityFeeLamports: 1_000_000n + a.amount });
              expect((await verify(tx, p, sc.snapshot)).ok).toBe(false);
              return;
            }
            break;
          case 'secondExternal':
            insert({ ...sc.swapIx, programAddress: attacker });
            break;
          case 'dropRequired': {
            const required = ixs.flatMap((ix, i) =>
              ix.programAddress !== JUPITER_PROGRAM && !(ix.data?.[0] === 1 && ix.accounts?.length === 6 && sc.intermediates.some(m => m.ata === ix.accounts![1].address))
                ? [i] : []);
            ixs.splice(required[a.position % required.length], 1);
            break;
          }
          case 'ephemeralExists':
            (sc.snapshot.accounts as Map<string, unknown>).set(sc.E.address, { owner: attacker, lamports: 1n + a.amount, data: new Uint8Array() });
            break;
          case 'thirdSigner':
            addToSwap(attacker, AccountRole.READONLY_SIGNER);
            break;
        }

        const v = await verify(compile(sc, ixs, s.version, cu), p, sc.snapshot);
        expect(v.ok, `${a.kind} was accepted`).toBe(false);
      }),
      PARAMS,
    );
  }, TIMEOUT);
});
