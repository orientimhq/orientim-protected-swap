# Orientim agent API

Protected swaps on Solana for bots and AI agents. The swap program (Jupiter's route) only ever holds a
one-time key and the approved amount; if less than your minimum would arrive, the whole transaction
reverts. Orientim never holds your key or your funds.

```
POST /api/v1/prepare    → an unsigned transaction and a ticket
   (your wallet signs it first)
POST /api/v1/finalize   → Orientim signs last with the one-time key and sends it once
```

**Verify before you sign.** Orientim's server builds the transaction. Run the verifier on it with chain
state from your own RPC (`checkPrepared` in `@orientimhq/swap`, or `orientim check`). With it, a
compromised server can refuse or delay a swap, never make you sign one that moves more than the
approved amount or pays below your own floor. **Without it, you trust the server with the whole
wallet.** An API key or the optional `x-orientim-skill: <version>` header does not prove the check ran.

The wallet must sign first and hand back a partially signed transaction: a local keypair, a KMS or a
signing service (`signerFromSignBytes`, `signerFromSignTransaction`). Sign-and-send-only wallets and
multisig vaults cannot be used.

## Authentication

```
Authorization: Bearer ori_...
```

Limits: 20 prepares and 15 finalizes a minute per key (per wallet for a self-serve key), and 120
prepares a minute per client address. A `429` carries `Retry-After`. At capacity a prepare is answered
`503 busy` with `Retry-After`, and nothing is built.

### API key

The wallet signs Orientim's Sign In With Solana message and gets a key bound to it at once. Signing
moves nothing.

```http
GET /api/v1/keys/challenge?wallet=<address>
→ { "message": "orientim.com wants you to sign in with your Solana account:\n<address>\n...", "challenge": "...", "expiresAt": "..." }

POST /api/v1/keys
{ "message": "<unchanged>", "challenge": "...", "signature": "<ed25519 signature of message, base58 or base64>" }
→ { "key": "ori_w1....", "wallet": "<address>", "expiresAt": "..." }
```

- The key prepares swaps for its own wallet only (`403 wrong-wallet` otherwise) and lasts 90 days.
- The wallet must hold 0.01 SOL. The challenge must be signed within 10 minutes.
- Per IP: 30 challenges and 10 keys an hour; per wallet: 5 keys a day. Keep the key you have.
- **Sign only Orientim's key message for your own wallet**: a signature over bytes someone else chose
  could be a signature for a transaction. `requestApiKey` and `orientim key-challenge` check the message
  first. The message always names orientim.com; one naming another site is refused.

## Fee

0.25%, inside the transaction. It is taken in SOL, USDC or USDT when either side of the swap is one of
them (in that order), otherwise in the input token; `amounts.feeMint` says which.

- On the input: 0.25% of `amountIn`, which includes it.
- On the output: 0.25% of the enforced minimum, paid after the minimum is checked. `amounts.minOut` is
  what your wallet keeps.
- Neither token can carry it: 0.25% of the swap's value in SOL, from the wallet (`policy.feeSide` is
  `sol`). Hold it to a limit of your own with `maxSolFeeLamports` (`ownSolFeeLimit`).

The fee is part of the message you sign; a transaction with it removed is not signed. The API refuses
a fee above 0.3%; the package refuses one above 0.25% unless `maxFeeBps` allows up to 0.3%. When the
fee cannot be collected, the answer is `503 fee-unavailable` and nothing is built.

## 1. Prepare

```http
POST /api/v1/prepare
Authorization: Bearer ori_...

{ "owner": "<wallet>", "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "outputMint": "So11111111111111111111111111111111111111112", "amountIn": "5000000", "minOut": "42400000" }
```

| Field | | |
| --- | --- | --- |
| `owner` | required | The wallet that pays, signs first and receives. |
| `inputMint`, `outputMint` | required | Mint addresses. |
| `amountIn` | required | Base units, as a string. Includes the fee when it is taken in the input token. |
| `minOut` | required | What your wallet must keep, in base units of the output. Get it from your own price (`ownMinimum`). |
| `slippageBps` | optional | The route's tolerance, 10 to 1500. Default 50, or 300 on a Pump.fun bonding curve. |
| `acceptCostBps` | optional | Accept a route this many bps below the open market, after `costs-more`. A route up to 50 bps past it is also taken; `minOut` still holds. |
| `ownRoutes` | optional | Fetch the routes with your own Jupiter key (below). |

A prepare answers within 45 seconds, or `503 unavailable`. `200` response:

```json
{
  "ticket": "eyJ2Ijox....",
  "transaction": "<base64, unsigned>",
  "messageSha256": "<hex>",
  "wallet": "<owner>",
  "temporaryAuthority": "<the one-time key>",
  "lastValidBlockHeight": "312345678",
  "blocksLeft": "148",
  "contextSlot": "334567890",
  "amounts": { "amountIn": "5000000", "fee": "106363", "feeMint": "So11111111111111111111111111111111111111112",
               "feeBps": "25", "swapAmount": "5000000", "quotedOut": "42780667", "minOut": "42439063",
               "priceImpactPct": 0.0001 },
  "costs": { "networkFeeLamports": "124480", "outputAccountRentLamports": "0", "routeRentLamports": "0", "routeRefundLamports": "0",
             "routeKeptLamports": "0", "orientimFeeSolLamports": "106363", "keptSolLamports": "230843", "tokenTax": null,
             "breakdown": { "principal": { "mint": "<inputMint>", "amount": "5000000" },
                            "orientimFee": { "mint": "So11111111111111111111111111111111111111112", "amount": "106363" },
                            "networkFeeLamports": "124480", "rentReturnedLamports": "0", "rentKeptLamports": "0" } },
  "notices": { "removesDelegate": false, "networkBusy": false },
  "tokens": { "input": { "freezeAuthority": true, "mintAuthority": true, "permanentDelegate": false },
              "output": { "freezeAuthority": false, "mintAuthority": false, "permanentDelegate": false } },
  "route": ["Kipseli", "AlphaQ"],
  "certificate": { "...": "what this exact transaction does, bound to messageSha256" },
  "policy": { "...": "the rules the transaction was verified against" }
}
```

- All amounts are strings in base units. The transaction lives 150 blocks (about 30 seconds); with
  fewer than 30 left, prepare again. `contextSlot` is the slot it was built at; the check waits for your
  RPC to reach it.
- `costs.keptSolLamports` is all the SOL the swap costs and does not return: network fee, rent the
  route keeps, and the fee when it is in SOL. `costs.breakdown` gives each part. A Pump.fun curve keeps
  about 0.00013 SOL of every buy.
- `amounts.priceImpactPct` is `null` when Jupiter did not state it: unknown, never none.
- `tokens` says what each issuer can do: freeze, mint, or move and burn from any wallet
  (`permanentDelegate`). `notices.networkBusy` means the network fee is at its cap.
- `certificate`, `amounts` and `costs` are Orientim's statements. The check computes them from the
  bytes and refuses a figure that differs (`certificate-mismatch`).

**Before signing**, `verifyPrepared(prepared, limits, rpc)` checks the bytes against rules R1–R7 and
simulates the transaction on your RPC: nothing may stay under the one-time key, and no account the
route opens may stay open. Route rent is held to `maxRouteCostLamports` (0.001 SOL) and the network fee
to `maxNetworkFeeLamports`. `prepareChecked` and `protectedSwap` add your floor's 20% limit, the price
impact and the fee in SOL.

### Your own Jupiter key (`ownRoutes`)

With `ownRoutes: true` you fetch the routes with your own key, which never reaches Orientim. Your routes
are held to the same checks as any route.

1. `POST /api/v1/prepare` with your body and `"ownRoutes": true`. The answer is `409 routes-needed` with
   `session` (for this swap and key, two minutes), `taker` (the one-time key, the same in every round)
   and `requests`. This round builds nothing and may omit `minOut`.
2. Fetch each request from `https://api.jup.ag/swap/v2/build` with your key, its fields as query
   parameters and `wrapAndUnwrapSol=false` (`excludeDexes` joined with commas). Fetch only requests for
   your mints, its `taker` and an amount no larger than yours.
3. Prepare again with the same body, `session` and `routes`: each
   `{ "params": <request, unchanged>, "response": <Jupiter's answer> }`, or `"noRoute": true` for a 400.
   At most 24 routes; body up to 1 MiB.
4. Repeat until the answer is the prepared swap, usually one or two rounds.

A session holds every round to the same terms (`routingMode`, `slippageBps`, `acceptCostBps`, `minOut`);
other terms, or an expired session, get `bad-session`: prepare again without it. With a fee on the
output, a route whose minimum is more than 1% below Orientim's own price is not used. A client of its
own should hold the `taker` fixed across rounds, fetch each request once, and honour Jupiter's
`Retry-After` on a 429. `@orientimhq/swap` does all of this when `JUPITER_API_KEY` is set
(`ORIENTIM_OWN_ROUTES=0` turns it off).

## 2. Sign as your wallet

Sign the message with the owner's key and leave the other signature empty:

```ts
import { getTransactionDecoder, getTransactionEncoder, partiallySignTransaction } from '@solana/kit';

const tx = getTransactionDecoder().decode(Buffer.from(prepared.transaction, 'base64'));
const signed = await partiallySignTransaction([wallet.keyPair], tx);
const signedTransaction = Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
```

Change nothing: finalize refuses any change. The wallet's signature is the transaction's id
(`getSignatureFromTransaction`): keep it, with the ticket, before calling finalize.

## 3. Finalize

```http
POST /api/v1/finalize
Authorization: Bearer ori_...

{ "ticket": "eyJ2Ijox....", "signedTransaction": "<base64, signed by your wallet>" }
```

Orientim checks that the message is the one it built, that your signature is valid, that the
transaction has not expired and that your output balance is the one at prepare; then it signs as the
one-time key and sends it once. A repeated finalize of the same ticket answers for the same
transaction and sends nothing new. Run one swap per output token at a time.

`"send": false` returns the fully signed transaction unsent (`status` `signed`): send those bytes
yourself, again every few seconds until they confirm or expire.

```json
{ "signature": "5h...", "status": "sent", "signedTransaction": "<base64, fully signed>", "lastValidBlockHeight": "312345678" }
```

| `status` | Meaning |
| --- | --- |
| `sent` | Accepted for broadcast, or already on chain. Confirm on chain; re-broadcast `signedTransaction` until it confirms or expires. |
| `unknown` | The answer was lost after the request left. Check the signature before anything else. |
| `signed` | `"send": false`: signed and not sent. Send it yourself. |
| `rejected` | This request never broadcast it (`refusal` `network`: the RPC's preflight, usually a price that moved; `transactionError` when there is one). |

Only the chain says whether the swap happened. **Before preparing again for the same swap**, make sure
the signed transaction can no longer land: no record of its signature, and the finalized block height
past its last block, read as one view (`getEpochInfo` at `finalized`, and a status answer whose
`context.slot` is at least that slot). Take the last block from your own RPC: your height when you
signed, plus 150, plus a margin. "No record" is proof only while the node still holds those blocks,
about the half-minute after the lifetime; later, look the signature up in a full history.
`protectedSwap`, `confirm` and `recoverPending` do this; `orientim resolve` settles by hand.

## Errors

Every error is `{ "error": { "code", "message" } }`, and that request signed and sent nothing. From
finalize the error names the transaction (`signature`, `lastValidBlockHeight`): check it before
preparing again. `price-moved` and `costs-more` carry `requiresApproval: true`: the user's decision, not
a retry.

| HTTP | `code` | What to do |
| --- | --- | --- |
| 400 | `bad-request` | Fix the field `message` names. |
| 400 | `invalid-ticket` | The ticket was not issued to this key, or was altered. |
| 400 | `transaction-changed` | Sign the transaction exactly as returned. |
| 400 | `wallet-changed-transaction` | Your wallet's signature is missing or does not match. |
| 400 | `bad-session` | `ownRoutes` session expired or opened for other terms. Prepare again without it. |
| 401 | `unauthorized` | Missing, expired or revoked key. Sign a new key challenge. |
| 403 | `wrong-wallet` | The key belongs to another wallet. |
| 404 | `not-enabled` | The agent API is not available. |
| 409 | `price-moved` | The route that fits cannot meet `minOut`. `newMinOut` is what it supports; prepare with it only with the user's approval. |
| 409 | `costs-more` | The route that fits is `gapBps` below the open market. With approval, prepare with `acceptCostBps`. |
| 409 | `routes-needed` | `ownRoutes`: fetch `requests` and prepare again. |
| 409 | `session-used` | `ownRoutes`: this session's one-time key already signed. Prepare again without it. |
| 409 | `output-balance-changed` | The output balance moved since prepare. Check `signature`, then prepare again. |
| 409 | `output-in-flight` | Another swap into the same output account has not landed. Wait `Retry-After`, finalize again. |
| 409 | `server-restarted` | Prepared before a restart. Check `signature`, then prepare again. |
| 410 | `expired` | The lifetime passed. Check `signature`, then prepare again. |
| 422 | `unsupported-token`, `no-route`, `bad-quote`, `insufficient-sol`, `insufficient-balance`, `simulation-failed`, `verification-failed`, `token-data-mismatch`, `output-account-restricted`, `input-account-restricted` | Cannot be built safely now; `message` says why. |
| 422 | `amount-too-small` | Below about 0.004 SOL or $1. Selling a token's whole balance is allowed at any size. |
| 426 | `skill-outdated` | Update the package to at least `minimum`. A signed swap still finalizes. |
| 429 | `rate-limited` | Wait `Retry-After`. |
| 500 | `internal` | Nothing was signed or sent. Retry later. |
| 503 | `busy`, `unavailable` | At capacity, or a dependency did not answer. Wait `Retry-After`. |
| 503 | `fee-unavailable` | The fee cannot be collected now. Wait `Retry-After`. |
| 503 | `paused` | Swaps and keys are paused. Funds are not affected. |
| 503 | `route-format` | Jupiter's instruction changed. Wait `Retry-After` (300 s). |

The key endpoints also answer:

| HTTP | `code` | What to do |
| --- | --- | --- |
| 400 | `bad-signature` | The signature or challenge is not valid. Ask for a new challenge. |
| 403 | `wallet-empty` | The wallet holds less than 0.01 SOL. Fund it. |
| 426 | `skill-outdated` | Update the package to at least `minimum`. |
| 429 | `rate-limited` | Wait `Retry-After`. |
| 503 | `unavailable` | The balance could not be read. Retry after `Retry-After`. |

## Direct integration

Orientim keeps no orders: it does not know your order ids and cannot deduplicate them. The chain and
your own store are the record. A bot calling the API directly must:

1. Set `minOut` from its own price and run `checkPrepared` or `orientim check` on the exact prepare
   answer, with its own RPC, before a signer sees it.
2. Give every order one stable id, and persist the transaction, ticket, signature and last valid block
   height before finalize. A repeated prepare is a new swap.
3. Serialize swaps per wallet with a durable lock. On restart or an unknown result, settle the signed
   transaction (confirmed, failed, or expired by the rule above) before anything new for that order.
4. Keep the signing key outside the agent, in a signer that enforces the owner's limits.

## What Orientim can and cannot do

- It never has your key. After your wallet signs, no byte can change without breaking that signature.
- No permission over your wallet outlives the transaction, and nothing may stay under the one-time key.
- It keeps no orders and nothing about your funds or keys, only short-lived records (ten minutes at
  most) and rate-limit counts.
- It can refuse or delay a swap; a transaction held back expires within 150 blocks.
- It sees the addresses and amounts of the swaps you ask for, as any swap API does.
