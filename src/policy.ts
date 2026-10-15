/**
 * The owner's own limits (`ORIENTIM_POLICY`), the approvals a dry run keeps, and the check of a swap
 * against both before anything is signed.
 */
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants as fsConstants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ConfigError } from './api.ts';
import { ownStateDir, temporaryFor } from './files.ts';
import { DAY_MS } from './util.ts';
import { MAX_BELOW_BPS, MAX_PRICE_IMPACT_BPS, MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS } from './verify.ts';

/**
 * The owner's own limits on what the wallet may spend, from a file only the owner writes
 * (`ORIENTIM_POLICY`), never from the intent: a misled agent, or one that lost its context after a
 * restart, cannot raise them by asking. Amounts are base units of the input token, as strings. A mint
 * not listed in `maxAmountIn` is not swapped from at all.
 */
export type OwnerPolicy = {
  /** Per input mint: the most one swap may spend. */
  maxAmountIn: Record<string, string>;
  /**
   * Per input mint: the most all swaps from one wallet signed in the last 24 hours may spend together.
   * A swap counts once signed and kept, whether it lands or not: a failed or expired one frees its
   * share only when its 24 hours pass.
   */
  maxAmountInPerDay?: Record<string, string>;
  /**
   * Where swaps, orders and what the last 24 hours spent are kept, as an absolute path. With it,
   * every command uses this directory and refuses another (`--state`, `ORIENTIM_STATE_DIR`), so a
   * daily limit counts every swap wherever the command is started from. A policy with a daily limit
   * needs it.
   */
  stateDir?: string;
  /**
   * Go on when Jupiter does not state a price impact (`priceImpactBps` null). Without it such a
   * swap is refused: an unknown impact is not a small one. Only the owner may set it.
   */
  allowUnknownPriceImpact?: boolean;
  /**
   * The most slippage tolerance a route may be built at, in bps (10 to 1500). The agent chooses
   * within it: a `slippageBps` above it is refused (`slippage-over-limit`); Orientim's default (3% on
   * a Pump.fun curve) and an `"auto"` estimate above it are lowered to it.
   */
  maxSlippageBps?: number;
  /**
   * The furthest below Jupiter's own price the agent's floor may sit, in bps (0 to 2000): a
   * `maxBelowBps` or a `minOut` further below is refused (`floor-over-limit`), a default further
   * below is raised to it. Without it the skill's own limit holds (`MAX_BELOW_BPS`, 20%).
   */
  maxBelowBps?: number;
  /**
   * The most price impact a swap may have, in bps (0 to 2000): a `maxPriceImpactBps` above it is
   * refused (`impact-over-limit`), and the default of 5% is lowered to it.
   */
  maxPriceImpactBps?: number;
  /**
   * The tokens the wallet may buy, as mint addresses. With it, a swap into a token not listed is
   * refused (`output-not-allowed`), so a misled agent cannot be talked into buying a token someone
   * else chose; selling back counts too, so list SOL or USDC if the agent sells into them. Without
   * it, any token may be bought.
   */
  allowedOutputMints?: string[];
};

/** The owner's ceilings on what an intent may choose: the route's tolerance, the floor, the price impact. */
export type OwnerCeilings = Pick<OwnerPolicy, 'maxSlippageBps' | 'maxBelowBps' | 'maxPriceImpactBps' | 'allowUnknownPriceImpact'>;


/** Reads and checks the owner's policy file: anything it does not understand is refused, not ignored. */
export function loadPolicy(path: string): OwnerPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`The owner's policy ${path} cannot be read as JSON: ${e instanceof Error ? e.message : String(e)}. Nothing was prepared.`);
  }
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

/**
 * Where the owner's policy is kept outside the agent's reach: a system path only an administrator
 * writes (`/etc/orientim/policy.json`, or `C:\ProgramData\Orientim\policy.json` on Windows). It is
 * named in the code, not in the environment, so that an agent which runs the command with
 * `ORIENTIM_POLICY` unset or changed is held to the same limits.
 */
export const SYSTEM_POLICY_PATH = process.platform === 'win32' ? 'C:\\ProgramData\\Orientim\\policy.json' : '/etc/orientim/policy.json';

/**
 * The policy file a command reads: the system one when it exists (and nothing else is accepted then:
 * `ORIENTIM_POLICY` may name it or be unset), otherwise the one `ORIENTIM_POLICY` names, otherwise none.
 */
export function policyPathFor(named: string | undefined, system: string = SYSTEM_POLICY_PATH, platform: NodeJS.Platform = process.platform): string | undefined {
  // Windows paths are one path in any letter case.
  const same = (a: string, b: string) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (existsSync(system)) {
    if (named && !same(resolve(named), resolve(system))) {
      throw new ConfigError(`The owner's policy is ${system}; ORIENTIM_POLICY names another file (${named}), which is not used. Nothing was prepared.`);
    }
    // The system policy holds only while the agent cannot rewrite it: a file, or a folder, the user
    // this runs as may write is not the owner's word (POSIX; on Windows an administrator makes the
    // folder before anyone else can).
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

/** The default state directory: relative to wherever the command is started, so named only as a last resort. */
export const DEFAULT_STATE_DIR = '.orientim-state';

/**
 * The state directory a command uses: the policy's own when it names one (and nothing else is
 * accepted then), otherwise the one given (`--state`, `ORIENTIM_STATE_DIR`), otherwise
 * `DEFAULT_STATE_DIR`. A policy with a daily limit must name its own `stateDir`: any other directory
 * would be a new, empty record, and so a new day's allowance.
 * `warning` says when the directory is the relative default.
 */
export function stateDirFor(policy: OwnerPolicy | undefined, given: string | undefined): { dir: string; warning?: string } {
  if (policy?.stateDir) {
    if (given !== undefined && resolve(given) !== resolve(policy.stateDir)) {
      throw new ConfigError(`The owner's policy keeps the state in ${policy.stateDir}; another state directory (${given}) is not used. Nothing was started.`);
    }
    return { dir: policy.stateDir };
  }
  // A daily limit counts what one directory recorded: one the agent could choose (`--state`,
  // ORIENTIM_STATE_DIR) would let a run start from an empty record, so only the policy names it.
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
 * What the user approved after a dry run: the least that arrives (`minOut`) for this wallet, these
 * mints and this amount, until `expiresAt` (ms). The dry run records it in the state directory; the
 * real swap of the same wallet, mints and amount enforces at least that minimum, refuses a lower
 * `--min-out`, and refuses once the approval expired, so that a "yes" holds for what the user saw,
 * not for whatever the market offers later. A swap that went out uses it up.
 */
export type Approval = { owner: string; inputMint: string; outputMint: string; amountIn: string; minOut: string; expiresAt: number };
/** How long a dry run's approval holds: after that, run the dry run again and ask again. */
export const APPROVAL_MS = 10 * 60_000;
type ApprovalKey = Pick<Approval, 'owner' | 'inputMint' | 'outputMint' | 'amountIn'>;
/** An amount as one spelling: "05000000" and "5000000" are the same amount, and find the same approval. */
const sameAmount = (amount: string) => (/^\d{1,64}$/.test(amount) ? BigInt(amount).toString() : amount);
const approvalFile = (dir: string, k: ApprovalKey) =>
  join(dir, `approval-${createHash('sha256').update(`${k.owner}:${k.inputMint}:${k.outputMint}:${sameAmount(k.amountIn)}`).digest('hex').slice(0, 40)}.json`);

/** Keeps what the user approved (`Approval`) in the state directory, the owner's alone. */
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

/** The approval kept for this wallet, these mints and this amount; null when there is none. */
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
 * Removes the approval for this wallet, these mints and this amount: used up, or expired. With
 * `recordedBy` (ms), only one recorded by then: a swap that lands uses up the yes it was held to,
 * never a newer one the user gave for the same swap while it was on its way.
 */
export function forgetApproval(dir: string, key: ApprovalKey, recordedBy?: number): void {
  if (recordedBy !== undefined) {
    const kept = approvalFor(dir, key);
    if (kept && kept.expiresAt - APPROVAL_MS > recordedBy) return;
  }
  rmSync(approvalFile(dir, key), { force: true });
}

/**
 * Holds a real swap's minimum to what the user approved after the dry run, if they did: at least the
 * approved minimum, never a lower `minOut`, and nothing once the approval expired. Returns the minimum
 * to enforce (the intent's own when no approval is kept). Throws `ApprovalError` otherwise.
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

/** The real swap would accept less than the user approved after the dry run, or the approval expired. */
export class ApprovalError extends Error {}

/**
 * The approval kept for this wallet, these mints and this amount, for `orientim swap` and for
 * the JSON commands alike. An expired approval keeps refusing until a new dry run replaces it; a day
 * later it is forgotten.
 */
export function keptApproval(dir: string, key: ApprovalKey, now = Date.now()): Approval | null {
  const approved = approvalFor(dir, key);
  // An approval no dry run could have written (it would expire later than one made now) is not the user's.
  if (approved && (approved.expiresAt + DAY_MS < now || approved.expiresAt > now + APPROVAL_MS + 60_000)) {
    forgetApproval(dir, key);
    return null;
  }
  return approved;
}

/** The swap is outside the owner's policy: refused before anything was prepared or sent. */
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

/** Where the swaps a policy counts per day are kept: the file store keeps them beside the swaps. */
export type SpendLog = {
  /** What swaps from `owner` in `mint` signed since `since` (ms) spent, other than `except`. */
  spentSince(owner: string, mint: string, since: number, except?: string): Promise<bigint>;
  recordSpend(entry: { signature: string; owner: string; mint: string; amountIn: string; at: number }): Promise<void>;
  /**
   * Takes back a spend recorded for a swap that was then refused before it was kept (its order was
   * taken by another run, or it could not be kept): it was never sent, so it does not count.
   */
  forgetSpend?(signature: string): Promise<void>;
};

/**
 * Holds one swap to the owner's policy: the mint must be listed, the token bought allowed when the
 * policy names the ones it may buy, the amount within the per-swap limit, and, with a daily limit,
 * this amount and what the last 24 hours spent within it. A daily
 * limit needs `spends`; without it the swap is refused rather than let through uncounted.
 */
export async function checkPolicy(
  policy: OwnerPolicy, swap: { owner: string; inputMint: string; outputMint: string; amountIn: string }, spends?: SpendLog, except?: string,
): Promise<void> {
  const amount = BigInt(swap.amountIn);
  const most = policy.maxAmountIn[swap.inputMint];
  if (most === undefined) throw new PolicyError('mint-not-allowed', `The owner's policy does not allow swapping from ${swap.inputMint}.`);
  if (policy.allowedOutputMints && !policy.allowedOutputMints.includes(swap.outputMint)) {
    throw new PolicyError('output-not-allowed', `The owner's policy does not allow buying ${swap.outputMint}.`);
  }
  if (amount > BigInt(most)) {
    throw new PolicyError('amount-over-limit', `${swap.amountIn} is above the owner's limit of ${most} per swap from ${swap.inputMint}.`, { limit: most });
  }
  const daily = policy.maxAmountInPerDay?.[swap.inputMint];
  if (daily === undefined) return;
  if (!spends) throw new PolicyError('daily-limit', 'The owner\'s policy sets a daily limit, and no record of earlier swaps is kept to count it against.', { limit: daily });
  const spent = await spends.spentSince(swap.owner, swap.inputMint, Date.now() - DAY_MS, except);
  if (spent + amount > BigInt(daily)) {
    throw new PolicyError('daily-limit', `${swap.amountIn} more would bring the last 24 hours to ${spent + amount}, above the owner's daily limit of ${daily} from ${swap.inputMint}.`, { limit: daily, spent: spent.toString() });
  }
}
