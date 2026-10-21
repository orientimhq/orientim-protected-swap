import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { PUMP_CURVE_PROGRAM, WSOL_MINT } from '@orientimhq/core/constants';
import { bondingCurveOf } from '@orientimhq/verifier';
import { curvePrice } from '../src/curve-price.ts';
import { ownQuote } from '../src/verify.ts';

/**
 * Mainnet, 2026-10-21: curves as they were when Jupiter quoted a buy of 0.05 SOL on them, or a sell,
 * with Pump's fee config read at the same time, and the output Jupiter quoted.
 */
type Fixture = {
  captured: string; feeConfigHead: string; feeConfigLength: number;
  cases: { mint: string; curve: string; inputMint: string; outputMint: string; amount: string; jupiterOutAmount: string }[];
};
const fixture: Fixture = JSON.parse(readFileSync(new URL('./fixtures/curve-prices.json', import.meta.url), 'utf8'));
const FEES_PROGRAM = address('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const [FEE_CONFIG] = await getProgramDerivedAddress({
  programAddress: FEES_PROGRAM, seeds: [new TextEncoder().encode('fee_config'), getAddressEncoder().encode(PUMP_CURVE_PROGRAM)],
});
const W = 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE';

const feeConfig = () => {
  const data = new Uint8Array(fixture.feeConfigLength);
  data.set(Buffer.from(fixture.feeConfigHead, 'base64'));
  return data;
};

async function rpcFor(c: Fixture['cases'][number], edit: { curve?: (d: Uint8Array) => void; fees?: (d: Uint8Array) => void } = {}) {
  const curve = new Uint8Array(Buffer.from(c.curve, 'base64'));
  // A sell here is of tokens bought in the same capture, on curves that hold almost no SOL yet: the
  // curve is given SOL to pay them with. The price does not read it.
  if (c.outputMint === WSOL_MINT) new DataView(curve.buffer).setBigUint64(32, 10n ** 15n, true);
  edit.curve?.(curve);
  const fees = feeConfig();
  edit.fees?.(fees);
  const accounts = new Map<string, { owner: string; data: Uint8Array }>([
    [await bondingCurveOf(address(c.mint)), { owner: PUMP_CURVE_PROGRAM, data: curve }],
    [FEE_CONFIG, { owner: FEES_PROGRAM, data: fees }],
  ]);
  return {
    getMultipleAccounts: (list: string[]) => ({
      send: async () => ({
        context: { slot: 1n },
        value: list.map(a => {
          const x = accounts.get(a);
          return x ? { owner: x.owner, lamports: 1n, data: [Buffer.from(x.data).toString('base64'), 'base64'], executable: false } : null;
        }),
      }),
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

const buy = fixture.cases.find(c => c.inputMint === WSOL_MINT)!;

describe('your own price from a Pump.fun curve', () => {
  for (const c of fixture.cases) {
    it(`is Jupiter's quote for the same curve: ${c.inputMint === WSOL_MINT ? 'buy' : 'sell'} ${c.mint.slice(0, 6)}`, async () => {
      const own = await curvePrice(await rpcFor(c), c.inputMint, c.outputMint, BigInt(c.amount));
      expect(own?.outAmount.toString()).toBe(c.jupiterOutAmount);
      // Pump's fees alone are 1.25%.
      expect(own!.priceImpactBps).toBeGreaterThanOrEqual(125);
    });
  }

  const refused: [string, { curve?: (d: Uint8Array) => void; fees?: (d: Uint8Array) => void }][] = [
    ['a complete curve', { curve: d => { d[48] = 1; } }],
    ['a curve quoted in another token', { curve: d => { d[83] = 1; } }],
    ['a buy past what is left on the curve', { curve: d => { new DataView(d.buffer).setBigUint64(24, 1n, true); } }],
    ['fees of 100% or more', { fees: d => { new DataView(d.buffer).setBigUint64(69 + 24, 10_000n, true); } }],
    ['an unreadable fee config', { fees: d => { new DataView(d.buffer).setUint32(65, 1_000, true); } }],
  ];
  for (const [what, edit] of refused) {
    it(`gives no price for ${what}`, async () => {
      expect(await curvePrice(await rpcFor(buy, edit), buy.inputMint, buy.outputMint, BigInt(buy.amount))).toBeNull();
    });
  }

  it("counts the curve's own creator fee, and the market-cap tier it reaches", async () => {
    const base = (await curvePrice(await rpcFor(buy), buy.inputMint, buy.outputMint, BigInt(buy.amount)))!.outAmount;
    const own = await curvePrice(await rpcFor(buy, { curve: d => { new DataView(d.buffer).setBigUint64(115, 100n, true); } }), buy.inputMint, buy.outputMint, BigInt(buy.amount));
    expect(own!.outAmount < base).toBe(true);
    // A second tier from a market cap of 1 lamport, at 2% protocol fee.
    const tiered = await curvePrice(await rpcFor(buy, {
      fees: d => {
        const v = new DataView(d.buffer);
        d.copyWithin(65 + 4 + 40, 65 + 4, 65 + 4 + 40);
        v.setUint32(65, 2, true);
        v.setBigUint64(65 + 4 + 40, 1n, true);
        v.setBigUint64(65 + 4 + 40 + 24, 200n, true);
      },
    }), buy.inputMint, buy.outputMint, BigInt(buy.amount));
    expect(tiered!.outAmount < base).toBe(true);
  });

  it('gives no price for a pair without SOL', async () => {
    expect(await curvePrice(await rpcFor(buy), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', buy.outputMint, 1_000_000n)).toBeNull();
  });

  it('prices a curve token Jupiter does not list yet, and only with your RPC', async () => {
    const noRoute = (async () => new Response(JSON.stringify({ error: 'No routes found' }), { status: 400 })) as unknown as typeof fetch;
    const rpc = await rpcFor(buy);
    const args = { inputMint: buy.inputMint, outputMint: buy.outputMint, amountIn: buy.amount, taker: W, maxFeeBps: 0, fetchImpl: noRoute };
    await expect(ownQuote(args)).rejects.toThrow();
    const own = await ownQuote({ ...args, rpc });
    expect(own).toMatchObject({ outAmount: buy.jupiterOutAmount, curve: true });
    // 5% below the curve's own price by default, as for any curve route.
    expect(own.minOut).toBe(((BigInt(buy.jupiterOutAmount) * 9_500n) / 10_000n).toString());
    expect(await ownQuote({ ...args, rpc, slippageBps: 400 })).toMatchObject({ slippageBps: 400, minOut: ((BigInt(buy.jupiterOutAmount) * 9_400n) / 10_000n).toString() });
    // A token that is not on a curve: Jupiter's refusal stands.
    const elsewhere = await rpcFor(buy, { curve: d => { d[48] = 1; } });
    await expect(ownQuote({ ...args, rpc: elsewhere })).rejects.toThrow();
  });
});
