# Contributing

Thank you for helping. Bug reports, fixes and documentation improvements are all welcome.

**Security issues do not go in public issues or pull requests.** Report them as [SECURITY.md](SECURITY.md)
describes.

## Build and test

Node 22.18 or later to build and test; the package runs on Node 20.18 or later.

```bash
npm ci
npm run typecheck
npm test               # unit and property tests
npm run build          # dist/: the package, its declarations, and orientim.mcpb
npm run test:fuzz      # the verifier's properties at 100,000 to 200,000 cases each (slow)
```

The Solana Agent Kit plugin has its own tests, run against this repository's source (after `npm ci`
at the root):

```bash
cd integrations/solana-agent-kit
npm ci --legacy-peer-deps
npm run typecheck
npm test               # add the kit to also test its adapters:
                       # npm install --no-save --legacy-peer-deps solana-agent-kit@2.0.10 @solana-agent-kit/adapter-mcp@2.0.7
```

A pull request should pass all of these. CI runs them on Linux, macOS and Windows.

## Guidelines

- **The verifier stays independent.** `packages/verifier` may import only `@solana/kit`, the token
  program client, the core constants and types, and its own files, never the compiler or the policy
  builder; `packages/verifier/test/architecture.test.ts` enforces it. A change to a rule (R1–R7) comes
  with tests that show what it now accepts and refuses.
- **Tests with the change.** A fix comes with a test that fails without it.
- **Changelog.** Add a line for a user-visible change under the unreleased version in
  [CHANGELOG.md](CHANGELOG.md), in the section that fits (Security, Added, Changed, Fixed...).
- **Commit messages.** A short subject naming the area and what changed (`Verifier: ...`,
  `MCP: ...`, `Docs: ...`), then a blank line and, when useful, a few bullets on what and why.
- **No secrets.** Never commit a keypair file, a private key, an API key, or an RPC URL with a key in
  it. Tests use generated keys and placeholders.

## Licence

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), as the rest of this repository is.
