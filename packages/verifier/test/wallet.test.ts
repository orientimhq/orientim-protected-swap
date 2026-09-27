import { describe, expect, it } from 'vitest';
import {
  generateKeyPairSigner, getTransactionEncoder, partiallySignTransaction, signBytes,
} from '@solana/kit';
import type { Transaction } from '@solana/kit';
import { compileProtectedSwap } from '@orientim/core';
import { verifyWalletReturn } from '../src/index.ts';
import { LIFETIME, scenario } from './fixtures.ts';

async function setup() {
  const owner = await generateKeyPairSigner();
  const s = await scenario({ owner });
  const tx = compileProtectedSwap({
    policy: s.policy, swapInstruction: s.swapIx, intermediates: [], version: 1, lifetime: LIFETIME,
    computeUnitLimit: 400_000, priorityFeeLamports: 20_000n,
  }).transaction;
  return { owner, s, tx };
}

const encode = (tx: Transaction) => new Uint8Array(getTransactionEncoder().encode(tx));

describe('R6: what the wallet returns', () => {
  it('accepts the identical message signed by W', async () => {
    const { owner, s, tx } = await setup();
    const signed = await partiallySignTransaction([owner.keyPair], tx);
    const v = await verifyWalletReturn(tx, encode(signed), owner.address, s.E.address);
    expect(v.violations).toEqual([]);
    expect(v.transaction).not.toBeNull();
  });

  it('rejects a changed message', async () => {
    const { owner, s, tx } = await setup();
    const bytes = Uint8Array.from(tx.messageBytes);
    bytes[bytes.length - 1] ^= 0xff;
    const changed = { ...tx, messageBytes: bytes } as unknown as Transaction;
    const signed = await partiallySignTransaction([owner.keyPair], changed);
    const v = await verifyWalletReturn(tx, encode(signed), owner.address, s.E.address);
    expect(v.violations.map(x => x.detail)).toContain('the wallet changed the transaction message');
  });

  it('rejects a missing wallet signature', async () => {
    const { owner, s, tx } = await setup();
    const v = await verifyWalletReturn(tx, encode(tx), owner.address, s.E.address);
    expect(v.violations.map(x => x.detail)).toContain('the wallet did not sign');
  });

  it('rejects a signature over a different message', async () => {
    const { owner, s, tx } = await setup();
    const other = await signBytes(owner.keyPair.privateKey, new Uint8Array([1, 2, 3]));
    const forged = { ...tx, signatures: { ...tx.signatures, [owner.address]: other } } as Transaction;
    const v = await verifyWalletReturn(tx, encode(forged), owner.address, s.E.address);
    expect(v.violations.map(x => x.detail)).toContain("the wallet's signature does not match the verified message");
  });

  it('rejects a transaction that E has already signed', async () => {
    const { owner, s, tx } = await setup();
    const signed = await partiallySignTransaction([owner.keyPair, s.E.keyPair], tx);
    const v = await verifyWalletReturn(tx, encode(signed), owner.address, s.E.address);
    expect(v.violations.map(x => x.detail)).toContain('the temporary key was already signed by someone else');
  });

  it('rejects bytes that are not a transaction', async () => {
    const { owner, s, tx } = await setup();
    const v = await verifyWalletReturn(tx, new Uint8Array([1, 2, 3]), owner.address, s.E.address);
    expect(v.ok).toBe(false);
  });
});
