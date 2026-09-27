/**
 * The certificate (idea 35): issued only for a transaction that passed every rule, bound to its
 * exact bytes, and stating what the user approved.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { compileProtectedSwap, JUPITER_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from '@orientim/core';
import type { TxVersion } from '@orientim/core';
import { certificateJson, certify, VERIFIER_VERSION } from '../src/index.ts';
import { BONK, compileRaw, cuIxs, honest, LIFETIME, randomAddress, scenario, USDC } from './fixtures.ts';
import type { Scenario } from './fixtures.ts';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { createNoopSigner } from '@solana/kit';

const compileHonest = (s: Scenario, version: TxVersion) =>
  compileProtectedSwap({
    policy: s.policy, swapInstruction: s.swapIx, intermediates: s.intermediates, version, lifetime: LIFETIME,
    computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, priorityFeeLamports: 20_000n,
    lookupTables: version === 0 ? s.lookupTables : undefined, outputBalanceBefore: s.wOutBalance,
  }).transaction;

describe('certificate', () => {
  for (const [name, opts] of [['USDC → SOL', {}], ['USDC → BONK', { input: USDC, output: BONK }]] as const) {
    for (const version of [0, 1] as const) {
      it(`${name}, v${version}: states what the user approved, bound to the exact bytes`, async () => {
        const s = await scenario(opts);
        const tx = compileHonest(s, version);
        const result = await certify(tx, s.policy, s.snapshot);
        if (!result.ok) throw new Error(JSON.stringify(result.violations));
        const c = result.certificate;
        expect(c.verifierVersion).toBe(VERIFIER_VERSION);
        expect(c.transactionVersion).toBe(version);
        expect(c.messageSha256).toBe(createHash('sha256').update(Uint8Array.from(tx.messageBytes)).digest('hex'));
        expect(c.input.totalDebit).toBe(s.policy.amountIn);
        expect(c.input.swapAmount + c.input.orientimFee).toBe(c.input.totalDebit);
        // Like Jupiter's fee: a sale into SOL pays in SOL, out of the output; a token bought with
        // USDC pays in USDC, out of the input. The minimum stated is what the wallet keeps.
        expect(s.policy.feeSide).toBe(name === 'USDC → SOL' ? 'output' : 'input');
        expect(c.output.minimumOutput + c.output.orientimFee).toBe(s.policy.minOut);
        expect(c.input.orientimFee + c.output.orientimFee).toBe(s.policy.fee);
        expect(c.signers).toEqual([s.W, s.E.address]);
        expect(c.directPrograms).toContain(JUPITER_PROGRAM);
        expect(c.directPrograms).toContain(TOKEN_PROGRAM);
        expect(c.otherTokenDebit).toBe(0);
        expect(c.persistentPermissions).toBe(0);
        // The snapshot of these tests carries no slot; a real read does, and it is carried through.
        expect(c.snapshotSlot).toBe(null);
        expect(JSON.parse(certificateJson(c)).input.totalDebit).toBe(s.policy.amountIn.toString());
      });
    }
  }

  it('a fee in SOL from the wallet is stated as such, with where it goes', async () => {
    const s = await scenario({ input: BONK, output: USDC, feeAccountExists: false, solFee: 777_000n });
    const result = await certify(compileHonest(s, 0), s.policy, s.snapshot);
    if (!result.ok) throw new Error(JSON.stringify(result.violations));
    expect(result.certificate.solFee).toEqual({ lamports: 777_000n, destination: s.treasury });
    expect(result.certificate.input.orientimFee + result.certificate.output.orientimFee).toBe(0n);
    expect(result.certificate.input.swapAmount).toBe(s.policy.amountIn);
  });

  it('names the slot the chain state was read at, when the reader recorded one', async () => {
    const s = await scenario();
    const tx = await compileHonest(s, 0);
    const result = await certify(tx, s.policy, { ...s.snapshot, slot: 123_456_789n });
    expect(result.ok && result.certificate.snapshotSlot).toBe(123_456_789n);
  });

  it('is never issued for a transaction that fails a rule', async () => {
    const s = await scenario();
    const stray = getTransferCheckedInstruction({
      source: s.policy.accounts.wIn!, mint: USDC, destination: await randomAddress(), authority: createNoopSigner(s.W),
      amount: 1n, decimals: 6,
    });
    const tx = compileRaw(s.W, [...cuIxs(), ...honest(s), stray], 0, s.lookupTables);
    const result = await certify(tx, s.policy, s.snapshot);
    expect(result.ok).toBe(false);
    expect('certificate' in result).toBe(false);
  });

  it('a SOL output names WSOL as the output mint', async () => {
    const s = await scenario();
    const result = await certify(compileHonest(s, 1), s.policy, s.snapshot);
    expect(result.ok && result.certificate.output.mint).toBe(WSOL_MINT);
  });
});
