/**
 * Builds what the skill ships beside its sources, so that the skill folder is the whole package an
 * agent or a bot downloads, and needs nothing from this repository:
 *
 *   lib/orientim-verify.mjs       the agent's verifier (src/verify.ts, with @orientim/verifier and friends)
 *   bin/orientim-verify.mjs       the command for bots in other languages (src/cli.ts and the example)
 *   bin/orientim-mcp.mjs          the MCP server for agents that work through tools (src/mcp.ts)
 *   SHA256SUMS                    the hash of every file the skill ships (`sha256sum -c SHA256SUMS`)
 *
 * and dist/orientim-protected-swap.zip, the skill folder as one download (the same file Orientim
 * serves at /skill/orientim-protected-swap.zip). The zip is stored without compression and with
 * fixed dates, so that it is byte for byte the same from every machine.
 *
 * The MCP server also goes out as one file with nothing beside it, @solana/kit inside: the npm package
 * orientim-mcp (dist/orientim-mcp/, for `npx`) and dist/orientim.mcpb, a Claude Desktop extension
 * (tools/mcp/ holds their README and icon).
 *
 * Only @solana/kit stays external, pinned to one version with a lockfile of hashes (package.json,
 * package-lock.json). Hashes are of the files with LF line ends, which .gitattributes keeps on
 * every checkout.
 *
 *   node tools/build-skill.ts           write them
 *   node tools/build-skill.ts --check   fail if a committed file differs from a fresh build (CI)
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { crc32 } from 'node:zlib';
import { rolldown } from 'rolldown';

const SKILL = 'skills/orientim-protected-swap';
/** What the skill ships, besides SHA256SUMS itself, in the order the sums list them. */
const SHIPPED = [
  'SKILL.md', 'README.md', 'LICENSE', 'package.json', 'package-lock.json', 'examples/swap.ts', 'lib/orientim-verify.mjs',
  'lib/orientim-verify.d.mts', 'bin/orientim-verify.mjs', 'src/verify.ts', 'src/cli.ts', 'src/cli-entry.ts', 'reference/AGENT-API.md',
  'bin/orientim-mcp.mjs', 'src/mcp.ts', 'src/mcp-entry.ts',
];

async function bundle(input: string, banner: string, standalone = false): Promise<string> {
  const b = await rolldown({
    input,
    // Standalone: everything inside, for a package that installs nothing else.
    external: id => !standalone && (id === '@solana/kit' || id.startsWith('@solana/kit/')),
    platform: 'node',
    logLevel: 'warn',
  });
  const { output } = await b.generate({ format: 'esm', banner });
  await b.close();
  return output[0].code;
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const sums = () => SHIPPED.map(file =>
  `${createHash('sha256').update(lf(readFileSync(`${SKILL}/${file}`, 'utf8'))).digest('hex')}  ${file}`).join('\n') + '\n';

/**
 * A zip of the skill, every file under one folder: stored (no compression, so no dependence on a
 * zlib version), dated 1980-01-01, the command marked executable, names in UTF-8.
 */
function zip(entries: { name: string; data: Buffer; mode: number }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data, mode } of entries) {
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed: 2.0
    head.writeUInt16LE(0x0800, 6); // names in UTF-8
    head.writeUInt16LE(0, 8); // stored
    head.writeUInt16LE(0, 10); // 00:00
    head.writeUInt16LE(0x21, 12); // 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    local.push(head, n, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE((3 << 8) | 20, 4); // made on Unix, so that the mode below is read
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE((mode << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, n);
    offset += head.length + n.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const skillPackage = () => JSON.parse(readFileSync(`${SKILL}/package.json`, 'utf8')) as { version: string; description: string; dependencies: Record<string, string> };

/** The MCP server as one file, the same for npm and for the Claude Desktop extension. */
let standaloneServer: Promise<string> | undefined;
const mcpServer = () => (standaloneServer ??= bundle(
  `${SKILL}/src/mcp-entry.ts`,
  `#!/usr/bin/env node\n// Generated by tools/build-skill.ts from skills/orientim-protected-swap/src/mcp.ts, with @solana/kit ${skillPackage().dependencies['@solana/kit']} inside. Do not edit.`,
  true,
  // The same bytes wherever @solana/kit was installed (the repository's node_modules or the skill's).
).then(code => code.replace(/^\/\/#region .*?node_modules\//gm, '//#region node_modules/')));

const MCP_DESCRIPTION = 'Protected swaps on Solana for MCP clients: the route can only touch the amount you approve, verified on your own RPC before your wallet signs.';
const REPOSITORY = 'https://github.com/orientimhq/orientim-protected-swap';
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const mcpReadme = () => lf(readFileSync('tools/mcp/README.md', 'utf8')).replaceAll('VERSION', skillPackage().version);

const npmPackage = () => json({
  name: 'orientim-mcp',
  version: skillPackage().version,
  description: MCP_DESCRIPTION,
  license: 'Apache-2.0',
  type: 'module',
  bin: { 'orientim-mcp': 'bin/orientim-mcp.mjs' },
  files: ['bin/', 'README.md', 'LICENSE'],
  engines: { node: '>=20.18' },
  repository: { type: 'git', url: `git+${REPOSITORY}.git`, directory: 'tools/mcp' },
  homepage: 'https://orientim.com/developers#mcp',
  keywords: ['mcp', 'model-context-protocol', 'solana', 'swap', 'jupiter', 'agent'],
});

/** The Claude Desktop extension's manifest (MCPB 0.3): the owner's settings, asked once, the secrets kept by the client. */
const mcpbManifest = () => json({
  manifest_version: '0.3',
  name: 'orientim-protected-swap',
  display_name: 'Orientim protected swap',
  version: skillPackage().version,
  description: MCP_DESCRIPTION,
  long_description: 'Swap Solana tokens from a wallet of your own through Orientim. The swap\'s route only ever holds the amount you approve, under a one-time key; the transaction is checked on your own RPC before your wallet signs, and less than your minimum reverts the whole swap. Claude quotes first, shows you what leaves the wallet and the least that arrives, and swaps only after your yes. Your key never reaches the model. The wallet\'s API key is signed for under Orientim\'s Terms of Use (orientim.com/terms), which using it accepts.',
  author: { name: 'Orientim', url: 'https://orientim.com' },
  homepage: 'https://orientim.com/developers#mcp',
  documentation: `${REPOSITORY}/blob/main/skills/orientim-protected-swap/SKILL.md#mcp-server`,
  support: `${REPOSITORY}/issues`,
  repository: { type: 'git', url: REPOSITORY },
  license: 'Apache-2.0',
  icon: 'icon.png',
  keywords: ['solana', 'swap', 'jupiter', 'wallet', 'defi'],
  privacy_policies: ['https://orientim.com/privacy'],
  server: {
    type: 'node',
    entry_point: 'server/orientim-mcp.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/orientim-mcp.mjs'],
      env: {
        SOLANA_RPC_URL: '${user_config.solana_rpc_url}',
        ORIENTIM_WALLET_KEYPAIR: '${user_config.wallet_keypair}',
        JUPITER_API_KEY: '${user_config.jupiter_api_key}',
        ORIENTIM_API_KEY: '${user_config.orientim_api_key}',
        ORIENTIM_POLICY: '${user_config.policy}',
        ORIENTIM_MAX_SLIPPAGE_BPS: '${user_config.max_slippage_bps}',
        ORIENTIM_MAX_PRICE_IMPACT_BPS: '${user_config.max_price_impact_bps}',
      },
    },
  },
  tools: [
    { name: 'orientim_wallet', description: 'The wallet\'s address and balances, read on your RPC.' },
    { name: 'orientim_quote', description: 'Prices and verifies a swap, in whole tokens. Nothing is signed.' },
    { name: 'orientim_swap', description: 'Carries out the quote you said yes to, and only that quote.' },
    { name: 'orientim_recover', description: 'Settles a swap that was interrupted.' },
  ],
  user_config: {
    solana_rpc_url: {
      type: 'string', title: 'Your Solana RPC URL', sensitive: true, required: true,
      description: 'Your own RPC (Helius, Triton, QuickNode...), never Orientim\'s: every swap is checked against it before your wallet signs.',
    },
    wallet_keypair: {
      type: 'file', title: 'Wallet keypair file', required: true,
      description: 'A solana-keygen file of a wallet of its own, holding only what may be swapped. The key stays on this computer.',
    },
    jupiter_api_key: {
      type: 'string', title: 'Jupiter API key', sensitive: true, required: false,
      description: 'Your own key, free at developers.jup.ag: Jupiter throttles calls without one.',
    },
    orientim_api_key: {
      type: 'string', title: 'Orientim API key (optional)', sensitive: true, required: false,
      description: 'Leave empty: the wallet gets its own key (it needs 0.01 SOL). Its key message accepts Orientim\'s Terms of Use (orientim.com/terms).',
    },
    policy: {
      type: 'file', title: 'Your limits (optional)', required: false,
      description: 'A policy file with the most each swap and each day may spend (see the skill\'s SKILL.md). Leave empty when /etc/orientim/policy.json or C:\\ProgramData\\Orientim\\policy.json exists: that file is then the only policy, and naming another one stops every swap.',
    },
    max_slippage_bps: {
      type: 'number', title: 'Most tolerance Claude may ask for, in bps (optional)', required: false, min: 10, max: 1500,
      description: 'Default 300 (3%). Lower it to hold every quote closer to the market; "auto" is then refused.',
    },
    max_price_impact_bps: {
      type: 'number', title: 'Most price impact, in bps (optional)', required: false, min: 0, max: 2000,
      description: 'Default 500 (5%).',
    },
  },
  compatibility: {
    platforms: ['darwin', 'win32', 'linux'],
    runtimes: { node: '>=20.18.0' },
  },
});

const mcpb = async () => zip([
  { name: 'manifest.json', data: Buffer.from(mcpbManifest(), 'utf8'), mode: 0o100644 },
  { name: 'server/orientim-mcp.mjs', data: Buffer.from(await mcpServer(), 'utf8'), mode: 0o100755 },
  { name: 'icon.png', data: readFileSync('tools/mcp/icon.png'), mode: 0o100644 },
  { name: 'README.md', data: Buffer.from(mcpReadme(), 'utf8'), mode: 0o100644 },
  { name: 'LICENSE', data: Buffer.from(lf(readFileSync(`${SKILL}/LICENSE`, 'utf8')), 'utf8'), mode: 0o100644 },
]);

const archive = () => zip([...SHIPPED, 'SHA256SUMS'].map(file => ({
  name: `orientim-protected-swap/${file}`,
  data: Buffer.from(lf(readFileSync(`${SKILL}/${file}`, 'utf8')), 'utf8'),
  mode: file.startsWith('bin/') ? 0o100755 : 0o100644,
})));

// In order, each written before the next is built: the command bundles the example, which imports
// lib/orientim-verify.mjs from disk, so the verifier must be current before the command is bundled, and
// the sums are taken of the files as they are once everything before them is written.
const outputs: [path: string, make: () => Promise<string | Buffer>][] = [
  [`${SKILL}/lib/orientim-verify.mjs`, () => bundle(
    `${SKILL}/src/verify.ts`,
    '// Generated by tools/build-skill.ts from skills/orientim-protected-swap/src/verify.ts and @orientim/verifier. Do not edit.',
  )],
  [`${SKILL}/bin/orientim-verify.mjs`, () => bundle(
    `${SKILL}/src/cli-entry.ts`,
    '#!/usr/bin/env node\n// Generated by tools/build-skill.ts from skills/orientim-protected-swap/src/cli.ts and examples/swap.ts. Do not edit.',
  )],
  [`${SKILL}/bin/orientim-mcp.mjs`, () => bundle(
    `${SKILL}/src/mcp-entry.ts`,
    '#!/usr/bin/env node\n// Generated by tools/build-skill.ts from skills/orientim-protected-swap/src/mcp.ts. Do not edit.',
  )],
  [`${SKILL}/SHA256SUMS`, async () => sums()],
];

const check = process.argv.includes('--check');
// The zip, the npm package and the extension are release assets, not committed: written on a build,
// never compared on a check.
if (!check) {
  outputs.push(
    ['dist/orientim-protected-swap.zip', async () => archive()],
    ['dist/orientim-mcp/bin/orientim-mcp.mjs', mcpServer],
    ['dist/orientim-mcp/package.json', async () => npmPackage()],
    ['dist/orientim-mcp/README.md', async () => mcpReadme()],
    ['dist/orientim-mcp/LICENSE', async () => lf(readFileSync(`${SKILL}/LICENSE`, 'utf8'))],
    ['dist/orientim.mcpb', mcpb],
  );
}
let stale = 0;
for (const [path, make] of outputs) {
  const content = await make();
  if (check) {
    let committed: Buffer | null = null;
    try {
      committed = readFileSync(path);
    } catch {
      // missing
    }
    const same = committed !== null && (typeof content === 'string'
      ? lf(committed.toString('utf8')) === lf(content)
      : committed.equals(content));
    if (!same) {
      console.error(`${path} differs from a fresh build. Run: node tools/build-skill.ts`);
      stale++;
    } else console.log(`${path} matches its source`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`${path}: ${content.length} bytes`);
  }
}
if (stale) process.exit(1);
