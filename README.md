# Orientim: zero-trust trade execution for AI agents on Solana

[![CI](https://github.com/orientimhq/orientim-protected-swap/actions/workflows/ci.yml/badge.svg)](https://github.com/orientimhq/orientim-protected-swap/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@orientimhq/swap)](https://www.npmjs.com/package/@orientimhq/swap)

The open-source client and verifier for [Orientim](https://orientim.com) protected swaps on Solana.
Before your wallet signs, `@orientimhq/swap` decodes the exact transaction and checks it on **your own
RPC**. A transaction that breaks a rule is never signed.

```bash
npx -y @orientimhq/swap@<version> mcp                      # MCP server (Claude Desktop, Claude Code, Cursor)
npx -y @orientimhq/swap@<version> swap --in ... --dry-run   # command line
npm install --save-exact @orientimhq/swap@<version>        # library: import { protectedSwap } from '@orientimhq/swap'
```

| You are | Start with |
| --- | --- |
| A coding agent | [`SKILL.md`](skills/orientim-protected-swap/SKILL.md) and the [guide](skills/orientim-protected-swap/reference/GUIDE.md) |
| A bot in TypeScript | [`examples/swap.ts`](examples/swap.ts) |
| A bot in another language | `orientim prepare`, `finalize`, `recover`: JSON in and out ([guide](skills/orientim-protected-swap/reference/GUIDE.md#bots-in-other-languages)) |
| Calling the API directly | [`AGENT-API.md`](skills/orientim-protected-swap/reference/AGENT-API.md) |

## The rules

The verifier (`packages/verifier`) checks seven rules on the bytes the wallet signs, with every account
read from your RPC:

| Rule | |
| --- | --- |
| R1 | The swap program never receives your wallet, or any of its token accounts except the one that receives the output. |
| R2 | Every other instruction is one the protected swap expects, with exact accounts and amounts: the approved amount, the on-chain minimum, the fee to the pinned treasury, the cleanup. |
| R3 | The one-time key and its token accounts do not exist on chain yet. |
| R4 | The network fee and the rent a route keeps stay under fixed maximums. |
| R5 | One canonical transaction within the size limit, each account loaded once, every temporary account opened and closed in it. |
| R6 | The wallet pays the fee, and the only signers are the wallet and the one-time key. |
| R7 | Every token on the route is a standard SPL token or a Token-2022 token without extensions that break isolation. |

On top of the rules, the client:

- requires a minimum of your own, and refuses one more than 20% below Jupiter's price;
- refuses a price impact above your limit (5% by default, 20% at most);
- simulates the transaction on your RPC and refuses one that leaves anything under the one-time key;
- holds every swap to the owner's policy file (`/etc/orientim/policy.json`): per swap, per day, allowed tokens, slippage;
- refuses Orientim's fee above 0.25% (0.3% only with `maxFeeBps`) or to any other treasury;
- never passes a server's text to the agent as instructions.

## Not covered

- **The key.** A key file the swap command can read, the agent can read too. Keep it in a separate signer.
- **Other tools.** Transfers or swaps made outside this package.
- **Your RPC.** Chain state is read from the RPC you choose; it is trusted for that.
- **The token.** `tokenRisk` reports what an issuer can still do (freeze, mint, a permanent delegate); it does not remove it.
- **Availability.** Orientim's server can refuse or delay a swap. It cannot make your wallet sign a different one.
- **Skipping pre-sign verification.** A client that calls the API without the verifier trusts the server with the whole wallet.

## Check your copy

Each release tarball and `orientim.mcpb` are built and attested by this repository's release workflow:

```bash
npm pack @orientimhq/swap@<version>
gh attestation verify orientimhq-swap-<version>.tgz -R orientimhq/orientim-protected-swap \
  --signer-workflow orientimhq/orientim-protected-swap/.github/workflows/release.yml --source-ref refs/tags/v<version>
```

`RELEASE-SHA256SUMS` on each release lists both hashes. The build is reproducible:
`git checkout v<version> && npm ci --ignore-scripts && npm run build` gives the same `dist/`.

## Build and test

Node 22.18 or later to build; the package runs on Node 20.18 or later. Its only dependency is
`@solana/kit`.

```bash
npm ci && npm run typecheck && npm test && npm run build
```

```
packages/verifier/   rules R1–R7
packages/core/       constants and types
packages/solana/     RPC reads, sending, proof that a swap expired
src/                 client, policy, order state, command line, MCP server
skills/              SKILL.md, guide, API reference
```

## Security and licence

Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes. Contributions: see
[CONTRIBUTING.md](CONTRIBUTING.md). [Apache License 2.0](LICENSE); see [NOTICE](NOTICE). Use of the
Orientim service is governed by its [Terms of Use](https://orientim.com/terms).
