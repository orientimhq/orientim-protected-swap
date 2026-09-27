import { isSignerRole, isWritableRole } from '@solana/kit';
import type { AccountRole, Address } from '@solana/kit';
import {
  ATA_PROGRAM, CLOSE_USER_VOLUME_ACCUMULATOR, COMPUTE_BUDGET_PROGRAM, PUMP_AMM_PROGRAM, PUMP_CURVE_PROGRAM, SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
} from '@orientim/core/constants';

export type Account = { address: Address; role: AccountRole };
export type RawInstruction = {
  programAddress: Address;
  accounts?: readonly Account[];
  data?: Uint8Array | { readonly [n: number]: number; readonly length: number };
};

/**
 * Every trusted instruction the protected transaction may contain, decoded field by field.
 * Anything that does not match one of these shapes exactly is `invalid` (unknown semantics ⇒ reject).
 */
export type Parsed =
  | { kind: 'cuLimit'; units: number }
  | { kind: 'cuPrice'; microLamports: bigint }
  | { kind: 'createAta'; payer: Address; ata: Address; owner: Address; mint: Address; tokenProgram: Address }
  | { kind: 'transferChecked'; program: Address; source: Address; mint: Address; destination: Address; authority: Address; amount: bigint; decimals: number }
  | { kind: 'systemTransfer'; from: Address; to: Address; lamports: bigint }
  | { kind: 'syncNative'; account: Address }
  | { kind: 'revoke'; program: Address; source: Address; owner: Address }
  | { kind: 'close'; program: Address; account: Address; destination: Address; owner: Address }
  | { kind: 'harvest'; program: Address; mint: Address; sources: readonly Address[] }
  | { kind: 'closeRouteAccount'; program: Address; user: Address; account: Address; eventAuthority: Address }
  | { kind: 'external'; program: Address; accounts: readonly Account[]; data: Uint8Array }
  | { kind: 'invalid'; program: Address; reason: string };

const bytes = (d: RawInstruction['data']): Uint8Array => (d ? Uint8Array.from(d as ArrayLike<number>) : new Uint8Array());
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

const signerWritable = (a: Account) => isSignerRole(a.role) && isWritableRole(a.role);

export function parseInstruction(ix: RawInstruction): Parsed {
  const program = ix.programAddress;
  const data = bytes(ix.data);
  const acc = ix.accounts ?? [];
  const invalid = (reason: string): Parsed => ({ kind: 'invalid', program, reason });

  if (program === COMPUTE_BUDGET_PROGRAM) {
    if (acc.length !== 0) return invalid('ComputeBudget instruction with accounts');
    if (data[0] === 2 && data.length === 5) return { kind: 'cuLimit', units: view(data).getUint32(1, true) };
    if (data[0] === 3 && data.length === 9) return { kind: 'cuPrice', microLamports: view(data).getBigUint64(1, true) };
    return invalid(`ComputeBudget instruction ${data[0]}`);
  }

  if (program === ATA_PROGRAM) {
    if (data.length !== 1 || data[0] !== 1) return invalid('ATA instruction other than CreateIdempotent');
    if (acc.length !== 6) return invalid('CreateIdempotent with unexpected accounts');
    const [payer, ata, owner, mint, system, tokenProgram] = acc;
    if (!signerWritable(payer) || !isWritableRole(ata.role)) return invalid('CreateIdempotent with wrong account roles');
    if (system.address !== SYSTEM_PROGRAM) return invalid('CreateIdempotent with wrong system program');
    if (tokenProgram.address !== TOKEN_PROGRAM && tokenProgram.address !== TOKEN_2022_PROGRAM) {
      return invalid('CreateIdempotent with unknown token program');
    }
    return { kind: 'createAta', payer: payer.address, ata: ata.address, owner: owner.address, mint: mint.address, tokenProgram: tokenProgram.address };
  }

  if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
    const disc = data[0];
    // Exactly four accounts. A Token-2022 mint with a transfer hook needs more, and such a mint
    // is refused anyway (R7), so anything longer is not a transfer we understand.
    if (disc === 12 && data.length === 10 && acc.length === 4) {
      const [source, mint, destination, authority] = acc;
      if (!isWritableRole(source.role) || !isWritableRole(destination.role) || !isSignerRole(authority.role)) {
        return invalid('TransferChecked with wrong account roles');
      }
      return {
        kind: 'transferChecked', program, source: source.address, mint: mint.address, destination: destination.address,
        authority: authority.address, amount: view(data).getBigUint64(1, true), decimals: data[9],
      };
    }
    if (disc === 9 && data.length === 1 && acc.length === 3) {
      const [account, destination, owner] = acc;
      if (!isWritableRole(account.role) || !isWritableRole(destination.role) || !isSignerRole(owner.role)) {
        return invalid('CloseAccount with wrong account roles');
      }
      return { kind: 'close', program, account: account.address, destination: destination.address, owner: owner.address };
    }
    // TransferFee extension (26), HarvestWithheldTokensToMint (4): permissionless, no amount.
    // [mint, ...accounts to harvest]. Without it, an account holding withheld fees cannot close.
    if (disc === 26 && data.length === 2 && data[1] === 4 && program === TOKEN_2022_PROGRAM) {
      if (acc.length < 2) return invalid('Harvest without accounts');
      if (acc.some(a => !isWritableRole(a.role))) return invalid('Harvest with a read-only account');
      return { kind: 'harvest', program, mint: acc[0].address, sources: acc.slice(1).map(a => a.address) };
    }
    if (disc === 5 && data.length === 1 && acc.length === 2) {
      const [source, owner] = acc;
      if (!isWritableRole(source.role) || !isSignerRole(owner.role)) return invalid('Revoke with wrong account roles');
      return { kind: 'revoke', program, source: source.address, owner: owner.address };
    }
    if (disc === 17 && data.length === 1 && acc.length === 1 && program === TOKEN_PROGRAM) {
      if (!isWritableRole(acc[0].role)) return invalid('SyncNative on a read-only account');
      return { kind: 'syncNative', account: acc[0].address };
    }
    return invalid(`Token instruction ${disc} (${data.length} bytes, ${acc.length} accounts)`);
  }

  if (program === SYSTEM_PROGRAM) {
    if (data.length === 12 && view(data).getUint32(0, true) === 2 && acc.length === 2) {
      const [from, to] = acc;
      if (!signerWritable(from) || !isWritableRole(to.role)) return invalid('System transfer with wrong account roles');
      return { kind: 'systemTransfer', from: from.address, to: to.address, lamports: view(data).getBigUint64(4, true) };
    }
    return invalid(`System instruction ${data.length >= 4 ? view(data).getUint32(0, true) : '?'}`);
  }

  // Pump's close_user_volume_accumulator, the one instruction of a market's program Orientim itself
  // places. Exactly its IDL shape; any other Pump instruction outside the route is
  // not one Orientim would write.
  if (program === PUMP_CURVE_PROGRAM || program === PUMP_AMM_PROGRAM) {
    if (data.length !== 8 || CLOSE_USER_VOLUME_ACCUMULATOR.some((b, i) => data[i] !== b) || acc.length !== 4) {
      return invalid('a Pump instruction other than closing the per-buyer account');
    }
    const [user, account, eventAuthority, self] = acc;
    if (
      !signerWritable(user) || !isWritableRole(account.role) || isSignerRole(account.role)
      || isWritableRole(eventAuthority.role) || isSignerRole(eventAuthority.role)
      || self.address !== program || isWritableRole(self.role) || isSignerRole(self.role)
    ) {
      return invalid('close_user_volume_accumulator with wrong accounts or roles');
    }
    return { kind: 'closeRouteAccount', program, user: user.address, account: account.address, eventAuthority: eventAuthority.address };
  }

  return { kind: 'external', program, accounts: acc, data };
}
