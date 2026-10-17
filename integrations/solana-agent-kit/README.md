# @orientimhq/solana-agent-kit

One action for [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit), `protectedSwap`, that
swaps through [Orientim](https://orientim.com). Everything else in the kit is left as it is.

The route can only touch the amount the swap approves, and the exact transaction is checked on **your
own RPC** (the kit's connection) before the agent's wallet signs it. The swap is the one `orientim swap`
makes; this package only hands it the kit's wallet and RPC. Read
[the guide](https://github.com/orientimhq/orientim-protected-swap/blob/main/skills/orientim-protected-swap/reference/GUIDE.md) for what is checked and why.

> **Status:** not yet published to npm. Until it is, build it from this repository, as below.

## Install from source

The plugin needs `@orientimhq/swap` 2.1.1, its peer dependency, beside it. Build both from a clone and install the
two tarballs in your app:

```bash
git clone https://github.com/orientimhq/orientim-protected-swap.git && cd orientim-protected-swap
npm ci --ignore-scripts && npm run build && npm pack --pack-destination /tmp
cd integrations/solana-agent-kit
npm ci --ignore-scripts --legacy-peer-deps && npm run build && npm pack --pack-destination /tmp

cd /path/to/your/app
npm install /tmp/orientimhq-swap-*.tgz /tmp/orientimhq-solana-agent-kit-*.tgz \
  solana-agent-kit@2.0.10 @solana/web3.js@1.98.4 zod@3.25.76
```

## Use

```ts
import { SolanaAgentKit, KeypairWallet } from 'solana-agent-kit';
import { orientimPlugin } from '@orientimhq/solana-agent-kit';

const agent = new SolanaAgentKit(new KeypairWallet(keypair, RPC_URL), RPC_URL, {}).use(
  orientimPlugin({
    apiKey: process.env.ORIENTIM_API_KEY!,       // this wallet's key: `orientim key-challenge`, then `orientim key`
    jupiterApiKey: process.env.JUPITER_API_KEY,  // your own; the routes are fetched with it
    policy: {
      maxAmountIn: { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: '25000000' },   // at most 25 USDC per swap
      allowedOutputMints: ['So11111111111111111111111111111111111111112'],        // and only into SOL
    },
  }),
);
```

The agent's actions then include `ORIENTIM_PROTECTED_SWAP`. Give the model the tools you choose, not
every action the kit has (see below); each of the kit's adapters takes the list:

```ts
import { createVercelAITools } from 'solana-agent-kit';   // or createLangchainTools, createOpenAITools
import { ACTION_NAME } from '@orientimhq/solana-agent-kit';

const tools = createVercelAITools(agent, agent.actions.filter(a => a.name === ACTION_NAME));
```

The model's tool takes `inputMint`, `outputMint`, `amount` in whole tokens as text (`"0.5"`), and
`slippageBps` and `orderId`, both null unless it means them: the kit's OpenAI and MCP adapters make
every field required, so a field the model may leave unset is nullable rather than optional. The answer
gives `receivedAmount` in whole tokens of the output, as `amount` is given (and `received` in base
units). In code: `await agent.methods.protectedSwap(agent, { inputMint, outputMint, amount: '5' })`.

A kit made with `signOnly` is refused: it hands signed transactions back for the app to send, and a
protected swap is sent within the call, once Orientim has signed last.

The `policy` is required, and is the same as Orientim's policy file (`maxAmountIn` and, optionally,
`allowedOutputMints`, `maxAmountInPerDay` with an absolute `stateDir`, `maxSlippageBps`, `maxBelowBps`,
`maxPriceImpactBps`); or give the path of a policy file. A plugin without limits is refused when it is made.
An administrator's policy file wins (see below).

Swaps wait for their outcome in a state directory: the policy's `stateDir`, else the `stateDir` option,
else `ORIENTIM_STATE_DIR`, else `.orientim-state` relative to where the app was started, which the
answer's `notices` then say. Give an absolute path that outlives the process, the same for every run of
the wallet.

Each call is an order with an `orderId` (given back in the answer). Asked again with the same `orderId`
after an unclear answer, an order is never swapped twice. A swap whose outcome is unknown blocks new
swaps from the wallet until it is settled: each call first looks up on the chain what earlier ones left
(`orientim resolve` does the same from the command line).

## What this protects, and what it does not

**It protects the swap.** A route (or Orientim's server) cannot take more than the approved amount, or
leave the wallet below the minimum, even if the model is misled. The minimum is the plugin's own: the
price this process asks Jupiter for, checked on your RPC, never the model's number or Orientim's. The
model chooses the tokens and the amount, within the owner's limits, and how far below that price the
minimum may sit: `slippageBps` at most 300 (3%), so the minimum is at most 4.5% below the price (5% on
a Pump.fun bonding curve), unless the owner's `maxSlippageBps` allows more. A higher `slippageBps` is
refused, not lowered. The price impact is held to 5%, or the owner's lower `maxPriceImpactBps`; the
model has no say in it.

**It does not make the agent safe.** The kit keeps the same hot key in the same process, and it has other
tools (`transfer`, and more) that can move the whole wallet. A misled agent can call those instead.
Expose the agent only to the tools it needs: build the tool list from this plugin's action, not from every
action the kit has, and keep the wallet's balance to what the agent may lose.

The policy given in code is as safe as the code that holds it: the model has no tool that edits it. A
policy file only an administrator writes (`/etc/orientim/policy.json`, or
`C:\ProgramData\Orientim\policy.json` on Windows) wins when it exists, as it does for the `orientim`
command and the MCP server: the plugin then refuses a policy given in code that is not that file or the
same limits, and, unless it runs as root, a file the user it runs as can change. It is read again on
every call. It binds this plugin, not the key: a compromised process still holds the kit's wallet.

## Tested with

`solana-agent-kit` 2.0.10, `@solana-agent-kit/adapter-mcp` 2.0.7, `@solana/web3.js` 1.98 and `zod` 3 (the
kit's own: its adapters accept only a schema from the same zod). The tests run the action through
`executeAction` and each adapter (AI SDK, LangChain, OpenAI Agents, MCP) when the kit is installed
(`npm install --no-save --legacy-peer-deps solana-agent-kit@2.0.10 @solana-agent-kit/adapter-mcp@2.0.7`).

Apache-2.0.
