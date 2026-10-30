// Regression test for the HTTP-200-wrapped auth failure defect.
//
// chat.deepseek.com answers an expired token with HTTP 200 and a JSON body
// {"code":40003,"msg":"INVALID_TOKEN"} rather than 401/403. A completion call
// must surface that as an auth error, not feed the JSON into the SSE decoder
// and return an empty answer.
import { createServer } from 'node:http';
import { DeepSeekWebClient } from '../src/deepseek-client.ts';

const SSE_OK = [
  'event: ready',
  'data: {"request_message_id":5,"response_message_id":6,"model_type":"default"}',
  '',
  'data: {"v":{"response":{"message_id":6,"parent_id":5,"role":"ASSISTANT","status":"WIP","fragments":[{"id":2,"type":"RESPONSE","content":"ok","stage_id":1}]}}}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
].join('\n\n') + '\n\n';

/** mode: 'auth_on_completion' | 'auth_on_session' | 'happy' */
function startMock(mode) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      const authFail = mode === 'auth_on_session'
        || (mode === 'auth_on_completion' && path === '/api/v0/chat/completion');

      if (authFail) {
        // Exact live shape: HTTP 200 + body-level code.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 40003, msg: 'INVALID_TOKEN', data: null }));
        return;
      }
      if (path === '/api/v0/chat_session/create') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { biz_code: 0, biz_data: { chat_session: { id: 's1' } } } }));
        return;
      }
      if (path === '/api/v0/chat/create_pow_challenge') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { biz_code: 0, biz_data: { challenge: {
          algorithm: 'DeepSeekHashV1',
          challenge: 'cebab4aa8e50955666f589816c66811144e056a8f41c43a43bd78cedc4b5f4a1',
          salt: '8360f8c9205c96c32b7a',
          difficulty: 144000,
          signature: 'mock',
          expire_at: 1739764288699,
        } } } }));
        return;
      }
      if (path === '/api/v0/chat/completion') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(SSE_OK);
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
  return server;
}

function clientFor(port) {
  return new DeepSeekWebClient({
    token: 'probe-token',
    appVersion: '2.0.0',
    locale: 'en-US',
    timezoneOffset: '0',
    timeoutMs: 20_000,
    baseUrl: `http://127.0.0.1:${port}`,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const results = [];

// 1. Happy path still works.
{
  const server = startMock('happy');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const turn = await clientFor(server.address().port).chat({ prompt: 'hi' });
    assert(turn.assistantText === 'ok', `happy path text: ${JSON.stringify(turn.assistantText)}`);
    results.push('happy path: assistantText="ok"');
  } finally { server.close(); }
}

// 2. Auth failure on session create (already handled).
{
  const server = startMock('auth_on_session');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let error = null;
  try { await clientFor(server.address().port).chat({ prompt: 'hi' }); }
  catch (e) { error = e; }
  finally { server.close(); }

  assert(error, 'auth_on_session should throw');
  results.push(`auth_on_session: ${error.name} -> ${error.message.slice(0, 70)}`);
}

// 3. The regression: HTTP 200 auth failure on the completion route itself.
{
  const server = startMock('auth_on_completion');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let turn = null;
  let error = null;
  try { turn = await clientFor(server.address().port).chat({ prompt: 'hi' }); }
  catch (e) { error = e; }
  finally { server.close(); }

  if (error) {
    results.push(`auth_on_completion: threw ${error.name} -> ${error.message.slice(0, 70)}`);
  } else {
    results.push(`auth_on_completion: NO ERROR, returned text=${JSON.stringify(turn.assistantText)} finished=${turn.finished}`);
  }

  assert(
    error || /INVALID_TOKEN|40003/i.test(JSON.stringify(turn)),
    'DEFECT: HTTP-200 auth failure was silently swallowed into an empty answer',
  );
}

console.log('\n=== invalid-token handling ===');
for (const line of results) console.log(`  ${line}`);
console.log('\nINVALID_TOKEN_HANDLING_OK');
