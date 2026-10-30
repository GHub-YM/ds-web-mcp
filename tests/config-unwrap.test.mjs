// Regression test for the userToken envelope bug.
//
// Live finding: localStorage["userToken"] is {"value":"<64-char>","__version":"1"}.
// Sending the raw 92-char envelope as the bearer is rejected with code 40003.
// The config layer must unwrap it.
import { unwrapUserToken } from '../src/config.ts';

function assert(condition, message) { if (!condition) throw new Error(message); }

const CASES = [
  {
    name: 'live envelope shape',
    input: JSON.stringify({ value: 'c'.repeat(64), __version: '1' }),
    expected: 'c'.repeat(64),
  },
  {
    name: 'envelope with token key',
    input: JSON.stringify({ token: 't'.repeat(50) }),
    expected: 't'.repeat(50),
  },
  {
    name: 'envelope prefers value',
    input: JSON.stringify({ value: 'primary', token: 'secondary' }),
    expected: 'primary',
  },
  {
    name: 'bare opaque token passes through',
    input: 'x'.repeat(64),
    expected: 'x'.repeat(64),
  },
  {
    name: 'whitespace is trimmed',
    input: '  y'.repeat(1) + 'y'.repeat(30) + '  ',
    expected: 'y'.repeat(31),
  },
  {
    name: 'braced but invalid JSON falls through as opaque',
    input: '{not-json',
    expected: '{not-json',
  },
  {
    name: 'empty object has no credential',
    input: '{}',
    expected: '{}',
  },
  {
    name: 'null-ish values',
    input: null,
    expected: null,
  },
  {
    name: 'empty string',
    input: '',
    expected: null,
  },
];

for (const testCase of CASES) {
  const actual = unwrapUserToken(testCase.input);
  assert(
    actual === testCase.expected,
    `${testCase.name}: expected ${JSON.stringify(testCase.expected)}, got ${JSON.stringify(actual)}`,
  );
  console.log(`  [ok] ${testCase.name}`);
}

// The exact failure mode observed live: a 92-char envelope must never be the
// value handed to the Authorization header.
{
  const envelope = JSON.stringify({ value: 'z'.repeat(64), __version: '1' });
  assert(envelope.length === 92, `fixture should be 92 chars, got ${envelope.length}`);
  const unwrapped = unwrapUserToken(envelope);
  assert(unwrapped.length === 64, `unwrapped should be 64 chars, got ${unwrapped.length}`);
  assert(!unwrapped.includes('__version'), 'envelope metadata leaked into the credential');
  console.log('  [ok] live 92-char envelope -> 64-char bearer');
}

console.log('\nTOKEN_UNWRAP_OK');
