/**
 * `orientim`: JSON-over-stdio protected swap for bots in any language. The bot signs the message
 * itself; this command runs the same checks as `protectedSwap`.
 *
 *   orientim prepare        {"intent": {...}}                       0 sign `message`, 1 refused, 3 settle first, 4 Orientim refused
 *   orientim finalize       {"checked": ..., "signature": "..."}    0 confirmed, 1 not swapped, 3 unknown, 5 order already used
 *   orientim recover                                                0 all settled, 3 still unknown or wallet busy
 *   orientim resolve        {"signature": "...", "outcome": "..."}  0 settled, 1 refused
 *   orientim check          {"prepared": ..., "intent": {...}}      0 safe to sign, 1 refused
 *   orientim key-challenge  {"wallet": "<address>"}                 0 sign `message`
 *   orientim key            {"message", "challenge", "signature"}   0 `key` issued, 4 Orientim refused
 *
 * Exit 2 is a usage or configuration error; exit 3 always carries `recoveryRequired: true`. `sent: false`
 * describes only this call. Failed answers carry `retryable` and `requiresNewOrderId` (see `withRetryHints`).
 *
 * `prepare` returns `checked` (pass it to finalize unchanged) and `message` (base64). Sign the message
 * bytes with the wallet's ed25519 key and pass `signature` (base58) or `signedTransaction` (base64).
 * Finalize re-verifies everything before sending. `intent.id` is required and must be stable across retries.
 * A dry-run approval (`orientim swap --dry-run`) also binds prepare, check and finalize (`error.code` `approval`).
 * Transient failures use `error.code` `unavailable` with `retryAfter`. With a daily limit, `check` counts
 * only swaps recorded in this state directory.
 *
 * Environment: SOLANA_RPC_URL, ORIENTIM_API_URL, ORIENTIM_API_KEY, JUPITER_API_KEY, ORIENTIM_STATE_DIR,
 * ORIENTIM_POLICY (see `OwnerPolicy`), ORIENTIM_TREASURY, ORIENTIM_ARCHIVE_RPC_URL, ORIENTIM_SEND_RPC_URL.
 */
import {
  createSolanaRpc, getBase58Encoder, getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder,
  isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from '@solana/kit';
import type { Address, Rpc, SignatureBytes, SolanaRpcApi } from '@solana/kit';
import { exitCodeOf, outcomeMeaning } from './agent.ts';
import { OrientimApiError, rpcSender } from './api.ts';
import { apiKeyChallenge, isApiKeyMessage, redeemApiKey } from './keys.ts';
import { acquireLock, LockBusyError, releaseHeldLocks } from './lock.ts';
import { ApprovalError, checkPolicy, DEFAULT_STATE_DIR, forgetApproval, heldToApproval, keptApproval, loadPolicy, NO_POLICY, PolicyError, policyPathFor, policyWarning, stateDirFor } from './policy.ts';
import { createFileStore, movedNothing, pendingFor, PendingSwapError, recoverPending, resolvePending, settleOrder, takeOrder } from './store.ts';
import { checkPrepared, finalizeSigned, FloorError, holdSolFee, IntentError, OrientimOrderError, ownFloor, prepareChecked, PriceImpactError, receivedFor, resumeSigned } from './swap.ts';
import type { Intent, Prepared, SendTransaction } from './api.ts';
import type { OwnerPolicy, SpendLog } from './policy.ts';
import type { FoundOrder, OrderBook, OrderRecord, PendingStore } from './store.ts';
import type { Checked } from './swap.ts';
import { isRpcFailure, ORIENTIM_TREASURY, preparationBudget } from './verify.ts';

/** Dependencies for `runCli`. */
export type CliDeps = {
  rpc: Rpc<SolanaRpcApi>;
  apiUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  jupiterApiKey?: string;
  /** Fetch routes from Jupiter directly with `jupiterApiKey` (ORIENTIM_OWN_ROUTES=0 disables). */
  ownRoutes?: boolean;
  /** Custom transaction sender (ORIENTIM_SEND_RPC_URL); Orientim then sends nothing. */
  sendTransaction?: SendTransaction;
  stateDir: string;
  treasury?: string;
  pollMs?: number;
  maxWaitMs?: number;
  requestTimeoutMs?: number;
  /** Swap and order store; defaults to a file store in `stateDir`. */
  store?: PendingStore & OrderBook & Partial<SpendLog> & { orderBySignature?(signature: string): Promise<FoundOrder | null> };
  /** Owner policy (`ORIENTIM_POLICY`). */
  policy?: OwnerPolicy;
  /** Full-history RPC (`ORIENTIM_ARCHIVE_RPC_URL`) used as a second proof of expiry. */
  archive?: Rpc<SolanaRpcApi>;
};

/** A command's exit code and JSON output. */
export type CliResult = { code: number; output: Record<string, unknown> };

const COMMANDS = ['prepare', 'finalize', 'recover', 'resolve', 'check', 'key-challenge', 'key'] as const;
/** Commands that need only ORIENTIM_API_URL. */
const KEY_COMMANDS: readonly string[] = ['key-challenge', 'key'];
const usage = (message: string): CliResult => ({ code: 2, output: { ok: false, error: message } });
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const policyRefusal = (e: PolicyError, sent?: false): CliResult => ({
  code: 1,
  output: { ok: false, ...(sent === false ? { sent } : {}), error: { code: e.code, message: e.message, ...(e.limit ? { limit: e.limit } : {}), ...(e.spent ? { spent: e.spent } : {}) } },
});
/** Maps a pre-send refusal to exit 1 with `error.code`, or exit 2 for an unusable intent. */
function refusal(e: unknown, sent?: false): CliResult {
  const s = sent === false ? { sent } : {};
  if (e instanceof IntentError) return { code: 2, output: { ok: false, ...s, error: e.message } };
  if (e instanceof FloorError) {
    return { code: 1, output: { ok: false, ...s, problems: [e.message], error: { code: 'floor-too-low', message: e.message, minOut: e.minOut, lowest: e.lowest } } };
  }
  if (e instanceof PriceImpactError) {
    return { code: 1, output: { ok: false, ...s, problems: [e.message], error: { code: 'price-impact-high', message: e.message, impactBps: e.impactBps, limitBps: e.limitBps } } };
  }
  if (e instanceof PolicyError) return policyRefusal(e, sent);
  if (e instanceof ApprovalError) return { code: 1, output: { ok: false, ...s, problems: [e.message], error: { code: 'approval', message: e.message } } };
  if (unavailable(e)) return unavailableRefusal(e, sent);
  return { code: 1, output: { ok: false, ...s, problems: [messageOf(e)] } };
}

const spendsOf = (store: Partial<SpendLog>): SpendLog | undefined =>
  store.spentSince && store.recordSpend ? store as SpendLog : undefined;
const isIntent = (v: unknown): v is Intent => {
  const i = v as Partial<Intent> | null;
  return !!i && [i.owner, i.inputMint, i.outputMint, i.amountIn].every(x => typeof x === 'string' && x.length > 0)
    && /^\d{1,20}$/.test(i.amountIn!) && BigInt(i.amountIn!) > 0n;
};
const INTENT_SHAPE = '{"owner", "inputMint", "outputMint", "amountIn"} (strings; amountIn in base units, digits only)';
const approvalKeyOf = (i: Pick<Intent, 'owner' | 'inputMint' | 'outputMint' | 'amountIn'>) =>
  ({ owner: i.owner, inputMint: i.inputMint, outputMint: i.outputMint, amountIn: i.amountIn });
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Validates the intent and pins the treasury to ORIENTIM_TREASURY or the built-in one; a treasury in
 * the JSON is never trusted. Returns an error string when unusable.
 */
function ownIntent(raw: Intent, deps: CliDeps): Intent | string {
  if (!ADDRESS.test(raw.owner)) return 'intent.owner must be a wallet address.';
  const treasury = deps.treasury ?? ORIENTIM_TREASURY;
  if (raw.treasury !== undefined && raw.treasury !== treasury) {
    return `intent.treasury names ${ADDRESS.test(String(raw.treasury)) ? raw.treasury : 'another wallet'}; Orientim's treasury is taken only from ORIENTIM_TREASURY or the skill (${treasury}). Leave it out.`;
  }
  const { treasury: _given, ...rest } = raw;
  return { ...rest, ...(deps.treasury ? { treasury: deps.treasury } : {}) };
}

/** JSON-RPC codes meaning the node is temporarily unable to answer. Excludes -32002 (preflight) and -32003. */
const RPC_SERVER_BUSY: ReadonlySet<number> = new Set([-32603, -32004, -32005, -32007, -32009, -32014, -32016]);
/** True when a dependency (Jupiter, RPC, Orientim) was unreachable or busy; nothing was sent. */
function unavailable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === 'TimeoutError' || e.name === 'AbortError' || e.name === 'RpcUnavailableError' || e.name === 'BudgetSpentError'
    || (e instanceof TypeError && /fetch failed/i.test(e.message))
    || (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && [429, 500, 502, 503, 504].includes(Number(e.context.statusCode)))
    || (isSolanaError(e) && RPC_SERVER_BUSY.has(Number((e.context as { __code?: unknown }).__code)))
    || /^Jupiter answered (429|5\d\d\b|400 \(busy\))/.test(e.message);
}
const unavailableRefusal = (e: unknown, sent?: false): CliResult => ({
  code: 1,
  output: {
    ok: false, ...(sent === false ? { sent } : {}), problems: [messageOf(e)],
    error: { code: 'unavailable', message: 'A service this needs did not answer, or is busy: `problems` names it. Nothing was sent; try again in a few seconds.', retryAfter: 5 },
  },
});
/** Placeholder store for stateless commands; every method rethrows `e`. */
const unavailableStore = (e: unknown): PendingStore & OrderBook & SpendLog => {
  const fail = async (): Promise<never> => { throw e; };
  return { put: fail, remove: fail, list: fail, order: fail, recordOrder: fail, claimOrder: fail, spentSince: fail, recordSpend: fail };
};

/** Returns the fee payer of a signed transaction, or null. */
function feePayerOf(signedTransaction: string): string | null {
  try {
    return getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(signedTransaction, 'base64')).messageBytes).staticAccounts[0] ?? null;
  } catch {
    return null;
  }
}

/** Age after which a pending order's transaction cannot land (blockhashes live 150 blocks, about 30 seconds at 200 ms blocks). */
const ORDER_SETTLED_AFTER_MS = 10 * 60_000;

/**
 * Resolves a pending order whose swap record is missing. Prefers the chain's status; the caller's
 * outcome is used only once the transaction can no longer land.
 */
async function resolveOrderOnly(
  signature: string, outcome: 'confirmed' | 'failed' | 'expired', store: NonNullable<CliDeps['store']>, deps: CliDeps,
): Promise<CliResult> {
  const none: CliResult = { code: 1, output: { ok: false, error: `No kept swap has the signature ${signature}. Nothing was changed.` } };
  let found: FoundOrder | null;
  try {
    found = store.orderBySignature ? await store.orderBySignature(signature) : null;
  } catch (e) {
    return { code: 3, output: { ok: false, error: `The order book could not be read: ${messageOf(e)}. Nothing was changed.` } };
  }
  if (!found || found.record.state !== 'pending') return none;
  let status: { confirmationStatus?: string | null; err?: unknown } | null;
  try {
    [status] = (await deps.rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true })
      .send({ abortSignal: AbortSignal.timeout(deps.requestTimeoutMs ?? 10_000) })).value as typeof status[];
  } catch (e) {
    return { code: 3, output: { ok: false, error: `Your RPC could not be asked about ${signature}: ${messageOf(e)}. Nothing was changed.` } };
  }
  const settled = status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized');
  if (status && !settled) {
    return { code: 1, output: { ok: false, error: `The network has seen ${signature} but not settled it yet: wait and resolve again. Nothing was changed.` } };
  }
  if (!settled && Date.now() - found.recordedAt < ORDER_SETTLED_AFTER_MS) {
    return { code: 1, output: { ok: false, error: `${signature} was recorded moments ago and may still land: resolve it later. Nothing was changed.` } };
  }
  const state = settled ? (status!.err ? 'failed' as const : 'confirmed' as const) : outcome;
  try {
    await store.recordOrder(found.id, { signature, state });
  } catch (e) {
    return { code: 3, output: { ok: false, error: `The order could not be updated: ${messageOf(e)}.` } };
  }
  return { code: 0, output: { ok: true, signature, outcome: state, by: settled ? 'chain' : 'you', order: found.id } };
}

/** Error codes that are transient: the same call may succeed after `retryAfter`. */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'unavailable', 'busy', 'rate-limited', 'expired', 'bad-session', 'routes-needed', 'route-format', 'paused',
  'fee-unavailable', 'bad-quote', 'internal', 'token-data-mismatch', 'no-route', 'simulation-failed', 'output-balance-changed',
  'output-in-flight',
]);

/**
 * Adds `retryable` and `requiresNewOrderId` to failed results. `requiresNewOrderId` is always false:
 * retries must reuse the order id, which is what prevents a double swap.
 */
export function withRetryHints(result: CliResult): CliResult {
  if (result.output.ok !== false) return result;
  const error = result.output.error;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : result.output.code;
  const outcome = result.output.outcome;
  const retryable = result.code === 3
    || (result.code !== 2 && result.code !== 5 && (
      (typeof code === 'string' && RETRYABLE_CODES.has(code))
      || outcome === 'failed' || outcome === 'expired' || outcome === 'rejected'));
  return { code: result.code, output: { ...result.output, retryable, requiresNewOrderId: false } };
}

/** Runs a command. Exit 3 results carry `recoveryRequired: true`; failures carry retry hints. */
export async function runCli(command: string, input: unknown, deps: CliDeps): Promise<CliResult> {
  const result = await runCommand(command, input, deps);
  return withRetryHints(result.code === 3 ? { code: 3, output: { ...result.output, recoveryRequired: true } } : result);
}

async function runCommand(command: string, input: unknown, deps: CliDeps): Promise<CliResult> {
  const body = (input ?? {}) as Record<string, unknown>;
  // An unusable state directory is exit 3 for stateful commands; check and key commands keep no state.
  let store: PendingStore & OrderBook & Partial<SpendLog>;
  try {
    store = deps.store ?? createFileStore(deps.stateDir);
  } catch (e) {
    if (command === 'check' || KEY_COMMANDS.includes(command) || !(COMMANDS as readonly string[]).includes(command)) {
      store = unavailableStore(e);
    } else {
      return { code: 3, output: { ok: false, sent: false, error: `The state directory ${deps.stateDir} cannot be used: ${messageOf(e)}. Nothing was prepared, sent or changed; fix it first.` } };
    }
  }

  if (command === 'check') {
    const prepared = body.prepared as Prepared | undefined;
    if (!prepared || typeof prepared.transaction !== 'string' || !isIntent(body.intent)) {
      return usage(`check reads {"prepared": <Orientim's prepare answer>, "intent": ${INTENT_SHAPE}}.`);
    }
    const intent = ownIntent(body.intent, deps);
    if (typeof intent === 'string') return usage(intent);
    try {
      if (deps.policy) await checkPolicy(deps.policy, intent, spendsOf(store));
      if (intent.slippageBps === 'auto') return usage('check needs intent.slippageBps as the number of bps the swap was prepared with, not "auto".');
      const budget = preparationBudget();
      const own = await ownFloor(intent, { rpc: deps.rpc, fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey, requestTimeoutMs: deps.requestTimeoutMs, policy: deps.policy, budget });
      intent.minOut = own.minOut;
      // Never report safe-to-sign below a dry-run approved minimum.
      const approved = heldToApproval(keptApproval(deps.stateDir, approvalKeyOf({ ...intent, owner: typeof prepared.wallet === 'string' ? prepared.wallet : intent.owner })), undefined);
      if (approved !== undefined && BigInt(approved) > BigInt(intent.minOut)) intent.minOut = approved;
      if (own.slippageBps !== undefined) intent.slippageBps = own.slippageBps;
      const priceImpactBps = own.priceImpactBps;
      await holdSolFee(intent, prepared, { fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey, budget });
      const problems = await checkPrepared(prepared, intent, deps.rpc, { requestTimeoutMs: deps.requestTimeoutMs, slippageCeilingBps: deps.policy?.maxSlippageBps });
      if (problems.length && problems.every(isRpcFailure)) return unavailableRefusal(new Error(problems.join('; ')));
      return { code: problems.length ? 1 : 0, output: { ok: problems.length === 0, problems, yourFloor: intent.minOut, priceImpactBps } };
    } catch (e) {
      return refusal(e);
    }
  }

  if (command === 'recover') {
    // Lock every affected wallet so recovery never races a run that is taking the same order.
    const held: (() => void)[] = [];
    try {
      let owners: string[];
      try {
        owners = [...new Set((await store.list()).map(s => s.owner ?? feePayerOf(s.signedTransaction)).filter((o): o is string => !!o && ADDRESS.test(o)))].sort();
      } catch (e) {
        return { code: 3, output: { ok: false, error: `The kept swaps could not be read or settled: ${messageOf(e)}. Nothing new may start until they are.` } };
      }
      try {
        for (const owner of owners) held.push(acquireLock(deps.stateDir, owner));
      } catch (e) {
        return { code: 3, output: { ok: false, ...(e instanceof LockBusyError ? { busy: true } : {}), error: `${messageOf(e)} Nothing was settled; run recover again once it is done.` } };
      }
      const { settled, unknown, bookkeepingErrors } = await recoverPending(store, deps.rpc, { pollMs: deps.pollMs, maxWaitMs: deps.maxWaitMs, orders: store, archive: deps.archive, spends: store });
      const open = unknown.length > 0 || bookkeepingErrors.length > 0;
      return {
        code: open ? 3 : 0,
        output: {
          ok: !open, settled, unknown, ...(bookkeepingErrors.length ? { bookkeepingErrors } : {}),
          ...(unknown.length ? { next: 'Check each unknown signature before swapping again. One the network can no longer prove: look it up in a full history (an explorer), then `orientim resolve`.' } : {}),
        },
      };
    } catch (e) {
      return { code: 3, output: { ok: false, error: `The kept swaps could not be read or settled: ${messageOf(e)}. Nothing new may start until they are.` } };
    } finally {
      for (const release of held) release();
    }
  }

  if (command === 'resolve') {
    const { signature, outcome } = body as { signature?: unknown; outcome?: unknown };
    if (typeof signature !== 'string' || (outcome !== 'confirmed' && outcome !== 'failed' && outcome !== 'expired')) {
      return usage('resolve reads {"signature": "<a kept swap>", "outcome": "confirmed" | "failed" | "expired"}, once you looked it up in a full history.');
    }
    let kept: Awaited<ReturnType<typeof store.list>>[number] | undefined;
    try {
      kept = (await store.list()).find(s => s.signature === signature);
    } catch (e) {
      return { code: 3, output: { ok: false, error: `The kept swaps could not be read: ${messageOf(e)}. Nothing was changed.` } };
    }
    if (!kept) return resolveOrderOnly(signature, outcome, store, deps);
    const owner = kept.owner ?? feePayerOf(kept.signedTransaction);
    if (!owner || !ADDRESS.test(owner)) {
      return { code: 1, output: { ok: false, error: `The kept swap ${signature} names no wallet it was signed by. Nothing was changed.` } };
    }
    let release: () => void;
    try {
      release = acquireLock(deps.stateDir, owner);
    } catch (e) {
      return { code: 3, output: { ok: false, ...(e instanceof LockBusyError ? { busy: true } : {}), error: `${messageOf(e)} Nothing was changed; try again once it is done.` } };
    }
    try {
      const resolved = await resolvePending(store, deps.rpc, signature, outcome, { orders: store, requestTimeoutMs: deps.requestTimeoutMs, spends: store });
      return { code: 0, output: { ok: true, ...resolved } };
    } catch (e) {
      return { code: 1, output: { ok: false, error: messageOf(e) } };
    } finally {
      release();
    }
  }

  // API key issuance: the bot signs the verified key message itself.
  if (command === 'key-challenge' || command === 'key') {
    if (!deps.apiUrl) return usage('Set ORIENTIM_API_URL.');
    try {
      if (command === 'key-challenge') {
        if (typeof body.wallet !== 'string') return usage('key-challenge reads {"wallet": "<address>"}.');
        const c = await apiKeyChallenge({ apiUrl: deps.apiUrl, address: body.wallet, fetchImpl: deps.fetchImpl, requestTimeoutMs: deps.requestTimeoutMs });
        return { code: 0, output: { ok: true, ...c, messageBase64: Buffer.from(c.message).toString('base64') } };
      }
      const { message, challenge, signature } = body;
      if (typeof message !== 'string' || typeof challenge !== 'string' || typeof signature !== 'string') {
        return usage('key reads {"message", "challenge", "signature"} (the signature of message, base58 or base64).');
      }
      const wallet = message.split('\n')[1] ?? '';
      if (!isApiKeyMessage(message, deps.apiUrl, wallet)) return usage("That is not Orientim's API-key message; get one with key-challenge.");
      const issued = await redeemApiKey({ apiUrl: deps.apiUrl, message, challenge, signature, fetchImpl: deps.fetchImpl, requestTimeoutMs: deps.requestTimeoutMs });
      return { code: 0, output: { ok: true, ...issued } };
    } catch (e) {
      if (e instanceof OrientimApiError) return { code: 4, output: { ok: false, error: e.message, status: e.status, code: e.code, retryAfter: e.retryAfter } };
      if (unavailable(e)) return { code: 1, output: { ok: false, error: `Orientim did not answer: ${messageOf(e)}. Nothing was signed; try again in a few seconds.`, code: 'unavailable', retryAfter: 5 } };
      return { code: 1, output: { ok: false, error: messageOf(e) } };
    }
  }

  if (!deps.apiUrl || !deps.apiKey) return usage('Set ORIENTIM_API_URL and ORIENTIM_API_KEY.');
  const api = { apiUrl: deps.apiUrl.replace(/\/+$/, ''), apiKey: deps.apiKey };

  if (command === 'prepare') {
    if (!isIntent(body.intent)) return usage(`prepare reads {"intent": ${INTENT_SHAPE}}.`);
    if (typeof body.intent.id !== 'string' || !body.intent.id) {
      return usage('prepare needs intent.id: your order\'s own id, the same on every retry of that order, so that it is never swapped twice.');
    }
    const own = ownIntent(body.intent, deps);
    if (typeof own === 'string') return usage(own);
    // One swap per wallet at a time; a record with an unreadable wallet blocks every wallet.
    const orderId = body.intent.id;
    let pending: string[];
    let prior: OrderRecord | null;
    try {
      pending = await pendingFor(store, own.owner);
      prior = orderId ? await store.order(orderId) : null;
    } catch (e) {
      return { code: 3, output: { ok: false, sent: false, error: `The kept swaps could not be read: ${messageOf(e)}. Nothing was prepared; fix the state directory first.` } };
    }
    if (pending.length) {
      return { code: 3, output: { ok: false, pending, error: 'Earlier swaps are not settled yet: run `orientim recover` first. Nothing was prepared.' } };
    }
    if (prior && (prior.state === 'confirmed' || prior.state === 'pending')) {
      return { code: 5, output: { ok: false, order: { id: orderId, ...prior }, error: prior.state === 'confirmed' ? 'This order already swapped. Nothing new was prepared.' : 'This order has a transaction that may still land: run `orientim recover`. Nothing new was prepared.' } };
    }
    const { owner, ...rest } = own;
    try {
      if (deps.policy) await checkPolicy(deps.policy, own, spendsOf(store));
      rest.minOut = heldToApproval(keptApproval(deps.stateDir, approvalKeyOf(own)), rest.minOut);
      const checked = await prepareChecked({
        ...api, rpc: deps.rpc, owner, intent: rest,
        fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey, requestTimeoutMs: deps.requestTimeoutMs, policy: deps.policy,
        ...(deps.ownRoutes !== undefined ? { ownRoutes: deps.ownRoutes } : {}),
      });
      const tx = getTransactionDecoder().decode(Buffer.from(checked.prepared.transaction, 'base64'));
      return {
        code: 0,
        output: {
          ok: true, checked, message: Buffer.from(tx.messageBytes).toString('base64'),
          amounts: checked.prepared.amounts, costs: checked.prepared.costs, lastValidBlockHeight: checked.prepared.lastValidBlockHeight,
          notices: checked.notices ?? [], ...(checked.tokenRisk ? { tokenRisk: checked.tokenRisk } : {}),
        },
      };
    } catch (e) {
      if (e instanceof OrientimApiError) {
        return {
          code: 4,
          output: {
            ok: false,
            error: {
              status: e.status, code: e.code, message: e.message, retryAfter: e.retryAfter, details: e.body,
              ...(e.serverMessage ? { untrustedServerMessage: e.serverMessage } : {}),
            },
          },
        };
      }
      return refusal(e);
    }
  }

  if (command === 'finalize') {
    // Approvals recorded after this moment are newer and must not be consumed by this swap.
    const finalizeStarted = Date.now();
    const checked = body.checked as Checked | undefined;
    const { signature, signedTransaction } = body as { signature?: unknown; signedTransaction?: unknown };
    if (!checked?.prepared || !isIntent(checked.intent) || (typeof signature !== 'string' && typeof signedTransaction !== 'string')) {
      return usage('finalize reads {"checked": <prepare\'s checked, unchanged>, "signature": "<base58>"} or {"checked": ..., "signedTransaction": "<base64>"}.');
    }
    // Without the order id nothing prevents a double swap.
    if (typeof checked.intent.id !== 'string' || !checked.intent.id) {
      return usage('finalize needs checked.intent.id, the order\'s id prepare was given: pass prepare\'s checked unchanged. Nothing was sent.');
    }
    const { prepared } = checked;
    // The wallet names the lock file, so only an address may reach a path.
    if (typeof prepared.wallet !== 'string' || !ADDRESS.test(prepared.wallet)) return usage('checked.prepared.wallet must be a wallet address.');
    const ownOrError = ownIntent(checked.intent, deps);
    if (typeof ownOrError === 'string') return usage(ownOrError);
    const intent: Intent = ownOrError;
    // A bookkeeping failure is reported alongside the chain outcome, never instead of it.
    const settle = async (result: { signature: string; outcome: string; refusal?: string; cause?: string }, orderId: string | undefined, resumed: boolean): Promise<CliResult> => {
      let bookkeepingError: string | undefined;
      try {
        // Never overwrite an order held by a newer attempt.
        if (orderId) await settleOrder(store, orderId, { signature: result.signature, state: (result.outcome === 'unknown' ? 'pending' : result.outcome) as OrderRecord['state'] });
        // Refund the daily allowance when the chain proves nothing moved.
        if (movedNothing(result.outcome)) await store.forgetSpend?.(result.signature);
        if (result.outcome !== 'unknown') await store.remove(result.signature);
        // Only a confirmed swap consumes the approval.
        if (result.outcome === 'confirmed') forgetApproval(deps.stateDir, approvalKeyOf({ ...intent, owner: prepared.wallet }), finalizeStarted);
      } catch (e) {
        bookkeepingError = messageOf(e);
      }
      // Best effort; never fails the result.
      const received = result.outcome === 'confirmed'
        ? await receivedFor(deps.rpc, result.signature, prepared, { requestTimeoutMs: deps.requestTimeoutMs, pollMs: deps.pollMs })
        : null;
      return {
        code: exitCodeOf({ outcome: result.outcome as Parameters<typeof exitCodeOf>[0]['outcome'], bookkeepingError }),
        output: {
          ok: result.outcome === 'confirmed', signature: result.signature, outcome: result.outcome,
          ...(result.refusal ? { refusal: result.refusal } : {}),
          meaning: outcomeMeaning(result.outcome as Parameters<typeof outcomeMeaning>[0], result.refusal, result.cause), amounts: prepared.amounts,
          ...(received !== null ? { received: received.toString() } : {}),
          ...(resumed ? { resumed: true } : {}),
          ...(bookkeepingError ? { bookkeepingError } : {}),
        },
      };
    };
    // A repeated signature resumes the kept swap instead of sending a new one.
    const incoming = (() => {
      if (typeof signature === 'string') return signature;
      try {
        return getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(signedTransaction as string, 'base64')));
      } catch {
        return undefined;
      }
    })();
    let release: () => void;
    try {
      release = acquireLock(deps.stateDir, prepared.wallet);
    } catch (e) {
      if (!(e instanceof LockBusyError)) {
        return { code: 3, output: { ok: false, sent: false, error: `${messageOf(e)}` } };
      }
      // The lock holder may have sent this transaction, so the outcome is unknown, not "not sent".
      return {
        code: 3,
        output: {
          ok: false, busy: true, ...(incoming ? { signature: incoming } : {}), outcome: 'unknown',
          error: `${messageOf(e)} That run may have sent this swap: wait for it, then run \`orientim recover\` before anything new.`,
        },
      };
    }
    // Set once the swap is kept; after that, any error means the outcome is unknown.
    let signedAs: string | null = null;
    try {
      // A kept swap may already be sent, so an unreadable store means an unknown outcome.
      let kept: Awaited<ReturnType<typeof store.list>>[number] | undefined;
      let recorded: OrderRecord | null;
      let waiting: string[];
      try {
        kept = incoming ? (await store.list()).find(s => s.signature === incoming) : undefined;
        recorded = !kept && intent.id && incoming ? await store.order(intent.id) : null;
        waiting = kept ? [] : await pendingFor(store, prepared.wallet, incoming);
      } catch (e) {
        return {
          code: 3,
          output: {
            ok: false, ...(incoming ? { signature: incoming } : {}), outcome: 'unknown',
            error: `The kept swaps could not be read: ${messageOf(e)}. An earlier run may have sent this swap; fix the state directory, then run \`orientim recover\`.`,
          },
        };
      }
      if (kept) {
        signedAs = kept.signature;
        const result = await resumeSigned({
          ...api, rpc: deps.rpc, signed: kept, fetchImpl: deps.fetchImpl, pollMs: deps.pollMs, maxWaitMs: deps.maxWaitMs, requestTimeoutMs: deps.requestTimeoutMs,
          archive: deps.archive, ...(deps.sendTransaction ? { sendTransaction: deps.sendTransaction } : {}),
        });
        return settle(result, kept.intentId ?? intent.id, true);
      }
      // The order points at this transaction but the swap record is gone: it may have landed.
      if (recorded && recorded.signature === incoming) {
        return {
          code: recorded.state === 'confirmed' ? 0 : recorded.state === 'pending' ? 3 : 1,
          output: {
            ok: recorded.state === 'confirmed', signature: incoming, outcome: recorded.state === 'pending' ? 'unknown' : recorded.state, recorded: true,
            ...(recorded.state === 'pending' ? { error: 'This transaction is recorded pending for its order, but its own record is gone: check its signature before anything new.' } : {}),
          },
        };
      }
      if (waiting.length) {
        return { code: 3, output: { ok: false, sent: false, pending: waiting, error: 'An earlier swap from this wallet may still land: run `orientim recover` first. Nothing was sent.' } };
      }
      // Re-verify everything; `checked` from prepare is not trusted.
      intent.minOut = heldToApproval(keptApproval(deps.stateDir, approvalKeyOf({ ...intent, owner: prepared.wallet })), intent.minOut);
      if (intent.slippageBps === 'auto') return { code: 2, output: { ok: false, sent: false, error: 'finalize needs checked.intent.slippageBps as prepare returned it, a number, not "auto". Nothing was sent.' } };
      const budget = preparationBudget();
      const own = await ownFloor(intent, { rpc: deps.rpc, fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey, requestTimeoutMs: deps.requestTimeoutMs, policy: deps.policy, budget });
      intent.minOut = own.minOut;
      if (own.slippageBps !== undefined) intent.slippageBps = own.slippageBps;
      await holdSolFee(intent, prepared, { fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey, budget });
      const problems = await checkPrepared(prepared, intent, deps.rpc, { requestTimeoutMs: deps.requestTimeoutMs, slippageCeilingBps: deps.policy?.maxSlippageBps });
      if (problems.length && problems.every(isRpcFailure)) return unavailableRefusal(new Error(problems.join('; ')), false);
      if (problems.length) return { code: 1, output: { ok: false, sent: false, problems } };
      let wire = typeof signedTransaction === 'string' ? signedTransaction : '';
      if (!wire) {
        const tx = getTransactionDecoder().decode(Buffer.from(prepared.transaction, 'base64'));
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(getBase58Encoder().encode(signature as string));
        } catch {
          return { code: 1, output: { ok: false, sent: false, error: 'signature is not base58.' } };
        }
        if (bytes.length !== 64) return { code: 1, output: { ok: false, sent: false, error: 'signature must be 64 bytes, in base58.' } };
        wire = Buffer.from(getTransactionEncoder().encode({
          ...tx, signatures: { ...tx.signatures, [prepared.wallet as Address]: bytes as SignatureBytes },
        })).toString('base64');
      }
      const result = await finalizeSigned({
        ...api, rpc: deps.rpc, prepared, signedTransaction: wire, fetchImpl: deps.fetchImpl,
        pollMs: deps.pollMs, maxWaitMs: deps.maxWaitMs, requestTimeoutMs: deps.requestTimeoutMs, archive: deps.archive,
        ...(deps.sendTransaction ? { sendTransaction: deps.sendTransaction } : {}),
        // Persist the swap before taking the order so a crash leaves something `recover` can settle.
        // Taking the order is atomic, so two runs cannot both send it.
        onSigned: async s => {
          const others = await pendingFor(store, prepared.wallet, s.signature);
          if (others.length) throw new PendingSwapError(others);
          // Re-check the policy under the lock and record the spend before keeping, since a kept swap may
          // be sent. Spends are recorded even without a policy so a later daily limit counts them.
          const spends = spendsOf(store);
          if (deps.policy) await checkPolicy(deps.policy, { owner: prepared.wallet, inputMint: intent.inputMint, outputMint: intent.outputMint, amountIn: intent.amountIn }, spends, s.signature);
          await spends?.recordSpend({ signature: s.signature, owner: prepared.wallet, mint: intent.inputMint, amountIn: intent.amountIn, at: Date.now() });
          try {
            const orderId = intent.id;
            await store.put({ ...s, ...(orderId ? { intentId: orderId } : {}) });
            // Re-read after keeping so concurrent runs both stand down instead of both sending.
            const raced = await pendingFor(store, prepared.wallet, s.signature);
            if (raced.length) {
              await store.remove(s.signature);
              throw new PendingSwapError(raced);
            }
            if (orderId) {
              const record: OrderRecord = { signature: s.signature, state: 'pending' };
              const prior = await store.order(orderId);
              const open = prior && (prior.state === 'confirmed' || prior.state === 'pending');
              if (open || !await takeOrder(store, orderId, prior, record)) {
                await store.remove(s.signature);
                throw new OrientimOrderError(orderId, open ? prior! : (await store.order(orderId)) ?? record);
              }
            }
          } catch (e) {
            await spends?.forgetSpend?.(s.signature).catch(() => undefined);
            throw e;
          }
          signedAs = s.signature;
        },
      });
      return settle(result, intent.id, false);
    } catch (e) {
      if (signedAs) return { code: 3, output: { ok: false, signature: signedAs, outcome: 'unknown', error: messageOf(e) } };
      if (e instanceof PendingSwapError) return { code: 3, output: { ok: false, sent: false, pending: e.signatures, error: e.message } };
      if (e instanceof OrientimOrderError) {
        return {
          code: 5,
          output: {
            ok: false, sent: false, order: { id: e.id, ...e.record },
            error: e.record.state === 'confirmed' ? `Order ${e.id} already swapped (${e.record.signature}). This run sent nothing.`
              : e.record.state === 'pending' ? `Order ${e.id} has a transaction that may still land (${e.record.signature}): run \`orientim recover\`. This run sent nothing.`
                : `Order ${e.id} was taken by another run, or this order book cannot retry it safely. This run sent nothing.`,
          },
        };
      }
      if (e instanceof FloorError || e instanceof PriceImpactError || e instanceof PolicyError || e instanceof IntentError || e instanceof ApprovalError || unavailable(e)) {
        return refusal(e, false);
      }
      return { code: 1, output: { ok: false, sent: false, error: messageOf(e) } };
    } finally {
      release();
    }
  }

  return usage(`Commands: ${COMMANDS.join(', ')}.`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** Entry point for the `orientim` binary. */
export async function main(): Promise<void> {
  const command = process.argv[2] ?? '';
  const print = (result: CliResult) => {
    const r = withRetryHints(result);
    process.stdout.write(`${JSON.stringify(r.output, null, 2)}\n`);
    process.exitCode = r.code;
  };
  if (!(COMMANDS as readonly string[]).includes(command)) return print(usage(`usage: orientim <${COMMANDS.join('|')}> < input.json`));
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl && !KEY_COMMANDS.includes(command)) return print(usage('Set SOLANA_RPC_URL to your own RPC.'));
  if (!process.env.JUPITER_API_KEY && (command === 'prepare' || command === 'check' || command === 'finalize')) {
    process.stderr.write('JUPITER_API_KEY is not set: Jupiter throttles keyless calls, and your own floor may not be priced.\n');
  }
  // An unreadable policy blocks every command except recover and resolve.
  let policy: OwnerPolicy | undefined;
  if (!KEY_COMMANDS.includes(command)) {
    try {
      const policyPath = policyPathFor(process.env.ORIENTIM_POLICY || undefined);
      if (policyPath) {
        policy = loadPolicy(policyPath);
        const note = policyWarning(policyPath);
        if (note && command !== 'recover' && command !== 'resolve') process.stderr.write(`${note}\n`);
      }
    } catch (e) {
      if (command !== 'recover' && command !== 'resolve') return print(usage(messageOf(e)));
    }
  }
  // A swap is prepared and signed only within the owner's limits.
  if (!policy && (command === 'prepare' || command === 'finalize')) return print(usage(NO_POLICY));
  const given = process.env.ORIENTIM_STATE_DIR || undefined;
  let stateDir: string;
  try {
    const chosen = stateDirFor(policy, given);
    stateDir = chosen.dir;
    if (chosen.warning && !KEY_COMMANDS.includes(command)) process.stderr.write(`${chosen.warning}\n`);
  } catch (e) {
    // Recovery must still work when the state directory rules reject the configuration.
    if (command !== 'recover' && command !== 'resolve') return print(usage(messageOf(e)));
    stateDir = policy?.stateDir ?? given ?? DEFAULT_STATE_DIR;
  }
  // Release wallet locks on termination; `recover` settles any persisted swap.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      releaseHeldLocks();
      process.exit(signal === 'SIGTERM' ? 143 : 130);
    });
  }
  let input: unknown = {};
  if (command !== 'recover') {
    try {
      // Strip the BOM that C# and PowerShell 5.1 write before UTF-8 text.
      input = JSON.parse((await readStdin()).replace(/^\uFEFF/, ''));
    } catch {
      return print(usage('The input on stdin is not JSON.'));
    }
  }
  print(await runCli(command, input, {
    // Placeholder for key commands, which do not use an RPC.
    rpc: createSolanaRpc(rpcUrl ?? 'http://127.0.0.1:1'),
    ...(process.env.ORIENTIM_ARCHIVE_RPC_URL ? { archive: createSolanaRpc(process.env.ORIENTIM_ARCHIVE_RPC_URL) } : {}),
    ...(process.env.ORIENTIM_SEND_RPC_URL ? { sendTransaction: rpcSender(process.env.ORIENTIM_SEND_RPC_URL) } : {}),
    apiUrl: process.env.ORIENTIM_API_URL,
    apiKey: process.env.ORIENTIM_API_KEY,
    jupiterApiKey: process.env.JUPITER_API_KEY || undefined,
    ownRoutes: process.env.ORIENTIM_OWN_ROUTES !== '0',
    stateDir,
    treasury: process.env.ORIENTIM_TREASURY || undefined,
    policy,
  }));
}
