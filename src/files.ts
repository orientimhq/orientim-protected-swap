// State directory file helpers. Not part of the public API.
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from './api.ts';

/** Fsyncs a directory so a newly created or renamed entry survives power loss. No-op where unsupported. */
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
  } finally {
    closeSync(fd);
  }
}

/** Owner-only modes: the state directory reveals the wallet, its orders and its swaps. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Unique temp path per write; opened with 'wx' so a planted symlink is never followed. */
export const temporaryFor = (path: string) => `${path}.${randomUUID()}.tmp`;

/**
 * Restricts the state directory to its owner and removes stale temp files.
 * Throws if another user owns it, since the daily limit relies on its records.
 */
export function ownStateDir(dir: string): void {
  if (process.platform !== 'win32' && typeof process.geteuid === 'function') {
    const st = statSync(dir);
    if (st.uid === process.geteuid()) {
      if (st.mode & 0o077) chmodSync(dir, DIR_MODE);
    } else {
      // Another owner could plant approvals or erase swap records regardless of mode.
      throw new ConfigError(`The state directory ${dir} belongs to another user: the record of swaps and the user's approvals would not be this user's alone. Use a directory of your own. Nothing was started.`);
    }
  }
  const stale = Date.now() - 60 * 60_000;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.tmp'))) {
    try {
      if (lstatSync(join(dir, f)).mtimeMs < stale) rmSync(join(dir, f), { force: true });
    } catch {
    }
  }
}
