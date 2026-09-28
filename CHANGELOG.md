# Changelog

Versions of the skill (`skills/orientim-protected-swap/package.json`). Each version's `SHA256SUMS`
is the list Orientim serves at `/skill/SHA256SUMS` while it is current.

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
