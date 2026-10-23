// Swaps 5 USDC for SOL, verified on your own RPC before the wallet signs.
//   npm install --save-exact @orientimhq/swap@3.0.1
//   SOLANA_RPC_URL=... ORIENTIM_API_KEY=ori_... JUPITER_API_KEY=... ORIENTIM_WALLET_KEYPAIR=./wallet.json npx tsx swap.ts
import { readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes, createSolanaRpc } from '@solana/kit';
import { acquireLock, createFileStore, loadPolicy, policyPathFor, protectedSwap, recoverPending, stateDirFor } from '@orientimhq/swap';

const wallet = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(process.env.ORIENTIM_WALLET_KEYPAIR!, 'utf8'))));
const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL!);
const policyPath = policyPathFor(process.env.ORIENTIM_POLICY); // Owner limits; /etc/orientim/policy.json takes precedence.
const policy = policyPath ? loadPolicy(policyPath) : undefined;
const { dir } = stateDirFor(policy, process.env.ORIENTIM_STATE_DIR);
const store = createFileStore(dir); // Keeps each signed swap until it settles.
const release = acquireLock(dir, wallet.address); // One run per wallet at a time.
try {
  // Settle any earlier swap that may still land before starting a new one.
  if ((await recoverPending(store, rpc, { orders: store, spends: store })).unknown.length) throw new Error('Settle the earlier swap first.');
  const result = await protectedSwap({
    apiUrl: 'https://orientim.com', apiKey: process.env.ORIENTIM_API_KEY!, jupiterApiKey: process.env.JUPITER_API_KEY, rpc, wallet,
    intent: { id: 'order-1', inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', outputMint: 'So11111111111111111111111111111111111111112', amountIn: '5000000' },
    pending: store, orders: store, spends: store, ...(policy ? { policy } : {}),
  });
  console.log(result.outcome, result.signature, result.received ?? '');
} finally {
  release();
}
