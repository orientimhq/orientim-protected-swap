// Against the real solana-agent-kit, when it is installed (`npm install --no-save solana-agent-kit@2.0.10`);
// skipped without it, so the package's own tests need nothing from the kit.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPublicKeyFromAddress, getTransactionDecoder, verifySignature } from '@solana/kit';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { orientimPlugin, walletSigner } from '../src/index.ts';
import type { Deps } from '../src/index.ts';

const name = 'solana-agent-kit';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const kit: any = await import(/* @vite-ignore */ name).catch(() => null);

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';

describe.skipIf(!kit)('with the real solana-agent-kit', () => {
  const calls: unknown[] = [];
  const deps: Deps = {
    decimalsOf: async () => 6,
    protectedSwap: (async (args: unknown) => {
      calls.push(args);
      return { outcome: 'confirmed', signature: 'sig', notices: [] };
    }) as unknown as Deps['protectedSwap'],
  };
  const make = () => {
    const keypair = Keypair.generate();
    const wallet = new kit.KeypairWallet(keypair, 'http://127.0.0.1:1');
    const plugin = orientimPlugin({ apiKey: 'ori_x', policy: { maxAmountIn: { [USDC]: '25000000' }, stateDir: mkdtempSync(join(tmpdir(), 'orientim-kit-')) } }, deps);
    return { keypair, agent: new kit.SolanaAgentKit(wallet, 'http://127.0.0.1:1', {}).use(plugin) };
  };

  it('registers its action and method, and the kit runs the action', async () => {
    const { agent } = make();
    const action = agent.actions.find((a: { name: string }) => a.name === 'ORIENTIM_PROTECTED_SWAP');
    expect(action).toBeDefined();
    const ran = await kit.executeAction(action, agent, { inputMint: USDC, outputMint: SOL, amount: '5' });
    expect(ran).toMatchObject({ status: 'success', signature: 'sig' });
    const called = await agent.methods.protectedSwap(agent, { inputMint: USDC, outputMint: SOL, amount: '1' });
    expect(called.status).toBe('success');
    expect(calls).toHaveLength(2);
  });

  it("the kit's own wallet signs the transaction for the check, the one-time key's place left empty", async () => {
    const { keypair, agent } = make();
    const e = Keypair.generate();
    const message = new TransactionMessage({
      payerKey: keypair.publicKey, recentBlockhash: '11111111111111111111111111111111',
      instructions: [SystemProgram.transfer({ fromPubkey: e.publicKey, toPubkey: keypair.publicKey, lamports: 1 })],
    }).compileToV0Message();
    const tx = getTransactionDecoder().decode(new VersionedTransaction(message).serialize());
    const signer = walletSigner(agent.wallet);
    const [signatures] = await signer.signTransactions([tx as never]);
    expect(await verifySignature(await getPublicKeyFromAddress(signer.address), signatures[signer.address], tx.messageBytes)).toBe(true);
  });
});
