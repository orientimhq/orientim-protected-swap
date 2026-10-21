/**
 * `orientim swap`: one protected swap per command.
 *
 * Environment:
 *   ORIENTIM_API_URL, ORIENTIM_API_KEY, SOLANA_RPC_URL   required
 *   ORIENTIM_WALLET_KEYPAIR    solana-keygen file (never paste a key in a prompt)
 *   JUPITER_API_KEY            recommended; keyless calls are throttled
 *   ORIENTIM_POLICY            owner limits (see OwnerPolicy), required; /etc/orientim/policy.json takes precedence
 *   ORIENTIM_TREASURY          optional, for other Orientim deployments
 *   ORIENTIM_ARCHIVE_RPC_URL   optional full-history RPC to prove expiry
 *   ORIENTIM_STATE_DIR         state directory (or --state; default ./.orientim-state)
 *
 *   orientim swap --in <mint> --out <mint> --amount <base units> --id <order id> [--slippage-bps N|auto] [--max-price-impact-bps N]
 *                [--min-out <base units>] [--max-below-bps N] [--max-fee-bps 30] [--max-route-cost-lamports N] [--accept-cost-bps N]
 *   orientim swap ... --owner <address> --dry-run      prepare and verify only; nothing is signed
 *
 * Default slippage is 0.5% (3% on a Pump.fun curve), capped by the policy's maxSlippageBps.
 *
 * Exit codes: 0 confirmed, 1 not swapped, 2 usage error, 3 an earlier swap must be settled first,
 * 5 this order id already swapped or may still land.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createKeyPairSignerFromBytes, createSolanaRpc } from '@solana/kit';
import { ConfigError, ERROR_MEANINGS, OrientimApiError, PREPARE_WAIT_MS, preparedByOrientim, rpcSender } from './api.ts';
import type { Intent } from './api.ts';
import type { Outcome } from './chain.ts';
import { acquireLock, LockBusyError, lockHeld, releaseHeldLocks } from './lock.ts';
import { APPROVAL_MS, checkPolicy, forgetApproval, heldToApproval, keptApproval, PolicyError, recordApproval, requiredPolicy, stateDirFor } from './policy.ts';
import { createFileStore, pendingFor, PendingSwapError, PendingUnreadableError, recoverPending } from './store.ts';
import { checkPrepared, FloorError, holdSolFee, IntentError, OrientimOrderError, ownFloor, preparedData, PriceImpactError, protectedSwap, withTolerance } from './swap.ts';
import { noticesOf, preparationBudget, tokenRisk } from './verify.ts';

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const need = (name: string) => process.env[name] ?? (console.error(`Set ${name}.`), process.exit(2));
  const [inputMint, outputMint, amountIn] = [flag('in'), flag('out'), flag('amount')];
  if (!inputMint || !outputMint || !amountIn) {
    console.error('usage: orientim swap --in <mint> --out <mint> --amount <base units> --id <order id> [--slippage-bps N|auto] [--max-price-impact-bps N] [--min-out N] [--max-below-bps N] [--max-fee-bps N] [--max-route-cost-lamports N] [--accept-cost-bps N] [--owner <address> --dry-run]');
    process.exit(2);
  }
  if (!/^\d{1,20}$/.test(amountIn) || BigInt(amountIn) === 0n) {
    console.error(`--amount must be a whole number of base units, more than zero; got ${JSON.stringify(amountIn).slice(0, 40)}. Nothing was started.`);
    process.exit(2);
  }
  const apiUrl = need('ORIENTIM_API_URL').replace(/\/+$/, '');
  const apiKey = need('ORIENTIM_API_KEY');
  const intent = {
    inputMint, outputMint, amountIn, minOut: flag('min-out'), treasury: process.env.ORIENTIM_TREASURY || undefined,
    maxFeeBps: flag('max-fee-bps') ? Number(flag('max-fee-bps')) : undefined,
    maxBelowBps: flag('max-below-bps') ? Number(flag('max-below-bps')) : undefined,
    slippageBps: flag('slippage-bps') === 'auto' ? 'auto' as const : flag('slippage-bps') ? Number(flag('slippage-bps')) : undefined,
    maxPriceImpactBps: flag('max-price-impact-bps') ? Number(flag('max-price-impact-bps')) : undefined,
    maxRouteCostLamports: flag('max-route-cost-lamports') ? Number(flag('max-route-cost-lamports')) : undefined,
    acceptCostBps: flag('accept-cost-bps'),
    version: process.argv.includes('--v1') ? 1 as const : undefined,
    routingMode: process.argv.includes('--fast') ? 'fast' as const : undefined,
    id: flag('id'),
  };
  const jupiterApiKey = process.env.JUPITER_API_KEY || undefined;
  if (!jupiterApiKey) console.error('JUPITER_API_KEY is not set: Jupiter throttles keyless calls, and your own floor may not be priced.');
  // Verification is only as trustworthy as this RPC.
  const rpc = createSolanaRpc(need('SOLANA_RPC_URL'));
  const archive = process.env.ORIENTIM_ARCHIVE_RPC_URL ? createSolanaRpc(process.env.ORIENTIM_ARCHIVE_RPC_URL) : undefined;
  // A missing or unreadable policy aborts everything, including the dry run.
  const policy = requiredPolicy(process.env.ORIENTIM_POLICY || undefined);

  if (process.argv.includes('--dry-run')) {
    const owner = flag('owner') ?? (console.error('--dry-run needs --owner <address>.'), process.exit(2));
    // Must match the real swap's state directory, where the approval is kept.
    const { dir: dryStateDir, warning: dryWarning } = stateDirFor(policy, flag('state') ?? (process.env.ORIENTIM_STATE_DIR || undefined));
    if (dryWarning) console.error(dryWarning);
    // A new approval while a swap may still land could turn a retry into a second swap.
    const earlier = await pendingFor(createFileStore(dryStateDir), owner);
    if (earlier.length) throw new PendingSwapError(earlier);
    if (lockHeld(dryStateDir, owner)) {
      console.error(`Another swap from ${owner} is running now: wait for its answer (or run recover), then quote again. Nothing was quoted.`);
      process.exitCode = 3;
      return;
    }
    // Daily limits are checked by the real swap.
    const { maxAmountIn, allowedOutputMints } = policy;
    await checkPolicy({ maxAmountIn, ...(allowedOutputMints ? { allowedOutputMints } : {}) }, { owner, inputMint, outputMint, amountIn });
    const budget = preparationBudget();
    const own = await ownFloor({ ...intent, owner }, { rpc, jupiterApiKey, policy, budget });
    const minOut = own.minOut;
    const prepared = await preparedByOrientim(fetch, apiUrl, apiKey, {
      owner, inputMint, outputMint, amountIn, minOut,
      ...(intent.acceptCostBps ? { acceptCostBps: intent.acceptCostBps } : {}), ...(intent.version ? { version: 1 } : {}),
      ...(own.slippageBps !== undefined ? { slippageBps: own.slippageBps } : {}),
      ...(intent.routingMode === 'fast' ? { routingMode: 'fast' } : {}),
    }, PREPARE_WAIT_MS, { jupiterApiKey, ownRoutes: process.env.ORIENTIM_OWN_ROUTES !== '0', budget });
    // Refuse here any quote the real swap would refuse, so it is never shown for approval.
    const routeImpact = prepared.amounts?.priceImpactPct;
    if (typeof routeImpact === 'number' && Number.isFinite(routeImpact) && Math.round(routeImpact * 10_000) > own.maxPriceImpactBps) {
      throw new PriceImpactError(Math.round(routeImpact * 10_000), own.maxPriceImpactBps);
    }
    const checked: Intent = withTolerance({ ...intent, owner, minOut }, own.slippageBps);
    await holdSolFee(checked, prepared, { jupiterApiKey, budget });
    const problems = await checkPrepared(prepared, checked, rpc, { slippageCeilingBps: policy.maxSlippageBps });
    const risk = await tokenRisk(rpc, [inputMint, outputMint]);
    const shownData = preparedData(prepared);
    let approval: { minOut: string; until: string } | undefined;
    if (!problems.length) {
      const expiresAt = Date.now() + APPROVAL_MS;
      recordApproval(dryStateDir, { owner, inputMint, outputMint, amountIn, minOut, expiresAt });
      approval = { minOut, until: new Date(expiresAt).toISOString() };
    }
    // A refused transaction shows only its problems, never its amounts.
    console.log(JSON.stringify({
      yourFloor: minOut, yourQuote: own.outAmount, ...(approval ? { approval } : {}), priceImpactBps: own.priceImpactBps,
      slippageBps: own.slippageBps ?? shownData.slippageBps,
      ...(problems.length ? {} : { amounts: shownData.amounts, costs: shownData.costs, blocksLeft: shownData.blocksLeft }),
      problems, notices: noticesOf(risk), tokenRisk: risk,
    }, null, 2));
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  // A stable order id makes retries idempotent.
  if (!intent.id) {
    console.error('Give the order an id: --id <order id>, the same on every retry of this order, so that it is never swapped twice. Nothing was started.');
    process.exit(2);
  }
  const wallet = await createKeyPairSignerFromBytes(readKeypair(need('ORIENTIM_WALLET_KEYPAIR')));
  const { dir: stateDir, warning } = stateDirFor(policy, flag('state') ?? (process.env.ORIENTIM_STATE_DIR || undefined));
  if (warning) console.error(warning);
  const store = createFileStore(stateDir);
  let release: () => void;
  try {
    release = acquireLock(stateDir, wallet.address);
  } catch (e) {
    if (!(e instanceof LockBusyError)) throw e;
    console.error(`${e.message} It may be sending a swap now: wait for it, then run this again with the same --id (never a new one). A run that was stopped is settled by the next one.`);
    process.exitCode = 3;
    return;
  }
  try {
    // Settle swaps left by a stopped run; start nothing new while any outcome is unknown.
    const { settled, unknown, bookkeepingErrors } = await recoverPending(store, rpc, { orders: store, archive, spends: store });
    for (const s of settled) console.error(`An earlier swap, ${s.signature}, ended ${s.outcome}.`);
    for (const b of bookkeepingErrors) console.error(`Its record could not be updated (${b.error}); the next run settles ${b.signature} again.`);
    if (unknown.length || bookkeepingErrors.length) {
      if (unknown.length) {
        console.error(`The outcome of an earlier swap is still unknown: ${unknown.join(', ')}. Check it before swapping again; nothing new was started. `
          + `If the network can no longer prove it, look it up in a full history (an explorer), then settle it with \`orientim resolve\` (ORIENTIM_STATE_DIR=${resolve(stateDir)}).`);
      }
      process.exitCode = 3;
      return;
    }
    const approvalKey = { owner: wallet.address, inputMint, outputMint, amountIn };
    const approvedBy = Date.now();
    const approved = keptApproval(stateDir, approvalKey, approvedBy);
    intent.minOut = heldToApproval(approved, intent.minOut);
    const result = await protectedSwap({
      apiUrl, apiKey, rpc, wallet, intent, jupiterApiKey, orders: store, archive, ownRoutes: process.env.ORIENTIM_OWN_ROUTES !== '0',
      // With a custom sender, Orientim sends nothing.
      ...(process.env.ORIENTIM_SEND_RPC_URL ? { sendTransaction: rpcSender(process.env.ORIENTIM_SEND_RPC_URL) } : {}),
      // Persisted before finalize so the next run can settle it if this process stops.
      pending: store,
      policy, spends: store,
      onSigned: s => console.error(`Signed transaction ${s.signature}; it can land until block ${s.lastValidBlockHeight}.`),
    });
    // Only a confirmed swap consumes the approval; a retry after failure stays held to it.
    if (approved && result.outcome === 'confirmed') forgetApproval(stateDir, approvalKey, approvedBy);
    console.log(JSON.stringify({
      signature: result.signature, outcome: result.outcome, refusal: result.refusal, meaning: outcomeMeaning(result.outcome, result.refusal, result.cause),
      amounts: result.prepared.amounts,
      ...(result.received ? { received: result.received } : {}), ...(result.notices.length ? { notices: result.notices } : {}),
      ...(result.tokenRisk ? { tokenRisk: result.tokenRisk } : {}),
      ...(result.bookkeepingError ? { bookkeepingError: result.bookkeepingError } : {}),
    }, null, 2));
    process.exitCode = exitCodeOf(result);
  } finally {
    release();
  }
}

/** Exit code for a swap result: 0 confirmed, 1 not swapped, 3 unknown or not recorded. */
export function exitCodeOf(result: { outcome: Outcome | 'rejected'; bookkeepingError?: string }): number {
  if (result.bookkeepingError || result.outcome === 'unknown') return 3;
  return result.outcome === 'confirmed' ? 0 : 1;
}

/** Human-readable meaning of a swap outcome, with the next step. */
export function outcomeMeaning(outcome: Outcome | 'rejected', refusal?: string, cause?: string): string {
  const retry = 'Nothing moved and no fee was paid. The order may be tried again with the same id.';
  if (outcome === 'confirmed') return 'The swap landed. `received` is what arrived in the wallet, read on your RPC.';
  if (outcome === 'failed') return `The transaction landed but failed on chain${cause ? `: ${cause}` : ''}, so no tokens moved; only the network fee was paid. The order may be tried again with the same id.`;
  if (outcome === 'expired') return `The transaction did not land before it expired. ${retry}`;
  if (outcome === 'unknown') return 'No outcome could be read in time: the swap may still land. Look up the signature (orientim resolve, or resolvePending) before anything new from this wallet.';
  if (refusal === 'network') {
    const why = cause ? `: ${cause}` : ' (its own check failed at that moment, most often because the price moved beyond your slippage)';
    return `The network refused the transaction when it was sent${why}, and it can no longer land. ${retry}`;
  }
  if (refusal === 'busy') return `Orientim was sending too many transactions and did not send this one, and it can no longer land. ${retry} Wait a few seconds first.`;
  if (refusal === 'paused') return `Orientim has paused swaps and did not send this one, and it can no longer land. ${retry} Try later.`;
  const meaning = refusal && Object.hasOwn(ERROR_MEANINGS, refusal) ? ERROR_MEANINGS[refusal] : undefined;
  return `Orientim did not send the transaction${meaning ? ` (${meaning})` : ''}, and it can no longer land. ${retry}`;
}

/** Formats an error as one line: code, message and, for API errors, data fields as JSON. */
export function errorLine(e: unknown): string {
  if (e instanceof OrientimApiError) {
    // Server-provided text is never shown to the model.
    const { requests: _r, session: _s, taker: _t, ...shown } = e.body;
    const details = Object.keys(shown).length ? ` ${JSON.stringify(shown)}` : '';
    return `${e.code}: ${e.message}${details}`;
  }
  return e instanceof PriceImpactError ? `price-impact-high: ${e.message}` : e instanceof FloorError ? `floor-too-low: ${e.message}`
    : e instanceof PolicyError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
}

/** Exit code for an error: 2 usage or config, 3 another swap may land, 5 order already used, else 1. */
export function errorExitCode(e: unknown): number {
  if (e instanceof IntentError || e instanceof ConfigError) return 2;
  if (e instanceof PendingSwapError || e instanceof PendingUnreadableError) return 3;
  if (e instanceof OrientimOrderError) return 5;
  return 1;
}

/** Warns when the keypair file is readable by other users (POSIX only); null otherwise. */
export function keypairFileWarning(path: string): string | null {
  if (process.platform === 'win32') return null;
  try {
    const mode = statSync(path).mode & 0o777;
    return mode & 0o077
      ? `The wallet's keypair file can be read by other users of this machine (mode ${mode.toString(8)}): run chmod 600 on it.`
      : null;
  } catch {
    return null;
  }
}

/** Reads a solana-keygen file. Its contents never appear in an error. */
function readKeypair(path: string): Uint8Array {
  const warning = keypairFileWarning(path);
  if (warning) process.stderr.write(`${warning}\n`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`The wallet's keypair file cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'}). Nothing was started.`);
  }
  let bytes: unknown;
  try {
    bytes = JSON.parse(text);
  } catch {
    bytes = null;
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new ConfigError('The wallet\'s keypair file is not a solana-keygen file (a JSON array of 64 numbers). Nothing was started.');
  }
  return new Uint8Array(bytes);
}

/** Runs `orientim swap` from process.argv. */
export function commandLine(): void {
  // Release the wallet lock on termination; the next run settles any persisted swap.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      releaseHeldLocks();
      process.exit(signal === 'SIGTERM' ? 143 : 130);
    });
  }
  main().catch(e => {
    console.error(errorLine(e));
    process.exitCode = errorExitCode(e);
  });
}
