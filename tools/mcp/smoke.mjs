// The MCP server as it ships (npm, Claude Desktop), started as a client starts it: plain JavaScript, so
// that it runs on every Node the package claims (CI runs it on each, on Linux, macOS and Windows).
//
//   node tools/mcp/smoke.mjs dist/orientim-mcp/bin/orientim-mcp.mjs
//
// The protocol in every version it speaks, the four tools, the commands the file runs itself, the
// wallet's own API key from a stand-in for Orientim on 127.0.0.1, and a client's placeholders taken
// as not set. Nothing reaches the network.
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const server = resolve(process.argv[2] ?? 'dist/orientim-mcp/bin/orientim-mcp.mjs');
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b) break; out = `1${out}`; }
  return out;
}

const home = mkdtempSync(join(tmpdir(), 'orientim-smoke-'));
const keypair = join(home, 'wallet.json');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
writeFileSync(keypair, JSON.stringify([...privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16), ...pub]));
const address = base58(pub);

const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, ORIENTIM_WALLET_KEYPAIR: keypair };
for (const name of ['ORIENTIM_API_KEY', 'ORIENTIM_API_URL', 'ORIENTIM_POLICY', 'ORIENTIM_STATE_DIR', 'SOLANA_RPC_URL', 'JUPITER_API_KEY']) delete baseEnv[name];

function serve(lines, env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [server], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.on('error', fail);
    child.on('close', () => done(stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))));
    child.stdin.end(`${lines.map(l => JSON.stringify(l)).join('\n')}\n`);
  });
}
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const quote = id => call(id, 'orientim_quote', { inputMint: SOL, outputMint: USDC, amount: '0.01' });

// The protocol, in each version.
for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
  const [init] = await serve([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }], baseEnv);
  check(init?.result?.protocolVersion === version, `initialize ${version}`);
}
const answers = await serve([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  call(3, 'orientim_drain'),
  call(4, 'orientim_quote', { inputMint: 'USDC', outputMint: SOL, amount: '1' }),
  { jsonrpc: '2.0', id: 5, method: 'ping' },
], baseEnv);
const by = id => answers.find(a => a.id === id);
check(JSON.stringify(by(2)?.result?.tools?.map(t => t.name)) === JSON.stringify(['orientim_wallet', 'orientim_quote', 'orientim_swap', 'orientim_recover']), 'tools/list: the four tools');
check(by(3)?.error?.code === -32602, 'an unknown tool is refused');
check(by(4)?.result?.isError === true && by(4)?.result?.structuredContent?.error?.code === 'input', 'a name instead of a mint is refused as input');
check(JSON.stringify(by(5)?.result) === '{}', 'ping');

// The commands the file runs itself.
const swapRun = spawnSync(process.execPath, [server, '--run-swap'], { encoding: 'utf8', env: baseEnv });
check(swapRun.status === 2 && /^usage: node swap\.ts/.test(swapRun.stderr), 'the example\'s command line, from the same file');
const verifyRun = spawnSync(process.execPath, [server, '--run-verify'], { encoding: 'utf8', env: baseEnv });
check(verifyRun.status === 2 && /usage: orientim-verify/.test(verifyRun.stdout), 'orientim-verify, from the same file');

// The wallet's own API key, from a stand-in for Orientim; then the dry run asks for the owner's RPC.
const seen = [];
let signed = false;
const orientim = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  seen.push(`${req.method} ${url.pathname}`);
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/v1/keys/challenge') {
    const host = req.headers.host;
    return send(200, {
      message: `${host} wants you to sign in with your Solana account:\n${url.searchParams.get('wallet')}\n\nGet an Orientim API key for this wallet. Signing costs nothing and gives no access to your funds.\n\nURI: http://${host}\nNonce: n1`,
      challenge: 'c1',
    });
  }
  if (url.pathname === '/api/v1/keys') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const { message, signature } = JSON.parse(body);
      signed = verify(null, Buffer.from(message), publicKey, Buffer.from(signature, 'base64'));
      send(200, { key: 'ori_smoke_secret', wallet: message.split('\n')[1], expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() });
    });
    return;
  }
  send(404, { error: { code: 'not-found', message: 'no' } });
});
await new Promise(r => orientim.listen(0, '127.0.0.1', r));
const keyEnv = {
  ...baseEnv, ORIENTIM_API_URL: `http://127.0.0.1:${orientim.address().port}`,
  // What a client passes for a field the owner left empty.
  SOLANA_RPC_URL: '${user_config.solana_rpc_url}', JUPITER_API_KEY: '', ORIENTIM_POLICY: '${user_config.policy}',
};
const [first] = await serve([quote(1)], keyEnv);
const answer = first?.result?.structuredContent;
check(signed, 'the wallet signed Orientim\'s key message, exactly as it came');
check(answer?.wallet === address, 'the wallet\'s address, read from its keypair file');
check(answer?.exitCode === 2 && /SOLANA_RPC_URL/.test(answer?.error?.line ?? ''), 'a placeholder RPC is not set: the dry run asks for the owner\'s');
check(!JSON.stringify(first).includes('ori_smoke_secret'), 'the key never reaches the answer');
const keyFile = join(home, '.orientim', 'api-key.json');
check(existsSync(keyFile) && JSON.parse(readFileSync(keyFile, 'utf8')).wallet === address, 'the key is kept in ~/.orientim');
if (process.platform !== 'win32') check((statSync(keyFile).mode & 0o777) === 0o600, 'the key file is its owner\'s alone');
await serve([quote(2)], keyEnv);
check(JSON.stringify(seen) === JSON.stringify(['GET /api/v1/keys/challenge', 'POST /api/v1/keys']), 'the kept key is used again: Orientim is asked once');
orientim.close();

console.log(failed ? `${failed} failed (Node ${process.version}, ${process.platform})` : `all passed (Node ${process.version}, ${process.platform})`);
process.exit(failed ? 1 : 0);
