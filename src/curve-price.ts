import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { PUMP_CURVE_PROGRAM, WSOL_MINT } from '@orientimhq/core/constants';
import { readAccounts } from '@orientimhq/solana';
import { bondingCurveOf } from '@orientimhq/verifier';

/** Pump's fee program, whose `fee_config` for the curve program holds the curve's trading fees. */
const PUMP_FEES_PROGRAM = address('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Your own price for a swap on an active Pump.fun bonding curve, read from the curve on your RPC:
 * what the curve pays out at its reserves less Pump's fees, as the curve program computes it. Jupiter
 * may not list a token in its first seconds on its curve; this prices it without Jupiter. Null when
 * the pair is not SOL and a token still on a curve quoted in SOL, or when the fees cannot be read.
 */
export async function curvePrice(
  rpc: Rpc<SolanaRpcApi>, inputMint: string, outputMint: string, amount: bigint, timeoutMs = 10_000,
): Promise<{ outAmount: bigint; priceImpactBps: number } | null> {
  const isBuy = inputMint === WSOL_MINT && outputMint !== WSOL_MINT;
  const isSell = outputMint === WSOL_MINT && inputMint !== WSOL_MINT;
  if ((!isBuy && !isSell) || amount <= 0n) return null;
  const curveAddress = await bondingCurveOf((isBuy ? outputMint : inputMint) as Address);
  const [feeConfig] = await getProgramDerivedAddress({
    programAddress: PUMP_FEES_PROGRAM, seeds: [new TextEncoder().encode('fee_config'), getAddressEncoder().encode(PUMP_CURVE_PROGRAM)],
  });
  const { accounts } = await readAccounts(rpc as never, [curveAddress, feeConfig], { timeoutMs });
  const curve = accounts.get(curveAddress);
  const config = accounts.get(feeConfig);
  // The curve: five u64 reserves after the discriminator, `complete` at 48, `quote_mint` at 83
  // (the default key for SOL) and the curve's own `creator_fee_bps` at 115.
  if (!curve || curve.owner !== PUMP_CURVE_PROGRAM || curve.data.length < 123 || curve.data[48] !== 0) return null;
  if (curve.data.subarray(83, 115).some(b => b !== 0)) return null;
  if (!config || config.owner !== PUMP_FEES_PROGRAM) return null;
  const c = new DataView(curve.data.buffer, curve.data.byteOffset, curve.data.byteLength);
  const virtualToken = c.getBigUint64(8, true);
  const virtualQuote = c.getBigUint64(16, true);
  const realToken = c.getBigUint64(24, true);
  const realQuote = c.getBigUint64(32, true);
  const supply = c.getBigUint64(40, true);
  const ownCreatorBps = c.getBigUint64(115, true);
  if (!virtualToken || !virtualQuote) return null;

  // fee_config: discriminator, bump, admin, flat fees (lp, protocol, creator as u64), then the tiers,
  // each a u128 market cap in lamports and its fees; the highest tier the curve's market cap reaches.
  const f = new DataView(config.data.buffer, config.data.byteOffset, config.data.byteLength);
  const tiersAt = 8 + 1 + 32 + 24;
  if (config.data.length < tiersAt + 4) return null;
  const count = f.getUint32(tiersAt, true);
  if (count > 64 || config.data.length < tiersAt + 4 + 40 * count) return null;
  const marketCap = (virtualQuote * supply) / virtualToken;
  let protocolBps = f.getBigUint64(tiersAt - 16, true);
  let creatorBps = f.getBigUint64(tiersAt - 8, true);
  for (let i = 0; i < count; i++) {
    const at = tiersAt + 4 + 40 * i;
    const threshold = f.getBigUint64(at, true) + (f.getBigUint64(at + 8, true) << 64n);
    if (i === 0 || marketCap >= threshold) {
      protocolBps = f.getBigUint64(at + 24, true);
      creatorBps = f.getBigUint64(at + 32, true);
    }
  }
  if (ownCreatorBps > 0n) creatorBps = ownCreatorBps;
  if (protocolBps + creatorBps >= BPS) return null;

  let out: bigint;
  if (isBuy) {
    // The fees come off what goes in, each rounded up; the rest buys at the virtual reserves.
    let net = (amount * BPS) / (BPS + protocolBps + creatorBps);
    const total = net + ceilDiv(net * protocolBps, BPS) + ceilDiv(net * creatorBps, BPS);
    if (total > amount) net -= total - amount;
    out = net > 1n ? (virtualToken * (net - 1n)) / (virtualQuote + net - 1n) : 0n;
    // A buy past what is left on the curve cannot be filled at this price.
    if (out >= realToken) return null;
  } else {
    const gross = (amount * virtualQuote) / (virtualToken + amount);
    if (gross > realQuote) return null;
    out = gross - ceilDiv(gross * protocolBps, BPS) - ceilDiv(gross * creatorBps, BPS);
  }
  if (out <= 0n) return null;
  // Against the curve's price before the trade, Pump's fees included.
  const spot = isBuy ? (amount * virtualToken) / virtualQuote : (amount * virtualQuote) / virtualToken;
  const impact = spot > out ? Number(((spot - out) * BPS) / spot) : 0;
  return { outAmount: out, priceImpactBps: impact };
}
