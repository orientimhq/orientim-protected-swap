# @orientimhq/solana-agent-kit

One action for [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit), `protectedSwap`, that
swaps through [Orientim](https://orientim.com). Everything else in the kit is left as it is.

The route can only touch the amount the swap approves, and the exact transaction is checked on **your
own RPC** (the kit's connection) before the agent's wallet signs it. The swap is the one `orientim swap`
makes; this package only hands it the kit's wallet and RPC. Read
[the guide](../../skills/orientim-protected-swap/reference/GUIDE.md) for what is checked and why.

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

The agent's tools then include `ORIENTIM_PROTECTED_SWAP` (`inputMint`, `outputMint`, `amount` in whole
tokens as text). In code: `await agent.methods.protectedSwap(agent, { inputMint, outputMint, amount: '5' })`.

The `policy` is required, and is the same as Orientim's policy file (`maxAmountIn` and, optionally,
`allowedOutputMints`, `maxAmountInPerDay` with an absolute `stateDir`, `maxSlippageBps`, `maxBelowBps`,
`maxPriceImpactBps`); or give the path of a policy file. A plugin without limits is refused when it is made.

Each call is an order with an `orderId` (given back in the answer). Asked again with the same `orderId`
after an unclear answer, an order is never swapped twice. A swap whose outcome is unknown blocks new
swaps from the wallet until it is settled (`orientim resolve`).

## What this protects, and what it does not

**It protects the swap.** A route (or Orientim's server) cannot take more than the approved amount, or
leave the wallet below the minimum, even if the model is misled.

**It does not make the agent safe.** The kit keeps the same hot key in the same process, and it has other
tools (`transfer`, and more) that can move the whole wallet. A misled agent can call those instead.
Expose the agent only to the tools it needs: build the tool list from this plugin's action, not from every
action the kit has, and keep the wallet's balance to what the agent may lose.

The policy given in code is as safe as the code that holds it: the model has no tool that edits it. For a
policy the agent cannot reach even from a compromised process, use a policy file only an administrator
writes (`/etc/orientim/policy.json`) and the `orientim` command or MCP server instead.

## Tested with

`solana-agent-kit` 2.0.10 and `@solana/web3.js` 1.98. Its tests run against the real kit when it is
installed (`npm install --no-save solana-agent-kit@2.0.10`).

Apache-2.0.
