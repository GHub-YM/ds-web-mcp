// Browser fingerprint profile.
//
// Every literal in this file was captured from a real Chrome 153.0.8010.50 on
// Windows 11 x64 running on the development host, not copied from
// documentation:
//
//   * UA / Sec-CH-UA / Sec-CH-UA-Mobile / Sec-CH-UA-Platform, Accept-Language,
//     Accept-Encoding, Priority  -> captured over both HTTP/1.1 and HTTP/2.
//   * Header ORDER  -> captured from the HPACK header list Chrome actually put
//     on the wire, by pointing chat.deepseek.com at a local HTTP/2 listener via
//     --host-resolver-rules and recording the server-side header order.
//   * HTTP/2 SETTINGS and the connection-level WINDOW_UPDATE  -> captured from
//     the raw client preface frames.
//   * TLS ClientHello  -> captured by pointing Chrome at a bare TCP listener
//     and parsing the ClientHello record.
//
// The header order is NOT insertion order and NOT alphabetical: Chrome orders
// request headers from its own internal table. It is stable for a given header
// set, and a header that is absent simply drops out without shifting the
// others, which is what makes an ordered template a faithful model.
//
// Known-unreachable TLS details are listed in TLS_GAPS below and surfaced by
// `ds-web-mcp doctor` so the residual difference is never silently implied away.

export type PlatformKey = 'win' | 'mac' | 'linux';
export type FingerprintMode = 'chrome' | 'off';
export type HttpProtocolMode = 'auto' | 'h2' | 'http1';

import { createSecureContext } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The origin the fingerprint claims to be a same-origin page of. */
export const FINGERPRINT_ORIGIN = 'https://chat.deepseek.com';

export const DEFAULT_CHROME_VERSION = '153.0.0.0';

/**
 * Chrome advertises these in the ClientHello but OpenSSL (and therefore Node)
 * cannot emit them. They are listed so `doctor` and `fingerprint` can state the
 * residual difference precisely instead of implying an exact match.
 */
export const TLS_GAPS = [
  'GREASE values (cipher, extension, group, sigalg) — OpenSSL cannot emit these',
  'encrypted_client_hello / ECH (65037)',
  'application_settings / ALPS (17613)',
  'status_request (5) and signed_certificate_timestamp (18)',
  'compress_certificate (27) and vendor extension 51764',
  'ML-DSA signature schemes 0x0904-0x0906 (Chrome 153 sends these; OpenSSL cannot)',
  'encrypt_then_mac (22) — we send it, Chrome does not',
  'ec_point_formats (Chrome sends uncompressed only; OpenSSL adds the two ANSI forms)',
  'key_share count (Chrome sends x25519_mlkem768 + x25519; OpenSSL sends only the first)',
  'extension ordering (OpenSSL emits a fixed order; Chrome orders its own)',
] as const;

interface PlatformPreset {
  userAgent: (version: string) => string;
  secChUaPlatform: string;
  acceptLanguage: string;
  ecdhCurve: string;
}

/**
 * The Windows preset is verified on this host. The macOS and Linux presets use
 * the same Chrome token layout with the platform token swapped; they are
 * derived, not captured, and are marked as such in `doctor`.
 */
const PLATFORM_PRESETS: Record<PlatformKey, PlatformPreset> = {
  win: {
    userAgent: (v) =>
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`,
    secChUaPlatform: '"Windows"',
    acceptLanguage: 'zh-CN,zh;q=0.9',
    ecdhCurve: 'X25519MLKEM768:X25519:P-256:P-384',
  },
  mac: {
    userAgent: (v) =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`,
    secChUaPlatform: '"macOS"',
    acceptLanguage: 'zh-CN,zh;q=0.9',
    ecdhCurve: 'X25519MLKEM768:X25519:P-256:P-384',
  },
  linux: {
    userAgent: (v) =>
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`,
    secChUaPlatform: '"Linux"',
    acceptLanguage: 'zh-CN,zh;q=0.9',
    ecdhCurve: 'X25519MLKEM768:X25519:P-256:P-384',
  },
};

/** Chrome's cipher list, TLS 1.3 suites first, exactly as captured. */
export const CHROME_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
] as const;

/**
 * Chrome's signature_algorithms order with the three unsupported ML-DSA codes
 * (0x0904-0x0906) replaced by the RSA-PSS-PSS schemes OpenSSL does understand.
 * That substitution is the closest reachable match, not an exact one.
 */
export const CHROME_SIGALGS = [
  'rsa_pss_pss_sha256',
  'rsa_pss_pss_sha384',
  'rsa_pss_pss_sha512',
  'ecdsa_secp256r1_sha256',
  'rsa_pss_rsae_sha256',
  'rsa_pkcs1_sha256',
  'ecdsa_secp384r1_sha384',
  'rsa_pss_rsae_sha384',
  'rsa_pkcs1_sha384',
  'rsa_pss_rsae_sha512',
  'rsa_pkcs1_sha512',
].join(':');

/** Chrome's HTTP/2 SETTINGS payload, captured from the client preface. */
export const CHROME_HTTP2_SETTINGS = {
  headerTableSize: 65536,
  enablePush: false,
  initialWindowSize: 6291456,
  maxHeaderListSize: 262144,
} as const;

/**
 * Chrome raises the connection-level receive window to this value right after
 * SETTINGS, which puts WINDOW_UPDATE delta=15663105 (this value minus the
 * protocol default of 65535) on the wire.
 */
export const CHROME_CONNECTION_WINDOW = 15728640;

export const CHROME_ACCEPT_ENCODING = 'gzip, deflate, br, zstd';
export const CHROME_PRIORITY = 'u=1, i';
export const CHROME_ACCEPT = '*/*';

export interface FingerprintProfile {
  readonly platform: PlatformKey;
  readonly chromeVersion: string;
  readonly chromeMajor: string;
  readonly userAgent: string;
  readonly secChUa: string;
  readonly secChUaMobile: string;
  readonly secChUaPlatform: string;
  readonly acceptLanguage: string;
  readonly acceptEncoding: string;
  readonly priority: string;
  readonly origin: string;
  readonly ecdhCurve: string;
  /** True when every value was captured on this host rather than derived. */
  readonly verified: boolean;
}

export function createFingerprintProfile(options: {
  platform?: string;
  chromeVersion?: string;
  /** Full User-Agent override; the client hints are still derived from it. */
  userAgent?: string;
} = {}): FingerprintProfile {
  const platform: PlatformKey = options.platform === 'mac' || options.platform === 'linux'
    ? options.platform
    : 'win';
  const version = normalizeChromeVersion(options.chromeVersion);
  const major = version.split('.')[0] || DEFAULT_CHROME_VERSION.split('.')[0];
  const preset = PLATFORM_PRESETS[platform];
  const userAgent = options.userAgent?.trim() || preset.userAgent(version);

  return {
    platform,
    chromeVersion: version,
    chromeMajor: major,
    userAgent,
    // Captured layout: brand list starts with the real Chrome brand, then the
    // "Not_A Brand" GREASE entry with version 8, then Chromium.
    secChUa: `"Google Chrome";v="${major}", "Not_A Brand";v="8", "Chromium";v="${major}"`,
    secChUaMobile: '?0',
    secChUaPlatform: preset.secChUaPlatform,
    acceptLanguage: preset.acceptLanguage,
    acceptEncoding: CHROME_ACCEPT_ENCODING,
    priority: CHROME_PRIORITY,
    origin: FINGERPRINT_ORIGIN,
    ecdhCurve: preset.ecdhCurve,
    verified: platform === 'win' && version === DEFAULT_CHROME_VERSION && !options.userAgent,
  };
}

/**
 * Chrome installs itself beside a directory named after its exact version
 * (`Application\153.0.8010.50\`), which is the reliable way to read it on
 * Windows: `chrome.exe --version` just launches a window there. macOS and Linux
 * are handled by `detectVersionFromExecutable` instead.
 *
 * The UA and Sec-CH-UA versions must agree, or the mismatch is itself a
 * fingerprint, so the profile tracks whatever this host really runs.
 */
export function detectChromeVersion(browserPath: string | null | undefined): string | null {
  if (!browserPath) return null;
  return detectVersionFromDirectory(browserPath) ?? detectVersionFromExecutable(browserPath);
}

function detectVersionFromDirectory(browserPath: string): string | null {
  try {
    const versionDir = readdirSync(dirname(browserPath), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      .sort(compareVersions)
      .pop();
    return versionDir ?? null;
  } catch {
    return null;
  }
}

/**
 * macOS and Linux have no version directory beside the executable; their builds
 * print the version to stdout instead. Skipped on Windows, where running the
 * binary with `--version` opens a window rather than printing.
 */
function detectVersionFromExecutable(browserPath: string): string | null {
  if (process.platform === 'win32') return null;
  try {
    const output = execFileSync(browserPath, ['--version'], {
      timeout: 5_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseChromeVersionOutput(output);
  } catch {
    return null;
  }
}

/**
 * Parses the output of `chrome --version`.
 *
 * Brave and Edge print their own version first and the engine version after a
 * `Chromium:` label, so the labelled value is preferred — claiming the browser
 * brand's number as the Chrome version would put a wrong value in the UA.
 * Exported for tests.
 */
export function parseChromeVersionOutput(output: string): string | null {
  const labelled = /Chromium[:\s]+(\d+\.\d+\.\d+\.\d+)/i.exec(output);
  if (labelled?.[1]) return labelled[1];
  const any = /(\d+\.\d+\.\d+\.\d+)/.exec(output);
  return any?.[1] ?? null;
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Reduces any Chrome version input to the form Chrome itself puts in the UA.
 *
 * Chrome reports only the major version followed by zeros — this host has
 * 153.0.8010.50 installed but sends `Chrome/153.0.0.0` — so the build number is
 * deliberately dropped. Accepts "153", "153.0.0.0" or "153.0.8010.50".
 */
function normalizeChromeVersion(value?: string): string {
  const trimmed = (value ?? '').trim();
  const major = trimmed.split('.')[0]?.trim();
  if (!major || !/^\d{2,3}$/.test(major)) return DEFAULT_CHROME_VERSION;
  return `${major}.0.0.0`;
}

// --- header ordering --------------------------------------------------------

/**
 * Header slots in the order Chrome put them on the wire, for a request that
 * carries a body. Captured from POST /api/v0/chat/{completion,create_pow_challenge}
 * and POST /api/v0/chat_session/create.
 */
const ORDER_POST = [
  'x-client-locale',
  'sec-ch-ua-platform',
  'authorization',
  'x-client-bundle-id',
  'x-device-id',
  'sec-ch-ua',
  'x-dpp-bypass-hook',
  'x-ds-pow-response',
  'sec-ch-ua-mobile',
  'x-client-timezone-offset',
  'x-app-version',
  'user-agent',
  'x-client-version',
  'content-type',
  'x-client-platform',
  'accept',
  'origin',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'referer',
  'accept-encoding',
  'accept-language',
  'cookie',
  'priority',
] as const;

/**
 * The same, for a GET that names an Accept explicitly. Captured from
 * GET /api/v0/chat/history_messages. Chrome positions the app-specified Accept
 * earlier here and omits Origin (GET is exempt from the Origin rule).
 */
const ORDER_GET = [
  'x-client-locale',
  'sec-ch-ua-platform',
  'authorization',
  'x-client-bundle-id',
  'x-device-id',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'x-client-timezone-offset',
  'x-app-version',
  'user-agent',
  'accept',
  'x-client-version',
  'content-type',
  'x-client-platform',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'referer',
  'accept-encoding',
  'accept-language',
  'cookie',
  'priority',
] as const;

export interface BrowserRequestShape {
  readonly method: string;
  /** Application headers, matched case-insensitively. */
  readonly headers: Record<string, string>;
  readonly profile: FingerprintProfile;
  readonly hasBody: boolean;
  readonly bodyLength?: number;
  /** Absolute request URL; supplies :scheme, :authority and :path. */
  readonly url: URL;
}

export interface OrderedHeaders {
  /** Ready for node:http2 request(), pseudo-headers included. */
  readonly h2: string[];
  /** Ready for node:http request(). */
  readonly h1: string[];
  /** Names only, in wire order, for diagnostics and tests. */
  readonly order: string[];
}

/**
 * Builds the exact header list a Chrome page would send for this request.
 *
 * Values come from the caller (bearer token, device id, versions, PoW answer);
 * only the browser-owned headers are supplied by the profile. Absent headers
 * are skipped without disturbing the position of the others.
 */
export function buildOrderedHeaders(shape: BrowserRequestShape): OrderedHeaders {
  const { profile } = shape;
  const supplied = new Map<string, string>();
  for (const [name, value] of Object.entries(shape.headers)) {
    if (value === undefined || value === null) continue;
    supplied.set(name.toLowerCase(), String(value));
  }

  // Browser-owned headers win: they describe the browser, not the application.
  supplied.set('user-agent', profile.userAgent);
  supplied.set('sec-ch-ua', profile.secChUa);
  supplied.set('sec-ch-ua-mobile', profile.secChUaMobile);
  supplied.set('sec-ch-ua-platform', profile.secChUaPlatform);
  supplied.set('accept-language', profile.acceptLanguage);
  supplied.set('accept-encoding', profile.acceptEncoding);
  supplied.set('priority', profile.priority);
  supplied.set('sec-fetch-site', 'same-origin');
  supplied.set('sec-fetch-mode', 'cors');
  supplied.set('sec-fetch-dest', 'empty');
  supplied.set('referer', `${profile.origin}/`);
  if (!supplied.has('accept')) supplied.set('accept', CHROME_ACCEPT);

  const method = shape.method.toUpperCase();
  const isBodyless = method === 'GET' || method === 'HEAD';
  // A browser only attaches Origin to a cross-origin-eligible request; GET is
  // exempt, which is exactly what the captured traffic shows.
  if (!isBodyless) supplied.set('origin', profile.origin);
  else supplied.delete('origin');

  const template = isBodyless ? ORDER_GET : ORDER_POST;

  // Chrome emits content-length immediately after the pseudo-headers on a POST,
  // and omits it entirely when there is no body. It is therefore not a template
  // slot but a prefix, and must not also appear in the unordered tail.
  const contentLength = !isBodyless && shape.hasBody && shape.bodyLength !== undefined
    ? String(shape.bodyLength)
    : null;
  supplied.delete('content-length');

  const order: string[] = [];
  const pairs: Array<[string, string]> = [];
  if (contentLength !== null) {
    order.push('content-length');
    pairs.push(['content-length', contentLength]);
  }
  for (const name of template) {
    const value = supplied.get(name);
    if (value === undefined) continue;
    order.push(name);
    pairs.push([name, value]);
    supplied.delete(name);
  }
  // Anything the application sent that the template does not know about keeps
  // its insertion order and lands after the known slots.
  for (const [name, value] of supplied) {
    order.push(name);
    pairs.push([name, value]);
  }

  const authority = shape.url.host;
  const h2 = [
    ':method', method,
    ':authority', authority,
    ':scheme', shape.url.protocol.replace(':', ''),
    ':path', `${shape.url.pathname}${shape.url.search}`,
    ...pairs.flatMap(([n, v]) => [n, v]),
  ];

  // HTTP/1.1 additionally needs the connection-level headers, which Chrome
  // also emits first. Content-Length is already in `pairs`.
  const h1: string[] = ['Host', authority];
  if (!isBodyless) h1.push('Connection', 'keep-alive');
  h1.push(...pairs.flatMap(([n, v]) => [n, v]));

  return { h2, h1, order };
}

/**
 * Node refuses a curve name OpenSSL does not know, and does so by throwing from
 * createSecureContext rather than degrading. Probe once and remember, so an
 * older Node without ML-KEM falls back instead of failing to start.
 */
const curveCache = new Map<string, string | null>();

export function resolveEcdhCurve(preferred: string): string | null {
  if (curveCache.has(preferred)) return curveCache.get(preferred) ?? null;
  const resolved = probeCurve(preferred) ? preferred : probeCurve('X25519:P-256:P-384') ? 'X25519:P-256:P-384' : null;
  curveCache.set(preferred, resolved);
  return resolved;
}

function probeCurve(candidate: string): boolean {
  try {
    createSecureContext({ ecdhCurve: candidate });
    return true;
  } catch {
    return false;
  }
}

/** TLS options for the fingerprinted transport, minus anything unsupported. */
export function buildTlsOptions(profile: FingerprintProfile): Record<string, unknown> {
  const options: Record<string, unknown> = {
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ciphers: CHROME_CIPHERS.join(':'),
    sigalgs: CHROME_SIGALGS,
    ALPNProtocols: ['h2', 'http/1.1'],
    // Chrome always advertises session_ticket (extension 35) and offers a
    // ticket when it holds one. Without this, OpenSSL omits the extension in
    // every ClientHello, which shows up in the JA3/JA4 extension list and in
    // the on-the-wire extension count.
    sessionTimeout: 300,
  };
  const curve = resolveEcdhCurve(profile.ecdhCurve);
  if (curve) options.ecdhCurve = curve;
  return options;
}
