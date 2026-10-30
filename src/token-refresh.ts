// Automatic DeepSeek credential re-capture.
//
// chat.deepseek.com's bearer token is short-lived, but the browser profile keeps
// a durable login (verified: a fully closed and relaunched Chromium restores the
// session and yields a usable token). That makes silent re-capture possible
// without a human — this module is the mechanism.
//
// It launches a throwaway headless browser against the dedicated profile, lets
// the page restore its own session, and reads the current bearer value.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dedicatedProfileDir, findBrowser } from './browser.ts';

/** The logged-out placeholder value observed on the sign-in page. */
const ANON_TOKEN_LENGTH = 30;

export type RefreshFailureReason =
  | 'login_expired'
  | 'browser_missing'
  | 'no_profile'
  | 'timeout';

export interface RefreshOptions {
  /** Browser profile holding the logged-in session. */
  profileDir?: string;
  /** Debug port; must not collide with an already-running debug instance. */
  port?: number;
  /** Total budget for launch + page read. */
  timeoutMs?: number;
}

export class TokenRefreshError extends Error {
  readonly reason: RefreshFailureReason;

  constructor(message: string, reason: RefreshFailureReason) {
    super(message);
    this.name = 'TokenRefreshError';
    this.reason = reason;
  }

  /** True when no amount of retrying will help and a human must sign in. */
  get needsHuman(): boolean {
    return this.reason === 'login_expired' || this.reason === 'no_profile';
  }
}

/**
 * `localStorage.userToken` is a JSON envelope; the bearer is the inner `value`.
 * Kept in sync with config.ts.
 */
export function unwrapUserToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ['value', 'token', 'accessToken', 'access_token']) {
        const inner = parsed?.[key];
        if (typeof inner === 'string' && inner.trim()) return inner.trim();
      }
    } catch {
      // Braced but not JSON; fall through and treat it as opaque.
    }
  }
  return trimmed;
}

/**
 * Reads the current bearer token out of the logged-in browser profile.
 * Throws TokenRefreshError when a human login is genuinely required.
 */
export async function refreshTokenFromBrowser(options: RefreshOptions = {}): Promise<string> {
  const profileDir = options.profileDir
    ?? process.env.DS_CHROME_PROFILE
    ?? dedicatedProfileDir();
  const port = options.port ?? Number(process.env.DS_CHROME_DEBUG_PORT ?? 9334);
  const timeoutMs = options.timeoutMs ?? 90_000;

  const browser = findBrowser();
  if (!browser) {
    throw new TokenRefreshError(
      'No Chromium-family browser found, so the DeepSeek token cannot be refreshed '
      + 'automatically. Set DS_BROWSER to the browser executable, or refresh manually.',
      'browser_missing',
    );
  }
  if (!existsSync(profileDir)) {
    throw new TokenRefreshError(
      `No browser profile at ${profileDir}. Run "ds-web-mcp login" once to sign in.`,
      'no_profile',
    );
  }

  const child = spawn(browser.path, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    'https://chat.deepseek.com',
  ], { stdio: 'ignore' });

  try {
    if (!await waitForCdp(port, Math.min(30_000, timeoutMs))) {
      throw new TokenRefreshError('The browser did not expose its debug port.', 'timeout');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raw = await readUserToken(port);
      if (raw) {
        const bearer = unwrapUserToken(raw);
        if (bearer && bearer.length > ANON_TOKEN_LENGTH + 8) return bearer;
        throw new TokenRefreshError(
          'The browser profile is no longer signed in. Run "ds-web-mcp login" to sign in again.',
          'login_expired',
        );
      }
      await sleep(1_500);
    }

    throw new TokenRefreshError('Timed out reading the token from the page.', 'timeout');
  } finally {
    child.kill();
    await sleep(600);
  }
}

async function waitForCdp(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await sleep(400);
  }
  return false;
}

async function readUserToken(port: number): Promise<string | null> {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(5_000),
    })).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;

    const page = targets.find((t) => t.type === 'page' && t.url.includes('deepseek.com'));
    if (!page) return null;

    return await evaluate(page.webSocketDebuggerUrl, `window.localStorage.getItem('userToken')`);
  } catch {
    return null;
  }
}

function evaluate(wsUrl: string, expression: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl);
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closing */ }
      resolve(value);
    };

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      finish(message.result?.result?.value ?? null);
    });
    socket.addEventListener('error', () => finish(null));
    setTimeout(() => finish(null), 15_000);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
