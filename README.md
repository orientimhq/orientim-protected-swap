# Orientim protected swap skill

Swap Solana tokens from a wallet an AI agent or a bot controls, so that the swap's route can only
touch the amount you approve. [Orientim](https://orientim.com) builds the transaction through
Jupiter; this skill checks it on **your own RPC**, with the verifier in this repository, before your
wallet signs, and reads the outcome on the chain.

The skill is the folder [`skills/orientim-protected-swap`](skills/orientim-protected-swap). It is
self-contained: copy that folder, run `npm ci` in it, and it needs nothing else from this repository.

| You are | Start with |
| --- | --- |
| An agent (Claude and other coding agents) | [`SKILL.md`](skills/orientim-protected-swap/SKILL.md) |
| A bot in JavaScript or TypeScript | `protectedSwap` in [`examples/swap.ts`](skills/orientim-protected-swap/examples/swap.ts) |
| A bot in Python, Rust, Go... | the `orientim-verify` command, `bin/orientim-verify.mjs` ("Bots in other languages" in `SKILL.md`) |
| Calling the API yourself | [`reference/AGENT-API.md`](skills/orientim-protected-swap/reference/AGENT-API.md) |

## What the check enforces

Before your wallet signs, the verifier decodes the exact transaction bytes and checks them against
seven rules (R1–R7), with every account read from your RPC, not from Orientim:

- the swap program (Jupiter's route) can reach only the approved amount, held by a one-time key;
- it never receives your wallet or any of your token accounts except the one that receives the output;
- the transaction grants no new authority over your assets;
- you receive at least the minimum you accepted, enforced on chain in the same transaction;
- Orientim's fee goes only to the treasury the skill pins, and the skill refuses it above 0.3% (the fee is 0.25%).

On top of the rules, the skill brings a price floor of its own from Jupiter (a minimum more than 20%
below it is refused), refuses a price impact above your limit, simulates the swap on your RPC, holds
each swap to the owner's spending limits (`ORIENTIM_POLICY`), and never lets a server's text reach the
agent as instructions. A compromised server, relay or DNS can refuse or delay a swap; it cannot make
your wallet sign one that moves anything else.

## Repository layout

```
skills/orientim-protected-swap/   the skill, exactly as it is distributed
  SKILL.md, README.md, LICENSE      what an agent and a person read
  examples/swap.ts                  the whole flow, with recovery and one worker per wallet
  src/                              sources of the verifier entry point and the command
  lib/orientim-verify.mjs           the verifier, bundled (generated)
  bin/orientim-verify.mjs           the command, bundled (generated)
  reference/AGENT-API.md            the API reference
  SHA256SUMS                        the hash of every file above (generated)
packages/verifier/                the verifier: rules R1–R7 on the transaction bytes
packages/core/                    constants, types and the protected-swap layout the verifier checks
packages/solana/                  the RPC reads the skill makes, and when "no record" proves a swap never landed
tools/build-skill.ts              builds the generated files and the zip
test/                             tests of the skill itself
```

## Build and test

Node 22.18 or later.

```bash
npm ci
npm run typecheck
npm test               # unit and property tests
npm run check          # the committed bundles and SHA256SUMS match a fresh build
npm run build          # rebuild them, and dist/orientim-protected-swap.zip
npm run test:fuzz      # the verifier's properties at 100,000 cases each (slow)
```

Only `@solana/kit` stays outside the bundle; the skill pins it to one version, with a lockfile of
hashes.

## Check your copy

The build is reproducible: the same source gives the same bytes on any machine. To check a copy of the
skill you received, from Orientim or anywhere else:

```bash
git clone https://github.com/orientimhq/orientim-protected-swap && cd orientim-protected-swap
git checkout v<version>          # the version in skills/orientim-protected-swap/package.json
npm ci && npm run check          # the committed files are what this source builds
cd skills/orientim-protected-swap && sha256sum -c SHA256SUMS
```

then compare that `SHA256SUMS` with the one in your copy and with the list Orientim serves at
`https://orientim.com/skill/SHA256SUMS`. All three must be the same. `npm run build` also writes
`dist/orientim-protected-swap.zip`, byte for byte the archive Orientim serves at
`/skill/orientim-protected-swap.zip` for the same version.

## Using it

You need an API key from Orientim (`ORIENTIM_API_KEY`, issued at once to a wallet that signs one
message: see `SKILL.md`) and an RPC of your own (`SOLANA_RPC_URL`). Use of the Orientim service is
governed by its [Terms of Use](https://orientim.com/terms).

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability. Please do not open a public issue for one.

## Licence

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for the bundled third-party code and the use of
the Orientim name.
