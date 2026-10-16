# Orientim protected swap

Swap Solana tokens from a wallet an AI agent or a bot controls, so that the swap's route can only
touch the amount you approve. [Orientim](https://orientim.com) builds the transaction through
Jupiter; `@orientimhq/swap` checks it on **your own RPC**, with the verifier in this repository, before
your wallet signs, and reads the outcome on the chain.

Everything is one npm package, [`@orientimhq/swap`](https://www.npmjs.com/package/@orientimhq/swap): the
library, the `orientim` command, and its MCP server.

```bash
npx -y @orientimhq/swap@<version> mcp                     # the MCP server, for Claude Desktop, Claude Code, Cursor...
npx -y @orientimhq/swap@<version> swap --in ... --dry-run  # one swap from the command line
npm install --save-exact @orientimhq/swap@<version>       # import { protectedSwap } from '@orientimhq/swap'
```

| You are | Start with |
| --- | --- |
| An agent (Claude and other coding agents) | the skill, [`SKILL.md`](skills/orientim-protected-swap/SKILL.md), and its [guide](skills/orientim-protected-swap/reference/GUIDE.md) |
| A bot in JavaScript or TypeScript | `protectedSwap`, as in [`examples/swap.ts`](examples/swap.ts) |
| A bot in Python, Rust, Go... | `orientim prepare`, `finalize`, `recover`: JSON in and out ("Bots in other languages" in the guide) |
| Claude Desktop, Cursor or another MCP client | `npx -y @orientimhq/swap@<version> mcp`, or `orientim.mcpb` from a release |
| Calling the API yourself | [`AGENT-API.md`](skills/orientim-protected-swap/reference/AGENT-API.md) |

## What the check enforces

Before your wallet signs, the verifier decodes the exact transaction bytes and checks them against
seven rules (R1–R7), with every account read from your RPC, not from Orientim:

- the swap program (Jupiter's route) can reach only the approved amount, held by a one-time key;
- it never receives your wallet or any of your token accounts except the one that receives the output;
- the transaction grants no new authority over your assets;
- you receive at least the minimum you accepted, enforced on chain in the same transaction;
- Orientim's fee goes only to the treasury the package pins, and the package refuses it above 0.25% (up to 0.3% only when the agent sets `maxFeeBps`).

On top of the rules, the package brings a price floor of its own from Jupiter (a minimum more than 20%
below it is refused), refuses a price impact above your limit, simulates the swap on your RPC, holds
each swap to the owner's spending limits and the tokens the wallet may buy (`/etc/orientim/policy.json`
or `ORIENTIM_POLICY`), and never lets a server's text reach the agent as instructions. A compromised
server, relay or DNS can refuse or delay a swap; it cannot make your wallet sign one that moves
anything else. Orientim's server is not open source and is not in this repository: the check is
built so that you do not have to trust it.

## Repository layout

```
src/                              the package: the client (api, keys, chain, lock, policy, store, swap),
                                  the verifier's entry (verify.ts), the commands (cli.ts, agent.ts),
                                  the MCP server (mcp.ts), index.ts and bin.ts
packages/verifier/                the verifier: rules R1–R7 on the transaction bytes
packages/core/                    constants, types and the protected-swap layout the verifier checks
packages/solana/                  the RPC reads, and when "no record" proves a swap never landed
skills/orientim-protected-swap/   the skill: SKILL.md, its guide and the API reference
examples/swap.ts                  one protected swap from TypeScript
tools/build.ts                    builds dist/ (the package) and dist/orientim.mcpb
tools/mcp/                        the README and icon of orientim.mcpb, and a smoke test of the server
test/                             tests of the client, the commands and the MCP server
```

## Build and test

Node 22.18 or later to build and test; the package runs on Node 20.18 or later.

```bash
npm ci
npm run typecheck
npm test               # unit and property tests
npm run build          # dist/: the package, its declarations, and orientim.mcpb
npm run test:fuzz      # the verifier's properties at 100,000 to 200,000 cases each (slow)
```

Only `@solana/kit` stays outside the bundle, a dependency pinned to one version; the workspace
packages are bundled in.

## Check your copy

Check the package against GitHub, not against the site that told you about it: it exists to protect
you from a dishonest server, so a server cannot vouch for it. Each version from 2.0.0 on is published
from this repository's release workflow with npm's provenance, which names the repository, the
workflow and the commit. `npm audit signatures` checks that the signatures are valid, not who made
them, and passes a version with none. The tarball npm serves is the one the release workflow built
and attested, so GitHub's signed statement checks who built it:

```bash
npm install --save-exact @orientimhq/swap@<version> && npm audit signatures
npm pack @orientimhq/swap@<version> && gh attestation verify orientimhq-swap-<version>.tgz -R orientimhq/orientim-protected-swap \
  --signer-workflow orientimhq/orientim-protected-swap/.github/workflows/release.yml --source-ref refs/tags/v<version>
```

`orientim.mcpb` on each GitHub release carries GitHub's signed statement that the same workflow built
it from that tag, and `RELEASE-SHA256SUMS` lists its sha256:

```bash
gh attestation verify orientim.mcpb -R orientimhq/orientim-protected-swap \
  --signer-workflow orientimhq/orientim-protected-swap/.github/workflows/release.yml --source-ref refs/tags/v<version>
```

The build is reproducible: `git checkout v<version> && npm ci --ignore-scripts && npm run build` gives
the same `dist/` from any machine.

## Using it

You need an API key from Orientim (`ORIENTIM_API_KEY`, issued at once to a wallet that signs one
message: see the skill's guide) and an RPC of your own (`SOLANA_RPC_URL`). Use of the Orientim service is
governed by its [Terms of Use](https://orientim.com/terms).

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability. Please do not open a public issue for one.

## Licence

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for the bundled third-party code and the use of
the Orientim name.
