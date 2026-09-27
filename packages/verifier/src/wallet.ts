import { getPublicKeyFromAddress, getTransactionDecoder, verifySignature } from '@solana/kit';
import type { Address, Transaction } from '@solana/kit';
import type { Verdict, Violation } from '@orientim/core/types';

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * R6, second half: what the wallet returns must be the verified message, byte for byte, carrying
 * a valid signature from W and no signature from E. Only then does E sign last.
 */
export async function verifyWalletReturn(
  original: Transaction,
  returnedBytes: Uint8Array,
  owner: Address,
  ephemeral: Address,
): Promise<Verdict & { transaction: Transaction | null }> {
  const violations: Violation[] = [];
  const fail = (detail: string) => void violations.push({ rule: 'R6', detail });

  let returned: Transaction;
  try {
    returned = getTransactionDecoder().decode(returnedBytes);
  } catch {
    fail('the wallet returned a transaction that cannot be decoded');
    return { ok: false, violations, transaction: null };
  }

  if (!sameBytes(returned.messageBytes, original.messageBytes)) {
    fail('the wallet changed the transaction message');
  }
  const signers = Object.keys(returned.signatures);
  if (signers.length !== 2 || !signers.includes(owner) || !signers.includes(ephemeral)) {
    fail('the returned transaction has unexpected signers');
  }
  const ownerSignature = returned.signatures[owner];
  if (!ownerSignature) {
    fail('the wallet did not sign');
  } else if (!(await verifySignature(await getPublicKeyFromAddress(owner), ownerSignature, original.messageBytes))) {
    fail("the wallet's signature does not match the verified message");
  }
  if (returned.signatures[ephemeral]) fail('the temporary key was already signed by someone else');

  const ok = violations.length === 0;
  return { ok, violations, transaction: ok ? returned : null };
}
