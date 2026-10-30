// End-to-end test through the real MCP stdio protocol against the live service.
// Uses the captured credentials in ~/.deepseek-web-mcp.json.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/server.ts');

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });

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
    setTimeout(() => rejectFn(new Error(`${method} timed out`)), 240_000);
  });
}

function assert(condition, message) { if (!condition) throw new Error(message); }

try {
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'live-mcp', version: '0.0.1' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  console.log('=== tools/list ===');
  const tools = await send('tools/list', {});
  const names = tools.result.tools.map((t) => t.name);
  console.log(`  ${names.join(', ')}`);
  assert(names.includes('web_search'), 'web_search missing');

  console.log('\n=== diagnose (live auth check) ===');
  const diag = await send('tools/call', { name: 'diagnose', arguments: {} });
  const diagText = diag.result.content[0].text;
  console.log(`  isError=${diag.result.isError === true}`);
  console.log(`  ${diagText.replace(/\n/g, '\n  ').slice(0, 200)}`);
  assert(!diag.result.isError, `diagnose failed: ${diagText}`);

  console.log('\n=== web_search (live) ===');
  const started = Date.now();
  const search = await send('tools/call', {
    name: 'web_search',
    arguments: { query: '今天有什么开源软件的新闻？简短回答，附来源。' },
  });
  const text = search.result.content[0].text;
  console.log(`  elapsed=${Date.now() - started}ms  isError=${search.result.isError === true}`);
  console.log(`  length=${text.length} chars`);
  console.log(`  ${text.slice(0, 500).replace(/\n/g, '\n  ')}`);

  assert(!search.result.isError, `web_search failed: ${text.slice(0, 200)}`);
  assert(text.length > 100, `answer too short: ${text.length} chars`);
  assert(/Session: https:\/\/chat\.deepseek\.com/.test(text), 'session link missing from output');

  console.log('\nLIVE_MCP_E2E_OK');
} finally {
  child.kill();
}
