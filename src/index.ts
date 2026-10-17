/**
 * @orientimhq/swap: Orientim's protected swap on Solana, for agents and bots. The route can only touch
 * the amount the wallet approves, and the exact transaction is checked on your own RPC before your
 * wallet signs it (see SKILL.md and reference/AGENT-API.md).
 *
 *   import { protectedSwap, createFileStore, acquireLock, loadPolicy } from '@orientimhq/swap';
 *
 * The same package is the `orientim` command (prepare, finalize, check, recover, resolve, swap,
 * key-challenge, key) and, as `orientim mcp`, the MCP server.
 */

// The agent API: intents, answers, errors.
export {
  ConfigError, dataOnly, ERROR_MEANINGS, errorDetails, OrientimApiError, rpcSender, safeCode, SKILL_VERSION,
  untrustedLine,
} from './api.ts';
export type {
  ApiError, Finalized, Intent, Prepared, SendTransaction,
} from './api.ts';

// The wallet's own API key.
export {
  apiKeyChallenge, isApiKeyMessage, redeemApiKey, requestApiKey,
} from './keys.ts';

// Signing as the wallet, and the outcome read on your RPC.
export {
  confirm, LAG_BLOCKS, lastBlockOf, MIN_BLOCKS_TO_FINALIZE, signAsWallet, signerFromSignBytes,
  signerFromSignTransaction, temporaryAuthorityOf,
} from './chain.ts';
export type {
  Outcome, WalletSigner,
} from './chain.ts';

// One run per wallet at a time.
export {
  acquireLock, LockBusyError, lockHeld, releaseHeldLocks,
} from './lock.ts';

// The owner's limits and the approvals a dry run keeps.
export {
  APPROVAL_MS, ApprovalError, approvalFor, checkPolicy, DEFAULT_STATE_DIR, forgetApproval, heldToApproval,
  keptApproval, loadPolicy, parsePolicy, PolicyError, policyPathFor, recordApproval, stateDirFor, SYSTEM_POLICY_PATH,
} from './policy.ts';
export type {
  Approval, OwnerCeilings, OwnerPolicy, SpendLog,
} from './policy.ts';

// Where signed swaps wait for their outcome, and what settles them.
export {
  createFileStore, pendingFor, PendingSwapError, recoverPending, resolvePending, settleOrder, takeOrder,
} from './store.ts';
export type {
  FoundOrder, OrderBook, OrderRecord, PendingStore, Signed,
} from './store.ts';

// The protected swap itself: prepare, check, sign, finalize, confirm.
export {
  checkPrepared, failureCause, fillAgainstQuote, finalizeSigned, FloorError, holdSolFee, IntentError,
  networkCause, OrientimOrderError, ownFloor, prepareChecked, preparedData, PriceImpactError, protectedSwap,
  receivedFor, resumeSigned, retryRefused, withTolerance,
} from './swap.ts';
export type {
  Checked, TimedPhase,
} from './swap.ts';

// The command line's exit codes and messages.
export {
  commandLine, errorExitCode, errorLine, exitCodeOf, keypairFileWarning, outcomeMeaning,
} from './agent.ts';

// The verifier the client runs before signing: Orientim's limits on a prepared swap, the agent's own
// price floor, and the token's risks.
export * from './verify.ts';

// For bots that drive the swap as JSON commands (the `orientim` command, in-process).
export { RETRYABLE_CODES, runCli, withRetryHints } from './cli.ts';
export type { CliDeps, CliResult } from './cli.ts';

// The seven rules (R1–R7) on the exact bytes the wallet signs, for a transaction built elsewhere.
export { verify as verifyTransaction, parseInstruction } from '@orientimhq/verifier';
export type { Parsed, VerifyOptions } from '@orientimhq/verifier';
export type { AccountState, ChainSnapshot, Policy, RuleId, Verdict, Violation } from '@orientimhq/core/types';
