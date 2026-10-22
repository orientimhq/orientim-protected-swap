/** Owner policy (`ORIENTIM_POLICY`), dry-run approvals, and the pre-signing check against both. */
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants as fsConstants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ConfigError } from './api.ts';
import { ownStateDir, temporaryFor } from './files.ts';
import { DAY_MS } from './util.ts';
import { MAX_BELOW_BPS, MAX_PRICE_IMPACT_BPS, MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS } from './verify.ts';

/**
 * Owner-set spending limits, read from a file the agent cannot write so an intent cannot raise them.
 * Amounts are input-token base units as strings. Mints absent from `maxAmountIn` cannot be swapped from.
 */
export type OwnerPolicy = {
  /** Per input mint: the most one swap may spend. */
  maxAmountIn: Record<string, string>;
  /**
   * Per input mint: the rolling 24-hour total one wallet may spend. A signed swap counts until the
   * chain proves it failed or can no longer land; an unknown outcome counts for the full 24 hours.
   */
  maxAmountInPerDay?: Record<string, string>;
  /** Absolute state directory that every command must use. Required with `maxAmountInPerDay`. */
  stateDir?: string;
  /** Allow routes where Jupiter reports no price impact. Refused by default. */
  allowUnknownPriceImpact?: boolean;
  /** Maximum route slippage in bps (10 to 1500). Higher requests are refused; higher defaults are lowered. */
  maxSlippageBps?: number;
  /** Maximum distance of the output floor below Jupiter's price, in bps (0 to 2000). Defaults to `MAX_BELOW_BPS`. */
  maxBelowBps?: number;
  /** Maximum price impact in bps (0 to 2000). Higher requests are refused; the 5% default is lowered. */
  maxPriceImpactBps?: number;
  /** Output mints the wallet may buy, including SOL or USDC when selling. Unset allows any token. */
  allowedOutputMints?: string[];
};

/** Policy ceilings on slippage, floor and price impact that an intent may not exceed. */
export type OwnerCeilings = Pick<OwnerPolicy, 'maxSlippageBps' | 'maxBelowBps' | 'maxPriceImpactBps' | 'allowUnknownPriceImpact'>;

/** Reads and validates a policy file. Unknown fields are rejected. */
export function loadPolicy(path: string): OwnerPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`The owner's policy ${path} cannot be read as JSON: ${e instanceof Error ? e.message : String(e)}. Nothing was prepared.`);
  }
  return parsePolicy(raw, path);
}

/** Validates a policy object. `source` identifies it in error messages. */
export function parsePolicy(raw: unknown, source: string): OwnerPolicy {
  const path = source;
  const bad = (why: string) => new ConfigError(`The owner's policy ${path} ${why}. Nothing was prepared.`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('is not a JSON object');
  const known = ['maxAmountIn', 'maxAmountInPerDay', 'stateDir', 'allowUnknownPriceImpact', 'maxSlippageBps', 'maxBelowBps', 'maxPriceImpactBps', 'allowedOutputMints'];
  const unknown = Object.keys(raw).filter(k => !known.includes(k));
  if (unknown.length) throw bad(`has fields it does not know: ${unknown.join(', ')}`);
  const limits = (name: string, value: unknown): Record<string, string> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(`needs ${name} as {"<mint>": "<base units>"}`);
    for (const [mint, amount] of Object.entries(value)) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw bad(`names ${JSON.stringify(mint)} in ${name}, which is not a mint address`);
      if (typeof amount !== 'string' || !/^\d{1,20}$/.test(amount)) throw bad(`needs ${name}.${mint} as a whole number of base units, in a string`);
    }
    return value as Record<string, string>;
  };
  const policy = raw as Record<string, unknown>;
  if (policy.stateDir !== undefined && !(typeof policy.stateDir === 'string' && isAbsolute(policy.stateDir))) {
    throw bad('needs stateDir as an absolute path');
  }
  if (policy.allowUnknownPriceImpact !== undefined && typeof policy.allowUnknownPriceImpact !== 'boolean') {
    throw bad('needs allowUnknownPriceImpact as true or false');
  }
  const ceiling = (name: string, least: number, most: number): number | undefined => {
    const v = policy[name];
    if (v === undefined) return undefined;
    if (!(typeof v === 'number' && Number.isInteger(v) && v >= least && v <= most)) throw bad(`needs ${name} as a whole number of bps from ${least} to ${most}`);
    return v;
  };
  const outputs = policy.allowedOutputMints;
  if (outputs !== undefined && !(Array.isArray(outputs) && outputs.length > 0 && outputs.every(m => typeof m === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)))) {
    throw bad('needs allowedOutputMints as a list of at least one mint address');
  }
  const maxSlippageBps = ceiling('maxSlippageBps', MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS);
  const maxBelowBps = ceiling('maxBelowBps', 0, MAX_BELOW_BPS);
  const maxPriceImpactBps = ceiling('maxPriceImpactBps', 0, MAX_PRICE_IMPACT_BPS);
  return {
    maxAmountIn: limits('maxAmountIn', policy.maxAmountIn),
    ...(policy.maxAmountInPerDay !== undefined ? { maxAmountInPerDay: limits('maxAmountInPerDay', policy.maxAmountInPerDay) } : {}),
    ...(policy.stateDir !== undefined ? { stateDir: policy.stateDir as string } : {}),
    ...(policy.allowUnknownPriceImpact === true ? { allowUnknownPriceImpact: true } : {}),
    ...(maxSlippageBps !== undefined ? { maxSlippageBps } : {}),
    ...(maxBelowBps !== undefined ? { maxBelowBps } : {}),
    ...(maxPriceImpactBps !== undefined ? { maxPriceImpactBps } : {}),
    ...(outputs !== undefined ? { allowedOutputMints: [...outputs as string[]] } : {}),
  };
}

/** Without the owner's limits a model's request alone would decide what is swapped, so signing needs them. */
export const NO_POLICY = 'No owner\'s policy is set, and a swap needs one: the owner writes their limits (maxAmountIn per input mint) '
  + 'to /etc/orientim/policy.json (C:\\ProgramData\\Orientim\\policy.json on Windows) or to a file named in ORIENTIM_POLICY. Nothing was prepared.';

/** Loads the owner's policy, which every command that may sign requires, with any `policyWarning`. */
export function requiredPolicy(named: string | undefined, system?: string): { policy: OwnerPolicy; warning: string | null } {
  const path = policyPathFor(named, system);
  if (!path) throw new ConfigError(NO_POLICY);
  return { policy: loadPolicy(path), warning: policyWarning(path, system) };
}

/** Admin-owned system policy path. Hardcoded so unsetting `ORIENTIM_POLICY` cannot bypass it. */
export const SYSTEM_POLICY_PATH = process.platform === 'win32' ? 'C:\\ProgramData\\Orientim\\policy.json' : '/etc/orientim/policy.json';

/** Resolves the policy path: the system policy if present (exclusively), else `named`, else none. */
export function policyPathFor(named: string | undefined, system: string = SYSTEM_POLICY_PATH, platform: NodeJS.Platform = process.platform): string | undefined {
  // Windows paths are case-insensitive.
  const same = (a: string, b: string) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (existsSync(system)) {
    if (named && !same(resolve(named), resolve(system))) {
      throw new ConfigError(`The owner's policy is ${system}; ORIENTIM_POLICY names another file (${named}), which is not used. Nothing was prepared.`);
    }
    // A system policy the current user can write is not trusted (POSIX only).
    if (system === SYSTEM_POLICY_PATH && platform !== 'win32' && process.getuid?.() !== 0) {
      for (const path of [system, dirname(system)]) {
        let writable = true;
        try {
          accessSync(path, fsConstants.W_OK);
        } catch {
          writable = false;
        }
        if (writable) throw new ConfigError(`The owner's policy ${system} can be changed by the user this runs as (${path} is writable): an administrator makes it, and its folder, writable only by root. Nothing was prepared.`);
      }
    }
    return system;
  }
  return named || undefined;
}

/**
 * A note for the owner when the user this runs as can change the named policy file or its folder (POSIX
 * only); null otherwise, and for the administrator's policy.
 */
export function policyWarning(path: string, system: string = SYSTEM_POLICY_PATH, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32' || process.getuid?.() === 0 || resolve(path) === resolve(system)) return null;
  for (const p of [path, dirname(resolve(path))]) {
    try {
      accessSync(p, fsConstants.W_OK);
    } catch {
      continue;
    }
    return `The owner's policy ${path} is writable by the user this runs as (${p}). An administrator's ${system}, writable only by root, keeps the limits out of this user's reach.`;
  }
  return null;
}

/** Fallback state directory, relative to the working directory. */
export const DEFAULT_STATE_DIR = '.orientim-state';

/**
 * Resolves the state directory: the policy's `stateDir` (exclusively), else `given`, else
 * `DEFAULT_STATE_DIR` with a `warning`.
 */
export function stateDirFor(policy: OwnerPolicy | undefined, given: string | undefined): { dir: string; warning?: string } {
  if (policy?.stateDir) {
    if (given !== undefined && resolve(given) !== resolve(policy.stateDir)) {
      throw new ConfigError(`The owner's policy keeps the state in ${policy.stateDir}; another state directory (${given}) is not used. Nothing was started.`);
    }
    return { dir: policy.stateDir };
  }
  // An agent-chosen directory would start an empty spend record, resetting the daily limit.
  const dailyLimit = !!policy?.maxAmountInPerDay && Object.keys(policy.maxAmountInPerDay).length > 0;
  if (dailyLimit) {
    throw new ConfigError("The owner's policy sets a daily limit but no stateDir: the policy must name the state directory as an absolute path, so that every swap counts against the limit wherever it is started. Nothing was started.");
  }
  if (given) return { dir: given };
  return {
    dir: DEFAULT_STATE_DIR,
    warning: `The state directory is ${resolve(DEFAULT_STATE_DIR)}, relative to where this was started: set ORIENTIM_STATE_DIR to an absolute path that outlives this process, the same for every run of this wallet.`,
  };
}

/**
 * A minimum output the user approved after a dry run, valid until `expiresAt` (ms). The matching real
 * swap enforces at least this `minOut` and consumes the approval once sent.
 */
export type Approval = { owner: string; inputMint: string; outputMint: string; amountIn: string; minOut: string; expiresAt: number };
/** Lifetime of a dry-run approval, in ms. */
export const APPROVAL_MS = 10 * 60_000;
type ApprovalKey = Pick<Approval, 'owner' | 'inputMint' | 'outputMint' | 'amountIn'>;
/** Normalizes leading zeros so equal amounts map to the same approval. */
const sameAmount = (amount: string) => (/^\d{1,64}$/.test(amount) ? BigInt(amount).toString() : amount);
const approvalFile = (dir: string, k: ApprovalKey) =>
  join(dir, `approval-${createHash('sha256').update(`${k.owner}:${k.inputMint}:${k.outputMint}:${sameAmount(k.amountIn)}`).digest('hex').slice(0, 40)}.json`);

/** Writes an approval atomically to the state directory. */
export function recordApproval(dir: string, approval: Approval): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  ownStateDir(dir);
  const path = approvalFile(dir, approval);
  const temporary = temporaryFor(path);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(approval));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

/** Reads the approval for this key, or null if none or malformed. */
export function approvalFor(dir: string, key: ApprovalKey): Approval | null {
  let a: Partial<Approval>;
  try {
    a = JSON.parse(readFileSync(approvalFile(dir, key), 'utf8')) as Partial<Approval>;
  } catch {
    return null;
  }
  const same = a.owner === key.owner && a.inputMint === key.inputMint && a.outputMint === key.outputMint
    && typeof a.amountIn === 'string' && sameAmount(a.amountIn) === sameAmount(key.amountIn);
  if (!same || typeof a.minOut !== 'string' || !/^\d{1,20}$/.test(a.minOut) || typeof a.expiresAt !== 'number') return null;
  return a as Approval;
}

/**
 * Removes the approval for this key. With `recordedBy` (ms), keeps an approval recorded later, so a
 * landing swap does not consume a newer approval.
 */
export function forgetApproval(dir: string, key: ApprovalKey, recordedBy?: number): void {
  if (recordedBy !== undefined) {
    const kept = approvalFor(dir, key);
    if (kept && kept.expiresAt - APPROVAL_MS > recordedBy) return;
  }
  rmSync(approvalFile(dir, key), { force: true });
}

/**
 * Returns the minimum output to enforce given a kept approval. Throws `ApprovalError` if the approval
 * expired or `minOut` is below the approved minimum.
 */
export function heldToApproval(approval: Approval | null, minOut: string | undefined, now = Date.now()): string | undefined {
  if (!approval) return minOut;
  if (approval.expiresAt < now) {
    throw new ApprovalError('The user\'s approval from the dry run has expired: run the dry run again and ask the user again. Nothing was started.');
  }
  if (minOut !== undefined && BigInt(minOut) < BigInt(approval.minOut)) {
    throw new ApprovalError(`The minimum ${minOut} (--min-out, or intent.minOut) is below the ${approval.minOut} the user approved after the dry run: run the dry run again and ask the user before accepting less. Nothing was started.`);
  }
  return minOut !== undefined && BigInt(minOut) > BigInt(approval.minOut) ? minOut : approval.minOut;
}

/** Thrown when a swap would accept less than approved, or the approval expired. */
export class ApprovalError extends Error {}

/** Returns the kept approval for this key. Expired approvals are kept for a day so they keep refusing. */
export function keptApproval(dir: string, key: ApprovalKey, now = Date.now()): Approval | null {
  const approved = approvalFor(dir, key);
  // An expiry later than a fresh dry run could set means the file was not written by a dry run.
  if (approved && (approved.expiresAt + DAY_MS < now || approved.expiresAt > now + APPROVAL_MS + 60_000)) {
    forgetApproval(dir, key);
    return null;
  }
  return approved;
}

/** Thrown when a swap violates the owner's policy. */
export class PolicyError extends Error {
  readonly code: 'mint-not-allowed' | 'output-not-allowed' | 'amount-over-limit' | 'daily-limit' | 'slippage-over-limit' | 'floor-over-limit' | 'impact-over-limit';
  readonly limit?: string;
  readonly spent?: string;
  constructor(code: PolicyError['code'], message: string, figures: { limit?: string; spent?: string } = {}) {
    super(`${message} The limit is the owner's (ORIENTIM_POLICY); only the owner may change it. Nothing was sent.`);
    this.code = code;
    Object.assign(this, figures);
  }
}

/** Storage for spends counted against a daily limit. */
export type SpendLog = {
  /** Total spent by `owner` from `mint` since `since` (ms), excluding signature `except`. */
  spentSince(owner: string, mint: string, since: number, except?: string): Promise<bigint>;
  recordSpend(entry: { signature: string; owner: string; mint: string; amountIn: string; at: number }): Promise<void>;
  /** Removes a spend for a swap that was never sent, or that the chain proves failed or cannot land. */
  forgetSpend?(signature: string): Promise<void>;
};

/**
 * Checks a swap against the policy's mint, output, per-swap and daily limits. Throws `PolicyError`.
 * A daily limit without `spends` is refused rather than left uncounted.
 */
export async function checkPolicy(
  policy: OwnerPolicy, swap: { owner: string; inputMint: string; outputMint: string; amountIn: string }, spends?: SpendLog, except?: string,
): Promise<void> {
  const amount = BigInt(swap.amountIn);
  const most = Object.hasOwn(policy.maxAmountIn, swap.inputMint) ? policy.maxAmountIn[swap.inputMint] : undefined;
  if (most === undefined) throw new PolicyError('mint-not-allowed', `The owner's policy does not allow swapping from ${swap.inputMint}.`);
  if (policy.allowedOutputMints && !policy.allowedOutputMints.includes(swap.outputMint)) {
    throw new PolicyError('output-not-allowed', `The owner's policy does not allow buying ${swap.outputMint}.`);
  }
  if (amount > BigInt(most)) {
    throw new PolicyError('amount-over-limit', `${swap.amountIn} is above the owner's limit of ${most} per swap from ${swap.inputMint}.`, { limit: most });
  }
  const daily = policy.maxAmountInPerDay && Object.hasOwn(policy.maxAmountInPerDay, swap.inputMint) ? policy.maxAmountInPerDay[swap.inputMint] : undefined;
  if (daily === undefined) return;
  if (!spends) throw new PolicyError('daily-limit', 'The owner\'s policy sets a daily limit, and no record of earlier swaps is kept to count it against.', { limit: daily });
  const spent = await spends.spentSince(swap.owner, swap.inputMint, Date.now() - DAY_MS, except);
  if (spent + amount > BigInt(daily)) {
    throw new PolicyError('daily-limit', `${swap.amountIn} more would bring the last 24 hours to ${spent + amount}, above the owner's daily limit of ${daily} from ${swap.inputMint}.`, { limit: daily, spent: spent.toString() });
  }
}
