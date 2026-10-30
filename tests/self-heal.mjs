// Automatic token self-healing.
//
// Corrupts the stored credential, then asserts the MCP server recovers by
// silently re-capturing from the signed-in browser profile. This is the exact
// failure a user hits when the token expires.
//
// Requires a signed-in profile. Exits 77 (skip) when the prerequisite is absent,
// so the suite stays green on a fresh checkout.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = 77;
const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');

// The server writes healed credentials to the canonical path, so seed that path
// from whichever file the loader currently resolves and exercise it directly.
const canonicalConfig = process.env.DS_WEB_MCP_CONFIG ?? join(homedir(), '.ds-web-mcp.json');
const legacyConfig = join(homedir(), '.deepseek-web-mcp.json');
const profileDir = process.env.DS_CHROME_PROFILE ?? join(homedir(), '.ds-web-mcp-chrome');
const legacyProfileDir = join(homedir(), '.deepseek-web-mcp-chrome');

const profile = existsSync(profileDir) ? profileDir
  : existsSync(legacyProfileDir) ? legacyProfileDir
    : null;

if (!profile) {
  console.log(`SKIP: no browser profile at ${profileDir} (run "ds-web-mcp login")`);
  process.exit(SKIP);
}

const seedPath = existsSync(canonicalConfig) ? canonicalConfig
  : existsSync(legacyConfig) ? legacyConfig
    : null;
if (!seedPath) {
  console.log('SKIP: no config found (run "ds-web-mcp login")');
  process.exit(SKIP);
}

function assert(condition, message) { if (!condition) throw new Error(message); }

// --- 1. Corrupt the credential at the canonical path -----------------------
const seedContent = readFileSync(seedPath, 'utf8');
const canonicalExisted = existsSync(canonicalConfig);
const canonicalBackup = canonicalExisted ? readFileSync(canonicalConfig, 'utf8') : null;

const parsed = JSON.parse(seedContent);
const originalToken = parsed.token;
assert(typeof originalToken === 'string' && originalToken.length > 0, 'no token to corrupt');

parsed.token = 'x'.repeat(64);
writeFileSync(canonicalConfig, `${JSON.stringify(parsed, null, 2)}\n`);
console.log(`corrupted token in ${canonicalConfig} (was ${originalToken.length} chars)`);

// --- 2. Drive the server ---------------------------------------------------
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const fn = pending.get(message.id);
    if (fn) { pending.delete(message.id); fn(message); }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolveFn, rejectFn) => {
    pending.set(id, resolveFn);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => rejectFn(new Error(`${method} timed out`)), 240_000);
  });
}

let exitCode = 0;
try {
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'self-heal', version: '0.0.1' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  console.log('\n=== call diagnose with a corrupted token =***');
  const started = Date.now();
  const diag = await send('tools/call', { name: 'diagnose', arguments: {} });
  const diagText = diag.result.content[0].text;
  console.log(`  elapsed=${Date.now() - started}ms  isError=${diag.result.isError === true}`);
  console.log(`  ${diagText.replace(/\n/g, '\n  ').slice(0, 260)}`);

  assert(!diag.result.isError, `diagnose did not self-heal: ${diagText}`);
  assert(/credential accepted/i.test(diagText), 'diagnose did not report acceptance');
  console.log('  -> recovered silently');

  console.log('\n=== call web_search after recovery ===');
  const search = await send('tools/call', {
    name: 'web_search',
    arguments: { query: 'Reply with exactly: recovery confirmed' },
  });
  const searchText = search.result.content[0].text;
  console.log(`  isError=${search.result.isError === true}  length=${searchText.length}`);
  assert(!search.result.isError, `web_search failed after recovery: ${searchText.slice(0, 160)}`);

  const healed = JSON.parse(readFileSync(canonicalConfig, 'utf8'));
  assert(healed.token.length === originalToken.length, `unexpected token length ${healed.token.length}`);
  assert(healed.token !== 'x'.repeat(64), 'config still holds the corrupted token');

  // The heal must land on the canonical path, not leave a stale legacy file in
  // charge. Preserve the redirect expectations the loader documents.
  console.log(`  healed config: ${canonicalConfig}`);

  console.log('\nSELF_HEAL_OK');
} catch (error) {
  console.error(`\n[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  // Restore the machine to its pre-test state either way.
  try {
    if (canonicalBackup !== null) writeFileSync(canonicalConfig, canonicalBackup);
    else if (existsSync(canonicalConfig)) writeFileSync(canonicalConfig, seedContent);
  } catch { /* best effort */ }
  child.kill();
}

process.exit(exitCode);
