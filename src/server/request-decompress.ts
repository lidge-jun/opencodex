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

/**
 * Hard ceiling on the opt-in `maxInboundBodyBytes` (#3573).
 *
 * The opt-in exists because a 922k-token session serializes past the 256 MiB default, and the
 * request that crosses it is the compaction request itself — so the session can no longer
 * shrink and is stuck. An UNBOUNDED inbound cap is not an acceptable answer: this admission
 * limit is the only thing standing between one request and the process heap, and
 * `readBoundedJsonRequestBody` materializes the body several times over (retained wire bytes,
 * decoded bytes, the decoded string, the re-encoded measurement copies, and the parsed object
 * graph), so peak RSS is a MULTIPLE of whatever is admitted here. 512 MiB is the largest value
 * that keeps that multiple survivable on an ordinary machine, and it is what #3573 asked for.
 */
export const MAX_CONFIGURABLE_INBOUND_BODY_BYTES = 512 * 1024 * 1024;

/** Floor for the opt-in. Below this an ordinary multi-image turn cannot be admitted at all. */
export const MIN_CONFIGURABLE_INBOUND_BODY_BYTES = 1024 * 1024;

/**
 * Resolve the configured inbound admission limit, clamped to the supported range.
 *
 * Pure and total on purpose: the schema in `src/config.ts` degrades an invalid hand edit to
 * `undefined` rather than failing the parse, so the schema cannot be the place the ceiling is
 * enforced. Every caller resolves through here, which makes this the single auditable bound
 * regardless of how the config object was produced.
 *
 * Omitted, zero, or non-finite = the 256 MiB default, so an unconfigured proxy admits exactly
 * what it admits today.
 */
export function resolveInboundBodyLimitBytes(configured: number | undefined): number {
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
    return MAX_DECOMPRESSED_BODY_BYTES;
  }
  return Math.min(
    Math.max(Math.floor(configured), MIN_CONFIGURABLE_INBOUND_BODY_BYTES),
    MAX_CONFIGURABLE_INBOUND_BODY_BYTES,
  );
}

/**
 * Render a byte count, or nothing at all. `DecompressedBodyTooLargeError` accepts non-finite
 * and untyped values from legacy callers and deliberately keeps them out of its own message;
 * the client-facing message inherits that rule rather than printing `NaN MB`.
 */
function megabytes(bytes: number): string | null {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= Number.MAX_SAFE_INTEGER
    ? (bytes / (1024 * 1024)).toFixed(1)
    : null;
}

const INBOUND_CEILING_MB = (MAX_CONFIGURABLE_INBOUND_BODY_BYTES / (1024 * 1024)).toFixed(1);


export class UnsupportedContentEncodingError extends Error {
  constructor(readonly encoding: string) {
    super(`Unsupported content-encoding: ${encoding}`);
  }
}

export type BodySizeMeasurement =
  | "declared_wire"
  | "observed_wire_lower_bound"
  | "decoded_exact"
  | "decoded_lower_bound";

export class DecompressedBodyTooLargeError extends Error {
  readonly measurement: BodySizeMeasurement | null;

  constructor(
    readonly bytes: number,
    readonly limit: number = MAX_DECOMPRESSED_BODY_BYTES,
    measurement: BodySizeMeasurement | null = null,
  ) {
    // Legacy callers supply no provenance. Only fixed categories and finite
    // numbers may reach the public message, including calls from untyped code.
    const category = measurement === "declared_wire" || measurement === "observed_wire_lower_bound"
      || measurement === "decoded_exact" || measurement === "decoded_lower_bound"
      ? measurement : null;
    const suffix = category !== null && Number.isFinite(bytes) && bytes >= 0
      && Number.isFinite(limit) && limit >= 0
      ? ` [measurement=${category}; bytes=${bytes}]` : "";
    super(`Decompressed request body exceeds ${Number.isFinite(limit) ? limit : "unknown"} bytes${suffix}`);
    this.measurement = category;
  }
}

/**
 * Name OpenCodex as the refuser, and name the lever.
 *
 * #4112 gave the UPSTREAM context refusal on `/v1/responses` its own HTTP 413 with
 * `context_length_exceeded`. That makes the two 413s on this surface look alike to a client
 * while having opposite remedies: the upstream one means the provider will not take the turn,
 * this one means the proxy never read it and a config key would have let it through. The
 * wording deliberately avoids "context window"/"context length", which `classifyError` treats
 * as evidence of an upstream context verdict.
 */
export function describeInboundBodyRefusal(error: DecompressedBodyTooLargeError): string {
  // A lower-bound measurement stopped counting at the cap; reporting it as exact would be a lie.
  const approximate = error.measurement === "declared_wire" || error.measurement === "decoded_exact"
    ? "" : "at least ";
  const observed = megabytes(error.bytes);
  const limit = megabytes(error.limit);
  const sizes = limit === null
    ? "the body is above the inbound admission limit"
    : observed === null
      ? `the body is above the ${limit} MB inbound admission limit`
      : `the body is ${approximate}${observed} MB, above the ${limit} MB inbound admission limit`;
  return `OpenCodex refused this request before reading it: ${sizes}. `
    + "This is a local proxy limit, not a provider refusal. Raise \"maxInboundBodyBytes\" in "
    + `config.json (ceiling ${INBOUND_CEILING_MB} MB) and restart the proxy, or compact the `
    + "conversation earlier.";
}

function assertBodySizeWithinLimit(
  body: Uint8Array,
  maxBytes: number,
  measurement: BodySizeMeasurement = "decoded_exact",
): Uint8Array {
  if (body.byteLength > maxBytes) throw new DecompressedBodyTooLargeError(body.byteLength, maxBytes, measurement);
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
        const error = new DecompressedBodyTooLargeError(retainedBytes + value.byteLength, maxBytes, "observed_wire_lower_bound");
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
      // Inflation stopped at the cap; the full decoded size was never measured.
      throw new DecompressedBodyTooLargeError(maxBytes + 1, maxBytes, "decoded_lower_bound");
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
    const error = new DecompressedBodyTooLargeError(declaredLength, maxBytes, "declared_wire");
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
  assertBodySizeWithinLimit(raw, maxBytes, "observed_wire_lower_bound");
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

/**
 * Parse a JSON data-plane body using the shared admission cap.
 *
 * `maxBytes` is the resolved per-deployment limit from `resolveInboundBodyLimitBytes()`;
 * omitting it keeps the 256 MiB default for callers with no config in scope.
 */
export function readJsonRequestBody(
  req: Request,
  budget?: TranslatorBudget,
  maxBytes: number = MAX_DECOMPRESSED_BODY_BYTES,
): Promise<unknown> {
  return readBoundedJsonRequestBody(req, maxBytes, budget);
}
