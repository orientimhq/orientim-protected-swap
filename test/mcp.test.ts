/**
 * The MCP server (src/mcp.ts, `orientim mcp`): the protocol, the four tools, whole
 * tokens to base units and back, a swap tied to the quote the user saw, and answers that never carry
 * an RPC's key. The swap itself is the example's command line, tested in skill.test.ts; here it is a
 * fake that answers as the command does.
 */
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commandEnv, createServer, fileQuoteStore, fromBaseUnits, InputError, MODEL_CEILINGS, mintDecimalsOf, ownerCeilings, PROTOCOL_VERSIONS, SERVER_VERSION, toBaseUnits, tokenAmountOf, TOOLS, withoutBlanks, withoutSecrets,
  type McpDeps, type Run, type RunOptions,
} from '../src/mcp.ts';
import { SKILL_VERSION } from '../src/api.ts';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../packages/core/src/constants.ts';

const ROOT = join(import.meta.dirname, '..');
const W = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SIG = '5'.repeat(87);

type Call = { command: 'swap' | 'verify'; args: string[]; options: RunOptions };

/** The dry run's answer, as `orientim swap` prints it. */
const dryRun = (over: Record<string, unknown> = {}) => JSON.stringify({
  yourFloor: '1490000', yourQuote: '1497000',
  approval: { minOut: '1490000', until: new Date(Date.UTC(2026, 9, 11, 12, 10)).toISOString() },
  priceImpactBps: 3, slippageBps: 50,
  amounts: { amountIn: '10000000', fee: '25000', feeBps: 25, swapAmount: '9975000', quotedOut: '1500000', minOut: '1490000' },
  costs: { networkFeeLamports: '5000', outputAccountRentLamports: '0', routeRentLamports: '0', routeRefundLamports: '0', keptSolLamports: '5000' },
  blocksLeft: 140, problems: [], notices: [], tokenRisk: {},
  ...over,
});

function harness(runs: ((call: Call) => Run | Promise<Run>)[], over: Partial<McpDeps> = {}) {
  const calls: Call[] = [];
  let clock = Date.UTC(2026, 9, 11, 12, 0);
  let ids = 0;
  const deps: McpDeps = {
    run: async (command, args, options) => {
      const call = { command, args, options };
      calls.push(call);
      const next = runs.shift();
      if (!next) throw new Error(`no run expected: ${command} ${args.join(' ')}`);
      return next(call);
    },
    wallet: async () => W,
    decimals: async mint => (mint === BONK ? 5 : Promise.reject(new InputError(`${mint} is not a token mint on your RPC.`))),
    balances: async (_owner, mints) => ({ lamports: 1_500_000_000n, tokens: Object.fromEntries(mints.map(m => [m, 123_45000n])) }),
    now: () => clock,
    newId: () => `0000000${++ids}-aaaa-bbbb-cccc-dddddddddddd`,
    ...over,
  };
  const server = createServer(deps);
  const sent: Record<string, unknown>[] = [];
  const send = (m: unknown) => { sent.push(m as Record<string, unknown>); };
  let next = 100;
  const request = async (method: string, params?: unknown) => {
    const id = next++;
    await server.receive(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }), send);
    return sent.find(m => m.id === id) as { result?: Record<string, unknown>; error?: { code: number; message: string } } | undefined;
  };
  const tool = async (name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) => {
    const r = await request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    const result = r?.result as { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError: boolean };
    return { ...result, answer: JSON.parse(result.content[0].text) as Record<string, any> };
  };
  return { server, calls, sent, send, request, tool, advance: (ms: number) => { clock += ms; } };
}

const ok = (stdout: string, stderr = ''): Run => ({ code: 0, stdout, stderr });

describe('whole tokens and base units', () => {
  it('converts exactly, both ways', () => {
    expect(toBaseUnits('0.1', 9)).toBe(100_000_000n);
    expect(toBaseUnits('25', 6)).toBe(25_000_000n);
    expect(toBaseUnits('1.500000', 6)).toBe(1_500_000n);
    expect(toBaseUnits('0.00001', 5)).toBe(1n);
    expect(toBaseUnits('7', 0)).toBe(7n);
    expect(fromBaseUnits('1500000', 6)).toBe('1.5');
    expect(fromBaseUnits(1n, 9)).toBe('0.000000001');
    expect(fromBaseUnits('25000000', 6)).toBe('25');
    expect(fromBaseUnits('0', 6)).toBe('0');
    expect(fromBaseUnits('7', 0)).toBe('7');
  });

  it('never rounds, and refuses what is not an amount', () => {
    expect(() => toBaseUnits('0.0000000001', 9)).toThrow(/9 decimals/);
    expect(() => toBaseUnits('0', 9)).toThrow(/more than zero/);
    expect(() => toBaseUnits('-1', 9)).toThrow(InputError);
    expect(() => toBaseUnits('1e3', 9)).toThrow(InputError);
    expect(() => toBaseUnits('1,5', 9)).toThrow(InputError);
    expect(() => toBaseUnits('.5', 9)).toThrow(InputError);
    expect(() => toBaseUnits('99999999999999999999', 9)).toThrow(/larger than any/);
  });
});

describe('the protocol', () => {
  it('answers initialize in the version the client asked for, or the newest', async () => {
    const h = harness([]);
    const old = await h.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(old?.result?.protocolVersion).toBe('2024-11-05');
    const unknown = await h.request('initialize', { protocolVersion: '1999-01-01' });
    expect(unknown?.result?.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect(unknown?.result?.serverInfo).toMatchObject({ name: 'orientim-protected-swap', version: SERVER_VERSION });
    expect(unknown?.result?.capabilities).toEqual({ tools: { listChanged: false } });
    expect(String(unknown?.result?.instructions)).toContain('orientim_quote first');
  });

  it('is the version the skill ships', () => {
    expect(SERVER_VERSION).toBe(SKILL_VERSION);
  });

  it('lists four tools, each with a schema that refuses anything else', async () => {
    const h = harness([]);
    const list = await h.request('tools/list');
    const tools = list?.result?.tools as typeof TOOLS;
    expect(tools.map(t => t.name)).toEqual(['orientim_wallet', 'orientim_quote', 'orientim_swap', 'orientim_recover']);
    for (const t of tools) {
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.description.length).toBeGreaterThan(40);
    }
    expect(tools.find(t => t.name === 'orientim_wallet')?.annotations.readOnlyHint).toBe(true);
    expect(tools.find(t => t.name === 'orientim_swap')?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
    // No tool takes a key, a floor of its own or a fee limit: those stay the owner's.
    const inputs = tools.flatMap(t => Object.keys(t.inputSchema.properties));
    expect(inputs.sort()).toEqual(['acceptCostBps', 'amount', 'inputMint', 'maxPriceImpactBps', 'mints', 'outputMint', 'quoteId', 'slippageBps']);
  });

  it('answers ping, and refuses unknown methods, bad JSON and bad requests', async () => {
    const h = harness([]);
    expect((await h.request('ping'))?.result).toEqual({});
    expect((await h.request('resources/list'))?.error?.code).toBe(-32601);
    await h.server.receive('{not json', h.send);
    expect(h.sent.at(-1)).toMatchObject({ id: null, error: { code: -32700 } });
    await h.server.receive(JSON.stringify({ id: 9, method: 'ping' }), h.send);
    expect(h.sent.at(-1)).toMatchObject({ id: 9, error: { code: -32600 } });
    await h.server.receive(JSON.stringify([]), h.send);
    expect(h.sent.at(-1)).toMatchObject({ error: { code: -32600 } });
    const count = h.sent.length;
    await h.server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), h.send);
    await h.server.receive('   ', h.send);
    expect(h.sent.length).toBe(count);
  });

  it('answers a batch in one message', async () => {
    const h = harness([]);
    await h.server.receive(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]), h.send);
    const batch = h.sent.at(-1) as unknown as { id: number }[];
    expect(batch.map(m => m.id)).toEqual([1, 2]);
  });

  it('refuses an unknown tool as a protocol error, and bad arguments as a tool error', async () => {
    const h = harness([]);
    expect((await h.request('tools/call', { name: 'orientim_drain', arguments: {} }))?.error?.code).toBe(-32602);
    const bad = await h.tool('orientim_quote', { inputMint: 'USDC', outputMint: SOL, amount: '1' });
    expect(bad.isError).toBe(true);
    expect(bad.answer.error).toEqual({ code: 'input', line: 'inputMint must be a mint address.' });
    expect(h.calls).toHaveLength(0);
  });

  it('gives structured content from 2025-06-18 on, text alone before', async () => {
    const h = harness([]);
    await h.request('initialize', { protocolVersion: '2025-03-26' });
    expect((await h.tool('orientim_wallet')).structuredContent).toBeUndefined();
    await h.request('initialize', { protocolVersion: '2025-06-18' });
    expect((await h.tool('orientim_wallet')).structuredContent).toMatchObject({ ok: true, wallet: W });
  });
});

describe('orientim_wallet', () => {
  it('reads SOL and each mint asked for, in whole tokens', async () => {
    const h = harness([]);
    const { answer, isError } = await h.tool('orientim_wallet', { mints: [BONK, SOL, BONK] });
    expect(isError).toBe(false);
    expect(answer).toEqual({
      ok: true, wallet: W,
      sol: { mint: SOL, amount: '1.5', baseUnits: '1500000000' },
      tokens: [{ mint: BONK, amount: '123.45', baseUnits: '12345000', decimals: 5 }],
    });
  });

  it('says plainly when a mint is not a token', async () => {
    const h = harness([]);
    const { answer } = await h.tool('orientim_wallet', { mints: [W] });
    expect(answer.error).toEqual({ code: 'input', line: `${W} is not a token mint on your RPC.` });
  });
});

describe('mints and token accounts, read from their bytes', () => {
  // The verifier's own: 1.12.0 and 1.12.1 named Token-2022 by a wrong address, and no Token-2022 mint
  // was a mint to them.
  const TOKEN = TOKEN_PROGRAM;
  const TOKEN_2022 = TOKEN_2022_PROGRAM;
  const mint = (length: number, decimals: number, kind?: number) => {
    const b = new Uint8Array(length);
    b[44] = decimals;
    b[45] = 1;
    if (kind !== undefined) b[165] = kind;
    return b;
  };

  it('a mint of either token program, extensions and all', () => {
    expect(mintDecimalsOf(TOKEN, mint(82, 6))).toBe(6);
    expect(mintDecimalsOf(TOKEN_2022, mint(82, 9))).toBe(9);
    // PYUSD's kind: a Token-2022 mint with extensions, which some RPCs cannot give as jsonParsed.
    expect(mintDecimalsOf(TOKEN_2022, mint(560, 6, 1))).toBe(6);
  });

  it('nothing else is a mint', () => {
    expect(mintDecimalsOf(TOKEN_2022, mint(300, 6, 2))).toBeUndefined();
    expect(mintDecimalsOf(TOKEN, mint(165, 6))).toBeUndefined();
    expect(mintDecimalsOf(TOKEN, mint(300, 6, 1))).toBeUndefined();
    expect(mintDecimalsOf('11111111111111111111111111111111', mint(82, 6))).toBeUndefined();
    const uninitialized = mint(82, 6);
    uninitialized[45] = 0;
    expect(mintDecimalsOf(TOKEN, uninitialized)).toBeUndefined();
  });

  it('a token account\'s amount, after its mint and its owner', () => {
    const account = new Uint8Array(170);
    Buffer.from(account.buffer).writeBigUInt64LE(18_446_744_073_709_551_615n, 64);
    expect(tokenAmountOf(account)).toBe(18_446_744_073_709_551_615n);
    expect(tokenAmountOf(account.subarray(0, 100))).toBeUndefined();
  });
});

describe('orientim_quote', () => {
  it('runs the dry run in base units for this wallet, and answers in whole tokens with a quoteId', async () => {
    const h = harness([() => ok(dryRun())]);
    const { answer, isError } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01', slippageBps: 'auto', maxPriceImpactBps: 100 });
    expect(isError).toBe(false);
    expect(h.calls[0].command).toBe('swap');
    expect(h.calls[0].args).toEqual(['--in', SOL, '--out', USDC, '--amount', '10000000', '--owner', W, '--dry-run', '--slippage-bps', 'auto', '--max-price-impact-bps', '100']);
    expect(answer.quoteId).toBe('00000001-aaaa-bbbb-cccc-dddddddddddd');
    expect(answer.summary).toEqual({
      pay: { amount: '0.01', mint: SOL },
      receiveAtLeast: { amount: '1.49', mint: USDC },
      // The agent's own Jupiter price, not Orientim's quotedOut (1.5).
      expected: { amount: '1.497', mint: USDC },
      orientimFee: { amount: '0.000025', mint: SOL },
      solCost: '0.000005',
      priceImpactBps: 3,
      slippageBps: 50,
      approvedUntil: '2026-10-11T12:10:00.000Z',
    });
    expect(answer.meaning).toMatch(/ask for a clear yes/);
  });

  it('gives no quoteId when the dry run found problems', async () => {
    const h = harness([() => ({ code: 1, stdout: dryRun({ approval: undefined, problems: ['R3: the route can take more than the amount'] }), stderr: '' })]);
    const { answer, isError } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    expect(isError).toBe(true);
    expect(answer.quoteId).toBeUndefined();
    expect(answer.answer.problems).toEqual(['R3: the route can take more than the amount']);
  });

  it("names the command's error, with every URL cut to its host", async () => {
    const h = harness([() => ({
      code: 1, stdout: '',
      stderr: '(node:1) ExperimentalWarning: Type Stripping\nprice-impact-high: The price impact is 7.20%, above 5%. Seen on https://mainnet.helius-rpc.com/?api-key=SECRET123 today.\n',
    })]);
    const { answer } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    expect(answer.error.code).toBe('price-impact-high');
    expect(JSON.stringify(answer)).not.toContain('SECRET123');
    expect(answer.error.line).toContain('https://mainnet.helius-rpc.com/…');
    expect(answer.log.join('\n')).not.toContain('ExperimentalWarning');
  });

  it('reads the decimals of a token that is not SOL, USDC or USDT', async () => {
    const h = harness([() => ok(dryRun())]);
    await h.tool('orientim_quote', { inputMint: BONK, outputMint: USDC, amount: '1000.5' });
    expect(h.calls[0].args.slice(4, 6)).toEqual(['--amount', '100050000']);
  });

  it('refuses limits out of range before anything runs', async () => {
    const h = harness([]);
    for (const extra of [{ slippageBps: 5 }, { slippageBps: 2000 }, { slippageBps: 'max' }, { maxPriceImpactBps: 5000 }, { acceptCostBps: -1 }, { acceptCostBps: 1.5 }]) {
      const { answer } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '1', ...extra });
      expect(answer.error.code).toBe('input');
    }
    const same = await h.tool('orientim_quote', { inputMint: USDC, outputMint: USDC, amount: '1' });
    expect(same.answer.error.line).toMatch(/same token/);
    expect(h.calls).toHaveLength(0);
  });

  it('keeps the tolerance and the price impact the model may ask for within the owner\'s ceilings', async () => {
    const h = harness([]);
    for (const extra of [{ slippageBps: MODEL_CEILINGS.slippageBps + 1 }, { slippageBps: 1500 }, { maxPriceImpactBps: MODEL_CEILINGS.priceImpactBps + 1 }, { maxPriceImpactBps: 2000 }]) {
      const { answer } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '1', ...extra });
      expect(answer.error).toMatchObject({ code: 'input', line: expect.stringMatching(/only the owner raises it/) });
    }
    expect(h.calls).toHaveLength(0);
    const raised = harness([() => ok(dryRun())], { ceilings: { slippageBps: 1000, priceImpactBps: 1500 } });
    const { isError } = await raised.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01', slippageBps: 1000, maxPriceImpactBps: 1500 });
    expect(isError).toBe(false);
    expect(raised.calls[0].args).toEqual(expect.arrayContaining(['--slippage-bps', '1000', '--max-price-impact-bps', '1500']));
  });

  it('reads the owner\'s ceilings from the environment, and refuses one it cannot read', () => {
    expect(ownerCeilings({})).toEqual({});
    expect(ownerCeilings({ ORIENTIM_MAX_SLIPPAGE_BPS: '800', ORIENTIM_MAX_PRICE_IMPACT_BPS: '0' })).toEqual({ slippageBps: 800, priceImpactBps: 0 });
    for (const bad of [{ ORIENTIM_MAX_SLIPPAGE_BPS: '5' }, { ORIENTIM_MAX_SLIPPAGE_BPS: '2000' }, { ORIENTIM_MAX_SLIPPAGE_BPS: '3%' }, { ORIENTIM_MAX_PRICE_IMPACT_BPS: '2001' }]) {
      expect(() => ownerCeilings(bad)).toThrow(/whole number of bps/);
    }
  });

  it('reports progress to a client that asked for it', async () => {
    const h = harness([({ options }) => {
      options.onLine?.('Pricing on https://rpc.example/key/abc');
      return ok(dryRun());
    }]);
    await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' }, { progressToken: 'p1' });
    const progress = h.sent.filter(m => m.method === 'notifications/progress').map(m => m.params as { progressToken: string; progress: number; message: string });
    expect(progress.map(p => p.progress)).toEqual([1, 2]);
    expect(progress.every(p => p.progressToken === 'p1')).toBe(true);
    expect(progress[1].message).toBe('Pricing on https://rpc.example/…');
  });
});

describe('orientim_swap', () => {
  it("swaps the quote under an order id the model never chooses, with the quote's own limits", async () => {
    const h = harness([
      () => ok(dryRun()),
      () => ok(JSON.stringify({ signature: SIG, outcome: 'confirmed', refusal: null, meaning: 'Swapped.', amounts: {}, received: '1497000' })),
    ]);
    const { answer: q } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01', slippageBps: 100 });
    const { answer, isError } = await h.tool('orientim_swap', { quoteId: q.quoteId });
    expect(isError).toBe(false);
    expect(h.calls[1].args).toEqual(['--in', SOL, '--out', USDC, '--amount', '10000000', '--id', `mcp-${q.quoteId}`, '--min-out', '1490000', '--slippage-bps', '100']);
    // Never stopped by the client: what it signed is settled on the chain.
    expect(h.calls[1].options.signal).toBeUndefined();
    expect(answer).toMatchObject({
      ok: true, outcome: 'confirmed', signature: SIG, explorer: `https://solscan.io/tx/${SIG}`, received: { amount: '1.497', mint: USDC }, exitCode: 0,
    });
  });

  it('takes the same quote again under the same order while the yes holds, and only recover after it', async () => {
    const h = harness([
      () => ok(dryRun()),
      () => ({ code: 3, stdout: '', stderr: 'The outcome of an earlier swap is still unknown.\n' }),
      () => ({ code: 5, stdout: '', stderr: 'This order already swapped.\n' }),
    ]);
    const { answer: q } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    const first = await h.tool('orientim_swap', { quoteId: q.quoteId });
    expect(first.answer.meaning).toMatch(/orientim_recover/);
    h.advance(5 * 60_000);
    const again = await h.tool('orientim_swap', { quoteId: q.quoteId });
    expect(h.calls[2].args).toContain(`mcp-${q.quoteId}`);
    expect(again.answer.exitCode).toBe(5);
    // A day later the yes no longer stands: a retry would build a new swap at a later market.
    h.advance(25 * 60 * 60_000);
    const late = await h.tool('orientim_swap', { quoteId: q.quoteId });
    expect(late.answer.error.line).toMatch(/has expired.*orientim_recover/);
    expect(h.calls).toHaveLength(3);
  });

  it('never swaps a tried quote once its yes expired, however long it was kept', async () => {
    const h = harness([
      () => ok(dryRun()),
      () => ({ code: 1, stdout: JSON.stringify({ outcome: 'expired', meaning: 'Nothing was swapped.' }), stderr: '' }),
    ]);
    const { answer: q } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    expect((await h.tool('orientim_swap', { quoteId: q.quoteId })).answer.ok).toBe(false);
    for (const later of [11 * 60_000, 24 * 60 * 60_000 + 10 * 60_000]) {
      h.advance(later);
      expect((await h.tool('orientim_swap', { quoteId: q.quoteId })).answer.error.code).toBe('input');
    }
    expect(h.calls).toHaveLength(2);
  });

  it('asks the person through a client that can, and signs nothing without their yes', async () => {
    for (const [answer, swapped] of [
      [{ action: 'accept', content: { confirm: true } }, true],
      [{ action: 'accept', content: { confirm: false } }, false],
      [{ action: 'decline' }, false],
      [{ action: 'cancel' }, false],
    ] as const) {
      const h = harness([() => ok(dryRun()), () => ok(JSON.stringify({ signature: SIG, outcome: 'confirmed' }))]);
      await h.request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 't', version: '1' } });
      const { answer: q } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
      const call = h.tool('orientim_swap', { quoteId: q.quoteId });
      await new Promise(r => setTimeout(r, 0));
      const asked = h.sent.find(m => m.method === 'elicitation/create') as { id: string; params: { message: string } };
      expect(asked.params.message).toBe(`Swap 0.01 of ${SOL} for at least 1.49 of ${USDC}, Orientim's fee 0.000025 of ${SOL}, 0.000005 SOL in network costs?`);
      await h.server.receive(JSON.stringify({ jsonrpc: '2.0', id: asked.id, result: answer }), h.send);
      const { answer: done } = await call;
      expect(done.ok).toBe(swapped);
      expect(h.calls).toHaveLength(swapped ? 2 : 1);
    }
  });

  it('does not ask a client that cannot', async () => {
    const h = harness([() => ok(dryRun()), () => ok(JSON.stringify({ signature: SIG, outcome: 'confirmed' }))]);
    await h.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const { answer: q } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    expect((await h.tool('orientim_swap', { quoteId: q.quoteId })).answer.ok).toBe(true);
    expect(h.sent.some(m => m.method === 'elicitation/create')).toBe(false);
  });

  it('refuses a quote it never gave, one a newer quote replaced, and one whose yes expired', async () => {
    const h = harness([() => ok(dryRun()), () => ok(dryRun()), () => ok(dryRun())]);
    expect((await h.tool('orientim_swap', { quoteId: '12345678-0000' })).answer.error.line).toMatch(/No quote with this id/);
    const { answer: a } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    const { answer: b } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    expect((await h.tool('orientim_swap', { quoteId: a.quoteId })).answer.error.line).toMatch(/newer quote/);
    h.advance(11 * 60_000);
    expect((await h.tool('orientim_swap', { quoteId: b.quoteId })).answer.error.line).toMatch(/has expired/);
    const { answer: c } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.02' });
    expect(c.quoteId).toBeDefined();
    expect(h.calls).toHaveLength(3);
  });

  it('lets a newer quote of the same swap replace one already tried', async () => {
    const h = harness([
      () => ok(dryRun()),
      () => ({ code: 1, stdout: JSON.stringify({ outcome: 'failed', meaning: 'Nothing was swapped.' }), stderr: '' }),
      () => ok(dryRun()),
    ]);
    const { answer: a } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    expect((await h.tool('orientim_swap', { quoteId: a.quoteId })).answer.ok).toBe(false);
    await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    expect((await h.tool('orientim_swap', { quoteId: a.quoteId })).answer.error.line).toMatch(/newer quote/);
  });

  it('cuts URLs in the command\'s answer too', async () => {
    const h = harness([() => ok(dryRun({ problems: ['simulation failed on https://rpc.example/secret-path?key=K'] }))]);
    const { answer } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    expect(answer.answer.problems).toEqual(['simulation failed on https://rpc.example/…']);
  });

  it('runs one quote once at a time', async () => {
    let finish: (r: Run) => void = () => {};
    const h = harness([() => ok(dryRun()), () => new Promise<Run>(r => { finish = r; })]);
    const { answer: q } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    const first = h.tool('orientim_swap', { quoteId: q.quoteId });
    await new Promise(r => setTimeout(r, 0));
    const second = await h.tool('orientim_swap', { quoteId: q.quoteId });
    expect(second.answer.error.line).toMatch(/already running/);
    finish(ok(JSON.stringify({ signature: SIG, outcome: 'confirmed' })));
    expect((await first).answer.ok).toBe(true);
  });

  it('refuses when the wallet changed since the quote', async () => {
    let wallet = W;
    const h = harness([() => ok(dryRun())], { wallet: async () => wallet });
    const { answer: q } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    wallet = BONK;
    expect((await h.tool('orientim_swap', { quoteId: q.quoteId })).answer.error.line).toMatch(/wallet changed/);
  });

  it('answers nothing to a call the client cancelled, but lets the swap finish', async () => {
    let finish: (r: Run) => void = () => {};
    const h = harness([() => ok(dryRun()), () => new Promise<Run>(r => { finish = r; })]);
    const { answer: q } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    const id = 900;
    const done = h.server.receive(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'orientim_swap', arguments: { quoteId: q.quoteId } } }), h.send);
    await new Promise(r => setTimeout(r, 0));
    await h.server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }), h.send);
    finish(ok(JSON.stringify({ signature: SIG, outcome: 'confirmed' })));
    await done;
    expect(h.sent.some(m => m.id === id)).toBe(false);
    expect(h.calls).toHaveLength(2);
  });
});

describe('one request, one swap (14 October 2026 review)', () => {
  it("gives a swap's answer the client stopped waiting for with the next call, before anything new", async () => {
    let finish: (r: Run) => void = () => {};
    const h = harness([() => ok(dryRun()), () => new Promise<Run>(r => { finish = r; })]);
    const { answer: q } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    const id = 901;
    const done = h.server.receive(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'orientim_swap', arguments: { quoteId: q.quoteId } } }), h.send);
    await new Promise(r => setTimeout(r, 0));
    // The client's timeout: it cancels, the swap goes on and lands.
    await h.server.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }), h.send);
    finish(ok(JSON.stringify({ signature: SIG, outcome: 'confirmed', received: '1497000' })));
    await done;
    // "Try again": the model quotes again, and is told the first swap landed instead.
    const again = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    expect(again.answer.error.code).toBe('earlier-swap');
    expect(again.answer.earlierSwaps).toEqual([expect.objectContaining({ quoteId: q.quoteId, outcome: 'confirmed', signature: SIG })]);
    expect(again.answer.quoteId).toBeUndefined();
    expect(h.calls).toHaveLength(2);
  });

  it('tells a second call for the same quote that it runs, even while the first awaits the wallet', async () => {
    let release: () => void = () => {};
    const slowWallet = new Promise<void>(r => { release = r; });
    let first = true;
    const h = harness([() => ok(dryRun()), () => ok(JSON.stringify({ signature: SIG, outcome: 'confirmed' }))], {
      wallet: async () => {
        if (!first) await slowWallet;
        return W;
      },
    });
    const { answer: q } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    first = false;
    const a = h.tool('orientim_swap', { quoteId: q.quoteId });
    const b = h.tool('orientim_swap', { quoteId: q.quoteId });
    release();
    const answers = await Promise.all([a, b]);
    expect(answers.filter(x => x.answer.ok)).toHaveLength(1);
    expect(answers.find(x => !x.answer.ok)!.answer.error.line).toMatch(/already running/);
    expect(h.calls).toHaveLength(2);
  });

  it("withdraws an unanswered question when the quote's 10 minutes end, and signs nothing", async () => {
    const h = harness([() => ok(dryRun())]);
    await h.request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 't', version: '1' } });
    const { answer: q } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    h.advance(10 * 60_000 - 30);
    const { answer } = await h.tool('orientim_swap', { quoteId: q.quoteId });
    expect(answer.error.line).toMatch(/did not answer the confirmation/);
    const asked = h.sent.find(m => m.method === 'elicitation/create') as { id: string };
    expect(h.sent).toContainEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: asked.id, reason: 'The quote expired.' } });
    expect(h.calls).toHaveLength(1);
  });

  it('lets no question hold a call open once the client is gone', async () => {
    const h = harness([() => ok(dryRun())]);
    await h.request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 't', version: '1' } });
    const { answer: q } = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    const call = h.tool('orientim_swap', { quoteId: q.quoteId });
    await new Promise(r => setTimeout(r, 0));
    h.server.clientGone();
    expect((await call).answer.error.line).toMatch(/did not confirm/);
    expect(h.server.busy()).toBe(false);
  });

  it('asks only a client that can show a form, and takes its error as no yes, for that swap only', async () => {
    const urlOnly = harness([() => ok(dryRun()), () => ok(JSON.stringify({ signature: SIG, outcome: 'confirmed' }))]);
    await urlOnly.request('initialize', { protocolVersion: '2025-11-25', capabilities: { elicitation: { url: {} } }, clientInfo: { name: 't', version: '1' } });
    const { answer: q1 } = await urlOnly.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    expect((await urlOnly.tool('orientim_swap', { quoteId: q1.quoteId })).answer.ok).toBe(true);
    expect(urlOnly.sent.some(m => m.method === 'elicitation/create')).toBe(false);

    const failing = harness([() => ok(dryRun()), () => ok(JSON.stringify({ signature: SIG, outcome: 'confirmed' }))]);
    await failing.request('initialize', { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 't', version: '1' } });
    const { answer: q2 } = await failing.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    const call = failing.tool('orientim_swap', { quoteId: q2.quoteId });
    await new Promise(r => setTimeout(r, 0));
    const asked = failing.sent.find(m => m.method === 'elicitation/create') as { id: string };
    await failing.server.receive(JSON.stringify({ jsonrpc: '2.0', id: asked.id, error: { code: -32601, message: 'Method not found' } }), failing.send);
    const refused = (await call).answer;
    expect(refused.ok).toBe(false);
    expect(refused.error.line).toMatch(/could not ask the user.*nothing was signed/);
    expect(failing.calls).toHaveLength(1);
    // Asked again on the next try, never switched off: an accept then is the yes.
    const again = failing.tool('orientim_swap', { quoteId: q2.quoteId });
    await new Promise(r => setTimeout(r, 0));
    const second = failing.sent.filter(m => m.method === 'elicitation/create') as { id: string }[];
    expect(second).toHaveLength(2);
    await failing.server.receive(JSON.stringify({ jsonrpc: '2.0', id: second[1].id, result: { action: 'accept', content: { confirm: true } } }), failing.send);
    expect((await again).answer.ok).toBe(true);
    expect(failing.calls).toHaveLength(2);
  });

  it("holds \"auto\" and the defaults to an owner's lower ceilings", async () => {
    const h = harness([() => ok(dryRun())], { ceilings: { slippageBps: 100, priceImpactBps: 200 } });
    const auto = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01', slippageBps: 'auto' });
    expect(auto.answer.error.line).toMatch(/"auto" may reach 300 bps.*100 bps/);
    await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    expect(h.calls[0].args).toEqual(expect.arrayContaining(['--slippage-bps', '50', '--max-price-impact-bps', '200']));
  });

  it("shows the agent's own tolerance, and no summary for a quote the check refused", async () => {
    const h = harness([
      () => ok(dryRun({ slippageBps: 75 })),
      () => ({ code: 1, stdout: dryRun({ approval: undefined, problems: ['minOut is below the floor'], amounts: undefined, costs: undefined }), stderr: '' }),
    ]);
    expect((await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' })).answer.summary.slippageBps).toBe(75);
    const refused = await h.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.02' });
    expect(refused.answer.summary).toBeUndefined();
    expect(refused.answer.answer.problems).toEqual(['minOut is below the floor']);
  });
});

describe('secrets in what the model reads', () => {
  it('cuts every spelling of a URL with a key or a password, and a key in a query without its scheme', () => {
    expect(withoutSecrets('HTTPS://user:pw@rpc.example/x?api-key=K1')).toBe('HTTPS://rpc.example/…');
    expect(withoutSecrets('https://user:p@ss@rpc.example/x')).toBe('https://rpc.example/…');
    expect(withoutSecrets('Failed to parse URL from mainnet.helius-rpc.com/?api-key=SECRETKEY')).toBe('Failed to parse URL from mainnet.helius-rpc.com/?api-key=…');
    expect(withoutSecrets('wss://rpc.example/ws?token=T&x=1')).toBe('wss://rpc.example/…');
  });
});

describe('orientim_recover', () => {
  it('runs orientim recover and passes on its words', async () => {
    const h = harness([
      () => ok(JSON.stringify({ ok: true, settled: [] })),
      () => ({ code: 2, stdout: JSON.stringify({ ok: false, error: 'Set SOLANA_RPC_URL to your own RPC.' }), stderr: '' }),
    ]);
    const first = await h.tool('orientim_recover');
    expect(h.calls[0]).toMatchObject({ command: 'verify', args: ['recover'] });
    expect(first.answer).toMatchObject({ ok: true, exitCode: 0, meaning: 'Everything kept is settled: new swaps may start.' });
    const second = await h.tool('orientim_recover');
    expect(second.answer.error).toEqual({ code: 'setup', line: 'Set SOLANA_RPC_URL to your own RPC.' });
  });
});

describe('the environment of the commands', () => {
  it("defaults Orientim's address and makes every path absolute", () => {
    const env = commandEnv({ ORIENTIM_WALLET_KEYPAIR: 'keys/w.json', ORIENTIM_POLICY: '/etc/orientim/policy.json', ORIENTIM_STATE_DIR: 'state', SOLANA_RPC_URL: 'https://rpc' }, '/home/me');
    expect(env.ORIENTIM_API_URL).toBe('https://orientim.com');
    expect(env.ORIENTIM_WALLET_KEYPAIR).toBe(resolve('/home/me', 'keys/w.json'));
    expect(env.ORIENTIM_POLICY).toBe('/etc/orientim/policy.json');
    expect(env.ORIENTIM_STATE_DIR).toBe(resolve('/home/me', 'state'));
    expect(commandEnv({ ORIENTIM_API_URL: 'https://staging.example' }).ORIENTIM_API_URL).toBe('https://staging.example');
  });

  it("takes a setting the client left empty, or its own placeholder, as not set", () => {
    expect(withoutBlanks({ JUPITER_API_KEY: '${user_config.jupiter_api_key}', ORIENTIM_POLICY: ' ', SOLANA_RPC_URL: 'https://rpc', PATH: '' }))
      .toEqual({ SOLANA_RPC_URL: 'https://rpc', PATH: '' });
  });

  it('cuts every URL to its host', () => {
    expect(withoutSecrets('rpc https://a.example/v2/KEY?x=1 and wss://b.example:443/k')).toBe('rpc https://a.example/… and wss://b.example:443/…');
    expect(withoutSecrets('fetch https://rpcuser:S3CRET@rpc.example/?api-key=K failed')).toBe('fetch https://rpc.example/… failed');
  });
});

/** The `orientim` command, from its source (the build is tested as shipped in CI: tools/mcp/smoke.mjs). */
const BIN = join(ROOT, 'src/bin.ts');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = (bytes: Uint8Array) => {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  return out;
};

/** A home of its own with a solana-keygen file in it: the ed25519 seed, then the public key. */
function wallet() {
  const home = mkdtempSync(join(tmpdir(), 'orientim-mcp-'));
  const keypair = join(home, 'wallet.json');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  writeFileSync(keypair, JSON.stringify([...seed, ...pub]));
  return { home, keypair, publicKey, address: base58(pub) };
}

/** The server on stdio, fed these lines; its answers once it exits. */
function serve(lines: unknown[], env: NodeJS.ProcessEnv): Promise<{ id: number; result: any }[]> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.on('error', fail);
    child.on('close', () => done(stdout.trim().split('\n').map(l => JSON.parse(l) as { id: number; result: any })));
    child.stdin.end(lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  });
}

const quoteCall = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'orientim_quote', arguments: { inputMint: SOL, outputMint: USDC, amount: '0.01' } } });

describe('orientim mcp', () => {
  // Two processes started one after the other: slow on a loaded Windows runner, hence the longer timeout.
  it('runs `orientim swap` and the JSON commands itself, with nothing beside it', () => {
    const swap = spawnSync(process.execPath, [BIN, '--run-swap'], { encoding: 'utf8' });
    expect(swap.status).toBe(2);
    expect(swap.stderr).toMatch(/^usage: orientim swap/);
    const verifyRun = spawnSync(process.execPath, [BIN, '--run-verify'], { encoding: 'utf8' });
    expect(verifyRun.status).toBe(2);
    expect(verifyRun.stdout).toMatch(/usage: orientim </);
  }, 30_000);

  it("gets the wallet's own API key once, keeps it for its owner alone, and never shows it", async () => {
    const w = wallet();
    const seen: string[] = [];
    let signedBy: KeyObject | undefined;
    const orientim = httpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push(`${req.method} ${url.pathname}`);
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url.pathname === '/api/v1/keys/challenge') {
        const host = req.headers.host;
        return send(200, {
          message: `${host} wants you to sign in with your Solana account:\n${url.searchParams.get('wallet')}\n\nGet an Orientim API key for this wallet, and accept the Terms of Use at https://orientim.com/terms. Signing costs nothing and gives no access to your funds.\n\nURI: http://${host}/developers#access\nVersion: 1\nChain ID: mainnet\nNonce: n1nonce\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(Date.now() + 10 * 60_000).toISOString()}`,
          challenge: 'c1',
        });
      }
      if (url.pathname === '/api/v1/keys') {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          const { message, signature } = JSON.parse(body) as { message: string; signature: string };
          if (verify(null, Buffer.from(message), w.publicKey, Buffer.from(signature, 'base64'))) signedBy = w.publicKey;
          send(200, { key: 'ori_issued_secret', wallet: message.split('\n')[1], expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() });
        });
        return;
      }
      send(404, { error: { code: 'not-found', message: 'no' } });
    });
    await new Promise<void>(r => orientim.listen(0, '127.0.0.1', r));
    const port = (orientim.address() as { port: number }).port;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: w.home, USERPROFILE: w.home, ORIENTIM_WALLET_KEYPAIR: w.keypair, ORIENTIM_API_URL: `http://127.0.0.1:${port}` };
      delete env.ORIENTIM_API_KEY;
      delete env.SOLANA_RPC_URL;
      const first = await serve([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, quoteCall(2)], env);
      const quote = first.find(a => a.id === 2)!.result;
      // The key was issued, then the dry run asked for what is still missing: the owner's RPC.
      expect(signedBy).toBe(w.publicKey);
      expect(quote.structuredContent.wallet).toBe(w.address);
      expect(quote.structuredContent.error.line).toMatch(/SOLANA_RPC_URL/);
      expect(quote.content[0].text).not.toContain('ori_issued_secret');
      // One file per wallet and Orientim address: another wallet on this machine keeps its own.
      const kept = readdirSync(join(w.home, '.orientim')).filter(f => /^api-key-[0-9a-f]{16}\.json$/.test(f));
      expect(kept).toHaveLength(1);
      const file = join(w.home, '.orientim', kept[0]);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ wallet: w.address, key: 'ori_issued_secret' });
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
      // Kept: the next start asks Orientim for nothing.
      await serve([quoteCall(3)], env);
      expect(seen).toEqual(['GET /api/v1/keys/challenge', 'POST /api/v1/keys']);
      // The state is kept in ~/.orientim, whatever folder the client starts the server in.
      expect(existsSync(join(w.home, '.orientim', '.orientim-state'))).toBe(true);
    } finally {
      orientim.close();
    }
  }, 60_000);

  it('speaks MCP on stdio, and runs the real dry run for a quote', async () => {
    const { home, keypair } = wallet();
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'orientim_quote', arguments: { inputMint: SOL, outputMint: USDC, amount: '0.01' } } },
    ];
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ORIENTIM_WALLET_KEYPAIR: keypair, ORIENTIM_API_KEY: 'ori_test' };
    delete env.SOLANA_RPC_URL;
    const answers = await serve(lines, env);
    expect(answers.map(a => a.id).sort()).toEqual([1, 2, 3]);
    const quote = answers.find(a => a.id === 3)!.result;
    expect(quote.isError).toBe(true);
    // The wallet's address, never its key; the command's own words on what to set.
    expect(quote.structuredContent.wallet).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(quote.structuredContent.exitCode).toBe(2);
    expect(quote.structuredContent.error.line).toMatch(/SOLANA_RPC_URL/);
    expect(quote.content[0].text).not.toContain('ori_test');
  }, 30_000);
});

describe('a quote outlives the server (15 October 2026 review)', () => {
  const swapped = () => ok(JSON.stringify({ signature: SIG, outcome: 'confirmed', refusal: null, meaning: 'Swapped.', amounts: {}, received: '1497000' }));

  it('a quote file written by someone else, with limits past the owner\'s, is not a quote', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orientim-quotes-'));
    const quoteStore = fileQuoteStore(dir);
    const before = harness([() => ok(dryRun())], { quoteStore });
    const { answer: q } = await before.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01', slippageBps: 100 });
    const [[id, kept]] = quoteStore.all();
    quoteStore.save(id, { ...kept, flags: ['--slippage-bps', '1500', '--max-below-bps', '10000'] });
    const after = harness([swapped], { quoteStore });
    const { isError } = await after.tool('orientim_swap', { quoteId: q.quoteId });
    expect(isError).toBe(true);
    expect(after.calls).toHaveLength(0);
  });

  it('a client that restarts the server between the quote and the yes keeps the quote, and its order', async () => {
    const quoteStore = fileQuoteStore(mkdtempSync(join(tmpdir(), 'orientim-quotes-')));
    const before = harness([() => ok(dryRun())], { quoteStore });
    const { answer: q } = await before.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01', slippageBps: 100 });
    // A new server, as a client starts after a restart: the same quote, under the same order id.
    const after = harness([swapped], { quoteStore });
    const { answer } = await after.tool('orientim_swap', { quoteId: q.quoteId });
    expect(answer).toMatchObject({ ok: true, outcome: 'confirmed', quoteId: q.quoteId });
    expect(after.calls[0].args).toEqual(['--in', SOL, '--out', USDC, '--amount', '10000000', '--id', `mcp-${q.quoteId}`, '--min-out', '1490000', '--slippage-bps', '100']);
  });

  it('a quote whose yes expired before the restart is still refused after it', async () => {
    const quoteStore = fileQuoteStore(mkdtempSync(join(tmpdir(), 'orientim-quotes-')));
    const before = harness([() => ok(dryRun())], { quoteStore });
    const { answer: q } = await before.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    const after = harness([], { quoteStore });
    after.advance(11 * 60_000);
    expect((await after.tool('orientim_swap', { quoteId: q.quoteId })).answer.error.line).toMatch(/has expired/);
    expect(after.calls).toHaveLength(0);
  });

  it('a kept quote that was changed on disk is no quote at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orientim-quotes-'));
    const before = harness([() => ok(dryRun())], { quoteStore: fileQuoteStore(dir) });
    const { answer: q } = await before.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    const file = join(dir, `quote-${q.quoteId}.json`);
    const kept = JSON.parse(readFileSync(file, 'utf8'));
    kept.quote.amountIn = '20000000';
    writeFileSync(file, JSON.stringify(kept));
    const after = harness([], { quoteStore: fileQuoteStore(dir) });
    expect((await after.tool('orientim_swap', { quoteId: q.quoteId })).answer.error.line).toMatch(/No quote with this id/);
    expect(existsSync(file)).toBe(false);
  });

  it('a tried quote stays tried across a restart: the person is not asked twice for one yes', async () => {
    const quoteStore = fileQuoteStore(mkdtempSync(join(tmpdir(), 'orientim-quotes-')));
    const before = harness([() => ok(dryRun()), () => ({ code: 3, stdout: '', stderr: 'The outcome is still unknown.\n' })], { quoteStore });
    const { answer: q } = await before.tool('orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });
    await before.tool('orientim_swap', { quoteId: q.quoteId });
    const kept = quoteStore.all().find(([id]) => id === q.quoteId)?.[1];
    expect(kept?.tried).toBe(true);
    expect(kept?.minOut).toBe('1490000');
  });
});
