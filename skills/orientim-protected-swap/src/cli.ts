/**
 * `orientim-verify`: Orientim's protected swap for bots in any language (Python, Rust, Go...). The bot
 * keeps its key and signs one message itself; this command does everything else the example does,
 * the same code: your own floor, the full check on your RPC, the durable record before finalize,
 * finalize, and the outcome read on the chain for the wallet's own signature. JSON in (stdin), JSON
 * out (stdout), and an exit code:
 *
 *   orientim-verify prepare    {"intent": {...}}                       0 ok: sign `message`   1 refused   3 settle first   4 Orientim said no
 *   orientim-verify finalize   {"checked": ..., "signature": "..."}    0 confirmed   1 not swapped   3 unknown: recover before anything new
 *                                                                      (3 too for a confirmed swap whose record could not be updated)
 *                                                                      5 this order already swapped, or another run has it
 *   orientim-verify recover                                            0 all settled   3 something is still unknown, or a run holds the wallet
 *   orientim-verify resolve    {"signature": "...", "outcome": "..."}  0 settled   1 refused (it could still land, or is not kept)
 *   3 also when the state directory cannot be made, read or written: nothing is prepared or changed until
 *   it can, and when another run from the wallet holds its lock (`busy`: that run may have sent the swap).
 *   orientim-verify check      {"prepared": ..., "intent": {...}}      0 safe to sign   1 refused   2 usage   (for bots that call the API themselves)
 *   orientim-verify key-challenge  {"wallet": "<address>"}             0 sign `message` (checked: Orientim's key message for this wallet, nothing else)
 *   orientim-verify key        {"message", "challenge", "signature"}   0 `key`, bound to that wallet   4 Orientim said no
 *   (both key commands: 1 when Orientim did not answer, with `code` `unavailable`; their `error` is a string, `code` beside it)
 *   A dry run's approval kept in the state directory (`node examples/swap.ts --dry-run`) holds here too:
 *   prepare and finalize refuse a lower minimum, or an expired approval (exit 1, `error.code` `approval`).
 *   2 on any usage or configuration error (a slippageBps, maxPriceImpactBps, maxFeeBps or minOut it cannot use included); 5 when `intent.id` names an order that already swapped or
 *   whose transaction may still land (the same order is never swapped twice). finalize without
 *   `checked.intent.id` is a usage error: the id is what keeps the order from being swapped twice.
 *
 * Every exit 3 carries `recoveryRequired: true`: run `recover` before anything new. `sent: false` says
 * only that this call sent nothing, never that an earlier call for the same order did not.
 *
 * Finalize asked again for a swap it already kept (the same signature) is not a new send: it asks
 * Orientim once more for the same bytes and reads the chain, and always answers with that signature and
 * its outcome. `resolve` settles by hand, after you looked it up in a full history
 * (an explorer), a kept swap whose outcome the chain can no longer prove: `outcome` is `confirmed`,
 * `failed` or `expired`; the chain's own answer is used instead whenever your RPC still has one.
 *
 * `intent` is the example's `Intent`: owner, inputMint, outputMint, amountIn (base units, strings),
 * and optionally slippageBps, maxPriceImpactBps, minOut, maxFeeBps, maxNetworkFeeLamports, maxRouteCostLamports,
 * maxSolFeeLamports (only ever lower than the skill's own limit), acceptCostBps, version. Orientim's treasury is never
 * taken from the JSON: only ORIENTIM_TREASURY names another. `prepare` answers `checked` (pass it to finalize unchanged) and `message`,
 * the transaction's message in base64: sign those bytes with the wallet's ed25519 key and pass the
 * 64-byte signature to finalize in base58 as `signature`, or the whole signed transaction in base64
 * as `signedTransaction`. Finalize checks everything again before anything is sent, the floor from
 * Jupiter's own price and the hard limits included: `checked` is taken on trust for nothing.
 *
 * A refusal because a service did not answer (Jupiter busy, your RPC or Orientim not answering) carries
 * `error.code` `unavailable` and `retryAfter`: try again later. Any other refusal is not a retry.
 *
 * Environment: SOLANA_RPC_URL (your own RPC; always), ORIENTIM_API_URL and ORIENTIM_API_KEY (prepare,
 * finalize), JUPITER_API_KEY (Jupiter throttles keyless calls), ORIENTIM_STATE_DIR (default ./.orientim-state; an
 * absolute path on a disk that outlives the process), ORIENTIM_TREASURY (only for another Orientim deployment),
 * ORIENTIM_POLICY (the owner's limits per swap and per day, a JSON file: see `OwnerPolicy`; a swap outside
 * them exits 1 with `error.code` `mint-not-allowed`, `amount-over-limit` or `daily-limit`; with a daily limit
 * the state directory must be absolute, the policy's `stateDir` or ORIENTIM_STATE_DIR). `check` counts a daily
 * limit against the swaps this state directory kept; a bot that sends through the API itself records none,
 * so for it a daily limit is only as good as its own record.
 * Finalize can take minutes (it reads the outcome on the chain): a run that is stopped anyway is settled
 * by `recover` before anything new.
 */
import {
  createSolanaRpc, getBase58Encoder, getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder,
  isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from '@solana/kit';
import type { Address, Rpc, SignatureBytes, SolanaRpcApi } from '@solana/kit';
import {
  acquireLock, apiKeyChallenge, OrientimApiError, checkPrepared, createFileStore, finalizeSigned, isApiKeyMessage, pendingFor, PendingSwapError,
  prepareChecked, PriceImpactError, FloorError, ownFloor, receivedFor, recoverPending, redeemApiKey, resolvePending, resumeSigned, takeOrder,
  checkPolicy, loadPolicy, PolicyError, LockBusyError, OrientimOrderError, holdSolFee, releaseHeldLocks, stateDirFor, DEFAULT_STATE_DIR, IntentError,
  exitCodeOf, outcomeMeaning, settleOrder, ApprovalError, forgetApproval, heldToApproval, keptApproval,
} from '../examples/swap.ts';
import type { Checked, FoundOrder, Intent, OrderBook, OrderRecord, OwnerPolicy, PendingStore, Prepared, SpendLog } from '../examples/swap.ts';
import { isRpcFailure, ORIENTIM_TREASURY } from '../lib/orientim-verify.mjs';

export type CliDeps = {
  rpc: Rpc<SolanaRpcApi>;
  apiUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  jupiterApiKey?: string;
  stateDir: string;
  treasury?: string;
  pollMs?: number;
  maxWaitMs?: number;
  requestTimeoutMs?: number;
  /** Where swaps and orders are kept; the state directory's files unless given (tests give one that fails). */
  store?: PendingStore & OrderBook & Partial<SpendLog> & { orderBySignature?(signature: string): Promise<FoundOrder | null> };
  /** The owner's limits (`ORIENTIM_POLICY`): per swap and per day, whatever the intent says. */
  policy?: OwnerPolicy;
  /** An RPC with the full history the owner names (`ORIENTIM_ARCHIVE_RPC_URL`): a second proof of expiry. */
  archive?: Rpc<SolanaRpcApi>;
};

export type CliResult = { code: number; output: Record<string, unknown> };

const COMMANDS = ['prepare', 'finalize', 'recover', 'resolve', 'check', 'key-challenge', 'key'] as const;
/** The commands that get an API key: they need Orientim's URL, not a key or an RPC. */
const KEY_COMMANDS: readonly string[] = ['key-challenge', 'key'];
const usage = (message: string): CliResult => ({ code: 2, output: { ok: false, error: message } });
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** The owner's policy said no: exit 1, with its code and figures. */
const policyRefusal = (e: PolicyError, sent?: false): CliResult => ({
  code: 1,
  output: { ok: false, ...(sent === false ? { sent } : {}), error: { code: e.code, message: e.message, ...(e.limit ? { limit: e.limit } : {}), ...(e.spent ? { spent: e.spent } : {}) } },
});
/**
 * Why a swap is refused before anything was sent, as a bot reads it: exit 1, with `error.code` for the
 * refusals it can act on (the floor, the price impact, the owner's policy, a service that did not
 * answer) and the reason in `problems` for the rest. An intent it cannot use (a slippage or a limit
 * outside the allowed range) is a usage error: exit 2.
 */
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

/** The store's record of earlier swaps, for a daily limit; none when the store keeps no such record. */
const spendsOf = (store: Partial<SpendLog>): SpendLog | undefined =>
  store.spentSince && store.recordSpend ? store as SpendLog : undefined;
const isIntent = (v: unknown): v is Intent => {
  const i = v as Partial<Intent> | null;
  return !!i && [i.owner, i.inputMint, i.outputMint, i.amountIn].every(x => typeof x === 'string' && x.length > 0);
};
const INTENT_SHAPE = '{"owner", "inputMint", "outputMint", "amountIn"} (strings)';
/** Which dry-run approval holds for an intent: the same wallet, mints and amount. */
const approvalKeyOf = (i: Pick<Intent, 'owner' | 'inputMint' | 'outputMint' | 'amountIn'>) =>
  ({ owner: i.owner, inputMint: i.inputMint, outputMint: i.outputMint, amountIn: i.amountIn });
/** A wallet address, as Solana writes one. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The intent as the command uses it: Orientim's treasury only from the environment (ORIENTIM_TREASURY)
 * or the one pinned in the skill, never from the JSON; a JSON that names another is refused. A string
 * when the intent cannot be used.
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

/**
 * A service that did not answer, or answered that it is busy: Jupiter, your RPC or Orientim. Nothing
 * was signed or sent; the same request may be tried again later.
 */
function unavailable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === 'TimeoutError' || e.name === 'AbortError' || e.name === 'RpcUnavailableError'
    || (e instanceof TypeError && /fetch failed/i.test(e.message))
    // Your RPC answered 429 or 5xx: busy or down, not a verdict on the swap.
    || (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && [429, 500, 502, 503, 504].includes(Number(e.context.statusCode)))
    || /^Jupiter answered (429|5\d\d)\b/.test(e.message);
}
const unavailableRefusal = (e: unknown, sent?: false): CliResult => ({
  code: 1,
  output: {
    ok: false, ...(sent === false ? { sent } : {}), problems: [messageOf(e)],
    error: { code: 'unavailable', message: 'A service this needs did not answer, or is busy: `problems` names it. Nothing was sent; try again in a few seconds.', retryAfter: 5 },
  },
});
/** A store for the commands that keep nothing: any use of it is the error that made it. */
const unavailableStore = (e: unknown): PendingStore & OrderBook & SpendLog => {
  const fail = async (): Promise<never> => { throw e; };
  return { put: fail, remove: fail, list: fail, order: fail, recordOrder: fail, claimOrder: fail, spentSince: fail, recordSpend: fail };
};

/** The wallet that signed a kept transaction: its fee payer. */
function feePayerOf(signedTransaction: string): string | null {
  try {
    return getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(signedTransaction, 'base64')).messageBytes).staticAccounts[0] ?? null;
  } catch {
    return null;
  }
}

/** How long after it was recorded pending an order's transaction can surely no longer land: its blockhash lives about a minute. */
const ORDER_SETTLED_AFTER_MS = 10 * 60_000;

/**
 * `resolve` for an order recorded pending whose own swap record is gone (a power cut between the two
 * writes): settled by the chain's answer when your RPC has one, otherwise by yours, once the order was
 * recorded long enough ago that its transaction can no longer land.
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

/**
 * One contract for every command: `sent` says only what this call did, and `recoveryRequired` (every
 * exit 3) says whether anything may still be in flight from earlier: run `recover` before anything new.
 */
export async function runCli(command: string, input: unknown, deps: CliDeps): Promise<CliResult> {
  const result = await runCommand(command, input, deps);
  return result.code === 3 ? { code: 3, output: { ...result.output, recoveryRequired: true } } : result;
}

async function runCommand(command: string, input: unknown, deps: CliDeps): Promise<CliResult> {
  const body = (input ?? {}) as Record<string, unknown>;
  // A state directory that cannot be made is an answer too, like one that cannot be read: exit 3, in
  // JSON, and nothing is prepared, sent or changed until it can (the check and the key commands keep none).
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
      // The owner's limits hold here too, counted against the swaps this state directory kept.
      if (deps.policy) await checkPolicy(deps.policy, intent, spendsOf(store));
      // The same floor as prepare: Jupiter's own price, whatever the intent says.
      if (intent.slippageBps === 'auto') return usage('check needs intent.slippageBps as the number of bps the swap was prepared with, not "auto".');
      const own = await ownFloor(intent, { rpc: deps.rpc, fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey, requestTimeoutMs: deps.requestTimeoutMs, policy: deps.policy });
      intent.minOut = own.minOut;
      // Without a tolerance of its own, the owner's ceiling (if any) is what the route is held to.
      if (own.slippageBps !== undefined) intent.slippageBps = own.slippageBps;
      const priceImpactBps = own.priceImpactBps;
      // A fee in SOL: never above the skill's own limit, whatever the intent says.
      await holdSolFee(intent, prepared, { fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey });
      const problems = await checkPrepared(prepared, intent, deps.rpc, { requestTimeoutMs: deps.requestTimeoutMs, slippageCeilingBps: deps.policy?.maxSlippageBps });
      if (problems.length && problems.every(isRpcFailure)) return unavailableRefusal(new Error(problems.join('; ')));
      return { code: problems.length ? 1 : 0, output: { ok: problems.length === 0, problems, yourFloor: intent.minOut, priceImpactBps } };
    } catch (e) {
      return refusal(e);
    }
  }

  if (command === 'recover') {
    // Every wallet whose swaps are kept here is locked while they are settled, as finalize locks it:
    // a recover never settles an order while a run from that wallet is taking it again.
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
      const { settled, unknown, bookkeepingErrors } = await recoverPending(store, deps.rpc, { pollMs: deps.pollMs, maxWaitMs: deps.maxWaitMs, orders: store, archive: deps.archive });
      // What stays kept (an unknown outcome, or a record that could not be updated) is settled again next time.
      const open = unknown.length > 0 || bookkeepingErrors.length > 0;
      return {
        code: open ? 3 : 0,
        output: {
          ok: !open, settled, unknown, ...(bookkeepingErrors.length ? { bookkeepingErrors } : {}),
          ...(unknown.length ? { next: 'Check each unknown signature before swapping again. One the network can no longer prove: look it up in a full history (an explorer), then `orientim-verify resolve`.' } : {}),
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
      // Another run from this wallet may be settling or sending this very swap: settle it later.
      return { code: 3, output: { ok: false, ...(e instanceof LockBusyError ? { busy: true } : {}), error: `${messageOf(e)} Nothing was changed; try again once it is done.` } };
    }
    try {
      const resolved = await resolvePending(store, deps.rpc, signature, outcome, { orders: store, requestTimeoutMs: deps.requestTimeoutMs });
      return { code: 0, output: { ok: true, ...resolved } };
    } catch (e) {
      return { code: 1, output: { ok: false, error: messageOf(e) } };
    } finally {
      release();
    }
  }

  // An API key for the bot's wallet: the bot signs the checked message itself (AGENT-API.md, "API access").
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
    // Every order has an id, the same on every retry, so that it is never swapped twice.
    if (typeof body.intent.id !== 'string' || !body.intent.id) {
      return usage('prepare needs intent.id: your order\'s own id, the same on every retry of that order, so that it is never swapped twice.');
    }
    const own = ownIntent(body.intent, deps);
    if (typeof own === 'string') return usage(own);
    // One swap per wallet at a time, and none while an earlier one from it could still land (a
    // record whose wallet cannot be read counts for every wallet).
    // A state directory that cannot be read is an answer too, not a stack trace.
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
      return { code: 3, output: { ok: false, pending, error: 'Earlier swaps are not settled yet: run `orientim-verify recover` first. Nothing was prepared.' } };
    }
    // The same order, asked again: said, not swapped twice.
    if (prior && (prior.state === 'confirmed' || prior.state === 'pending')) {
      return { code: 5, output: { ok: false, order: { id: orderId, ...prior }, error: prior.state === 'confirmed' ? 'This order already swapped. Nothing new was prepared.' : 'This order has a transaction that may still land: run `orientim-verify recover`. Nothing new was prepared.' } };
    }
    const { owner, ...rest } = own;
    try {
      // The owner's limits, before anything is asked of Orientim; finalize holds the swap to them again.
      if (deps.policy) await checkPolicy(deps.policy, own, spendsOf(store));
      // What the user approved after a dry run of this wallet, these mints and this amount: at least that minimum.
      rest.minOut = heldToApproval(keptApproval(deps.stateDir, approvalKeyOf(own)), rest.minOut);
      const checked = await prepareChecked({
        ...api, rpc: deps.rpc, owner, intent: rest,
        fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey, requestTimeoutMs: deps.requestTimeoutMs, policy: deps.policy,
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
    const checked = body.checked as Checked | undefined;
    const { signature, signedTransaction } = body as { signature?: unknown; signedTransaction?: unknown };
    if (!checked?.prepared || !isIntent(checked.intent) || (typeof signature !== 'string' && typeof signedTransaction !== 'string')) {
      return usage('finalize reads {"checked": <prepare\'s checked, unchanged>, "signature": "<base58>"} or {"checked": ..., "signedTransaction": "<base64>"}.');
    }
    // The order's id travels in checked: without it, nothing would keep this order from being swapped
    // twice, so an adapter that lost it is stopped here, before anything is sent.
    if (typeof checked.intent.id !== 'string' || !checked.intent.id) {
      return usage('finalize needs checked.intent.id, the order\'s id prepare was given: pass prepare\'s checked unchanged. Nothing was sent.');
    }
    const { prepared } = checked;
    // The wallet names the lock file: nothing but an address may reach a path.
    if (typeof prepared.wallet !== 'string' || !ADDRESS.test(prepared.wallet)) return usage('checked.prepared.wallet must be a wallet address.');
    const ownOrError = ownIntent(checked.intent, deps);
    if (typeof ownOrError === 'string') return usage(ownOrError);
    const intent: Intent = ownOrError;
    // The chain's answer is the result; a record that could not be updated is said beside it, with
    // the signature, never in its place.
    const settle = async (result: { signature: string; outcome: string; refusal?: string; cause?: string }, orderId: string | undefined, resumed: boolean): Promise<CliResult> => {
      let bookkeepingError: string | undefined;
      try {
        // Only this attempt's own order: a newer attempt that holds it is never written over.
        if (orderId) await settleOrder(store, orderId, { signature: result.signature, state: (result.outcome === 'unknown' ? 'pending' : result.outcome) as OrderRecord['state'] });
        if (result.outcome !== 'unknown') await store.remove(result.signature);
        // A swap that landed uses the user's approval up; one that failed or expired keeps it until it expires.
        if (result.outcome === 'confirmed') forgetApproval(deps.stateDir, approvalKeyOf({ ...intent, owner: prepared.wallet }));
      } catch (e) {
        bookkeepingError = messageOf(e);
      }
      // What arrived, read from the chain; never a reason to fail.
      const received = result.outcome === 'confirmed'
        ? await receivedFor(deps.rpc, result.signature, prepared, { requestTimeoutMs: deps.requestTimeoutMs, pollMs: deps.pollMs })
        : null;
      return {
        // The example's own rule: a confirmed swap whose record could not be updated is 3, settle first.
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
    // The same swap asked again (the same signature) is its own record, not another swap.
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
        // The state directory cannot be written: nothing was kept, so nothing was sent by this run.
        return { code: 3, output: { ok: false, sent: false, error: `${messageOf(e)}` } };
      }
      // Another run from this wallet holds the lock: one still running, or one stopped on another
      // machine (a stopped process on this one gives its lock up). That run may be sending this very
      // transaction, or already sent it, so this is never "not sent": unknown, settled by `recover` (exit 3).
      return {
        code: 3,
        output: {
          ok: false, busy: true, ...(incoming ? { signature: incoming } : {}), outcome: 'unknown',
          error: `${messageOf(e)} That run may have sent this swap: wait for it, then run \`orientim-verify recover\` before anything new.`,
        },
      };
    }
    // Once kept before finalize, the swap may have been sent: from then on an error is not "not sent".
    let signedAs: string | null = null;
    try {
      // A swap already kept under this signature may have been sent: it is asked again and settled,
      // never checked as a first send, and the answer always carries its signature. What is kept must
      // be read to know that: a store that cannot be read is an unknown outcome, never "not sent".
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
            error: `The kept swaps could not be read: ${messageOf(e)}. An earlier run may have sent this swap; fix the state directory, then run \`orientim-verify recover\`.`,
          },
        };
      }
      if (kept) {
        signedAs = kept.signature;
        const result = await resumeSigned({
          ...api, rpc: deps.rpc, signed: kept, fetchImpl: deps.fetchImpl, pollMs: deps.pollMs, maxWaitMs: deps.maxWaitMs, requestTimeoutMs: deps.requestTimeoutMs,
          archive: deps.archive,
        });
        return settle(result, kept.intentId ?? intent.id, true);
      }
      // Its order says it is this very transaction, but the swap's own record is gone: it may have landed.
      if (recorded && recorded.signature === incoming) {
        return {
          code: recorded.state === 'confirmed' ? 0 : recorded.state === 'pending' ? 3 : 1,
          output: {
            ok: recorded.state === 'confirmed', signature: incoming, outcome: recorded.state === 'pending' ? 'unknown' : recorded.state, recorded: true,
            ...(recorded.state === 'pending' ? { error: 'This transaction is recorded pending for its order, but its own record is gone: check its signature before anything new.' } : {}),
          },
        };
      }
      // One swap per wallet: another that may still land stops this one before anything is sent,
      // whichever order it was prepared for.
      if (waiting.length) {
        return { code: 3, output: { ok: false, sent: false, pending: waiting, error: 'An earlier swap from this wallet may still land: run `orientim-verify recover` first. Nothing was sent.' } };
      }
      // Checked again here, on your RPC, as for a first check: finalize takes nothing on trust, not
      // even prepare's output. The floor is held to Jupiter's own price and the hard limits again,
      // and a fee in SOL to the skill's own limit, and to what the user approved after a dry run.
      intent.minOut = heldToApproval(keptApproval(deps.stateDir, approvalKeyOf({ ...intent, owner: prepared.wallet })), intent.minOut);
      if (intent.slippageBps === 'auto') return { code: 2, output: { ok: false, sent: false, error: 'finalize needs checked.intent.slippageBps as prepare returned it, a number, not "auto". Nothing was sent.' } };
      const own = await ownFloor(intent, { rpc: deps.rpc, fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey, requestTimeoutMs: deps.requestTimeoutMs, policy: deps.policy });
      intent.minOut = own.minOut;
      if (own.slippageBps !== undefined) intent.slippageBps = own.slippageBps;
      await holdSolFee(intent, prepared, { fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey });
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
        // Kept on disk before finalize: if this process stops, `recover` settles it first. The swap is
        // kept before the order is taken, as the example does, so a run that stops between the two
        // leaves a kept swap `recover` settles, never an order pending with nothing kept. The order is
        // taken atomically, new or retried, so two runs cannot both send it.
        onSigned: async s => {
          const others = await pendingFor(store, prepared.wallet, s.signature);
          if (others.length) throw new PendingSwapError(others);
          // The owner's limits again, under the wallet's lock, with what the last 24 hours spent; the
          // swap counts from here, before it is kept, since once kept it may be sent. Every swap is
          // recorded, with a policy or without, so that a daily limit set later counts it too. A swap
          // refused before it is kept was never sent, and its spend is taken back.
          const spends = spendsOf(store);
          if (deps.policy) await checkPolicy(deps.policy, { owner: prepared.wallet, inputMint: intent.inputMint, amountIn: intent.amountIn }, spends, s.signature);
          await spends?.recordSpend({ signature: s.signature, owner: prepared.wallet, mint: intent.inputMint, amountIn: intent.amountIn, at: Date.now() });
          try {
            const orderId = intent.id;
            await store.put({ ...s, ...(orderId ? { intentId: orderId } : {}) });
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
      // After the swap was kept it may have been sent: its signature and an unknown outcome, never
      // "not sent". Before that, nothing was sent.
      if (signedAs) return { code: 3, output: { ok: false, signature: signedAs, outcome: 'unknown', error: messageOf(e) } };
      if (e instanceof PendingSwapError) return { code: 3, output: { ok: false, sent: false, pending: e.signatures, error: e.message } };
      // This order already swapped, or another run has it (and may be sending it): never a reason to
      // try the same order under a new id.
      if (e instanceof OrientimOrderError) {
        return {
          code: 5,
          output: {
            ok: false, sent: false, order: { id: e.id, ...e.record },
            error: e.record.state === 'confirmed' ? `Order ${e.id} already swapped (${e.record.signature}). This run sent nothing.`
              : e.record.state === 'pending' ? `Order ${e.id} has a transaction that may still land (${e.record.signature}): run \`orientim-verify recover\`. This run sent nothing.`
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

export async function main(): Promise<void> {
  const command = process.argv[2] ?? '';
  const print = (r: CliResult) => {
    process.stdout.write(`${JSON.stringify(r.output, null, 2)}\n`);
    process.exitCode = r.code;
  };
  if (!(COMMANDS as readonly string[]).includes(command)) return print(usage(`usage: orientim-verify <${COMMANDS.join('|')}> < input.json`));
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl && !KEY_COMMANDS.includes(command)) return print(usage('Set SOLANA_RPC_URL to your own RPC.'));
  // Only the commands that ask Jupiter for a price.
  if (!process.env.JUPITER_API_KEY && (command === 'prepare' || command === 'check' || command === 'finalize')) {
    process.stderr.write('JUPITER_API_KEY is not set: Jupiter throttles keyless calls, and your own floor may not be priced.\n');
  }
  // The owner's limits: a policy named but unreadable stops everything but settling what is kept.
  let policy: OwnerPolicy | undefined;
  if (process.env.ORIENTIM_POLICY && !KEY_COMMANDS.includes(command)) {
    try {
      policy = loadPolicy(process.env.ORIENTIM_POLICY);
    } catch (e) {
      if (command !== 'recover' && command !== 'resolve') return print(usage(messageOf(e)));
    }
  }
  // The state directory: the policy's own when it names one, and absolute when it sets a daily limit.
  const given = process.env.ORIENTIM_STATE_DIR || undefined;
  let stateDir: string;
  try {
    const chosen = stateDirFor(policy, given);
    stateDir = chosen.dir;
    if (chosen.warning && !KEY_COMMANDS.includes(command)) process.stderr.write(`${chosen.warning}\n`);
  } catch (e) {
    // Settling what is kept never waits on a policy's rule about where new swaps are kept.
    if (command !== 'recover' && command !== 'resolve') return print(usage(messageOf(e)));
    stateDir = policy?.stateDir ?? given ?? DEFAULT_STATE_DIR;
  }
  // Told to stop (a bot's timeout, Ctrl-C): the lock goes at once. What was kept before finalize is
  // on disk, and `recover` settles it.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      releaseHeldLocks();
      process.exit(signal === 'SIGTERM' ? 143 : 130);
    });
  }
  let input: unknown = {};
  if (command !== 'recover') {
    try {
      input = JSON.parse(await readStdin());
    } catch {
      return print(usage('The input on stdin is not JSON.'));
    }
  }
  print(await runCli(command, input, {
    // The key commands read nothing from a chain.
    rpc: createSolanaRpc(rpcUrl ?? 'http://127.0.0.1:1'),
    ...(process.env.ORIENTIM_ARCHIVE_RPC_URL ? { archive: createSolanaRpc(process.env.ORIENTIM_ARCHIVE_RPC_URL) } : {}),
    apiUrl: process.env.ORIENTIM_API_URL,
    apiKey: process.env.ORIENTIM_API_KEY,
    jupiterApiKey: process.env.JUPITER_API_KEY || undefined,
    stateDir,
    treasury: process.env.ORIENTIM_TREASURY || undefined,
    policy,
  }));
}
