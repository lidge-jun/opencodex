export class BodyTooLargeError extends Error {
  constructor() {
    super("body_too_large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a request body without ever retaining more than the configured limit.
 * The stream is cancelled as soon as the next chunk would cross the boundary.
 */
export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid_body_limit");
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (value.byteLength > maxBytes - total) throw new BodyTooLargeError();
      total += value.byteLength;
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
