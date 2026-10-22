# Changelog

Notable changes to `@orientimhq/swap`, in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 3.0.0 (2026-10-22)

First release of this repository's package.

- The verifier: rules R1–R7 on the exact transaction bytes, with chain state from your own RPC.
- The client: your own price floor, price-impact limit, simulation, the owner's policy file, order
  ids, one swap in flight per wallet, and the outcome read on the chain.
- The `orientim` command line (`swap`, `prepare`, `finalize`, `check`, `recover`, `resolve`, `key`).
- The MCP server (`orientim mcp`) and `orientim.mcpb` for Claude Desktop.
- `@orientimhq/swap/core` exports constants and types only: a client verifies, it never builds.
