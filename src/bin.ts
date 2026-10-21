/**
 * The `orientim` command.
 *
 *   orientim mcp                     MCP server over stdio
 *   orientim swap --in ... --out ... one protected swap (see ./agent.ts)
 *   orientim <command> < input.json  JSON commands on stdin/stdout (see ./cli.ts)
 */
import { fileURLToPath } from 'node:url';
import { commandLine as swap } from './agent.ts';
import { SKILL_VERSION } from './api.ts';
import { main as commands } from './cli.ts';
import { main as server, RUN_SWAP, RUN_VERIFY } from './mcp.ts';

const first = process.argv[2];
// Subcommands read their own arguments from process.argv.
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
  // The server spawns swaps from this same file.
  await server(fileURLToPath(import.meta.url));
} else {
  await commands();
}
