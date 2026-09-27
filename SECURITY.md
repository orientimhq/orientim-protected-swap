# Security policy

This skill decides what a wallet signs, so a flaw in it can cost someone their funds. Reports are
welcome and taken seriously.

## Reporting a vulnerability

Please report privately, never in a public issue or pull request:

- through GitHub: **Security**, then **Report a vulnerability**, on this repository; or
- by email, to the address in [orientim.com/.well-known/security.txt](https://orientim.com/.well-known/security.txt).

Include what you found, the version (`skills/orientim-protected-swap/package.json`), and a way to
reproduce it: a transaction, a server answer or a test is best. You will get an answer within a few
days. Please give us reasonable time to fix it before you publish.

## In scope

- A transaction the skill accepts although it breaks one of the rules R1–R7 or the skill's own checks
  (price floor, price impact, route rent, fee and treasury, the owner's policy).
- A way for a server, relay or RPC answer to make the agent act on text it sends.
- A swap sent twice for one order, or an outcome reported that the chain does not show.
- A difference between this source and the files Orientim distributes for the same version.

## Out of scope

- An attacker who already controls the machine the agent runs on, the agent's own instructions, or
  the RPC the owner chose (the skill trusts the RPC it is given for chain state).
- Price movements within the tolerance the user accepted.
- Denial of service by Orientim's server: it can refuse or delay a swap by design, never redirect one.

## Supported versions

Only the latest release receives fixes. Orientim's API may refuse versions that are too old
(`skill-outdated`).
