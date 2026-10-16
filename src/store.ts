/**
 * Where a signed swap waits for its outcome, and what settles it after a stop: `createFileStore`,
 * `recoverPending`, `resolvePending`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { ConfigError } from './api.ts';
import { confirm, lastBlockOf, lookUp, temporaryAuthorityOf } from './chain.ts';
import type { Outcome } from './chain.ts';
import { DIR_MODE, FILE_MODE, ownStateDir, syncDir, temporaryFor } from './files.ts';
import type { SpendLog } from './policy.ts';
import { DAY_MS } from './util.ts';

/**
 * What to keep before finalize: with it, a process that stops can still find out what happened, and
 * ask finalize again with the same ticket and bytes (the same transaction lands at most once).
 */
export type Signed = {
  signature: string;
  lastValidBlockHeight: bigint;
  ticket: string;
  /** The transaction as your wallet signed it, base64. */
  signedTransaction: string;
  messageSha256: string;
  /** When it was signed, in ms since the epoch. */
  signedAt: number;
  /** The order it carries out (`Intent.id`), if it has one. */
  intentId?: string;
  /** The wallet that signed it: one swap per wallet may be pending at a time. */
  owner?: string;
  /**
   * Your RPC's block height when it was signed: nothing sent after it can land below it. What lets
   * "no record" prove the swap expired (see `confirm`); a record without it stays unknown until
   * settled by hand (`resolvePending`).
   */
  signedHeight?: bigint;
};

/** What happened to an order: its last transaction, and that transaction's state. */
export type OrderRecord = { signature: string; state: 'pending' | 'confirmed' | 'failed' | 'expired' | 'rejected' };

/**
 * Where each order's outcome is kept, by `Intent.id`. `claimOrder` must be atomic across every worker
 * that may take the same order: it records the order only if nothing is recorded for it yet.
 * `reclaimOrder` is the same for a retry: it records the new attempt only if `prior`, an attempt that
 * failed or expired, is still the one recorded, so two workers retrying one order cannot both send
 * it. The file store does both with exclusive creates; workers on several machines need a shared
 * store (a database row, a compare-and-set key) with the same calls. A book without `reclaimOrder`
 * cannot retry an order safely, so a retry with it is refused: give the retry a new id instead.
 */
export type OrderBook = {
  order(id: string): Promise<OrderRecord | null>;
  recordOrder(id: string, record: OrderRecord): Promise<void>;
  claimOrder(id: string, record: OrderRecord): Promise<boolean>;
  reclaimOrder?(id: string, prior: OrderRecord, record: OrderRecord): Promise<boolean>;
};

/**
 * Takes order `id` for a new attempt: atomically when nothing is recorded for it yet, and, after an
 * attempt that failed or expired, only while that attempt is still the one recorded. False when
 * another worker took it first, or when the book cannot retry safely.
 */
export async function takeOrder(orders: OrderBook, id: string, prior: OrderRecord | null, record: OrderRecord): Promise<boolean> {
  if (!prior) return orders.claimOrder(id, record);
  return orders.reclaimOrder ? orders.reclaimOrder(id, prior, record) : false;
}

/** The wallet a kept record was signed by: named in it, or read from its transaction's fee payer. */
function ownerOfRecord(s: Signed): string | null {
  if (s.owner) return s.owner;
  try {
    return getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(s.signedTransaction, 'base64')).messageBytes).staticAccounts[0];
  } catch {
    return null;
  }
}

/**
 * Swaps from `owner` whose transaction may still land, other than `except`. A record whose wallet
 * cannot be read counts for every wallet: it is settled first, not guessed about.
 */
export async function pendingFor(store: PendingStore, owner: string, except?: string): Promise<string[]> {
  return (await store.list())
    .filter(s => s.signature !== except && (ownerOfRecord(s) ?? owner) === owner)
    .map(s => s.signature);
}

/**
 * An earlier swap from this wallet may still land: nothing new is sent until it is settled
 * (`recoverPending`), whether or not the two share an order id.
 */
export class PendingSwapError extends Error {
  readonly signatures: string[];
  constructor(signatures: string[]) {
    super(`An earlier swap from this wallet may still land (${signatures.join(', ')}): settle it first. Nothing new was sent.`);
    this.signatures = signatures;
  }
}


/** Where signed swaps wait for their outcome. Unattended, it must survive the process. */
export type PendingStore = {
  put(signed: Signed): Promise<void>;
  remove(signature: string): Promise<void>;
  list(): Promise<Signed[]>;
};

/** An order recorded in the book, found by its transaction's signature (`orderBySignature`). */
export type FoundOrder = { id: string; record: OrderRecord; recordedAt: number };


/**
 * How old a retry marker must be before a worker may find it abandoned. A worker records its attempt
 * milliseconds after creating the marker; a minute is far past that, and short for an order to wait.
 */
const RETRY_MARKER_STALE_MS = 60_000;

/**
 * Pending swaps as files in `dir`, one per signature, each written to a temporary file, flushed to
 * disk and renamed into place, so a record is either whole or absent. The directory is made readable
 * by its owner only.
 */
export function createFileStore(dir: string): PendingStore & OrderBook & SpendLog & { orderBySignature(signature: string): Promise<FoundOrder | null> } {
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch (e) {
    throw new ConfigError(`The state directory ${dir} cannot be made (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); nothing was started. Fix it first.`);
  }
  ownStateDir(dir);
  const file = (signature: string) => join(dir, `pending-${signature}.json`);
  // An id is the caller's text: its hash names the file, and the record keeps the id itself.
  const orderFile = (id: string) => join(dir, `order-${createHash('sha256').update(id).digest('hex').slice(0, 40)}.json`);
  /** Creates `path`, which must not exist yet: a temporary file (`temporaryFor`), or a claim. */
  const writeDurably = (path: string, text: string) => {
    const fd = openSync(path, 'wx', FILE_MODE);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  /** Renames a flushed temporary file into place, and flushes the directory that now names it. */
  const commit = (temporary: string, path: string) => {
    renameSync(temporary, path);
    syncDir(dir);
  };
  const readOrder = (id: string): OrderRecord | null => {
    try {
      const { signature, state } = JSON.parse(readFileSync(orderFile(id), 'utf8')) as OrderRecord;
      return { signature, state };
    } catch {
      return null;
    }
  };
  const writeOrder = (id: string, record: OrderRecord) => {
    const temporary = temporaryFor(orderFile(id));
    writeDurably(temporary, JSON.stringify({ id, ...record }));
    commit(temporary, orderFile(id));
  };
  /** A retry marker no worker can still be using: see `reclaimOrder`. */
  const retryMarkerAbandoned = (marker: string, id: string, prior: OrderRecord): boolean => {
    let made: number;
    try {
      made = statSync(marker).mtimeMs;
    } catch {
      return false;
    }
    if (Date.now() - made < RETRY_MARKER_STALE_MS) return false;
    const now = readOrder(id);
    if (!now || now.signature !== prior.signature || now.state !== prior.state) return false;
    for (const f of readdirSync(dir).filter(f => f.startsWith('pending-') && f.endsWith('.json'))) {
      try {
        if ((JSON.parse(readFileSync(join(dir, f), 'utf8')) as { intentId?: unknown }).intentId === id) return false;
      } catch {
        // A pending record that cannot be read may be this order's: the marker is not taken.
        return false;
      }
    }
    return true;
  };
  return {
    async order(id) {
      return readOrder(id);
    },
    async recordOrder(id, record) {
      writeOrder(id, record);
    },
    async claimOrder(id, record) {
      try {
        writeDurably(orderFile(id), JSON.stringify({ id, ...record }));
      } catch {
        return false;
      }
      syncDir(dir);
      return true;
    },
    async reclaimOrder(id, prior, record) {
      // One retry per earlier attempt: the worker that creates this marker first takes the order.
      const marker = `${orderFile(id)}.retry-${prior.signature}`;
      const claim = () => {
        try {
          writeDurably(marker, '');
          return true;
        } catch {
          return false;
        }
      };
      if (!claim()) {
        // A marker left by a worker that stopped between creating it and recording its attempt would
        // hold the order for good. It is abandoned only when all of these hold: it is older than any
        // worker takes to record its attempt (milliseconds), the order still names the attempt it
        // retries, and no swap kept for this order is pending (a worker keeps its swap before it
        // creates the marker, and keeps it until it lands or is settled). One worker then sets it
        // aside, atomically, and claims it afresh; any other finds it gone and stands down.
        if (!retryMarkerAbandoned(marker, id, prior)) return false;
        try {
          renameSync(marker, `${marker}.abandoned-${randomUUID()}`);
        } catch {
          return false;
        }
        for (const f of readdirSync(dir).filter(f => f.startsWith(`${basename(marker)}.abandoned-`))) rmSync(join(dir, f), { force: true });
        if (!claim()) return false;
      }
      const now = readOrder(id);
      if (!now || now.signature !== prior.signature || now.state !== prior.state) return false;
      writeOrder(id, record);
      // Once the order names the new attempt, a worker still holding `prior` finds it changed and
      // stands down: the marker has done its work and is removed, so markers do not pile up.
      rmSync(marker, { force: true });
      return true;
    },
    async put(s) {
      const temporary = temporaryFor(file(s.signature));
      writeDurably(temporary, JSON.stringify({
        ...s, lastValidBlockHeight: s.lastValidBlockHeight.toString(),
        ...(s.signedHeight !== undefined ? { signedHeight: s.signedHeight.toString() } : {}),
      }));
      commit(temporary, file(s.signature));
    },
    async remove(signature) {
      rmSync(file(signature), { force: true });
    },
    async spentSince(owner, mint, since, except) {
      let spent = 0n;
      const spends = readdirSync(dir).filter(f => f.startsWith('spend-') && f.endsWith('.json'))
        .map(f => [f, JSON.parse(readFileSync(join(dir, f), 'utf8')) as { signature: string; owner: string; mint: string; amountIn: string; at: number }] as const);
      // A spend older than two days counts for no daily limit: it is removed, so the log stays small.
      // Two days before the newest spend too: a clock that jumps ahead erases nothing it has not
      // seen a later spend for, so a daily limit does not reset when the clock comes back.
      const newest = spends.reduce((m, [, s]) => (Number.isFinite(s.at) && s.at > m ? s.at : m), -Infinity);
      const expired = Math.min(since, Date.now() - 2 * DAY_MS, newest - 2 * DAY_MS);
      for (const [f, s] of spends) {
        if (s.at < expired) {
          rmSync(join(dir, f), { force: true });
          continue;
        }
        if (s.owner === owner && s.mint === mint && s.at >= since && s.signature !== except) spent += BigInt(s.amountIn);
      }
      return spent;
    },
    async recordSpend(entry) {
      const path = join(dir, `spend-${entry.signature}.json`);
      const temporary = temporaryFor(path);
      writeDurably(temporary, JSON.stringify(entry));
      commit(temporary, path);
    },
    async forgetSpend(signature) {
      rmSync(join(dir, `spend-${signature}.json`), { force: true });
    },
    async orderBySignature(signature) {
      for (const f of readdirSync(dir).filter(f => /^order-[0-9a-f]{40}\.json$/.test(f))) {
        try {
          const path = join(dir, f);
          const { id, signature: sig, state } = JSON.parse(readFileSync(path, 'utf8')) as OrderRecord & { id: string };
          if (sig === signature && typeof id === 'string') return { id, record: { signature: sig, state }, recordedAt: statSync(path).mtimeMs };
        } catch {
          // A file that is not an order record names no order.
        }
      }
      return null;
    },
    async list() {
      return readdirSync(dir).filter(f => f.startsWith('pending-') && f.endsWith('.json')).map(f => {
        const json = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Omit<Signed, 'lastValidBlockHeight' | 'signedHeight'> & { lastValidBlockHeight: string; signedHeight?: string };
        return {
          ...json, lastValidBlockHeight: BigInt(json.lastValidBlockHeight),
          ...(json.signedHeight !== undefined ? { signedHeight: BigInt(json.signedHeight) } : {}),
        } as Signed;
      });
    },
  };
}

/**
 * Records `record` as the outcome of order `id` only while the order is still this attempt's (the
 * same signature) or names none: a late settle of an older attempt never writes over a newer one.
 * Every writer of one wallet's orders holds that wallet's lock (`acquireLock`), so the read and the
 * write here are not raced by another run of the command. False when the order is another attempt's.
 */
export async function settleOrder(orders: OrderBook, id: string, record: OrderRecord): Promise<boolean> {
  const now = await orders.order(id);
  if (now && now.signature !== record.signature) return false;
  await orders.recordOrder(id, record);
  return true;
}

/**
 * The chain proves this swap moved nothing from the wallet: it failed, or it can no longer land
 * (`rejected` is Orientim's refusal of a swap that can no longer land). Its spend no longer counts.
 */
export const movedNothing = (outcome: string) => outcome === 'failed' || outcome === 'expired' || outcome === 'rejected';

/**
 * Settles the swaps a stopped run left in `store`, each by its own signature on your RPC, and removes
 * those whose outcome is final. Returns what is still unknown: while anything is, start no new swap
 * for the same intent. A swap that "no record" can no longer prove expired stays unknown
 * however long ago it was sent: look it up in a full history, then `resolvePending`.
 * An outcome whose record could not be updated is returned all the same, beside the error, and its
 * pending record stays for the next run. With `spends`, a swap that moved nothing frees its spend.
 */
export async function recoverPending(
  store: PendingStore, rpc: Rpc<SolanaRpcApi>,
  opts: { pollMs?: number; maxWaitMs?: number; orders?: OrderBook; archive?: Rpc<SolanaRpcApi>; spends?: Pick<SpendLog, 'forgetSpend'> } = {},
): Promise<{ settled: { signature: string; outcome: Outcome }[]; unknown: string[]; bookkeepingErrors: { signature: string; error: string }[] }> {
  const settled: { signature: string; outcome: Outcome }[] = [];
  const unknown: string[] = [];
  const bookkeepingErrors: { signature: string; error: string }[] = [];
  for (const s of await store.list()) {
    const outcome = await confirm(rpc, s.signature, lastBlockOf(s), {
      ...opts, earliestHeight: s.signedHeight, temporaryAuthority: temporaryAuthorityOf(s.signedTransaction),
    });
    if (outcome === 'unknown') {
      unknown.push(s.signature);
      continue;
    }
    settled.push({ signature: s.signature, outcome });
    try {
      // The order learns its outcome before the record that says it was pending goes away.
      if (s.intentId && opts.orders) await settleOrder(opts.orders, s.intentId, { signature: s.signature, state: outcome });
      if (movedNothing(outcome)) await opts.spends?.forgetSpend?.(s.signature);
      await store.remove(s.signature);
    } catch (e) {
      bookkeepingErrors.push({ signature: s.signature, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { settled, unknown, bookkeepingErrors };
}

/**
 * Settles by hand a kept swap whose outcome the chain can no longer prove (`unknown` long after it was
 * sent: see `confirm`), once you have looked its signature up in a full history, such as an explorer.
 * The chain's own answer comes first: a status your RPC still has is used instead of yours. Refused
 * while the transaction could still land, and while it is seen but not settled. With `spends`, a swap
 * the chain shows failed frees its spend; one settled on your word alone still counts for its day.
 */
export async function resolvePending(
  store: PendingStore, rpc: Rpc<SolanaRpcApi>, signature: string, outcome: 'confirmed' | 'failed' | 'expired',
  opts: { orders?: OrderBook; requestTimeoutMs?: number; spends?: Pick<SpendLog, 'forgetSpend'> } = {},
): Promise<{ signature: string; outcome: 'confirmed' | 'failed' | 'expired'; by: 'chain' | 'you' }> {
  const kept = (await store.list()).find(s => s.signature === signature);
  if (!kept) throw new Error(`No kept swap has the signature ${signature}. Nothing was changed.`);
  const bounded = () => ({ abortSignal: AbortSignal.timeout(opts.requestTimeoutMs ?? 10_000) });
  const { status, view } = await lookUp(rpc, signature, bounded);
  const onChain = status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
    ? (status.err ? 'failed' as const : 'confirmed' as const) : null;
  if (!onChain && status) throw new Error(`The network has seen ${signature} but not settled it yet: wait and recover again. Nothing was changed.`);
  if (!onChain && view.coveredHeight === null) {
    throw new Error(`Your RPC could not say whether ${signature} can still land: try again, or recover it. Nothing was changed.`);
  }
  if (!onChain && view.coveredHeight! <= lastBlockOf(kept)) {
    throw new Error(`${signature} can still land until block ${lastBlockOf(kept)}: recover it instead. Nothing was changed.`);
  }
  const settledAs = onChain ?? outcome;
  if (kept.intentId && opts.orders) await settleOrder(opts.orders, kept.intentId, { signature, state: settledAs });
  if (onChain === 'failed') await opts.spends?.forgetSpend?.(signature);
  await store.remove(signature);
  return { signature, outcome: settledAs, by: onChain ? 'chain' : 'you' };
}
