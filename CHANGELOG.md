# Changelog

Versions of the skill (`skills/orientim-protected-swap/package.json`). Each version's `SHA256SUMS`
is the list Orientim serves at `/skill/SHA256SUMS` while it is current.

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
