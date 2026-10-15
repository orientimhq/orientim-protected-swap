/**
 * A wallet's own API key: Orientim's key message, checked before the wallet signs it, and the calls
 * that turn the signature into a key (AGENT-API.md, "API access").
 */
import { answerOf, OrientimApiError, retryAfterOf, SKILL_VERSION } from './api.ts';
import type { Fetch } from './api.ts';

/**
 * Is `message` Orientim's API-key message for `address`, from the host of `apiUrl`, and nothing else?
 * A wallet's signature over bytes a server chose could, for bytes shaped like a transaction, be a
 * signature for that transaction: so only this exact text, for this wallet and this host, is ever
 * signed (AGENT-API.md, "API access").
 */
export function isApiKeyMessage(message: unknown, apiUrl: string, address: string, now = Date.now()): message is string {
  if (typeof message !== 'string' || message.length > 1_000 || !/^[\x20-\x7e\n]+$/.test(message)) return false;
  const host = new URL(apiUrl).host;
  const lines = message.split('\n');
  // Every field, in the order Orientim's server writes them, as the site checks it
  // (apps/web/lib/client/keyMessage.ts): the same rule on both sides.
  const field = (i: number, name: string, value: RegExp) => {
    const m = new RegExp(`^${name}: (.+)$`).exec(lines[i] ?? '');
    return m !== null && value.test(m[1]) ? m[1] : null;
  };
  const isoTime = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/;
  const issued = Date.parse(field(9, 'Issued At', isoTime) ?? '');
  const expires = Date.parse(field(10, 'Expiration Time', isoTime) ?? '');
  return lines.length === 11
    && lines[0] === `${host} wants you to sign in with your Solana account:`
    && lines[1] === address && lines[2] === ''
    && lines[3] === 'Get an Orientim API key for this wallet, and accept the Terms of Use at https://orientim.com/terms. Signing costs nothing and gives no access to your funds.'
    && lines[4] === ''
    && (lines[5] === `URI: https://${host}/developers#access` || (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && lines[5] === `URI: http://${host}/developers#access`))
    && lines[6] === 'Version: 1'
    && lines[7] === 'Chain ID: mainnet'
    && field(8, 'Nonce', /^[A-Za-z0-9_-]{6,64}$/) !== null
    // Issued now, give or take a slow clock, and valid for a quarter of an hour at most.
    && Math.abs(issued - now) <= 15 * 60_000
    && expires > issued && expires - issued <= 15 * 60_000;
}

/** The message to sign for an API key, checked first (`isApiKeyMessage`). */
export async function apiKeyChallenge(args: { apiUrl: string; address: string; fetchImpl?: Fetch; requestTimeoutMs?: number }): Promise<{ message: string; challenge: string }> {
  const base = args.apiUrl.replace(/\/+$/, '');
  const res = await (args.fetchImpl ?? fetch)(`${base}/api/v1/keys/challenge?wallet=${encodeURIComponent(args.address)}`, {
    headers: { 'x-orientim-skill': SKILL_VERSION }, signal: AbortSignal.timeout(args.requestTimeoutMs ?? 30_000),
  });
  const json = await answerOf<{ message?: unknown; challenge?: unknown }>(res);
  if (!res.ok) {
    throw new OrientimApiError({ status: res.status, code: json.error?.code ?? 'http', message: json.error?.message ?? res.statusText, body: json.error ?? {}, retryAfter: retryAfterOf(res) });
  }
  if (!isApiKeyMessage(json.message, base, args.address) || typeof json.challenge !== 'string') {
    throw new Error('Orientim answered with a message that is not its API-key message for this wallet. Nothing was signed.');
  }
  return { message: json.message, challenge: json.challenge };
}

/** Sends the signed challenge; the key comes back, bound to the wallet that signed it. */
export async function redeemApiKey(args: {
  apiUrl: string; message: string; challenge: string; signature: Uint8Array | string; fetchImpl?: Fetch; requestTimeoutMs?: number;
}): Promise<{ key: string; wallet: string; expiresAt: string }> {
  const signature = typeof args.signature === 'string' ? args.signature : Buffer.from(args.signature).toString('base64');
  const res = await (args.fetchImpl ?? fetch)(`${args.apiUrl.replace(/\/+$/, '')}/api/v1/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orientim-skill': SKILL_VERSION },
    body: JSON.stringify({ message: args.message, challenge: args.challenge, signature }),
    signal: AbortSignal.timeout(args.requestTimeoutMs ?? 30_000),
  });
  const json = await answerOf<{ key?: string; wallet?: string; expiresAt?: string }>(res);
  if (!res.ok || typeof json.key !== 'string') {
    throw new OrientimApiError({ status: res.status, code: json.error?.code ?? 'http', message: json.error?.message ?? res.statusText, body: json.error ?? {}, retryAfter: retryAfterOf(res) });
  }
  return { key: json.key, wallet: json.wallet ?? '', expiresAt: json.expiresAt ?? '' };
}

/**
 * An API key for this wallet, at once (AGENT-API.md, "API access"): the wallet signs Orientim's
 * message, checked first, and nothing else. The key prepares swaps for this wallet only.
 */
export async function requestApiKey(args: {
  apiUrl: string; address: string; signMessage: (message: Uint8Array) => Promise<Uint8Array>; fetchImpl?: Fetch; requestTimeoutMs?: number;
}): Promise<{ key: string; wallet: string; expiresAt: string }> {
  const { message, challenge } = await apiKeyChallenge(args);
  const signature = await args.signMessage(new TextEncoder().encode(message));
  return redeemApiKey({ ...args, message, challenge, signature });
}
