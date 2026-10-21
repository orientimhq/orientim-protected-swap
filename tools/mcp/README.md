# Orientim protected swap, for MCP clients

Protected swaps on Solana for Claude Desktop, Claude Code, Cursor and any client that starts a local
MCP server. The swap's route can only touch the amount you approve, and every transaction is checked
on **your own RPC** before your wallet signs. This is `orientim mcp`, the MCP server of
[`@orientimhq/swap`](https://github.com/orientimhq/orientim-protected-swap).

```json
{
  "mcpServers": {
    "orientim": {
      "command": "npx",
      "args": ["-y", "@orientimhq/swap@VERSION", "mcp"],
      "env": {
        "SOLANA_RPC_URL": "https://your-own-rpc.example/...",
        "ORIENTIM_WALLET_KEYPAIR": "/absolute/path/to/agent-wallet.json",
        "JUPITER_API_KEY": "..."
      }
    }
  }
}
```

On Windows, the keypair path is written with doubled backslashes:
`"ORIENTIM_WALLET_KEYPAIR": "C:\\Users\\you\\agent-wallet.json"`.

Claude Code: `claude mcp add --transport stdio orientim --env SOLANA_RPC_URL=... --env ORIENTIM_WALLET_KEYPAIR=... --env JUPITER_API_KEY=... -- npx -y @orientimhq/swap@VERSION mcp`.
The `npx` route needs Node.js 20.18 or later. Claude Desktop also takes `orientim.mcpb`, from the same
release or from orientim.com, installed with a click; it holds the server only, and Claude Desktop runs
it with its own built-in Node.js.

- `SOLANA_RPC_URL`: any Solana mainnet RPC of your own, never Orientim's. A provider's free tier is
  enough to start.
- `ORIENTIM_WALLET_KEYPAIR`: a keypair file, a JSON array of 64 numbers, as
  `solana-keygen new --outfile <path>` writes it. A base58 private key exported from a browser wallet
  is not that format.
- `JUPITER_API_KEY`: free at developers.jup.ag. Strongly recommended: without it Jupiter throttles
  calls, and a swap may stop before anything is signed.

Four tools: `orientim_wallet` (balances on your RPC), `orientim_quote` (prices and verifies a swap, in
whole tokens; nothing is signed), `orientim_swap` (the quote the user said yes to, and only that, within
10 minutes) and `orientim_recover` (settles an interrupted swap). No tool takes a key, a minimum or a fee
limit. The server needs no `ORIENTIM_API_URL` (it uses `https://orientim.com`) and no
`ORIENTIM_API_KEY`: it gets the wallet's own key and keeps it in `~/.orientim`, one file per wallet,
and its key message accepts Orientim's Terms of Use (orientim.com/terms). The command line needs both
set; the Solana Agent Kit plugin needs the key. Fund the wallet with 0.01 SOL, held for the key and not spent,
plus a little for each swap's network fee and rent; `orientim_wallet` gives its address. The owner's limits
(`/etc/orientim/policy.json`, or `ORIENTIM_POLICY`) hold here too, and without them nothing is quoted or swapped.

Give the server a wallet of its own, holding only what it may swap. In a client where the agent also
runs commands, it can read a key file the server can read: see "MCP server" and "Safe setup for an
agent" in the skill's guide. Pin the version: `@orientimhq/swap` is published with npm's provenance,
and `orientim.mcpb` with GitHub's attestation, both from the repository's release workflow.

Apache-2.0.
