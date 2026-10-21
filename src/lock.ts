/**
 * Per-wallet lock file in the state directory. A lock is taken over only when its holder is provably
 * gone or the lock is stale.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, utimesSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from './api.ts';
import { DIR_MODE, FILE_MODE } from './files.ts';
import { BASE58 } from './util.ts';

/** Thrown when another run holds the wallet's lock and may be sending a swap. */
export class LockBusyError extends Error {
  readonly path: string;
  constructor(owner: string, path: string) {
    super(`Another swap from ${owner} is running (lock ${path}); nothing was started.`);
    this.path = path;
  }
}

/** Release callbacks for locks held by this process. */
const heldLocks = new Set<() => void>();
/** Tokens of locks held by this process; a lock with this pid but another token belongs to a predecessor. */
const heldTokens = new Set<string>();

let bootIdRead: string | null | undefined;
let pidNsRead: string | null | undefined;
/** Returns this process's pid namespace (e.g. `pid:[4026531836]`), or undefined off Linux. */
export function pidNamespace(): string | undefined {
  if (pidNsRead === undefined) {
    try {
      const ns = readlinkSync('/proc/self/ns/pid');
      pidNsRead = /^pid:\[\d{1,20}\]$/.test(ns) ? ns : null;
    } catch {
      pidNsRead = null;
    }
  }
  return pidNsRead ?? undefined;
}

/** Returns the Linux boot id, or undefined. A lock from an earlier boot has no live holder. */
export function bootId(): string | undefined {
  if (bootIdRead === undefined) {
    try {
      const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      bootIdRead = /^[0-9a-f-]{16,64}$/i.test(id) ? id : null;
    } catch {
      bootIdRead = null;
    }
  }
  return bootIdRead ?? undefined;
}

/** Releases every lock this process holds, so a run stopped by a signal does not block the next until stale. */
export function releaseHeldLocks(): void {
  for (const release of [...heldLocks]) release();
}

type LockFile = { token?: unknown; pid?: unknown; host?: unknown; bootId?: unknown; pidNs?: unknown };

/**
 * Returns true when the lock's writer is provably gone: same host, and the host rebooted, the pid is
 * reused by this process (container restart), or no process has that pid.
 */
export function holderIsGone(lock: LockFile | null): boolean {
  if (!lock || lock.host !== hostname() || !Number.isInteger(lock.pid) || (lock.pid as number) <= 0) return false;
  const boot = bootId();
  if (boot && typeof lock.bootId === 'string' && lock.bootId !== boot) return true;
  // Pids from another namespace cannot be checked here; the lock waits until stale.
  if (typeof lock.pidNs === 'string' && lock.pidNs !== pidNamespace()) return false;
  if (lock.pid === process.pid) return !(typeof lock.token === 'string' && heldTokens.has(lock.token));
  try {
    process.kill(lock.pid as number, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Returns true when a fresh lock for `owner` exists in `dir` and its holder is not known to be gone. Read-only. */
export function lockHeld(dir: string, owner: string, staleMs = 10 * 60_000): boolean {
  if (typeof owner !== 'string' || !BASE58.test(owner)) return false;
  const path = join(dir, `lock-${owner}`);
  try {
    const info = lstatSync(path);
    if (!info.isFile()) return true;
    if (Date.now() - info.mtimeMs >= staleMs) return false;
    const lock = JSON.parse(readFileSync(path, 'utf8')) as LockFile | null;
    return !holderIsGone(lock && typeof lock === 'object' ? lock : null);
  } catch (e) {
    // An unreadable lock counts as held.
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Acquires the per-wallet lock in `dir` and returns its release function. `owner` must be a wallet
 * address; `staleMs` must exceed the longest swap. Throws `LockBusyError` when another run holds it.
 */
export function acquireLock(dir: string, owner: string, staleMs = 10 * 60_000): () => void {
  if (typeof owner !== 'string' || !BASE58.test(owner)) {
    throw new Error(`A lock is taken for a wallet address, not ${JSON.stringify(String(owner).slice(0, 60))}. Nothing was started.`);
  }
  const unwritable = (e: unknown) =>
    new ConfigError(`The state directory ${dir} cannot be written (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); nothing was started. Fix it first.`);
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch (e) {
    throw unwritable(e);
  }
  const path = join(dir, `lock-${owner}`);
  const token = randomUUID();
  const busy = () => new LockBusyError(owner, path);
  const lockAt = (file: string): LockFile | null => {
    try {
      // Links and directories are never followed, moved or removed.
      if (!lstatSync(file).isFile()) return null;
      const json = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return json && typeof json === 'object' ? json as { token?: unknown } : null;
    } catch {
      return null;
    }
  };
  const tokenAt = (file: string): string | null => {
    const t = lockAt(file)?.token;
    return typeof t === 'string' ? t : null;
  };
  const take = () => {
    const fd = openSync(path, 'wx', FILE_MODE);
    try {
      const boot = bootId();
      const ns = pidNamespace();
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), token, ...(boot ? { bootId: boot } : {}), ...(ns ? { pidNs: ns } : {}) }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  try {
    take();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw unwritable(e);
    let judged: string | null;
    try {
      if (!lstatSync(path).isFile()) throw busy();
      // Read age and token from one fd so a lock replaced in between is not judged by the old one's age.
      const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      let info: ReturnType<typeof fstatSync>;
      let lock: LockFile | null = null;
      try {
        info = fstatSync(fd);
        if (!info.isFile()) throw busy();
        try {
          const json = JSON.parse(readFileSync(fd, 'utf8')) as unknown;
          lock = json && typeof json === 'object' ? json as { token?: unknown } : null;
        } catch {
          lock = null;
        }
      } finally {
        closeSync(fd);
      }
      if (Date.now() - info.mtimeMs < staleMs && !holderIsGone(lock)) throw busy();
      judged = typeof lock?.token === 'string' ? lock.token : null;
    } catch (e) {
      if (e instanceof LockBusyError) throw e;
      throw busy(); // gone or unreadable in between: another worker is at it
    }
    const aside = `${path}.stale-${token}`;
    try {
      renameSync(path, aside); // atomic: one worker moves it, every other one finds it gone
    } catch {
      throw busy();
    }
    if (tokenAt(aside) !== judged) {
      // Another worker replaced the stale lock after it was judged; put it back.
      try {
        renameSync(aside, path);
      } catch {
        // The next stale check clears it.
      }
      throw busy();
    }
    rmSync(aside, { force: true });
    try {
      take();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw unwritable(e);
      throw busy();
    }
  }
  // Heartbeat keeps the lock fresh during long swaps.
  const beat = setInterval(() => {
    try {
      if (tokenAt(path) === token) {
        const now = new Date();
        utimesSync(path, now, now);
      }
    } catch {
      // Retried on the next beat.
    }
  }, Math.max(1_000, Math.floor(staleMs / 3)));
  beat.unref?.();
  const release = () => {
    clearInterval(beat);
    heldLocks.delete(release);
    if (tokenAt(path) === token) rmSync(path, { force: true });
    heldTokens.delete(token);
  };
  heldTokens.add(token);
  heldLocks.add(release);
  return release;
}
