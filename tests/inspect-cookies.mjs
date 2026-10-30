// Read cookie lifetimes from the debug Chrome profile.
//
// Answers: how long does the *browser* session last? That upper-bounds how long
// an automatic token re-capture can keep working without a human logging in.
// Only names and expiry metadata are reported; cookie values are never read.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const profile = process.argv[2]
  ?? process.env.DS_CHROME_PROFILE
  ?? join(homedir(), '.ds-web-mcp-chrome');
const legacyProfile = join(homedir(), '.deepseek-web-mcp-chrome');
const profileDir = existsSync(join(profile, 'Default', 'Network', 'Cookies'))
  ? profile
  : existsSync(join(legacyProfile, 'Default', 'Network', 'Cookies'))
    ? legacyProfile
    : profile;
const dbPath = join(profileDir, 'Default', 'Network', 'Cookies');

if (!existsSync(dbPath)) {
  console.error(`[!] no cookie database at ${dbPath}`);
  process.exit(1);
}

// Chrome holds an exclusive lock; work on a copy.
const copy = join(process.env.TEMP ?? '.', `ds-cookies-${Date.now()}.db`);
copyFileSync(dbPath, copy);

const db = new DatabaseSync(copy, { readBigInts: true });
const rows = db.prepare(
  `SELECT host_key, name, expires_utc, is_secure, is_httponly, has_expires
   FROM cookies
   WHERE host_key LIKE '%deepseek%'
   ORDER BY name`,
).all();
db.close();

const now = Date.now();
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000; // 1601-01-01 -> 1970-01-01

console.log('=== deepseek cookies in debug profile ===\n');
console.log(`${'name'.padEnd(44)} ${'httpOnly'.padEnd(9)} ${'expires'}`);
console.log('-'.repeat(90));

let sessionMax = 0;

for (const row of rows) {
  let expiryText;
  if (!row.has_expires || !row.expires_utc) {
    expiryText = 'session-only (until browser closes)';
  } else {
    const ms = Number(BigInt(row.expires_utc) / 1000n) - CHROME_EPOCH_OFFSET_MS;
    const days = (ms - now) / 86_400_000;
    if (days <= 0) {
      expiryText = `EXPIRED ${Math.abs(days).toFixed(1)} days ago`;
    } else {
      expiryText = `${days.toFixed(1)} days (${new Date(ms).toISOString().slice(0, 10)})`;
      if (row.name === 'ds_session_id') sessionMax = days;
    }
  }
  console.log(
    `${String(row.name).padEnd(44)} ${(row.is_httponly ? 'yes' : 'no').padEnd(9)} ${expiryText}`,
  );
}

console.log('\n=== verdict ===');
console.log(sessionMax > 0
  ? `  browser-side session (ds_session_id) outlives the API token by ~${sessionMax.toFixed(0)} days`
  : '  no persistent session cookie found — the login may rely on localStorage only');

process.stdout.write('');
try { (await import('node:fs')).unlinkSync(copy); } catch { /* best effort */ }
