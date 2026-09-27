import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayer,
  setTransactionMessageHeapSize,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
  setTransactionMessagePriorityFeeLamports,
} from '@solana/kit';
import type { Address, Blockhash, Instruction, KeyPairSigner, Transaction } from '@solana/kit';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import {
  ataOf, buildPolicy, eventAuthorityOf, JUPITER_PROGRAM, protectedInstructions, routeAccountOf, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM, withRouteRefund, withTakerRent, WSOL_MINT,
} from '@orientim/core';
import type { AccountState, ChainSnapshot, IntermediateAta, Policy, TxVersion } from '@orientim/core';

export const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const BONK = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
export const JUP = address('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
/** A token W holds that is never part of the swap. */
export const WIF = address('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm');
const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const DEX = address('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const JUPITER_EVENT_AUTHORITY = address('D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf');

export const DECIMALS: Record<string, number> = {
  So11111111111111111111111111111111111111112: 9,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5,
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6,
};

export const LIFETIME = {
  blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash,
  lastValidBlockHeight: 1_000_000n,
};

export const randomAddress = async () => (await generateKeyPairSigner()).address;

/**
 * Jupiter's route_v2 data as /swap/v2/build returns it: discriminator, amount in, quoted amount out,
 * tolerance, platform fee and positive slippage (both 0), then a one-step route plan.
 */
export function routeV2Data(inAmount: bigint, quotedOut: bigint, slippageBps = 50): Uint8Array {
  const d = new Uint8Array(8 + 22 + 4 + 6);
  d.set([0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14], 0);
  const v = new DataView(d.buffer);
  v.setBigUint64(8, inAmount, true);
  v.setBigUint64(16, quotedOut, true);
  v.setUint16(24, slippageBps, true);
  v.setUint32(30, 1, true);
  d.set([0x97, 0x01, 0x10, 0x27, 0x00, 0x01], 34);
  return d;
}


export const CONFIG = (treasury: Address | null) => ({
  feeBps: 50n,
  treasury,
  maxNetworkFeeLamports: 200_000n,
  jupiterProgram: JUPITER_PROGRAM,
});

const tokenAccountData = (owner: Address, mint: Address) => {
  const data = new Uint8Array(165);
  data.set(getAddressEncoder().encode(mint), 0);
  data.set(getAddressEncoder().encode(owner), 32);
  return data;
};

export type Scenario = {
  W: Address;
  E: KeyPairSigner;
  treasury: Address | null;
  policy: Policy;
  swapIx: Instruction;
  pools: Address[];
  intermediates: IntermediateAta[];
  lookupTable: Address;
  lookupTables: Record<string, Address[]>;
  snapshot: ChainSnapshot;
  /** A token account of W that is not part of the swap (WIF). */
  wOther: Address;
  /** Token balance W_out already holds before the swap (variants B and C). */
  wOutBalance: bigint;
};

/** A realistic protected swap with a fake Jupiter instruction touching `poolCount` pool accounts. */
export async function scenario(opts: {
  input?: Address;
  output?: Address;
  fee?: boolean;
  feeAccountExists?: boolean;
  /** Whether the treasury has an account for the output token (USDC or USDT), for a fee on the output. */
  outputFeeAccountExists?: boolean;
  /** Whether the treasury wallet exists to receive a fee in SOL; true unless a test says otherwise. */
  treasuryWalletReady?: boolean;
  /** The fee in lamports for a pair neither token of which can carry it, as a builder priced it. */
  solFee?: bigint;
  intermediates?: number;
  poolCount?: number;
  owner?: KeyPairSigner;
  minOut?: bigint;
  wOutBalance?: bigint;
  /** The whole amount the wallet spends; 100 USDC, or 0.9 SOL, unless a test asks for another. */
  amountIn?: bigint;
  /** Decimals of each mint, as the chain states them; the real token's unless a test asks. */
  inputDecimals?: number;
  outputDecimals?: number;
  /** What Jupiter's instruction quotes, and the tolerance it carries: twice the minimum at 0.5% unless set. */
  quotedOut?: bigint;
  routeBps?: number;
  /** A Pump market's account opened in E's name, closed after the swap and its rent sent on to W. */
  routeRefund?: { program: Address; lamports: bigint };
  /** Token program of each mint; classic SPL unless a test asks for Token-2022. */
  inputProgram?: Address;
  outputProgram?: Address;
  /** Extension types written into a Token-2022 mint, as [type, payload length] pairs. */
  inputExtensions?: [number, number][];
  outputExtensions?: [number, number][];
} = {}): Promise<Scenario> {
  const W = opts.owner?.address ?? (await randomAddress());
  const E = await generateKeyPairSigner();
  const treasury = opts.fee === false ? null : await randomAddress();
  const input = opts.input ?? USDC;
  const output = opts.output ?? WSOL_MINT;
  const inputProgram = input === WSOL_MINT ? TOKEN_PROGRAM : opts.inputProgram ?? TOKEN_PROGRAM;
  const outputProgram = output === WSOL_MINT ? TOKEN_PROGRAM : opts.outputProgram ?? TOKEN_PROGRAM;
  let policy = await buildPolicy({
    intent: { owner: W, inputMint: input, outputMint: output, amountIn: opts.amountIn ?? (input === WSOL_MINT ? 900_000_000n : 100_000_000n) },
    ephemeral: E.address,
    inputDecimals: opts.inputDecimals ?? DECIMALS[input],
    outputDecimals: opts.outputDecimals ?? DECIMALS[output],
    inputTokenProgram: inputProgram,
    outputTokenProgram: outputProgram,
    // A mint that taxes its transfers needs the withheld amount harvested before the close.
    inputTransferFee: inputProgram === TOKEN_2022_PROGRAM && (opts.inputExtensions ?? []).some(([type]) => type === 1),
    minOut: opts.minOut ?? 1_000_000n,
    config: CONFIG(treasury),
    feeAccountExists: opts.feeAccountExists ?? true,
    outputFeeAccountExists: opts.outputFeeAccountExists,
    treasuryWalletReady: opts.treasuryWalletReady,
    solFee: opts.solFee,
  });

  const intermediates: IntermediateAta[] = [];
  const hopMints = [JUP, BONK];
  // A hop may be one of the swap's own mints, and a taxing mint is harvested wherever it lands.
  const taxes = (mint: Address) =>
    (mint === input && inputProgram === TOKEN_2022_PROGRAM && (opts.inputExtensions ?? []).some(([t]) => t === 1)) ||
    (mint === output && outputProgram === TOKEN_2022_PROGRAM && (opts.outputExtensions ?? []).some(([t]) => t === 1));
  for (let i = 0; i < (opts.intermediates ?? 0); i++) {
    const mint = hopMints[i];
    // A hop belongs to the program that owns its mint, which for one of the swap's own mints may
    // be Token-2022.
    const tokenProgram = mint === input ? inputProgram : mint === output ? outputProgram : TOKEN_PROGRAM;
    intermediates.push({ ata: await ataOf(E.address, mint, tokenProgram), mint, tokenProgram, transferFee: taxes(mint) });
  }

  // The market charges E the account's rent before the swap and Orientim returns it after.
  const routeAccount = opts.routeRefund ? await routeAccountOf(opts.routeRefund.program, E.address) : null;
  if (opts.routeRefund) {
    policy = withRouteRefund(withTakerRent(policy, opts.routeRefund.lamports), {
      program: opts.routeRefund.program, account: routeAccount!, eventAuthority: await eventAuthorityOf(opts.routeRefund.program),
      lamports: opts.routeRefund.lamports,
    });
  }
  const pools = await Promise.all(Array.from({ length: opts.poolCount ?? 12 }, randomAddress));
  const a = policy.accounts;
  // Laid out like Jupiter's route_v2 (its IDL on chain): E's temporary account for SOL is the user
  // destination; a token goes to the wallet's own account, passed as the optional destination.
  const A = policy.variant === 'A';
  const swapIx: Instruction = {
    programAddress: JUPITER_PROGRAM,
    accounts: [
      { address: E.address, role: AccountRole.READONLY_SIGNER },
      { address: a.eIn, role: AccountRole.WRITABLE },
      { address: A ? a.eOut! : await ataOf(E.address, output, outputProgram), role: AccountRole.WRITABLE },
      { address: input, role: AccountRole.READONLY },
      { address: output, role: AccountRole.READONLY },
      { address: inputProgram, role: AccountRole.READONLY },
      { address: outputProgram, role: AccountRole.READONLY },
      A ? { address: JUPITER_PROGRAM, role: AccountRole.READONLY } : { address: a.wOut!, role: AccountRole.WRITABLE },
      { address: JUPITER_EVENT_AUTHORITY, role: AccountRole.READONLY },
      { address: JUPITER_PROGRAM, role: AccountRole.READONLY },
      ...intermediates.map(x => ({ address: x.ata, role: AccountRole.WRITABLE })),
      { address: DEX, role: AccountRole.READONLY },
      ...pools.map(p => ({ address: p, role: AccountRole.WRITABLE })),
      // Jupiter passes a Pump market's program and the buyer's account to the route.
      ...(opts.routeRefund
        ? [{ address: opts.routeRefund.program, role: AccountRole.READONLY }, { address: routeAccount!, role: AccountRole.WRITABLE }]
        : []),
    ],
    // Quoted at twice the minimum, at 0.5%: what an honest route carries.
    data: routeV2Data(policy.swapAmount, opts.quotedOut ?? policy.minOut * 2n, opts.routeBps),
  };

  const lookupTable = await randomAddress();
  const lookupTables = { [lookupTable]: [...pools, DEX, TOKEN_PROGRAM, input, output] };

  const wOther = await ataOf(W, WIF);
  const accounts = new Map<string, AccountState | null>();
  const mintState = (program: Address, decimals = 0, extensions: [number, number][] = []): AccountState => {
    // A Token-2022 mint is padded to the size of a token account, then an account-type byte, then
    // the extensions: [type u16][length u16][payload].
    const size = program === TOKEN_2022_PROGRAM
      ? 166 + extensions.reduce((n, [, length]) => n + 4 + length, 0)
      : 82;
    const data = new Uint8Array(size);
    data[44] = decimals; // the verifier reads decimals from the mint
    if (program === TOKEN_2022_PROGRAM) {
      data[165] = 1; // AccountType::Mint
      const view = new DataView(data.buffer);
      let at = 166;
      for (const [type, length] of extensions) {
        view.setUint16(at, type, true);
        view.setUint16(at + 2, length, true);
        at += 4 + length;
      }
    }
    return { owner: program, lamports: 1_066_800n, data };
  };
  accounts.set(input, mintState(inputProgram, opts.inputDecimals ?? DECIMALS[input], opts.inputExtensions ?? [[18, 64]]));
  accounts.set(output, mintState(outputProgram, opts.outputDecimals ?? DECIMALS[output], opts.outputExtensions ?? [[18, 64]]));
  // A hop mint may also be the output mint; the swap's own mints win.
  for (const m of hopMints) if (!accounts.has(m)) accounts.set(m, mintState(TOKEN_PROGRAM, DECIMALS[m]));
  for (const p of pools) accounts.set(p, { owner: DEX, lamports: 5_000_000n, data: new Uint8Array(300) });
  accounts.set(DEX, { owner: LOADER, lamports: 1n, data: new Uint8Array(36) });
  if (opts.routeRefund) {
    accounts.set(opts.routeRefund.program, { owner: LOADER, lamports: 1n, data: new Uint8Array(36) });
    accounts.set(routeAccount!, null); // opened by the swap itself
  }
  accounts.set(TOKEN_PROGRAM, { owner: LOADER, lamports: 1n, data: new Uint8Array(36) });
  accounts.set(TOKEN_2022_PROGRAM, { owner: LOADER, lamports: 1n, data: new Uint8Array(36) });
  accounts.set(JUPITER_PROGRAM, { owner: LOADER, lamports: 1n, data: new Uint8Array(36) });
  accounts.set(JUPITER_EVENT_AUTHORITY, { owner: SYSTEM_PROGRAM, lamports: 1_000_000n, data: new Uint8Array() });
  // E's own account for a token output is named by the route but never created: the output goes to W's.
  const eOutputAta = await ataOf(E.address, output, outputProgram);
  for (const x of [E.address, a.eIn, a.eOut, eOutputAta, ...intermediates.map(i => i.ata)]) if (x && !accounts.has(x)) accounts.set(x, null);
  if (a.wIn) accounts.set(a.wIn, { owner: inputProgram, lamports: 2_039_280n, data: tokenAccountData(W, input) });
  const wOutBalance = opts.wOutBalance ?? 0n;
  if (a.wOut) {
    const data = tokenAccountData(W, output);
    new DataView(data.buffer).setBigUint64(64, wOutBalance, true);
    accounts.set(a.wOut, { owner: outputProgram, lamports: 2_039_280n, data });
  }
  accounts.set(wOther, { owner: TOKEN_PROGRAM, lamports: 2_039_280n, data: tokenAccountData(W, WIF) });

  return {
    W, E, treasury, policy, swapIx, pools, intermediates, lookupTable, lookupTables,
    snapshot: { accounts, lookupTables }, wOther, wOutBalance,
  };
}

export const cuIxs = (units = 400_000, microLamports = 50_000n) => [
  getSetComputeUnitLimitInstruction({ units }),
  getSetComputeUnitPriceInstruction({ microLamports }),
];

/**
 * Compiles an arbitrary instruction list the way an attacker (or a buggy compiler) could.
 * For v0 the caller includes the ComputeBudget instructions it wants.
 */
export function compileRaw(
  feePayer: Address,
  ixs: Instruction[],
  version: TxVersion,
  lookupTables?: Record<string, Address[]>,
  v1Budget: { units?: number; priorityFeeLamports?: bigint } = {},
): Transaction {
  if (version === 1) {
    return compileTransaction(pipe(
      createTransactionMessage({ version: 1 }),
      m => setTransactionMessageFeePayer(feePayer, m),
      m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
      m => setTransactionMessageComputeUnitLimit(v1Budget.units ?? 400_000, m),
      m => setTransactionMessagePriorityFeeLamports(v1Budget.priorityFeeLamports ?? 20_000n, m),
      m => setTransactionMessageLoadedAccountsDataSizeLimit(64 * 1024 * 1024, m),
      m => appendTransactionMessageInstructions(ixs, m),
    ));
  }
  const base = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
    m => appendTransactionMessageInstructions(ixs, m),
  );
  return compileTransaction(lookupTables ? compressTransactionMessageUsingAddressLookupTables(base, lookupTables as never) : base);
}

/** The honest instruction list for a scenario (what the compiler produces). */
export const honest = (s: Scenario) =>
  protectedInstructions({
    policy: s.policy, swapInstruction: s.swapIx, intermediates: s.intermediates, outputBalanceBefore: s.wOutBalance,
  });

/** A v1 transaction whose config also carries a heap size, which Orientim never sets. */
export function compileRawV1WithHeap(feePayer: Address, ixs: Instruction[]): Transaction {
  return compileTransaction(pipe(
    createTransactionMessage({ version: 1 }),
    m => setTransactionMessageFeePayer(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
    m => setTransactionMessageComputeUnitLimit(400_000, m),
    m => setTransactionMessagePriorityFeeLamports(20_000n, m),
    m => setTransactionMessageLoadedAccountsDataSizeLimit(64 * 1024 * 1024, m),
    m => setTransactionMessageHeapSize(64 * 1024, m),
    m => appendTransactionMessageInstructions(ixs, m),
  ));
}
