// Structural analysis of the captured DeepSeek bearer token.
//
// Goal: determine whether the credential carries its own expiry, and whether
// any long-lived refresh material exists alongside it. Values are decoded for
// shape only (lengths, field names, numeric ranges) — never printed raw.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const candidates = [
  process.env.DS_WEB_MCP_CONFIG,
  join(homedir(), '.ds-web-mcp.json'),
  join(homedir(), '.deepseek-web-mcp.json'),
].filter(Boolean);

const configPath = candidates.find((p) => existsSync(p));
if (!configPath) {
  console.error('[!] No config found. Run "ds-web-mcp login" first.');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const token = config.token;

console.log('=== bearer token shape ===');
console.log(`  length      : ${token.length}`);
console.log(`  charset     : ${/^[A-Za-z0-9_-]+$/.test(token) ? 'base64url (no padding)' : 'other'}`);
console.log(`  has dots    : ${token.includes('.')}`);

const bytes = Buffer.from(token, 'base64url');
console.log(`  decodes as  : ${bytes.length} bytes (base64url)`);

// Is it printable text (a JSON blob or uuid) or random bytes?
const asText = bytes.toString('utf8');
const printable = /^[\x20-\x7e]+$/.test(asText);
console.log(`  printable   : ${printable ? 'yes' : 'no (opaque/encrypted)'}`);
if (printable) {
  console.log(`  as text     : ${asText.slice(0, 60)}${asText.length > 60 ? '…' : ''}`);
}

// Look for an embedded unix timestamp (seconds or milliseconds) in either the
// raw bytes or the decoded text.
const nowSec = Math.floor(Date.now() / 1000);
console.log(`\n=== embedded timestamp scan (now = ${nowSec}) ===`);
const candidates = [];
for (let i = 0; i + 8 <= bytes.length; i += 1) {
  const big = bytes.readBigUInt64BE(i);
  const num = Number(big);
  if (num > 1_600_000_000 && num < 2_100_000_000) {
    candidates.push({ offset: i, kind: 'unix seconds BE', value: num, iso: new Date(num * 1000).toISOString() });
  }
  if (num > 1_600_000_000_000 && num < 2_100_000_000_000) {
    candidates.push({ offset: i, kind: 'unix millis BE', value: num, iso: new Date(num).toISOString() });
  }
}
if (candidates.length === 0) console.log('  none found in token bytes');
for (const c of candidates) console.log(`  offset ${c.offset} ${c.kind} -> ${c.iso}`);

// Hex dump header for manual inspection of structure.
console.log(`\n=== first 24 bytes (hex) ===`);
console.log(`  ${[...bytes.subarray(0, 24)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);

console.log(`\n=== cookie shape ===`);
for (const part of (config.cookie ?? '').split(';')) {
  const [name, ...rest] = part.trim().split('=');
  const value = rest.join('=');
  if (!name) continue;
  console.log(`  ${name.padEnd(38)} ${String(value.length).padStart(4)} chars`);
}

console.log('\n=== verdict ===');
console.log(candidates.length
  ? '  token appears to embed an expiry; see ISO timestamps above'
  : '  token is opaque with no readable expiry — lifetime must be observed empirically');
