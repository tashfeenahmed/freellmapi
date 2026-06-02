import { randomBytes } from 'crypto';

function detectContentType(filename: string): string {
  if (filename.endsWith('.json')) return 'application/json';
  if (filename.endsWith('.env') || filename.endsWith('.js')) return 'text/plain';
  return 'application/octet-stream';
}

export interface MultipartFile {
  filename: string;
  content: string | Buffer;
  contentType?: string;
}

export interface MultipartBody {
  body: Buffer;
  headers: {
    'Content-Type': string;
  };
}

/**
 * Creates a multipart/form-data request body compatible with Express 5 multer.
 *
 * Generates a proper multipart body with a unique boundary string.
 * Only uses Node.js built-in modules — no external dependencies.
 *
 * @example
 * ```typescript
 * const { body, headers } = createMultipartBody({
 *   filename: 'keys.env',
 *   content: 'GROQ_KEY=gsk_test123',
 *   contentType: 'text/plain',
 * });
 * const res = await fetch(url, { method: 'POST', headers, body });
 * ```
 */
export function createMultipartBody(file: MultipartFile): MultipartBody {
  const boundary = `----TestBoundary${randomBytes(8).toString('hex')}`;
  const contentType = file.contentType ?? detectContentType(file.filename);
  const content = typeof file.content === 'string'
    ? Buffer.from(file.content, 'utf-8')
    : file.content;

  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
    `Content-Type: ${contentType}\r\n` +
    `\r\n`
  );

  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

  const body = Buffer.concat([header, content, footer]);

  return {
    body,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}
