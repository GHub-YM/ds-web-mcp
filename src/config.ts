import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findBrowser } from './browser.ts';
import { detectChromeVersion, type FingerprintMode, type HttpProtocolMode } from './fingerprint.ts';

export interface DsConfig {
  /** DeepSeek web bearer token: the inner `value` of localStorage `userToken`. */
  token: string;
  /** Raw Cookie header for chat.deepseek.com. */
  cookie?: string;
  /** Value sent as x-device-id. */
  deviceId?: string;
  /** Value sent as x-client-version. */
  appVersion: string;
  locale: string;
  timezoneOffset: string;
  /** Wall-clock budget for one completion turn. */
  timeoutMs: number;
  /** Route origin override; defaults to https://chat.deepseek.com. Test/proxy use only. */
  baseUrl: string;
  /** Browser fingerprint to present. `chrome` is the default; `off` is the old Node shape. */
  fingerprint: FingerprintMode;
  /** Platform token for the fingerprint preset. */
  fingerprintPlatform: string;
  /** Chrome version advertised in UA and client hints; `auto` detects the installed Chrome. */
  chromeVersion: string;
  /** Full User-Agent override. Escape hatch for a UA this profile cannot build. */
  userAgent?: string;
  /** Transport protocol: `auto` (h2 for https), `h2`, or `http1`. */
  httpProtocol: HttpProtocolMode;
}

// Observed live from chat.deepseek.com request headers.
export const DEFAULT_APP_VERSION = '2.5.0';
export const DEFAULT_LOCALE = 'zh_CN';
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_BASE_URL = 'https://chat.deepseek.com';
export const CLIENT_BUNDLE_ID = 'com.deepseek.chat';
export const DEFAULT_FINGERPRINT: FingerprintMode = 'chrome';
export const DEFAULT_FINGERPRINT_PLATFORM = 'win';
export const DEFAULT_HTTP_PROTOCOL: HttpProtocolMode = 'auto';

export const CONFIG_PATH = process.env.DS_WEB_MCP_CONFIG
  ?? join(homedir(), '.ds-web-mcp.json');

/**
 * Config path used by releases before the package was renamed. Reading it keeps
 * an existing setup working across the upgrade instead of silently losing the
 * saved login.
 */
export const LEGACY_CONFIG_PATH = join(homedir(), '.deepseek-web-mcp.json');

export class DsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DsConfigError';
  }
}

/**
 * `localStorage.userToken` is a JSON envelope, not the bearer value itself:
 *
 *   {"value":"<64-char credential>","__version":"1"}
 *
 * Observed live: the real `authorization` payload is the inner `value`. Sending
 * the raw 92-char envelope as the bearer is rejected with code 40003.
 *
 * Tokens may arrive already unwrapped (hand-copied, or written by the CLI), so
 * this is idempotent: a bare value passes through unchanged.
 */
export function unwrapUserToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ['value', 'token', 'accessToken', 'access_token']) {
        const inner = parsed?.[key];
        if (typeof inner === 'string' && inner.trim()) return inner.trim();
      }
    } catch {
      // Braced but not JSON; treat it as an opaque value below.
    }
  }

  return trimmed;
}

/**
 * Resolution order: environment variables, then the config file.
 * The token is never logged; callers must treat every value here as a secret.
 *
 * These settings are independent of credentials on purpose: `doctor` and
 * `fingerprint` must be able to describe fingerprint posture on a fresh install
 * where no login exists yet. Use `loadConfig` when a token is actually required.
 */
export function loadSettings(): Omit<DsConfig, 'token'> & { token: string | null } {
  const file = readConfigFile();
  const token = unwrapUserToken(process.env.DS_TOKEN?.trim() || file.token);

  const cookie = process.env.DS_COOKIE?.trim() || file.cookie;

  const fingerprint = readFingerprintMode(process.env.DS_FINGERPRINT) ?? file.fingerprint ?? DEFAULT_FINGERPRINT;
  const httpProtocol = readHttpProtocol(process.env.DS_HTTP_PROTOCOL) ?? file.httpProtocol ?? DEFAULT_HTTP_PROTOCOL;

  return {
    token,
    cookie,
    deviceId: process.env.DS_DEVICE_ID?.trim() || file.deviceId,
    appVersion: process.env.DS_APP_VERSION?.trim() || file.appVersion || DEFAULT_APP_VERSION,
    locale: process.env.DS_LOCALE?.trim() || file.locale || DEFAULT_LOCALE,
    timezoneOffset: process.env.DS_TZ_OFFSET?.trim()
      || file.timezoneOffset
      || String(-new Date().getTimezoneOffset() * 60),
    timeoutMs: readPositiveInt(process.env.DS_TIMEOUT_MS) ?? file.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    baseUrl: process.env.DS_BASE_URL?.trim() || file.baseUrl || DEFAULT_BASE_URL,
    fingerprint,
    fingerprintPlatform: process.env.DS_FINGERPRINT_PLATFORM?.trim()
      || file.fingerprintPlatform
      || DEFAULT_FINGERPRINT_PLATFORM,
    chromeVersion: process.env.DS_CHROME_VERSION?.trim()
      || file.chromeVersion
      || detectChromeVersion(findBrowser()?.path)
      || '',
    userAgent: process.env.DS_USER_AGENT?.trim() || file.userAgent,
    httpProtocol,
  };
}

/**
 * Full config for a real request. Throws when no credential is available, so
 * callers either catch it (diagnostics) or let it surface (the server).
 */
export function loadConfig(): DsConfig {
  const settings = loadSettings();
  if (!settings.token) {
    throw new DsConfigError(
      'DeepSeek web token is missing. Run "ds-web-mcp login", or set DS_TOKEN, '
      + `or put {"token":"<value>"} in ${CONFIG_PATH}.`,
    );
  }
  return { ...settings, token: settings.token };
}

function readFingerprintMode(value: string | undefined): FingerprintMode | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'chrome' || normalized === 'off') return normalized;
  return null;
}

function readHttpProtocol(value: string | undefined): HttpProtocolMode | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'h2' || normalized === 'http1') return normalized;
  return null;
}

export function configPath(): string {
  return CONFIG_PATH;
}

/**
 * True when two loaded configs would produce equivalent clients.
 *
 * Compared field-by-field rather than by file fingerprint: modification-time
 * granularity is coarse on some filesystems, so a same-length token swap could
 * otherwise go unnoticed.
 */
export function configsMatch(a: DsConfig | null, b: DsConfig | null): boolean {
  if (!a || !b) return a === b;
  return a.token === b.token
    && a.cookie === b.cookie
    && a.deviceId === b.deviceId
    && a.appVersion === b.appVersion
    && a.locale === b.locale
    && a.timezoneOffset === b.timezoneOffset
    && a.timeoutMs === b.timeoutMs
    && a.baseUrl === b.baseUrl
    && a.fingerprint === b.fingerprint
    && a.fingerprintPlatform === b.fingerprintPlatform
    && a.chromeVersion === b.chromeVersion
    && a.userAgent === b.userAgent
    && a.httpProtocol === b.httpProtocol;
}

interface PartialConfig {
  token?: string;
  cookie?: string;
  deviceId?: string;
  appVersion?: string;
  locale?: string;
  timezoneOffset?: string;
  timeoutMs?: number;
  baseUrl?: string;
  fingerprint?: FingerprintMode;
  fingerprintPlatform?: string;
  chromeVersion?: string;
  userAgent?: string;
  httpProtocol?: HttpProtocolMode;
}

function readConfigFile(): PartialConfig {
  const primary = readJsonFile(CONFIG_PATH);
  if (primary) return primary;
  // Fall back to the pre-rename location when the current path is absent.
  if (!process.env.DS_WEB_MCP_CONFIG) {
    const legacy = readJsonFile(LEGACY_CONFIG_PATH);
    if (legacy) return legacy;
  }
  return {};
}

function readJsonFile(path: string): PartialConfig | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DsConfigError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DsConfigError(`${path} must contain a JSON object.`);
  }
  return parsed as PartialConfig;
}

function readPositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}
