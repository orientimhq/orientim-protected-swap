/**
 * The `orientim` command (dist/bin/orientim.mjs):
 *
 *   orientim mcp                     the MCP server, over stdio (`npx -y @orientimhq/swap mcp`)
 *   orientim swap --in ... --out ... one protected swap from the command line (see ./agent.ts)
 *   orientim <command> < input.json  prepare, finalize, check, recover, resolve, key-challenge, key:
 *                                    JSON in on stdin, JSON out on stdout (see ./cli.ts)
 *
 * It is the package's one command, so `npx @orientimhq/swap <args>` runs it: npx picks a package's
 * command by the package's name only when there are several.
 */
import { fileURLToPath } from 'node:url';
import { commandLine as swap } from './agent.ts';
import { SKILL_VERSION } from './api.ts';
import { main as commands } from './cli.ts';
import { main as server, RUN_SWAP, RUN_VERIFY } from './mcp.ts';

const first = process.argv[2];
// Each reads its own arguments from process.argv, as when it is run on its own.
const shift = () => void process.argv.splice(2, 1);

if (first === '--version' || first === '-v') {
  process.stdout.write(`${SKILL_VERSION}\n`);
} else if (first === RUN_SWAP || first === 'swap') {
  shift();
  swap();
} else if (first === RUN_VERIFY) {
  shift();
  await commands();
} else if (first === 'mcp') {
  shift();
  // The server runs each swap as this same file, so that it needs nothing beside it.
  await server(fileURLToPath(import.meta.url));
} else {
  await commands();
}
