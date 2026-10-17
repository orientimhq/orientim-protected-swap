import { describe, expect, it } from 'vitest';
import type { Address, Instruction } from '@solana/kit';
import { JUPITER_PROGRAM } from '@orientim/core';
import { verify } from '../src/index.ts';
import { BONK, compileRaw, cuIxs, honest, randomAddress, scenario, USDC } from './fixtures.ts';

describe('what the verifier takes from the policy and the bytes', () => {
  it('a policy naming another program as Jupiter does not switch off the route checks (R2)', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    const other = await randomAddress();
    (s.snapshot.accounts as Map<string, unknown>).set(other, { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', lamports: 1n, data: new Uint8Array(36) });
    const ixs = honest(s).map(ix => (ix.programAddress === JUPITER_PROGRAM ? { ...ix, programAddress: other, data: new Uint8Array([1, 2, 3]) } as Instruction : ix));
    const v = await verify(compileRaw(s.W, [...cuIxs(), ...ixs], 0, s.lookupTables), { ...s.policy, jupiterProgram: other as Address }, s.snapshot);
    expect(v.ok).toBe(false);
    expect(v.violations.map(x => x.rule)).toContain('R2');
  });

  it('bytes after the message are refused (R5): the wallet signs exactly what was checked', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    const tx = compileRaw(s.W, [...cuIxs(), ...honest(s)], 0, s.lookupTables);
    expect((await verify(tx, s.policy, s.snapshot)).ok).toBe(true);
    const v = await verify({ ...tx, messageBytes: new Uint8Array([...tx.messageBytes, 0xde, 0xad]) } as never, s.policy, s.snapshot);
    expect(v.ok).toBe(false);
    expect(v.violations.map(x => x.rule)).toContain('R5');
  });
});
