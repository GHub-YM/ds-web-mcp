// MCP protocol handshake and tool catalog, with no credential configured.
//
// Points at a nonexistent config and clears credential env vars so the test
// asserts the unconfigured path regardless of what the developer machine holds.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DS_TOKEN: '',
    DS_COOKIE: '',
    DS_DEVICE_ID: '',
    DS_WEB_MCP_CONFIG: resolve(here, '..', '.no-such-config.json'),
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
child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolveFn, rejectFn) => {
    pending.set(id, resolveFn);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => rejectFn(new Error(`${method} timed out`)), 20_000);
  });
}

function assert(condition, message) { if (!condition) throw new Error(message); }

try {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'probe', version: '0.0.1' },
  });
  assert(init.result?.serverInfo?.name === 'deepseek-web', 'unexpected server name');
  console.log(`initialize -> ${JSON.stringify(init.result.serverInfo)}`);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const tools = await send('tools/list', {});
  const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
  console.log(`tools/list -> ${names.join(', ')}`);

  const expected = ['chat', 'diagnose', 'list_files', 'new_session', 'refresh_token', 'upload_files', 'web_search'];
  assert(
    JSON.stringify(names) === JSON.stringify(expected),
    `tool set mismatch: ${JSON.stringify(names)}`,
  );

  // Every tool that only reads must declare readOnlyHint so approval-free call
  // paths stay usable. `upload_files` is the deliberate exception: it writes to
  // the account's file store, so it must NOT claim to be read-only.
  const writeTools = new Set(['upload_files']);
  for (const tool of tools.result.tools) {
    if (writeTools.has(tool.name)) {
      assert(tool.annotations?.readOnlyHint !== true, `${tool.name} must not claim readOnlyHint`);
      continue;
    }
    assert(tool.annotations?.readOnlyHint === true, `${tool.name} is missing readOnlyHint`);
  }

  const diag = await send('tools/call', { name: 'diagnose', arguments: {} });
  const text = diag.result?.content?.[0]?.text ?? '';
  console.log(`diagnose (unconfigured) -> ${text.slice(0, 100)}`);
  assert(diag.result?.isError === true, 'diagnose should fail without a credential');
  assert(/login|token/i.test(text), `unhelpful error: ${text}`);

  console.log('\nHANDSHAKE_OK');
} finally {
  child.kill();
}
