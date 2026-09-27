/**
 * `orientim-verify`: Orientim's protected swap for bots in any language (Python, Rust, Go...). The bot
 * keeps its key and signs one message itself; this command does everything else the example does,
 * the same code: your own floor, the full check on your RPC, the durable record before finalize,
 * finalize, and the outcome read on the chain for the wallet's own signature. JSON in (stdin), JSON
 * out (stdout), and an exit code:
 *
 *   orientim-verify prepare    {"intent": {...}}                       0 ok: sign `message`   1 refused   3 settle first   4 Orientim said no
 *   orientim-verify finalize   {"checked": ..., "signature": "..."}    0 confirmed   1 not swapped   3 unknown: recover before anything new
 *   orientim-verify recover                                            0 all settled   3 something is still unknown
 *   orientim-verify resolve    {"signature": "...", "outcome": "..."}  0 settled   1 refused (it could still land, or is not kept)
 *   3 also when the state directory cannot be made or read: nothing is prepared or changed until it can,
 *   and from finalize when another run from the wallet holds its lock (that run may have sent the swap).
 *   orientim-verify check      {"prepared": ..., "intent": {...}}      0 safe to sign   1 refused   (for bots that call the API themselves)
 *   orientim-verify key-challenge  {"wallet": "<address>"}             0 sign `message` (checked: Orientim's key message for this wallet, nothing else)
 *   orientim-verify key        {"message", "challenge", "signature"}   0 `key`, bound to that wallet   4 Orientim said no
 *   2 on any usage or configuration error; 5 when `intent.id` names an order that already swapped or
 *   whose transaction may still land (the same order is never swapped twice).
 *
 * Finalize asked again for a swap it already kept (the same signature) is not a new send: it asks
 * Orientim once more for the same bytes and reads the chain, and always answers with that signature and
 * its outcome. `resolve` settles by hand, after you looked it up in a full history
 * (an explorer), a kept swap whose outcome the chain can no longer prove: `outcome` is `confirmed`,
 * `failed` or `expired`; the chain's own answer is used instead whenever your RPC still has one.
 *
 * `intent` is the example's `Intent`: owner, inputMint, outputMint, amountIn (base units, strings),
 * and optionally slippageBps, maxPriceImpactBps, minOut, maxFeeBps, maxNetworkFeeLamports, maxRouteCostLamports,
 * maxSolFeeLamports, acceptCostBps, version. `prepare` answers `checked` (pass it to finalize unchanged) and `message`,
 * the transaction's message in base64: sign those bytes with the wallet's ed25519 key and pass the
 * 64-byte signature to finalize in base58 as `signature`, or the whole signed transaction in base64
 * as `signedTransaction`. Finalize checks everything again before anything is sent.
 *
 * Environment: SOLANA_RPC_URL (your own RPC; always), ORIENTIM_API_URL and ORIENTIM_API_KEY (prepare,
 * finalize), JUPITER_API_KEY (Jupiter throttles keyless calls), ORIENTIM_STATE_DIR (default ./.orientim-state; an
 * absolute path on a disk that outlives the process), ORIENTIM_TREASURY (only for another Orientim deployment),
 * ORIENTIM_POLICY (the owner's limits per swap and per day, a JSON file: see `OwnerPolicy`; a swap outside
 * them exits 1 with `error.code` `mint-not-allowed`, `amount-over-limit` or `daily-limit`).
 * Finalize can take minutes (it reads the outcome on the chain): a run that is stopped anyway is settled
 * by `recover` before anything new.
 */
import { createSolanaRpc, getBase58Encoder, getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import type { Address, Rpc, SignatureBytes, SolanaRpcApi } from '@solana/kit';
import {
  acquireLock, apiKeyChallenge, OrientimApiError, checkPrepared, createFileStore, finalizeSigned, isApiKeyMessage, pendingFor, PendingSwapError,
  prepareChecked, PriceImpactError, FloorError, ownFloor, receivedFor, recoverPending, redeemApiKey, resolvePending, resumeSigned, takeOrder,
  checkPolicy, loadPolicy, PolicyError,
} from '../examples/swap.ts';
import type { Checked, Intent, OrderBook, OrderRecord, OwnerPolicy, PendingStore, Prepared, SpendLog } from '../examples/swap.ts';
import { ownSolFeeLimit } from '../lib/orientim-verify.mjs';

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
  store?: PendingStore & OrderBook & Partial<SpendLog>;
  /** The owner's limits (`ORIENTIM_POLICY`): per swap and per day, whatever the intent says. */
  policy?: OwnerPolicy;
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
/** The store's record of earlier swaps, for a daily limit; none when the store keeps no such record. */
const spendsOf = (store: Partial<SpendLog>): SpendLog | undefined =>
  store.spentSince && store.recordSpend ? store as SpendLog : undefined;
const isIntent = (v: unknown): v is Intent => {
  const i = v as Partial<Intent> | null;
  return !!i && [i.owner, i.inputMint, i.outputMint, i.amountIn].every(x => typeof x === 'string' && x.length > 0);
};
const INTENT_SHAPE = '{"owner", "inputMint", "outputMint", "amountIn"} (strings)';
/** A store for the commands that keep nothing: any use of it is the error that made it. */
const unavailableStore = (e: unknown): PendingStore & OrderBook & SpendLog => {
  const fail = async (): Promise<never> => { throw e; };
  return { put: fail, remove: fail, list: fail, order: fail, recordOrder: fail, claimOrder: fail, spentSince: fail, recordSpend: fail };
};

export async function runCli(command: string, input: unknown, deps: CliDeps): Promise<CliResult> {
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
    const intent: Intent = { ...(deps.treasury ? { treasury: deps.treasury } : {}), ...body.intent };
    try {
      // The owner's limits hold here too; a bot that calls the API itself counts its own spending.
      if (deps.policy) await checkPolicy(deps.policy, intent, spendsOf(store));
      // The same floor as prepare: Jupiter's own price, whatever the intent says.
      const own = await ownFloor(intent, { rpc: deps.rpc, fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey, requestTimeoutMs: deps.requestTimeoutMs });
      intent.minOut = own.minOut;
      const priceImpactBps = own.priceImpactBps;
      if ((prepared.policy as { feeSide?: unknown }).feeSide === 'sol' && intent.maxSolFeeLamports === undefined) {
        intent.maxSolFeeLamports = await ownSolFeeLimit({
          inputMint: intent.inputMint, amountIn: intent.amountIn, taker: intent.owner, maxFeeBps: intent.maxFeeBps, apiKey: deps.jupiterApiKey, fetchImpl: deps.fetchImpl,
        });
      }
      const problems = await checkPrepared(prepared, intent, deps.rpc, { requestTimeoutMs: deps.requestTimeoutMs });
      return { code: problems.length ? 1 : 0, output: { ok: problems.length === 0, problems, yourFloor: intent.minOut, priceImpactBps } };
    } catch (e) {
      if (e instanceof PolicyError) return policyRefusal(e);
      return { code: 1, output: { ok: false, problems: [messageOf(e)] } };
    }
  }

  if (command === 'recover') {
    try {
      const { settled, unknown, bookkeepingErrors } = await recoverPending(store, deps.rpc, { pollMs: deps.pollMs, maxWaitMs: deps.maxWaitMs, orders: store });
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
    if (!kept) return { code: 1, output: { ok: false, error: `No kept swap has the signature ${signature}. Nothing was changed.` } };
    let release: () => void;
    try {
      release = acquireLock(deps.stateDir, kept.owner ?? 'unknown-wallet');
    } catch (e) {
      return { code: 1, output: { ok: false, error: messageOf(e) } };
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
      if (e instanceof OrientimApiError) return { code: 4, output: { ok: false, error: e.message, status: e.status, code: e.code } };
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
    // One swap at a time, and none while an earlier one could still land.
    // A state directory that cannot be read is an answer too, not a stack trace (Stage 2 re-run, E5).
    const orderId = body.intent.id;
    let pending: string[];
    let prior: OrderRecord | null;
    try {
      pending = (await store.list()).map(s => s.signature);
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
    const { owner, ...rest } = body.intent;
    try {
      // The owner's limits, before anything is asked of Orientim; finalize holds the swap to them again.
      if (deps.policy) await checkPolicy(deps.policy, body.intent, spendsOf(store));
      const checked = await prepareChecked({
        ...api, rpc: deps.rpc, owner, intent: { ...(deps.treasury ? { treasury: deps.treasury } : {}), ...rest },
        fetchImpl: deps.fetchImpl, jupiterApiKey: deps.jupiterApiKey, requestTimeoutMs: deps.requestTimeoutMs,
      });
      const tx = getTransactionDecoder().decode(Buffer.from(checked.prepared.transaction, 'base64'));
      return {
        code: 0,
        output: {
          ok: true, checked, message: Buffer.from(tx.messageBytes).toString('base64'),
          amounts: checked.prepared.amounts, costs: checked.prepared.costs, lastValidBlockHeight: checked.prepared.lastValidBlockHeight,
          notices: checked.notices ?? [],
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
      if (e instanceof FloorError) {
        return { code: 1, output: { ok: false, error: { code: 'floor-too-low', message: e.message, minOut: e.minOut, lowest: e.lowest } } };
      }
      if (e instanceof PriceImpactError) {
        return { code: 1, output: { ok: false, error: { code: 'price-impact-high', message: e.message, impactBps: e.impactBps, limitBps: e.limitBps } } };
      }
      if (e instanceof PolicyError) return policyRefusal(e);
      return { code: 1, output: { ok: false, problems: [messageOf(e)] } };
    }
  }

  if (command === 'finalize') {
    const checked = body.checked as Checked | undefined;
    const { signature, signedTransaction } = body as { signature?: unknown; signedTransaction?: unknown };
    if (!checked?.prepared || !isIntent(checked.intent) || (typeof signature !== 'string' && typeof signedTransaction !== 'string')) {
      return usage('finalize reads {"checked": <prepare\'s checked, unchanged>, "signature": "<base58>"} or {"checked": ..., "signedTransaction": "<base64>"}.');
    }
    const { prepared, intent } = checked;
    // The chain's answer is the result; a record that could not be updated is said beside it, with
    // the signature, never in its place.
    const settle = async (result: { signature: string; outcome: string; refusal?: string }, orderId: string | undefined, resumed: boolean): Promise<CliResult> => {
      let bookkeepingError: string | undefined;
      try {
        if (orderId) await store.recordOrder(orderId, { signature: result.signature, state: (result.outcome === 'unknown' ? 'pending' : result.outcome) as OrderRecord['state'] });
        if (result.outcome !== 'unknown') await store.remove(result.signature);
      } catch (e) {
        bookkeepingError = messageOf(e);
      }
      // What arrived, read from the chain, as the page reports it; never a reason to fail.
      const received = result.outcome === 'confirmed'
        ? await receivedFor(deps.rpc, result.signature, prepared, { requestTimeoutMs: deps.requestTimeoutMs, pollMs: deps.pollMs })
        : null;
      return {
        code: result.outcome === 'confirmed' ? 0 : result.outcome === 'unknown' ? 3 : 1,
        output: {
          ok: result.outcome === 'confirmed', signature: result.signature, outcome: result.outcome,
          ...(result.refusal ? { refusal: result.refusal } : {}), amounts: prepared.amounts,
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
      // Another run from this wallet holds the lock: one still running, or one a bot's timeout killed
      // (its lock stays until it is stale). That run may be sending this very transaction, or already
      // sent it, so this is never "not sent": unknown, settled by `recover` (exit 3).
      return {
        code: 3,
        output: {
          ok: false, busy: true, ...(incoming ? { signature: incoming } : {}), outcome: 'unknown',
          error: `${messageOf(e)} That run may have sent this swap: run \`orientim-verify recover\` before anything new.`,
        },
      };
    }
    // Once kept before finalize, the swap may have been sent: from then on an error is not "not sent".
    let signedAs: string | null = null;
    try {
      // Checked again here, on your RPC: finalize takes nothing on trust, not even prepare's output.
      // One swap per wallet: another that may still land stops this one before anything is sent,
      // whichever order it was prepared for.
      // A swap already kept under this signature may have been sent: it is asked again and settled,
      // never checked as a first send, and the answer always carries its signature.
      const kept = incoming ? (await store.list()).find(s => s.signature === incoming) : undefined;
      if (kept) {
        signedAs = kept.signature;
        const result = await resumeSigned({
          ...api, rpc: deps.rpc, signed: kept, fetchImpl: deps.fetchImpl, pollMs: deps.pollMs, maxWaitMs: deps.maxWaitMs, requestTimeoutMs: deps.requestTimeoutMs,
        });
        return settle(result, kept.intentId ?? intent.id, true);
      }
      // Its order says it is this very transaction, but the swap's own record is gone: it may have landed.
      const recorded = intent.id && incoming ? await store.order(intent.id) : null;
      if (recorded && recorded.signature === incoming) {
        return {
          code: recorded.state === 'confirmed' ? 0 : recorded.state === 'pending' ? 3 : 1,
          output: {
            ok: recorded.state === 'confirmed', signature: incoming, outcome: recorded.state === 'pending' ? 'unknown' : recorded.state, recorded: true,
            ...(recorded.state === 'pending' ? { error: 'This transaction is recorded pending for its order, but its own record is gone: check its signature before anything new.' } : {}),
          },
        };
      }
      const waiting = await pendingFor(store, prepared.wallet, incoming);
      if (waiting.length) {
        return { code: 3, output: { ok: false, sent: false, pending: waiting, error: 'An earlier swap from this wallet may still land: run `orientim-verify recover` first. Nothing was sent.' } };
      }
      const problems = await checkPrepared(prepared, intent, deps.rpc, { requestTimeoutMs: deps.requestTimeoutMs });
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
        pollMs: deps.pollMs, maxWaitMs: deps.maxWaitMs, requestTimeoutMs: deps.requestTimeoutMs,
        // Kept on disk before finalize: if this process stops, `recover` settles it first. The swap is
        // kept before the order is taken, as the example does, so a run that stops between the two
        // leaves a kept swap `recover` settles, never an order pending with nothing kept. The order is
        // taken atomically, new or retried, so two runs cannot both send it.
        onSigned: async s => {
          const others = await pendingFor(store, prepared.wallet, s.signature);
          if (others.length) throw new PendingSwapError(others);
          // The owner's limits again, under the wallet's lock, with what the last 24 hours spent; the
          // swap counts from here, before it is kept, since once kept it may be sent.
          if (deps.policy) {
            const spends = spendsOf(store);
            await checkPolicy(deps.policy, { owner: prepared.wallet, inputMint: intent.inputMint, amountIn: intent.amountIn }, spends, s.signature);
            await spends?.recordSpend({ signature: s.signature, owner: prepared.wallet, mint: intent.inputMint, amountIn: intent.amountIn, at: Date.now() });
          }
          const orderId = intent.id;
          await store.put({ ...s, ...(orderId ? { intentId: orderId } : {}) });
          if (orderId) {
            const record: OrderRecord = { signature: s.signature, state: 'pending' };
            const prior = await store.order(orderId);
            const open = prior && (prior.state === 'confirmed' || prior.state === 'pending');
            if (open || !await takeOrder(store, orderId, prior, record)) {
              await store.remove(s.signature);
              throw new Error(open ? `Order ${orderId} is already ${prior!.state} (${prior!.signature}).` : `Order ${orderId} was taken by another run, or this order book cannot retry it safely.`);
            }
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
      if (e instanceof PolicyError) return policyRefusal(e, false);
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
  if (!process.env.JUPITER_API_KEY && command !== 'recover' && !KEY_COMMANDS.includes(command)) {
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
    apiUrl: process.env.ORIENTIM_API_URL,
    apiKey: process.env.ORIENTIM_API_KEY,
    jupiterApiKey: process.env.JUPITER_API_KEY || undefined,
    stateDir: process.env.ORIENTIM_STATE_DIR || '.orientim-state',
    treasury: process.env.ORIENTIM_TREASURY || undefined,
    policy,
  }));
}
