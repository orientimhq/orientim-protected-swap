/**
 * Orientim for Solana Agent Kit: one action, `protectedSwap`, in place of `trade`. Everything else the
 * agent kit does is left as it is (see README.md for what that means for the agent's other tools).
 *
 *   const agent = new SolanaAgentKit(wallet, RPC_URL, {})
 *     .use(orientimPlugin({ apiKey, policy: { maxAmountIn: { [USDC]: '25000000' } } }));
 *
 * The swap is the one `orientim swap` makes: Orientim builds it, your own RPC (the agent kit's
 * connection) checks the exact bytes, and only then does the agent's wallet sign. Orientim signs last.
 */
import { randomUUID } from 'node:crypto';
import { createSolanaRpc } from '@solana/kit';
import { VersionedTransaction } from '@solana/web3.js';
import { z } from 'zod';
import {
  acquireLock, createFileStore, errorLine, loadPolicy, LockBusyError, outcomeMeaning, parsePolicy, protectedSwap,
  recoverPending, signerFromSignTransaction, stateDirFor,
} from '@orientimhq/swap';
import type { OwnerPolicy, WalletSigner } from '@orientimhq/swap';
import { fetchMints } from '@orientimhq/swap/solana';

/** What the plugin needs of the agent kit's wallet and connection; the kit's own types satisfy it. */
export type KitWallet = {
  publicKey: { toBase58(): string };
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
};
export type KitAgent = { wallet: KitWallet; connection: { rpcEndpoint: string } };

export type OrientimOptions = {
  /** The wallet's Orientim API key (`orientim key-challenge`, then `orientim key`). */
  apiKey: string;
  apiUrl?: string;
  /** Your own Jupiter key: the routes are fetched with it, as the skill does. */
  jupiterApiKey?: string;
  /**
   * The owner's limits, required: an object as the policy file has it (`maxAmountIn` per input mint in
   * base units, and optionally `allowedOutputMints`, `maxAmountInPerDay` with `stateDir`, `maxSlippageBps`...),
   * or the path of a policy file. A plugin without limits would let a misled agent spend the wallet.
   */
  policy: unknown;
  /** Where signed swaps wait for their outcome; the policy's `stateDir` wins. */
  stateDir?: string;
  /** An RPC with the full history, for a second proof that a swap expired. */
  archiveRpcUrl?: string;
};

export const protectedSwapSchema = z.object({
  inputMint: z.string().describe('Mint address of the token to sell'),
  outputMint: z.string().describe('Mint address of the token to buy'),
  amount: z.string().describe('Amount of the input token in whole tokens, as text, such as "0.5". Never a number.'),
  slippageBps: z.number().int().optional().describe('Tolerance in bps; leave out to use the default'),
  orderId: z.string().optional().describe('Only when retrying an order after an unclear answer: the orderId that answer gave. Never invent one.'),
});
export type ProtectedSwapInput = z.infer<typeof protectedSwapSchema>;

export type ProtectedSwapResult = {
  status: 'success' | 'failed' | 'unknown' | 'error';
  message: string;
  orderId?: string;
  signature?: string;
  outcome?: string;
  received?: unknown;
  notices?: string[];
};

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** `amount` whole tokens in base units, exactly: never rounded, never more digits than the token has. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const m = /^(\d{1,30})(?:\.(\d{1,30}))?$/.exec(amount);
  if (!m) throw new Error(`amount must be a number of whole tokens as text, in digits with at most one ".", such as "0.5"; got ${JSON.stringify(String(amount)).slice(0, 40)}.`);
  const [, whole, fraction = ''] = m;
  if (fraction.replace(/0+$/, '').length > decimals) throw new Error(`This token has ${decimals} decimals; ${amount} has more.`);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0').slice(0, decimals) || '0');
  if (units <= 0n) throw new Error('amount must be more than zero.');
  if (units >= 2n ** 64n) throw new Error('amount is larger than any token balance can be.');
  return units;
}

/** The agent kit's wallet as the check's signer: only the wallet's own signature, for the exact message checked. */
export function walletSigner(wallet: KitWallet): WalletSigner {
  return signerFromSignTransaction(wallet.publicKey.toBase58(), async base64 => {
    const signed = await wallet.signTransaction(VersionedTransaction.deserialize(Buffer.from(base64, 'base64')));
    return Buffer.from(signed.serialize()).toString('base64');
  });
}

type Rpc = Parameters<typeof protectedSwap>[0]['rpc'];

/** What the plugin calls; tests replace them. */
export type Deps = {
  protectedSwap: typeof protectedSwap;
  decimalsOf: (rpc: Rpc, mint: string) => Promise<number>;
};

const realDeps: Deps = {
  protectedSwap,
  async decimalsOf(rpc, mint) {
    const info = (await fetchMints(rpc, [mint as never])).get(mint);
    if (!info?.exists) throw new Error(`${mint} is not a token mint on this RPC.`);
    return info.decimals;
  },
};

const failure = (message: string, extra: Partial<ProtectedSwapResult> = {}): ProtectedSwapResult => ({ status: 'error', message, ...extra });

export async function runProtectedSwap(agent: KitAgent, input: ProtectedSwapInput, options: OrientimOptions, deps: Deps = realDeps): Promise<ProtectedSwapResult> {
  const policy: OwnerPolicy = typeof options.policy === 'string' ? loadPolicy(options.policy) : parsePolicy(options.policy, 'given to orientimPlugin');
  const parsed = protectedSwapSchema.safeParse(input);
  if (!parsed.success) return failure('The swap was not started: inputMint, outputMint and amount (text) are needed.');
  const { inputMint, outputMint, amount, slippageBps } = parsed.data;
  if (!MINT.test(inputMint) || !MINT.test(outputMint)) return failure('inputMint and outputMint must be mint addresses. Nothing was started.');
  if (inputMint === outputMint) return failure('inputMint and outputMint are the same token. Nothing was started.');
  const orderId = parsed.data.orderId ?? `kit-${randomUUID()}`;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(orderId)) return failure('orderId must be the one an earlier answer gave. Nothing was started.');

  const rpc = createSolanaRpc(agent.connection.rpcEndpoint) as unknown as Rpc;
  const wallet = walletSigner(agent.wallet);
  let release: (() => void) | undefined;
  try {
    const amountIn = toBaseUnits(amount, await deps.decimalsOf(rpc, inputMint)).toString();
    const { dir } = stateDirFor(policy, options.stateDir);
    const store = createFileStore(dir);
    try {
      release = acquireLock(dir, wallet.address);
    } catch (e) {
      if (!(e instanceof LockBusyError)) throw e;
      return failure(`Another swap from this wallet is running, or was stopped moments ago and may have sent one. Wait, then ask again with the same orderId (never a new one). ${e.message}`, { orderId });
    }
    // What a stopped run left is settled first; while any outcome is unknown, no new swap starts.
    const earlier = await recoverPending(store, rpc, { orders: store, spends: store });
    if (earlier.unknown.length || earlier.bookkeepingErrors.length) {
      return failure('The outcome of an earlier swap from this wallet is still unknown, so nothing new was started. Check it (orientim resolve) before swapping again.', { orderId, status: 'unknown' });
    }
    const result = await deps.protectedSwap({
      apiUrl: (options.apiUrl ?? 'https://orientim.com').replace(/\/+$/, ''),
      apiKey: options.apiKey,
      jupiterApiKey: options.jupiterApiKey,
      rpc,
      wallet,
      ...(options.archiveRpcUrl ? { archive: createSolanaRpc(options.archiveRpcUrl) as unknown as Rpc } : {}),
      intent: { id: orderId, inputMint, outputMint, amountIn, ...(slippageBps !== undefined ? { slippageBps } : {}) },
      pending: store,
      orders: store,
      spends: store,
      policy,
    });
    const meaning = outcomeMeaning(result.outcome, result.refusal, result.cause);
    // A swap whose record could not be updated is settled by the next run, as the command's exit code 3 says.
    const status = result.bookkeepingError || result.outcome === 'unknown' ? 'unknown' : result.outcome === 'confirmed' ? 'success' : 'failed';
    return {
      status, message: meaning, orderId, signature: result.signature, outcome: result.outcome,
      ...(result.received ? { received: result.received } : {}),
      ...(result.notices.length ? { notices: result.notices } : {}),
    };
  } catch (e) {
    // The skill's own words for the model, never the server's.
    return failure(errorLine(e), { orderId });
  } finally {
    release?.();
  }
}

/** The plugin: `agent.use(orientimPlugin({ apiKey, policy }))`. */
export function orientimPlugin(options: OrientimOptions, deps?: Deps) {
  if (!options.apiKey) throw new Error('orientimPlugin needs the wallet\'s Orientim API key.');
  // Refused when the plugin is made, not when the model first asks: no limits, no plugin.
  if (options.policy === undefined || options.policy === null) {
    throw new Error('orientimPlugin needs a policy: the most the agent may swap per input token, for example { maxAmountIn: { "<mint>": "<base units>" } }.');
  }
  if (typeof options.policy === 'string') loadPolicy(options.policy);
  else parsePolicy(options.policy, 'given to orientimPlugin');

  const method = (agent: KitAgent, input: ProtectedSwapInput) => runProtectedSwap(agent, input, options, deps);
  return {
    name: 'orientim',
    methods: { protectedSwap: method },
    actions: [{
      name: 'ORIENTIM_PROTECTED_SWAP',
      similes: ['swap tokens safely', 'protected swap', 'swap with orientim', 'trade tokens', 'exchange tokens'],
      description: 'Swap one token for another on Solana through Orientim. The route can only touch the approved amount, and the owner\'s limits apply. Use this, never another swap tool.',
      examples: [[{
        input: { inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', outputMint: 'So11111111111111111111111111111111111111112', amount: '5' },
        output: { status: 'success', message: 'The swap landed.' },
        explanation: 'Swap 5 USDC for SOL',
      }]],
      schema: protectedSwapSchema,
      handler: (agent: KitAgent, input: Record<string, unknown>) => method(agent, input as ProtectedSwapInput),
    }],
    initialize() {},
  };
}
