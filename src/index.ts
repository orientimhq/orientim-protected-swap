/**
 * @orientimhq/swap: protected Solana swaps for agents and bots. Each transaction is verified against
 * your own RPC before the wallet signs it, and the route can spend only the approved amount.
 *
 *   import { protectedSwap, createFileStore, acquireLock, loadPolicy } from '@orientimhq/swap';
 */

// Agent API: intents, responses, errors.
export {
  ConfigError, dataOnly, ERROR_MEANINGS, errorDetails, OrientimApiError, rpcSender, safeCode, SKILL_VERSION,
  untrustedLine,
} from './api.ts';
export type {
  ApiError, Finalized, Intent, Prepared, SendTransaction,
} from './api.ts';

// API keys.
export {
  apiKeyChallenge, isApiKeyMessage, redeemApiKey, requestApiKey,
} from './keys.ts';

// Signing and on-chain confirmation.
export {
  confirm, LAG_BLOCKS, lastBlockOf, MIN_BLOCKS_TO_FINALIZE, signAsWallet, signerFromSignBytes,
  signerFromSignTransaction, temporaryAuthorityOf,
} from './chain.ts';
export type {
  Outcome, WalletSigner,
} from './chain.ts';

// Per-wallet locking.
export {
  acquireLock, LockBusyError, lockHeld, releaseHeldLocks,
} from './lock.ts';

// Owner policy and approvals.
export {
  APPROVAL_MS, ApprovalError, approvalFor, checkPolicy, DEFAULT_STATE_DIR, forgetApproval, heldToApproval,
  keptApproval, loadPolicy, parsePolicy, PolicyError, policyPathFor, recordApproval, stateDirFor, SYSTEM_POLICY_PATH,
} from './policy.ts';
export type {
  Approval, OwnerCeilings, OwnerPolicy, SpendLog,
} from './policy.ts';

// Pending swap storage and settlement.
export {
  createFileStore, pendingFor, PendingSwapError, recoverPending, resolvePending, settleOrder, takeOrder,
} from './store.ts';
export type {
  FoundOrder, OrderBook, OrderRecord, PendingStore, Signed,
} from './store.ts';

// Protected swap flow.
export {
  checkPrepared, failureCause, fillAgainstQuote, finalizeSigned, FloorError, holdSolFee, IntentError,
  networkCause, OrientimOrderError, ownFloor, prepareChecked, preparedData, PriceImpactError, protectedSwap,
  receivedFor, resumeSigned, retryRefused, withTolerance,
} from './swap.ts';
export type {
  Checked, TimedPhase,
} from './swap.ts';

// CLI exit codes and messages.
export {
  commandLine, errorExitCode, errorLine, exitCodeOf, keypairFileWarning, outcomeMeaning,
} from './agent.ts';

// Client-side checks run before signing.
export * from './verify.ts';
export { curvePrice } from './curve-price.ts';

// In-process JSON command interface.
export { RETRYABLE_CODES, runCli, withRetryHints } from './cli.ts';
export type { CliDeps, CliResult } from './cli.ts';

// Transaction verifier for externally built transactions.
export { verify as verifyTransaction, parseInstruction } from '@orientimhq/verifier';
export type { Parsed, VerifyOptions } from '@orientimhq/verifier';
export type { AccountState, ChainSnapshot, Policy, RuleId, Verdict, Violation } from '@orientimhq/core/types';
