import {
  DEEPSEEK_BYPASS_HOOK_HEADER,
  DEEPSEEK_WEB_ORIGIN,
  DEEPSEEK_WEB_ROUTES,
} from '../vendor/contracts.ts';
import {
  encodeCompletionRequest,
  encodeCreateSessionRequest,
  encodePowChallengeRequest,
  encodeHistoryRequest,
  encodeUploadFileRequest,
  encodeFetchFilesRequest,
} from '../vendor/request-codec.ts';
import {
  createDeepSeekSseByteDecoder,
  createDeepSeekStreamSummary,
  consumeDeepSeekSseEvents,
  type DeepSeekStreamSummary,
} from '../vendor/stream-codec.ts';
import { solvePowChallengeLocally, type PowChallenge } from '../vendor/pow.ts';
import {
  DeepSeekAuthError,
  DeepSeekPayloadError,
  DeepSeekPowError,
  DeepSeekSessionError,
} from '../vendor/errors.ts';
import type { DeepSeekUploadedFile } from '../vendor/contracts.ts';
import type { DsConfig } from './config.ts';
import { CLIENT_BUNDLE_ID } from './config.ts';
import { createFingerprintProfile, type FingerprintProfile } from './fingerprint.ts';
import { FingerprintTransport, type TransportTrace } from './transport.ts';
import { prepareUpload, type SerializedMultipart } from './upload.ts';

const COMPLETION_PATH = DEEPSEEK_WEB_ROUTES.completion;
const UPLOAD_PATH = DEEPSEEK_WEB_ROUTES.uploadFile;

// DeepSeek signals an invalid/expired token with these body-level codes while
// still answering HTTP 200.
const AUTH_BIZ_CODES = new Set([40002, 40003]);

export interface ChatTurn {
  assistantText: string;
  reasoningText: string;
  responseMessageId: number | null;
  requestMessageId: number | null;
  finished: boolean;
  sessionUrl: string;
}

export interface ChatOptions {
  prompt: string;
  chatSessionId?: string | null;
  parentMessageId?: number | null;
  modelType?: string | null;
  thinkingEnabled?: boolean;
  searchEnabled?: boolean;
  /**
   * Uploaded file ids to attach to this turn. Populated by uploading first
   * (see uploadFiles) and passing the returned ids here; the completion route
   * carries them in ref_file_ids and the server resolves them against the
   * account's file store.
   */
  refFileIds?: string[] | null;
  signal?: AbortSignal;
  onTextChunk?: (delta: string, fullText: string) => void;
  onReasoningChunk?: (delta: string, fullReasoning: string) => void;
}

export interface UploadResult {
  /** Server-assigned file id, used as ref_file_ids on a later completion. */
  id: string;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  status: string | null;
  /** Signed CDN path, present once the upload is accepted. */
  signedPath: string | null;
  /** Content-policy audit verdict, when the server supplies one. */
  auditResult: string | null;
  retryable: boolean | null;
  width: number | null;
  height: number | null;
}

/**
 * Node port of the extension's DeepSeek web client. Route encoding, PoW
 * solving, and SSE interpretation are the upstream vendored modules; only the
 * credential source and the browser-only transport differ.
 */
export class DeepSeekWebClient {
  private readonly config: DsConfig;
  private readonly transport: FingerprintTransport | null;
  readonly fingerprint: FingerprintProfile | null;

  constructor(config: DsConfig) {
    this.config = config;

    // `off` restores the previous behaviour exactly: plain fetch(), Node's own
    // User-Agent, undici's HTTP/1.1 and TLS defaults. It exists so the browser
    // shape can be A/B compared against the old one on a live account.
    if (config.fingerprint === 'off') {
      this.transport = null;
      this.fingerprint = null;
      return;
    }

    this.fingerprint = createFingerprintProfile({
      platform: config.fingerprintPlatform,
      ...(config.chromeVersion ? { chromeVersion: config.chromeVersion } : {}),
      ...(config.userAgent ? { userAgent: config.userAgent } : {}),
    });
    this.transport = new FingerprintTransport({
      profile: this.fingerprint,
      protocol: config.httpProtocol,
    });
  }

  /** Wire-level trace of requests made so far; used by `doctor`. */
  takeTransportTrace(): TransportTrace[] {
    return this.transport?.takeTrace() ?? [];
  }

  close(): void {
    this.transport?.close();
  }

  createClientHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      'X-App-Version': this.config.appVersion,
      'x-client-platform': 'web',
      'x-client-version': this.config.appVersion,
      'x-client-locale': this.config.locale,
      'x-client-timezone-offset': this.config.timezoneOffset,
      // The live page sends these on every /api/v0 call; omitting them risks a
      // rejection that looks like an auth failure.
      'x-client-bundle-id': CLIENT_BUNDLE_ID,
    };
    if (this.config.deviceId) headers['x-device-id'] = this.config.deviceId;
    return headers;
  }

  async createChatSession(): Promise<string> {
    const response = await this.request(
      encodeCreateSessionRequest(this.createClientHeaders()),
      'DeepSeek chat session create',
    );
    const json = await readJson(response, 'DeepSeek chat session create', DeepSeekSessionError);
    const data = json?.data;
    const chatSessionId = firstString(data?.biz_data?.chat_session?.id);

    if (isAuthBizError(data, json)) {
      throw new DeepSeekAuthError(
        'DeepSeek auth token was rejected while creating a chat session. Refresh the token.',
      );
    }
    if (!response.ok || data?.biz_code !== 0 || !chatSessionId) {
      throw new DeepSeekSessionError(
        `Failed to create DeepSeek chat session: ${preview(data ?? json)}`,
      );
    }
    return chatSessionId;
  }

  async createPowHeaders(targetPath: string, signal?: AbortSignal): Promise<Record<string, string>> {
    const challenge = await this.fetchPowChallenge(targetPath, signal);
    const answer = await solvePowChallengeLocally(challenge, undefined, signal);
    return {
      'X-DS-PoW-Response': Buffer.from(JSON.stringify({
        algorithm: answer.algorithm,
        challenge: answer.challenge,
        salt: answer.salt,
        answer: answer.answer,
        signature: answer.signature,
        target_path: targetPath,
      }), 'utf8').toString('base64'),
    };
  }

  async chat(options: ChatOptions): Promise<ChatTurn> {
    const deadline = AbortSignal.timeout(this.config.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline;

    const chatSessionId = options.chatSessionId?.trim() || await this.createChatSession();
    const powHeaders = await this.createPowHeaders(COMPLETION_PATH, signal);

    const response = await this.request(
      encodeCompletionRequest({
        chatSessionId,
        parentMessageId: options.parentMessageId ?? null,
        modelType: options.modelType ?? null,
        prompt: options.prompt,
        refFileIds: options.refFileIds ?? [],
        thinkingEnabled: options.thinkingEnabled ?? true,
        searchEnabled: options.searchEnabled ?? false,
        clientHeaders: this.createClientHeaders(),
        powHeaders,
      }),
      'DeepSeek completion',
      signal,
    );

    if (!response.ok) {
      const body = await safeText(response);
      // A 413 here means the attachment set, not the prompt, blew the budget.
      const hint = response.status === 413
        ? ' (the referenced attachments may exceed the upload size budget)'
        : '';
      throw new DeepSeekPayloadError(
        `DeepSeek completion failed with HTTP ${response.status}${hint}: ${preview(body)}`,
        { retryable: response.status >= 500 },
      );
    }

    // DeepSeek reports token failures as HTTP 200 with a JSON body carrying a
    // body-level `code` (observed live: {"code":40003,"msg":"INVALID_TOKEN"}).
    // The completion route must answer with an event stream, so any other
    // content type is an error body — decode it before it reaches the SSE
    // decoder, which would otherwise swallow it into an empty answer.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      const body = await safeText(response);
      throw classifyCompletionFailure(response.status, contentType, body);
    }

    if (!response.body) {
      throw new DeepSeekPayloadError(
        'DeepSeek completion response did not include a stream body.',
        { retryable: true },
      );
    }

    const summary = await this.readStream(response, options);
    return {
      assistantText: summary.assistantText,
      reasoningText: summary.assistantReasoningText,
      responseMessageId: summary.responseMessageId,
      requestMessageId: summary.requestMessageId,
      finished: summary.finished,
      sessionUrl: `${DEEPSEEK_WEB_ORIGIN}/a/chat/s/${chatSessionId}`,
    };
  }

  /**
   * Uploads local files and returns their server metadata.
   *
   * The files are read, framed as multipart/form-data and posted to the upload
   * route. The resulting ids are what a completion turn references through
   * ref_file_ids; uploading does not by itself attach anything to a chat, so an
   * upload that is never referenced simply sits in the account's file store.
   *
   * The upload route carries its own proof-of-work: the challenge is solved for
   * UPLOAD_PATH specifically, so the completion-route headers cannot be reused.
   * All files in one call travel in a single multipart request, matching how the
   * web client batches a multi-file selection.
   */
  async uploadFiles(filePaths: string[], signal?: AbortSignal): Promise<UploadResult[]> {
    const serialized = await prepareUpload(filePaths);
    const powHeaders = await this.createPowHeaders(UPLOAD_PATH, signal);
    // x-file-size describes the uploaded content, not the multipart envelope.
    const contentBytes = serialized.files.reduce((sum, f) => sum + f.byteLength, 0);

    const response = await this.request(
      encodeUploadFileRequest({
        body: serialized.body,
        contentType: serialized.contentType,
        fileSize: contentBytes,
        powHeaders,
        clientHeaders: this.createClientHeaders(),
      }),
      'DeepSeek file upload',
      signal,
    );

    const json = await readJson(response, 'DeepSeek file upload', DeepSeekPayloadError);
    const data = json?.data;

    if (isAuthBizError(data, json)) {
      throw new DeepSeekAuthError('DeepSeek auth token was rejected during a file upload.');
    }
    if (!response.ok || data?.biz_code !== 0) {
      throw new DeepSeekPayloadError(
        `DeepSeek file upload failed: ${preview(data ?? json)}`,
        { retryable: response.status >= 500 },
      );
    }

    const raw = extractUploadedFiles(data?.biz_data);
    if (!raw.length) {
      throw new DeepSeekPayloadError(
        `DeepSeek file upload returned no file record: ${preview(data?.biz_data)}`,
      );
    }

    // Report every uploaded file with the local size as a fallback, so a
    // response that omits file_size still yields a truthful byte count.
    return raw.map((file, index) => normalizeUploadedFile(file, serialized.files[index] ?? null));
  }

  /** Polls metadata for previously uploaded file ids. */
  async fetchFiles(fileIds: string[], signal?: AbortSignal): Promise<UploadResult[]> {
    if (!fileIds.length) return [];
    const response = await this.request(
      encodeFetchFilesRequest(fileIds, this.createClientHeaders()),
      'DeepSeek file lookup',
      signal,
    );

    const json = await readJson(response, 'DeepSeek file lookup', DeepSeekPayloadError);
    const data = json?.data;
    if (isAuthBizError(data, json)) {
      throw new DeepSeekAuthError('DeepSeek auth token was rejected during a file lookup.');
    }
    if (!response.ok || data?.biz_code !== 0) {
      throw new DeepSeekPayloadError(
        `DeepSeek file lookup failed: ${preview(data ?? json)}`,
        { retryable: response.status >= 500 },
      );
    }
    return extractUploadedFiles(data?.biz_data).map((f) => normalizeUploadedFile(f, null));
  }

  /** Continues the current branch of an existing session. */
  async readParentMessageId(chatSessionId: string, assistantMessageId: number, signal?: AbortSignal) {
    const response = await this.request(
      encodeHistoryRequest(chatSessionId, this.createClientHeaders()),
      'DeepSeek history',
      signal,
    );
    if (!response.ok) return null;

    const json = await readJson(response, 'DeepSeek history', DeepSeekPayloadError);
    const data = json?.data?.biz_data ?? json?.data ?? json?.biz_data ?? json;
    const messages: unknown[] = Array.isArray(data?.chat_messages) ? data.chat_messages : [];
    for (const raw of messages) {
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const id = firstMessageId(value.message_id, value.id);
      if (id === assistantMessageId) return id;
    }
    return null;
  }

  private async fetchPowChallenge(targetPath: string, signal?: AbortSignal): Promise<PowChallenge> {
    const response = await this.request(
      encodePowChallengeRequest(this.createClientHeaders(), targetPath),
      'DeepSeek PoW challenge',
      signal,
    );

    if (response.status === 401 || response.status === 403) {
      throw new DeepSeekAuthError(
        `DeepSeek auth token was rejected (HTTP ${response.status}) while creating a PoW challenge.`,
      );
    }

    const json = await readJson(response, 'DeepSeek PoW challenge', DeepSeekPowError);
    const data = json?.data;
    const challenge = data?.biz_data?.challenge;

    if (isAuthBizError(data, json)) {
      throw new DeepSeekAuthError('DeepSeek auth token was rejected while creating a PoW challenge.');
    }
    if (!response.ok || data?.biz_code !== 0 || !challenge) {
      throw new DeepSeekPowError(`Failed to create DeepSeek PoW challenge: ${preview(data ?? json)}`);
    }

    return {
      algorithm: String(challenge.algorithm),
      challenge: String(challenge.challenge),
      salt: String(challenge.salt),
      difficulty: Number(challenge.difficulty),
      signature: String(challenge.signature),
      expireAt: Number(challenge.expire_at ?? challenge.expireAt ?? 0),
      expireAfter: Number(challenge.expire_after ?? challenge.expireAfter ?? 0),
    };
  }

  private async readStream(response: Response, options: ChatOptions): Promise<DeepSeekStreamSummary> {
    const reader = response.body!.getReader();
    const decoder = createDeepSeekSseByteDecoder();
    const summary = createDeepSeekStreamSummary();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const delta = consumeDeepSeekSseEvents(decoder.push(value), summary, {
          onReasoningChunk: options.onReasoningChunk,
        });
        if (delta) options.onTextChunk?.(delta, summary.assistantText);
      }
      const tail = consumeDeepSeekSseEvents(decoder.finish(), summary, {
        onReasoningChunk: options.onReasoningChunk,
      });
      if (tail) options.onTextChunk?.(tail, summary.assistantText);
    } finally {
      await reader.cancel().catch(() => {});
    }

    return summary;
  }

  private async request(
    encoded: { url: string; init: RequestInit },
    operation: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    // A plain ordered object rather than Headers: the transport has to control
    // both header order and casing, and Headers normalises names.
    const headers = toPlainHeaderObject(encoded.init.headers);
    headers[DEEPSEEK_BYPASS_HOOK_HEADER] = '1';
    if (this.config.cookie) headers.cookie = this.config.cookie;

    // The vendored encoders always emit chat.deepseek.com URLs; a configured
    // baseUrl is applied here so local mocks and proxies stay possible without
    // forking the route table.
    const url = this.config.baseUrl === DEEPSEEK_WEB_ORIGIN
      ? encoded.url
      : encoded.url.replace(DEEPSEEK_WEB_ORIGIN, this.config.baseUrl);

    const init: RequestInit = {
      ...encoded.init,
      headers,
      ...(signal ?? encoded.init.signal ? { signal: signal ?? encoded.init.signal } : {}),
    };

    try {
      return this.transport
        ? await this.transport.fetch(url, init)
        : await fetch(url, init);
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new DeepSeekPayloadError(
          `${operation} exceeded the ${this.config.timeoutMs}ms budget.`,
          { retryable: true },
        );
      }
      throw new DeepSeekPayloadError(
        `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }
  }
}

/** Flattens any HeadersInit into the plain ordered object the transport uses. */
function toPlainHeaderObject(init: HeadersInit | undefined): Record<string, string> {
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

async function readJson(
  response: Response,
  label: string,
  ErrorKind: new (message: string, options?: { retryable?: boolean }) => Error,
): Promise<any> {
  const text = await safeText(response);
  try {
    return JSON.parse(text);
  } catch {
    throw new ErrorKind(`${label} returned non-JSON HTTP ${response.status}: ${preview(text)}`);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Maps a non-stream completion response onto the right error class so callers
 * can tell "re-authenticate" apart from "retry later".
 */
function classifyCompletionFailure(
  status: number,
  contentType: string,
  body: string,
): Error {
  let code: number | null = null;
  try {
    const parsed = JSON.parse(body);
    code = typeof parsed?.code === 'number' ? parsed.code : null;
  } catch {
    // Non-JSON bodies keep the raw preview in the message below.
  }

  if ((code !== null && AUTH_BIZ_CODES.has(code)) || status === 401 || status === 403) {
    return new DeepSeekAuthError(
      `DeepSeek auth token was rejected while completing a turn (HTTP ${status}): ${preview(body)}. `
      + 'Refresh the token from chat.deepseek.com localStorage.',
    );
  }

  return new DeepSeekPayloadError(
    `DeepSeek completion returned HTTP ${status} with content-type `
    + `${contentType || 'unknown'} instead of an event stream: ${preview(body)}`,
    { retryable: status >= 500 },
  );
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function isAuthBizError(data: any, json: any): boolean {
  return (typeof data?.biz_code === 'number' && AUTH_BIZ_CODES.has(data.biz_code))
    || (typeof json?.code === 'number' && AUTH_BIZ_CODES.has(json.code));
}

/**
 * Pulls the uploaded-file records out of an upload or fetch response.
 *
 * The shape varies: sometimes the record is wrapped under `file` / `files` /
 * `file_infos`, and sometimes `biz_data` IS the record (observed live — the
 * upload response returns `{id, status, file_name, file_size, model_kind, ...}`
 * directly, with no wrapper). All shapes are accepted, because a wrapper
 * mismatch here silently discards a successful upload.
 *
 * A record is recognized by carrying an id under one of the known keys; that
 * check is what distinguishes "biz_data is the record" from "biz_data is an
 * unrelated object and the record is nested under `data`".
 */
function extractUploadedFiles(bizData: any): any[] {
  if (!bizData || typeof bizData !== 'object') return [];
  const candidates = [
    bizData.file,
    bizData.files,
    bizData.file_infos,
    bizData.fileInfos,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter((v) => v && typeof v === 'object');
    if (candidate && typeof candidate === 'object') return [candidate];
  }

  // No wrapper: the object may be the record itself.
  if (looksLikeFileRecord(bizData)) return [bizData];

  // Or the record may be nested one level deeper.
  if (bizData.data && typeof bizData.data === 'object') return extractUploadedFiles(bizData.data);
  return [];
}

/** True when the object carries a file id under any key the service has used. */
function looksLikeFileRecord(value: any): boolean {
  return firstString(value?.id, value?.file_id, value?.fileId) !== null;
}

/** Maps one raw file record onto the stable UploadResult shape. */
function normalizeUploadedFile(raw: any, fallback: { byteLength: number; mimeType: string } | null): UploadResult {
  const id = firstString(raw?.id, raw?.file_id, raw?.fileId);
  if (!id) {
    throw new DeepSeekPayloadError(
      `DeepSeek file record has no id: ${preview(raw)}`,
    );
  }
  return {
    id,
    fileName: firstString(raw?.file_name, raw?.fileName, raw?.name),
    fileSize: firstNumber(raw?.file_size, raw?.fileSize, raw?.size) ?? fallback?.byteLength ?? null,
    mimeType: firstString(raw?.mime_type, raw?.mimeType, raw?.content_type) ?? fallback?.mimeType ?? null,
    status: firstString(raw?.status, raw?.state),
    signedPath: firstString(raw?.signed_path, raw?.signedPath, raw?.url),
    auditResult: firstString(raw?.audit_result, raw?.auditResult),
    retryable: typeof raw?.retryable === 'boolean' ? raw.retryable : null,
    width: firstNumber(raw?.width, raw?.image_width) ?? null,
    height: firstNumber(raw?.height, raw?.image_height) ?? null,
  };
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstMessageId(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return null;
}
