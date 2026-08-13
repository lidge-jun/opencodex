import { gunzipSync, inflateRawSync, inflateSync, zstdDecompressSync } from "node:zlib";
import type { TranslatorBudget } from "../lib/translator-budget";

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

function declaredBodyLength(req: Request): number | null {
  const raw = req.headers.get("content-length");
  if (raw === null || raw.trim() === "") return null;
  const length = Number(raw);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

function cancelStreamWithoutWaiting(stream: ReadableStream<Uint8Array> | null, reason: unknown): void {
  if (!stream || stream.locked) return;
  try {
    void stream.cancel(reason).catch(() => undefined);
  } catch {
    // A non-standard stream may throw synchronously from cancel().
  }
}

function cancelReaderWithoutWaiting(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): void {
  // Request.clone() tees can leave cancel() pending until the other branch
  // drains. Cancellation must never extend this reader's own admission bound.
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // A non-standard reader may throw synchronously from cancel().
  }
}

async function readRequestBodyBytesCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) {
    cancelStreamWithoutWaiting(body, signal.reason);
    throw signal.reason;
  }
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  // Keep one geometric buffer instead of one object per transport chunk. A
  // hostile peer can fragment a bounded payload into arbitrarily many chunks.
  let retained = new Uint8Array(Math.min(maxBytes, 64 * 1024));
  let retainedBytes = 0;
  let aborted = false;
  let abortReason: unknown;
  let cancellationStarted = false;
  const cancel = (reason: unknown): void => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    cancelReaderWithoutWaiting(reader, reason);
  };
  const onAbort = (): void => {
    aborted = true;
    abortReason = signal?.reason;
    cancel(abortReason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // Close the narrow race between the preflight check and listener install.
  if (signal?.aborted) onAbort();

  try {
    while (true) {
      if (aborted) throw abortReason;
      const { value, done } = await reader.read();
      // cancel() can resolve a pending read as EOF. Preserve the caller's
      // original abort reason instead of misclassifying that as a clean body.
      if (aborted) throw abortReason;
      if (done) {
        return retainedBytes === retained.byteLength
          ? retained
          : retained.slice(0, retainedBytes);
      }
      if (!value || value.byteLength === 0) continue;

      if (value.byteLength > maxBytes - retainedBytes) {
        const error = new DecompressedBodyTooLargeError(retainedBytes + value.byteLength, maxBytes);
        cancel(error);
        throw error;
      }

      const required = retainedBytes + value.byteLength;
      if (required > retained.byteLength) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(retained.byteLength * 2, required)));
        grown.set(retained.subarray(0, retainedBytes));
        retained = grown;
      }
      retained.set(value, retainedBytes);
      retainedBytes = required;
    }
  } catch (error) {
    const failure = aborted ? abortReason : error;
    cancel(failure);
    throw failure;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A pending cancellation can retain the lock briefly; never await it.
    }
  }
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

/**
 * Parse a bounded JSON request body, transparently decoding compressed payloads.
 *
 * `options.signal`, when provided, replaces `req.signal` rather than composing with
 * it. Callers that need both (for example request disconnect plus a deadline) must
 * merge them into one AbortSignal before calling.
 */
export async function readBoundedJsonRequestBody(
  req: Request,
  maxBytes: number,
  budget?: TranslatorBudget,
  options?: { emptyBodyFallback?: unknown; signal?: AbortSignal },
): Promise<unknown> {
  const encoding = req.headers.get("content-encoding");
  const declaredLength = declaredBodyLength(req);
  // Reject an honest oversized declaration before reading. Missing, malformed,
  // and dishonest declarations remain bounded by the streaming reader below.
  if (declaredLength !== null && declaredLength > maxBytes) {
    const error = new DecompressedBodyTooLargeError(declaredLength, maxBytes);
    cancelStreamWithoutWaiting(req.body, error);
    throw error;
  }
  const releaseReservation = budget && declaredLength !== null && declaredLength > 0
    ? budget.observeAcceptedRequestCopy(declaredLength)
    : undefined;
  let raw: Uint8Array;
  try {
    raw = await readRequestBodyBytesCapped(req.body, maxBytes, options?.signal ?? req.signal);
  } finally {
    releaseReservation?.();
  }
  assertBodySizeWithinLimit(raw, maxBytes);
  const releaseRaw = budget?.observeAcceptedRequestCopy(raw.byteLength);
  let releaseDecoded: (() => void) | undefined;
  let releaseText: (() => void) | undefined;
  try {
    const decoded = decodeRequestBody(raw, encoding, maxBytes);
    releaseDecoded = decoded === raw ? undefined : budget?.observeAcceptedRequestCopy(decoded.byteLength);
    const text = new TextDecoder().decode(decoded);
    releaseText = budget?.observeAcceptedRequestCopy(new TextEncoder().encode(text).byteLength);
    if (options && "emptyBodyFallback" in options && text.trim() === "") {
      return options.emptyBodyFallback;
    }
    const parsed = JSON.parse(text);
    budget?.observeAcceptedRequestCopy(new TextEncoder().encode(JSON.stringify(parsed)).byteLength);
    return parsed;
  } finally {
    releaseText?.();
    releaseDecoded?.();
    releaseRaw?.();
  }
}

/** Parse a JSON data-plane body using the shared 256 MiB admission cap. */
export function readJsonRequestBody(req: Request, budget?: TranslatorBudget): Promise<unknown> {
  return readBoundedJsonRequestBody(req, MAX_DECOMPRESSED_BODY_BYTES, budget);
}
