# Changelog

Versions of the skill (`skills/orientim-protected-swap/package.json`). Each version's `SHA256SUMS`
is the list Orientim serves at `/skill/SHA256SUMS` while it is current.

## 1.9.4 (2026-10-03)

- The fall back to Orientim's own routes, after the route or round limit, runs within the time the
  preparation has left, never a call's full timeout: when that time is spent, the skill stops before
  signing with `BudgetSpentError` (`error.code` `unavailable` from `orientim-verify`), a spent budget
  of asks of Jupiter too. `check` and `finalize` hold their own checks before sending to a budget of
  their own. `BudgetSpentError`, `preparationBudget`, `PREPARATION_MS` and `PREPARATION_ASKS` are
  exported for an agent that runs its own.
- `reference/AGENT-API.md` states the integration contract plainly: who asks Jupiter and who reads
  the chain in one swap, that neither `sent` nor `unknown` is a final answer, that Orientim keeps no
  order database, and what a direct client does on every start.

## 1.9.3 (2026-10-03)

From an external audit:

- One budget for the whole preparation: 110 seconds and 48 asks of Jupiter, from the agent's own
  quote, every route and its retries and pauses, to the fee-in-SOL check, the check on your RPC and
  the token-risk read before signing. Every ask is counted before it is sent, even one that fails;
  time is kept on a monotonic clock; spent, the swap stops unsigned. Finalize and the wait for an
  outcome are not part of it.
- The fee on the output is documented exactly: 0.25% of the guaranteed minimum, which with your own
  routes is checked against an independent Orientim price within 1%. The earlier "never lowers
  Orientim's fee" said more than that.
- On Orientim's side, its own price is kept in the session for the rounds that follow while fresh
  (15 seconds) and asked for the same tolerance and fee, instead of being asked in every round.

## 1.9.2 (2026-10-02)

Found by the mainnet simulation matrix with the agent's own routes (732 cases):

- A large swap that needs more routes or rounds than one prepare may fetch (24 routes, 10 rounds) is
  prepared with Orientim's key instead of stopping. Orientim also asks for every narrower route in
  one round once the widest does not fit, so such a swap rarely gets there.
- A prepared route whose own price impact is above the limit is refused (`PriceImpactError`), as
  your own quote's is: a costlier route, once approved, may move the market more than the best one.
- Jupiter that does not answer in time is busy: asked again within the budget, then refused in
  words, never as a bare "operation aborted".

## 1.9.1 (2026-10-02)

- Routes from the agent's own key are held to more (found in an external audit). On Orientim's side:
  a fee on the output (a sale into SOL, USDC or USDT) is a share of the minimum a route sets, so
  Orientim now prices such a swap once with its own key and does not use a route whose minimum is
  more than 1% below that price; an excluded DEX it cannot tell by its programs is not taken as
  absent; in both cases Orientim builds the swap with its own key instead. A session now ends two
  minutes after the first round. On the skill's side:
  - the one-time key of the first round must be the one of every round and of the prepared swap;
  - routes are counted before they are fetched (24 in all), each fetched once, one at a time;
  - one prepare spends at most 48 asks of the agent's Jupiter key, retries included, and 110
    seconds in all;
  - a 429 from Jupiter is waited out as long as its `Retry-After` or `x-ratelimit-reset` says, when
    that fits the time left, and the wait is shared by the swaps of one process using the same key.

## 1.9.0 (2026-10-02)

- Routes from the agent's own Jupiter key. With `JUPITER_API_KEY` set, the skill and
  `orientim-verify` prepare with `ownRoutes: true`: Orientim answers which Jupiter builds it needs
  (`409 routes-needed`, with a sealed session and the one-time key as taker), the skill fetches them
  from Jupiter with the agent's key, which never leaves this process, and prepares again with them.
  Orientim builds, checks and signs around these routes exactly as around its own, and prices its
  fee in SOL with its own key, never from an agent's route. The skill fetches only requests for the
  swap's own mints, the named one-time key and an amount no larger than the agent's.
  `ORIENTIM_OWN_ROUTES=0` (or `ownRoutes: false`) lets Orientim's key build them as before; a
  deployment that does not know `ownRoutes` builds them itself.

## 1.8.8 (2026-10-02)

- A retry marker left by a worker that stopped between creating it and recording its new attempt
  no longer holds the order for good (found in an external audit). The file store's
  `reclaimOrder` now finds such a marker abandoned, and sets it aside atomically for one worker,
  only when all of these hold: it is older than a minute, the order still names the attempt it
  retries, and no swap kept for that order is pending. A marker a worker may still be using is never
  taken, so two workers still cannot both retry one order.

## 1.8.7 (2026-10-01)

- The owner's `maxSlippageBps` is read on v1 transactions too. A v1 message lists its instructions
  as headers and payloads, not as v0's instructions; the check read only the latter, so a v1 swap
  under an owner's ceiling stopped with "Cannot read properties of undefined" before signing (found
  by the mainnet simulation matrix run as v1). Nothing was signed; the swap could not be made. A v1
  transaction that failed on chain is now explained with its program too.

## 1.8.6 (2026-09-30)

- The owner's archive RPC (`ORIENTIM_ARCHIVE_RPC_URL`) proves expiry only when its history reaches
  back past every block the swap could have landed in: the skill asks it for its first available
  block and that block's height. An RPC that trims its history now proves nothing, and the swap
  stays `unknown`, rather than being called `expired` and swapped again.
- A prepare is waited for 60 seconds, longer than Orientim takes at most to answer one (45 seconds),
  so a slow build ends in its answer rather than in a second prepare.
- The source of the shipped bundle matches it again: a read of a node behind an earlier read's slot
  is asked again for about four and a half seconds (0.3 to 1.5 s apart), as the bundle already did.
- Docs: `acceptCostBps` also takes a route up to 0.5% past it, so a market that drifts a little does
  not ask again; `minOut` still holds.

## 1.8.5 (2026-09-30)

- A route that fails in the check's simulation is simulated once more, 1.2 seconds later, and only
  a simulation that succeeds is read. On mainnet, routes of $50k to $100k through markets whose
  maker sets the price each slot failed once and passed a moment later (found by the simulation
  matrix). A route that fails twice is refused as before, now naming the program that failed and
  its error code, from the simulation's logs; never a program's own words, which the route writes.

## 1.8.4 (2026-09-30)

- Jupiter's 400s that wrap a market whose price feed is behind for a moment ("Oracle price out of
  date", "Oracle is stale", "The price was expired", "Pair temporarily unavailable", or an upstream
  `500:`) are asked again, as busy answers, not taken as refusals. Found on mainnet by the
  simulation matrix, where they stopped about 7% of swaps. The agent's own price is now asked up to
  four times (waits of 0.4, 0.8 and 1.6 seconds). Orientim's server does the same.
- A refusal Jupiter gives without a code gets one: `NO_ROUTES_FOUND`, `TOKEN_NOT_TRADABLE` or
  `SAME_MINT`, asked once and never taken for busy.
- The same token on both sides is refused by the skill itself (`IntentError`), before anything is
  asked of Jupiter or Orientim.
- The check's simulation is asked again, a moment apart, when the RPC answers "Minimum context slot
  has not been reached" (a node of a load-balanced RPC a few slots behind the one that read the
  accounts). Before, it stopped the check as unavailable.

## 1.8.3 (2026-09-30)

- The agent's own price is asked of Jupiter again, twice, a moment apart, when Jupiter answers 429,
  a 5xx, or a 400 that wraps a failure upstream ("quote failed", "pool has not been updated"), as
  Orientim's server already does. Before, such a 400 stopped the swap at once with no reason given;
  on mainnet it hit swaps of $5k to $100k and sales of Pump.fun tokens (found by the mainnet
  simulation matrix). Still busy after three asks, it is said as `Jupiter answered 400 (busy)`, and
  `orientim-verify` answers `unavailable` (try again), not a refusal. Any other refusal is said at
  once with Jupiter's own error code, such as `COULD_NOT_FIND_ANY_ROUTE`, and none of its prose.

## 1.8.2 (2026-09-30)

- The owner's `maxSlippageBps` is held on the bytes the wallet signs, for every Jupiter route in
  them. Before, an agent whose own quote was an ordinary route (0.5% by default, within the
  ceiling) could be handed a route on a Pump.fun curve, which the check allowed at its own default
  (3%, tightened to about 2% by the agent's floor), above the owner's ceiling. Such a route is now
  refused before the wallet signs; ask for a `slippageBps` or `"auto"` within the ceiling to trade
  a curve token. Found by an outside audit; the fuzz now draws the agent's quote and the final
  route independently.
- The transaction's lifetime is stated as about 40 seconds again: at today's block times (about
  270 ms a slot, as the canary measures it) 150 blocks last about 41 seconds. 1.8.0 said a minute.

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
