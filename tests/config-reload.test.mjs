// Config hot-reload.
//
// The server caches a client built from the config it read at startup. A
// credential swapped out-of-band (hand-edited file, an external `ds-web-mcp
// refresh`) must take effect without restarting the process.
//
// Verification is direct: a mock upstream records the bearer it receives, so
// the test can assert which token the server actually used after the file
// changed underneath it. Runs fully offline.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');

function assert(condition, message) { if (!condition) throw new Error(message); }

// --- mock upstream that records the bearer it was given ---------------------
const observed = { tokens: [], appVersions: [] };

const mock = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    observed.tokens.push(req.headers.authorization ?? null);
    observed.appVersions.push(req.headers['x-client-version'] ?? null);

    const send = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/v0/chat_session/create') {
      return send({ data: { biz_code: 0, biz_data: { chat_session: { id: 'mock-session' } } } });
    }
    return send({ data: { biz_code: 0, biz_data: {} } });
  });
});

await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;

// --- isolated config --------------------------------------------------------
const sandbox = join(process.env.TEMP ?? '.', `ds-web-mcp-reload-${Date.now()}`);
mkdirSync(sandbox, { recursive: true });
const configPath = join(sandbox, 'config.json');

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

function writeConfig({ token, appVersion }) {
  writeFileSync(configPath, `${JSON.stringify({
    token,
    appVersion,
    baseUrl: `http://127.0.0.1:${port}`,
  }, null, 2)}\n`);
}

writeConfig({ token: TOKEN_A, appVersion: '1.0.0-probe' });

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DS_TOKEN: '',
    DS_COOKIE: '',
    DS_DEVICE_ID: '',
    DS_NO_AUTO_REFRESH: '1', // keep the test offline
    DS_WEB_MCP_CONFIG: configPath,
  },
});

let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const fn = pending.get(message.id);
    if (fn) { pending.delete(message.id); fn(message); }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolveFn, rejectFn) => {
    pending.set(id, resolveFn);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => rejectFn(new Error(`${method} timed out`)), 15_000);
  });
}

function cleanup() {
  child.kill();
  mock.close();
  rmSync(sandbox, { recursive: true, force: true });
}

try {
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'reload-test', version: '1' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  console.log('  [1] initial config is used');
  {
    observed.tokens.length = 0;
    observed.appVersions.length = 0;
    const result = await send('tools/call', { name: 'new_session', arguments: {} });
    assert(!result.result.isError, `new_session failed: ${result.result.content[0].text}`);
    assert(observed.tokens.includes(`Bearer ${TOKEN_A}`), `expected token A, saw ${JSON.stringify(observed.tokens)}`);
    assert(observed.appVersions.includes('1.0.0-probe'), 'expected appVersion 1.0.0-probe');
    console.log('       used token A / appVersion 1.0.0-probe');
  }

  console.log('  [2] an out-of-band edit is picked up without restart');
  {
    writeConfig({ token: TOKEN_B, appVersion: '2.0.0-probe' });

    observed.tokens.length = 0;
    observed.appVersions.length = 0;
    const result = await send('tools/call', { name: 'new_session', arguments: {} });
    assert(!result.result.isError, `new_session failed: ${result.result.content[0].text}`);
    assert(
      observed.tokens.includes(`Bearer ${TOKEN_B}`),
      `server kept the stale token; saw ${JSON.stringify(observed.tokens)}`,
    );
    assert(observed.appVersions.includes('2.0.0-probe'), 'appVersion not reloaded');
    console.log('       switched to token B / appVersion 2.0.0-probe');
  }

  console.log('  [3] reverting is also observed');
  {
    writeConfig({ token: TOKEN_A, appVersion: '1.0.0-probe' });

    observed.tokens.length = 0;
    const result = await send('tools/call', { name: 'new_session', arguments: {} });
    assert(!result.result.isError, `new_session failed: ${result.result.content[0].text}`);
    assert(observed.tokens.includes(`Bearer ${TOKEN_A}`), 'revert not observed');
    console.log('       back on token A');
  }

  console.log('  [4] a corrupt config does not take the server down');
  {
    writeFileSync(configPath, '{ this is not valid json');

    const during = await send('tools/call', { name: 'new_session', arguments: {} });
    assert(during.result, 'no result object');
    assert(typeof during.result.content[0].text === 'string', 'malformed response');

    writeConfig({ token: TOKEN_B, appVersion: '3.0.0-probe' });
    observed.tokens.length = 0;
    const recovered = await send('tools/call', { name: 'new_session', arguments: {} });
    assert(!recovered.result.isError, `did not recover: ${recovered.result.content[0].text}`);
    assert(observed.tokens.includes(`Bearer ${TOKEN_B}`), 'did not resume reading config');
    console.log('       survived corrupt config and recovered');
  }

  console.log('\nRELOAD_OK');
  cleanup();
} catch (error) {
  console.error(`\n[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  cleanup();
  process.exit(1);
}
