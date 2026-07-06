/**
 * Request-body decompression for the /v1/responses data plane.
 *
 * Codex CLI compresses Responses HTTP bodies with zstd when its
 * `enable_request_compression` feature fires (default ON): auth is the codex
 * backend AND the provider is the built-in `openai` id (codex-rs client.rs
 * responses_request_compression). Under Design B injection the provider id IS
 * `openai`, so the HTTP fallback path (WebSocket unavailable) delivers
 * `content-encoding: zstd` bodies that `req.json()` cannot parse.
 */

/** Cap decompressed request bodies (a compressed bomb must not inflate unbounded). */
export const MAX_DECOMPRESSED_BODY_BYTES = 64 * 1024 * 1024;

export class UnsupportedContentEncodingError extends Error {
  constructor(readonly encoding: string) {
    super(`Unsupported content-encoding: ${encoding}`);
  }
}

export class DecompressedBodyTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Decompressed request body exceeds ${MAX_DECOMPRESSED_BODY_BYTES} bytes`);
  }
}

export function decodeRequestBody(raw: Uint8Array<ArrayBuffer>, contentEncoding: string | null): Uint8Array {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return raw;
  let decoded: Uint8Array;
  if (encoding === "zstd") decoded = Bun.zstdDecompressSync(raw);
  else if (encoding === "gzip" || encoding === "x-gzip") decoded = Bun.gunzipSync(raw);
  else if (encoding === "deflate") decoded = Bun.inflateSync(raw);
  // Multi-codings ("zstd, gzip") and unknown tokens are rejected rather than guessed.
  else throw new UnsupportedContentEncodingError(encoding);
  if (decoded.byteLength > MAX_DECOMPRESSED_BODY_BYTES) throw new DecompressedBodyTooLargeError(decoded.byteLength);
  return decoded;
}

/** Parse a JSON request body, transparently decoding compressed payloads. */
export async function readJsonRequestBody(req: Request): Promise<unknown> {
  const encoding = req.headers.get("content-encoding");
  if (!encoding || encoding.trim().toLowerCase() === "identity") return await req.json();
  const decoded = decodeRequestBody(new Uint8Array(await req.arrayBuffer()), encoding);
  return JSON.parse(new TextDecoder().decode(decoded));
}
