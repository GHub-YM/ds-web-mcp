// Fingerprint regression tests.
//
// The expected values here are literal copies of what Chrome 153.0.8010.50 on
// Windows put on the wire, captured on the development host. They are pinned
// deliberately: if a future edit reorders a header, drops a client hint, or
// changes the HTTP/2 SETTINGS payload, this test fails and says so.
import { createServer } from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import {
  buildOrderedHeaders,
  createFingerprintProfile,
  detectChromeVersion,
  parseChromeVersionOutput,
  resolveEcdhCurve,
  buildTlsOptions,
  CHROME_HTTP2_SETTINGS,
  CHROME_CONNECTION_WINDOW,
  CHROME_ACCEPT_ENCODING,
  DEFAULT_CHROME_VERSION,
} from '../src/fingerprint.ts';
import { FingerprintTransport } from '../src/transport.ts';

function assert(condition, message) { if (!condition) throw new Error(message); }
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected: ${b}\n  actual:   ${a}`);
}

const profile = createFingerprintProfile({ chromeVersion: '153' });
const results = [];

// --- the captured values themselves ----------------------------------------

assertEqual(
  profile.userAgent,
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  'User-Agent must match the captured Chrome string',
);
results.push('User-Agent matches the captured Chrome 153 string');

assertEqual(
  profile.secChUa,
  '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
  'Sec-CH-UA triple must match the captured value',
);
results.push('Sec-CH-UA triple matches (Chrome / Not_A Brand v8 / Chromium)');

assertEqual(profile.secChUaMobile, '?0', 'Sec-CH-UA-Mobile');
assertEqual(profile.secChUaPlatform, '"Windows"', 'Sec-CH-UA-Platform');
assertEqual(profile.acceptEncoding, 'gzip, deflate, br, zstd', 'Accept-Encoding');
assertEqual(profile.acceptLanguage, 'zh-CN,zh;q=0.9', 'Accept-Language');
results.push('Sec-CH-UA-Mobile/Platform, Accept-Encoding, Accept-Language match');

// --- a Chrome build number must not leak into the UA ------------------------

assertEqual(
  createFingerprintProfile({ chromeVersion: '153.0.8010.50' }).userAgent,
  profile.userAgent,
  'a real installed build number must be reduced to major.0.0.0',
);
assertEqual(
  createFingerprintProfile({ chromeVersion: '153.0.8010.50' }).secChUa,
  profile.secChUa,
  'client hints must stay major-only',
);
results.push('detected build numbers are reduced to the major-only UA form');

if (DEFAULT_CHROME_VERSION !== '153.0.0.0') {
  throw new Error(`default Chrome version drifted: ${DEFAULT_CHROME_VERSION}`);
}

// --- POST header order, against the captured wire ---------------------------

const APP_HEADERS = {
  'content-type': 'application/json',
  Authorization: 'Bearer TOKENVALUE',
  'x-client-version': '2.5.0',
  'x-client-platform': 'web',
  'x-app-version': '2.5.0',
  'x-client-locale': 'zh_CN',
  'x-client-timezone-offset': '28800',
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-device-id': 'dev-1',
  'X-DPP-Bypass-Hook': '1',
  'X-DS-PoW-Response': 'POW',
  cookie: 'ds_session_id=abc123',
};

const post = buildOrderedHeaders({
  method: 'POST',
  headers: APP_HEADERS,
  profile,
  hasBody: true,
  bodyLength: 14,
  url: new URL('https://chat.deepseek.com/api/v0/chat/completion'),
});

// Captured from POST /api/v0/chat/completion, HPACK header list order.
const EXPECTED_POST = [
  ':method', ':authority', ':scheme', ':path', 'content-length',
  'x-client-locale', 'sec-ch-ua-platform', 'authorization', 'x-client-bundle-id',
  'x-device-id', 'sec-ch-ua', 'x-dpp-bypass-hook', 'x-ds-pow-response',
  'sec-ch-ua-mobile', 'x-client-timezone-offset', 'x-app-version', 'user-agent',
  'x-client-version', 'content-type', 'x-client-platform', 'accept', 'origin',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'referer',
  'accept-encoding', 'accept-language', 'cookie', 'priority',
];

assertEqual(post.h2.filter((_, i) => i % 2 === 0), EXPECTED_POST, 'POST header order must match the captured Chrome wire order');
results.push('POST header order matches the captured Chrome wire order (30 slots)');

assertEqual(post.h2[0], ':method', 'pseudo-headers come first');
assertEqual(post.h2[1], 'POST', ':method value');
assertEqual(post.h2[2], ':authority', ':authority follows :method');
// The list is flat [name, value, ...]: four pseudo-header pairs, then
// content-length as the first regular header.
assertEqual(post.h2[8], 'content-length', 'content-length sits directly after the pseudo-headers');
assertEqual(post.h2[9], '14', 'content-length carries the body length');
results.push('pseudo-headers lead, content-length immediately follows');

// No duplicates: a header must appear exactly once.
for (const name of ['content-length', 'user-agent', 'sec-ch-ua', 'accept', 'origin', 'priority']) {
  const count = post.order.filter((n) => n === name).length;
  assert(count === 1, `${name} appears ${count} times, expected exactly 1`);
}
results.push('no duplicated headers in the ordered list');

// --- GET excludes Origin and positions Accept early -------------------------

// A history GET carries neither the bypass hook nor the PoW answer in real
// traffic, only the client headers plus an explicit Accept.
const { 'X-DPP-Bypass-Hook': _hook, 'X-DS-PoW-Response': _pow, ...GET_HEADERS } = APP_HEADERS;
const get = buildOrderedHeaders({
  method: 'GET',
  headers: { ...GET_HEADERS, accept: 'application/json' },
  profile,
  hasBody: false,
  url: new URL('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=abc'),
});

const EXPECTED_GET = [
  ':method', ':authority', ':scheme', ':path',
  'x-client-locale', 'sec-ch-ua-platform', 'authorization', 'x-client-bundle-id',
  'x-device-id', 'sec-ch-ua', 'sec-ch-ua-mobile', 'x-client-timezone-offset',
  'x-app-version', 'user-agent', 'accept', 'x-client-version', 'content-type',
  'x-client-platform', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
  'referer', 'accept-encoding', 'accept-language', 'cookie', 'priority',
];
assertEqual(get.h2.filter((_, i) => i % 2 === 0), EXPECTED_GET, 'GET header order must match the captured Chrome wire order');
assert(!get.order.includes('content-length'), 'a bodyless request must not send content-length');
assert(!get.order.includes('origin'), 'a GET must not send Origin');
results.push('GET header order matches, and omits content-length and Origin');

// --- the app's own headers survive ------------------------------------------

assertEqual(
  post.h2[post.h2.indexOf('authorization') + 1],
  'Bearer TOKENVALUE',
  'caller-supplied authorization value must be preserved',
);
assertEqual(
  post.h2[post.h2.indexOf('x-ds-pow-response') + 1],
  'POW',
  'caller-supplied PoW value must be preserved',
);
assertEqual(
  post.h2[post.h2.indexOf('user-agent') + 1],
  profile.userAgent,
  'the profile owns User-Agent, overriding any caller value',
);
results.push('caller values survive; profile-owned headers win');

// --- unknown headers are kept, not dropped ----------------------------------

const extra = buildOrderedHeaders({
  method: 'POST',
  headers: { ...APP_HEADERS, 'x-custom-thing': 'kept' },
  profile,
  hasBody: true,
  bodyLength: 2,
  url: new URL('https://chat.deepseek.com/api/v0/chat/completion'),
});
assert(extra.order.includes('x-custom-thing'), 'an unrecognised header must still be sent');
assertEqual(extra.order[extra.order.length - 1], 'x-custom-thing', 'unrecognised headers land after the known slots');
results.push('unrecognised headers are preserved and appended');

// --- TLS options ------------------------------------------------------------

const tlsOptions = buildTlsOptions(profile);
assert(tlsOptions.ciphers.includes('TLS_AES_128_GCM_SHA256'), 'cipher list must lead with TLS 1.3 suites');
assert(tlsOptions.ALPNProtocols.includes('h2'), 'ALPN must offer h2');
assert(resolveEcdhCurve(profile.ecdhCurve) !== null, 'a usable curve must resolve on this Node');
results.push(`TLS options build; curve resolves to ${resolveEcdhCurve(profile.ecdhCurve)}`);

// --- what the server actually receives, HTTP/2 ------------------------------

const observedH2 = await new Promise((resolvePromise, rejectPromise) => {
  const server = http2.createServer();
  const seen = { headerNames: null, settings: null, frames: [] };

  server.on('session', (session) => {
    session.on('remoteSettings', (settings) => { seen.settings = settings; });
  });

  server.on('stream', (stream, headers) => {
    seen.headerNames = Object.keys(headers);
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end('{"ok":true}');
  });

  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const transport = new FingerprintTransport({ profile, protocol: 'h2' });
    try {
      const response = await transport.fetch(`http://127.0.0.1:${port}/api/v0/chat/completion`, {
        method: 'POST',
        headers: APP_HEADERS,
        body: '{}',
      });
      await response.text();
      seen.status = response.status;
      transport.close();
      server.close();
      resolvePromise(seen);
    } catch (error) {
      transport.close();
      server.close();
      rejectPromise(error);
    }
  });
});

assertEqual(observedH2.status, 200, 'h2 request round-trips');
assert(observedH2.headerNames !== null, 'server received headers');
assertEqual(
  observedH2.headerNames,
  EXPECTED_POST,
  'server-side header order must equal the captured Chrome order',
);
results.push('HTTP/2 server sees the captured Chrome header order, pseudo-headers included');

// Chrome's SETTINGS payload, verified from the server's view of the client.
assertEqual(observedH2.settings?.headerTableSize, CHROME_HTTP2_SETTINGS.headerTableSize, 'SETTINGS headerTableSize');
assertEqual(observedH2.settings?.initialWindowSize, CHROME_HTTP2_SETTINGS.initialWindowSize, 'SETTINGS initialWindowSize');
assertEqual(observedH2.settings?.maxHeaderListSize, CHROME_HTTP2_SETTINGS.maxHeaderListSize, 'SETTINGS maxHeaderListSize');
assertEqual(observedH2.settings?.enablePush, CHROME_HTTP2_SETTINGS.enablePush, 'SETTINGS enablePush');
results.push('HTTP/2 SETTINGS match Chrome (65536 / 6291456 / 262144 / push off)');

// --- HTTP/1.1 fallback keeps the order and still works ----------------------

const observedH1 = await new Promise((resolvePromise, rejectPromise) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ names: req.rawHeaders.filter((_, i) => i % 2 === 0), ua: req.headers['user-agent'], ae: req.headers['accept-encoding'] }));
  });
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const transport = new FingerprintTransport({ profile, protocol: 'http1' });
    try {
      const response = await transport.fetch(`http://127.0.0.1:${port}/api/v0/chat/completion`, {
        method: 'POST',
        headers: APP_HEADERS,
        body: '{}',
      });
      const json = await response.json();
      transport.close();
      server.close();
      resolvePromise(json);
    } catch (error) {
      transport.close();
      server.close();
      rejectPromise(error);
    }
  });
});

assertEqual(observedH1.ua, profile.userAgent, 'HTTP/1.1 must carry the Chrome User-Agent, not "node"');
assertEqual(observedH1.ae, CHROME_ACCEPT_ENCODING, 'HTTP/1.1 must carry Chrome Accept-Encoding');
assert(!observedH1.names.includes('Node'), 'no Node-identifying header may remain');
const appNames = observedH1.names.filter((n) => !['Host', 'Connection', 'Content-Length'].includes(n));
assertEqual(appNames, EXPECTED_POST.filter((n) => !n.startsWith(':')), 'HTTP/1.1 header order must match the captured Chrome order');
results.push('HTTP/1.1 path sends the Chrome shape and the captured order');

// --- compressed responses are decoded (Accept-Encoding now advertises them) --

const gzBody = await new Promise((resolvePromise, rejectPromise) => {
  const payload = JSON.stringify({ data: { biz_code: 0, biz_data: { chat_session: { id: 'gz-session' } } } });
  const server = createServer((req, res) => {
    const body = gzipSync(payload);
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(body.length) });
    res.end(body);
  });
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const transport = new FingerprintTransport({ profile, protocol: 'http1' });
    try {
      const response = await transport.fetch(`http://127.0.0.1:${port}/api/v0/chat_session/create`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      const parsed = JSON.parse(await response.text());
      transport.close();
      server.close();
      resolvePromise(parsed?.data?.biz_data?.chat_session?.id ?? null);
    } catch (error) {
      transport.close();
      server.close();
      rejectPromise(error);
    }
  });
});
assertEqual(gzBody, 'gz-session', 'a gzip response must be transparently decoded');
results.push('gzip responses are decoded (required now that zstd/br are advertised)');

// --- the raw client preface: SETTINGS payload and WINDOW_UPDATE delta --------
//
// An HTTP/2 server normalises frames before exposing them, so the connection
// preface has to be read off a bare TCP socket to be checked against Chrome.

const PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'ascii');

function parseFrames(buffer) {
  const frames = [];
  let offset = buffer.subarray(0, 24).equals(PREFACE) ? 24 : 0;
  const hasPreface = offset === 24;
  while (offset + 9 <= buffer.length) {
    const length = buffer.readUIntBE(offset, 3);
    const type = buffer[offset + 3];
    const flags = buffer[offset + 4];
    const payload = buffer.subarray(offset + 9, offset + 9 + length);
    const frame = { type, flags, length };
    if (type === 4 && !(flags & 1)) {
      frame.settings = [];
      for (let i = 0; i + 6 <= payload.length; i += 6) {
        frame.settings.push([payload.readUInt16BE(i), payload.readUInt32BE(i + 2)]);
      }
    }
    if (type === 8) frame.delta = payload.readUInt32BE(0) & 0x7fffffff;
    frames.push(frame);
    offset += 9 + length;
  }
  return { hasPreface, frames };
}

const wire = await new Promise((resolvePromise, rejectPromise) => {
  const chunks = [];
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', () => {});
    setTimeout(() => { socket.destroy(); server.close(); resolvePromise(Buffer.concat(chunks)); }, 1200);
  });
  server.on('error', rejectPromise);
  server.listen(0, '127.0.0.1', () => {
    const transport = new FingerprintTransport({ profile, protocol: 'h2' });
    transport.fetch(`http://127.0.0.1:${server.address().port}/api/v0/x`, { method: 'POST', body: '{}' })
      .catch(() => {})
      .finally(() => setTimeout(() => transport.close(), 900));
  });
});

const parsed = parseFrames(wire);
assert(parsed.hasPreface, 'the client must send the HTTP/2 connection preface');
const settingsFrame = parsed.frames.find((f) => f.type === 4 && !(f.flags & 1));
assert(settingsFrame, 'a SETTINGS frame must precede any request');
assertEqual(settingsFrame.settings, [
  [1, CHROME_HTTP2_SETTINGS.headerTableSize],
  [2, CHROME_HTTP2_SETTINGS.enablePush ? 1 : 0],
  [4, CHROME_HTTP2_SETTINGS.initialWindowSize],
  [6, CHROME_HTTP2_SETTINGS.maxHeaderListSize],
], 'the raw SETTINGS payload must match Chrome byte for byte');
results.push('raw SETTINGS frame matches Chrome exactly (4 entries, same order, no extras)');

const windowFrame = parsed.frames.find((f) => f.type === 8);
assert(windowFrame, 'a connection-level WINDOW_UPDATE must follow SETTINGS');
assertEqual(
  windowFrame.delta,
  CHROME_CONNECTION_WINDOW - 65535,
  'WINDOW_UPDATE delta must be the captured Chrome value (15663105)',
);
results.push(`raw WINDOW_UPDATE delta=${windowFrame.delta} matches Chrome`);

assert(
  parsed.frames.indexOf(settingsFrame) < parsed.frames.indexOf(windowFrame),
  'SETTINGS must precede the WINDOW_UPDATE',
);
results.push('preface order is SETTINGS then WINDOW_UPDATE, as Chrome sends it');

// --- `--version` parsing (macOS/Linux discovery path) -----------------------
// Chrome prints its own version; Brave and Edge prepend their brand version and
// put the engine version after a `Chromium:` label. Taking the first number
// would advertise the wrong version in the UA on those browsers.
assertEqual(
  parseChromeVersionOutput('Google Chrome 153.0.8010.50'),
  '153.0.8010.50',
  'plain Chrome --version output must parse',
);
assertEqual(
  parseChromeVersionOutput('Brave Browser 1.75.175\nChromium: 153.0.8010.50'),
  '153.0.8010.50',
  'Brave must report the Chromium engine version, not its own',
);
assertEqual(
  parseChromeVersionOutput('Microsoft Edge 140.0.3485.54 (Chromium: 140.0.7339.186)'),
  '140.0.7339.186',
  'Edge must report the Chromium engine version, not its own',
);
assertEqual(
  parseChromeVersionOutput('Chromium 153.0.8010.50'),
  '153.0.8010.50',
  'plain Chromium --version output must parse',
);
assertEqual(parseChromeVersionOutput('no version here'), null, 'garbage input must return null');
results.push('`--version` parsing prefers the Chromium engine version (Brave/Edge safe)');

console.log('\n=== browser fingerprint ===');
for (const line of results) console.log(`  ${line}`);
console.log('\nFINGERPRINT_OK');
