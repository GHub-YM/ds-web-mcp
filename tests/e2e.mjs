import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/server.ts');

// ---------------------------------------------------------------------------
// Mock DeepSeek web backend. Mirrors the real route shapes the vendored
// encoders target: session create, PoW challenge, completion SSE, history.
// ---------------------------------------------------------------------------

const SSE_BODY = [
  'event: ready',
  'data: {"request_message_id":5,"response_message_id":6,"model_type":"default"}',
  '',
  'data: {"v":{"response":{"message_id":6,"parent_id":5,"role":"ASSISTANT","status":"WIP","fragments":[{"id":2,"type":"THINK","content":"需要查","stage_id":1}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"一下"}',
  '',
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"今日","stage_id":1}]}',
  '',
  'data: {"p":"response/fragments/-1/content","v":"天气晴"}',
  '',
  'data: {"v":"，气温 22 度"}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
].join('\n\n') + '\n\n';

const observed = { completionBody: null, powPath: null, authHeader: null };

const mock = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    observed.authHeader = observed.authHeader ?? req.headers.authorization ?? null;

    if (url.pathname === '/api/v0/chat_session/create') {
      return json(res, { data: { biz_code: 0, biz_data: { chat_session: { id: 'mock-session-1' } } } });
    }

    if (url.pathname === '/api/v0/chat/create_pow_challenge') {
      const body = JSON.parse(raw || '{}');
      observed.powPath = body.target_path ?? null;
      return json(res, {
        data: {
          biz_code: 0,
          biz_data: {
            challenge: {
              algorithm: 'DeepSeekHashV1',
              challenge: 'cebab4aa8e50955666f589816c66811144e056a8f41c43a43bd78cedc4b5f4a1',
              salt: '8360f8c9205c96c32b7a',
              difficulty: 144000,
              signature: 'mock-signature',
              expire_at: 1739764288699,
            },
          },
        },
      });
    }

    if (url.pathname === '/api/v0/chat/completion') {
      observed.completionBody = JSON.parse(raw || '{}');
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Split mid-multibyte to exercise the byte decoder over the wire.
      const encoded = new TextEncoder().encode(SSE_BODY);
      for (let i = 0; i < encoded.length; i += 5) {
        res.write(Buffer.from(encoded.subarray(i, Math.min(i + 5, encoded.length))));
      }
      res.end();
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `unmapped ${url.pathname}` }));
  });
});

function json(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;
console.log(`mock DeepSeek listening on 127.0.0.1:${port}`);

// ---------------------------------------------------------------------------
// Drive the MCP server over stdio, exactly as OpenClaw would.
// ---------------------------------------------------------------------------

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DS_TOKEN: 'mock-token-not-a-secret',
    DS_BASE_URL: `http://127.0.0.1:${port}`,
    DS_TIMEOUT_MS: '30000',
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
    const resolveFn = pending.get(message.id);
    if (resolveFn) { pending.delete(message.id); resolveFn(message); }
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolveFn, rejectFn) => {
    pending.set(id, resolveFn);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => rejectFn(new Error(`${method} timed out`)), 30_000);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0.0.1' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const result = await send('tools/call', {
    name: 'web_search',
    arguments: { query: '今天天气如何' },
  });

  const text = result.result?.content?.[0]?.text ?? '';
  console.log('\n--- web_search result ---');
  console.log(text);
  console.log('--- end ---\n');

  assert(!result.result?.isError, `tool reported an error: ${text}`);
  assert(text.includes('今日天气晴，气温 22 度'), 'answer text did not round-trip through the decoder');
  assert(text.includes('需要查一下'), 'reasoning text is missing from the tool output');
  assert(text.includes('mock-session-1'), 'session id is missing from the tool output');

  assert(observed.completionBody?.search_enabled === true, `search_enabled should be true, got ${observed.completionBody?.search_enabled}`);
  assert(observed.completionBody?.thinking_enabled === true, 'thinking_enabled should default to true');
  assert(observed.completionBody?.chat_session_id === 'mock-session-1', 'session id was not reused for the completion');
  assert(observed.completionBody?.prompt === '今天天气如何', 'prompt did not reach the backend');
  assert(observed.powPath === '/api/v0/chat/completion', `PoW target_path should be the completion route, got ${observed.powPath}`);
  assert(observed.authHeader === 'Bearer mock-token-not-a-secret', `auth header wrong: ${observed.authHeader}`);

  console.log('E2E_OK search_enabled=true pow_target=/api/v0/chat/completion stream_decoded=true');
} finally {
  child.kill();
  mock.close();
}
