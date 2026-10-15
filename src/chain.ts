/**
 * Signing as the wallet, and the chain as the only witness: what a signed swap's outcome is, read for
 * its own signature on your RPC, whatever finalize answers.
 */
import { getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder, verifySignature } from '@solana/kit';
import type { Address, Rpc, SignatureBytes, SignatureDictionary, SolanaRpcApi, Transaction, TransactionPartialSigner } from '@solana/kit';
import type { SendTransaction } from './api.ts';
import { sameBytes, wait, withinTime } from './util.ts';
import { pastProof, provesNeverLanded } from './verify.ts';

/**
 * The transaction lives 150 blocks, about a minute (60 s at 400 ms a block, more when slots are skipped). Finalize only with this many
 * left, so that it can still land; otherwise prepare again.
 */
export const MIN_BLOCKS_TO_FINALIZE = 30n;

/**
 * How far your RPC may trail the one Orientim read the blockhash from, in blocks. The last block the
 * transaction can land in is taken on your own clock with this margin, never from the server alone.
 */
export const LAG_BLOCKS = 25n;

/**
 * The last block a kept swap can land in. Its blockhash lives 150 blocks and is older than the height
 * the wallet signed at, so a stated block beyond that bound (a record a server overstated before this
 * check existed) cannot hold the wallet's next swap back for good.
 */
export function lastBlockOf(s: { lastValidBlockHeight: bigint; signedHeight?: bigint }): bigint {
  if (s.signedHeight === undefined) return s.lastValidBlockHeight;
  const bound = s.signedHeight + 150n + LAG_BLOCKS;
  return s.lastValidBlockHeight < bound ? s.lastValidBlockHeight : bound;
}

/**
 * The wallet: whatever signs a transaction for one address the way @solana/kit's signers do. A
 * `KeyPairSigner` from a keypair file is one; a wallet held by a signing service is another, through
 * `signerFromSignBytes` or `signerFromSignTransaction`. Only its signature for its own address is
 * used, and only once it verifies against the exact message that was checked.
 */
export type WalletSigner = TransactionPartialSigner;

export async function signAsWallet(wallet: WalletSigner, transaction: string): Promise<string> {
  const tx = getTransactionDecoder().decode(Buffer.from(transaction, 'base64'));
  const [signatures] = await wallet.signTransactions([tx as never]);
  const signature = signatures?.[wallet.address];
  if (!signature || !await verifySignature(await getPublicKeyFromAddress(wallet.address), signature, tx.messageBytes)) {
    throw new Error(`Not sending: the wallet returned no valid signature from ${wallet.address} for this transaction.`);
  }
  return Buffer.from(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, [wallet.address]: signature } })).toString('base64');
}

/**
 * A wallet held by a service that signs raw bytes with its ed25519 key (a KMS or HSM, or a signing
 * service's raw-payload call): `sign` receives the transaction's message and returns the 64-byte
 * signature. The message is all that leaves your process, and it is the one the check verified.
 */
export function signerFromSignBytes(address: string, sign: (message: Uint8Array) => Promise<Uint8Array>): WalletSigner {
  return {
    address: address as Address,
    signTransactions: transactions => Promise.all(transactions.map(async tx =>
      ({ [address]: (await sign(new Uint8Array(tx.messageBytes))) as SignatureBytes }) as SignatureDictionary)),
  };
}

/**
 * A wallet held by a service that signs whole transactions and hands them back without sending
 * them (base64 in, base64 out). Its answer counts only when it is this very transaction: a service
 * that changes one byte (a priority fee, a new blockhash, an instruction of its own) is refused, since
 * Orientim co-signs only the message it built and your check verified. A service that can only sign
 * and send cannot be used: Orientim's signature comes last.
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
 * `expired`: it did not land and can no longer land. `unknown`: no outcome could be proven; it may
 * be on chain, so look it up before any new swap (`resolvePending` once you have).
 */
export type Outcome = 'confirmed' | 'failed' | 'expired' | 'unknown';

type StatusState = { confirmationStatus?: string | null; err?: unknown } | null;

/**
 * One look at the chain: the signature's status from full history, with the finalized height the
 * answering node had reached and the highest height it can have reached (see `provesNeverLanded`).
 */
export async function lookUp(rpc: Rpc<SolanaRpcApi>, signature: string, bounded: () => { abortSignal: AbortSignal }) {
  // The finalized slot and height in one answer, then the full history from a node that had reached that slot.
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

/** E, the transaction's other signer: the wallet pays, so it signs first, and there are exactly two. */
export function temporaryAuthorityOf(signedTransaction: string): string | undefined {
  try {
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(signedTransaction, 'base64')).messageBytes);
    const signers = message.staticAccounts.slice(0, message.header.numSignerAccounts);
    return signers.length === 2 ? signers[1] : undefined;
  } catch {
    return undefined;
  }
}

/** A list this long may be cut: it proves nothing about what is not on it. */
const ARCHIVE_PAGE = 1_000;
/**
 * How far before the end of its lifetime a transaction could have landed, in blocks: its lifetime is
 * 150 blocks, and this is twice that, to spare. The archive's history must reach back this far.
 */
const ARCHIVE_REACH_BLOCKS = 300n;

/**
 * The second proof that a transaction never landed, from an RPC with the chain's full history that
 * the owner named (`ORIENTIM_ARCHIVE_RPC_URL`): its finalized height is past the lifetime, it has no
 * status for the signature, and the one-time key E, which no other transaction of Orientim's signs,
 * lists no such signature at a slot at least as late. Its confirmed status, if it has one, is the
 * outcome instead. Null when it proves nothing. Used when your RPC does not answer, or can no longer
 * prove it (`confirm`). An archive whose history does not reach back to every block the transaction
 * could have landed in (its first available block, read here) proves nothing: an RPC that trims its
 * history is asked and found too short, never taken at its word.
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
  // Its history reaches back before the transaction could first land, or its silence proves nothing.
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
 * Settles one transaction on your own RPC, by its signature, until it lands, can no longer land, or
 * `maxWaitMs` passes. With `signedTransaction` (the fully signed bytes, checked to be this very
 * transaction), it re-broadcasts every few seconds: the same bytes land at most once. Only a confirmed
 * status is an outcome, since an error seen at `processed` may be on a fork.
 *
 * `expired` needs one coherent view, twice: a finalized height past the lifetime, no record in the
 * full history from a node that had reached that height's slot, and that node's status cache still
 * holding every block the transaction could have landed in, from `earliestHeight` (your RPC's height
 * when you signed) on. Older than that, "no record" may only mean a pruned history or an archive that
 * failed, so the outcome stays `unknown` and is returned as soon as that is clear.
 * Without `earliestHeight` nothing is proven expired. Every request is bounded by what is left of
 * `maxWaitMs`, so one that never answers cannot hold the agent past it.
 *
 * With `archive` (an RPC with the full history, that the owner names) and `temporaryAuthority`, a
 * swap past that window can still be proven expired, twice as well (`archiveProvesNeverLanded`):
 * a bot whose RPC was down while the status cache could prove it is not left with `unknown`.
 */
export async function confirm(
  rpc: Rpc<SolanaRpcApi>,
  signature: string,
  lastValidBlockHeight: bigint,
  opts: {
    signedTransaction?: string; pollMs?: number; maxWaitMs?: number; requestTimeoutMs?: number; earliestHeight?: bigint; onFailed?: (err: unknown) => void;
    archive?: Rpc<SolanaRpcApi>; temporaryAuthority?: string;
    /** How `signedTransaction` is re-broadcast (`SendTransaction`); your RPC's sendTransaction otherwise. */
    send?: SendTransaction;
  } = {},
): Promise<Outcome> {
  // A little over a slot: a confirmation is seen within half a second of landing.
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
    // Your sender is held to the same time as every read: one that never answers cannot hold the
    // wait past its deadline. The same bytes are sent again later; the chain says the outcome.
    if (opts.send) await withinTime(Promise.resolve().then(() => opts.send!(opts.signedTransaction!)), bounded().abortSignal).catch(() => undefined);
    else await rpc.sendTransaction(opts.signedTransaction as never, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send(bounded()).catch(() => undefined);
  };
  while (Date.now() < deadline) {
    // A failed read says nothing about the transaction: keep reading until the deadline.
    let read = false;
    try {
      // Sent by you alone (Orientim signed and sent nothing): the first send goes at once, before
      // anything is read. When Orientim sent it, the first read comes first: it has usually landed.
      if (!pastLifetime && opts.signedTransaction && opts.send && lastSend === 0) await resend();
      if (!pastLifetime) {
        // Read together: a height past the lifetime only sends the next look to the full history, which
        // finds the transaction there if it landed meanwhile.
        const [{ value: [status] }, height] = await Promise.all([
          rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: false }).send(bounded()),
          rpc.getBlockHeight({ commitment: 'confirmed' }).send(bounded()),
        ]);
        if (settled(status)) return status!.err ? failed(status!.err) : 'confirmed';
        if (height > lastValidBlockHeight) pastLifetime = true;
        else if (opts.signedTransaction && Date.now() - lastSend > 3_000) await resend();
        read = !pastLifetime;
      } else {
        // It can no longer be included: one coherent view of the full history.
        const { status: late, view } = await lookUp(rpc, signature, bounded);
        if (settled(late)) return late!.err ? failed(late!.err) : 'confirmed';
        if (late) read = true;
        else {
          if (earliest !== undefined && provesNeverLanded(view, lastValidBlockHeight, earliest) && ++empty >= 2) return 'expired';
          const over = view.coveredHeight !== null && view.coveredHeight > lastValidBlockHeight;
          // Past the window in which "no record" proves anything, waiting longer proves nothing either,
          // unless the owner's archive can prove it (below).
          if (over && (earliest === undefined || pastProof(view, earliest)) && ++unprovable >= (canAskArchive ? 3 : 2)) return 'unknown';
        }
      }
    } catch {
      // keep reading
    }
    // Your RPC did not answer, or no longer can prove it: the owner's archive, if one was named.
    if (!read && canAskArchive) {
      const proven = await archiveOutcome(opts.archive!, signature, opts.temporaryAuthority!, lastValidBlockHeight, bounded).catch(() => null);
      if (proven === 'expired' && ++archived >= 2) return 'expired';
      if (proven && proven !== 'expired') return proven === 'confirmed' ? 'confirmed' : failed(proven.err);
    }
    await wait(Math.max(0, Math.min(pastLifetime ? pollMs * 2 : pollMs, deadline - Date.now())));
  }
  return 'unknown';
}

/** Is `wire` the very transaction your wallet signed, now carrying a valid signature from E too? */
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
