# Orientim protected swap

Swap Solana tokens from a wallet your agent or bot controls, so that the swap's route can only
touch the amount you approve (any token Orientim's checks accept; others are refused with the reason). Orientim builds the transaction; this folder checks it on **your own
RPC** before your wallet signs, and reads the outcome on the chain.

```bash
npm ci               # the one dependency, @solana/kit 8.3.0, as the lockfile pins it (Node 22.18 or later)
```

- **Agents** (Claude and other coding agents): `SKILL.md` is the skill. `examples/swap.ts` is the
  whole flow, with recovery after a stop and one worker per wallet.
- **Bots in JavaScript or TypeScript**: import `protectedSwap` from `examples/swap.ts`. A wallet held
  by a signing service works through `signerFromSignBytes` or `signerFromSignTransaction`.
- **Bots in Python, Rust, Go...**: `bin/orientim-verify.mjs` (see "Bots in other languages" in
  `SKILL.md`). The bot signs one message with its own key; the command does the rest.
- **Claude Desktop, Cursor and other MCP clients**: `bin/orientim-mcp.mjs`, the skill as an MCP server
  with four tools (wallet, quote, swap, recover). See "MCP server" in `SKILL.md`.
- **The API itself**: `reference/AGENT-API.md`.

You need an API key from Orientim (`ORIENTIM_API_KEY`), an RPC of your own (`SOLANA_RPC_URL`), a Jupiter
API key of your own (`JUPITER_API_KEY`, free at developers.jup.ag) and `ORIENTIM_API_URL=https://orientim.com`.
Run `npm ci` in this folder once. The Orientim key comes at once and lasts 90 days: connect the agent's
wallet on orientim.com/developers#access and sign one message, or run
`node bin/orientim-verify.mjs key-challenge`, then `key` (see `SKILL.md`). Never put a wallet key in a prompt, a
message, a log or a command line. A key file the swap can read, the agent that runs it can read too: to
keep the key from the agent, sign in a process the agent does not run (a signing service, such as
Turnkey or Privy, or a signer of your own), and give the agent a wallet holding only what it may swap.

From a keypair file, without a browser: save this as `get-key.mjs` in this folder and run it once with
`ORIENTIM_WALLET_KEYPAIR` set (the owner runs it, not the agent; it signs only Orientim's key message):

```js
import { readFileSync } from 'node:fs';
import { createKeyPairFromBytes, getAddressFromPublicKey, signBytes } from '@solana/kit';
import { requestApiKey } from './examples/swap.ts';

const pair = await createKeyPairFromBytes(new Uint8Array(JSON.parse(readFileSync(process.env.ORIENTIM_WALLET_KEYPAIR, 'utf8'))));
const address = await getAddressFromPublicKey(pair.publicKey);
const { key, expiresAt } = await requestApiKey({
  apiUrl: 'https://orientim.com', address, signMessage: message => signBytes(pair.privateKey, message),
});
console.log(`ORIENTIM_API_KEY=${key}  (until ${expiresAt})`);
```

Write your own limits as JSON at `/etc/orientim/policy.json` (`C:\ProgramData\Orientim\policy.json` on
Windows), as an administrator, read-only to the agent: when that file exists it is used whatever the
environment says. `ORIENTIM_POLICY` can name a policy file elsewhere instead, which holds only for an
agent that keeps it set. The policy sets the most
one swap may spend of each input mint (`maxAmountIn`; a mint not listed is refused) and the most all
swaps may spend in 24 hours (`maxAmountInPerDay`), the tokens the wallet may buy (`allowedOutputMints`),
and the absolute path of the state directory every swap keeps its record in (`stateDir`; a daily limit
needs one). See "Safe setup for an agent" and Setup in `SKILL.md`.

Slippage defaults to 0.5%, or 3% on a Pump.fun curve. Set `slippageBps` (10 to 1500) for your own, or
`"auto"` to ask Jupiter for the trade's own tolerance (0.5% to 3%). A swap that would move the market more than 5% is refused
before anything is prepared (`maxPriceImpactBps` raises it, to 20% at most), and so is a minimum of
your own more than 20% below Jupiter's price (`floor-too-low`). The example and the command line start
nothing without an order id (`--id`, `intent.id`), the same on every retry, so that it is never
swapped twice.

**Check your copy before it signs anything.** `SHA256SUMS` lists the hash of every file here, and
Orientim's site serves the same list at `/skill/SHA256SUMS`: compare the two, then run
`sha256sum -c SHA256SUMS` in this folder (on Windows, `Get-FileHash` on each file). `npm ci` installs
exactly the versions in `package-lock.json`, each checked against its recorded hash.

Contents: `lib/orientim-verify.mjs` is Orientim's verifier, bundled; `bin/orientim-verify.mjs` the command;
`bin/orientim-mcp.mjs` the MCP server; `src/` their sources. Orientim's fee (0.25%, which `maxFeeBps` may raise to a 0.3% ceiling, never more) and treasury are pinned in the check: a swap that
charges more or pays anyone else is refused before your wallet signs.
