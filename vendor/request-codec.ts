import {
  DEEPSEEK_BYPASS_HOOK_HEADER,
  DEEPSEEK_WEB_ORIGIN,
  DEEPSEEK_WEB_ROUTES,
} from './contracts.ts';

export type DeepSeekWebRouteName = keyof typeof DEEPSEEK_WEB_ROUTES;
export type DeepSeekHttpMethod = 'GET' | 'POST';

export const DEEPSEEK_AUGMENTABLE_WEB_ROUTES = [
  'completion',
  'editMessage',
  'regenerate',
] as const satisfies readonly DeepSeekWebRouteName[];

export type DeepSeekAugmentableWebRoute = typeof DEEPSEEK_AUGMENTABLE_WEB_ROUTES[number];

const DEEPSEEK_AUGMENTABLE_WEB_ROUTE_SET = new Set<DeepSeekWebRouteName>(
  DEEPSEEK_AUGMENTABLE_WEB_ROUTES,
);

export interface DeepSeekRoutePolicy {
  readonly route: DeepSeekWebRouteName;
  readonly method: DeepSeekHttpMethod;
}

type DeepSeekWebRoutePolicyMap = {
  readonly [Route in DeepSeekWebRouteName]: DeepSeekRoutePolicy & { readonly route: Route };
};

export const DEEPSEEK_WEB_ROUTE_POLICY = {
  completion: { route: 'completion', method: 'POST' },
  editMessage: { route: 'editMessage', method: 'POST' },
  regenerate: { route: 'regenerate', method: 'POST' },
  createSession: { route: 'createSession', method: 'POST' },
  powChallenge: { route: 'powChallenge', method: 'POST' },
  history: { route: 'history', method: 'GET' },
  uploadFile: { route: 'uploadFile', method: 'POST' },
  fetchFiles: { route: 'fetchFiles', method: 'GET' },
  fetchSessions: { route: 'fetchSessions', method: 'GET' },
} as const satisfies DeepSeekWebRoutePolicyMap;

export interface EncodedDeepSeekRequest {
  readonly url: string;
  readonly init: RequestInit;
}

export interface EncodeDeepSeekRouteRequestOptions {
  readonly baseUrl?: string;
  readonly searchParams?: Readonly<Record<string, string>>;
}

export interface MatchDeepSeekWebRouteInput {
  readonly url: string;
  readonly method: string;
  readonly baseUrl?: string;
}

export interface DeepSeekCompletionRequestInput {
  chatSessionId: string;
  parentMessageId: number | null;
  modelType: string | null;
  prompt: string;
  refFileIds: string[];
  thinkingEnabled: boolean;
  searchEnabled: boolean;
  clientHeaders: Record<string, string>;
  powHeaders: Record<string, string>;
}

const DEFAULT_MODEL_TYPE = 'default';
const SUPPORTED_MODEL_TYPES = new Set(['DEFAULT', 'default', 'expert', 'vision']);

export function createDeepSeekRouteUrl(
  route: DeepSeekWebRouteName,
  baseUrl: string = DEEPSEEK_WEB_ORIGIN,
): URL {
  return new URL(DEEPSEEK_WEB_ROUTES[route], baseUrl);
}

export function matchDeepSeekWebRoute(
  input: MatchDeepSeekWebRouteInput,
): DeepSeekWebRouteName | null {
  let parsed: URL;
  try {
    parsed = new URL(input.url, input.baseUrl ?? DEEPSEEK_WEB_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== DEEPSEEK_WEB_ORIGIN) return null;

  const method = input.method.toUpperCase();
  for (const policy of Object.values(DEEPSEEK_WEB_ROUTE_POLICY)) {
    if (parsed.pathname === DEEPSEEK_WEB_ROUTES[policy.route] && method === policy.method) {
      return policy.route;
    }
  }
  return null;
}

export function isDeepSeekAugmentableWebRoute(
  value: unknown,
): value is DeepSeekAugmentableWebRoute {
  return typeof value === 'string' && DEEPSEEK_AUGMENTABLE_WEB_ROUTE_SET.has(value as DeepSeekWebRouteName);
}

export function encodeDeepSeekRouteRequest(
  route: DeepSeekWebRouteName,
  init: Omit<RequestInit, 'method'>,
  options: EncodeDeepSeekRouteRequestOptions = {},
): EncodedDeepSeekRequest {
  const url = createDeepSeekRouteUrl(route, options.baseUrl);
  for (const [name, value] of Object.entries(options.searchParams ?? {})) {
    url.searchParams.set(name, value);
  }
  return {
    url: url.href,
    init: {
      ...init,
      method: DEEPSEEK_WEB_ROUTE_POLICY[route].method,
    },
  };
}

export function encodeCreateSessionRequest(
  clientHeaders: Record<string, string>,
): EncodedDeepSeekRequest {
  return encodeDeepSeekRouteRequest('createSession', {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...clientHeaders },
    body: JSON.stringify({}),
  });
}

export function encodePowChallengeRequest(
  clientHeaders: Record<string, string>,
  targetPath: string,
): EncodedDeepSeekRequest {
  return encodeDeepSeekRouteRequest('powChallenge', {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ target_path: targetPath }),
  });
}

export function encodeCompletionRequest(
  input: DeepSeekCompletionRequestInput,
): EncodedDeepSeekRequest {
  return encodeDeepSeekRouteRequest('completion', {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      [DEEPSEEK_BYPASS_HOOK_HEADER]: '1',
      ...input.clientHeaders,
      ...input.powHeaders,
    },
    body: JSON.stringify({
      chat_session_id: input.chatSessionId,
      parent_message_id: input.parentMessageId,
      model_type: normalizeDeepSeekModelType(input.modelType),
      prompt: input.prompt,
      ref_file_ids: input.refFileIds,
      thinking_enabled: input.thinkingEnabled,
      search_enabled: input.searchEnabled,
      action: null,
      preempt: false,
    }),
  });
}

export function encodeHistoryRequest(
  chatSessionId: string,
  clientHeaders: Record<string, string>,
): EncodedDeepSeekRequest {
  return encodeDeepSeekRouteRequest('history', {
    credentials: 'include',
    headers: { accept: 'application/json', ...clientHeaders },
  }, { searchParams: { chat_session_id: chatSessionId } });
}

export interface DeepSeekUploadRequestInput {
  /** Complete multipart/form-data body, already serialized by src/upload.ts. */
  body: Uint8Array;
  /** Full Content-Type including the generated boundary. */
  contentType: string;
  /**
   * Byte count of the file part content. Sent as x-file-size, which the real
   * upload carries. Defaults to the body length when omitted.
   */
  fileSize?: number;
  /** PoW headers for the upload route; see the note on encodeUploadFileRequest. */
  powHeaders: Record<string, string>;
  /** Model/thinking hints the web client sends alongside an upload. */
  modelType?: string | null;
  thinkingEnabled?: boolean;
  clientHeaders: Record<string, string>;
}

/**
 * Encodes the file upload route.
 *
 * Header set is taken from a captured successful upload (HTTP 200) rather than
 * inferred. Three things matter here:
 *
 *   1. The upload route carries its OWN proof-of-work. The captured
 *      x-ds-pow-response payload names `/api/v0/file/upload_file` as its
 *      target_path, so a completion-route PoW cannot be reused — the caller
 *      must solve one for this path. Omitting it is answered with
 *      40300 MISSING_HEADER, which names the wrong cause.
 *   2. x-file-size is the file's byte count, not the multipart envelope size.
 *   3. x-model-type / x-thinking-enabled are sent even though no model reply
 *      is requested; they default to `default` and `0`.
 *
 * The caller owns the body: multipart framing and the boundary live in
 * src/upload.ts. Any supplied header that would misdescribe that body
 * (content-type, content-length) is dropped and replaced.
 */
export function encodeUploadFileRequest(
  input: DeepSeekUploadRequestInput,
): EncodedDeepSeekRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.clientHeaders)) {
    const lowered = name.toLowerCase();
    if (lowered === 'content-type' || lowered === 'content-length') continue;
    headers[name] = value;
  }
  headers['content-type'] = input.contentType;
  headers['x-file-size'] = String(input.fileSize ?? input.body.byteLength);
  headers['x-model-type'] = normalizeDeepSeekModelType(input.modelType ?? null);
  headers['x-thinking-enabled'] = input.thinkingEnabled ? '1' : '0';

  return encodeDeepSeekRouteRequest('uploadFile', {
    credentials: 'include',
    headers: { ...headers, ...input.powHeaders },
    body: input.body,
  });
}

/** Encodes the file metadata lookup route used to poll upload status. */
export function encodeFetchFilesRequest(
  fileIds: string[],
  clientHeaders: Record<string, string>,
): EncodedDeepSeekRequest {
  return encodeDeepSeekRouteRequest('fetchFiles', {
    credentials: 'include',
    headers: { accept: 'application/json', ...clientHeaders },
  }, { searchParams: { file_ids: fileIds.join(',') } });
}

export function normalizeDeepSeekModelType(modelType: string | null): string {
  if (!modelType) return DEFAULT_MODEL_TYPE;
  if (SUPPORTED_MODEL_TYPES.has(modelType)) return modelType;
  if (modelType === 'chat' || modelType === 'deepseek_chat') return DEFAULT_MODEL_TYPE;
  if (modelType === 'reasoner' || modelType === 'deepseek_reasoner') return 'expert';
  return DEFAULT_MODEL_TYPE;
}

export function normalizeDeepSeekMessageId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xFFFFFFFF) {
    return value;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xFFFFFFFF ? parsed : null;
}

export function buildDeepSeekWebSessionUrl(chatSessionId: string): string {
  return `${DEEPSEEK_WEB_ORIGIN}/a/chat/s/${chatSessionId}`;
}
