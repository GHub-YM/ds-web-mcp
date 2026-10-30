// Definitive live test: run the real client against the real service with an
// invalid token and confirm the completion path raises a classified auth error
// instead of silently returning an empty answer.
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

const report = [];

// 1. Session create must classify the live body-level 40003 as auth.
{
  let error = null;
  try { await client.createChatSession(); } catch (e) { error = e; }
  assert(error, 'createChatSession should fail with an invalid token');
  report.push({ step: 'createChatSession', error: error.name, msg: error.message.slice(0, 90) });
  assert(error.name === 'DeepSeekAuthError', `expected DeepSeekAuthError, got ${error.name}`);
}

// 2. The completion path is the one that previously swallowed the error.
{
  let error = null;
  let turn = null;
  try {
    turn = await client.chat({ prompt: 'ping', thinkingEnabled: false });
  } catch (e) { error = e; }

  if (error) {
    report.push({ step: 'chat(completion)', error: error.name, msg: error.message.slice(0, 110) });
    assert(error.name === 'DeepSeekAuthError', `expected DeepSeekAuthError, got ${error.name}: ${error.message}`);
  } else {
    report.push({ step: 'chat(completion)', error: 'NONE', msg: `text=${JSON.stringify(turn?.assistantText)}` });
    throw new Error('DEFECT: live completion auth failure was not surfaced');
  }
}

// 3. PoW challenge route must also classify as auth, not PoW failure.
{
  let error = null;
  try { await client.createPowHeaders('/api/v0/chat/completion'); } catch (e) { error = e; }
  assert(error, 'createPowHeaders should fail with an invalid token');
  report.push({ step: 'createPowHeaders', error: error.name, msg: error.message.slice(0, 90) });
  assert(error.name === 'DeepSeekAuthError', `expected DeepSeekAuthError, got ${error.name}`);
}

console.log('=== live classification (real chat.deepseek.com, invalid token) ===');
for (const r of report) {
  console.log(`  ${r.step.padEnd(20)} -> ${r.error}`);
  console.log(`    ${r.msg}`);
}
console.log('\nLIVE_CLASSIFICATION_OK');
