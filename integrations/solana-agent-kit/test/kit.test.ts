// Against the real solana-agent-kit and its tool adapters, when they are installed
// (`npm install --no-save solana-agent-kit@2.0.10 @solana-agent-kit/adapter-mcp@2.0.7`); skipped without
// them, so the package's own tests need nothing from the kit.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPublicKeyFromAddress, getTransactionDecoder, verifySignature } from '@solana/kit';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ACTION_NAME, orientimPlugin, walletSigner } from '../src/index.ts';
import type { Deps } from '../src/index.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const optional = (name: string): Promise<any> => import(/* @vite-ignore */ name).catch(() => null);
const kit = await optional('solana-agent-kit');
const mcp = await optional('@solana-agent-kit/adapter-mcp');
// The JSON schema the AI SDK and LangChain send the model, by the converter they use.
const zodToJsonSchema = (await optional('zod-to-json-schema'))?.zodToJsonSchema;

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const swap = { inputMint: USDC, outputMint: SOL, amount: '5', slippageBps: null, orderId: null };

const make = (config: Record<string, unknown> = {}) => {
  const calls: { intent: { id: string; amountIn: string; slippageBps?: number } }[] = [];
  const deps: Deps = {
    decimalsOf: async (_rpc, mint) => (mint === SOL ? 9 : 6),
    protectedSwap: (async (args: (typeof calls)[number]) => {
      calls.push(args);
      return { outcome: 'confirmed', signature: 'sig', notices: [], received: '31000000' };
    }) as unknown as Deps['protectedSwap'],
  };
  const keypair = Keypair.generate();
  const wallet = new kit.KeypairWallet(keypair, 'http://127.0.0.1:1');
  const plugin = orientimPlugin({ apiKey: 'ori_x', policy: { maxAmountIn: { [USDC]: '25000000' }, stateDir: mkdtempSync(join(tmpdir(), 'orientim-kit-')) } }, deps);
  const agent = new kit.SolanaAgentKit(wallet, 'http://127.0.0.1:1', config).use(plugin);
  return { keypair, agent, calls, action: agent.actions.find((a: { name: string }) => a.name === ACTION_NAME) };
};

describe.skipIf(!kit)('with the real solana-agent-kit', () => {
  it('registers its action and method, and the kit runs the action', async () => {
    const { agent, action, calls } = make();
    expect(action).toBeDefined();
    const ran = await kit.executeAction(action, agent, swap);
    expect(ran).toMatchObject({ status: 'success', signature: 'sig', receivedAmount: '0.031', received: '31000000' });
    const called = await agent.methods.protectedSwap(agent, { inputMint: USDC, outputMint: SOL, amount: '1' });
    expect(called.status).toBe('success');
    expect(calls.map(c => c.intent.amountIn)).toEqual(['5000000', '1000000']);
  });

  it('is refused by a kit set to sign only, since the swap is sent within the call', () => {
    expect(() => make({ signOnly: true })).toThrow('signOnly');
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
    expect(Object.keys(signatures)).toEqual([signer.address]);
    expect(await verifySignature(await getPublicKeyFromAddress(signer.address), signatures[signer.address], tx.messageBytes)).toBe(true);
  });
});

// Each of the kit's adapters turns the action into a model's tool its own way. The two fields the
// model may leave unset must reach every one of them as nullable, never as a value it has to invent.
describe.skipIf(!kit)("through each of the kit's tool adapters", () => {
  type Field = { type?: unknown; anyOf?: { type?: unknown }[]; description?: string };
  const takesNull = (f: Field) => (Array.isArray(f.type) && f.type.includes('null')) || !!f.anyOf?.some(o => o.type === 'null');
  const unset = (schema: { properties: Record<string, Field> }) => {
    for (const field of ['slippageBps', 'orderId']) {
      expect(takesNull(schema.properties[field])).toBe(true);
      expect(schema.properties[field].description).toBeTruthy();
    }
    expect(schema.properties.orderId.description).toContain('Never invent');
  };

  it('Vercel AI SDK', async () => {
    const { agent, action, calls } = make();
    const tools = kit.createVercelAITools(agent, [action]);
    unset(zodToJsonSchema(tools['0'].parameters) as never);
    const ran = await tools['0'].execute(swap, {});
    expect(ran).toMatchObject({ status: 'success', receivedAmount: '0.031' });
    expect(calls[0].intent.id).toMatch(/^kit-/);
    expect(calls[0].intent).not.toHaveProperty('slippageBps');
  });

  it('LangChain', async () => {
    const { agent, action } = make();
    const [tool] = kit.createLangchainTools(agent, [action]);
    unset(zodToJsonSchema(tool.schema) as never);
    expect(JSON.parse(await tool.invoke({ ...swap, slippageBps: 50 }))).toMatchObject({ status: 'success' });
  });

  it('OpenAI Agents', async () => {
    const { agent, action, calls } = make();
    const [tool] = kit.createOpenAITools(agent, [action]);
    expect(tool.parameters.required).toEqual(['inputMint', 'outputMint', 'amount', 'slippageBps', 'orderId']);
    unset(tool.parameters);
    expect(await tool.invoke({}, JSON.stringify({ ...swap, orderId: '' }))).toMatchObject({ status: 'success' });
    // An empty orderId is a new order, as null is.
    expect(calls[0].intent.id).toMatch(/^kit-/);
  });

  it.skipIf(!mcp)('MCP', async () => {
    const { agent, action } = make();
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const server = mcp.createMcpServer({ [ACTION_NAME]: action }, agent, { name: 'kit', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    unset(tools[0].inputSchema as never);
    const result = await client.callTool({ name: ACTION_NAME, arguments: swap });
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ status: 'success' });
    await client.close();
  });
});
