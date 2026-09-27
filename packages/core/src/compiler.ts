import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionSize,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
  setTransactionMessagePriorityFeeLamports,
} from '@solana/kit';
import type { Address, Blockhash, Instruction, Transaction } from '@solana/kit';
import {
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getRevokeInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import { TOKEN_2022_PROGRAM } from './constants.ts';
import { getTransferSolInstruction } from '@solana-program/system';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { CLOSE_USER_VOLUME_ACCUMULATOR, MAX_LOADED_ACCOUNTS_DATA_SIZE, TOKEN_PROGRAM, WSOL_MINT } from './constants.ts';
import type { IntermediateAta, Policy, TxVersion } from './types.ts';

export type Lifetime = { blockhash: Blockhash; lastValidBlockHeight: bigint };

export type CompileInput = {
  policy: Policy;
  /** The single untrusted instruction (Jupiter's swap instruction). */
  swapInstruction: Instruction;
  intermediates: readonly IntermediateAta[];
  version: TxVersion;
  lifetime: Lifetime;
  computeUnitLimit: number;
  /** v0: price per compute unit in micro-lamports. */
  microLamportsPerComputeUnit?: bigint;
  /** v1: total priority fee in lamports. */
  priorityFeeLamports?: bigint;
  /** v0: lookup tables used to compress the message. */
  lookupTables?: Readonly<Record<string, readonly Address[]>>;
  /** Token balance of W_out before the transaction (variants B and C), for the minimum-output check. */
  outputBalanceBefore?: bigint;
};

export type CompiledSwap = { transaction: Transaction; size: number; staticAccounts: number };

/**
 * SyncNative with exactly one account. The generated builder appends the program id as a
 * placeholder for its optional `rent` account, which the verifier (rightly) does not accept.
 */
const syncNative = (account: Address): Instruction => ({
  programAddress: TOKEN_PROGRAM,
  accounts: [{ address: account, role: AccountRole.WRITABLE }],
  data: new Uint8Array([17]),
});

/**
 * Token-2022 HarvestWithheldTokensToMint: moves the fees withheld in an account to its mint.
 * Anyone may call it, it moves nothing that belongs to the holder, and without it an account that
 * has received a transfer-fee token cannot be closed.
 */
const harvestWithheld = (mint: Address, account: Address): Instruction => ({
  programAddress: TOKEN_2022_PROGRAM,
  accounts: [
    { address: mint, role: AccountRole.WRITABLE },
    { address: account, role: AccountRole.WRITABLE },
  ],
  data: new Uint8Array([26, 4]),
});

/**
 * The full instruction list in execution order: trusted setup, the one untrusted swap, trusted
 * cleanup (plan, section 5). W signs only the trusted instructions; E is the swap authority.
 */
export function protectedInstructions(
  input: Pick<CompileInput, 'policy' | 'swapInstruction' | 'intermediates' | 'outputBalanceBefore'>,
): Instruction[] {
  const { policy: p, swapInstruction, intermediates } = input;
  if (p.minOut <= 0n) throw new Error('A protected swap needs a minimum output');
  const W = createNoopSigner(p.owner);
  const E = createNoopSigner(p.ephemeral);
  const a = p.accounts;
  const pre: Instruction[] = [];
  const post: Instruction[] = [];

  pre.push(getCreateAssociatedTokenIdempotentInstruction({
    payer: W, ata: a.eIn, owner: p.ephemeral, mint: p.inputMint, tokenProgram: p.inputTokenProgram,
  }));
  if (p.variant === 'A') {
    pre.push(getCreateAssociatedTokenIdempotentInstruction({ payer: W, ata: a.eOut!, owner: p.ephemeral, mint: WSOL_MINT }));
  } else {
    pre.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: W, ata: a.wOut!, owner: p.owner, mint: p.outputMint, tokenProgram: p.outputTokenProgram,
      }),
      // W_out is the only account of W the swap sees. Revoking any delegate makes "no one else can
      // move it" an on-chain fact instead of a snapshot read.
      getRevokeInstruction({ source: a.wOut!, owner: W }, { programAddress: p.outputTokenProgram }),
    );
  }
  for (const x of intermediates) {
    pre.push(getCreateAssociatedTokenIdempotentInstruction({ payer: W, ata: x.ata, owner: p.ephemeral, mint: x.mint, tokenProgram: x.tokenProgram }));
  }

  if (p.variant === 'B') {
    pre.push(
      getTransferSolInstruction({ source: W, destination: a.eIn, amount: p.swapAmount }),
      syncNative(a.eIn),
    );
    if (p.feeSide === 'input' && p.fee > 0n) pre.push(getTransferSolInstruction({ source: W, destination: a.feeDestination!, amount: p.fee }));
  } else {
    pre.push(
      getTransferCheckedInstruction({
        source: a.wIn!, mint: p.inputMint, destination: a.eIn, authority: W, amount: p.swapAmount, decimals: p.inputDecimals,
      }, { programAddress: p.inputTokenProgram }),
    );
    if (p.feeSide === 'input' && p.fee > 0n) {
      pre.push(
        getTransferCheckedInstruction({
          source: a.wIn!, mint: p.inputMint, destination: a.feeDestination!, authority: W, amount: p.fee, decimals: p.inputDecimals,
        }, { programAddress: p.inputTokenProgram }),
      );
    }
    // A pair no token of which can carry the fee pays it in SOL, from the wallet to the treasury wallet.
    if (p.feeSide === 'sol' && p.fee > 0n) pre.push(getTransferSolInstruction({ source: W, destination: a.feeDestination!, amount: p.fee }));
  }

  // Rent for an account the route opens in E's name, and nothing more: the exact amount was
  // measured in simulation, so E spends all of it and does not survive the transaction.
  if (p.takerRent > 0n) pre.push(getTransferSolInstruction({ source: W, destination: p.ephemeral, amount: p.takerRent }));

  // Minimum-output check: a self-transfer of the expected floor. The Token program
  // checks the balance before short-circuiting a self-transfer, so this is a no-op when the swap
  // delivered at least minOut and reverts the whole transaction when it did not.
  if (p.variant === 'A') {
    post.push(getTransferCheckedInstruction({
      source: a.eOut!, mint: WSOL_MINT, destination: a.eOut!, authority: E, amount: p.minOut, decimals: 9,
    }));
  } else {
    post.push(getTransferCheckedInstruction({
      source: a.wOut!, mint: p.outputMint, destination: a.wOut!, authority: W,
      amount: (input.outputBalanceBefore ?? 0n) + p.minOut, decimals: p.outputDecimals,
    }, { programAddress: p.outputTokenProgram }));
  }
  // A fee withheld in E_in would make the close fail, so it goes back to the mint first.
  if (p.inputTransferFee) post.push(harvestWithheld(p.inputMint, a.eIn));
  post.push(getCloseAccountInstruction({ account: a.eIn, destination: p.owner, owner: E }, { programAddress: p.inputTokenProgram }));
  if (p.variant === 'A') post.push(getCloseAccountInstruction({ account: a.eOut!, destination: p.owner, owner: E }));
  for (const x of intermediates) {
    if (x.transferFee) post.push(harvestWithheld(x.mint, x.ata));
    post.push(getCloseAccountInstruction({ account: x.ata, destination: p.owner, owner: E }, { programAddress: x.tokenProgram }));
  }
  // The account a Pump market opened in E's name, closed last: by now E owns no token
  // account, so the market's program, given E's signature, reaches nothing but the lamports it
  // returns, and those go straight on to W.
  if (p.routeRefund > 0n) {
    post.push(
      {
        programAddress: p.routeRefundProgram!,
        accounts: [
          { address: p.ephemeral, role: AccountRole.WRITABLE_SIGNER },
          { address: a.routeAccount!, role: AccountRole.WRITABLE },
          { address: a.routeEventAuthority!, role: AccountRole.READONLY },
          { address: p.routeRefundProgram!, role: AccountRole.READONLY },
        ],
        data: new Uint8Array(CLOSE_USER_VOLUME_ACCUMULATOR),
      },
      getTransferSolInstruction({ source: E, destination: p.owner, amount: p.routeRefund }),
    );
  }
  // A fee on the output comes last, out of what arrived: SOL from the wallet once E_out has paid out
  // to it, a token from W_out once its minimum is checked. The wallet keeps at least minOut - fee.
  if (p.feeSide === 'output' && p.fee > 0n) {
    post.push(p.variant === 'A'
      ? getTransferSolInstruction({ source: W, destination: a.feeDestination!, amount: p.fee })
      : getTransferCheckedInstruction({
        source: a.wOut!, mint: p.outputMint, destination: a.feeDestination!, authority: W, amount: p.fee, decimals: p.outputDecimals,
      }, { programAddress: p.outputTokenProgram }));
  }
  return [...pre, swapInstruction, ...post];
}

export function compileProtectedSwap(input: CompileInput): CompiledSwap {
  const ixs = protectedInstructions(input);
  let transaction: Transaction;
  if (input.version === 1) {
    // v1: no ALTs and no ComputeBudget instructions; the budget lives in the message config.
    const msg = pipe(
      createTransactionMessage({ version: 1 }),
      m => setTransactionMessageFeePayer(input.policy.owner, m),
      m => setTransactionMessageLifetimeUsingBlockhash(input.lifetime, m),
      m => setTransactionMessageComputeUnitLimit(input.computeUnitLimit, m),
      m => setTransactionMessagePriorityFeeLamports(input.priorityFeeLamports ?? 0n, m),
      m => setTransactionMessageLoadedAccountsDataSizeLimit(MAX_LOADED_ACCOUNTS_DATA_SIZE, m),
      m => appendTransactionMessageInstructions(ixs, m),
    );
    transaction = compileTransaction(msg);
  } else {
    const base = pipe(
      createTransactionMessage({ version: 0 }),
      m => setTransactionMessageFeePayer(input.policy.owner, m),
      m => setTransactionMessageLifetimeUsingBlockhash(input.lifetime, m),
      m => appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: input.computeUnitLimit }),
          getSetComputeUnitPriceInstruction({ microLamports: input.microLamportsPerComputeUnit ?? 0n }),
          ...ixs,
        ],
        m,
      ),
    );
    // Orientim's own accounts stay in the message itself: each is replaced by the
    // table's own address, which never appears in the message, so its index is kept but unused.
    const own = new Set<string>([
      ...Object.values(input.policy.accounts).filter((a): a is Address => !!a),
      ...(input.policy.treasury ? [input.policy.treasury] : []),
      ...input.intermediates.map(x => x.ata),
    ]);
    const tables = input.lookupTables
      ? Object.fromEntries(Object.entries(input.lookupTables).map(([table, list]) => [table, list.map(a => (own.has(a) ? table : a))]))
      : null;
    const msg = tables ? compressTransactionMessageUsingAddressLookupTables(base, tables as never) : base;
    transaction = compileTransaction(msg);
  }
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  return { transaction, size: getTransactionSize(transaction), staticAccounts: compiled.staticAccounts.length };
}
