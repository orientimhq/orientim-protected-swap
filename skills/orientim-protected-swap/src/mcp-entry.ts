// The entry of bin/orientim-mcp.mjs (tools/build-skill.ts bundles it): see ./mcp.ts. The same file
// runs the skill's own commands for the server's swaps, so that it needs nothing beside it.
import { fileURLToPath } from 'node:url';
import { commandLine as swap } from '../examples/swap.ts';
import { main as verify } from './cli.ts';
import { main, RUN_SWAP, RUN_VERIFY } from './mcp.ts';

const mode = process.argv[2];
if (mode === RUN_SWAP || mode === RUN_VERIFY) {
  // The command reads its own arguments from process.argv, as when it is run by hand.
  process.argv.splice(2, 1);
  if (mode === RUN_SWAP) swap();
  else await verify();
} else {
  await main(fileURLToPath(import.meta.url));
}
