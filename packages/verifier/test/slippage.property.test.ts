/**
 * The tolerance rule, fuzzed: for any tolerance a person chose (or none, or a value that is not one),
 * any tolerance a route carries, curve or not, and any quote, the verifier refuses exactly the routes
 * it must: above the ceiling (the chosen tolerance up to 15%, else 0.5% or 3% on a Pump.fun curve), or
 * with a floor of Jupiter's own below the minimum Orientim enforces. Nothing else changes.
 *
 * `npm run test:fuzz` runs 200,000 cases; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set the size and
 * the seed of a shard (.github/workflows/fuzz.yml).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AccountRole } from '@solana/kit';
import type { Instruction } from '@solana/kit';
import {
  JUPITER_PROGRAM, MAX_CHOSEN_SLIPPAGE_BPS, MAX_CURVE_SLIPPAGE_BPS, MAX_ROUTE_SLIPPAGE_BPS, PUMP_CURVE_PROGRAM, SYSTEM_PROGRAM,
} from '@orientim/core';
import type { AccountState } from '@orientim/core/types';
import { verify } from '../src/index.ts';
import { compileRaw, cuIxs, honest, routeV2Data, scenario } from './fixtures.ts';
import type { Scenario } from './fixtures.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 200_000 : 300));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 20;

/** The honest transaction with only Jupiter's route data changed, as a builder or a server could. */
function withRoute(s: Scenario, data: Uint8Array, curve: boolean) {
  const ixs: Instruction[] = honest(s);
  const i = ixs.findIndex(ix => ix.programAddress === JUPITER_PROGRAM);
  const extra = curve ? [{ address: PUMP_CURVE_PROGRAM, role: AccountRole.READONLY }] : [];
  ixs[i] = { ...ixs[i], data, accounts: [...(ixs[i].accounts ?? []), ...extra] };
  return compileRaw(s.W, [...cuIxs(), ...ixs], 0, s.lookupTables);
}

describe('the tolerance rule, fuzzed', () => {
  // Scenarios are built once and reused: the case is the route, not the keys.
  let plain: Scenario;
  let curve: Scenario;
  beforeAll(async () => {
    plain = await scenario();
    curve = await scenario();
    (curve.snapshot.accounts as Map<string, AccountState | null>).set(PUMP_CURVE_PROGRAM, { owner: SYSTEM_PROGRAM, lamports: 1n, data: new Uint8Array(36) });
  });

  it('refuses a route exactly when it is above the ceiling or its own floor is below the minimum', async () => {
    const chosen = fc.oneof(
      fc.constant(undefined),
      fc.integer({ min: 10, max: 1_500 }),
      fc.integer({ min: 1_501, max: 20_000 }),
      fc.constantFrom(0, -1, 2.5, Number.NaN),
    );
    await fc.assert(
      fc.asyncProperty(
        chosen, fc.integer({ min: 0, max: 10_000 }), fc.boolean(), fc.integer({ min: 5_000, max: 30_000 }),
        async (maxSlippageBps, routeBps, onCurve, quotePerMinute) => {
          const s = onCurve ? curve : plain;
          const minOut = s.policy.minOut;
          // The quote Jupiter's instruction states, from half the minimum to three times it.
          const quotedOut = (minOut * BigInt(quotePerMinute)) / 10_000n;
          const tx = withRoute(s, routeV2Data(s.policy.swapAmount, quotedOut, routeBps), onCurve);
          const v = await verify(tx, s.policy, s.snapshot, maxSlippageBps === undefined ? {} : { maxSlippageBps });
          const valid = maxSlippageBps !== undefined && Number.isInteger(maxSlippageBps) && maxSlippageBps >= 0;
          const ceiling = valid ? Math.min(maxSlippageBps, MAX_CHOSEN_SLIPPAGE_BPS) : onCurve ? MAX_CURVE_SLIPPAGE_BPS : MAX_ROUTE_SLIPPAGE_BPS;
          const floor = (quotedOut * BigInt(10_000 - routeBps)) / 10_000n;
          const details = v.violations.map(x => x.detail);
          const tooWide = details.some(d => d.includes(`tolerates ${routeBps} bps, above ${ceiling}`));
          const tooLow = details.some(d => d.includes('own floor is'));
          expect(tooWide).toBe(routeBps > ceiling);
          expect(tooLow).toBe(floor < minOut);
          // Nothing but these two: the route's data is all that changed.
          expect(v.violations.length).toBe(Number(tooWide) + Number(tooLow));
          expect(v.ok).toBe(!tooWide && !tooLow);
        },
      ),
      PARAMS,
    );
  }, TIMEOUT);
});
