#!/usr/bin/env node
// MCP stdio server: exposes DeepSeek web (with its built-in web search) as tools.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath, configsMatch, loadConfig, type DsConfig } from './config.ts';
import { DeepSeekWebClient, type ChatTurn, type UploadResult } from './deepseek-client.ts';
import { refreshTokenFromBrowser, TokenRefreshError } from './token-refresh.ts';
import { MAX_UPLOAD_BYTES, SUPPORTED_EXTENSIONS, UploadInputError } from './upload.ts';

const VERSION = '0.3.0';

const server = new McpServer({ name: 'deepseek-web', version: VERSION });

/** Set DS_NO_AUTO_REFRESH=1 to disable silent re-capture. */
const AUTO_REFRESH_DISABLED = process.env.DS_NO_AUTO_REFRESH === '1';

let client: DeepSeekWebClient | null = null;
/** The config the cached client was built from. */
let clientConfig: DsConfig | null = null;

function buildClient(): DeepSeekWebClient {
  return new DeepSeekWebClient(loadConfig());
}

/**
 * Returns the cached client, rebuilding it when the effective config changed.
 *
 * Without this, a credential swapped out-of-band (hand-edited config, an
 * external `ds-web-mcp refresh`) is ignored for the whole process lifetime,
 * because the client captured the old token at construction time.
 *
 * The reload is guarded: if the config is momentarily unreadable (mid-write,
 * partial JSON) the previous client keeps serving rather than the server
 * failing outright.
 */
function getClient(): DeepSeekWebClient {
  let current: DsConfig | null = null;
  let loadError: Error | null = null;
  try {
    current = loadConfig();
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(String(error));
  }

  if (loadError) {
    // Serve from the last good config rather than taking the server down; a
    // missing or half-written file is usually transient.
    if (client) return client;
    throw loadError;
  }

  if (client && configsMatch(clientConfig, current)) return client;

  client = buildClient();
  clientConfig = current;
  return client;
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'DeepSeekAuthError';
}

/**
 * Runs an operation, and on an auth rejection silently re-captures the token
 * from the signed-in browser profile and retries exactly once.
 *
 * The retry is deliberately bounded: one refresh attempt, one retry. If the
 * refreshed credential also fails, the second error surfaces instead of looping.
 */
async function withAuthRefresh<T>(operation: (c: DeepSeekWebClient) => Promise<T>): Promise<T> {
  try {
    return await operation(getClient());
  } catch (error) {
    if (!isAuthFailure(error) || AUTO_REFRESH_DISABLED) throw error;

    let fresh: string;
    try {
      fresh = await refreshTokenFromBrowser();
    } catch (refreshError) {
      if (refreshError instanceof TokenRefreshError) {
        throw new Error(
          'DeepSeek session is unusable and automatic refresh failed.\n'
          + `${refreshError.message}\n`
          + `(original error: ${(error as Error).message})`,
        );
      }
      throw refreshError;
    }

    persistToken(fresh);
    client = buildClient();
    clientConfig = loadConfigSafely();
    return await operation(client);
  }
}

/** Writes a refreshed token back to the config file without dropping other fields. */
function persistToken(token: string): void {
  const path = configPath();
  try {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      existing = { appVersion: '2.5.0', locale: 'zh_CN' };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...existing, token }, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* Windows may ignore POSIX modes */ }
  } catch {
    // The in-memory client stays usable even when the file cannot be written.
  }
}

/** loadConfig that yields null instead of throwing, for cache bookkeeping. */
function loadConfigSafely(): DsConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: `DeepSeek web error: ${message}` }], isError: true };
}

function sessionNote(turn: ChatTurn): string {
  const reasoning = turn.reasoningText.trim();
  const base = `\n\n---\nSession: ${turn.sessionUrl}`;
  return reasoning ? `${base}\n\nThinking:\n${reasoning}` : base;
}

/**
 * Renders uploaded-file metadata for tool output. Ids are shown first and
 * verbatim because they are the values a follow-up `chat` call must carry in
 * `refFileIds`; anything else in the record is supporting detail.
 */
function formatUploads(label: string, files: UploadResult[]): string {
  const lines = files.map((file) => {
    const parts = [
      `  id=${file.id}`,
      `name=${file.fileName ?? 'unknown'}`,
      `size=${file.fileSize ?? 'unknown'}`,
      `type=${file.mimeType ?? 'unknown'}`,
      `status=${file.status ?? 'accepted'}`,
    ];
    if (file.auditResult) parts.push(`audit=${file.auditResult}`);
    if (file.width && file.height) parts.push(`dims=${file.width}x${file.height}`);
    if (file.retryable === true) parts.push('retryable=true');
    return parts.join(' ');
  });
  return `${label}\n${lines.join('\n')}\n\nUse these ids as refFileIds in the chat tool to attach them to a prompt.`;
}

server.registerTool(
  'web_search',
  {
    title: 'DeepSeek web search',
    description:
      'Ask DeepSeek with its web search turned on. Use for current events, prices, releases, '
      + 'or anything requiring up-to-date sources. Returns the answer plus the session link.',
    inputSchema: {
      query: z.string().min(1).describe('The question to research on the live web.'),
      thinking: z.boolean().optional().describe('Enable DeepSeek reasoning mode. Default true.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, thinking }) => {
    try {
      const turn = await withAuthRefresh((c) => c.chat({
        prompt: query,
        searchEnabled: true,
        thinkingEnabled: thinking ?? true,
      }));
      return { content: [{ type: 'text' as const, text: turn.assistantText + sessionNote(turn) }] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'upload_files',
  {
    title: 'Upload files to DeepSeek',
    description:
      'Upload one or more local files (images, PDFs, documents, code, archives) to the '
      + 'DeepSeek account. Returns a file id per upload; pass those ids as refFileIds to '
      + `the chat tool to attach them to a prompt. Max ${MAX_UPLOAD_BYTES} bytes per file.`,
    inputSchema: {
      filePaths: z.array(z.string().min(1)).min(1)
        .describe('Absolute or relative local paths to upload.'),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  },
  async ({ filePaths }) => {
    try {
      const files = await withAuthRefresh((c) => c.uploadFiles(filePaths));
      return { content: [{ type: 'text' as const, text: formatUploads('Uploaded:', files) }] };
    } catch (error) {
      if (error instanceof UploadInputError) {
        return failure(new Error(`${error.message} Supported extensions: ${SUPPORTED_EXTENSIONS.join(', ')}`));
      }
      return failure(error);
    }
  },
);

server.registerTool(
  'list_files',
  {
    title: 'Look up DeepSeek file metadata',
    description:
      'Fetch the server-side metadata for previously uploaded file ids (name, size, '
      + 'mime type, upload status, content-audit verdict). Use to confirm an upload '
      + 'finished or to re-check status before attaching it.',
    inputSchema: {
      fileIds: z.array(z.string().min(1)).min(1).describe('File ids returned by upload_files.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ fileIds }) => {
    try {
      const files = await withAuthRefresh((c) => c.fetchFiles(fileIds));
      return { content: [{ type: 'text' as const, text: formatUploads('Files:', files) }] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'chat',
  {
    title: 'DeepSeek chat',
    description:
      'Send a prompt to DeepSeek. Set search=true to attach live web results. '
      + 'Pass sessionId + parentMessageId to continue an existing conversation.',
    inputSchema: {
      prompt: z.string().min(1).describe('Prompt text.'),
      search: z.boolean().optional().describe('Enable DeepSeek web search. Default false.'),
      thinking: z.boolean().optional().describe('Enable reasoning mode. Default true.'),
      model: z.enum(['default', 'expert', 'vision']).optional()
        .describe('DeepSeek web model type. Default "default".'),
      sessionId: z.string().optional().describe('Existing chat session id to continue.'),
      parentMessageId: z.number().int().nonnegative().optional()
        .describe('Assistant message id to branch from when continuing a session.'),
      refFileIds: z.array(z.string().min(1)).optional()
        .describe('File ids from upload_files to attach to this turn as references.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ prompt, search, thinking, model, sessionId, parentMessageId, refFileIds }) => {
    try {
      const turn = await withAuthRefresh((c) => c.chat({
        prompt,
        searchEnabled: search ?? false,
        thinkingEnabled: thinking ?? true,
        modelType: model ?? null,
        chatSessionId: sessionId ?? null,
        parentMessageId: parentMessageId ?? null,
        refFileIds: refFileIds ?? null,
      }));
      return { content: [{ type: 'text' as const, text: turn.assistantText + sessionNote(turn) }] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'new_session',
  {
    title: 'New DeepSeek session',
    description: 'Create an empty DeepSeek chat session and return its id and URL.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const chatSessionId = await withAuthRefresh((c) => c.createChatSession());
      return {
        content: [{
          type: 'text' as const,
          text: `sessionId: ${chatSessionId}\nurl: https://chat.deepseek.com/a/chat/s/${chatSessionId}`,
        }],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'refresh_token',
  {
    title: 'Refresh DeepSeek token',
    description:
      'Re-capture the DeepSeek bearer token from the signed-in browser profile and save it. '
      + 'Use when another tool reports an auth rejection.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const token = await refreshTokenFromBrowser();
      persistToken(token);
      client = buildClient();
      clientConfig = loadConfigSafely();
      return {
        content: [{
          type: 'text' as const,
          text: `Refreshed: token ${token.length} chars, saved to ${configPath()}.`,
        }],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'diagnose',
  {
    title: 'DeepSeek health check',
    description: 'Report whether the DeepSeek credential is configured and accepted.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const chatSessionId = await withAuthRefresh((c) => c.createChatSession());
      const config = loadConfig();
      return {
        content: [{
          type: 'text' as const,
          text: [
            'OK. Credential accepted.',
            `Config: ${configPath()}`,
            `App version: ${config.appVersion}  Locale: ${config.locale}`,
            `Auto-refresh: ${AUTO_REFRESH_DISABLED ? 'disabled (DS_NO_AUTO_REFRESH=1)' : 'enabled'}`,
            `sessionId: ${chatSessionId}`,
          ].join('\n'),
        }],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
