/**
 * One run per wallet at a time: a lock file in the state directory, taken over only when its holder
 * is provably gone (its process ended on this host) or the lock is stale.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, utimesSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from './api.ts';
import { DIR_MODE, FILE_MODE } from './files.ts';
import { BASE58 } from './util.ts';

/** Another run from the wallet holds its lock: it may be sending a swap now. */
export class LockBusyError extends Error {
  readonly path: string;
  constructor(owner: string, path: string) {
    super(`Another swap from ${owner} is running (lock ${path}); nothing was started.`);
    this.path = path;
  }
}

/** The locks this process holds, released when it is told to stop (`releaseHeldLocks`). */
const heldLocks = new Set<() => void>();

/**
 * Releases every lock this process holds. For a process told to stop (SIGTERM, SIGINT): what it
 * kept before finalize is on disk, and the next run settles it, instead of waiting for the lock to
 * go stale.
 */
export function releaseHeldLocks(): void {
  for (const release of [...heldLocks]) release();
}

/** Is the process that wrote a lock on this machine gone? Only a process on this host can be asked. */
function holderIsGone(lock: { pid?: unknown; host?: unknown } | null): boolean {
  if (!lock || lock.host !== hostname() || !Number.isInteger(lock.pid) || (lock.pid as number) <= 0) return false;
  try {
    process.kill(lock.pid as number, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Is a run from `owner` at work in `dir` now: its lock is there, fresh, and its process is not known
 * to be gone. Only reads; a quote asks it, so as not to be taken for a retry of a swap being sent.
 */
export function lockHeld(dir: string, owner: string, staleMs = 10 * 60_000): boolean {
  if (typeof owner !== 'string' || !BASE58.test(owner)) return false;
  const path = join(dir, `lock-${owner}`);
  try {
    const info = lstatSync(path);
    if (!info.isFile()) return true;
    if (Date.now() - info.mtimeMs >= staleMs) return false;
    const lock = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; host?: unknown } | null;
    return !holderIsGone(lock && typeof lock === 'object' ? lock : null);
  } catch (e) {
    // No lock, or one that went between the two reads; one that cannot be read (yet) is held.
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * One worker per wallet at a time, across processes sharing `dir`: the lock file is created only if
 * it does not exist, and names its holder (a token of its own, its process and host). A lock whose
 * process is gone from this host, or one older than `staleMs`, is left by a process that died: it is
 * moved aside, which only one process can do, and only if it is still the lock that was judged, then
 * taken. The release deletes the lock only while it still carries this holder's token, so a worker
 * whose lock was taken over never removes its successor's. Keep `staleMs` above the longest swap
 * (`maxWaitMs` and its requests). Workers on other machines need a shared store with a lock of its own.
 *
 * `owner` must be a wallet address: it names the lock file, so nothing else may reach the path.
 * Throws `LockBusyError` when another run holds the lock, and a plain error when the directory
 * cannot be written.
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
  const lockAt = (file: string): { token?: unknown; pid?: unknown; host?: unknown } | null => {
    try {
      // Only a regular file is a lock; a link or a directory is never followed, moved or removed.
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
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), token }));
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
      // Something other than a lock file under a lock's name is never taken over.
      if (!lstatSync(path).isFile()) throw busy();
      // Its age and its token are read from one open file: a fresh lock another worker put in its
      // place between two reads by name would otherwise be judged by the old one's age, and taken.
      const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      let info: ReturnType<typeof fstatSync>;
      let lock: { token?: unknown; pid?: unknown; host?: unknown } | null = null;
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
      // What was moved is a fresh lock another worker took after this one judged the old one stale.
      try {
        renameSync(aside, path);
      } catch {
        // its holder releases nothing that is not its own; the next stale check clears it
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
  // Held, the lock is kept fresh: a swap that waits long (a signer asking a person, a slow RPC)
  // outlives `staleMs` without another worker judging its lock left behind.
  const beat = setInterval(() => {
    try {
      if (tokenAt(path) === token) {
        const now = new Date();
        utimesSync(path, now, now);
      }
    } catch {
      // Unwritable for a moment: the next beat tries again.
    }
  }, Math.max(1_000, Math.floor(staleMs / 3)));
  beat.unref?.();
  const release = () => {
    clearInterval(beat);
    heldLocks.delete(release);
    if (tokenAt(path) === token) rmSync(path, { force: true });
  };
  heldLocks.add(release);
  return release;
}
