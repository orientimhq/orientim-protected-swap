import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  fetchAddressesForLookupTables,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from '@solana/kit';
import type { Address, KeyPairSigner, Rpc, SolanaRpcApi, Transaction } from '@solana/kit';
import type { AccountState, ChainSnapshot } from '@orientimhq/core';

/** A Solana JSON-RPC client. */
export type SolanaRpc = Rpc<SolanaRpcApi>;

/** The HTTP status of a failed RPC call, read from the error context since production builds strip messages. */
export function httpStatusOf(e: unknown): number | null {
  if (!isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return null;
  return (e.context as { statusCode?: number }).statusCode ?? null;
}

type Transport = ReturnType<typeof createDefaultRpcTransport>;

/**
 * Retries HTTP 429 responses with jittered exponential backoff. `sendTransaction` is never retried:
 * a 429 may follow a forwarded send, and only the sender can decide whether to re-broadcast.
 */
export function retryingTransport(transport: Transport, maxRetries = 5, baseMs = 500, timeoutMs = 20_000): Transport {
  return (async (config: Parameters<Transport>[0]) => {
    const method = (config as { payload?: { method?: unknown } }).payload?.method;
    const own = (config as { signal?: AbortSignal }).signal;
    for (let attempt = 0; ; attempt++) {
      try {
        // Bound every request by `timeoutMs` as well as the caller's signal.
        const limit = AbortSignal.timeout(timeoutMs);
        const signal = own && typeof AbortSignal.any === 'function' ? AbortSignal.any([own, limit]) : own ?? limit;
        return await transport({ ...config, signal } as Parameters<Transport>[0]);
      } catch (e) {
        if (attempt >= maxRetries || httpStatusOf(e) !== 429 || method === 'sendTransaction') throw e;
        // The caller's signal also cuts the backoff short.
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer);
            own?.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, baseMs * 2 ** attempt * (0.5 + Math.random()));
          own?.addEventListener('abort', done, { once: true });
        });
        if (own?.aborted) throw e;
      }
    }
  }) as Transport;
}

/** An RPC client that retries rate-limited reads and simulations, but never sends. */
export function createRetryingRpc(url: string, maxRetries = 5): SolanaRpc {
  const transport = createDefaultRpcTransport({ url: url as `https://${string}` });
  return createSolanaRpcFromTransport(retryingTransport(transport, maxRetries)) as unknown as SolanaRpc;
}

const MAX_ACCOUNTS_PER_CALL = 100;

const decodeBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** Reads accounts in batches; a missing account maps to null. */
export async function fetchAccounts(rpc: SolanaRpc, addresses: readonly Address[]): Promise<Map<string, AccountState | null>> {
  return (await readAccounts(rpc, addresses)).accounts;
}

/** Retries `read` for about 4.5 s while the node is behind `minContextSlot`. */
export async function notOlderThan<T>(read: () => Promise<T>, minContextSlot: bigint | undefined): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (e) {
      if (minContextSlot === undefined || attempt >= 5 || !isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED)) throw e;
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

/**
 * Reads accounts in batches and returns the oldest slot answered. Every batch is held to
 * `minContextSlot`, or else to the first batch's slot, so a snapshot never mixes older state.
 */
export async function readAccounts(
  rpc: SolanaRpc,
  addresses: readonly Address[],
  opts: { minContextSlot?: bigint; timeoutMs?: number } = {},
): Promise<{ accounts: Map<string, AccountState | null>; slot: bigint }> {
  const unique = [...new Set(addresses)];
  const out = new Map<string, AccountState | null>();
  let slot = 0n;
  let floor = opts.minContextSlot;
  for (let i = 0; i < unique.length; i += MAX_ACCOUNTS_PER_CALL) {
    const batch = unique.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    const atLeast = floor;
    const { context, value } = await notOlderThan(() => rpc.getMultipleAccounts(batch, {
      encoding: 'base64', commitment: 'confirmed', ...(atLeast !== undefined ? { minContextSlot: atLeast } : {}),
    }).send(opts.timeoutMs ? { abortSignal: AbortSignal.timeout(opts.timeoutMs) } : undefined), atLeast);
    // Track the oldest slot; an RPC that omits the context leaves it at zero.
    const at = BigInt(context?.slot ?? 0);
    slot = slot === 0n || (at !== 0n && at < slot) ? at : slot;
    if (floor === undefined && at > 0n) floor = at;
    value.forEach((acc, j) => {
      out.set(batch[j], acc ? { owner: acc.owner, lamports: acc.lamports, data: decodeBase64(acc.data[0]) } : null);
    });
  }
  return { accounts: out, slot };
}

/** Reads the verifier's snapshot from the RPC, with accounts and lookup tables at least `minContextSlot` recent. */
export async function fetchSnapshot(args: {
  rpc: SolanaRpc;
  addresses: readonly Address[];
  lookupTableAddresses: readonly Address[];
  minContextSlot?: bigint;
}): Promise<ChainSnapshot> {
  const [{ accounts, slot }, lookupTables] = await Promise.all([
    readAccounts(args.rpc, args.addresses, { minContextSlot: args.minContextSlot }),
    args.lookupTableAddresses.length
      ? notOlderThan(() => fetchAddressesForLookupTables([...args.lookupTableAddresses], args.rpc, {
        ...(args.minContextSlot !== undefined ? { minContextSlot: args.minContextSlot } : {}),
      }), args.minContextSlot) as Promise<Record<string, readonly Address[]>>
      : Promise.resolve({} as Record<string, readonly Address[]>),
  ]);
  return { accounts, lookupTables, slot };
}

/** Basic facts about a mint account. */
export type MintInfo = { exists: boolean; program: Address | null; decimals: number; freezeAuthority: boolean; mintAuthority: boolean };

/** Decodes a mint account; `exists` is false when missing or too short. */
export function mintInfoOf(s: AccountState | null | undefined): MintInfo {
  if (!s || s.data.length < 82) return { exists: false, program: null, decimals: 0, freezeAuthority: false, mintAuthority: false };
  const view = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength);
  return {
    exists: true,
    program: s.owner,
    decimals: s.data[44],
    mintAuthority: view.getUint32(0, true) === 1,
    freezeAuthority: view.getUint32(46, true) === 1,
  };
}

/** Reads and decodes several mints. */
export async function fetchMints(rpc: SolanaRpc, mints: readonly Address[]): Promise<Map<string, MintInfo>> {
  const states = await fetchAccounts(rpc, mints);
  return new Map(mints.map(m => [m, mintInfoOf(states.get(m))]));
}

const INFRA = new Set([
  '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'ComputeBudget111111111111111111111111111111',
]);

/** The innermost non-infrastructure program on the stack when a simulation failed, else the failing program. */
export function blameProgram(logs: readonly string[]): string | null {
  const stack: string[] = [];
  for (const line of logs) {
    let m = line.match(/^Program (\w+) invoke \[(\d+)\]/);
    if (m) { stack.length = Number(m[2]) - 1; stack.push(m[1]); continue; }
    m = line.match(/^Program (\w+) failed/);
    if (m) return [...stack].reverse().find(p => !INFRA.has(p)) ?? m[1];
    if (/^Program \w+ success/.test(line)) stack.pop();
  }
  return null;
}

/** Whether a program is system, token, ATA, compute budget or Jupiter. */
export const isInfrastructureProgram = (programId: string) => INFRA.has(programId);

function failedInstructionOf(err: unknown): number | null {
  const ie = (err as { InstructionError?: [number | bigint, unknown] } | null)?.InstructionError;
  return ie ? Number(ie[0]) : null;
}

/** The result of `simulate`. */
export type Simulation = {
  ok: boolean;
  error: string | null;
  units: number;
  logs: string[];
  blame: string | null;
  /** Index of the instruction that failed, when the error names one. */
  failedInstruction: number | null;
  /** Lamports of each watched account afterwards; 0 when closed. */
  lamportsAfter: bigint[];
  /** Data size of each watched account afterwards; 0 when closed. */
  sizesAfter: number[];
  /** The slot the simulation ran at, or 0 when unreported. */
  slot: bigint;
  /** Post-balances by address when `balances` was requested; empty otherwise. */
  balancesAfter: Map<string, bigint>;
};

/**
 * A transaction's accounts in runtime order (static, then lookup writable, then read-only), matching
 * `postBalances`. Null when a table is missing or an index is out of range.
 */
export function accountKeysOf(
  transaction: Transaction, lookupTables: Readonly<Record<string, readonly Address[]>>,
): { keys: Address[]; writable: Address[]; readonly: Address[] } | null {
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes) as unknown as {
    staticAccounts: readonly Address[];
    addressTableLookups?: readonly { lookupTableAddress: Address; writableIndexes: readonly number[]; readonlyIndexes: readonly number[] }[];
  };
  const lookups = compiled.addressTableLookups ?? [];
  const load = (pick: (l: (typeof lookups)[number]) => readonly number[]) => {
    const out: Address[] = [];
    for (const l of lookups) {
      const table = lookupTables[l.lookupTableAddress];
      if (!table) return null;
      for (const i of pick(l)) {
        if (i >= table.length) return null;
        out.push(table[i]);
      }
    }
    return out;
  };
  const writable = load(l => l.writableIndexes);
  const readonly = load(l => l.readonlyIndexes);
  if (!writable || !readonly) return null;
  return { keys: [...compiled.staticAccounts, ...writable, ...readonly], writable, readonly };
}

type SimulatedBalances = {
  postBalances?: readonly (bigint | number)[] | null;
  loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null;
};

/** Lamports per account from a simulation's `postBalances`, or the reason they cannot be trusted. */
export function balancesAfterSimulation(
  transaction: Transaction, value: SimulatedBalances, lookupTables: Readonly<Record<string, readonly Address[]>>,
): Map<string, bigint> | string {
  const order = accountKeysOf(transaction, lookupTables);
  if (!order) return 'the transaction names a lookup table entry that could not be read';
  const post = value.postBalances;
  if (!Array.isArray(post)) return 'the RPC did not report the balances after the transaction';
  if (post.length !== order.keys.length) return `the RPC reported ${post.length} balances for ${order.keys.length} accounts`;
  if (order.writable.length || order.readonly.length) {
    const loaded = value.loadedAddresses;
    const same = (a: readonly string[] | undefined, b: readonly string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
    if (!loaded || !same(loaded.writable, order.writable) || !same(loaded.readonly, order.readonly)) {
      return 'the RPC loaded other accounts from the lookup tables than the tables hold';
    }
  }
  const out = new Map<string, bigint>();
  for (const [i, a] of order.keys.entries()) {
    const b = post[i];
    if (typeof b !== 'bigint' && typeof b !== 'number') return 'the RPC reported a balance that is not a number';
    out.set(a, BigInt(b));
  }
  return out;
}

/** Bytes in a base64 string, without decoding it. */
const base64Size = (s: string | undefined) =>
  s ? (s.length * 3) / 4 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0) : 0;

/** Simulates a transaction. This shows whether it executes, never whether it is safe. */
export async function simulate(
  rpc: SolanaRpc,
  transaction: Transaction,
  watch: readonly Address[] = [],
  opts: {
    minContextSlot?: bigint;
    /** Fill `balancesAfter` from `postBalances`. */
    balances?: { lookupTables: Readonly<Record<string, readonly Address[]>> };
  } = {},
): Promise<Simulation> {
  const { context, value } = await notOlderThan(() => rpc
    .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
      ...(watch.length ? { accounts: { addresses: [...watch], encoding: 'base64' as const } } : {}),
      ...(opts.minContextSlot !== undefined ? { minContextSlot: opts.minContextSlot } : {}),
    })
    .send(), opts.minContextSlot);
  const logs = [...(value.logs ?? [])];
  const after = (value as { accounts?: readonly ({ lamports: bigint | number; data?: readonly string[] } | null)[] | null }).accounts;
  // Unreported watched accounts are unknown, not zero, so the simulation is inconclusive.
  if (value.err === null && watch.length && (!Array.isArray(after) || after.length !== watch.length)) {
    return {
      ok: false, error: 'the RPC did not report the accounts it was asked to watch', units: Number(value.unitsConsumed ?? 0n),
      logs, blame: null, failedInstruction: null, lamportsAfter: [], sizesAfter: [], slot: BigInt(context?.slot ?? 0), balancesAfter: new Map(),
    };
  }
  const balances = value.err === null && opts.balances
    ? balancesAfterSimulation(transaction, value as SimulatedBalances, opts.balances.lookupTables)
    : new Map<string, bigint>();
  if (typeof balances === 'string') {
    return {
      ok: false, error: balances, units: Number(value.unitsConsumed ?? 0n),
      logs, blame: null, failedInstruction: null, lamportsAfter: [], sizesAfter: [], slot: BigInt(context?.slot ?? 0), balancesAfter: new Map(),
    };
  }
  return {
    ok: value.err === null,
    error: value.err === null ? null : JSON.stringify(value.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    units: Number(value.unitsConsumed ?? 0n),
    logs,
    blame: value.err === null ? null : blameProgram(logs),
    failedInstruction: failedInstructionOf(value.err),
    lamportsAfter: watch.map((_, i) => BigInt(after?.[i]?.lamports ?? 0)),
    sizesAfter: watch.map((_, i) => base64Size(after?.[i]?.data?.[0])),
    slot: BigInt(context?.slot ?? 0),
    balancesAfter: balances,
  };
}

/**
 * The outcome of a send. Only `rejected`, `expired` and `failed` prove no funds moved;
 * `unknown` must be looked up before retrying.
 */
export type SendOutcome = 'confirmed' | 'failed' | 'expired' | 'rejected' | 'unknown';
/** Progress reported while sending. */
export type SendStatus = 'sending' | 'sent' | SendOutcome;
/** Who refused a `rejected` send: the relay (`paused`, `busy`) or the RPC's preflight (`network`). */
export type SendRefusal = 'paused' | 'busy' | 'network';
/** A send result; `transactionError` is the preflight simulation's error as JSON, when available. */
export type SendResult = { signature: string; status: SendOutcome; error: string | null; refusal?: SendRefusal; transactionError?: string };

/** Polling and timeout settings for `sendAndConfirm`. */
export type SendTiming = { pollMs: number; rebroadcastMs: number; giveUpMs: number; settleTries: number; settleMs: number; requestMs: number };
// Settling allows ~30 s because the finalized height trails confirmed by about 13 s.
const TIMING: SendTiming = { pollMs: 1_000, rebroadcastMs: 3_000, giveUpMs: 150_000, settleTries: 15, settleMs: 2_000, requestMs: 15_000 };

/** Only confirmed or finalized statuses count, since `processed` may be on a fork. */
const settled = (s: { confirmationStatus?: string | null } | null | undefined) =>
  !!s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const stringify = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

/**
 * Whether an error proves the send never left a node: a preflight failure, or a 4xx the relay marks
 * as not forwarded. Any other error is ambiguous.
 */
export function refusedBeforeBroadcast(e: unknown): boolean {
  if (isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) return true;
  if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const status = (e.context as { statusCode?: number }).statusCode ?? 0;
    const headers = (e.context as { headers?: Headers }).headers;
    return status >= 400 && status < 500 && headers?.get('x-orientim-not-forwarded') === '1';
  }
  return false;
}

/** The simulation error behind a preflight refusal, shaped like a transaction `err`, or null. */
export function preflightError(e: unknown): unknown {
  if (!isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) return null;
  const kept = (e.context as { err?: unknown }).err;
  if (kept !== undefined && kept !== null) return kept;
  const cause = (e as Error).cause;
  if (isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
    return { InstructionError: [cause.context.index, { Custom: cause.context.code }] };
  }
  return null;
}

/** Whether a preflight refusal means the transaction was already processed. */
export function alreadyProcessed(e: unknown): boolean {
  if (!isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) return false;
  return isSolanaError((e as Error).cause, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)
    || (e.context as { err?: unknown }).err === 'AlreadyProcessed';
}

/** A signature's status as the RPC reports it. */
export type SignatureState = { confirmationStatus?: string | null; err?: unknown } | null;

/**
 * Signature statuses with the heights they cover: `coveredHeight` is a finalized height the node had
 * reached, `reachHeight` the highest it could have reached. Both are null when unknown.
 */
export type StatusView = { statuses: SignatureState[]; coveredHeight: bigint | null; reachHeight: bigint | null };

/** Signature statuses from full history, with heights covered only when the node had reached the finalized slot. */
export async function statusesCovering(rpc: SolanaRpc, signatures: readonly string[], timeoutMs?: number): Promise<StatusView> {
  const finalized = await rpc.getEpochInfo({ commitment: 'finalized' }).send(timeoutMs ? { abortSignal: AbortSignal.timeout(timeoutMs) } : undefined);
  const { context, value } = await rpc.getSignatureStatuses(signatures as never, { searchTransactionHistory: true }).send(timeoutMs ? { abortSignal: AbortSignal.timeout(timeoutMs) } : undefined);
  const height = (finalized as { blockHeight?: bigint | number }).blockHeight;
  const ahead = context?.slot !== undefined ? BigInt(context.slot) - BigInt(finalized.absoluteSlot) : null;
  const covered = height !== undefined && ahead !== null && ahead >= 0n;
  return {
    statuses: value.map(s => (s ?? null) as SignatureState),
    coveredHeight: covered ? BigInt(height) : null,
    reachHeight: covered ? BigInt(height) + ahead : null,
  };
}

/**
 * Blocks held in a node's status cache. History beyond it may be pruned or fail silently, so
 * "no record" proves a transaction never landed only within this window.
 */
export const STATUS_CACHE_BLOCKS = 300n;
/** Safety margin below the edge of the status cache. */
export const STATUS_CACHE_MARGIN_BLOCKS = 30n;
/** Blocks a blockhash stays valid; the earliest landing block is `lastValid - 149`. */
export const BLOCKHASH_LIFE_BLOCKS = 150n;

/**
 * Whether "no record" proves a transaction never landed: finalized height is past `lastValid` and
 * the node's status cache still reaches `earliest`.
 */
export function provesNeverLanded(view: Pick<StatusView, 'coveredHeight' | 'reachHeight'>, lastValid: bigint, earliest: bigint): boolean {
  return view.coveredHeight !== null && view.reachHeight !== null && view.coveredHeight > lastValid
    && view.reachHeight + STATUS_CACHE_MARGIN_BLOCKS < earliest + STATUS_CACHE_BLOCKS;
}

/** Whether the status cache no longer reaches `earliest`, so no record can prove expiry. */
export function pastProof(view: Pick<StatusView, 'coveredHeight'>, earliest: bigint): boolean {
  return view.coveredHeight !== null && view.coveredHeight + STATUS_CACHE_MARGIN_BLOCKS >= earliest + STATUS_CACHE_BLOCKS;
}

/** The result of `sendOnce`: `sent` may land, `unknown` may have been forwarded, `rejected` was never broadcast. */
export type FirstSend = { signature: string; status: 'sent' | 'unknown' | 'rejected'; error: string | null; refusal?: SendRefusal; transactionError?: string };

/** One send with preflight, for callers that confirm and re-broadcast themselves. */
export async function sendOnce(rpc: SolanaRpc, transaction: Transaction): Promise<FirstSend> {
  const signature = getSignatureFromTransaction(transaction);
  const wire = getBase64EncodedWireTransaction(transaction);
  try {
    await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0n }).send();
    return { signature, status: 'sent', error: null };
  } catch (e) {
    if (!refusedBeforeBroadcast(e)) return { signature, status: 'unknown', error: String((e as Error)?.message ?? e) };
    if (alreadyProcessed(e)) return { signature, status: 'sent', error: null };
    const http = httpStatusOf(e);
    if (http === null) {
      const known = await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send()
        .then(r => !!r.value[0], () => null);
      if (known) return { signature, status: 'sent', error: null };
      // The refusal may be of a duplicate send, so an unreadable status leaves the outcome unknown.
      if (known === null) return { signature, status: 'unknown', error: String((e as Error)?.message ?? e) };
    }
    const simulated = preflightError(e);
    return {
      signature, status: 'rejected', error: String((e as Error)?.message ?? e),
      refusal: http === 403 ? 'paused' : http === 429 ? 'busy' : 'network',
      ...(simulated === null ? {} : { transactionError: stringify(simulated) }),
    };
  }
}

/** Sends, re-broadcasts, and settles the outcome; the signature is reported before the first request. */
export async function sendAndConfirm(args: {
  rpc: SolanaRpc;
  transaction: Transaction;
  lastValidBlockHeight: bigint;
  onStatus?: (status: SendStatus, signature: string) => void;
  timing?: Partial<SendTiming>;
}): Promise<SendResult> {
  const { rpc, transaction, lastValidBlockHeight } = args;
  const t = { ...TIMING, ...args.timing };
  const signature = getSignatureFromTransaction(transaction);
  const wire = getBase64EncodedWireTransaction(transaction);
  const done = (status: SendOutcome, error: string | null = null, refusal?: SendRefusal): SendResult => {
    args.onStatus?.(status, signature);
    return { signature, status, error, ...(refusal ? { refusal } : {}) };
  };
  const bounded = () => ({ abortSignal: AbortSignal.timeout(t.requestMs) });
  const rebroadcast = () =>
    void rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send(bounded()).catch(() => undefined);
  const lookup = async (searchTransactionHistory: boolean) =>
    (await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory }).send(bounded())).value[0];

  args.onStatus?.('sending', signature);
  // The deadline starts before the first send, since a send that never answers may still land.
  const started = Date.now();
  try {
    await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0n }).send(bounded());
    args.onStatus?.('sent', signature);
  } catch (e) {
    if (refusedBeforeBroadcast(e)) {
      const http = httpStatusOf(e);
      const result = done('rejected', String((e as Error)?.message ?? e), http === 403 ? 'paused' : http === 429 ? 'busy' : 'network');
      const simulated = preflightError(e);
      return simulated === null ? result : { ...result, transactionError: stringify(simulated) };
    }
    // It may have been forwarded, so keep watching; re-broadcasts of the same bytes land at most once.
  }

  let lastBroadcast = Date.now();
  while (Date.now() - started < t.giveUpMs) {
    await sleep(t.pollMs);
    try {
      const s = await lookup(false);
      if (settled(s)) return s!.err ? done('failed', stringify(s!.err)) : done('confirmed');
      const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send(bounded());
      if (height > lastValidBlockHeight) return settleAfterExpiry();
    } catch {
      // A failed read says nothing about the transaction.
    }
    if (Date.now() - lastBroadcast >= t.rebroadcastMs) {
      rebroadcast();
      lastBroadcast = Date.now();
    }
  }
  return done('unknown', 'the outcome could not be read from the network');

  // After expiry, report `expired` only when two coherent views prove the transaction never landed.
  async function settleAfterExpiry(): Promise<SendResult> {
    const earliest = lastValidBlockHeight - BLOCKHASH_LIFE_BLOCKS + 1n;
    let notFound = 0;
    let seen = false;
    for (let i = 0; i < t.settleTries; i++) {
      try {
        const view = await statusesCovering(rpc, [signature], t.requestMs);
        const s = view.statuses[0];
        if (settled(s)) return s!.err ? done('failed', stringify(s!.err)) : done('confirmed');
        seen ||= !!s;
        if (!s && provesNeverLanded(view, lastValidBlockHeight, earliest) && ++notFound >= 2) return done('expired');
        if (!s && pastProof(view, earliest)) break;
      } catch {
        // Keep settling.
      }
      await sleep(t.settleMs);
    }
    return done('unknown', seen ? 'seen by the network but not confirmed' : 'the outcome could not be proven');
  }
}

/** Creates the one-time authority E as a non-extractable WebCrypto key, used for a single transaction. */
export async function createEphemeral(): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  if (signer.keyPair.privateKey.extractable) throw new Error('The temporary key must be non-extractable');
  return signer;
}
