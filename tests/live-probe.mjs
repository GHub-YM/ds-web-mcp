// Real-network probe against chat.deepseek.com.
//
// Purpose: confirm the vendored route table matches the live service and
// capture the exact shape of an unauthenticated rejection, without ever
// holding a credential. Every request here uses a deliberately invalid token.
const ORIGIN = 'https://chat.deepseek.com';

const ROUTES = [
  { name: 'createSession', method: 'POST', path: '/api/v0/chat_session/create' },
  { name: 'powChallenge', method: 'POST', path: '/api/v0/chat/create_pow_challenge', body: { target_path: '/api/v0/chat/completion' } },
  { name: 'completion', method: 'POST', path: '/api/v0/chat/completion', body: { chat_session_id: 'x', prompt: 'ping' } },
  { name: 'history', method: 'GET', path: '/api/v0/chat/history_messages?chat_session_id=x' },
];

const headers = {
  'content-type': 'application/json',
  authorization: 'Bearer invalid-probe-token-000000000000000000000000',
  'X-App-Version': '2.0.0',
  'x-client-platform': 'web',
  'x-client-version': '2.0.0',
  'x-client-locale': 'en-US',
  'x-client-timezone-offset': '0',
};

const results = [];

for (const route of ROUTES) {
  const started = Date.now();
  try {
    const response = await fetch(`${ORIGIN}${route.path}`, {
      method: route.method,
      headers,
      body: route.body ? JSON.stringify(route.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    results.push({
      route: route.name,
      status: response.status,
      ms: Date.now() - started,
      server: response.headers.get('server'),
      contentType: response.headers.get('content-type'),
      body: text.replace(/\s+/g, ' ').slice(0, 200),
    });
  } catch (error) {
    results.push({
      route: route.name,
      ms: Date.now() - started,
      error: `${error.name}: ${error.message}`,
    });
  }
}

console.log('=== live route probe (invalid token) ===');
for (const r of results) {
  console.log(`\n[${r.route}] status=${r.status ?? '-'} ms=${r.ms} server=${r.server ?? '-'}`);
  console.log(`  content-type: ${r.contentType ?? '-'}`);
  console.log(`  body: ${r.error ?? r.body}`);
}

console.log('\n=== classification ===');
for (const r of results) {
  let verdict;
  if (r.error) verdict = `TRANSPORT_FAILURE — ${r.error}`;
  else if (r.status === 404) verdict = 'ROUTE_MISSING — vendored path does not exist on the live service';
  else if (r.status === 401 || r.status === 403) verdict = 'ROUTE_EXISTS + AUTH_REQUIRED — expected for an invalid token';
  else if (r.status === 400) verdict = 'ROUTE_EXISTS + REJECTED_INPUT — reached the handler';
  else verdict = `OTHER (HTTP ${r.status})`;
  console.log(`  ${r.route}: ${verdict}`);
}
