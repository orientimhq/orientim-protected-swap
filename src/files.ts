// The state directory's files: the owner's alone, each written whole. Not part of the package's API.
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from './api.ts';

/**
 * Flushes a directory's entries to disk, so that a file just created or renamed into it survives a
 * power cut, not only a crash of the process. Where a platform cannot open a directory, a no-op.
 */
export function syncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Not supported for directories here: the file itself was flushed.
  } finally {
    closeSync(fd);
  }
}

/** The state directory and its files are the owner's alone: they name the wallet, its orders and its swaps. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * A temporary file of its own for each write, created only if no file of that name exists ('wx'), so
 * that a link planted in the directory is never followed and two writers never share one.
 */
export const temporaryFor = (path: string) => `${path}.${randomUUID()}.tmp`;

/**
 * The state directory, held to its owner: made the owner's alone when this process owns it, and
 * refused when another user owns it and others may change it, since the daily limit counts what it records.
 * Temporary files a crash left behind are removed.
 */
export function ownStateDir(dir: string): void {
  if (process.platform !== 'win32' && typeof process.geteuid === 'function') {
    const st = statSync(dir);
    if (st.uid === process.geteuid()) {
      if (st.mode & 0o077) chmodSync(dir, DIR_MODE);
    } else {
      // Its owner could plant an approval or erase the record of swaps, whatever its mode says.
      throw new ConfigError(`The state directory ${dir} belongs to another user: the record of swaps and the user's approvals would not be this user's alone. Use a directory of your own. Nothing was started.`);
    }
  }
  const stale = Date.now() - 60 * 60_000;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.tmp'))) {
    try {
      if (lstatSync(join(dir, f)).mtimeMs < stale) rmSync(join(dir, f), { force: true });
    } catch {
      // Removed meanwhile.
    }
  }
}
