// Internal helpers shared across modules. Not part of the public API.

export const DIGITS = /^\d{1,20}$/;
/** A base58-encoded Solana address. */
export const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
export const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
export const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Resolves with `work`, or rejects when `signal` aborts. For calls that do not accept a signal. */
export function withinTime<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export const DAY_MS = 24 * 60 * 60_000;
