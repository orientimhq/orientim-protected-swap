/**
 * Builds @orientimhq/swap into dist/: the library (index.mjs), the `orientim` CLI and MCP server
 * (bin/orientim.mjs), type declarations (types/), and the release-only Claude Desktop extension
 * (orientim.mcpb). Output is reproducible and is renamed into place only when complete.
 *
 *   node tools/build.ts
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { crc32 } from 'node:zlib';
import { rolldown } from 'rolldown';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string; description: string };
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const SHEBANG = '#!/usr/bin/env node';
/** Staging directory, renamed to dist/ when complete. */
const OUT = 'dist.partial';

/** Builds the library and CLI; @solana/kit stays an external dependency. */
const ENTRIES = {
  index: 'src/index.ts',
  core: 'packages/core/src/index.ts',
  solana: 'packages/solana/src/index.ts',
  verifier: 'packages/verifier/src/index.ts',
  'bin/orientim': 'src/bin.ts',
};

async function library(): Promise<void> {
  const b = await rolldown({
    input: ENTRIES,
    external: id => id === '@solana/kit' || id.startsWith('@solana/kit/'),
    platform: 'node',
    logLevel: 'warn',
  });
  await b.write({
    dir: OUT,
    format: 'esm',
    entryFileNames: '[name].mjs',
    chunkFileNames: 'chunks/[name]-[hash].mjs',
    banner: chunk => (chunk.name === 'bin/orientim' ? `${SHEBANG}\n` : ''),
  });
  await b.close();
}

/** Bundles the MCP server into one file for the Claude Desktop extension. */
async function standalone(): Promise<string> {
  const b = await rolldown({ input: 'src/bin.ts', platform: 'node', logLevel: 'warn' });
  const { output } = await b.generate({ format: 'esm', banner: `${SHEBANG}\n// @orientimhq/swap ${pkg.version}, with @solana/kit inside. Do not edit.` });
  await b.close();
  if (output.length !== 1) throw new Error('the standalone server must be one file');
  // Strip machine-specific paths for reproducible output.
  return output[0].code.replace(/^\/\/#region .*?node_modules\//gm, '//#region node_modules/');
}

/** Emits declarations with imports rewritten to resolve in the published package. */
function declarations(): void {
  const root = `${OUT}/types`;
  const run = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tools/tsconfig.types.json', '--outDir', root], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`declarations: ${run.stdout}${run.stderr}`);
  const WORKSPACE: Record<string, string> = {
    '@orientimhq/core': 'packages/core/src/index.d.ts',
    '@orientimhq/core/constants': 'packages/core/src/constants.d.ts',
    '@orientimhq/core/types': 'packages/core/src/types.d.ts',
    '@orientimhq/solana': 'packages/solana/src/index.d.ts',
    '@orientimhq/verifier': 'packages/verifier/src/index.d.ts',
  };
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8').replace(/^([^*\n]*?\bfrom )'([^']+)'/gm, (all, lead: string, spec: string) => {
      if (spec.startsWith('.')) return `${lead}'${spec.replace(/\.ts$/, '.js')}'`;
      const target = WORKSPACE[spec];
      if (!target) {
        if (/^@orientimhq\/(core|solana|verifier)(\/|$)/.test(spec) || spec.startsWith('@solana-program/')) throw new Error(`${file}: ${spec} is not published`);
        return all;
      }
      let rel = relative(dirname(file), join(root, target)).replaceAll('\\', '/').replace(/\.d\.ts$/, '.js');
      if (!rel.startsWith('.')) rel = `./${rel}`;
      return `${lead}'${rel}'`;
    });
    writeFileSync(file, lf(text));
  }
}

const MCP_DESCRIPTION = 'Protected swaps on Solana for MCP clients: the route can only touch the amount you approve, verified on your own RPC before your wallet signs.';
const REPOSITORY = 'https://github.com/orientimhq/orientim-protected-swap';
const mcpReadme = () => lf(readFileSync('tools/mcp/README.md', 'utf8')).replaceAll('VERSION', pkg.version);

/** A reproducible zip: stored entries, fixed 1980-01-01 dates, UTF-8 names, executable server. */
function zip(entries: { name: string; data: Buffer; mode: number }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data, mode } of entries) {
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // Version needed: 2.0.
    head.writeUInt16LE(0x0800, 6); // UTF-8 names.
    head.writeUInt16LE(0, 8); // Stored.
    head.writeUInt16LE(0, 10); // 00:00.
    head.writeUInt16LE(0x21, 12); // 1980-01-01.
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    local.push(head, n, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE((3 << 8) | 20, 4); // Made on Unix, so the mode is honored.
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

/** The Claude Desktop extension manifest (MCPB 0.3). */
const mcpbManifest = () => json({
  manifest_version: '0.3',
  name: 'orientim-protected-swap',
  display_name: 'Orientim protected swap',
  version: pkg.version,
  description: MCP_DESCRIPTION,
  long_description: 'Swap Solana tokens from a wallet of your own through Orientim. The swap\'s route only ever holds the amount you approve, under a one-time key; the transaction is checked on your own RPC before your wallet signs, and less than your minimum reverts the whole swap. Claude quotes first, shows you what leaves the wallet and the least that arrives, and swaps only after your yes. Your key never reaches the model. The wallet\'s API key is signed for under Orientim\'s Terms of Use (orientim.com/terms), which using it accepts.',
  author: { name: 'Orientim', url: 'https://orientim.com' },
  homepage: 'https://orientim.com/developers#mcp',
  documentation: `${REPOSITORY}/blob/main/skills/orientim-protected-swap/reference/GUIDE.md#mcp-server`,
  support: `${REPOSITORY}/issues`,
  repository: { type: 'git', url: REPOSITORY },
  license: 'Apache-2.0',
  icon: 'icon.png',
  keywords: ['solana', 'swap', 'jupiter', 'wallet', 'defi'],
  privacy_policies: ['https://orientim.com/privacy'],
  server: {
    type: 'node',
    entry_point: 'server/orientim.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/orientim.mjs', 'mcp'],
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
      description: 'Your own key, free at developers.jup.ag. Strongly recommended: without one Jupiter throttles calls, and a swap may stop before anything is signed.',
    },
    orientim_api_key: {
      type: 'string', title: 'Orientim API key (optional)', sensitive: true, required: false,
      description: 'Leave empty: the wallet gets its own key (it needs 0.01 SOL). Its key message accepts Orientim\'s Terms of Use (orientim.com/terms).',
    },
    policy: {
      type: 'file', title: 'Your limits (optional)', required: false,
      description: `A policy file with the most each swap and each day may spend (its format: ${REPOSITORY}/blob/main/skills/orientim-protected-swap/reference/GUIDE.md#setup). Leave empty when /etc/orientim/policy.json or C:\\ProgramData\\Orientim\\policy.json exists: that file is then the only policy, and naming another one stops every swap.`,
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
  { name: 'server/orientim.mjs', data: Buffer.from(await standalone(), 'utf8'), mode: 0o100755 },
  { name: 'icon.png', data: readFileSync('tools/mcp/icon.png'), mode: 0o100644 },
  { name: 'README.md', data: Buffer.from(mcpReadme(), 'utf8'), mode: 0o100644 },
  { name: 'LICENSE', data: Buffer.from(lf(readFileSync('LICENSE', 'utf8')), 'utf8'), mode: 0o100644 },
]);

rmSync(OUT, { recursive: true, force: true });
await library();
declarations();
writeFileSync(`${OUT}/orientim.mcpb`, await mcpb());
rmSync('dist', { recursive: true, force: true });
renameSync(OUT, 'dist');
for (const f of ['bin/orientim.mjs', 'index.mjs', 'orientim.mcpb']) console.log(`dist/${f}: ${statSync(`dist/${f}`).size} bytes`);
