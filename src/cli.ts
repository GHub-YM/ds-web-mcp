#!/usr/bin/env node
// ds-web-mcp command line.
//
//   ds-web-mcp login    [--browser <path>]   sign in and save credentials
//   ds-web-mcp refresh                        re-capture the token silently
//   ds-web-mcp status                         show config + credential health
//   ds-web-mcp doctor                         check environment prerequisites
//   ds-web-mcp run                            run the MCP server on stdio
//
// `run` is what an MCP client launches; the rest are setup and diagnostics.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  browserCandidates,
  dedicatedProfileDir,
  findBrowser,
} from './browser.ts';
import { CONFIG_PATH, configPath, loadConfig, loadSettings, unwrapUserToken } from './config.ts';
import {
  CHROME_CIPHERS,
  CHROME_CONNECTION_WINDOW,
  CHROME_HTTP2_SETTINGS,
  TLS_GAPS,
  createFingerprintProfile,
  detectChromeVersion,
  resolveEcdhCurve,
} from './fingerprint.ts';
import { refreshTokenFromBrowser, TokenRefreshError } from './token-refresh.ts';

/**
 * The logged-out placeholder DeepSeek stores in `localStorage.userToken`.
 * Anything at or below this length is the anonymous value, not a session.
 * Kept in sync with token-refresh.ts.
 */
const ANON_TOKEN_LENGTH = 30;

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const flags = parseFlags(argv.slice(1));

function parseFlags(args: string[]): Map<string, string | true> {
  const map = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=');
    if (inline !== undefined) {
      map.set(name, inline);
    } else if (args[i + 1] && !args[i + 1].startsWith('--')) {
      map.set(name, args[i + 1]);
      i += 1;
    } else {
      map.set(name, true);
    }
  }
  return map;
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  switch (command) {
    case 'run': return runServer();    case 'login': return login();
    case 'refresh': return refresh();
    case 'status': return status();
    case 'doctor': return doctor();
    case 'fingerprint': return fingerprint();
    case 'help':
    case '--help':
    case '-h': return help();
    case '--version':
    case '-v': return version();
    default:
      out(`Unknown command: ${command}`);
      out('');
      return help(1);
  }
}

function help(exitCode = 0): number {
  out(`ds-web-mcp — DeepSeek web as an MCP server

Usage: ds-web-mcp <command> [options]

Commands:
  login      Sign in to chat.deepseek.com and save credentials (interactive, once)
             Opens a visible browser window; the session must be written to the
             profile on disk so automatic refresh can re-read it later.
  refresh    Re-capture the token from the saved browser profile (no interaction)
  status     Show configuration, credential shape, and profile location
  doctor     Verify environment prerequisites and credential health
  fingerprint  Show the browser fingerprint that will be presented
  run        Run the MCP server on stdio (used by MCP clients)
  help       Show this message

Options:
  --browser <path>     Browser executable to use (login/doctor)
  --keep-open          Leave the browser open after login; close it yourself
                       (use when the session will not persist automatically)
  --no-verify          Skip the post-login profile persistence check
  --json               Machine-readable output (status/doctor)
  --timeout <seconds>  Login wait budget (default 600)

Environment:
  DS_TOKEN              Bearer token; skips the browser entirely
  DS_COOKIE             Raw Cookie header for chat.deepseek.com
  DS_CHROME_PROFILE     Browser profile directory
  DS_BROWSER            Browser executable path
  DS_BASE_URL           Route origin override (testing)
  DS_TIMEOUT_MS         Per-turn request budget
  DS_NO_AUTO_REFRESH    Set to 1 to disable silent token re-capture
  DS_WEB_MCP_CONFIG     Config file path
  DS_FINGERPRINT        chrome (default) or off — the latter restores the plain Node request shape
  DS_FINGERPRINT_PLATFORM  win (default) | mac | linux
  DS_CHROME_VERSION     Chrome major version for the UA and client hints
  DS_USER_AGENT         Full User-Agent override
  DS_HTTP_PROTOCOL      auto (default) | h2 | http1

Docs: see README.md beside this package.`);
  return exitCode;
}

function version(): number {
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  try {
    out(JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown');
  } catch {
    out('unknown');
  }
  return 0;
}

// --- run --------------------------------------------------------------------

/**
 * Starts the MCP server in this process.
 *
 * Importing it in-process (rather than spawning a child) keeps the stdio
 * transport bound to the real stdin/stdout. The returned promise resolves once
 * the transport is connected; the event loop stays alive afterwards, which is
 * what keeps the server serving. The caller must therefore not force an exit.
 */
async function runServer(): Promise<number> {
  await import('./server.ts');
  return -1;
}

// --- login ------------------------------------------------------------------

function resolveBrowser(): string | null {
  const explicit = flags.get('browser');
  if (typeof explicit === 'string') return explicit;
  if (process.env.DS_BROWSER) return process.env.DS_BROWSER;
  return findBrowser()?.path ?? null;
}

async function login(): Promise<number> {
  const browser = resolveBrowser();
  if (!browser) {
    out('No Chromium-family browser found.');
    out('Install Chrome/Chromium/Edge, or pass --browser <path>.');
    return 1;
  }

  const profileDir = dedicatedProfileDir();
  mkdirSync(profileDir, { recursive: true });

  const port = Number(flags.get('port') ?? 9333);
  const timeoutSeconds = Number(flags.get('timeout') ?? 600);
  const verify = !flags.has('no-verify');
  const keepOpen = flags.has('keep-open');

  out(`browser : ${browser}`);
  out(`profile : ${profileDir}`);
  out(`config  : ${CONFIG_PATH}`);
  out('');
  out('Opening a browser window. Sign in to DeepSeek, then come back here.');
  out('Waiting for login...');
  out('');

  // No `--headless` and no throwaway profile: the login has to land in the
  // durable profile, because that is what automatic token refresh re-reads.
  const child = spawn(browser, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://chat.deepseek.com/sign_in',
  ], { stdio: 'ignore' });

  let captured: Awaited<ReturnType<typeof tryCapture>> = null;
  try {
    if (!await waitForPort(port, 30_000)) {
      out('The browser did not expose its debug port. Try again, or pass --browser.');
      return 1;
    }

    const deadline = Date.now() + timeoutSeconds * 1000;
    process.stdout.write('  waiting');
    while (Date.now() < deadline) {
      captured = await tryCapture(port);
      if (captured) break;
      process.stdout.write('.');
      await sleep(3_000);
    }

    if (!captured) {
      out('');
      out('');
      out(`Timed out after ${timeoutSeconds}s. Nothing was saved.`);
      return 2;
    }

    out('');
    out('');
    out('Captured credentials.');
    out(`  token    : ${captured.token.length} chars`);
    out(`  deviceId : ${captured.deviceId ? 'captured' : 'not found'}`);
    out(`  cookies  : ${captured.cookies.length} entries`);
    out(`  saved to : ${CONFIG_PATH}`);

    if (keepOpen) {
      out('');
      out('Leaving the browser open (--keep-open). Close it when you are done;');
      out('the session must be flushed to disk for automatic refresh to work.');
      return 0;
    }

    // Shut down gracefully so Chromium flushes localStorage (including
    // `userToken`) to the profile on disk. A kill skips that flush, which is
    // exactly how a successful login ends up leaving the profile signed out.
    out('');
    out('Closing the browser to flush the session to the profile...');
    await gracefulShutdown(port);
    await sleep(2_500);

    if (verify) {
      out('Verifying the session was persisted...');
      const persisted = await verifySessionPersisted(browser, profileDir, port + 1);
      if (!persisted) {
        out('');
        out('[!] The captured token works, but the profile still reports as signed out.');
        out('    Automatic refresh re-reads that profile, so it would fail later.');
        out('');
        out('    Retry with: ds-web-mcp login --keep-open');
        out('    Then close the browser window yourself and re-run:');
        out('      ds-web-mcp doctor');
        return 1;
      }
      out('  [ok] profile restores the signed-in session');
    }

    out('');
    out('Done. The MCP server can now be started.');
    return 0;
  } finally {
    // Only reached while the browser is still ours to close.
    if (!keepOpen) {
      try { child.kill(); } catch { /* already closed by gracefulShutdown */ }
    }
  }
}

/**
 * Asks Chromium to close itself so it writes pending state (localStorage in
 * particular) to the profile. Returns once the debug port stops answering.
 */
async function gracefulShutdown(port: number): Promise<boolean> {
  try {
    const info = await (await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(3_000),
    })).json() as { webSocketDebuggerUrl?: string };

    if (info?.webSocketDebuggerUrl) {
      await cdpSend(info.webSocketDebuggerUrl, 'Browser.close', {});
    } else {
      return false;
    }

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
      } catch {
        return true; // port gone: the browser exited
      }
      await sleep(300);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Relaunches the profile headless and checks that DeepSeek restores a real
 * session from it. This is the same path automatic refresh uses, so it is the
 * only honest way to prove the login will survive.
 */
async function verifySessionPersisted(
  browser: string,
  profileDir: string,
  port: number,
): Promise<boolean> {
  const child = spawn(browser, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'https://chat.deepseek.com/',
  ], { stdio: 'ignore' });

  try {
    if (!await waitForPort(port, 30_000)) return false;

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const raw = await readProfileUserToken(port);
      const bearer = unwrapUserToken(raw);
      if (bearer && bearer.length > ANON_TOKEN_LENGTH) return true;
      await sleep(2_000);
    }
    return false;
  } catch {
    return false;
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
}

/** Reads `localStorage.userToken` from the DeepSeek page, if one is open. */
async function readProfileUserToken(port: number): Promise<string | null> {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(5_000),
    })).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;

    const page = targets.find((t) => t.type === 'page' && t.url.includes('deepseek.com'));
    if (!page) return null;

    return await cdpEvaluate(page.webSocketDebuggerUrl, `window.localStorage.getItem('userToken')`);
  } catch {
    return null;
  }
}

async function tryCapture(port: number): Promise<{
  token: string;
  deviceId: string | null;
  cookies: Array<{ name: string; value: string }>;
} | null> {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(5_000),
    })).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;

    const page = targets.find((t) => t.type === 'page' && t.url.includes('deepseek.com'));
    if (!page) return null;

    const payload = await cdpEvaluate(page.webSocketDebuggerUrl, `(() => {
      return JSON.stringify({
        raw: window.localStorage.getItem('userToken'),
        deviceId: window.localStorage.getItem('deepseek-device-id:chat'),
      });
    })()`);
    if (!payload) return null;

    const parsed = JSON.parse(payload) as { raw: string | null; deviceId: string | null };
    const token = unwrapUserToken(parsed.raw);
    if (!token || token.length <= ANON_TOKEN_LENGTH) return null; // still the anon value

    const cookieResult = await cdpSend(page.webSocketDebuggerUrl, 'Network.getCookies', {
      urls: ['https://chat.deepseek.com'],
    });
    const cookies = (cookieResult?.cookies ?? []) as Array<{ name: string; value: string }>;
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    writeConfig({
      token,
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(parsed.deviceId ? { deviceId: parsed.deviceId } : {}),
    });

    return { token, deviceId: parsed.deviceId, cookies };
  } catch {
    return null;
  }
}

/** Merges captured values into the config file without dropping other fields. */
function writeConfig(values: Record<string, unknown>): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const merged = {
    appVersion: '2.5.0',
    locale: 'zh_CN',
    ...existing,
    ...values,
  };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* Windows may ignore POSIX modes */ }
}

// --- refresh ----------------------------------------------------------------

async function refresh(): Promise<number> {
  const checkOnly = flags.has('check') || flags.has('json');
  try {
    const token = await refreshTokenFromBrowser({
      ...(typeof flags.get('timeout') === 'string'
        ? { timeoutMs: Number(flags.get('timeout')) * 1000 }
        : {}),
    });

    let previous: string | null = null;
    try { previous = (JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { token?: string }).token ?? null; } catch { /* none */ }

    if (!checkOnly) writeConfig({ token });

    if (flags.has('json')) {
      out(JSON.stringify({ ok: true, changed: previous !== token, length: token.length }));
    } else {
      out(checkOnly ? 'Credential is valid.' : `Refreshed. token ${token.length} chars${previous === token ? ' (unchanged)' : ''}.`);
    }
    return 0;
  } catch (error) {
    if (error instanceof TokenRefreshError) {
      if (flags.has('json')) {
        out(JSON.stringify({ ok: false, reason: error.reason, message: error.message }));
      } else {
        out(`Refresh failed: ${error.message}`);
      }
      return error.needsHuman ? 2 : 1;
    }
    out(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// --- status -----------------------------------------------------------------

async function status(): Promise<number> {
  const asJson = flags.has('json');
  const report: Record<string, unknown> = {};

  report.configPath = configPath();
  report.configExists = existsSync(CONFIG_PATH);
  report.profileDir = dedicatedProfileDir();
  report.profileExists = existsSync(dedicatedProfileDir());

  const browser = findBrowser();
  report.browser = browser ? { name: browser.name, path: browser.path } : null;

  let tokenShape: Record<string, unknown> | null = null;
  try {
    const config = loadConfig();
    tokenShape = {
      length: config.token.length,
      fromEnv: Boolean(process.env.DS_TOKEN),
      hasCookie: Boolean(config.cookie),
      hasDeviceId: Boolean(config.deviceId),
      appVersion: config.appVersion,
      locale: config.locale,
      baseUrl: config.baseUrl,
    };
  } catch (error) {
    tokenShape = { error: error instanceof Error ? error.message : String(error) };
  }
  report.credential = tokenShape;
  report.autoRefresh = process.env.DS_NO_AUTO_REFRESH === '1' ? 'disabled' : 'enabled';

  if (asJson) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }

  out('ds-web-mcp status');
  out('');
  out(`  config file  : ${report.configPath}${report.configExists ? '' : '  (missing)'}`);
  out(`  profile dir  : ${report.profileDir}${report.profileExists ? '' : '  (missing - run "ds-web-mcp login")'}`);
  out(`  browser      : ${browser ? `${browser.name} (${browser.path})` : 'not found'}`);
  out(`  auto-refresh : ${report.autoRefresh}`);
  out('');
  if (tokenShape && 'error' in tokenShape) {
    out(`  credential   : ${tokenShape.error}`);
    return 1;
  }
  const t = tokenShape as Record<string, unknown>;
  out(`  token        : ${t.length} chars${t.fromEnv ? ' (from DS_TOKEN)' : ''}`);
  out(`  cookie       : ${t.hasCookie ? 'present' : 'absent'}`);
  out(`  deviceId     : ${t.hasDeviceId ? 'present' : 'absent'}`);
  out(`  app version  : ${t.appVersion}   locale: ${t.locale}`);
  return 0;
}

// --- fingerprint --------------------------------------------------------------

/**
 * Prints the browser shape that will be presented, plus the TLS details OpenSSL
 * cannot reproduce. The gaps are shown rather than hidden: claiming an exact
 * Chrome ClientHello would be wrong.
 */
async function fingerprint(): Promise<number> {
  const asJson = flags.has('json');

  // Settings only: `fingerprint` describes posture, so it must work before the
  // first login.
  let config;
  try {
    config = loadSettings();
  } catch (error) {
    out(`Cannot read config: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const browser = findBrowser();
  const detected = detectChromeVersion(browser?.path);

  if (config.fingerprint === 'off') {
    if (asJson) {
      out(JSON.stringify({ mode: 'off', note: 'Plain Node request shape: default User-Agent, no client hints.' }, null, 2));
    } else {
      out('ds-web-mcp fingerprint');
      out('');
      out('  mode : off');
      out('');
      out(`  The request is sent with Node's default User-Agent and no browser`);
      out('  headers. This is the pre-1.0 behaviour, kept for A/B comparison.');
    }
    return 0;
  }

  const profile = createFingerprintProfile({
    platform: config.fingerprintPlatform,
    ...(config.chromeVersion ? { chromeVersion: config.chromeVersion } : {}),
    ...(config.userAgent ? { userAgent: config.userAgent } : {}),
  });
  const curve = resolveEcdhCurve(profile.ecdhCurve);

  const report = {
    mode: config.fingerprint,
    platform: profile.platform,
    chromeVersion: profile.chromeVersion,
    capturedOnThisHost: profile.verified,
    detectedBrowserVersion: detected,
    protocol: config.httpProtocol,
    userAgent: profile.userAgent,
    clientHints: {
      'sec-ch-ua': profile.secChUa,
      'sec-ch-ua-mobile': profile.secChUaMobile,
      'sec-ch-ua-platform': profile.secChUaPlatform,
    },
    acceptLanguage: profile.acceptLanguage,
    acceptEncoding: profile.acceptEncoding,
    tls: { curve, ciphers: CHROME_CIPHERS.length, alpn: ['h2', 'http/1.1'] },
    http2: { settings: CHROME_HTTP2_SETTINGS, connectionWindow: CHROME_CONNECTION_WINDOW },
    knownGaps: TLS_GAPS,
  };

  if (asJson) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }

  out('ds-web-mcp fingerprint');
  out('');
  out(`  mode         : ${profile.verified ? 'chrome (values captured on this host)' : 'chrome'}`);
  out(`  platform     : ${profile.platform}`);
  out(`  chrome ver   : ${profile.chromeVersion}${detected && detected !== profile.chromeVersion ? `  (installed: ${detected})` : ''}`);
  out(`  protocol     : ${config.httpProtocol}`);
  out('');
  out(`  user-agent   : ${profile.userAgent}`);
  out(`  sec-ch-ua    : ${profile.secChUa}`);
  out(`  sec-ch-ua-mobile/platform : ${profile.secChUaMobile} ${profile.secChUaPlatform}`);
  out(`  lang / encod : ${profile.acceptLanguage}  |  ${profile.acceptEncoding}`);
  out('');
  out(`  TLS          : ALPN h2,http/1.1 | ${CHROME_CIPHERS.length} ciphers | curve ${curve ?? 'unsupported'}`);
  out(`  HTTP/2       : SETTINGS ${JSON.stringify(CHROME_HTTP2_SETTINGS)}`);
  out(`                 connection window ${CHROME_CONNECTION_WINDOW} (WINDOW_UPDATE delta ${CHROME_CONNECTION_WINDOW - 65535})`);
  out('');
  out('  Known gaps vs a real Chrome ClientHello:');
  for (const gap of TLS_GAPS) out(`    - ${gap}`);
  return 0;
}

// --- doctor -----------------------------------------------------------------

async function doctor(): Promise<number> {
  const asJson = flags.has('json');
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js >= 22',
    ok: nodeMajor >= 22,
    detail: `v${process.versions.node}${nodeMajor >= 22 ? '' : ' (upgrade required)'}`,
  });

  const browser = resolveBrowser();
  checks.push({
    name: 'Chromium-family browser',
    ok: Boolean(browser),
    detail: browser ?? 'not found (needed for login and token refresh)',
  });

  const profileDir = dedicatedProfileDir();
  checks.push({
    name: 'Browser profile',
    ok: existsSync(profileDir),
    detail: existsSync(profileDir) ? profileDir : `${profileDir} (run "ds-web-mcp login")`,
  });

  let credentialOk = false;
  let credentialDetail = 'not configured (run "ds-web-mcp login")';
  let fingerprintSettings: ReturnType<typeof loadSettings> | null = null;
  try {
    const settings = loadSettings();
    fingerprintSettings = settings;
    if (settings.token) {
      credentialDetail = `token ${settings.token.length} chars`;
      credentialOk = true;
    }
  } catch (error) {
    credentialDetail = error instanceof Error ? error.message.slice(0, 100) : String(error);
  }
  checks.push({ name: 'Credential configured', ok: credentialOk, detail: credentialDetail });

  // Fingerprint posture. This is advisory rather than pass/fail: `off` is a
  // supported choice, and a platform preset that was not captured on this host
  // is still usable — but either one is worth stating out loud. Read from
  // settings, not the credential-bearing config, so a fresh install can still
  // see what fingerprint would be presented.
  let fingerprintDetail = 'unknown';
  let fingerprintOk = true;
  try {
    const settings = fingerprintSettings ?? loadSettings();
    if (settings.fingerprint === 'off') {
      fingerprintDetail = 'disabled (DS_FINGERPRINT=off) — Node User-Agent is sent';
      fingerprintOk = true;
    } else {
      const profile = createFingerprintProfile({
        platform: settings.fingerprintPlatform,
        ...(settings.chromeVersion ? { chromeVersion: settings.chromeVersion } : {}),
        ...(settings.userAgent ? { userAgent: settings.userAgent } : {}),
      });
      const curve = resolveEcdhCurve(profile.ecdhCurve);
      fingerprintDetail = `${profile.platform} Chrome ${profile.chromeMajor}, `
        + `${profile.verified ? 'captured values' : 'derived values'}, `
        + `curve ${curve ?? 'unavailable'}, protocol ${settings.httpProtocol}`;
      // Advisory, not pass/fail: `off` and a non-captured platform are both
      // supported choices. The detail string carries the caveat instead.
      fingerprintOk = true;
    }
  } catch (error) {
    fingerprintDetail = error instanceof Error ? error.message.slice(0, 90) : String(error);
    fingerprintOk = false;
  }
  checks.push({ name: 'Browser fingerprint', ok: fingerprintOk, detail: fingerprintDetail });
  // Live check: does the service accept the token?
  let liveOk = false;
  let liveDetail = 'skipped (no credential)';
  if (credentialOk) {
    try {
      const { DeepSeekWebClient } = await import('./deepseek-client.ts');
      const client = new DeepSeekWebClient(loadConfig());
      await client.createChatSession();
      liveOk = true;
      liveDetail = 'token accepted by chat.deepseek.com';
    } catch (error) {
      liveDetail = `${error instanceof Error ? error.name : 'Error'}: `
        + `${error instanceof Error ? error.message.slice(0, 90) : String(error)}`;
    }
  }
  checks.push({ name: 'Live credential check', ok: liveOk, detail: liveDetail });

  if (asJson) {
    out(JSON.stringify({ ok: checks.every((c) => c.ok), checks }, null, 2));
  } else {
    out('ds-web-mcp doctor');
    out('');
    for (const check of checks) {
      out(`  ${check.ok ? '[ok]  ' : '[!!]  '} ${check.name.padEnd(26)} ${check.detail}`);
    }
    out('');
    const failed = checks.filter((c) => !c.ok);
    if (failed.length === 0) out('All checks passed.');
    else out(`${failed.length} check(s) need attention.`);
  }

  if (checks.every((c) => c.ok)) return 0;
  // A missing login is recoverable by the user; report it distinctly.
  return credentialOk ? 1 : 2;
}

// --- helpers ----------------------------------------------------------------

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await sleep(400);
  }
  return false;
}

function cdpEvaluate(wsUrl: string, expression: string): Promise<string | null> {
  return cdpSend(wsUrl, 'Runtime.evaluate', { expression, returnByValue: true })
    .then((result) => (result?.result?.value as string | undefined) ?? null)
    .catch(() => null);
}

function cdpSend(wsUrl: string, method: string, params: unknown): Promise<any> {
  return new Promise((resolvePromise) => {
    const socket = new WebSocket(wsUrl);
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closing */ }
      resolvePromise(value);
    };

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      finish(message.result);
    });
    socket.addEventListener('error', () => finish(null));
    setTimeout(() => finish(null), 20_000);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `run` hands control to the server, which owns the process from here on; any
// explicit exit would tear the stdio transport down.
const exitCode = await main();
if (exitCode >= 0) process.exit(exitCode);
