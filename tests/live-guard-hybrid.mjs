// Hybrid test: mock the session + PoW routes so chat() reaches the completion
// call, then forward completions to the REAL chat.deepseek.com. This isolates
// the content-type guard against production, which is otherwise shadowed by the
// earlier auth-gated PoW step.
import { createServer } from 'node:http';
import { DeepSeekWebClient } from '../src/deepseek-client.ts';

const LIVE_ORIGIN = 'https://chat.deepseek.com';

const mock = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;

  if (path === '/api/v0/chat_session/create') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { biz_code: 0, biz_data: { chat_session: { id: 'hybrid-session' } } } }));
    return;
  }

  if (path === '/api/v0/chat/create_pow_challenge') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { biz_code: 0, biz_data: { challenge: {
      algorithm: 'DeepSeekHashV1',
      challenge: 'cebab4aa8e50955666f589816c66811144e056a8f41c43a43bd78cedc4b5f4a1',
      salt: '8360f8c9205c96c32b7a',
      difficulty: 144000,
      signature: 'hybrid',
      expire_at: 1739764288699,
    } } } }));
    return;
  }

  if (path === '/api/v0/chat/completion') {
    // Forward to the real service with the caller's invalid token.
    let raw = '';
    req.on('data', (c) => { raw += c; });
    await new Promise((r) => req.on('end', r));

    const upstream = await fetch(`${LIVE_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...req.headers, host: undefined },
      body: raw,
      signal: AbortSignal.timeout(25_000),
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    });
    res.end(body);
    return;
  }

  res.writeHead(404).end('{}');
});

await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;

const client = new DeepSeekWebClient({
  token: 'invalid-probe-token-000000000000000000000000',
  appVersion: '2.0.0',
  locale: 'en-US',
  timezoneOffset: '0',
  timeoutMs: 30_000,
  baseUrl: `http://127.0.0.1:${port}`,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let error = null;
let turn = null;
try {
  turn = await client.chat({
    prompt: 'ping',
    chatSessionId: 'hybrid-session',
    thinkingEnabled: false,
  });
} catch (e) { error = e; } finally { mock.close(); }

console.log('=== completion content-type guard (live upstream, invalid token) ===');
if (error) {
  console.log(`  threw   : ${error.name}`);
  console.log(`  message : ${error.message.slice(0, 200)}`);
}
if (turn) {
  console.log(`  returned: text=${JSON.stringify(turn.assistantText)} finished=${turn.finished}`);
}

assert(error, 'DEFECT: live completion returned a turn instead of raising');
assert(
  error.name === 'DeepSeekAuthError',
  `expected DeepSeekAuthError from the content-type guard, got ${error.name}: ${error.message}`,
);
assert(
  /40003|INVALID_TOKEN|invalid token/i.test(error.message),
  `auth error should quote the upstream body: ${error.message}`,
);

console.log('\nCONTENT_TYPE_GUARD_LIVE_OK');
