import {
  consumeDeepSeekSseEvents,
  createDeepSeekSseByteDecoder,
  createDeepSeekStreamSummary,
  parseSSEChunk,
} from '../vendor/stream-codec.ts';

// Fixture copied from deepseek-pp/tests/deepseek-stream-reasoning.test.ts
// ("separates THINK fragment content from RESPONSE fragment content"), which
// mirrors a real captured DeepSeek web stream.
const SSE = [
  'event: ready',
  'data: {"request_message_id":5,"response_message_id":6,"model_type":"default"}',
  '',
  'data: {"v":{"response":{"message_id":6,"parent_id":5,"model":"","role":"ASSISTANT","thinking_enabled":true,"status":"WIP","fragments":[{"id":2,"type":"THINK","content":"我们","elapsed_secs":null,"references":[],"stage_id":1}],"conversation_mode":"DEFAULT"}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"使用"}',
  '',
  'data: {"v":"经典的"}',
  '',
  'data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":1.4}',
  '',
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"设","references":[],"stage_id":1}]}',
  '',
  'data: {"p":"response/fragments/-1/content","v":"鸡"}',
  '',
  'data: {"v":"有23只"}',
  '',
  'data: {"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"FINISHED"}]}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
].join('\n\n') + '\n\n';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// 1. Text-level decode (what parseSSEChunk does in the upstream tests).
{
  const summary = createDeepSeekStreamSummary();
  const reasoning = [];
  consumeDeepSeekSseEvents(parseSSEChunk(SSE), summary, {
    onReasoningChunk: (delta, full) => reasoning.push({ delta, full }),
  });

  assert(summary.assistantText === '设鸡有23只', `text mismatch: ${JSON.stringify(summary.assistantText)}`);
  assert(summary.assistantReasoningText === '我们使用经典的', `reasoning mismatch: ${JSON.stringify(summary.assistantReasoningText)}`);
  assert(summary.responseMessageId === 6, `responseMessageId: ${summary.responseMessageId}`);
  assert(summary.requestMessageId === 5, `requestMessageId: ${summary.requestMessageId}`);
  assert(summary.finished === true, 'stream should be finished');
  assert(reasoning.map((c) => c.delta).join('|') === '我们|使用|经典的', `reasoning deltas: ${JSON.stringify(reasoning)}`);
  console.log('SSE_TEXT_OK text=%j reasoning=%j ids=%d/%d', summary.assistantText, summary.assistantReasoningText, summary.requestMessageId, summary.responseMessageId);
}

// 2. Byte-level decode, chunked mid-multibyte, exactly as the live transport feeds it.
{
  const bytes = new TextEncoder().encode(SSE);
  const decoder = createDeepSeekSseByteDecoder();
  const summary = createDeepSeekStreamSummary();
  const deltas = [];

  // 7 is prime and lands inside multi-byte CJK sequences.
  for (let offset = 0; offset < bytes.length; offset += 7) {
    const slice = bytes.subarray(offset, Math.min(offset + 7, bytes.length));
    const delta = consumeDeepSeekSseEvents(decoder.push(slice), summary);
    if (delta) deltas.push(delta);
  }
  const tail = consumeDeepSeekSseEvents(decoder.finish(), summary);
  if (tail) deltas.push(tail);

  assert(summary.assistantText === '设鸡有23只', `chunked text mismatch: ${JSON.stringify(summary.assistantText)}`);
  assert(summary.assistantReasoningText === '我们使用经典的', `chunked reasoning mismatch: ${JSON.stringify(summary.assistantReasoningText)}`);
  assert(summary.finished === true, 'chunked stream should be finished');
  console.log('SSE_BYTE_OK deltas=%d text=%j', deltas.length, summary.assistantText);
}

console.log('\nVENDOR_CODEC_OK');
