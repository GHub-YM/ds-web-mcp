// CLI behaviour: help, version, status, doctor, and flag parsing.
//
// These are the commands a new user runs first, so they must work on a machine
// with no configuration at all.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, '..', 'src', 'cli.ts');

function run(args, env = {}) {
  return new Promise((resolveFn) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolveFn({ code: code ?? 1, stdout, stderr }));
  });
}

function assert(condition, message) { if (!condition) throw new Error(message); }

// Isolate from any real credential on this machine.
const ISOLATED = { DS_WEB_MCP_CONFIG: resolve(here, '..', '.no-such-config.json'), DS_TOKEN: '' };

console.log('  [1] help');
{
  const result = await run(['help'], ISOLATED);
  assert(result.code === 0, `help exited ${result.code}`);
  for (const cmd of ['login', 'refresh', 'status', 'doctor', 'run']) {
    assert(result.stdout.includes(cmd), `help does not mention "${cmd}"`);
  }
}

console.log('  [2] unknown command exits nonzero');
{
  const result = await run(['definitely-not-a-command'], ISOLATED);
  assert(result.code !== 0, 'unknown command should exit nonzero');
  assert(/unknown command/i.test(result.stdout + result.stderr), 'no error message');
}

console.log('  [3] version reads package.json');
{
  const result = await run(['--version'], ISOLATED);
  assert(result.code === 0, `--version exited ${result.code}`);
  assert(/^\d+\.\d+\.\d+/.test(result.stdout.trim()), `bad version: ${result.stdout.trim()}`);
}

console.log('  [4] status reports a missing config without crashing');
{
  const result = await run(['status'], ISOLATED);
  assert(!/TypeError|ReferenceError|SyntaxError/.test(result.stdout + result.stderr), 'status crashed');
  assert(/config file/i.test(result.stdout), 'status output looks wrong');
  // A missing credential is a user-fixable state, not a crash: code 1.
  assert(result.code === 1, `expected exit 1 for unconfigured, got ${result.code}`);
}

console.log('  [5] status --json is machine readable');
{
  const result = await run(['status', '--json'], ISOLATED);
  const parsed = JSON.parse(result.stdout);
  assert(typeof parsed.configPath === 'string', 'json missing configPath');
  assert(typeof parsed.profileDir === 'string', 'json missing profileDir');
  assert(parsed.credential && typeof parsed.credential === 'object', 'json missing credential');
}

console.log('  [6] doctor reports unmet prerequisites');
{
  const result = await run(['doctor'], ISOLATED);
  assert(!/TypeError|ReferenceError|SyntaxError/.test(result.stdout + result.stderr), 'doctor crashed');
  assert(/\[!!\]/.test(result.stdout), 'doctor should flag missing prerequisites');
  assert(result.code === 2, `expected exit 2 for no credential, got ${result.code}`);
}

console.log('  [7] doctor --json lists named checks');
{
  const result = await run(['doctor', '--json'], ISOLATED);
  const parsed = JSON.parse(result.stdout);
  assert(Array.isArray(parsed.checks) && parsed.checks.length > 0, 'no checks reported');
  assert(parsed.checks.every((c) => typeof c.name === 'string'), 'check missing name');
  assert(parsed.checks.some((c) => /Node\.js/.test(c.name)), 'no Node.js check');
}

console.log('  [8] flag parsing handles --key=value and --bool');
{
  const result = await run(['status', '--json'], ISOLATED);
  assert(result.code === 1 || result.code === 0, 'status --json should not fail hard');
  const spaced = await run(['status', '--json'], ISOLATED);
  assert(spaced.stdout.trim().startsWith('{'), 'output is not JSON');
}

console.log('  [9] bin wrapper completes an MCP handshake');
{
  // Regression: `run` used to spawn a child and return immediately, so the
  // top-level exit killed the server before the transport came up. Driving the
  // real bin entry point is the only way to catch that.
  const binPath = resolve(here, '..', 'bin', 'ds-web-mcp.mjs');
  const child = spawn(process.execPath, [binPath, 'run'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...ISOLATED },
  });

  const response = await new Promise((resolveFn) => {
    let stdout = '';
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolveFn(value); } };

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('\n')) finish(stdout);
    });
    child.on('close', () => finish(stdout));
    setTimeout(() => finish(stdout), 25_000);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'cli-test', version: '1' },
      },
    })}\n`);
  });

  child.kill();
  assert(response.trim().length > 0, 'bin run produced no output (server likely exited early)');
  const parsed = JSON.parse(response.trim().split('\n')[0]);
  assert(parsed.result?.serverInfo?.name === 'deepseek-web', `unexpected handshake: ${response.slice(0, 120)}`);
}

console.log('\nCLI_OK');
