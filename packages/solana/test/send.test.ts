/**
 * After a transaction may have been broadcast, "nothing moved" is only said
 * when the network proves it. Every other case is `unknown`, with the signature kept.
 */
import { describe, expect, it } from 'vitest';
import {
  appendTransactionMessageInstruction, createTransactionMessage, generateKeyPairSigner, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  getSolanaErrorFromJsonRpcError, SolanaError, SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from '@solana/kit';
import type { Address, Blockhash } from '@solana/kit';
import { httpStatusOf, preflightError, readAccounts, retryingTransport, sendAndConfirm, sendOnce } from '../src/index.ts';
import type { SendStatus, SolanaRpc } from '../src/index.ts';

const LAST_VALID = 100n;
const timing = { pollMs: 1, rebroadcastMs: 1, giveUpMs: 150, settleTries: 3, settleMs: 1 };

async function signedTransaction() {
  const payer = await generateKeyPairSigner();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: LAST_VALID }, m),
    m => appendTransactionMessageInstruction({ programAddress: '11111111111111111111111111111111' as Address, data: new Uint8Array([2, 0, 0, 0]) }, m),
  );
  return signTransactionMessageWithSigners(message);
}

type Status = { confirmationStatus: 'processed' | 'confirmed' | 'finalized'; err: unknown } | null;
/** Each read takes the next scripted value; the last one repeats. 'throw' simulates a failed read. */
function fakeRpc(script: {
  firstSend?: 'ok' | Error; statuses?: (Status | 'throw')[]; heights?: bigint[]; finalizedHeights?: bigint[];
  /** The slot the node answering each status read had reached; the finalized slot is 500,000 (a processed node is some 40 ahead). */
  statusSlots?: bigint[];
}) {
  let sends = 0;
  let statusReads = 0;
  let heightReads = 0;
  let finalizedReads = 0;
  const next = <T>(list: T[], i: number) => list[Math.min(i, list.length - 1)];
  const rpc = {
    sendTransaction: () => ({
      send: async () => {
        if (sends++ === 0 && script.firstSend instanceof Error) throw script.firstSend;
        return 'sig';
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => {
        const slot = next(script.statusSlots ?? [500_040n], statusReads);
        const s = next(script.statuses ?? [null], statusReads++);
        if (s === 'throw') throw new Error('status read failed');
        return { context: { slot }, value: [s] };
      },
    }),
    getBlockHeight: (config?: { commitment?: string }) => ({
      send: async () => (config?.commitment === 'finalized' && script.finalizedHeights
        ? next(script.finalizedHeights, finalizedReads++)
        : next(script.heights ?? [1n], heightReads++)),
    }),
    // The finalized slot and height, in one answer, as a node reports them.
    getEpochInfo: () => ({
      send: async () => ({
        absoluteSlot: 500_000n,
        blockHeight: script.finalizedHeights ? next(script.finalizedHeights, finalizedReads++) : next(script.heights ?? [1n], heightReads++),
      }),
    }),
  } as unknown as SolanaRpc;
  return { rpc, reads: () => statusReads };
}

async function run(script: Parameters<typeof fakeRpc>[0]) {
  const { rpc, reads } = fakeRpc(script);
  const events: SendStatus[] = [];
  const result = await sendAndConfirm({
    rpc, transaction: await signedTransaction(), lastValidBlockHeight: LAST_VALID, timing, onStatus: s => events.push(s),
  });
  return { result, events, reads: reads() };
}

const confirmed: Status = { confirmationStatus: 'confirmed', err: null };
const processed: Status = { confirmationStatus: 'processed', err: null };
const httpError = (statusCode: number, stoppedByOrientim = false) => {
  const headers = new Headers();
  if (stoppedByOrientim) headers.set('x-orientim-not-forwarded', '1');
  return new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers, message: 'error', statusCode } as never);
};

describe('the outcome of a send', () => {
  it('reports the signature before the first request', async () => {
    const { result, events } = await run({ statuses: [confirmed] });
    expect(events[0]).toBe('sending');
    expect(result.signature.length).toBeGreaterThan(80);
  });

  it('a lost connection on the first send keeps watching: it may have landed', async () => {
    const { result } = await run({ firstSend: new Error('fetch failed'), statuses: [null, confirmed] });
    expect(result.status).toBe('confirmed');
  });

  it('a gateway error (5xx) is ambiguous, not a refusal', async () => {
    const { result } = await run({ firstSend: httpError(502), statuses: [confirmed] });
    expect(result.status).toBe('confirmed');
  });

  it('an upstream 4xx is ambiguous without Orientim\'s local-refusal marker', async () => {
    const { result } = await run({ firstSend: httpError(429), statuses: [confirmed] });
    expect(result.status).toBe('confirmed');
  });

  it('an internal JSON-RPC error keeps watching because the node may have accepted the send', async () => {
    const internal = new SolanaError(SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, { __serverMessage: 'internal' });
    const { result } = await run({ firstSend: internal, statuses: [null, confirmed] });
    expect(result.status).toBe('confirmed');
  });

  it('a preflight refusal means it was never broadcast', async () => {
    const preflight = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {} as never);
    const { result, reads } = await run({ firstSend: preflight });
    expect(result.status).toBe('rejected');
    expect(reads).toBe(0);
  });

  it("a refusal from Orientim's proxy (4xx) means it was never broadcast", async () => {
    expect((await run({ firstSend: httpError(429, true) })).result.status).toBe('rejected');
  });

  it('status reads that keep failing end as unknown, never as "nothing moved"', async () => {
    expect((await run({ statuses: ['throw'] })).result.status).toBe('unknown');
  });

  it('processed at expiry is not an outcome: it waits for confirmation', async () => {
    const { result } = await run({ statuses: [processed, processed, confirmed], heights: [LAST_VALID + 1n] });
    expect(result.status).toBe('confirmed');
  });

  it('processed but never confirmed after expiry ends as unknown', async () => {
    expect((await run({ statuses: [processed], heights: [LAST_VALID + 1n] })).result.status).toBe('unknown');
  });

  it('expired only when the cluster has no record of it after the blockhash expired', async () => {
    expect((await run({ statuses: [null], heights: [LAST_VALID + 1n] })).result.status).toBe('expired');
  });

  it('an on-chain error is a failure that reverted', async () => {
    const failed: Status = { confirmationStatus: 'confirmed', err: { InstructionError: [7, { Custom: 1 }] } };
    const { result } = await run({ statuses: [failed] });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('InstructionError');
  });
});

describe('who refused a send that was never broadcast', () => {
  it("Orientim's kill switch (403 from the relay) is told as a pause, not as a price move", async () => {
    const { result } = await run({ firstSend: httpError(403, true) });
    expect(result.status).toBe('rejected');
    expect(result.refusal).toBe('paused');
  });

  it("the relay's send limit (429) is told as too many requests", async () => {
    expect((await run({ firstSend: httpError(429, true) })).result.refusal).toBe('busy');
  });

  it("the RPC's preflight is the network's refusal", async () => {
    const preflight = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {} as never);
    expect((await run({ firstSend: preflight })).result.refusal).toBe('network');
  });

  it("keeps why the preflight refused, as a confirmed transaction's error reads", async () => {
    // As the RPC answers: the simulation's err in the error's data, which kit turns into its cause.
    const slippage = getSolanaErrorFromJsonRpcError({
      code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
      message: 'Transaction simulation failed',
      data: { err: { InstructionError: [3, { Custom: 6001 }] }, logs: [] },
    });
    const { result } = await run({ firstSend: slippage });
    expect(result.status).toBe('rejected');
    expect(JSON.parse(result.transactionError!)).toEqual({ InstructionError: [3, { Custom: 6001 }] });
    expect(preflightError(slippage)).toEqual({ InstructionError: [3, { Custom: 6001 }] });
  });

  it('says nothing about why when the preflight gave no program error', async () => {
    const bare = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {} as never);
    expect((await run({ firstSend: bare })).result.transactionError).toBeUndefined();
    expect(preflightError(new Error('Transaction simulation failed'))).toBeNull();
  });
});

describe('a rate-limited RPC in the production build', () => {
  /** Errors made as the page users load makes them: kit replaces the words with a code. */
  const productionError = (statusCode: number) => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      return httpError(statusCode);
    } finally {
      process.env.NODE_ENV = env;
    }
  };

  it('has no "429" in its message, so the status must come from the context', () => {
    const e = productionError(429);
    expect(e.message).not.toMatch(/429|Too Many Requests/i);
    expect(httpStatusOf(e)).toBe(429);
  });

  it('is retried, and the answer that follows is returned', async () => {
    let calls = 0;
    const transport = (async () => {
      if (calls++ < 2) throw productionError(429);
      return { ok: true };
    }) as unknown as Parameters<typeof retryingTransport>[0];
    expect(await retryingTransport(transport, 5, 1)({} as never)).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('a send is never retried by the transport: a 429 may follow a forwarded request', async () => {
    let calls = 0;
    const transport = (async () => {
      calls++;
      throw productionError(429);
    }) as unknown as Parameters<typeof retryingTransport>[0];
    await expect(retryingTransport(transport, 5, 1)({ payload: { method: 'sendTransaction' } } as never)).rejects.toThrow();
    expect(calls).toBe(1);
    calls = 0;
    await expect(retryingTransport(transport, 2, 1)({ payload: { method: 'getBalance' } } as never)).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it('any other failure is not retried', async () => {
    let calls = 0;
    const transport = (async () => {
      calls++;
      throw productionError(502);
    }) as unknown as Parameters<typeof retryingTransport>[0];
    await expect(retryingTransport(transport, 5, 1)({} as never)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('one send, for a caller that confirms on its own (the agent API)', () => {
  const once = async (script: Parameters<typeof fakeRpc>[0]) => sendOnce(fakeRpc(script).rpc, await signedTransaction());
  const preflight = () => new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {} as never);

  it('accepted by the RPC is sent', async () => {
    expect((await once({})).status).toBe('sent');
  });

  it('a preflight refusal is rejected: never broadcast', async () => {
    const r = await once({ firstSend: preflight(), statuses: [null] });
    expect(r.status).toBe('rejected');
    expect(r.refusal).toBe('network');
  });

  it('keeps why the preflight refused, for the caller to pass on', async () => {
    const slippage = getSolanaErrorFromJsonRpcError({
      code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
      message: 'Transaction simulation failed',
      data: { err: { InstructionError: [3, { Custom: 6001 }] }, logs: [] },
    });
    const r = await once({ firstSend: slippage, statuses: [null] });
    expect(r.status).toBe('rejected');
    expect(JSON.parse(r.transactionError!)).toEqual({ InstructionError: [3, { Custom: 6001 }] });
    expect((await once({ firstSend: preflight(), statuses: [null] })).transactionError).toBeUndefined();
  });

  it('a preflight refusal of a signature the cluster already has is a second send, not a rejection', async () => {
    expect((await once({ firstSend: preflight(), statuses: [confirmed] })).status).toBe('sent');
  });

  it('"already processed" is a second send of a transaction that landed: sent, however far the status read lags', async () => {
    // As the RPC answers it, through Kit: the simulation's error becomes the cause.
    const already = getSolanaErrorFromJsonRpcError({
      code: -32002, message: 'Transaction simulation failed: This transaction has already been processed',
      data: { err: 'AlreadyProcessed', logs: [], accounts: null, unitsConsumed: 0, returnData: null },
    });
    const r = await once({ firstSend: already as Error, statuses: [null] });
    expect(r.status).toBe('sent');
    expect(r.refusal).toBeUndefined();
    const kept = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, { err: 'AlreadyProcessed', logs: [] } as never);
    expect((await once({ firstSend: kept, statuses: [null] })).status).toBe('sent');
  });

  it('a preflight refusal whose status cannot be read is unknown, not rejected', async () => {
    const r = await once({ firstSend: preflight(), statuses: ['throw'] });
    expect(r.status).toBe('unknown');
    expect(r.refusal).toBeUndefined();
  });

  it('a lost connection is unknown: it may have been forwarded', async () => {
    expect((await once({ firstSend: new Error('fetch failed') })).status).toBe('unknown');
  });
});

describe('outcomes are said only once the chain proves them', () => {
  it('an error seen only at processed (a fork, perhaps) is not a failure: the swap lands confirmed later', async () => {
    const processedError: Status = { confirmationStatus: 'processed', err: { InstructionError: [3, { Custom: 1 }] } };
    expect((await run({ statuses: [processedError, confirmed] })).result.status).toBe('confirmed');
  });

  it('a status node behind the finalized slot cannot make a swap expired, whatever the height', async () => {
    // Another node reports a finalized height well past the lifetime; the node that says "no record"
    // had not reached that slot, so its silence proves nothing.
    const { result } = await run({ statuses: [null], heights: [LAST_VALID + 1n], finalizedHeights: [LAST_VALID + 50n], statusSlots: [1n] });
    expect(result.status).toBe('unknown');
    const covered = await run({ statuses: [null], heights: [LAST_VALID + 1n], finalizedHeights: [LAST_VALID + 50n] });
    expect(covered.result.status).toBe('expired');
  });

  it('long after the lifetime, "no record" proves nothing: the node may have forgotten it', async () => {
    // The status cache holds the last 300 blocks; this transaction could land from block -49 on.
    const late = await run({ statuses: [null], heights: [LAST_VALID + 1n], finalizedHeights: [LAST_VALID + 500n] });
    expect(late.result.status).toBe('unknown');
    // It stops looking as soon as that is clear, rather than asking until it gives up: one read
    // while it could still land, one of the full history after.
    expect(late.reads).toBe(2);
  });

  it('a status node far ahead of the finalized view proves nothing either: its cache may start past the swap', async () => {
    const { result } = await run({ statuses: [null], heights: [LAST_VALID + 1n], finalizedHeights: [LAST_VALID + 10n], statusSlots: [505_000n] });
    expect(result.status).toBe('unknown');
  });

  it('expiry needs the finalized height past the lifetime too, so a lagging node cannot make it expired', async () => {
    const { result } = await run({ statuses: [null], heights: [LAST_VALID + 1n], finalizedHeights: [LAST_VALID] });
    expect(result.status).toBe('unknown');
  });

  it('a failure confirmed by the chain is a failure', async () => {
    const failed: Status = { confirmationStatus: 'confirmed', err: { InstructionError: [3, { Custom: 1 }] } };
    expect((await run({ statuses: [failed] })).result.status).toBe('failed');
  });
});

describe('reads that must not be older than a slot', () => {
  const lagging = (behind: number) => {
    const asked: unknown[] = [];
    let calls = 0;
    const rpc = {
      getMultipleAccounts: (addresses: string[], config: { minContextSlot?: bigint }) => ({
        send: async () => {
          asked.push(config.minContextSlot);
          if (++calls <= behind) {
            throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED, { __serverMessage: 'Minimum context slot has not been reached', contextSlot: 99 } as never);
          }
          return { context: { slot: 120n }, value: addresses.map(() => null) };
        },
      }),
    } as unknown as Parameters<typeof readAccounts>[0];
    return { rpc, asked, calls: () => calls };
  };

  it('asks for the slot, waits for a node that is behind, and answers at least that recent', async () => {
    const { rpc, asked, calls } = lagging(2);
    const { slot } = await readAccounts(rpc, ['11111111111111111111111111111111' as never], { minContextSlot: 110n });
    expect(slot).toBe(120n);
    expect(calls()).toBe(3);
    expect(asked).toEqual([110n, 110n, 110n]);
  });

  it('a node that stays behind fails the read instead of answering from older state', async () => {
    const { rpc, calls } = lagging(99);
    await expect(readAccounts(rpc, ['11111111111111111111111111111111' as never], { minContextSlot: 110n })).rejects.toThrow();
    // Asked six times over about four and a half seconds: a node of a load-balanced RPC can lag that long.
    expect(calls()).toBe(6);
  }, 20_000);

  it('a node that catches up after four seconds is still waited for', async () => {
    const { rpc, calls } = lagging(5);
    expect((await readAccounts(rpc, ['11111111111111111111111111111111' as never], { minContextSlot: 110n })).slot).toBe(120n);
    expect(calls()).toBe(6);
  }, 20_000);
});

describe('nothing waits without end', () => {
  it('a first send that never answers counts against the deadline, and the outcome is read for its signature', async () => {
    const { rpc } = fakeRpc({ statuses: [confirmed] });
    // The first send hangs until it is aborted; statuses answer as usual.
    const hanging = {
      ...rpc,
      sendTransaction: () => ({
        send: (o?: { abortSignal?: AbortSignal }) => new Promise((_, reject) => o?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')))),
      }),
    } as unknown as SolanaRpc;
    const started = Date.now();
    const result = await sendAndConfirm({ rpc: hanging, transaction: await signedTransaction(), lastValidBlockHeight: LAST_VALID, timing: { ...timing, requestMs: 40 } });
    expect(result.status).toBe('confirmed');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('the transport ends every request in time, whoever calls it', async () => {
    const never: Parameters<typeof retryingTransport>[0] = ((config: unknown) => new Promise((_, reject) => {
      (config as { signal?: AbortSignal }).signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as never;
    const transport = retryingTransport(never, 0, 1, 30);
    const started = Date.now();
    await expect(transport({ payload: { method: 'getBalance' } } as never)).rejects.toThrow('aborted');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
