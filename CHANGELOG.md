# Changelog

Versions of the skill (`skills/orientim-protected-swap/package.json`). Each version's `SHA256SUMS`
is the list Orientim serves at `/skill/SHA256SUMS` while it is current.

## 1.8.1 (2026-09-30)

- A dry run's approval is found for an amount written with leading zeros past 20 digits too (found
  by the new fuzz of the owner's ceilings, "auto" tolerance and the archive's proof).

## 1.8.0 (2026-09-29)

- The owner's policy caps what an agent may choose: `maxSlippageBps` (the route's tolerance),
  `maxBelowBps` (how far below Jupiter's price the floor may sit) and `maxPriceImpactBps`. A choice
  beyond them is refused before anything is prepared (`slippage-over-limit`, `floor-over-limit`,
  `impact-over-limit`); a default beyond them is brought within them.
- `slippageBps: "auto"` (`--slippage-bps auto`): Jupiter's estimate of the tolerance the trade needs,
  from 0.5% to 3% (3% on a Pump.fun curve), never above the owner's ceiling. The route is built at
  that number, and the check holds it there; `checked.intent` carries it.
- `ORIENTIM_ARCHIVE_RPC_URL` (`archive` in code): an RPC with the full history, a second proof of
  expiry from the one-time key's own history when your RPC missed the moment the status cache could
  prove it. An outage near expiry no longer leaves the wallet at `unknown`.
- A lock held through a long wait (a signer asking a person) is kept fresh, so another worker never
  judges it left behind. A retry's marker file is removed once the order names the new attempt.
- An approval from a dry run is found for the same amount however it is written (`05000000`).
- The transaction's lifetime is stated as about a minute (150 blocks), not 40 seconds.

## 1.7.9 (2026-09-29)

- Orientim's fee is 0.25%; the check still refuses a fee above 0.3%. The smallest swap is about
  0.004 SOL, or $1 of USDC or USDT. Documentation only: the skill's code is unchanged.

## 1.7.8 (2026-09-29)

- A transaction that landed and failed on chain says why in `meaning`, read from the status your RPC
  gave and the transaction you signed: Jupiter's slippage error (6001) is "the price moved beyond
  your slippage"; other errors name the instruction, its program and the code.
- `no-route` says when to stop: try a smaller amount or once more later, and stop if it is refused
  again.
- SKILL.md: the smallest swap in numbers (about 0.0034 SOL, or $0.84 of USDC or USDT), tokens to
  sell must be in the policy, retries count against a daily limit, the cost caps are amounts, the
  20% bounds, what a bot with no one to ask does with each code, and the wait after `rejected`.

## 1.7.7 (2026-09-29)

- When the network's own check refuses a transaction at send time, `meaning` names the reason it
  gave, read from the simulation's error and the transaction you signed: Jupiter's slippage error
  (6001) is "the price moved beyond your slippage"; other program errors name the instruction, its
  program and the code. The error is read only in the shapes a simulation gives.
- Selling the whole balance of a token is allowed at any size, however little it is worth (Orientim
  refuses swaps below about $1 otherwise).

## 1.7.6 (2026-09-29)

- The example's result and `orientim-verify finalize` carry `meaning`: the outcome and `refusal` in
  words, with what to do next. A transaction the RPC's preflight refused (`rejected`, `refusal`
  `network`) says that the network's own check failed at send time, most often a price that moved,
  that nothing moved and no fee was paid, and that the order may be tried again with the same id.

## 1.7.5 (2026-09-29)

- An RPC that does not answer during the check is `error.code` `unavailable`, with `retryAfter`,
  instead of a refusal of the transaction; so is an RPC that answers 429 or 5xx. Other refusals are
  unchanged.
- A Jupiter 429 without `JUPITER_API_KEY` says that the key is missing.
- Refusals after the wallet signed say "Nothing was sent", not "nothing was prepared or signed".
- A limit outside what the skill allows (`maxBelowBps`, `maxNetworkFeeLamports`,
  `maxRouteCostLamports`, `maxSolFeeLamports`) is a usage error, exit 2, as documented.
- The key commands read `Retry-After`, answer `unavailable` when Orientim does not answer, and
  explain `bad-signature`. An answer from Orientim that is not JSON is `unavailable` (5xx).
- Error meanings name the cause the check has: `price-moved` also when the route that meets the
  minimum is too big, `unauthorized` for an expired or revoked key, and `insufficient-sol` as an
  estimate.
- A retry refused for a book without `reclaimOrder` no longer suggests a new order id.
- `fillAgainstQuote` says "within your tolerance" only when it is.

## 1.7.4 (2026-09-29)

- Adds an opt-in Jupiter fast route-search request to the example, with the same owner floor,
  independent verification, and exact-byte signing checks as standard routing.
- Adds optional per-phase timing callbacks for quote, prepare, verification, signing and finalization.
- Documents the existing v1 pilot as a separate opt-in requiring compatible RPCs and signers.

## 1.7.3 (2026-09-29)

- Clarifies that direct API clients must verify the exact transaction before signing, maintain a
  durable order book across all workers, and enforce owner limits at a separate signer when the
  agent must not control the key.
- Updates the API reference for the required positive `minOut` and the 30 bps production fee cap.
- Removes references to the retired browser swap page from the skill instructions and source comments.

## 1.7.2 (2026-09-28)

- The check of what stays under the one-time key reads every balance after the swap from the
  simulation's `postBalances`, matched to the transaction's accounts in order and to its lookup
  tables, instead of asking for them in `accounts.addresses`, which some RPC providers limit to two.
  An answer without balances, with another number of them, or with other loaded addresses is refused.
- An account under the one-time key that the transaction does not name is read before the swap, and
  counts as empty only when that read shows it empty.

## 1.7.1 (2026-09-28)

- `orientim-verify prepare` and `finalize` hold to the user's approval from a dry run kept in the same
  state directory: they refuse a lower minimum, or an approval that expired (exit 1, `error.code`
  `approval`).
- The approval is used up only once the swap lands. A swap that failed or expired keeps it until it
  expires, so a retry still holds to the minimum the user approved.

## 1.7.0 (2026-09-28)

- The user's yes after a dry run now binds the real swap (A5). A dry run that finds no problem
  answers `approval` (the least that arrives, and until when it holds, 10 minutes) and keeps it in the
  state directory. The real swap of the same wallet, mints and amount enforces at least that minimum,
  refuses a lower `--min-out`, and refuses once the approval expired; a swap that went out uses it up.

## 1.6.0 (2026-09-28)

Fixes from a second external audit (A1 to A4, A6, A7):

- `ownMinimum` refuses an amount whose price impact is above `maxPriceImpactBps` (default 5%, at most
  20%), so a bot built on `ownMinimum` and `verifyPrepared` keeps the check the full flow makes.
  AGENT-API.md says what `verifyPrepared` does not check, and names `prepareChecked` as the full flow.
- `orientim-verify finalize` refuses a `checked` without `intent.id` (exit 2) before anything is sent.
- The SOL a swap delivered is read from the chain and the verified policy, never from the costs the
  answer states; the check refuses an answer whose route rent, refund, SOL costs, fee rate or fee
  mint differ from the policy.
- An order's outcome is written only for the attempt that holds it (`settleOrder`): a late recovery
  of an older attempt never writes over a newer one. `orientim-verify recover` holds each wallet's
  lock while it settles, and waits (exit 3, `busy`) for a run that holds it.
- `amounts` and `costs` pass to the agent only as the fields the skill knows, the dry run's included.
- One exit-code rule for the example and `orientim-verify`: a confirmed swap whose record could not be
  updated exits 3 from both; every exit 3 carries `recoveryRequired: true`; the example exits 2 for a
  policy, state directory or keypair file it cannot use (`ConfigError`).

## 1.5.1 (2026-09-28)

Fixes from a live test with a real wallet:

- A daily limit counts every swap of the wallet in the last 24 hours, those made while no policy was
  set included: the example and `orientim-verify finalize` record every swap in the state directory,
  with a policy or without. Before, a swap counted only when a policy was active when it was made.
- `price-moved` from the example prints the error's data as JSON after its code
  (`{"newMinOut":"476545",...}`), so the value to ask the user about is there.
- The example exits 5 for an order that already swapped, or whose transaction may still land, as
  `orientim-verify` does, and 3 while another swap from the wallet may still land. A `slippageBps`
  outside 10 to 1500, or a `maxPriceImpactBps`, `maxFeeBps` or `minOut` the skill cannot use, is a
  usage error: exit 2 from the example and from `orientim-verify` (`IntentError`).
- `wallet-empty` (an API key needs at least 0.01 SOL in the wallet) has the skill's own words.
- `SKILL.md` says that `insufficient-sol` is an upper estimate that includes deposits returned in the
  same transaction, and that the network fee follows the network's load but never goes above the cap.

## 1.5.0 (2026-09-28)

Fixes from an external audit:

- `maxSolCostLamports` counts Orientim's fee whenever it is in SOL, whether taken from SOL sold, from
  SOL bought or from the wallet (`solFeeOf`). The API's `costs.keptSolLamports` states the same sum,
  and `costs.breakdown` each part apart.
- A quote without a price impact is unknown, not zero: the skill refuses it unless the owner's policy
  says `allowUnknownPriceImpact: true`; the API answers `priceImpactPct: null`.
- `tokenRisk`: what each token's issuer can do, a permanent delegate included, or `unavailable` when
  the mints cannot be read; `tokenNotices` now names a permanent delegate and says when it could not read.
- The JavaScript quickstart loads the owner's policy, passes `policy` and `spends`, holds the wallet's
  lock and recovers first.

## 1.4.0 (2026-09-27)

Fixes from a review of the skill and of `orientim-verify`:

- A fee paid in SOL is always held to the skill's own limit from Jupiter's price; `maxSolFeeLamports`
  can only lower it. `orientim-verify` never takes Orientim's treasury from its JSON (exit 2).
- `finalize` checks `checked` again in full, Jupiter's floor and the fee in SOL included, and
  refuses a wallet that is not an address before it touches a file.
- `finalize` that cannot read its state directory answers `outcome` `unknown` (exit 3), never "not
  sent"; a second transaction for an order that already swapped exits 5, and its spend is not counted.
- A transaction whose blockhash claims more than 150 blocks of life is refused.
- A lock whose process is gone from this host is taken over at once; a stopped run gives up its locks.
  "Another swap … is running" means wait and run again with the same `--id`.
- The state directory is the owner's alone (0700, files 0600), written durably; spends older than two
  days are cleared. The policy may pin it (`stateDir`); a daily limit needs an absolute directory.
- A swap of another wallet no longer holds this wallet's `prepare` back. An order recorded pending
  whose swap record is gone can be settled with `resolve`.
- A service that does not answer is `error.code` `unavailable`, with `retryAfter`.
- The policy's fields and error details from the server are checked for shape; the server's own
  text reaches the agent only as one short line marked untrusted (`serverMessage`). An answer from Jupiter without a price impact is refused.
- The example exits 0 only for a confirmed swap and 3 for what must be settled first; its dry run holds
  the owner's policy, and a bad key file is never repeated in an error.

## 1.3.2 (2026-09-27)

- First public release, under the Apache License 2.0.
- Comments cleaned of references to internal documents. No change in behaviour.

## 1.3.1 (2026-09-27)

- Harder property tests of the owner's limits, amounts and prices.

## 1.3.0 (2026-09-27)

- The owner's spending limits in a file (`ORIENTIM_POLICY`): the most per swap and per 24 hours for
  each input mint, and a mint not listed is refused.
- Advice on keeping the wallet key away from the agent: a signing service or a signer of your own.

## 1.2.0 (2026-09-27)

- Hard limits in code: a minimum at most 20% below Jupiter's own price (`floor-too-low`), price
  impact at most 20%, Orientim's fee at most 0.3%.
- Every swap needs an order id (`--id`, `intent.id`), the same on every retry, so it is never swapped
  twice.
- Errors read in the skill's own words; a server's text is kept apart as one untrusted line.

## 1.1.x (2026-09-26)

- Recovery fixes after a stop, and the API reference without operator settings.

## 1.0.0 (2026-09-26)

- First version: the agent checks each prepared swap on its own RPC before its wallet signs.
