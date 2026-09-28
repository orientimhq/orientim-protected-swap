import { isSolanaError, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED } from '@solana/kit';
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import type { AccountState } from '@orientim/core';

/**
 * What the skill reads from the chain: accounts at a known slot, and whether a signature's missing
 * record proves anything. Sending, simulating and the one-time key are Orientim's server and page
 * (the bound repository), not the skill's.
 */
export type SolanaRpc = Rpc<SolanaRpcApi>;

const MAX_ACCOUNTS_PER_CALL = 100;

const decodeBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

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
