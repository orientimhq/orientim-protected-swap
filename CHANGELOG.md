# Changelog

Versions of the skill (`skills/orientim-protected-swap/package.json`). Each version's `SHA256SUMS`
is the list Orientim serves at `/skill/SHA256SUMS` while it is current.

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
- The policy's fields and error details from the server are checked for shape; prose never reaches
  the agent. An answer from Jupiter without a price impact is refused.
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
