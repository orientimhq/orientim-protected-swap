import { describe, expect, it } from 'vitest';
import { feeSideFor, minimumForReceived, outputFeeFor, WSOL_MINT } from '../src/index.ts';
import type { Address } from '@solana/kit';

/** What the wallet keeps of a minimum, after a fee from the output. */
const keeps = (gross: bigint, feeBps: bigint) => gross - outputFeeFor(gross, feeBps);

describe('the minimum that keeps what the user accepted', () => {
  it('one unit kept at 0.2% needs a minimum of one: its fee rounds down to nothing', () => {
    expect(minimumForReceived(1n, 20n)).toBe(1n);
  });

  it('is the least minimum that keeps at least the amount, for every amount and fee tried', () => {
    const wrong: string[] = [];
    for (const feeBps of [0n, 1n, 20n, 50n, 100n, 999n]) {
      for (let received = 0n; received <= 20_000n; received++) {
        const gross = minimumForReceived(received, feeBps);
        if (keeps(gross, feeBps) < received || (gross > 0n && keeps(gross - 1n, feeBps) >= received)) wrong.push(`${received} at ${feeBps} bps`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('holds for amounts far larger than a test can count through', () => {
    for (const received of [995_000_000n, 10n ** 15n + 7n, 2n ** 63n]) {
      const gross = minimumForReceived(received, 20n);
      expect(keeps(gross, 20n)).toBeGreaterThanOrEqual(received);
      expect(keeps(gross - 1n, 20n)).toBeLessThan(received);
    }
  });
});

describe('which token pays the fee (every swap pays)', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address;
  const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as Address;
  const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' as Address;
  const none = { input: false, output: false };

  it('SOL, USDC and USDT first, then the input token, then SOL from the wallet', () => {
    expect(feeSideFor(BONK, WSOL_MINT, { input: false, output: true, sol: true })).toBe('output');
    expect(feeSideFor(USDC, BONK, { input: true, output: false, sol: true })).toBe('input');
    expect(feeSideFor(BONK, WIF, { input: true, output: false, sol: true })).toBe('input');
    expect(feeSideFor(BONK, WIF, { ...none, sol: true })).toBe('sol');
    expect(feeSideFor(USDC, BONK, { ...none, sol: true })).toBe('sol');
  });

  it('with no way to receive anything, the swap is fee-free', () => {
    expect(feeSideFor(BONK, WIF, none)).toBeNull();
    expect(feeSideFor(BONK, WIF, { ...none, sol: false })).toBeNull();
  });
});
