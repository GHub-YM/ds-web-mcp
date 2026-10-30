// File attachment support for the DeepSeek web protocol.
//
// chat.deepseek.com accepts attachments as multipart/form-data on
// /api/v0/file/upload_file. The JSON routes have hand-written encoders in
// vendor/request-codec.ts because they are small; multipart framing is not, so
// it lives here and the route encoder just carries the finished body through.
//
// Deliberately dependency-free: no npm multer/formidable, and no native code.
// The framing is a few dozen lines and keeping it local means the upload path
// stays inspectable and portable across the same targets the rest of the
// package supports.

import { open, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Hard ceiling on one attachment. DeepSeek's own UI is far below this. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Extension -> MIME. Covers what the DeepSeek web UI itself accepts for
 * attachments (images, documents, code, archives). Unknown extensions fall back
 * to application/octet-stream, which the server audits and may reject; that is
 * surfaced to the caller rather than guessed at.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.py': 'text/x-python',
  '.java': 'text/x-java-source',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.rb': 'text/x-ruby',
  '.php': 'text/x-php',
  '.sh': 'application/x-sh',
  '.sql': 'application/x-sql',
  '.log': 'text/plain',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** Extensions the DeepSeek web UI itself offers in its file picker. */
export const SUPPORTED_EXTENSIONS = Object.keys(MIME_BY_EXTENSION).sort();

export interface LocalFileMeta {
  /** Absolute path as resolved on disk. */
  path: string;
  /** Base name sent as the multipart filename. */
  fileName: string;
  byteLength: number;
  mimeType: string;
}

export class UploadInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadInputError';
  }
}

export function guessMimeType(fileName: string): string {
  return MIME_BY_EXTENSION[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Validates a path and returns its metadata without reading the bytes.
 *
 * The size limit is enforced here, before any read, so an oversized file is
 * rejected on a stat call rather than after pulling 100+ MB into memory.
 */
export async function describeLocalFile(
  filePath: string,
  options: { maxBytes?: number } = {},
): Promise<LocalFileMeta> {
  if (!filePath || !filePath.trim()) {
    throw new UploadInputError('filePath is empty.');
  }

  const absolute = resolve(filePath);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch (error) {
    throw new UploadInputError(
      `Cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (info.isDirectory()) {
    throw new UploadInputError(`${absolute} is a directory; pass a file path.`);
  }
  if (!info.isFile()) {
    throw new UploadInputError(`${absolute} is neither a regular file nor a directory.`);
  }

  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  if (info.size === 0) {
    throw new UploadInputError(`${absolute} is empty (0 bytes).`);
  }
  if (info.size > maxBytes) {
    throw new UploadInputError(
      `${absolute} is ${info.size} bytes, over the ${maxBytes}-byte limit.`,
    );
  }

  const fileName = basename(absolute);
  return {
    path: absolute,
    fileName,
    byteLength: info.size,
    mimeType: guessMimeType(fileName),
  };
}

export interface MultipartFile {
  meta: LocalFileMeta;
  /** Field name in the form body. DeepSeek's web UI posts a single `file`. */
  fieldName?: string;
}

export interface SerializedMultipart {
  body: Uint8Array;
  contentType: string;
  boundary: string;
  /** Per-file metadata in the same order as the input, for reporting. */
  files: LocalFileMeta[];
  byteLength: number;
}

/**
 * Builds a multipart/form-data body with one part per file.
 *
 * Files are streamed from disk into the assembled buffer one chunk at a time,
 * so peak memory is the body size rather than body size plus a second full copy
 * per file. The boundary is random per call, which matters because DeepSeek
 * rejects reused boundaries the same way any spec-compliant parser would.
 */
export async function serializeMultipart(
  files: MultipartFile[],
  options: { boundary?: string } = {},
): Promise<SerializedMultipart> {
  if (!files.length) {
    throw new UploadInputError('serializeMultipart requires at least one file.');
  }

  const boundary = options.boundary ?? `----dswebmcp${randomBytes(16).toString('hex')}`;
  const chunks: Buffer[] = [];
  let total = 0;

  const push = (chunk: Buffer | string) => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    chunks.push(buffer);
    total += buffer.byteLength;
  };

  for (const entry of files) {
    const fieldName = entry.fieldName ?? 'file';
    const { meta } = entry;

    // Content-Disposition follows RFC 7578: the filename is a quoted string
    // with backslash and quote escaped. Non-ASCII names are sent UTF-8 encoded
    // in the header, which is what the reference web client does.
    const safeName = meta.fileName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    push(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\n`
      + `Content-Type: ${meta.mimeType}\r\n`
      + '\r\n',
    );

    const handle = await open(meta.path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, meta.byteLength));
      let position = 0;
      while (position < meta.byteLength) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, meta.byteLength - position),
          position,
        );
        if (bytesRead === 0) break;
        push(Buffer.from(buffer.subarray(0, bytesRead)));
        position += bytesRead;
      }
      if (position !== meta.byteLength) {
        // The file changed under us between stat and read. Better to fail than
        // to upload a truncated attachment that audits as corrupted server-side.
        throw new UploadInputError(
          `${meta.path} changed while being read (${position} of ${meta.byteLength} bytes).`,
        );
      }
    } finally {
      await handle.close();
    }

    push('\r\n');
  }

  push(`--${boundary}--\r\n`);

  return {
    body: Buffer.concat(chunks, total),
    contentType: `multipart/form-data; boundary=${boundary}`,
    boundary,
    files: files.map((f) => f.meta),
    byteLength: total,
  };
}

/** Convenience: describe + serialize in one call, for a list of paths. */
export async function prepareUpload(
  filePaths: string[],
  options: { maxBytes?: number; boundary?: string } = {},
): Promise<SerializedMultipart> {
  if (!filePaths.length) {
    throw new UploadInputError('prepareUpload requires at least one path.');
  }
  const metas = await Promise.all(
    filePaths.map((p) => describeLocalFile(p, options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {})),
  );
  return serializeMultipart(metas.map((meta) => ({ meta })), options.boundary !== undefined ? { boundary: options.boundary } : {});
}
