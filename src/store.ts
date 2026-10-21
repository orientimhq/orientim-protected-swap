/** Durable storage for signed swaps, orders and spends, and recovery after an interrupted run. */
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

/** Record persisted before finalize so an interrupted run can confirm or resend the same transaction. */
export type Signed = {
  signature: string;
  lastValidBlockHeight: bigint;
  ticket: string;
  /** Wallet-signed transaction, base64. */
  signedTransaction: string;
  messageSha256: string;
  /** Signing time, ms since the epoch. */
  signedAt: number;
  /** The `Intent.id` this swap carries out, if any. */
  intentId?: string;
  /** Signing wallet. */
  owner?: string;
  /**
   * RPC block height at signing. Required for "no record" to prove expiry; without it the swap stays
   * unknown until settled with `resolvePending`.
   */
  signedHeight?: bigint;
};

/** An order's latest transaction and its state. */
export type OrderRecord = { signature: string; state: 'pending' | 'confirmed' | 'failed' | 'expired' | 'rejected' };

/**
 * Order outcomes keyed by `Intent.id`. `claimOrder` and `reclaimOrder` must be atomic across all workers
 * (compare-and-set) so one order is never sent twice. Without `reclaimOrder`, retries are refused.
 */
export type OrderBook = {
  order(id: string): Promise<OrderRecord | null>;
  recordOrder(id: string, record: OrderRecord): Promise<void>;
  claimOrder(id: string, record: OrderRecord): Promise<boolean>;
  reclaimOrder?(id: string, prior: OrderRecord, record: OrderRecord): Promise<boolean>;
};

/** Claims order `id` for a new attempt; returns false if another worker took it or retry is unsupported. */
export async function takeOrder(orders: OrderBook, id: string, prior: OrderRecord | null, record: OrderRecord): Promise<boolean> {
  if (!prior) return orders.claimOrder(id, record);
  return orders.reclaimOrder ? orders.reclaimOrder(id, prior, record) : false;
}

/** The record's wallet, falling back to the transaction's fee payer. */
function ownerOfRecord(s: Signed): string | null {
  if (s.owner) return s.owner;
  try {
    return getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(s.signedTransaction, 'base64')).messageBytes).staticAccounts[0];
  } catch {
    return null;
  }
}

/**
 * Signatures of `owner`'s pending swaps, excluding `except`. A record with an unknown wallet counts
 * for every wallet.
 */
export async function pendingFor(store: PendingStore, owner: string, except?: string): Promise<string[]> {
  return (await store.list())
    .filter(s => s.signature !== except && (ownerOfRecord(s) ?? owner) === owner)
    .map(s => s.signature);
}

/** A pending record cannot be read; it may still land, so no new swap starts (exit 3). */
export class PendingUnreadableError extends Error {
  override name = 'PendingUnreadableError';
  constructor(path: string, cause: unknown) {
    super(`A kept swap's record could not be read (${path}: ${cause instanceof Error ? cause.message : String(cause)}). It may still land: nothing new was started. Check that swap, then fix or remove the file.`);
  }
}

/** An earlier swap from this wallet may still land and must be settled first. */
export class PendingSwapError extends Error {
  readonly signatures: string[];
  constructor(signatures: string[]) {
    super(`An earlier swap from this wallet may still land (${signatures.join(', ')}): settle it first. Nothing new was sent.`);
    this.signatures = signatures;
  }
}

/** Storage for signed swaps awaiting an outcome; must survive process restarts. */
export type PendingStore = {
  put(signed: Signed): Promise<void>;
  remove(signature: string): Promise<void>;
  list(): Promise<Signed[]>;
};

/** An order found by its transaction signature. */
export type FoundOrder = { id: string; record: OrderRecord; recordedAt: number };

/** Age after which a retry marker may be considered abandoned. */
const RETRY_MARKER_STALE_MS = 60_000;

/** File-backed store in `dir` (owner-only). Writes are atomic: temp file, fsync, rename. */
export function createFileStore(dir: string): PendingStore & OrderBook & SpendLog & { orderBySignature(signature: string): Promise<FoundOrder | null> } {
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch (e) {
    throw new ConfigError(`The state directory ${dir} cannot be made (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); nothing was started. Fix it first.`);
  }
  ownStateDir(dir);
  const file = (signature: string) => join(dir, `pending-${signature}.json`);
  // Ids are caller text, so the file name uses their hash.
  const orderFile = (id: string) => join(dir, `order-${createHash('sha256').update(id).digest('hex').slice(0, 40)}.json`);
  /** Exclusively creates `path` and fsyncs it. */
  const writeDurably = (path: string, text: string) => {
    const fd = openSync(path, 'wx', FILE_MODE);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  /** Renames into place and fsyncs the directory. */
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
  /** True when a retry marker is stale and no worker can still be using it. */
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
        // An unreadable pending record may belong to this order.
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
      // One retry per prior attempt: the first worker to create the marker wins.
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
        // A marker from a crashed worker would block the order forever; take it over only when it is
        // stale, the order is unchanged and no pending swap exists for it. The rename makes this atomic.
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
      // Prune spends older than two days, measured also from the newest spend so a clock jump
      // forward cannot erase spends and reset the daily limit.
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
          // Not an order record.
        }
      }
      return null;
    },
    async list() {
      return readdirSync(dir).filter(f => f.startsWith('pending-') && f.endsWith('.json')).map(f => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        } catch (e) {
          // An unreadable record may still land, so it must not be treated as absent.
          throw new PendingUnreadableError(join(dir, f), e);
        }
        const json = parsed as Omit<Signed, 'lastValidBlockHeight' | 'signedHeight'> & { lastValidBlockHeight: string; signedHeight?: string };
        return {
          ...json, lastValidBlockHeight: BigInt(json.lastValidBlockHeight),
          ...(json.signedHeight !== undefined ? { signedHeight: BigInt(json.signedHeight) } : {}),
        } as Signed;
      });
    },
  };
}

/**
 * Records an order's outcome unless the order now names a newer attempt (returns false then).
 * Callers hold the wallet lock, so the read and write are not raced.
 */
export async function settleOrder(orders: OrderBook, id: string, record: OrderRecord): Promise<boolean> {
  const now = await orders.order(id);
  if (now && now.signature !== record.signature) return false;
  await orders.recordOrder(id, record);
  return true;
}

/** True for outcomes where the swap moved no funds, so its spend no longer counts. */
export const movedNothing = (outcome: string) => outcome === 'failed' || outcome === 'expired' || outcome === 'rejected';

/**
 * Confirms each pending swap on chain and removes those with a final outcome. Do not start a new swap
 * while `unknown` is non-empty; settle swaps that can no longer be proven with `resolvePending`.
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
      // Update the order before removing the pending record.
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
 * Manually settles a pending swap the chain can no longer prove. An on-chain status takes precedence;
 * refused while the transaction could still land. A manual settle keeps its spend counted.
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
