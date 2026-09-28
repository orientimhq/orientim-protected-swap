/**
 * The skill's reads: accounts no older than a slot, and when "no record" proves a swap never landed.
 */
import { describe, expect, it } from 'vitest';
import { SolanaError, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED } from '@solana/kit';
import { pastProof, provesNeverLanded, readAccounts, STATUS_CACHE_BLOCKS, STATUS_CACHE_MARGIN_BLOCKS } from '../src/index.ts';

describe('reads that must not be older than a slot', () => {
  const lagging = (behind: number) => {
    const asked: unknown[] = [];
    let calls = 0;
    const rpc = {
      getMultipleAccounts: (addresses: string[], config: { minContextSlot?: bigint }) => ({
        send: async () => {
          asked.push(config.minContextSlot);
          if (++calls <= behind) {
            throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED, { __serverMessage: 'Minimum context slot has not been reached', contextSlot: 99 } as never);
          }
          return { context: { slot: 120n }, value: addresses.map(() => null) };
        },
      }),
    } as unknown as Parameters<typeof readAccounts>[0];
    return { rpc, asked, calls: () => calls };
  };

  it('asks for the slot, waits for a node that is behind, and answers at least that recent', async () => {
    const { rpc, asked, calls } = lagging(2);
    const { slot } = await readAccounts(rpc, ['11111111111111111111111111111111' as never], { minContextSlot: 110n });
    expect(slot).toBe(120n);
    expect(calls()).toBe(3);
    expect(asked).toEqual([110n, 110n, 110n]);
  });

  it('a node that stays behind fails the read instead of answering from older state', async () => {
    const { rpc } = lagging(99);
    await expect(readAccounts(rpc, ['11111111111111111111111111111111' as never], { minContextSlot: 110n })).rejects.toThrow();
  });
});

describe('"no record" proves a swap never landed only while the cache still holds it', () => {
  const lastValid = 1_000n;
  const earliest = lastValid - 149n;
  it('proves it once the finalized chain is past the lifetime and the cache reaches back', () => {
    expect(provesNeverLanded({ coveredHeight: lastValid + 1n, reachHeight: lastValid + 5n }, lastValid, earliest)).toBe(true);
  });
  it('proves nothing before the lifetime is over', () => {
    expect(provesNeverLanded({ coveredHeight: lastValid, reachHeight: lastValid + 5n }, lastValid, earliest)).toBe(false);
  });
  it('proves nothing from a node that lagged, or whose cache starts past the swap', () => {
    expect(provesNeverLanded({ coveredHeight: null, reachHeight: null }, lastValid, earliest)).toBe(false);
    const far = earliest + STATUS_CACHE_BLOCKS - STATUS_CACHE_MARGIN_BLOCKS;
    expect(provesNeverLanded({ coveredHeight: far, reachHeight: far }, lastValid, earliest)).toBe(false);
    expect(pastProof({ coveredHeight: far }, earliest)).toBe(true);
    expect(pastProof({ coveredHeight: lastValid + 1n }, earliest)).toBe(false);
  });
});
