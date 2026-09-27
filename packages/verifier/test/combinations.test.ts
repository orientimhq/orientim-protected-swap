/**
 * Every shape the compiler builds, across the features that combine in real swaps, must pass the
 * verifier: a fee on the input, on the output (SOL, USDC) or in SOL from the wallet; a Pump market's
 * account closed and refunded; hops; an input mint that taxes its transfers; v0 and v1. The property
 * tests in property.test.ts vary a smaller set; a disagreement here is a swap the page would build
 * and then refuse, or one the rules would let through that the compiler never meant.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compileProtectedSwap, PUMP_AMM_PROGRAM, PUMP_CURVE_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from '@orientim/core';
import type { TxVersion } from '@orientim/core';
import type { Address } from '@solana/kit';
import { verify } from '../src/index.ts';
import { BONK, JUP, LIFETIME, scenario, USDC } from './fixtures.ts';

const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? ((import.meta as { env?: { MODE?: string } }).env?.MODE === 'fuzz' ? 20_000 : 120));
const TIMEOUT = 60_000 + RUNS * 60;

// SOL on either side; USDC on the output (a fee there); two tokens neither of which is SOL or a
// stablecoin on the output (a fee on the input, or in SOL from the wallet).
const PAIRS: [Address, Address][] = [[USDC, WSOL_MINT], [WSOL_MINT, USDC], [USDC, BONK], [BONK, USDC], [BONK, JUP], [JUP, BONK]];

const combination = fc.record({
  pair: fc.constantFrom(...PAIRS),
  version: fc.constantFrom<TxVersion>(0, 1),
  fee: fc.boolean(),
  feeAccountExists: fc.boolean(),
  outputFeeAccountExists: fc.boolean(),
  solFee: fc.constantFrom(0n, 12_345n, 4_000_000n),
  intermediates: fc.integer({ min: 0, max: 2 }),
  refund: fc.constantFrom<null | Address>(null, PUMP_CURVE_PROGRAM, PUMP_AMM_PROGRAM),
  taxingInput: fc.boolean(),
  wOutBalance: fc.bigInt({ min: 0n, max: 10n ** 12n }),
  poolCount: fc.integer({ min: 1, max: 12 }),
});

describe('every combination the compiler builds passes the verifier', () => {
  it('fee sides, refunds, hops, taxing inputs, v0 and v1 together', async () => {
    await fc.assert(
      fc.asyncProperty(combination, async c => {
        const [input, output] = c.pair;
        // The fixture's hops are JUP then BONK; a route never hops through its own input token (the
        // pipeline leaves E_in out of the hops it recreates).
        fc.pre(!([JUP, BONK] as Address[]).slice(0, c.intermediates).includes(input));
        const taxing = c.taxingInput && input !== WSOL_MINT;
        const sc = await scenario({
          input, output, fee: c.fee, feeAccountExists: c.feeAccountExists, outputFeeAccountExists: c.outputFeeAccountExists,
          solFee: c.solFee, intermediates: c.intermediates, poolCount: c.poolCount, wOutBalance: c.wOutBalance,
          ...(c.refund ? { routeRefund: { program: c.refund, lamports: 1_346_200n } } : {}),
          inputProgram: taxing ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
          inputExtensions: taxing ? [[1, 108], [18, 64]] : [[18, 64]],
        });
        const { transaction } = compileProtectedSwap({
          policy: sc.policy, swapInstruction: sc.swapIx, intermediates: sc.intermediates, version: c.version, lifetime: LIFETIME,
          computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, priorityFeeLamports: 20_000n,
          lookupTables: c.version === 0 ? sc.lookupTables : undefined, outputBalanceBefore: sc.wOutBalance,
        });
        const verdict = await verify(transaction, sc.policy, sc.snapshot);
        if (!verdict.ok) {
          throw new Error(`refused ${JSON.stringify({ ...c, wOutBalance: String(c.wOutBalance), solFee: String(c.solFee), feeSide: sc.policy.feeSide })}: ${verdict.violations.map(v => `${v.rule} ${v.detail}`).join('; ')}`);
        }
        expect(verdict.networkFeeLamports).toBeGreaterThan(0n);
      }),
      { numRuns: RUNS },
    );
  }, TIMEOUT);
});
