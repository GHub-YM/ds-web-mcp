// Test suite runner.
//
//   node tests/run-all.mjs           offline suite (no network)
//   node tests/run-all.mjs --live    adds probes against the real service
//   node tests/run-all.mjs --authed  adds tests needing a signed-in profile
//   node tests/run-all.mjs --all     everything
//
// Exit codes: 0 pass (skips allowed), 1 failure, 2 infrastructure problem.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const live = argv.includes('--live') || argv.includes('--all');
const authed = argv.includes('--authed') || argv.includes('--all');

/** Exit code a test uses to report "prerequisite missing", not failure. */
const SKIP_CODE = 77;

const offline = [
  'handshake.mjs',
  'cli.test.mjs',
  'config-reload.test.mjs',
  'pow.test.mjs',
  'stream.test.mjs',
  'config-unwrap.test.mjs',
  'fingerprint.test.mjs',
  'e2e.mjs',
  'upload-e2e.mjs',
  'auth-failure.test.mjs',
];

const liveTests = [
  'live-probe.mjs',
  'live-control.mjs',
  'live-classify.mjs',
  'live-completion-guard.mjs',
  'live-guard-hybrid.mjs',
];

const authedTests = [
  'live-smoke.mjs',
  'live-mcp-e2e.mjs',
  'self-heal.mjs',
];

// Helper scripts and fixtures shipped with the suite, not assertions.
const helpers = new Set([
  'run-all.mjs',
  'analyze-lifetime.mjs',
  'inspect-cookies.mjs',
]);

// Fail loudly on an unregistered test file, so new tests cannot be silently
// left out of CI.
const known = new Set([...offline, ...liveTests, ...authedTests, ...helpers]);
const unknown = readdirSync(testsDir).filter((f) => f.endsWith('.mjs') && !known.has(f));
if (unknown.length) {
  console.error(`[!] unregistered test file(s): ${unknown.join(', ')}`);
  console.error('    Register them in tests/run-all.mjs, or list them in "helpers".');
  process.exit(2);
}

const selected = [
  ...offline,
  ...(live ? liveTests : []),
  ...(authed ? authedTests : []),
];

const results = [];

for (const test of selected) {
  const started = Date.now();
  const result = await new Promise((resolveFn) => {
    const child = spawn(process.execPath, [resolve(testsDir, test)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    child.on('close', (code) => resolveFn({ code: code ?? 1, output, ms: Date.now() - started }));
  });

  const skipped = result.code === SKIP_CODE;
  const passed = result.code === 0;
  const label = passed ? '[ok]  ' : skipped ? '[skip]' : '[FAIL]';
  results.push({ test, passed, skipped, ms: result.ms });

  console.log(`${label} ${test.padEnd(26)} ${String(result.ms).padStart(7)}ms`);
  if (!passed && !skipped) {
    console.log(result.output.trim().split('\n').map((l) => `       ${l}`).join('\n'));
  } else if (skipped) {
    const reason = result.output.trim().split('\n')[0] ?? '';
    console.log(`       ${reason}`);
  }
}

const failed = results.filter((r) => !r.passed && !r.skipped);
const skipped = results.filter((r) => r.skipped).length;
const passed = results.filter((r) => r.passed).length;

console.log(`\n${passed} passed, ${skipped} skipped, ${failed.length} failed`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((f) => f.test).join(', ')}`);
  process.exit(1);
}
console.log('ALL_TESTS_OK');
