# Orientim protected swap, for MCP clients

Protected swaps on Solana for Claude Desktop, Claude Code, Cursor and any client that starts a local
MCP server. Every transaction is checked on **your own RPC** before your wallet signs. This is
`orientim mcp`, from [`@orientimhq/swap`](https://github.com/orientimhq/orientim-protected-swap).

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

On Windows, write the path with doubled backslashes (`"C:\\Users\\you\\agent-wallet.json"`). Claude
Code: `claude mcp add --transport stdio orientim --env SOLANA_RPC_URL=... --env ORIENTIM_WALLET_KEYPAIR=... --env JUPITER_API_KEY=... -- npx -y @orientimhq/swap@VERSION mcp`.
`npx` needs Node.js 20.18 or later; `orientim.mcpb` runs on Claude Desktop's own Node.js.

- `SOLANA_RPC_URL`: your own Solana mainnet RPC, never Orientim's.
- `ORIENTIM_WALLET_KEYPAIR`: a keypair file, a JSON array of 64 numbers (`solana-keygen new --outfile <path>`).
- `JUPITER_API_KEY`: free at developers.jup.ag. Without it Jupiter throttles calls.
- The owner's limits: `/etc/orientim/policy.json`, or `ORIENTIM_POLICY`. Without them nothing is swapped.

Tools: `orientim_wallet`, `orientim_quote` (nothing is signed), `orientim_swap` (only the quote the user
approved, within 10 minutes) and `orientim_recover`. No tool takes a key, a minimum or a fee limit. The
server gets the wallet's own API key (which accepts orientim.com/terms) and keeps it in `~/.orientim`.
Fund the wallet with 0.01 SOL, held for the key, plus a little for fees.

Give the server a wallet of its own. Where the agent can also run commands, see "Safe setup for an
agent" in the skill's guide.

Apache-2.0.
