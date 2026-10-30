// Browser-fingerprinted HTTP transport.
//
// Why this exists: the previous transport was global fetch(), which emits
// `User-Agent: node`, undici's default SETTINGS, an untuned TLS ClientHello and
// no browser headers at all. Anything downstream that looks at the connection
// rather than the request saw "Node script", not "Chrome page".
//
// This module reimplements the small slice of fetch() the DeepSeek client uses
// (url, method, headers, body, signal -> Response) directly on node:http2, so
// the wire shape can be controlled:
//
//   TLS        Chrome cipher list, curve preference, signature algorithms, ALPN.
//   HTTP/2     Chrome's SETTINGS payload and connection-level WINDOW_UPDATE,
//              already active before the first HEADERS frame.
//   HEADERS    flat [name, value, ...] arrays, because Node emits pseudo-headers
//              and regular headers in exactly the order they are supplied.
//
// Compression is handled here rather than by undici, because Accept-Encoding now
// advertises gzip/deflate/br/zstd and the response has to be decoded to match.
//
// Scope: only https:// targets use HTTP/2. A configured http:// baseUrl (the
// mock backends the test suite runs) goes down the HTTP/1.1 path, since those
// are plain node:http servers.

import http from 'node:http';
import http2 from 'node:http2';
import { Readable } from 'node:stream';
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
} from 'node:zlib';
import {
  buildOrderedHeaders,
  buildTlsOptions,
  CHROME_CONNECTION_WINDOW,
  CHROME_HTTP2_SETTINGS,
  type FingerprintProfile,
} from './fingerprint.ts';

export type HttpProtocolMode = 'auto' | 'h2' | 'http1';

export interface TransportOptions {
  readonly profile: FingerprintProfile;
  /** Explicit ALPN protocol. `auto` picks h2 for https and http/1.1 otherwise. */
  readonly protocol?: HttpProtocolMode;
  /** Idle timeout for a pooled session, in milliseconds. */
  readonly sessionIdleMs?: number;
}

/** What actually went on the wire, for `doctor` and tests. */
export interface TransportTrace {
  protocol: 'h2' | 'http1';
  url: string;
  method: string;
  headerOrder: string[];
  alpn?: string | null;
  tlsCipher?: string | null;
  reusedSession: boolean;
}

interface PooledSession {
  session: http2.ClientHttp2Session;
  timer: NodeJS.Timeout | null;
  /** Requests currently in flight on this session. */
  active: number;
}

const DEFAULT_SESSION_IDLE_MS = 120_000;

export class FingerprintTransport {
  private readonly options: TransportOptions;
  private readonly sessions = new Map<string, PooledSession>();
  private readonly log: TransportTrace[] = [];

  constructor(options: TransportOptions) {
    this.options = options;
  }

  /** Recent request traces, newest last. Used by `doctor --json`. */
  takeTrace(): TransportTrace[] {
    const copy = [...this.log];
    this.log.length = 0;
    return copy;
  }

  /** Drops pooled connections. Safe to call at any time. */
  close(): void {
    for (const { session, timer } of this.sessions.values()) {
      if (timer) clearTimeout(timer);
      try { session.destroy(); } catch { /* already gone */ }
    }
    this.sessions.clear();
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = normalizeBody(init.body);
    const headers = toPlainHeaders(init.headers);

    const shape = buildOrderedHeaders({
      method,
      headers,
      profile: this.options.profile,
      hasBody: body !== null,
      ...(body !== null ? { bodyLength: body.byteLength } : {}),
      url: target,
    });

    const requested = this.options.protocol ?? 'auto';
    const useH2 = requested === 'h2'
      || (requested === 'auto' && target.protocol === 'https:');

    if (useH2) return this.fetchH2(target, method, shape.h2, shape.order, body, init.signal);
    return this.fetchH1(target, method, shape.h1, shape.order, body, init.signal);
  }

  // --- HTTP/2 ---------------------------------------------------------------

  private async fetchH2(
    url: URL,
    method: string,
    headers: string[],
    order: string[],
    body: Buffer | null,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> {
    const origin = url.origin;

    const attempt = async (reused: boolean): Promise<Response> => {
      const session = await this.sessionFor(origin);
      this.markActive(origin, 1);
      return new Promise<Response>((resolve, reject) => {
        let settled = false;
        let released = false;
        // The session must stay referenced until the body has been consumed:
        // releasing it at the response head would let the event loop drain and
        // kill the process while an SSE stream is still arriving.
        const release = () => {
          if (released) return;
          released = true;
          this.markActive(origin, -1);
        };
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };

        const onAbort = () => {
          this.dropSession(origin);
          release();
          finish(() => reject(abortError()));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });

        let request: http2.ClientHttp2Stream;
        try {
          // A flat array is the only way to control pseudo-header placement:
          // Node writes them in the order given, and the later `end()` body goes
          // into DATA frames rather than a second HEADERS block.
          request = session.request(headers);
        } catch (error) {
          signal?.removeEventListener('abort', onAbort);
          this.dropSession(origin);
          release();
          return finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }

        request.on('response', (responseHeaders, flags) => {
          signal?.removeEventListener('abort', onAbort);
          const status = Number(responseHeaders[':status'] ?? 0);
          const headerList = new Headers();
          for (const [name, value] of Object.entries(responseHeaders)) {
            if (name.startsWith(':')) continue;
            if (Array.isArray(value)) for (const v of value) headerList.append(name, String(v));
            else if (value !== undefined) headerList.append(name, String(value));
          }

          this.log.push({
            protocol: 'h2',
            url: url.href,
            method,
            headerOrder: order,
            alpn: session.alpnProtocol ?? null,
            tlsCipher: socketCipherName(session),
            reusedSession: reused,
          });

          const decoded = decodeBody(request, headerList);
          const isBodyless = method === 'HEAD' || status === 204 || status === 304;
          if (isBodyless) {
            release();
          } else {
            // Hold the session reference until the body stops arriving, then
            // let the idle timer take over.
            const done = () => release();
            decoded.once('end', done);
            decoded.once('close', done);
            decoded.once('error', done);
          }
          const responseBody = isBodyless
            ? null
            : Readable.toWeb(decoded) as ReadableStream<Uint8Array>;
          finish(() => resolve(new Response(responseBody, { status, statusText: '', headers: headerList })));

          // Release the stream's slot only after the body has been consumed, so
          // the pooled session is not closed mid-transfer.
          void flags;
        });

        request.on('error', (error) => {
          signal?.removeEventListener('abort', onAbort);
          const code = (error as NodeJS.ErrnoException).code ?? '';
          // Only a session-level failure justifies tearing the connection down;
          // a cancelled single stream must not disturb concurrent requests.
          const sessionLevel = code === 'ERR_HTTP2_GOAWAY_SESSION'
            || code === 'ERR_HTTP2_INVALID_SESSION'
            || code === 'ERR_HTTP2_SESSION_ERROR'
            || code === 'ERR_HTTP2_STREAM_CANCEL';
          if (sessionLevel) this.dropSession(origin);
          release();
          finish(() => reject(Object.assign(new Error(error.message), { stale: sessionLevel })));
        });

        if (body !== null) request.end(body);
        else request.end();
      });
    };

    try {
      return await attempt(true);
    } catch (error) {
      // A pooled connection can be closed by the peer at any moment; one retry
      // on a fresh session is safe because the request never reached the server.
      if ((error as { stale?: boolean }).stale) return attempt(false);
      throw error;
    }
  }

  private async sessionFor(origin: string): Promise<http2.ClientHttp2Session> {
    const existing = this.sessions.get(origin);
    if (existing && !existing.session.closed && !existing.session.destroyed) {
      if (existing.timer) { clearTimeout(existing.timer); existing.timer = null; }
      return existing.session;
    }
    if (existing) this.dropSession(origin);

    const session = http2.connect(origin, {
      ...buildTlsOptions(this.options.profile),
      settings: { ...CHROME_HTTP2_SETTINGS },
    });

    // Chrome raises the connection receive window immediately after SETTINGS;
    // this must happen before the first request so the preface frames match.
    session.once('connect', () => {
      try { session.setLocalWindowSize(CHROME_CONNECTION_WINDOW); } catch { /* older Node */ }
    });

    session.on('goaway', () => this.dropSession(origin));
    session.on('error', () => this.dropSession(origin));
    session.on('close', () => this.dropSession(origin));

    // Idle sockets must not hold the event loop open, or a short-lived caller
    // (notably `doctor`) would never exit. `markActive` refs the session again
    // while a request is in flight.
    session.unref();

    this.sessions.set(origin, { session, timer: null, active: 0 });
    return session;
  }

  /**
   * Tracks in-flight requests so the pooled socket keeps the event loop alive
   * exactly while there is work outstanding, and is dropped when it goes idle.
   */
  private markActive(origin: string, delta: number): void {
    const entry = this.sessions.get(origin);
    if (!entry) return;
    entry.active = Math.max(0, entry.active + delta);

    if (entry.active > 0) {
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      entry.session.ref();
      return;
    }

    entry.session.unref();
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.idleTimer(origin);
  }

  /**
   * Closes a pooled session that has seen no traffic for `sessionIdleMs`.
   * Without this a long-running MCP server keeps sockets to the upstream open
   * indefinitely, which is itself a behavioural tell.
   */
  private idleTimer(origin: string): NodeJS.Timeout {
    const ms = this.options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    const timer = setTimeout(() => this.dropSession(origin), ms);
    timer.unref?.();
    return timer;
  }

  private dropSession(origin: string): void {
    const entry = this.sessions.get(origin);
    if (!entry) return;
    this.sessions.delete(origin);
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.session.destroy(); } catch { /* already gone */ }
  }

  // --- HTTP/1.1 -------------------------------------------------------------

  private fetchH1(
    url: URL,
    method: string,
    headers: string[],
    order: string[],
    body: Buffer | null,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const request = http.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        method,
        path: `${url.pathname}${url.search}`,
        // A flat array preserves the wire order exactly, as it does for HTTP/2.
        headers,
        signal: signal ?? undefined,
      });

      request.on('response', (response) => {
        const headerList = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) for (const v of value) headerList.append(name, String(v));
          else headerList.append(name, String(value));
        }

        this.log.push({
          protocol: 'http1',
          url: url.href,
          method,
          headerOrder: order,
          reusedSession: false,
        });

        const status = response.statusCode ?? 0;
        const decoded = decodeBody(response, headerList);
        const responseBody = status === 204 || status === 304
          ? null
          : Readable.toWeb(decoded) as ReadableStream<Uint8Array>;
        resolve(new Response(responseBody, { status, statusText: response.statusMessage ?? '', headers: headerList }));
      });

      request.on('error', reject);
      if (body !== null) request.end(body);
      else request.end();
    });
  }
}

// --- helpers ----------------------------------------------------------------

function toPlainHeaders(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (init instanceof Headers) {
    init.forEach((value, name) => { out[name] = value; });
    return out;
  }
  if (Array.isArray(init)) {
    for (const [name, value] of init) out[String(name)] = String(value);
    return out;
  }
  for (const [name, value] of Object.entries(init as Record<string, string>)) {
    if (value !== undefined && value !== null) out[name] = String(value);
  }
  return out;
}

function normalizeBody(body: RequestInit['body']): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('FingerprintTransport: unsupported body type');
}

/**
 * Wraps the response stream in the decompressor named by Content-Encoding, and
 * removes the now-inaccurate encoding headers so downstream code sees a plain
 * byte stream — which is what it would have got from fetch().
 */
function decodeBody(
  source: Readable,
  headers: Headers,
): Readable {
  const encoding = (headers.get('content-encoding') ?? '').trim().toLowerCase();
  headers.delete('content-encoding');

  let stream: Readable;
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      stream = source.pipe(createGunzip());
      break;
    case 'br':
      stream = source.pipe(createBrotliDecompress());
      break;
    case 'zstd':
      stream = source.pipe(createZstdDecompress());
      break;
    case 'deflate':
      stream = source.pipe(createInflate());
      break;
    default:
      // Identity, or an encoding this build does not know: pass the bytes
      // through rather than corrupting them.
      stream = source;
      break;
  }

  // The body handed to callers is decoded, so the length no longer describes
  // it — the same thing fetch() does.
  headers.delete('content-length');
  return stream;
}

function socketCipherName(session: http2.ClientHttp2Session): string | null {
  try {
    const socket = session.socket as import('node:tls').TLSSocket | undefined;
    return socket?.getCipher?.()?.name ?? null;
  } catch {
    return null;
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}
