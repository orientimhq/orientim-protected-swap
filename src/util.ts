// Small helpers the client's modules share. Not part of the package's API.

export const DIGITS = /^\d{1,20}$/;
/** An address, as Solana writes one. */
export const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
export const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
export const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** `work`, or a refusal once `signal` aborts: for a call that takes no signal of its own. */
export function withinTime<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export const DAY_MS = 24 * 60 * 60_000;
