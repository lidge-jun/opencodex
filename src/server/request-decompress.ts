import { gunzipSync, inflateRawSync, inflateSync, zstdDecompressSync } from "node:zlib";

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

/**
 * Cap decompressed request bodies (a compressed bomb must not inflate unbounded). Codex compresses
 * EVERY responses request with zstd (no size threshold), and image-heavy histories inflate fast:
 * ~12 full-res screenshots as base64 already cross 64MB decompressed. The proxy is fed by the user's
 * own local Codex over loopback, so the bomb threat is weak; this cap is really an OOM guard. Keep it
 * generous enough that ordinary multi-image sessions decode, while still bounding a runaway body.
 */
export const MAX_DECOMPRESSED_BODY_BYTES = 256 * 1024 * 1024;

export class UnsupportedContentEncodingError extends Error {
  constructor(readonly encoding: string) {
    super(`Unsupported content-encoding: ${encoding}`);
  }
}

export class DecompressedBodyTooLargeError extends Error {
  constructor(readonly bytes: number, limit: number = MAX_DECOMPRESSED_BODY_BYTES) {
    super(`Decompressed request body exceeds ${limit} bytes`);
  }
}

function assertBodySizeWithinLimit(body: Uint8Array, maxBytes: number): Uint8Array {
  if (body.byteLength > maxBytes) throw new DecompressedBodyTooLargeError(body.byteLength, maxBytes);
  return body;
}

function inflateDeflateBody(compressed: Uint8Array<ArrayBuffer>, opts: { maxOutputLength: number }): Uint8Array {
  // HTTP "deflate" appears both zlib-wrapped and raw in the wild (Bun.deflateSync emits raw,
  // which the previous Bun.inflateSync accepted). Try zlib-wrapped first, fall back to raw —
  // but never swallow the size-cap abort.
  try {
    return inflateSync(compressed, opts);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ERR_BUFFER_TOO_LARGE") throw err;
    return inflateRawSync(compressed, opts);
  }
}

export function decodeRequestBody(
  raw: Uint8Array,
  contentEncoding: string | null,
  maxBytes: number = MAX_DECOMPRESSED_BODY_BYTES,
): Uint8Array {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return assertBodySizeWithinLimit(raw, maxBytes);
  const compressed = raw as Uint8Array<ArrayBuffer>;
  // `maxOutputLength` makes zlib abort DURING inflation (ERR_BUFFER_TOO_LARGE), so a
  // decompression bomb never allocates beyond the cap — checking after the fact would
  // already have paid the full allocation (review finding, PR #96).
  const opts = { maxOutputLength: maxBytes };
  let decoded: Uint8Array;
  try {
    if (encoding === "zstd") decoded = zstdDecompressSync(compressed, opts);
    else if (encoding === "gzip" || encoding === "x-gzip") decoded = gunzipSync(compressed, opts);
    else if (encoding === "deflate") decoded = inflateDeflateBody(compressed, opts);
    // Multi-codings ("zstd, gzip") and unknown tokens are rejected rather than guessed.
    else throw new UnsupportedContentEncodingError(encoding);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new DecompressedBodyTooLargeError(maxBytes + 1, maxBytes);
    }
    throw err;
  }
  return assertBodySizeWithinLimit(decoded, maxBytes);
}

/** Parse a JSON request body, transparently decoding compressed payloads. */
export async function readJsonRequestBody(req: Request): Promise<unknown> {
  const encoding = req.headers.get("content-encoding");
  const decoded = decodeRequestBody(new Uint8Array(await req.arrayBuffer()), encoding);
  return JSON.parse(new TextDecoder().decode(decoded));
}
