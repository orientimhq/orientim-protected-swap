/** Wallet signing and on-chain outcome checks. Outcomes come from your RPC, never from the server. */
import { getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder, verifySignature } from '@solana/kit';
import type { Address, Rpc, SignatureBytes, SignatureDictionary, SolanaRpcApi, Transaction, TransactionPartialSigner } from '@solana/kit';
import type { SendTransaction } from './api.ts';
import { sameBytes, wait, withinTime } from './util.ts';
import { pastProof, provesNeverLanded } from './verify.ts';

/** Minimum blocks of lifetime (of 150, roughly 60–90 s) left to finalize; otherwise prepare again. */
export const MIN_BLOCKS_TO_FINALIZE = 30n;

/** Blocks your RPC may trail the server's RPC; applied so the expiry bound never relies on the server alone. */
export const LAG_BLOCKS = 25n;

/**
 * Last block a stored swap can land in, capped at `signedHeight + 150 + LAG_BLOCKS` so an overstated
 * server value cannot block the wallet's next swap indefinitely.
 */
export function lastBlockOf(s: { lastValidBlockHeight: bigint; signedHeight?: bigint }): bigint {
  if (s.signedHeight === undefined) return s.lastValidBlockHeight;
  const bound = s.signedHeight + 150n + LAG_BLOCKS;
  return s.lastValidBlockHeight < bound ? s.lastValidBlockHeight : bound;
}

/**
 * Any @solana/kit transaction signer, e.g. a `KeyPairSigner` or `signerFromSignBytes`/`signerFromSignTransaction`.
 * Only its own signature is used, and only after it verifies against the checked message.
 */
export type WalletSigner = TransactionPartialSigner;

/** Signs a base64 transaction as `wallet` and returns it base64-encoded; throws if the signature does not verify. */
export async function signAsWallet(wallet: WalletSigner, transaction: string): Promise<string> {
  const tx = getTransactionDecoder().decode(Buffer.from(transaction, 'base64'));
  const [signatures] = await wallet.signTransactions([tx as never]);
  const signature = signatures?.[wallet.address];
  if (!signature || !await verifySignature(await getPublicKeyFromAddress(wallet.address), signature, tx.messageBytes)) {
    throw new Error(`Not sending: the wallet returned no valid signature from ${wallet.address} for this transaction.`);
  }
  return Buffer.from(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, [wallet.address]: signature } })).toString('base64');
}

/** Wraps a raw ed25519 signer (KMS, HSM): `sign` gets the verified message bytes and returns a 64-byte signature. */
export function signerFromSignBytes(address: string, sign: (message: Uint8Array) => Promise<Uint8Array>): WalletSigner {
  return {
    address: address as Address,
    signTransactions: transactions => Promise.all(transactions.map(async tx =>
      ({ [address]: (await sign(new Uint8Array(tx.messageBytes))) as SignatureBytes }) as SignatureDictionary)),
  };
}

/**
 * Wraps a service that signs a base64 transaction and returns it unsent. Any change to the message is
 * rejected, since Orientim co-signs only the verified message. Sign-and-send services are unsupported.
 */
export function signerFromSignTransaction(address: string, sign: (transaction: string) => Promise<string>): WalletSigner {
  return {
    address: address as Address,
    signTransactions: transactions => Promise.all(transactions.map(async tx => {
      const back = getTransactionDecoder().decode(Buffer.from(await sign(Buffer.from(getTransactionEncoder().encode(tx)).toString('base64')), 'base64'));
      if (!sameBytes(back.messageBytes, tx.messageBytes)) throw new Error('The signing service changed the transaction. Nothing was signed or sent.');
      const signature = back.signatures[address as Address];
      if (!signature) throw new Error(`The signing service returned no signature from ${address}. Nothing was sent.`);
      return { [address]: signature } as SignatureDictionary;
    })),
  };
}

/**
 * Swap outcome. `expired` is proven never to land; `unknown` may still be on chain and must be
 * resolved (`resolvePending`) before another swap.
 */
export type Outcome = 'confirmed' | 'failed' | 'expired' | 'unknown';

type StatusState = { confirmationStatus?: string | null; err?: unknown } | null;

/** Reads a signature's status from full history, plus the node's finalized and reachable heights (see `provesNeverLanded`). */
export async function lookUp(rpc: Rpc<SolanaRpcApi>, signature: string, bounded: () => { abortSignal: AbortSignal }) {
  const finalized = await rpc.getEpochInfo({ commitment: 'finalized' }).send(bounded());
  const { context, value: [status] } = await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send(bounded());
  const height = (finalized as { blockHeight?: bigint | number }).blockHeight;
  const ahead = BigInt(context.slot) - BigInt(finalized.absoluteSlot);
  const covered = height !== undefined && ahead >= 0n;
  return {
    status: (status ?? null) as StatusState,
    view: { coveredHeight: covered ? BigInt(height) : null, reachHeight: covered ? BigInt(height) + ahead : null },
  };
}

/** Returns the temporary authority E: the second of exactly two signers (the wallet pays and signs first). */
export function temporaryAuthorityOf(signedTransaction: string): string | undefined {
  try {
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(signedTransaction, 'base64')).messageBytes);
    const signers = message.staticAccounts.slice(0, message.header.numSignerAccounts);
    return signers.length === 2 ? signers[1] : undefined;
  } catch {
    return undefined;
  }
}

/** A full page may be truncated, so it proves nothing about absent signatures. */
const ARCHIVE_PAGE = 1_000;
/** Required archive history before expiry, in blocks: twice the 150-block lifetime. */
const ARCHIVE_REACH_BLOCKS = 300n;

/**
 * Proves an outcome using the owner's archive RPC (`ORIENTIM_ARCHIVE_RPC_URL`). Returns null when nothing is proven.
 * Expiry requires no status, a finalized height past the lifetime, history covering every possible landing
 * block, and no matching signature for the one-time key E.
 */
async function archiveOutcome(
  archive: Rpc<SolanaRpcApi>, signature: string, temporaryAuthority: string, lastValidBlockHeight: bigint,
  bounded: () => { abortSignal: AbortSignal },
): Promise<'expired' | 'confirmed' | { err: unknown } | null> {
  const { value: [status] } = await archive.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send(bounded());
  if (status) {
    if (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized') return null;
    return status.err ? { err: status.err } : 'confirmed';
  }
  const finalized = await archive.getEpochInfo({ commitment: 'finalized' }).send(bounded());
  const height = (finalized as { blockHeight?: bigint | number }).blockHeight;
  if (height === undefined || BigInt(height) <= lastValidBlockHeight) return null;
  // A trimmed history proves nothing, so check how far back it actually reaches.
  const first = await archive.getFirstAvailableBlock().send(bounded());
  const oldest = await archive.getBlock(BigInt(first), {
    commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0,
  }).send(bounded());
  const oldestHeight = (oldest as { blockHeight?: bigint | number | null } | null)?.blockHeight;
  if (oldestHeight === undefined || oldestHeight === null || BigInt(oldestHeight) > lastValidBlockHeight - ARCHIVE_REACH_BLOCKS) return null;
  const listed = await archive.getSignaturesForAddress(temporaryAuthority as Address, {
    commitment: 'finalized', minContextSlot: BigInt(finalized.absoluteSlot), limit: ARCHIVE_PAGE,
  }).send(bounded());
  return listed.length < ARCHIVE_PAGE && !listed.some(x => x.signature === signature) ? 'expired' : null;
}

/**
 * Polls your RPC until the transaction confirms, fails, provably expires, or `maxWaitMs` passes,
 * re-broadcasting `signedTransaction` if given. Only `confirmed`/`finalized` statuses count, since
 * `processed` may be on a fork.
 *
 * `expired` requires two consistent proofs and `earliestHeight` (your RPC's height at signing);
 * otherwise the result is `unknown`. An `archive` RPC with `temporaryAuthority` can prove expiry
 * after your RPC's status cache no longer can.
 */
export async function confirm(
  rpc: Rpc<SolanaRpcApi>,
  signature: string,
  lastValidBlockHeight: bigint,
  opts: {
    signedTransaction?: string; pollMs?: number; maxWaitMs?: number; requestTimeoutMs?: number; earliestHeight?: bigint; onFailed?: (err: unknown) => void;
    archive?: Rpc<SolanaRpcApi>; temporaryAuthority?: string;
    /** Custom re-broadcast for `signedTransaction`; defaults to your RPC's sendTransaction. */
    send?: SendTransaction;
  } = {},
): Promise<Outcome> {
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + (opts.maxWaitMs ?? 180_000);
  const bounded = () => ({ abortSignal: AbortSignal.timeout(Math.max(1, Math.min(opts.requestTimeoutMs ?? 10_000, deadline - Date.now()))) });
  const settled = (s: { confirmationStatus?: string | null } | null | undefined) =>
    !!s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized');
  const earliest = opts.earliestHeight;
  const failed = (err: unknown) => { opts.onFailed?.(err); return 'failed' as const; };
  let pastLifetime = false;
  let empty = 0;
  let unprovable = 0;
  let archived = 0;
  const canAskArchive = !!opts.archive && !!opts.temporaryAuthority;
  let lastSend = 0;
  const resend = async () => {
    lastSend = Date.now();
    // Bounded like every read so a hung sender cannot outlast the deadline.
    if (opts.send) await withinTime(Promise.resolve().then(() => opts.send!(opts.signedTransaction!)), bounded().abortSignal).catch(() => undefined);
    else await rpc.sendTransaction(opts.signedTransaction as never, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send(bounded()).catch(() => undefined);
  };
  while (Date.now() < deadline) {
    let read = false;
    try {
      // With a custom sender, nothing has been broadcast yet, so send before the first read.
      if (!pastLifetime && opts.signedTransaction && opts.send && lastSend === 0) await resend();
      if (!pastLifetime) {
        const [{ value: [status] }, height] = await Promise.all([
          rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: false }).send(bounded()),
          rpc.getBlockHeight({ commitment: 'confirmed' }).send(bounded()),
        ]);
        if (settled(status)) return status!.err ? failed(status!.err) : 'confirmed';
        if (height > lastValidBlockHeight) pastLifetime = true;
        else if (opts.signedTransaction && Date.now() - lastSend > 3_000) await resend();
        read = !pastLifetime;
      } else {
        // Past its lifetime: check the full history.
        const { status: late, view } = await lookUp(rpc, signature, bounded);
        if (settled(late)) return late!.err ? failed(late!.err) : 'confirmed';
        if (late) read = true;
        else {
          if (earliest !== undefined && provesNeverLanded(view, lastValidBlockHeight, earliest) && ++empty >= 2) return 'expired';
          const over = view.coveredHeight !== null && view.coveredHeight > lastValidBlockHeight;
          // Once "no record" can no longer prove expiry, stop waiting unless an archive can.
          if (over && (earliest === undefined || pastProof(view, earliest)) && ++unprovable >= (canAskArchive ? 3 : 2)) return 'unknown';
        }
      }
    } catch {
      // A failed read says nothing about the transaction; retry until the deadline.
    }
    // Fall back to the owner's archive when your RPC cannot answer or prove the outcome.
    if (!read && canAskArchive) {
      const proven = await archiveOutcome(opts.archive!, signature, opts.temporaryAuthority!, lastValidBlockHeight, bounded).catch(() => null);
      if (proven === 'expired' && ++archived >= 2) return 'expired';
      if (proven && proven !== 'expired') return proven === 'confirmed' ? 'confirmed' : failed(proven.err);
    }
    await wait(Math.max(0, Math.min(pastLifetime ? pollMs * 2 : pollMs, deadline - Date.now())));
  }
  return 'unknown';
}

/** Returns true if `wire` is exactly the transaction the wallet signed, with a valid signature from E. */
export async function isThisTransaction(wire: string, mine: Transaction, temporaryAuthority: string): Promise<boolean> {
  try {
    const tx = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
    if (!sameBytes(tx.messageBytes, mine.messageBytes)) return false;
    if (getSignatureFromTransaction(tx) !== getSignatureFromTransaction(mine)) return false;
    const e = tx.signatures[temporaryAuthority as Address];
    return !!e && await verifySignature(await getPublicKeyFromAddress(temporaryAuthority as Address), e, tx.messageBytes);
  } catch {
    return false;
  }
}
