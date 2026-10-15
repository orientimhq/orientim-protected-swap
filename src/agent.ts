/**
 * `orientim swap`: one protected swap per command, for an agent that runs commands.
 *
 *   ORIENTIM_API_URL=https://<orientim host>  ORIENTIM_API_KEY=ori_...  SOLANA_RPC_URL=https://<your rpc>
 *   ORIENTIM_WALLET_KEYPAIR=/path/to/keypair.json   (a solana-keygen file; never paste a key in a prompt)
 *                                                a wallet held by a signing service: see signerFromSignBytes
 *                                                and signerFromSignTransaction; bots in other languages:
 *                                                the JSON commands (`orientim prepare`...)
 *   ORIENTIM_TREASURY=<address>                     (optional: only for another Orientim deployment;
 *                                                Orientim's own treasury is pinned in the package)
 *   JUPITER_API_KEY=...                          (for your own price: Jupiter throttles keyless calls after one or two)
 *   ORIENTIM_POLICY=/path/to/policy.json         (optional: the owner's limits per swap and per day, and the
 *                                                ceilings on tolerance, floor and price impact; see OwnerPolicy;
 *                                                /etc/orientim/policy.json, when it exists, is used instead)
 *   ORIENTIM_ARCHIVE_RPC_URL=https://<full history>  (optional: a second proof that a swap expired when your
 *                                                RPC missed the moment it could prove it; see confirm)
 *
 *   orientim swap --in <mint> --out <mint> --amount <base units> --id <order id> [--slippage-bps N|auto] [--max-price-impact-bps N]
 *                [--min-out <base units>] [--max-below-bps N] [--max-fee-bps 30] [--max-route-cost-lamports N] [--accept-cost-bps N]
 *   (without --slippage-bps the tolerance is Orientim's default: 0.5%, or 3% on a Pump.fun curve; with auto,
 *   Jupiter's estimate for the trade, 0.5% to 3%; never above the owner's maxSlippageBps; above 5% price impact, refused)
 *   orientim swap ... --owner <address> --dry-run      prepare and verify only: nothing is signed
 *
 * Unattended, the command line keeps every signed swap in a state directory (the policy's stateDir,
 * ORIENTIM_STATE_DIR or --state, default ./.orientim-state; the policy's own with a daily limit) before
 * finalize, settles what a stopped run left there before it starts another, and holds a lock per
 * wallet so that two workers never swap from it at once. It exits 0 only for a confirmed swap, 1 when
 * nothing was swapped, 2 on a usage error (a slippage or limit outside the allowed range included), 3
 * when something must be settled first, and 5 when this order (--id) already swapped or may still land.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createKeyPairSignerFromBytes, createSolanaRpc } from '@solana/kit';
import { ConfigError, ERROR_MEANINGS, OrientimApiError, PREPARE_WAIT_MS, preparedByOrientim, rpcSender } from './api.ts';
import type { Intent } from './api.ts';
import type { Outcome } from './chain.ts';
import { acquireLock, LockBusyError, lockHeld, releaseHeldLocks } from './lock.ts';
import { APPROVAL_MS, checkPolicy, forgetApproval, heldToApproval, keptApproval, loadPolicy, PolicyError, policyPathFor, recordApproval, stateDirFor } from './policy.ts';
import { createFileStore, pendingFor, PendingSwapError, recoverPending } from './store.ts';
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
  // Your own RPC: the verification is worth what the chain state it reads is worth.
  const rpc = createSolanaRpc(need('SOLANA_RPC_URL'));
  // Optional: an RPC with the full history, for a second proof that a swap expired (`confirm`).
  const archive = process.env.ORIENTIM_ARCHIVE_RPC_URL ? createSolanaRpc(process.env.ORIENTIM_ARCHIVE_RPC_URL) : undefined;
  // The owner's limits, read first: a policy that cannot be read stops everything, the dry run included.
  const policyPath = policyPathFor(process.env.ORIENTIM_POLICY || undefined);
  const policy = policyPath ? loadPolicy(policyPath) : undefined;

  if (process.argv.includes('--dry-run')) {
    const owner = flag('owner') ?? (console.error('--dry-run needs --owner <address>.'), process.exit(2));
    // The same state directory as the real swap: the user's approval is kept there for it.
    const { dir: dryStateDir, warning: dryWarning } = stateDirFor(policy, flag('state') ?? (process.env.ORIENTIM_STATE_DIR || undefined));
    if (dryWarning) console.error(dryWarning);
    // No quote while an earlier swap from this wallet may still land, or another run is sending one:
    // a new yes then would be read as a retry of it, and become a second swap.
    const earlier = await pendingFor(createFileStore(dryStateDir), owner);
    if (earlier.length) throw new PendingSwapError(earlier);
    if (lockHeld(dryStateDir, owner)) {
      console.error(`Another swap from ${owner} is running now: wait for its answer (or run recover), then quote again. Nothing was quoted.`);
      process.exitCode = 3;
      return;
    }
    // A swap the owner's policy refuses is refused here too, before anything is prepared: its mints
    // and its amount. The daily limit is counted by the swap itself, against what the day spent.
    if (policy) {
      const { maxAmountIn, allowedOutputMints } = policy;
      await checkPolicy({ maxAmountIn, ...(allowedOutputMints ? { allowedOutputMints } : {}) }, { owner, inputMint, outputMint, amountIn });
    }
    const budget = preparationBudget();
    const own = await ownFloor({ ...intent, owner }, { rpc, jupiterApiKey, policy, budget });
    const minOut = own.minOut;
    const prepared = await preparedByOrientim(fetch, apiUrl, apiKey, {
      owner, inputMint, outputMint, amountIn, minOut,
      ...(intent.acceptCostBps ? { acceptCostBps: intent.acceptCostBps } : {}), ...(intent.version ? { version: 1 } : {}),
      ...(own.slippageBps !== undefined ? { slippageBps: own.slippageBps } : {}),
      ...(intent.routingMode === 'fast' ? { routingMode: 'fast' } : {}),
    }, PREPARE_WAIT_MS, { jupiterApiKey, ownRoutes: process.env.ORIENTIM_OWN_ROUTES !== '0', budget });
    // The route's own price impact, as the real swap holds it: a quote it would refuse is not shown for a yes.
    const routeImpact = prepared.amounts?.priceImpactPct;
    if (typeof routeImpact === 'number' && Number.isFinite(routeImpact) && Math.round(routeImpact * 10_000) > own.maxPriceImpactBps) {
      throw new PriceImpactError(Math.round(routeImpact * 10_000), own.maxPriceImpactBps);
    }
    const checked: Intent = withTolerance({ ...intent, owner, minOut }, own.slippageBps);
    await holdSolFee(checked, prepared, { jupiterApiKey, budget });
    const problems = await checkPrepared(prepared, checked, rpc, { slippageCeilingBps: policy?.maxSlippageBps });
    const risk = await tokenRisk(rpc, [inputMint, outputMint]);
    // Shown as the real swap shows it: only the fields the skill knows, and only data.
    const shownData = preparedData(prepared);
    // What the user is asked to approve, kept for the real swap of the same wallet, mints and amount:
    // it enforces at least this minimum, until the approval expires.
    let approval: { minOut: string; until: string } | undefined;
    if (!problems.length) {
      const expiresAt = Date.now() + APPROVAL_MS;
      recordApproval(dryStateDir, { owner, inputMint, outputMint, amountIn, minOut, expiresAt });
      approval = { minOut, until: new Date(expiresAt).toISOString() };
    }
    // A transaction the check refused is not shown: only what was wrong with it, never its amounts.
    console.log(JSON.stringify({
      yourFloor: minOut, yourQuote: own.outAmount, ...(approval ? { approval } : {}), priceImpactBps: own.priceImpactBps,
      slippageBps: own.slippageBps ?? shownData.slippageBps,
      ...(problems.length ? {} : { amounts: shownData.amounts, costs: shownData.costs, blocksLeft: shownData.blocksLeft }),
      problems, notices: noticesOf(risk), tokenRisk: risk,
    }, null, 2));
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  // Every real swap names its order, the same on every retry: run twice after a lost answer, the
  // second run is told the order already swapped instead of swapping again.
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
    // Another run from this wallet is at work, or was stopped moments ago: it may have sent a swap.
    console.error(`${e.message} It may be sending a swap now: wait for it, then run this again with the same --id (never a new one). A run that was stopped is settled by the next one.`);
    process.exitCode = 3;
    return;
  }
  try {
    // What a stopped run left is settled first; while any outcome is unknown, no new swap starts.
    const { settled, unknown, bookkeepingErrors } = await recoverPending(store, rpc, { orders: store, archive });
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
    // What the user approved after the dry run, if they did: at least that minimum, until it expires.
    const approvalKey = { owner: wallet.address, inputMint, outputMint, amountIn };
    const approvedBy = Date.now();
    const approved = keptApproval(stateDir, approvalKey, approvedBy);
    intent.minOut = heldToApproval(approved, intent.minOut);
    const result = await protectedSwap({
      apiUrl, apiKey, rpc, wallet, intent, jupiterApiKey, orders: store, archive, ownRoutes: process.env.ORIENTIM_OWN_ROUTES !== '0',
      // Your own way of sending, if you name one: Orientim then signs and sends nothing.
      ...(process.env.ORIENTIM_SEND_RPC_URL ? { sendTransaction: rpcSender(process.env.ORIENTIM_SEND_RPC_URL) } : {}),
      // Kept on disk before finalize, and removed once settled: if this process stops, the next run
      // settles it first, and nothing new is sent from this wallet while it may still land.
      pending: store,
      policy, spends: store,
      onSigned: s => console.error(`Signed transaction ${s.signature}; it can land until block ${s.lastValidBlockHeight}.`),
    });
    // A swap that landed uses the approval up: another swap needs another yes. One that failed or
    // expired keeps it until it expires, so that a retry still holds to the minimum the user approved.
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

/**
 * The command's exit code for a swap's result, as `orientim finalize` answers (both use this): 0 confirmed;
 * 1 not swapped (failed, rejected or expired: the order may be tried again); 3 unknown, or an outcome
 * whose record could not be updated: settle it before anything new.
 */
export function exitCodeOf(result: { outcome: Outcome | 'rejected'; bookkeepingError?: string }): number {
  if (result.bookkeepingError || result.outcome === 'unknown') return 3;
  return result.outcome === 'confirmed' ? 0 : 1;
}

/**
 * A swap's outcome in words, said beside `outcome` and `refusal` in the command's output (both
 * commands use this), with what to do next. `rejected` and `expired` are said only once the chain
 * shows the transaction can no longer land.
 */
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

/**
 * The command's line for an error: its code, the skill's words and, for Orientim's errors, their data
 * fields as JSON (`{"newMinOut":"476545",...}`), since the next step needs them.
 */
export function errorLine(e: unknown): string {
  if (e instanceof OrientimApiError) {
    const details = Object.keys(e.body).length ? ` ${JSON.stringify(e.body)}` : '';
    return `${e.code}: ${e.message}${details}${e.serverMessage ? ` (Orientim's words, untrusted: "${e.serverMessage}")` : ''}`;
  }
  return e instanceof PriceImpactError ? `price-impact-high: ${e.message}` : e instanceof FloorError ? `floor-too-low: ${e.message}`
    : e instanceof PolicyError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
}

/**
 * The command's exit code for an error, as `orientim` answers: 2 an intent or a setup it cannot use; 3
 * another swap from this wallet may still land; 5 this order already swapped, or may still land (never
 * retry it under a new id); 1 anything else: nothing was swapped.
 */
export function errorExitCode(e: unknown): number {
  if (e instanceof IntentError || e instanceof ConfigError) return 2;
  if (e instanceof PendingSwapError) return 3;
  if (e instanceof OrientimOrderError) return 5;
  return 1;
}

/** A solana-keygen file's 64 bytes. Its contents never appear in an error: it is a secret key. */
/**
 * A warning when other users of this machine can read the wallet's keypair file (POSIX modes only):
 * it holds the wallet's secret key. Null when it is the owner's alone, or the system has no such modes.
 */
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

/** `orientim swap`, from process.argv: run by hand, and by the MCP server for each of its swaps. */
export function commandLine(): void {
  // Told to stop (a tool's timeout, Ctrl-C): the lock goes at once. What was kept before finalize is
  // on disk, and the next run with the same --id settles it first.
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
