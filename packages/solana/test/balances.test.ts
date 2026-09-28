import { describe, expect, it } from 'vitest';
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage, generateKeyPairSigner, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { Address, Blockhash } from '@solana/kit';
import { accountKeysOf, balancesAfterSimulation } from '../src/index.ts';

const fresh = async () => (await generateKeyPairSigner()).address;

/** A v0 transaction naming a payer, a program and four accounts, two of them loaded from a table. */
async function withTable() {
  const [payer, program, stat, table, loadedW, loadedR] = await Promise.all(Array.from({ length: 6 }, fresh));
  const tables: Record<string, Address[]> = { [table]: [loadedR, loadedW] };
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 1n }, m),
    m => appendTransactionMessageInstructions([{
      programAddress: program,
      accounts: [
        { address: stat, role: AccountRole.WRITABLE },
        { address: loadedW, role: AccountRole.WRITABLE },
        { address: loadedR, role: AccountRole.READONLY },
      ],
    }], m),
    m => compressTransactionMessageUsingAddressLookupTables(m, tables),
  );
  return { transaction: compileTransaction(message), tables, payer, stat, loadedW, loadedR, table };
}

describe('balances after a simulation, from postBalances', () => {
  it('match the accounts in the runtime order: static, then loaded writable, then loaded read-only', async () => {
    const t = await withTable();
    const order = accountKeysOf(t.transaction, t.tables)!;
    expect(order.writable).toEqual([t.loadedW]);
    expect(order.readonly).toEqual([t.loadedR]);
    expect(order.keys.slice(-2)).toEqual([t.loadedW, t.loadedR]);
    const post = order.keys.map((_, i) => BigInt(i + 1));
    const balances = balancesAfterSimulation(t.transaction, { postBalances: post, loadedAddresses: { writable: [t.loadedW], readonly: [t.loadedR] } }, t.tables);
    expect(balances).toBeInstanceOf(Map);
    const m = balances as Map<string, bigint>;
    expect(m.get(t.payer)).toBe(1n);
    expect(m.get(t.loadedW)).toBe(BigInt(order.keys.length - 1));
    expect(m.get(t.loadedR)).toBe(BigInt(order.keys.length));
  });

  it('are refused when missing, for another number of accounts, or loaded from other table entries', async () => {
    const t = await withTable();
    const n = accountKeysOf(t.transaction, t.tables)!.keys.length;
    const loaded = { writable: [t.loadedW], readonly: [t.loadedR] };
    expect(balancesAfterSimulation(t.transaction, { postBalances: null, loadedAddresses: loaded }, t.tables)).toMatch(/did not report the balances/);
    expect(balancesAfterSimulation(t.transaction, { loadedAddresses: loaded }, t.tables)).toMatch(/did not report the balances/);
    expect(balancesAfterSimulation(t.transaction, { postBalances: Array(n - 1).fill(0n), loadedAddresses: loaded }, t.tables)).toMatch(/reported \d+ balances for \d+ accounts/);
    expect(balancesAfterSimulation(t.transaction, { postBalances: Array(n + 1).fill(0n), loadedAddresses: loaded }, t.tables)).toMatch(/reported \d+ balances for \d+ accounts/);
    // The same addresses in another order, none at all, or a table the check could not read.
    const swapped = { writable: [t.loadedR], readonly: [t.loadedW] };
    expect(balancesAfterSimulation(t.transaction, { postBalances: Array(n).fill(0n), loadedAddresses: swapped }, t.tables)).toMatch(/other accounts from the lookup tables/);
    expect(balancesAfterSimulation(t.transaction, { postBalances: Array(n).fill(0n), loadedAddresses: null }, t.tables)).toMatch(/other accounts from the lookup tables/);
    expect(balancesAfterSimulation(t.transaction, { postBalances: Array(n).fill(0n), loadedAddresses: loaded }, {})).toMatch(/could not be read/);
    expect(balancesAfterSimulation(t.transaction, { postBalances: Array(n).fill(0n), loadedAddresses: loaded }, { [t.table]: [t.loadedR] })).toMatch(/could not be read/);
    expect(balancesAfterSimulation(t.transaction, { postBalances: [...Array(n - 1).fill(0n), 'x' as never], loadedAddresses: loaded }, t.tables)).toMatch(/not a number/);
  });
});
