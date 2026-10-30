// Upload flow E2E: drives the real MCP server over stdio against a mock
// DeepSeek backend that implements /api/v0/file/upload_file,
// /api/v0/file/fetch_files and /api/v0/chat/completion.
//
// Asserts the wire-level facts that matter:
//   - upload_files reaches the upload route with a multipart body
//   - the multipart body carries the right part name, filename and bytes
//   - the returned file id is surfaced verbatim
//   - chat refFileIds lands in ref_file_ids on the completion body
//   - list_files round-trips against the fetch route
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/server.ts');

const observed = {
  uploadContentType: null,
  uploadBody: null,
  fetchQuery: null,
  completionBody: null,
  // Headers the real upload carries and a missing one of which is answered with
  // 40300 MISSING_HEADER. Captured from a successful (HTTP 200) browser upload.
  uploadHeaders: null,
};

const SSE_BODY = [
  'event: ready',
  'data: {"request_message_id":5,"response_message_id":6,"model_type":"default"}',
  '',
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"已读取附件","stage_id":1}]}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
].join('\n\n') + '\n\n';

const mock = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/api/v0/chat_session/create') {
      return json(res, { data: { biz_code: 0, biz_data: { chat_session: { id: 'mock-session-1' } } } });
    }

    if (url.pathname === '/api/v0/chat/create_pow_challenge') {
      // Same challenge values as the working e2e.mjs mock. The solver verifies
      // its own answer against these, so arbitrary constants are rejected with
      // "Invalid DeepSeek PoW challenge digest" before the request is made.
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

    if (url.pathname === '/api/v0/file/upload_file') {
      observed.uploadContentType = req.headers['content-type'] ?? null;
      observed.uploadBody = body;
      observed.uploadHeaders = { ...req.headers };
      // Mirror the LIVE response shape: the file record sits directly under
      // biz_data with no `file`/`files` wrapper. An earlier version of this mock
      // wrapped it, which let a real bug through — the client discarded the
      // unwrapped record and reported a successful upload as a failure.
      return json(res, {
        data: {
          biz_code: 0,
          biz_data: {
            id: 'file-abc123',
            status: 'PENDING',
            file_name: 'note.txt',
            from_share: false,
            file_size: Buffer.byteLength('hello upload'),
            model_kind: 'VISION',
            token_usage: null,
            error_code: null,
          },
        },
      });
    }

    if (url.pathname === '/api/v0/file/fetch_files') {
      observed.fetchQuery = url.searchParams.get('file_ids');
      return json(res, {
        data: {
          biz_code: 0,
          biz_data: {
            files: [{
              id: 'file-abc123',
              file_name: 'note.txt',
              file_size: 12,
              mime_type: 'text/plain',
              status: 'SUCCESS',
            }],
          },
        },
      });
    }

    if (url.pathname === '/api/v0/chat/completion') {
      observed.completionBody = JSON.parse(body.toString('utf8') || '{}');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(SSE_BODY);
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

// --- fixture file -----------------------------------------------------------
const workDir = mkdtempSync(join(tmpdir(), 'ds-upload-e2e-'));
const fixturePath = join(workDir, 'note.txt');
const fixtureText = 'hello upload';
writeFileSync(fixturePath, fixtureText, 'utf8');

await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;

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
child.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolveFn, rejectFn) => {
    pending.set(id, resolveFn);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => rejectFn(new Error(`${method} timed out`)), 30_000);
  });
}

function callTool(name, args) {
  return send('tools/call', { name, arguments: args });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let ok = false;
try {
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'upload-e2e', version: '0.0.1' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  // 1. Tool surface: upload_files and list_files must be registered.
  const list = await send('tools/list', {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  assert(names.includes('upload_files'), `upload_files missing from tools/list: ${names.join(',')}`);
  assert(names.includes('list_files'), `list_files missing from tools/list: ${names.join(',')}`);
  console.log('tools/list:', names.join(', '));

  // 2. Upload a real file.
  const upload = await callTool('upload_files', { filePaths: [fixturePath] });
  const uploadText = upload.result?.content?.[0]?.text ?? '';
  console.log('\n--- upload_files ---\n' + uploadText + '\n---');
  assert(!upload.result?.isError, `upload_files errored: ${uploadText}`);
  assert(uploadText.includes('file-abc123'), 'file id missing from upload output');

  // 3. The wire body must be real multipart/form-data with the file bytes.
  assert(
    (observed.uploadContentType ?? '').startsWith('multipart/form-data; boundary='),
    `content-type was not multipart: ${observed.uploadContentType}`,
  );
  const boundary = observed.uploadContentType.split('boundary=')[1];
  const bodyText = observed.uploadBody.toString('utf8');
  assert(bodyText.startsWith(`--${boundary}\r\n`), 'body does not start with the boundary');
  assert(bodyText.includes(`name="file"; filename="note.txt"`), 'part header is wrong');
  assert(bodyText.includes('Content-Type: text/plain'), 'part content-type is wrong');
  assert(bodyText.includes(fixtureText), 'file bytes are missing from the multipart body');
  assert(bodyText.endsWith(`--${boundary}--\r\n`), 'body does not end with the closing boundary');
  console.log('multipart OK: boundary applied, part header + bytes + terminator present');

  // 3b. Headers the real upload carries. The PoW header is the one whose
  // absence the service reports as 40300 MISSING_HEADER, so assert on it by
  // name and on its target_path, which must name the UPLOAD route rather than
  // the completion route.
  const headers = observed.uploadHeaders ?? {};
  assert(headers['x-file-size'] !== undefined, 'x-file-size is missing from the upload request');
  assert(
    Number(headers['x-file-size']) === Buffer.byteLength(fixtureText),
    `x-file-size should describe the file content, got ${headers['x-file-size']}`,
  );
  assert(headers['x-ds-pow-response'] !== undefined, 'x-ds-pow-response is missing; uploads need their own PoW');
  assert(headers['x-model-type'] !== undefined, 'x-model-type is missing from the upload request');
  assert(headers['x-thinking-enabled'] !== undefined, 'x-thinking-enabled is missing from the upload request');

  const powRaw = Buffer.from(String(headers['x-ds-pow-response']), 'base64').toString('utf8');
  const pow = JSON.parse(powRaw);
  assert(
    pow.target_path === '/api/v0/file/upload_file',
    `PoW target_path must name the upload route, got ${pow.target_path}`,
  );
  console.log('upload headers OK: x-file-size=' + headers['x-file-size']
    + ' pow_target=' + pow.target_path);

  // 3c. The response has no wrapper key, yet the id must still be surfaced.
  assert(uploadText.includes('file-abc123'), 'unwrapped file record was not parsed');
  assert(/status=PENDING/.test(uploadText), `status not surfaced from the record: ${uploadText}`);

  // 4. Attach the id to a chat turn and confirm it reaches ref_file_ids.
  const chat = await callTool('chat', { prompt: '总结附件', refFileIds: ['file-abc123'] });
  const chatText = chat.result?.content?.[0]?.text ?? '';
  assert(!chat.result?.isError, `chat errored: ${chatText}`);
  assert(chatText.includes('已读取附件'), 'chat answer did not round-trip');
  assert(
    Array.isArray(observed.completionBody?.ref_file_ids)
      && observed.completionBody.ref_file_ids.includes('file-abc123'),
    `ref_file_ids did not carry the upload id: ${JSON.stringify(observed.completionBody?.ref_file_ids)}`,
  );
  console.log('completion ref_file_ids:', JSON.stringify(observed.completionBody.ref_file_ids));

  // 5. list_files round-trips.
  const lookup = await callTool('list_files', { fileIds: ['file-abc123'] });
  const lookupText = lookup.result?.content?.[0]?.text ?? '';
  assert(!lookup.result?.isError, `list_files errored: ${lookupText}`);
  assert(lookupText.includes('file-abc123'), 'list_files did not return the id');
  assert(observed.fetchQuery === 'file-abc123', `fetch query wrong: ${observed.fetchQuery}`);
  console.log('list_files OK');

  // 6. A missing file must fail cleanly, not crash the server.
  const missing = await callTool('upload_files', { filePaths: [join(workDir, 'nope.bin')] });
  const missingText = missing.result?.content?.[0]?.text ?? '';
  assert(missing.result?.isError === true, 'missing file should report isError');
  assert(/Cannot read/.test(missingText), `missing file error text unclear: ${missingText}`);
  console.log('missing-file error OK');

  // Server survived all of it: a further call must still work.
  const after = await send('tools/list', {});
  assert((after.result?.tools ?? []).length > 0, 'server stopped responding after error paths');

  ok = true;
  console.log('\nUPLOAD_E2E_OK multipart_body=true pow_target=upload_file x-file-size=true '
    + 'unwrapped_record=true ref_file_ids_forwarded=true list_files=true error_path=clean');
} catch (error) {
  console.error('UPLOAD_E2E_FAIL:', error.message);
} finally {
  child.kill();
  mock.close();
  rmSync(workDir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
