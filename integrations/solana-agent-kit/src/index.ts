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
  acquireLock, ConfigError, createFileStore, errorLine, loadPolicy, LockBusyError, outcomeMeaning, parsePolicy, policyPathFor,
  protectedSwap, recoverPending, signerFromSignTransaction, stateDirFor,
} from '@orientimhq/swap';
import type { OwnerPolicy, WalletSigner } from '@orientimhq/swap';
import { fetchMints } from '@orientimhq/swap/solana';

/** What the plugin needs of the agent kit's wallet and connection; the kit's own types satisfy it. */
export type KitWallet = {
  publicKey: { toBase58(): string };
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
};
export type KitAgent = { wallet: KitWallet; connection: { rpcEndpoint: string }; config?: { signOnly?: boolean } };

export const ACTION_NAME = 'ORIENTIM_PROTECTED_SWAP';

// The kit's signOnly hands signed transactions back for the app to send. Orientim signs last and the
// swap is sent within the call, so a kit set to sign only would see a swap it never sent.
const SIGN_ONLY = 'This agent kit is set to signOnly, and a protected swap is sent as part of the call; the Orientim plugin does not run with signOnly.';

/**
 * The most tolerance the model may ask for, in bps: the MCP server's own ceiling (`MODEL_CEILINGS`).
 * The floor sits this tolerance and 1.5% more (2% on a Pump.fun curve) below the market, so only the
 * owner raises it (the policy's `maxSlippageBps`), never the model. The model has no price impact to
 * choose: the default of 5%, or the owner's lower one, holds.
 */
export const MODEL_MAX_SLIPPAGE_BPS = 300;

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
   * An administrator's policy file (`SYSTEM_POLICY_PATH`, `/etc/orientim/policy.json`) wins when it
   * exists, as it does for the command: a policy given here must then be that file or the same limits.
   */
  policy: unknown;
  /** Where signed swaps wait for their outcome, else `ORIENTIM_STATE_DIR`; the policy's `stateDir` wins. */
  stateDir?: string;
  /** An RPC with the full history, for a second proof that a swap expired. */
  archiveRpcUrl?: string;
};

// The model's tool takes every field, the two it may leave unset as null: the kit's OpenAI and MCP tools
// mark every field required (an optional one would make the model invent an orderId), and read each
// description from the innermost type, so it is given before nullable.
export const protectedSwapSchema = z.object({
  inputMint: z.string().describe('Mint address of the token to sell'),
  outputMint: z.string().describe('Mint address of the token to buy'),
  amount: z.string().describe('Amount of the input token in whole tokens, as text, such as "0.5". Never a number.'),
  slippageBps: z.number().int().describe(`Tolerance in bps, at most ${MODEL_MAX_SLIPPAGE_BPS} unless the owner allows more; null for the default`).nullable(),
  orderId: z.string().describe('null for a new swap. Only to retry an order after an unclear answer: the orderId that answer gave. Never invent one.').nullable(),
});
// Code calling the method may leave them out.
const inputSchema = protectedSwapSchema.partial({ slippageBps: true, orderId: true });
export type ProtectedSwapInput = z.input<typeof inputSchema>;

export type ProtectedSwapResult = {
  status: 'success' | 'failed' | 'unknown' | 'error';
  message: string;
  orderId?: string;
  signature?: string;
  outcome?: string;
  /** What arrived, in whole tokens of the output, as `amount` is given. */
  receivedAmount?: string;
  /** The same, in the output's base units. */
  received?: string;
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

/** Base units as whole tokens, exactly: `fromBaseUnits('1500000', 6)` is `'1.5'`. */
export function fromBaseUnits(units: string, decimals: number): string {
  const digits = BigInt(units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
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
  /** Where an administrator's policy is; `SYSTEM_POLICY_PATH` when not set. */
  systemPolicy?: string;
};

/** A policy as one spelling: the same limits in another order are the same policy. */
const canonical = (policy: OwnerPolicy) => JSON.stringify(policy, (_k, v: unknown) => (Array.isArray(v) ? [...v].sort()
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

/**
 * The owner's policy, as the command reads it (`policyPathFor`): an administrator's file wins when it
 * exists, and a policy given in code is then refused unless it is that file or the same limits.
 * Read again on every call, so the owner's change holds from the next swap.
 */
function ownerPolicy(given: unknown, system?: string): OwnerPolicy {
  const inCode = typeof given === 'string' ? loadPolicy(given) : parsePolicy(given, 'given to orientimPlugin');
  const file = policyPathFor(undefined, system);
  if (!file) return inCode;
  const policy = loadPolicy(file);
  if (canonical(policy) !== canonical(inCode)) {
    throw new ConfigError(`The owner's policy is ${file}; the policy given to orientimPlugin differs from it, and is not used. Give that file's path, or the same limits. Nothing was started.`);
  }
  return policy;
}

const realDeps: Deps = {
  protectedSwap,
  async decimalsOf(rpc, mint) {
    const info = (await fetchMints(rpc, [mint as never])).get(mint);
    if (!info?.exists) throw new Error(`${mint} is not a token mint on this RPC.`);
    return info.decimals;
  },
};

const failure = (message: string, extra: Partial<ProtectedSwapResult> = {}): ProtectedSwapResult => ({ status: 'error', message, ...extra });

// The command's words for an unclear outcome name `orientim resolve`; through the kit, asking again is
// how it is looked up: each call settles what earlier ones left before it starts anything.
const UNCLEAR = 'No outcome could be read in time: the swap may still land. Ask again later with the same orderId: it is looked up on the chain first, and an order is never swapped twice. Nothing new from this wallet starts until its outcome is known.';
const EARLIER_UNCLEAR = 'The outcome of an earlier swap from this wallet is still unknown, so nothing new was started. Ask again later: it is looked up on the chain first.';

export async function runProtectedSwap(agent: KitAgent, input: ProtectedSwapInput, options: OrientimOptions, deps: Deps = realDeps): Promise<ProtectedSwapResult> {
  if (agent.config?.signOnly) return failure(SIGN_ONLY);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return failure('The swap was not started: inputMint, outputMint and amount (text) are needed.');
  const { inputMint, outputMint, amount, slippageBps } = parsed.data;
  if (!MINT.test(inputMint) || !MINT.test(outputMint)) return failure('inputMint and outputMint must be mint addresses. Nothing was started.');
  if (inputMint === outputMint) return failure('inputMint and outputMint are the same token. Nothing was started.');
  // null or "" is a new order: a model told to leave it unset sends either.
  const orderId = parsed.data.orderId || `kit-${randomUUID()}`;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(orderId)) return failure('orderId must be the one an earlier answer gave. Nothing was started.');

  let release: (() => void) | undefined;
  try {
    const policy = ownerPolicy(options.policy, deps.systemPolicy);
    // The model's tolerance is held to the MCP server's ceiling: refused, never lowered in silence.
    const most = policy.maxSlippageBps ?? MODEL_MAX_SLIPPAGE_BPS;
    if (slippageBps != null && slippageBps > most) {
      return failure(`slippageBps ${slippageBps} is above the ${most} bps the owner allows: a wider tolerance lowers the least that arrives, so only the owner raises it (maxSlippageBps in the policy). Use null, or ${most} or less. Nothing was started.`, { orderId });
    }
    const rpc = createSolanaRpc(agent.connection.rpcEndpoint) as unknown as Rpc;
    const archive = options.archiveRpcUrl ? createSolanaRpc(options.archiveRpcUrl) as unknown as Rpc : undefined;
    const wallet = walletSigner(agent.wallet);
    const [inputDecimals, outputDecimals] = await Promise.all([deps.decimalsOf(rpc, inputMint), deps.decimalsOf(rpc, outputMint)]);
    const amountIn = toBaseUnits(amount, inputDecimals).toString();
    const { dir, warning } = stateDirFor(policy, options.stateDir ?? (process.env.ORIENTIM_STATE_DIR || undefined));
    const store = createFileStore(dir);
    try {
      release = acquireLock(dir, wallet.address);
    } catch (e) {
      if (!(e instanceof LockBusyError)) throw e;
      return failure(`Another swap from this wallet is running, or was stopped moments ago and may have sent one. Wait, then ask again with the same orderId (never a new one). ${e.message}`, { orderId });
    }
    // What a stopped run left is settled first; while any outcome is unknown, no new swap starts.
    const earlier = await recoverPending(store, rpc, { orders: store, spends: store, ...(archive ? { archive } : {}) });
    if (earlier.unknown.length || earlier.bookkeepingErrors.length) return failure(EARLIER_UNCLEAR, { orderId, status: 'unknown' });
    const result = await deps.protectedSwap({
      apiUrl: (options.apiUrl ?? 'https://orientim.com').replace(/\/+$/, ''),
      apiKey: options.apiKey,
      jupiterApiKey: options.jupiterApiKey,
      rpc,
      wallet,
      ...(archive ? { archive } : {}),
      intent: { id: orderId, inputMint, outputMint, amountIn, ...(slippageBps != null ? { slippageBps } : {}) },
      pending: store,
      orders: store,
      spends: store,
      policy,
    });
    const status = result.outcome === 'unknown' ? 'unknown' : result.outcome === 'confirmed' ? 'success' : 'failed';
    const meaning = status === 'unknown' ? UNCLEAR
      : status === 'success' ? 'The swap landed. receivedAmount is what arrived in the wallet, in whole tokens, read on your RPC.'
      : outcomeMeaning(result.outcome, result.refusal, result.cause);
    // The chain's answer stands; a record that could not be updated is settled by the next call.
    const message = result.bookkeepingError ? `${meaning} Its record could not be updated, so the next call settles it before anything new starts.` : meaning;
    return {
      status, message, orderId, signature: result.signature, outcome: result.outcome,
      ...(result.received ? { receivedAmount: fromBaseUnits(result.received, outputDecimals), received: result.received } : {}),
      ...(result.notices.length || warning ? { notices: [...result.notices, ...(warning ? [warning] : [])] } : {}),
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
  ownerPolicy(options.policy, deps?.systemPolicy);

  const method = (agent: KitAgent, input: ProtectedSwapInput) => runProtectedSwap(agent, input, options, deps);
  return {
    name: 'orientim',
    methods: { protectedSwap: method },
    actions: [{
      name: ACTION_NAME,
      similes: ['swap tokens safely', 'protected swap', 'swap with orientim', 'trade tokens', 'exchange tokens'],
      description: 'Swap one token for another on Solana through Orientim. The route can only touch the approved amount, and the owner\'s limits apply. Use this, never another swap tool.',
      examples: [[{
        input: { inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', outputMint: 'So11111111111111111111111111111111111111112', amount: '5', slippageBps: null, orderId: null },
        output: { status: 'success', message: 'The swap landed.', orderId: 'kit-0b6f2c1e-6f0e-4a8e-9d55-3f1c2b7a9e10', receivedAmount: '0.031' },
        explanation: 'Swap 5 USDC for SOL',
      }]],
      schema: protectedSwapSchema,
      handler: (agent: KitAgent, input: Record<string, unknown>) => method(agent, input as ProtectedSwapInput),
    }],
    // The kit calls it from `use`: a kit set to sign only is refused there, before the model sees the tool.
    initialize(agent: KitAgent) {
      if (agent?.config?.signOnly) throw new Error(SIGN_ONLY);
    },
  };
}
