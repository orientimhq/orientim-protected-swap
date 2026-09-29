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
import type { AccountState, ChainSnapshot } from '@orientim/core';

export type SolanaRpc = Rpc<SolanaRpcApi>;

/**
 * The HTTP status of a failed RPC call. Read from the error's context, never its text: a
 * production build of kit replaces every message with "Solana error #<code>", so a test on the
 * words "429" or "Too Many Requests" never matches in the page users actually load.
 */
export function httpStatusOf(e: unknown): number | null {
  if (!isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return null;
  return (e.context as { statusCode?: number }).statusCode ?? null;
}

type Transport = ReturnType<typeof createDefaultRpcTransport>;

/**
 * Retries rate-limited requests (HTTP 429) with exponential backoff. The wait is jittered, so the
 * pages that were refused together do not all come back at the same moment and be refused again.
 *
 * Never a send: a 429 may come back after the request was forwarded, and a later attempt refused
 * outright would hide that earlier one behind a definitive "never broadcast". The sender sees the first answer and decides; re-broadcasting is its job.
 */
export function retryingTransport(transport: Transport, maxRetries = 5, baseMs = 500, timeoutMs = 20_000): Transport {
  return (async (config: Parameters<Transport>[0]) => {
    const method = (config as { payload?: { method?: unknown } }).payload?.method;
    const own = (config as { signal?: AbortSignal }).signal;
    for (let attempt = 0; ; attempt++) {
      try {
        // Every request ends within `timeoutMs`, besides any signal of the caller's own: one that never
        // answers is an error, not a wait without end.
        const limit = AbortSignal.timeout(timeoutMs);
        const signal = own && typeof AbortSignal.any === 'function' ? AbortSignal.any([own, limit]) : own ?? limit;
        return await transport({ ...config, signal } as Parameters<Transport>[0]);
      } catch (e) {
        if (attempt >= maxRetries || httpStatusOf(e) !== 429 || method === 'sendTransaction') throw e;
        // The caller's signal also ends the wait: a caller out of time gets the 429 now, not after it.
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

/**
 * An RPC client that retries rate-limited requests: reads and simulations, which are safe to repeat.
 * A send is answered as it was; the sender re-broadcasts the same bytes itself.
 */
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

/**
 * A read that must not be older than `minContextSlot`: a node behind it says so, and is asked again
 * a few times (it catches up in a slot or two) before the read fails.
 */
async function notOlderThan<T>(read: () => Promise<T>, minContextSlot: bigint | undefined): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (e) {
      if (minContextSlot === undefined || attempt >= 4 || !isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED)) throw e;
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

/**
 * The same read, keeping the slot the chain answered at. With `minContextSlot`, every batch is at
 * least that recent, so reads made in separate calls cannot mix state older than an earlier one.
 */
export async function readAccounts(
  rpc: SolanaRpc,
  addresses: readonly Address[],
  opts: { minContextSlot?: bigint; timeoutMs?: number } = {},
): Promise<{ accounts: Map<string, AccountState | null>; slot: bigint }> {
  const unique = [...new Set(addresses)];
  const out = new Map<string, AccountState | null>();
  let slot = 0n;
  for (let i = 0; i < unique.length; i += MAX_ACCOUNTS_PER_CALL) {
    const batch = unique.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    const { context, value } = await notOlderThan(() => rpc.getMultipleAccounts(batch, {
      encoding: 'base64', commitment: 'confirmed', ...(opts.minContextSlot !== undefined ? { minContextSlot: opts.minContextSlot } : {}),
    }).send(opts.timeoutMs ? { abortSignal: AbortSignal.timeout(opts.timeoutMs) } : undefined), opts.minContextSlot);
    // The oldest slot of the batches: the state is at least that recent. An RPC that omits the
    // context leaves the slot at zero, and a certificate then simply names no slot.
    const at = BigInt(context?.slot ?? 0);
    slot = slot === 0n || (at !== 0n && at < slot) ? at : slot;
    value.forEach((acc, j) => {
      out.set(batch[j], acc ? { owner: acc.owner, lamports: acc.lamports, data: decodeBase64(acc.data[0]) } : null);
    });
  }
  return { accounts: out, slot };
}

/**
 * Everything the verifier needs, read from the chain. Lookup tables come from the RPC, never from
 * Jupiter. With `minContextSlot` (the slot the swap was simulated at), the accounts and the tables
 * are both at least that recent.
 */
export async function fetchSnapshot(args: {
  rpc: SolanaRpc;
  addresses: readonly Address[];
  lookupTableAddresses: readonly Address[];
  minContextSlot?: bigint;
}): Promise<ChainSnapshot> {
  const { accounts, slot } = await readAccounts(args.rpc, args.addresses, { minContextSlot: args.minContextSlot });
  const lookupTables: Record<string, readonly Address[]> = args.lookupTableAddresses.length
    ? await notOlderThan(() => fetchAddressesForLookupTables([...args.lookupTableAddresses], args.rpc, {
      ...(args.minContextSlot !== undefined ? { minContextSlot: args.minContextSlot } : {}),
    }), args.minContextSlot)
    : {};
  return { accounts, lookupTables, slot };
}

export type MintInfo = { exists: boolean; program: Address | null; decimals: number; freezeAuthority: boolean; mintAuthority: boolean };

/** What a mint account says; `exists: false` for a missing account or one too short to be a mint. */
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

export async function fetchMints(rpc: SolanaRpc, mints: readonly Address[]): Promise<Map<string, MintInfo>> {
  const states = await fetchAccounts(rpc, mints);
  return new Map(mints.map(m => [m, mintInfoOf(states.get(m))]));
}

const INFRA = new Set([
  '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'ComputeBudget111111111111111111111111111111',
]);

/**
 * The innermost non-infrastructure program on the call stack when a simulation failed: the DEX to
 * blame. Returns the failing infrastructure program when none (one of our own instructions failed).
 */
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

export const isInfrastructureProgram = (programId: string) => INFRA.has(programId);

function failedInstructionOf(err: unknown): number | null {
  const ie = (err as { InstructionError?: [number | bigint, unknown] } | null)?.InstructionError;
  return ie ? Number(ie[0]) : null;
}

export type Simulation = {
  ok: boolean;
  error: string | null;
  units: number;
  logs: string[];
  blame: string | null;
  /** Index of the instruction that failed, when the error names one. */
  failedInstruction: number | null;
  /** Lamports each requested account holds after the transaction (0 when it no longer exists). */
  lamportsAfter: bigint[];
  /** The size of each requested account's data after the transaction (0 when it no longer exists). */
  sizesAfter: number[];
  /** The slot the simulation ran at (0 when the RPC does not say). */
  slot: bigint;
  /**
   * With `balances`: the lamports every account the transaction names holds after it, from the
   * simulation's `postBalances`, by address. Empty otherwise, or when the simulation failed.
   */
  balancesAfter: Map<string, bigint>;
};

/**
 * The accounts a transaction names, in the order the runtime numbers them (and `postBalances`
 * follows): the static accounts, then what the lookup tables load as writable, then as read-only,
 * table by table. Null when a table it names is not in `lookupTables`, or an index is past its end.
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

/**
 * What each account of `transaction` holds after a successful simulation, from its `postBalances`,
 * or why that answer cannot be relied on: no balances, a count that is not the transaction's, or
 * addresses loaded from lookup tables that are not the ones the tables hold. Read this way, the
 * accounts need not be named in `accounts.addresses`, which some RPC providers limit to two.
 */
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

/**
 * Simulation answers "will it execute?" — never "is it safe?" (plan, section 15). With
 * `minContextSlot`, it runs on state at least that recent: a load-balanced provider cannot answer
 * from a node behind the snapshot the verifier read.
 */
export async function simulate(
  rpc: SolanaRpc,
  transaction: Transaction,
  watch: readonly Address[] = [],
  opts: {
    minContextSlot?: bigint;
    /** Read every account's balance after the transaction from `postBalances` (`balancesAfter`). */
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
  // Accounts asked to be watched and not reported are not accounts at zero: what they hold after
  // the swap is unknown, so the simulation says nothing.
  if (value.err === null && watch.length && (!Array.isArray(after) || after.length !== watch.length)) {
    return {
      ok: false, error: 'the RPC did not report the accounts it was asked to watch', units: Number(value.unitsConsumed ?? 0n),
      logs, blame: null, failedInstruction: null, lamportsAfter: [], sizesAfter: [], slot: BigInt(context?.slot ?? 0), balancesAfter: new Map(),
    };
  }
  // Balances that cannot be matched to the transaction's accounts say nothing either.
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
 * What happened to a sent transaction. Only three outcomes allow saying that no funds
 * moved: `rejected` (refused before it was broadcast), `expired` (its blockhash expired and the
 * cluster has no record of it, so it can never execute) and `failed` (it executed and reverted;
 * only the network fee was paid). `unknown` means exactly that: look it up before trying again.
 */
export type SendOutcome = 'confirmed' | 'failed' | 'expired' | 'rejected' | 'unknown';
export type SendStatus = 'sending' | 'sent' | SendOutcome;
/**
 * `refusal`, for `rejected` only: who refused. `paused` and `busy` are Orientim's own relay (the kill
 * switch, the send limit); `network` is the RPC's preflight, which usually means the price moved.
 */
export type SendRefusal = 'paused' | 'busy' | 'network';
/**
 * `transactionError`, for a refusal by the RPC's preflight only: the simulation's error, as JSON in
 * the shape a confirmed transaction's `err` has, when it was one program's custom error. It says
 * why the network refused (the price moved, most often), which the message alone does not.
 */
export type SendResult = { signature: string; status: SendOutcome; error: string | null; refusal?: SendRefusal; transactionError?: string };

export type SendTiming = { pollMs: number; rebroadcastMs: number; giveUpMs: number; settleTries: number; settleMs: number; requestMs: number };
// Settling waits up to 30 s: expiry is proven against the finalized height, which trails the
// confirmed one by about 13 s. Every request, the first send included, ends within `requestMs`.
const TIMING: SendTiming = { pollMs: 1_000, rebroadcastMs: 3_000, giveUpMs: 150_000, settleTries: 15, settleMs: 2_000, requestMs: 15_000 };

/** An outcome only once the cluster has confirmed it: an error seen at `processed` may be on a fork. */
const settled = (s: { confirmationStatus?: string | null } | null | undefined) =>
  !!s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const stringify = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

/**
 * Only two responses prove that the first send never left a node: Solana's structured preflight
 * failure, and a 4xx that Orientim's proxy explicitly marks as rejected before forwarding. Every
 * upstream HTTP/JSON-RPC error is ambiguous, because a node may have accepted the transaction
 * before its response failed.
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

/**
 * The error of the simulation behind a preflight refusal, in the shape a confirmed transaction's
 * `err` has, or null. Kit keeps it as the refusal's cause, which a production build still carries
 * when it drops the words.
 */
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

/**
 * A preflight refusal because the cluster has already processed this very transaction: it was sent,
 * whatever a lagging status read says.
 */
export function alreadyProcessed(e: unknown): boolean {
  if (!isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) return false;
  // Kit turns the simulation's `err` into the error's cause; a context that kept it says the same.
  return isSolanaError((e as Error).cause, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)
    || (e.context as { err?: unknown }).err === 'AlreadyProcessed';
}

/** A signature's status as the RPC reports it. */
export type SignatureState = { confirmationStatus?: string | null; err?: unknown } | null;

/**
 * What one look at the chain can say about signatures that have no record.
 * `coveredHeight`: a finalized block height the answering node had reached. `reachHeight`: the
 * highest block height that node can have reached (the finalized height plus the slots its answer
 * was ahead of it). Both are null when the node lagged the finalized slot or no height was reported.
 */
export type StatusView = { statuses: SignatureState[]; coveredHeight: bigint | null; reachHeight: bigint | null };

/**
 * The statuses of `signatures` from full history, with the heights that answer covers. The finalized slot and height come from one answer; the statuses must come from a
 * node that had reached at least that slot, since a load-balanced provider may answer the two reads
 * from different nodes and a lagging node's silence proves nothing. Whether "no record" proves that
 * a transaction never landed is `provesNeverLanded`'s to say.
 */
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
 * A node finds a transaction's status in its status cache, which holds the transactions of its last
 * 300 rooted blocks (Agave's MAX_RECENT_BLOCKHASHES), and only then in its ledger history or an
 * archive. That history can be pruned or missing, and an archive that fails answers "no record" as
 * well (Agave maps a BigTable error to none). So "no record" proves that a transaction never landed
 * only while the node's cache still holds every block it could have landed in.
 */
export const STATUS_CACHE_BLOCKS = 300n;
/** Kept in hand below the edge of that cache. */
export const STATUS_CACHE_MARGIN_BLOCKS = 30n;
/** A blockhash can be used in the 150 blocks after its own: the first block a transaction can land in is `lastValid - 149`. */
export const BLOCKHASH_LIFE_BLOCKS = 150n;

/**
 * Does `view` prove that a transaction with no record in it never landed, and never will? It can
 * land in blocks `earliest` to `lastValid`: the finalized chain must be past `lastValid`, and the
 * answering node's cache must still reach down to `earliest`. Past that window, "no record" is no
 * proof at all: the outcome stays unknown until someone looks it up in a full history.
 */
export function provesNeverLanded(view: Pick<StatusView, 'coveredHeight' | 'reachHeight'>, lastValid: bigint, earliest: bigint): boolean {
  return view.coveredHeight !== null && view.reachHeight !== null && view.coveredHeight > lastValid
    && view.reachHeight + STATUS_CACHE_MARGIN_BLOCKS < earliest + STATUS_CACHE_BLOCKS;
}

/** Has the window in which "no record" could prove anything closed for good (see `provesNeverLanded`)? */
export function pastProof(view: Pick<StatusView, 'coveredHeight'>, earliest: bigint): boolean {
  return view.coveredHeight !== null && view.coveredHeight + STATUS_CACHE_MARGIN_BLOCKS >= earliest + STATUS_CACHE_BLOCKS;
}

/**
 * `sent`: the RPC accepted it, so it may land; confirm it on chain. `unknown`: the connection failed
 * after the request left, so it may have been forwarded. `rejected`: provably never broadcast.
 */
export type FirstSend = { signature: string; status: 'sent' | 'unknown' | 'rejected'; error: string | null; refusal?: SendRefusal; transactionError?: string };

/**
 * One send with preflight, for a caller that confirms and re-broadcasts on its own (the agent API,
 * which cannot hold a request open for the minute a transaction may take to land). A preflight
 * refusal of a signature the cluster already has, a second send of the same transaction, is `sent`.
 */
export async function sendOnce(rpc: SolanaRpc, transaction: Transaction): Promise<FirstSend> {
  const signature = getSignatureFromTransaction(transaction);
  const wire = getBase64EncodedWireTransaction(transaction);
  try {
    await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0n }).send();
    return { signature, status: 'sent', error: null };
  } catch (e) {
    if (!refusedBeforeBroadcast(e)) return { signature, status: 'unknown', error: String((e as Error)?.message ?? e) };
    // A second send of a transaction that already landed: sent, even while the status read lags.
    if (alreadyProcessed(e)) return { signature, status: 'sent', error: null };
    const http = httpStatusOf(e);
    if (http === null) {
      const known = await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send()
        .then(r => !!r.value[0], () => null);
      if (known) return { signature, status: 'sent', error: null };
      // The refusal may be of a second send of a transaction already on its way; a status that
      // cannot be read does not say it is not, so the outcome is unknown.
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

/**
 * Sends, re-broadcasts every few seconds, and settles the outcome. The signature is reported
 * before the first request, so a caller never loses track of a transaction that may have landed.
 */
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
  // The deadline starts before the first send: a send that never answers counts against it, and is
  // an outcome to watch for, never "not sent".
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
    // It may have been forwarded before the connection failed: keep watching. The re-broadcasts
    // send the same bytes, which can land at most once.
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
      // A failed read says nothing about the transaction; keep trying until giving up.
    }
    if (Date.now() - lastBroadcast >= t.rebroadcastMs) {
      rebroadcast();
      lastBroadcast = Date.now();
    }
  }
  return done('unknown', 'the outcome could not be read from the network');

  // The blockhash has expired, so the transaction can no longer be included. Stop re-broadcasting
  // and read the full status history: seen but only `processed` is not an outcome yet. "Expired" is
  // said only from one coherent view, twice: a finalized height past the lifetime, and no record
  // from a node that had reached that height's slot and whose status cache still holds every block
  // the transaction could have landed in.
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
        // keep settling
      }
      await sleep(t.settleMs);
    }
    return done('unknown', seen ? 'seen by the network but not confirmed' : 'the outcome could not be proven');
  }
}

/**
 * The temporary authority E: an Ed25519 key generated with WebCrypto as non-extractable, so not
 * even a bug can export it. One per transaction; the caller drops it after signing.
 */
export async function createEphemeral(): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  if (signer.keyPair.privateKey.extractable) throw new Error('The temporary key must be non-extractable');
  return signer;
}
