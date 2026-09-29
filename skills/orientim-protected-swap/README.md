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
- **The API itself**: `reference/AGENT-API.md`.

Route search is standard by default. An intent may request `routingMode: "fast"` when the server enables Jupiter's beta fast mode; compare latency and quote quality before using it for unattended orders. `version: 1` is a separate opt-in pilot for compatible RPCs and signers. The same verification runs before signing in both cases.

You need an API key from Orientim (`ORIENTIM_API_KEY`) and an RPC of your own (`SOLANA_RPC_URL`). The key
comes at once: connect the agent's wallet on orientim.com/developers#access and sign one message, or run
`orientim-verify key-challenge`, then `key` (see `SKILL.md`). Never put a wallet key in a prompt, a
message, a log or a command line. A key file the swap can read, the agent that runs it can read too: to
keep the key from the agent, sign in a process the agent does not run (a signing service, such as
Turnkey or Privy, or a signer of your own), and give the agent a wallet holding only what it may swap.

Set `ORIENTIM_POLICY` to a JSON file of your own limits, kept where the agent cannot edit it: the most
one swap may spend of each input mint (`maxAmountIn`; a mint not listed is refused) and the most all
swaps may spend in 24 hours (`maxAmountInPerDay`), and the absolute path of the state directory every
swap keeps its record in (`stateDir`; a daily limit needs one). See Setup in `SKILL.md`.

Slippage is automatic unless you set it: 0.5%, or 3% on a Pump.fun curve. Set
`slippageBps` (10 to 1500) for your own. A swap that would move the market more than 5% is refused
before anything is prepared (`maxPriceImpactBps` raises it, to 20% at most), and so is a minimum of
your own more than 20% below Jupiter's price (`floor-too-low`). The example and the command line start
nothing without an order id (`--id`, `intent.id`), the same on every retry, so that it is never
swapped twice.

**Check your copy before it signs anything.** `SHA256SUMS` lists the hash of every file here, and
Orientim's site serves the same list at `/skill/SHA256SUMS`: compare the two, then run
`sha256sum -c SHA256SUMS` in this folder (on Windows, `Get-FileHash` on each file). `npm ci` installs
exactly the versions in `package-lock.json`, each checked against its recorded hash.

Contents: `lib/orientim-verify.mjs` is Orientim's verifier, bundled; `bin/orientim-verify.mjs` the command;
`src/` their sources. Orientim's fee ceiling (0.3%; the fee is 0.25%) and treasury are pinned in the check: a swap that
charges more or pays anyone else is refused before your wallet signs.
