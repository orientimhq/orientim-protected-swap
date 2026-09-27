/**
 * Regression tests for attacks found by earlier security reviews. They replace the reviewers'
 * proof-of-concept scripts: every attack those reviews showed was ACCEPTED must now be rejected,
 * and every control they ran must keep holding.
 */
import { describe, expect, it } from 'vitest';
import {
  AccountRole, address, createNoopSigner, getAddressEncoder, getTransactionEncoder, getTransactionSize,
} from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import { getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import {
  ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS, ataOf, buildPolicy, compileProtectedSwap, JUPITER_PROGRAM, MAX_FEE_BPS,
  TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT, withMinOut,
} from '@orientim/core';
import type { AccountState, RuleId, TxVersion } from '@orientim/core';
import { memoRequired, verify } from '../src/index.ts';
import { BONK, compileRaw, compileRawV1WithHeap, cuIxs, honest, JUP, LIFETIME, randomAddress, scenario, USDC } from './fixtures.ts';
import type { Scenario } from './fixtures.ts';

const rules = (v: { violations: { rule: RuleId }[] }) => [...new Set(v.violations.map(x => x.rule))];
const accounts = (s: Scenario) => s.snapshot.accounts as Map<string, AccountState | null>;

const compileHonest = (s: Scenario, version: TxVersion = 0) =>
  compileProtectedSwap({
    policy: s.policy, swapInstruction: s.swapIx, intermediates: s.intermediates, version, lifetime: LIFETIME,
    computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, priorityFeeLamports: 20_000n,
    lookupTables: version === 0 ? s.lookupTables : undefined, outputBalanceBefore: s.wOutBalance,
  }).transaction;

const withSwapAccount = (s: Scenario, address: Address, role = AccountRole.WRITABLE): Instruction[] => {
  const ixs = honest(s);
  const i = ixs.findIndex(x => x.programAddress === JUPITER_PROGRAM);
  ixs[i] = { ...ixs[i], accounts: [...(ixs[i].accounts ?? []), { address, role }] };
  return ixs;
};

describe('B-01: the Orientim fee is bounded by the verifier, not by the configuration', () => {
  for (const bps of [5_000n, 9_999n, MAX_FEE_BPS + 1n]) {
    it(`a ${bps} bps fee is rejected even though the policy is self-consistent`, async () => {
      const s = await scenario();
      const evil = await buildPolicy({
        intent: { owner: s.W, inputMint: USDC, outputMint: WSOL_MINT, amountIn: 100_000_000n },
        ephemeral: s.E.address, inputDecimals: 6, outputDecimals: 9, feeAccountExists: true, minOut: 1_000_000n,
        config: { feeBps: bps, treasury: s.treasury, maxNetworkFeeLamports: 200_000n, jupiterProgram: JUPITER_PROGRAM },
      });
      const tx = compileProtectedSwap({
        policy: evil, swapInstruction: s.swapIx, intermediates: [], version: 0, lifetime: LIFETIME,
        computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n, lookupTables: s.lookupTables,
      }).transaction;
      expect(rules(await verify(tx, evil, s.snapshot))).toContain('R2');
    });
  }
});

describe('B-02: F_max is bounded by the verifier, not by the configuration', () => {
  it('a 710,000 lamport fee is rejected even when the policy allows 1 SOL', async () => {
    const s = await scenario();
    const tx = compileRaw(s.W, [...cuIxs(1_400_000, 500_000n), ...honest(s)], 0, s.lookupTables);
    const loose = await verify(tx, { ...s.policy, maxNetworkFeeLamports: 1_000_000_000n }, s.snapshot);
    expect(rules(loose)).toContain('R4');
  });

  it('a configured F_max above the absolute maximum is itself a violation', async () => {
    const s = await scenario();
    const v = await verify(compileHonest(s), { ...s.policy, maxNetworkFeeLamports: ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS + 1n }, s.snapshot);
    expect(v.violations.map(x => x.detail).join(' ')).toMatch(/absolute maximum/);
  });
});

describe('B-03: W_out authorities', () => {
  const OFF = { amount: 64, delegateTag: 72, delegate: 76, delegatedAmount: 121, closeTag: 129, close: 133 };

  it('a delegate on W_out is neutralised by a trusted Revoke before the swap', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    const wOut = s.policy.accounts.wOut!;
    const base = accounts(s).get(wOut)!;
    const d = new Uint8Array(base.data);
    const view = new DataView(d.buffer);
    view.setUint32(OFF.delegateTag, 1, true);
    d.set(getAddressEncoder().encode(await randomAddress()), OFF.delegate);
    view.setBigUint64(OFF.delegatedAmount, 10n ** 12n, true);
    accounts(s).set(wOut, { ...base, data: d });

    const ixs = honest(s);
    const revoke = ixs.findIndex(ix => ix.programAddress === TOKEN_PROGRAM && ix.data?.[0] === 5);
    const swap = ixs.findIndex(ix => ix.programAddress === JUPITER_PROGRAM);
    expect(revoke).toBeGreaterThan(-1);
    expect(revoke).toBeLessThan(swap);
    expect((await verify(compileHonest(s), s.policy, s.snapshot)).ok).toBe(true);
  });

  it('a transaction without the Revoke is rejected', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    const ixs = honest(s).filter(ix => !(ix.programAddress === TOKEN_PROGRAM && ix.data?.[0] === 5));
    expect(rules(await verify(compileRaw(s.W, [...cuIxs(), ...ixs], 0, s.lookupTables), s.policy, s.snapshot))).toContain('R2');
  });

  it('W_out with a close authority is refused', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    const wOut = s.policy.accounts.wOut!;
    const base = accounts(s).get(wOut)!;
    const d = new Uint8Array(base.data);
    new DataView(d.buffer).setUint32(OFF.closeTag, 1, true);
    d.set(getAddressEncoder().encode(await randomAddress()), OFF.close);
    accounts(s).set(wOut, { ...base, data: d });
    const v = await verify(compileHonest(s), s.policy, s.snapshot);
    expect(v.violations.map(x => x.detail)).toContain('W_out has a close authority set');
  });

  it('W_out missing from the snapshot fails closed', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    accounts(s).delete(s.policy.accounts.wOut!);
    expect(rules(await verify(compileHonest(s), s.policy, s.snapshot))).toContain('R1');
  });
});

describe('B-04: Orientim enforces the minimum output itself', () => {
  for (const [name, opts] of [
    ['A: USDC → SOL (check on E_out)', {}],
    ['B: SOL → USDC (check on W_out)', { input: WSOL_MINT, output: USDC }],
    ['C: USDC → BONK, W_out already holds a balance', { input: USDC, output: BONK, wOutBalance: 7_000_000n }],
    ['C: USDC → Token-2022 BONK', { input: USDC, output: BONK, outputProgram: TOKEN_2022_PROGRAM }],
  ] as const) {
    it(`${name}: the honest check is accepted`, async () => {
      const s = await scenario(opts);
      expect((await verify(compileHonest(s), s.policy, s.snapshot)).violations).toEqual([]);
    });
  }

  it('a transaction without the check is rejected', async () => {
    const s = await scenario();
    const ixs = honest(s).filter(ix => !(ix.data?.[0] === 12 && ix.accounts?.[0].address === ix.accounts?.[2].address));
    expect(rules(await verify(compileRaw(s.W, [...cuIxs(), ...ixs], 0, s.lookupTables), s.policy, s.snapshot))).toContain('R2');
  });

  it('a check for less than the policy minimum is rejected', async () => {
    const s = await scenario();
    const weaker = withMinOut(s.policy, s.policy.minOut - 1n);
    const ixs = honest({ ...s, policy: weaker });
    expect(rules(await verify(compileRaw(s.W, [...cuIxs(), ...ixs], 0, s.lookupTables), s.policy, s.snapshot))).toContain('R2');
  });

  it('a check that ignores the existing W_out balance is rejected', async () => {
    const s = await scenario({ input: USDC, output: BONK, wOutBalance: 7_000_000n });
    const ixs = honest({ ...s, wOutBalance: 0n }); // floor would be satisfied by the old balance alone
    expect(rules(await verify(compileRaw(s.W, [...cuIxs(), ...ixs], 0, s.lookupTables), s.policy, s.snapshot))).toContain('R2');
  });

  it('a check placed after E_out is closed is rejected', async () => {
    const s = await scenario();
    const ixs = honest(s);
    const check = ixs.findIndex(ix => ix.data?.[0] === 12 && ix.accounts?.[0].address === s.policy.accounts.eOut);
    const [moved] = ixs.splice(check, 1);
    ixs.push(moved);
    expect(rules(await verify(compileRaw(s.W, [...cuIxs(), ...ixs], 0, s.lookupTables), s.policy, s.snapshot))).toContain('R5');
  });

  it('a policy without a minimum output is rejected', async () => {
    const s = await scenario();
    const v = await verify(compileHonest(s), { ...s.policy, minOut: 0n }, s.snapshot);
    expect(v.violations.map(x => x.detail)).toContain('the policy has no minimum output');
  });
});

describe('Token-2022 MemoTransfer account state', () => {
  const account = (required: number, length = 1) => {
    const data = new Uint8Array(166 + 4 + length);
    data[165] = 2; // AccountType::Account
    const view = new DataView(data.buffer);
    view.setUint16(166, 8, true); // MemoTransfer
    view.setUint16(168, length, true);
    if (length > 0) data[170] = required;
    return data;
  };

  it('allows an account whose memo requirement is present but disabled', () => {
    expect(memoRequired(account(0))).toBe(false);
  });

  it('refuses an account whose incoming memo requirement is enabled', () => {
    expect(memoRequired(account(1))).toBe(true);
  });

  it('fails closed on a malformed MemoTransfer payload', () => {
    expect(memoRequired(account(0, 0))).toBe(true);
  });
});

describe('B-07: the v1 message config is an allowlist', () => {
  it('a heap size in the v1 config is rejected', async () => {
    const s = await scenario();
    expect((await verify(compileRaw(s.W, honest(s), 1), s.policy, s.snapshot)).ok).toBe(true);
    expect(rules(await verify(compileRawV1WithHeap(s.W, honest(s)), s.policy, s.snapshot))).toContain('R4');
  });
});

describe("B-09: the user never pays rent for Orientim's fee account", () => {
  for (const version of [0, 1] as const) {
    it(`without a fee account the swap is fee-free and creates nothing for the treasury, v${version}`, async () => {
      // Neither side is SOL, USDC or USDT and the treasury has no account for the input token.
      const s = await scenario({ input: BONK, output: JUP, feeAccountExists: false });
      expect(s.policy.fee).toBe(0n);
      expect(s.policy.treasury).toBeNull();
      expect(s.policy.swapAmount).toBe(s.policy.amountIn);
      const tx = compileHonest(s, version);
      expect((await verify(tx, s.policy, s.snapshot)).ok).toBe(true);
    });
  }

  it("creating the treasury's account at the user's expense is rejected", async () => {
    const s = await scenario();
    const create = getCreateAssociatedTokenIdempotentInstruction({
      payer: createNoopSigner(s.W), ata: s.policy.accounts.feeDestination!, owner: s.treasury!, mint: USDC,
    });
    const tx = compileRaw(s.W, [...cuIxs(), create, ...honest(s)], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R2');
  });

  it('a SOL input still pays the fee to the treasury wallet, which needs no account', async () => {
    const s = await scenario({ input: WSOL_MINT, output: USDC, feeAccountExists: false });
    expect(s.policy.fee).toBeGreaterThan(0n);
    expect(s.policy.accounts.feeDestination).toBe(s.treasury);
    expect((await verify(compileHonest(s), s.policy, s.snapshot)).ok).toBe(true);
  });
});

describe('B-10: Token-2022 intermediate hops', () => {
  const HOOK = 14;
  const PERMANENT_DELEGATE = 12;
  const METADATA_POINTER = 18;
  const TRANSFER_FEE = 1;
  /** A Token-2022 mint account with the given TLV extensions (none: the 82-byte base mint). */
  const t22Mint = (...extensions: [number, Uint8Array][]): AccountState => {
    const tlv = extensions.flatMap(([type, v]) => [type & 0xff, type >> 8, v.length & 0xff, v.length >> 8, ...v]);
    const data = new Uint8Array(extensions.length ? 166 + tlv.length : 82);
    if (extensions.length) {
      data[165] = 1; // AccountType::Mint
      data.set(tlv, 166);
    }
    return { owner: TOKEN_2022_PROGRAM, lamports: 2_000_000n, data };
  };
  const key = (fill: number) => new Uint8Array(32).fill(fill);
  const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(p => [...p]));

  /** Adds a created-and-closed ATA(E, hopMint) with `tokenProgram`, and returns the verdict. */
  async function withHops(
    s: Scenario,
    hops: { mint: Address; tokenProgram: Address; state?: AccountState | null; harvest?: boolean }[],
  ) {
    const ixs = honest(s);
    const swapAt = ixs.findIndex(i => i.programAddress === JUPITER_PROGRAM);
    for (const h of hops) {
      const mid = await ataOf(s.E.address, h.mint, h.tokenProgram);
      accounts(s).set(mid, null);
      if (h.state !== undefined) accounts(s).set(h.mint, h.state);
      ixs.splice(swapAt, 0, getCreateAssociatedTokenIdempotentInstruction({
        payer: createNoopSigner(s.W), ata: mid, owner: s.E.address, mint: h.mint, tokenProgram: h.tokenProgram,
      }));
      // A taxing mint withholds in this account, so the cleanup harvests before it closes.
      if (h.harvest) {
        ixs.push({
          programAddress: TOKEN_2022_PROGRAM,
          accounts: [{ address: h.mint, role: AccountRole.WRITABLE }, { address: mid, role: AccountRole.WRITABLE }],
          data: new Uint8Array([26, 4]),
        });
      }
      ixs.push(getCloseAccountInstruction({ account: mid, destination: s.W, owner: createNoopSigner(s.E.address) }, { programAddress: h.tokenProgram }));
    }
    return verify(compileRaw(s.W, ixs, 1), s.policy, s.snapshot);
  }

  const cases: [string, AccountState | null, boolean][] = [
    ['a base mint without extensions is accepted', t22Mint(), true],
    // A metadata pointer is an authority and an address: 64 bytes, as the program lays it out.
    ['a harmless extension (metadata pointer) is accepted', t22Mint([METADATA_POINTER, cat(key(7), key(8))], [METADATA_POINTER + 1, new Uint8Array(0)]), true],
    ['a transfer-hook extension with no program is accepted', t22Mint([HOOK, cat(key(9), key(0))]), true],
    ['a mint that runs a transfer hook is rejected', t22Mint([HOOK, cat(key(9), key(5))]), false],
    // Delegates read from mainnet: PYUSD's is an ordinary key, the xStocks' a program address.
    ['a hop whose issuer delegate is an ordinary key is accepted', t22Mint([PERMANENT_DELEGATE, Uint8Array.from(getAddressEncoder().encode(address('2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk')))]), true],
    ['a hop whose issuer delegate a program can sign for is rejected', t22Mint([PERMANENT_DELEGATE, Uint8Array.from(getAddressEncoder().encode(address('5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq')))]), false],

    ['a hop mint missing from the snapshot is rejected', null, false],
  ];
  it('a hop through a taxing mint is accepted when its withheld fees are harvested first', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    const verdict = await withHops(s, [{
      mint: JUP, tokenProgram: TOKEN_2022_PROGRAM, state: t22Mint([TRANSFER_FEE, new Uint8Array(108)]), harvest: true,
    }]);
    expect(verdict.violations).toEqual([]);
  });

  it('the same hop without the harvest could not be closed → R5', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    const verdict = await withHops(s, [{
      mint: JUP, tokenProgram: TOKEN_2022_PROGRAM, state: t22Mint([TRANSFER_FEE, new Uint8Array(108)]),
    }]);
    expect(rules(verdict)).toContain('R5');
  });

  for (const [name, state, ok] of cases) {
    it(name, async () => {
      const s = await scenario({ input: USDC, output: BONK });
      const verdict = await withHops(s, [{ mint: JUP, tokenProgram: TOKEN_2022_PROGRAM, state }]);
      if (ok) expect(verdict.violations).toEqual([]);
      else expect(rules(verdict)).toEqual(['R7']);
    });
  }

  it('the number of intermediate accounts is bounded', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    const mints = await Promise.all(Array.from({ length: 5 }, () => randomAddress()));
    const verdict = await withHops(s, mints.map(mint => ({ mint, tokenProgram: TOKEN_PROGRAM })));
    expect(verdict.violations.map(v => v.detail)).toContain('5 intermediate accounts, above the maximum of 4');
  });
});

describe('B-11: Orientim fee accounts are kept away from the external program', () => {
  it("the treasury's fee ATA inside the swap is rejected", async () => {
    const s = await scenario();
    const feeDest = s.policy.accounts.feeDestination!;
    accounts(s).set(feeDest, { owner: TOKEN_PROGRAM, lamports: 2_039_280n, data: new Uint8Array(165) });
    const tx = compileRaw(s.W, [...cuIxs(), ...withSwapAccount(s, feeDest)], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R1');
  });
});

describe('controls the reviews ran', () => {
  it('an unrelated W token account in the swap is rejected with R1', async () => {
    const s = await scenario();
    const tx = compileRaw(s.W, [...cuIxs(), ...withSwapAccount(s, s.wOther)], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R1');
  });

  it('an external account missing from the snapshot fails closed with R1', async () => {
    const s = await scenario();
    const ghost = address('9yVVtnxxqxTCTRjEMMPHF6ixCxLGdyLhLjbBCbPYyFTM');
    const tx = compileRaw(s.W, [...cuIxs(), ...withSwapAccount(s, ghost)], 0, s.lookupTables);
    expect(rules(await verify(tx, s.policy, s.snapshot))).toContain('R1');
  });

  it('R5 measures the real wire size', async () => {
    for (const version of [0, 1] as const) {
      const s = await scenario();
      const tx = compileHonest(s, version);
      expect(getTransactionSize(tx)).toBe(getTransactionEncoder().encode(tx).length);
    }
  });
});

describe('the verifier derives what the policy claims', () => {
  it('a policy whose variant does not match its mints is rejected', async () => {
    const s = await scenario({ input: USDC, output: BONK });
    const v = await verify(compileHonest(s), { ...s.policy, variant: 'A' }, s.snapshot);
    expect(v.violations.map(x => x.detail).join(' ')).toMatch(/variant A does not match the mints \(C\)/);
  });

  it('decimals that disagree with the mint in the snapshot are rejected', async () => {
    const s = await scenario();
    const v = await verify(compileHonest(s), { ...s.policy, inputDecimals: 9 }, s.snapshot);
    expect(v.violations.map(x => x.detail).join(' ')).toMatch(/input decimals 9 do not match the mint \(6\)/);
  });
});
