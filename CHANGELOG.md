# Changelog

Notable changes to `@orientimhq/swap`, in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Earlier versions are on npm.

## 3.0.0 (2026-10-21)

### Breaking

- `@orientimhq/swap/core` exports Orientim's constants and types only. A client verifies the
  transaction it is given; it never builds one.
- `TOKEN_ACCOUNT_RENT_UPPER_ORIENTIM_LAMPORTS` is removed: use `TOKEN_ACCOUNT_RENT_UPPER_BOUND_LAMPORTS`.

### Security

- R7 refuses a Token-2022 mint whose permanent delegate is the wallet or the one-time key.
- R1 refuses a wallet output account that requires a memo on every incoming transfer.
- R2 holds a route_v2's user destination to the one-time key's output account or the destination.
- The verifier refuses a message that is not its canonical encoding, and checks the swap program
  against Jupiter's address.
- The MCP server treats an error from a client that can ask the user as a no: the swap is refused.
- `orientim_swap` holds the swap to the minimum the user was shown, and a quote read back from disk
  is checked again before the user is asked.
- A server's text never reaches the model.
- `orientim swap`, the MCP server's quotes and swaps, and the `prepare` and `finalize` commands need
  the owner's policy: without one they stop before anything is prepared or signed, so a model's
  request alone never decides what is swapped.
- A wallet lock left by a container that was killed and restarted is taken after 30 seconds instead of
  10 minutes. A live holder in another container refreshes its lock every 5 seconds and keeps it.
- A policy named in `ORIENTIM_POLICY` that the user the agent runs as can change is used with a
  warning naming the administrator's `/etc/orientim/policy.json`, which the agent cannot change.
- The MCP server's saved quotes are checked with the question the user is asked, so an edited
  question is never shown.

### Added

- `integrations/solana-agent-kit`: a Solana Agent Kit plugin with one action, `protectedSwap`.
- `tokenRisk` reports a mint whose issuer can still turn on a transfer hook.
- `parsePolicy(object, source)` checks a policy given in code.
- `server.json` and `mcpName` for the MCP Registry.
- When Jupiter gives no quote for a token still on its Pump.fun bonding curve (a token in its first
  seconds, not listed yet), your own price is read from the curve on your RPC: `curvePrice`, used by
  `ownQuote` when given `rpc` and by every swap.

### Fixed

- `429` and 5xx answers without a code are waited out and tried again.
- A non-JSON success from Jupiter is treated as busy and tried again.
- Market names keep their spaces; Jupiter's insufficient liquidity is named.
- Out-of-range `maxBelowBps` and `maxPriceImpactBps` exit 2.
- RPC read failures are reported as `RpcUnavailableError`.
- A clock that jumps ahead no longer clears the daily limit's spends.
- Locks are scoped to the pid namespace.

### Changed

- The rate limits as served: 60 prepares and 30 finalizes a minute per key, 120 prepares a minute
  per address, and `503 busy` at capacity.
- A transaction lives 150 blocks, about 30 seconds at Solana's 200 ms blocks (since 2026-10-09).
  The verifier counts blocks, not seconds.
- The guide says that a swap revokes any delegate on the wallet's account for the token it buys, and
  that a container recreated under a new hostname waits up to 10 minutes for its old lock.
- The README says how 3.0.0 is checked: its tarball carries the release workflow's attestation, not
  npm's provenance.
- vitest 4.1.12, with a fixed vite, for the test tools only.
- The API reference says one key takes at most a quarter of the prepares all keys share a minute.
