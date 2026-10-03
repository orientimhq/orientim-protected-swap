/**
 * The edges, fuzzed: amounts from one unit to the largest a token account can hold, any decimals a
 * mint may state, any quote a route may carry and any balance the output account already holds.
 * - the fee and the minimum are exact whatever the amount: never above 0.3%, never negative, never lost;
 * - an honest swap at any size passes, and the verifier answers every case without throwing;
 * - a route whose own floor is below the minimum is refused at any size, by one unit or by all of it;
 * - a token account of the wallet that is frozen is refused, whichever side it is on.
 *
 * `npm run test:fuzz` runs 200,000 cases per property; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Address } from '@solana/kit';
import {
  compileProtectedSwap, feeFor, minimumForReceived, minimumReceived, outputFeeFor, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT,
} from '@orientim/core';
import type { TxVersion } from '@orientim/core';
import { verify } from '../src/index.ts';
import { BONK, LIFETIME, scenario, USDC } from './fixtures.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 200_000 : 200));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 50;

const U64 = 2n ** 64n - 1n;
/** Amounts spread over every order of magnitude, the ends included, not only the middle. */
const amount = (min = 1n, max = U64) =>
  fc.oneof(
    fc.constantFrom(min, min + 1n, max - 1n, max).filter(x => x >= min && x <= max),
    fc.integer({ min: 0, max: 19 }).chain(e => fc.bigInt({ min: 10n ** BigInt(e), max: 10n ** BigInt(e + 1) }))
      .filter(x => x >= min && x <= max),
    fc.bigInt({ min, max }),
  );
const PAIRS: [Address, Address][] = [[USDC, WSOL_MINT], [WSOL_MINT, USDC], [USDC, BONK], [BONK, USDC]];

describe('the fee and the minimum at any size', () => {
  it('a fee on the input is at most 0.3%, never negative, and the swap gets exactly the rest', () => {
    fc.assert(fc.property(amount(), fc.bigInt({ min: 0n, max: 30n }), fc.boolean(), (amountIn, feeBps, treasury) => {
      const fee = feeFor(amountIn, { feeBps, treasury: treasury ? ('T' as Address) : null });
      expect(fee >= 0n).toBe(true);
      expect(fee * 10_000n <= amountIn * feeBps).toBe(true);
      // Rounded down, by less than one unit.
      if (treasury) expect((fee + 1n) * 10_000n > amountIn * feeBps).toBe(true);
      else expect(fee).toBe(0n);
      // Never all of it: at 0.3% the swap keeps at least 99.7% of the amount.
      expect(amountIn - fee > 0n).toBe(true);
    }), PARAMS);
  }, TIMEOUT);

  it('a fee on the output never leaves the wallet less than the minimum less 0.3%', () => {
    fc.assert(fc.property(amount(), fc.bigInt({ min: 0n, max: 30n }), (minOut, feeBps) => {
      const fee = outputFeeFor(minOut, feeBps);
      const kept = minimumReceived({ minOut, fee, feeSide: 'output' });
      expect(fee >= 0n && fee <= minOut).toBe(true);
      expect(kept * 10_000n >= minOut * (10_000n - feeBps)).toBe(true);
      expect(kept <= minOut).toBe(true);
    }), PARAMS);
  }, TIMEOUT);

  it('the least minimum for what the wallet must keep is the least, and it suffices', () => {
    fc.assert(fc.property(amount(1n, U64 / 2n), fc.bigInt({ min: 0n, max: 30n }), (received, feeBps) => {
      const gross = minimumForReceived(received, feeBps);
      expect(gross - outputFeeFor(gross, feeBps) >= received).toBe(true);
      expect(gross - 1n - outputFeeFor(gross - 1n, feeBps) < received).toBe(true);
    }), PARAMS);
  }, TIMEOUT);
});

describe('the verifier at any size', () => {
  const shape = fc.record({
    pair: fc.constantFrom(...PAIRS),
    version: fc.constantFrom<TxVersion>(0, 1),
    fee: fc.boolean(),
    token2022: fc.boolean(),
    inputDecimals: fc.integer({ min: 0, max: 18 }),
    outputDecimals: fc.integer({ min: 0, max: 18 }),
    // The fee is taken from the amount, so the smallest amount that leaves something to swap is 2 units.
    amountIn: amount(2n),
    minOut: amount(1n, U64 / 2n),
    wOutBalance: fc.oneof(fc.constant(0n), amount(1n, U64)),
    routeBps: fc.integer({ min: 0, max: 50 }),
    // Where the quote sits: from exactly enough for the route's own floor to reach the minimum, to far above.
    headroom: fc.oneof(fc.constant(0n), amount(1n, U64)),
  })
    // A mint's supply is a u64, so what the wallet holds and what arrives fit in one together; the
    // compiler throws rather than wrap when they would not, and nothing is signed.
    .filter(s => s.wOutBalance + s.minOut <= U64);

  type Shape = typeof shape extends fc.Arbitrary<infer T> ? T : never;
  const make = async (s: Shape, quotedOut: (least: bigint) => bigint) => {
    const [input, output] = s.pair;
    const least = (s.minOut * 10_000n + BigInt(9_999 - s.routeBps)) / BigInt(10_000 - s.routeBps);
    const q = quotedOut(least);
    const sc = await scenario({
      input, output, fee: s.fee, amountIn: s.amountIn, minOut: s.minOut, wOutBalance: s.wOutBalance,
      inputDecimals: input === WSOL_MINT ? 9 : s.inputDecimals, outputDecimals: output === WSOL_MINT ? 9 : s.outputDecimals,
      inputProgram: s.token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM, outputProgram: s.token2022 ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM,
      quotedOut: q > U64 ? U64 : q, routeBps: s.routeBps,
    });
    const tx = compileProtectedSwap({
      policy: sc.policy, swapInstruction: sc.swapIx, intermediates: sc.intermediates, version: s.version,
      lifetime: LIFETIME, computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, priorityFeeLamports: 20_000n,
      lookupTables: s.version === 0 ? sc.lookupTables : undefined, outputBalanceBefore: sc.wOutBalance,
    }).transaction;
    return { sc, tx, least, quoted: q > U64 ? U64 : q };
  };

  it('passes an honest swap of any size, decimals, quote and balance already held', async () => {
    await fc.assert(fc.asyncProperty(shape.filter(s => {
      // Jupiter states the quote in a u64, so the minimum must be reachable within one.
      const least = (s.minOut * 10_000n + BigInt(9_999 - s.routeBps)) / BigInt(10_000 - s.routeBps);
      return least <= U64;
    }), async s => {
      const { sc, tx } = await make(s, least => least + s.headroom);
      const v = await verify(tx, sc.policy, sc.snapshot);
      expect(v.violations).toEqual([]);
    }), PARAMS);
  }, TIMEOUT);

  it("refuses a swap from or to a frozen token account of the wallet, at any size", async () => {
    await fc.assert(fc.asyncProperty(shape, fc.boolean(), async (s, outputSide) => {
      const { sc, tx } = await make(s, least => (least > U64 ? U64 : least));
      const side = outputSide ? sc.policy.accounts.wOut : sc.policy.accounts.wIn;
      const state = side ? sc.snapshot.accounts.get(side) : null;
      fc.pre(!!side && !!state && state.data.length >= 165);
      const data = new Uint8Array(state!.data);
      data[108] = 2; // AccountState::Frozen
      const accounts = new Map(sc.snapshot.accounts);
      accounts.set(side!, { ...state!, data });
      const v = await verify(tx, sc.policy, { ...sc.snapshot, accounts });
      expect(v.ok).toBe(false);
      expect(v.violations).toContainEqual(expect.objectContaining({
        rule: 'R1', detail: `the wallet's ${outputSide ? 'output' : 'input'} token account is frozen`,
      }));
      // One state byte decides it, so a tenth of the cases suffices and the shard keeps its time.
    }), { ...PARAMS, numRuns: Math.max(200, Math.floor(RUNS / 10)) });
  }, TIMEOUT);

  it("refuses a route whose own floor is below the minimum at any size, by one unit or by all of it", async () => {
    await fc.assert(fc.asyncProperty(shape, amount(1n, U64), async (s, short) => {
      // A quote whose floor after the route's own tolerance falls below the minimum.
      const { sc, tx, quoted } = await make(s, least => (least - short < 0n ? 0n : least - short));
      const floor = (quoted * BigInt(10_000 - s.routeBps)) / 10_000n;
      fc.pre(floor < sc.policy.minOut);
      const v = await verify(tx, sc.policy, sc.snapshot);
      expect(v.ok).toBe(false);
      expect(v.violations.some(x => x.detail.includes('own floor is'))).toBe(true);
    }), PARAMS);
  }, TIMEOUT);
});
