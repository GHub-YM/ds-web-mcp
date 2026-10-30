// Live smoke test against the real chat.deepseek.com using whatever
// credential the local config holds. Prints shapes and lengths, never values.
import { loadConfig } from '../src/config.ts';
import { DeepSeekWebClient } from '../src/deepseek-client.ts';

const config = loadConfig();
console.log('=== credential shape ===');
console.log(`  token      : ${config.token ? `${config.token.length} chars` : '(none)'}`);
console.log(`  token dots : ${(config.token.match(/\./g) ?? []).length} (2 => JWT)`);
console.log(`  cookie     : ${config.cookie ? `${config.cookie.split(';').length} entries, ${config.cookie.length} chars` : '(none)'}`);
console.log(`  baseUrl    : ${config.baseUrl}`);

const client = new DeepSeekWebClient(config);

console.log('\n=== step 1: create session ===');
let chatSessionId = null;
try {
  chatSessionId = await client.createChatSession();
  console.log(`  OK  sessionId=${chatSessionId}`);
} catch (error) {
  console.log(`  FAIL ${error.name}: ${error.message.slice(0, 200)}`);
}

if (chatSessionId) {
  console.log('\n=== step 2: PoW challenge ===');
  try {
    const headers = await client.createPowHeaders('/api/v0/chat/completion');
    const value = Object.values(headers)[0] ?? '';
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    console.log(`  OK  algorithm=${decoded.algorithm} answer=${decoded.answer} target=${decoded.target_path}`);
  } catch (error) {
    console.log(`  FAIL ${error.name}: ${error.message.slice(0, 200)}`);
  }

  console.log('\n=== step 3: completion with web search ===');
  const started = Date.now();
  try {
    const turn = await client.chat({
      prompt: '今天有什么科技新闻？请给出来源。',
      chatSessionId,
      searchEnabled: true,
      thinkingEnabled: true,
      onTextChunk: () => {},
    });
    console.log(`  OK  ${Date.now() - started}ms  finished=${turn.finished}`);
    console.log(`  answer (${turn.assistantText.length} chars):`);
    console.log(`  ${turn.assistantText.slice(0, 600).replace(/\n/g, '\n  ')}`);
    if (turn.reasoningText) {
      console.log(`  thinking (${turn.reasoningText.length} chars):`);
      console.log(`  ${turn.reasoningText.slice(0, 300).replace(/\n/g, '\n  ')}`);
    }
    console.log(`  session: ${turn.sessionUrl}`);
    console.log('\nLIVE_SMOKE_OK');
  } catch (error) {
    console.log(`  FAIL ${error.name}: ${error.message.slice(0, 300)}`);
  }
}
