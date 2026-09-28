import type { Dispatcher } from 'undici';

const MB = 1024 * 1024;

/** The most a JSON answer may hold: model lists and statuses are far smaller. */
export const MAX_JSON_BYTES = 16 * MB;
/** An answer to an image request can carry the image itself. */
export const MAX_IMAGE_BYTES = 128 * MB;
/** An error body is read only for its message. */
export const MAX_ERROR_BYTES = 64 * 1024;
/** The most one streamed run may send, far beyond any real answer. */
export const MAX_STREAM_BYTES = 64 * MB;

/** An answer that is larger than any real one; the app stops reading instead of filling memory. */
export class TooLargeError extends Error {
  readonly code = 'E_TOO_LARGE';

  constructor(readonly limit: number) {
    super(
      `The answer was larger than ${Math.round(limit / MB) || limit} ${limit >= MB ? 'MB' : 'bytes'}, so it was not read.`,
    );
    this.name = 'TooLargeError';
  }
}

type Body = Dispatcher.ResponseData['body'];

/** A response body up to `limit` bytes. A larger one throws TooLargeError and is closed. */
export async function readBytes(body: Body, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > limit) throw new TooLargeError(limit);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** A response body as text, up to `limit` bytes. */
export async function readText(body: Body, limit = MAX_JSON_BYTES): Promise<string> {
  return (await readBytes(body, limit)).toString('utf8');
}

/** The first `limit` bytes of a body as text, for an error message; the rest is dropped. */
export async function readTextStart(body: Body, limit = MAX_ERROR_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const bytes = chunk as Buffer;
    chunks.push(bytes.subarray(0, Math.max(0, limit - size)));
    size += bytes.length;
    if (size >= limit) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}
