// The plugin as npm ships it, in an app with the real kit, on plain Node (CI copies this file into that
// app). The RPC answers nothing, so the swap stops at its first look at the chain: the point is that
// the published files load and the kit runs the action through them.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { KeypairWallet, SolanaAgentKit, createVercelAITools, executeAction } from 'solana-agent-kit';
import { ACTION_NAME, orientimPlugin } from '@orientimhq/solana-agent-kit';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const RPC = 'http://127.0.0.1:1';
const plugin = () => orientimPlugin({ apiKey: 'ori_x', policy: { maxAmountIn: { [USDC]: '1000000' }, stateDir: mkdtempSync(join(tmpdir(), 'kit-')) } });
const kit = config => new SolanaAgentKit(new KeypairWallet(Keypair.generate(), RPC), RPC, config);

const agent = kit({}).use(plugin());
const actions = agent.actions.filter(a => a.name === ACTION_NAME);
assert.equal(actions.length, 1);
assert.equal(Object.keys(createVercelAITools(agent, actions)).length, 1);

const ran = await executeAction(actions[0], agent, { inputMint: USDC, outputMint: SOL, amount: '1', slippageBps: null, orderId: null, acceptCostBps: null });
assert.equal(ran.status, 'error');
assert.match(ran.orderId, /^kit-/);
assert.equal((await agent.methods.protectedSwap(agent, { inputMint: USDC, outputMint: SOL, amount: '1' })).status, 'error');

assert.throws(() => kit({ signOnly: true }).use(plugin()), /signOnly/);
console.log('ok');
