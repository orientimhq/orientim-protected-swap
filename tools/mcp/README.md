# orientim-mcp

Protected swaps on Solana for Claude Desktop, Claude Code, Cursor and any client that starts a local
MCP server. The swap's route can only touch the amount you approve, and every transaction is checked
on **your own RPC** before your wallet signs. This is the MCP server of the
[Orientim protected swap skill](https://github.com/orientimhq/orientim-protected-swap), as one file
with no dependencies.

```json
{
  "mcpServers": {
    "orientim": {
      "command": "npx",
      "args": ["-y", "orientim-mcp@VERSION"],
      "env": {
        "SOLANA_RPC_URL": "https://your-own-rpc.example/...",
        "ORIENTIM_WALLET_KEYPAIR": "/absolute/path/to/agent-wallet.json",
        "JUPITER_API_KEY": "..."
      }
    }
  }
}
```

Claude Code: `claude mcp add --transport stdio orientim --env SOLANA_RPC_URL=... --env ORIENTIM_WALLET_KEYPAIR=... -- npx -y orientim-mcp@VERSION`.
Claude Desktop also takes `orientim.mcpb`, from the same release or from orientim.com, installed with a click.

Four tools: `orientim_wallet` (balances on your RPC), `orientim_quote` (prices and verifies a swap, in
whole tokens; nothing is signed), `orientim_swap` (the quote the user said yes to, and only that, within
10 minutes) and `orientim_recover` (settles an interrupted swap). No tool takes a key, a minimum or a fee
limit. Without `ORIENTIM_API_KEY`, the server gets the wallet's own key and keeps it in
`~/.orientim`, one file per wallet; the wallet needs 0.01 SOL for it, and its key message accepts
Orientim's Terms of Use (orientim.com/terms). The owner's limits
(`/etc/orientim/policy.json`, or `ORIENTIM_POLICY`) hold here too.

Give the server a wallet of its own, holding only what it may swap. In a client where the agent also
runs commands, it can read a key file the server can read: see "MCP server" and "Safe setup for an
agent" in the skill's `SKILL.md`. Pin the version: this package is published with npm's provenance,
and `orientim.mcpb` with GitHub's attestation, both from the repository's release workflow.

Apache-2.0.
