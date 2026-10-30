// Isolate the content-type guard added for the HTTP-200 auth defect.
//
// chat() normally creates a session first, which fails earlier. Passing an
// explicit sessionId skips that step so the completion route is exercised
// directly against the live service with an invalid token.
import { DeepSeekWebClient } from '../src/deepseek-client.ts';

const client = new DeepSeekWebClient({
  token: 'invalid-probe-token-000000000000000000000000',
  appVersion: '2.0.0',
  locale: 'en-US',
  timezoneOffset: '0',
  timeoutMs: 30_000,
  baseUrl: 'https://chat.deepseek.com',
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// With an explicit sessionId, chat() goes straight to PoW + completion.
let error = null;
let turn = null;
try {
  turn = await client.chat({
    prompt: 'ping',
    chatSessionId: 'probe-session-not-real',
    thinkingEnabled: false,
  });
} catch (e) { error = e; }

console.log('=== completion-route guard (live, invalid token) ===');
if (error) {
  console.log(`  threw      : ${error.name}`);
  console.log(`  message    : ${error.message.slice(0, 160)}`);
} else {
  console.log(`  NO ERROR   : text=${JSON.stringify(turn?.assistantText)} finished=${turn?.finished}`);
}

assert(error, 'expected an error from the live completion route');
// The PoW step runs first and is itself auth-gated, so either the PoW auth
// error or the completion content-type guard is a correct outcome. What must
// never happen is a silent empty answer.
assert(
  error.name === 'DeepSeekAuthError' || error.name === 'DeepSeekPowError',
  `unexpected error class: ${error.name} -> ${error.message}`,
);
assert(!turn, 'DEFECT: returned a turn instead of raising on an auth failure');

console.log('\nCOMPLETION_GUARD_OK (no silent empty answer)');
