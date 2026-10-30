// Control probe: prove the live probe can tell a missing route apart from an
// auth failure, so the earlier all-40003 result is meaningful.
const ORIGIN = 'https://chat.deepseek.com';

const headers = {
  'content-type': 'application/json',
  authorization: 'Bearer invalid-probe-token-000000000000000000000000',
  'X-App-Version': '2.0.0',
  'x-client-platform': 'web',
  'x-client-version': '2.0.0',
  'x-client-locale': 'en-US',
  'x-client-timezone-offset': '0',
};

const CASES = [
  { label: 'known route  ', path: '/api/v0/chat_session/create', body: {} },
  { label: 'bogus route  ', path: '/api/v0/definitely/not/a/route', body: {} },
  { label: 'wrong method ', path: '/api/v0/chat_session/create', method: 'GET' },
  { label: 'garbage body ', path: '/api/v0/chat_session/create', body: 'not-json-at-all' },
];

for (const c of CASES) {
  try {
    const response = await fetch(`${ORIGIN}${c.path}`, {
      method: c.method ?? 'POST',
      headers,
      body: c.method === 'GET' ? undefined : (typeof c.body === 'string' ? c.body : JSON.stringify(c.body)),
      signal: AbortSignal.timeout(20_000),
    });
    const text = (await response.text()).replace(/\s+/g, ' ').slice(0, 130);
    console.log(`${c.label} HTTP ${response.status}  ct=${response.headers.get('content-type')}`);
    console.log(`              ${text}`);
  } catch (error) {
    console.log(`${c.label} ERROR ${error.name}: ${error.message}`);
  }
}
