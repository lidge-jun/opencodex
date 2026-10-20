import { Buffer } from "node:buffer";
import { constants, gzipSync, zstdCompressSync } from "node:zlib";
import type { OcxConfig } from "../../types";

/**
 * Opt-in compression of outbound native ChatGPT Responses HTTP request bodies (#7247).
 *
 * Codex re-sends the whole conversation on every turn. When that turn travels over HTTP the body
 * reaches `chatgpt.com` identity-encoded, which on a metered egress is the dominant cost of
 * running Codex through the proxy. The backend already accepts coded request bodies: Codex CLI
 * itself sends `content-encoding: zstd` there (see `src/server/request-decompress.ts`).
 *
 * Applied only at the final HTTP send (`sendWithConnectionPolicy`), after the WebSocket decision
 * and plugin rewrites, so WebSocket frames and every other destination are untouched.
 *
 * Compression is synchronous on purpose. An await at the physical-send boundary would open a gap
 * between dispatch admission (credential selection, attempt receipts, live reserve policy) and the
 * send itself. The cost is bounded instead: bodies above {@link MAX_COMPRESSIBLE_BODY_BYTES} are sent
 * as they are, which keeps the event-loop block to tens of milliseconds on ordinary hardware.
 */
export type UpstreamRequestCompression = "off" | "gzip" | "zstd";

/** Below this the header overhead outweighs any saving. */
export const MIN_COMPRESSIBLE_BODY_BYTES = 1024;
/** Above this the synchronous compression block is no longer negligible; send identity. */
export const MAX_COMPRESSIBLE_BODY_BYTES = 16 * 1024 * 1024;

const CANONICAL_CODEX_RESPONSES = /^https:\/\/chatgpt\.com\/backend-api\/codex\/responses(?:\/compact)?$/;

/** True for the native ChatGPT Responses and compact endpoints, the only compressed destinations. */
export function isCanonicalCodexResponsesUrl(url: string): boolean {
  return CANONICAL_CODEX_RESPONSES.test(url);
}

/** Anything other than an explicit codec, including a malformed hand edit, means off. */
export function resolveUpstreamRequestCompression(value: unknown): UpstreamRequestCompression {
  return value === "gzip" || value === "zstd" ? value : "off";
}

// The live server config object, installed once at startup by `setLiveStateStoreConfig`. Live
// reconciliation mutates that object in place, so the field is read per send rather than copied.
let boundConfig: Pick<OcxConfig, "upstreamRequestCompression"> | null = null;

export function bindUpstreamRequestCompressionConfig(config: Pick<OcxConfig, "upstreamRequestCompression"> | null): void {
  boundConfig = config;
}

export function currentUpstreamRequestCompression(): UpstreamRequestCompression {
  return resolveUpstreamRequestCompression(boundConfig?.upstreamRequestCompression);
}

// ArrayBuffer-backed, which is what node:zlib returns and what a fetch BodyInit accepts.
type CodedBytes = Buffer<ArrayBuffer>;
type Compressor = (mode: Exclude<UpstreamRequestCompression, "off">, bytes: Buffer) => CodedBytes;

const defaultCompressor: Compressor = (mode, bytes) => mode === "gzip"
  ? gzipSync(bytes, { level: 1 }) as CodedBytes
  : zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }) as CodedBytes;

let compressor: Compressor = defaultCompressor;
let maxBodyBytes = MAX_COMPRESSIBLE_BODY_BYTES;

/** Test seam: replace the codec (failure injection) and the size ceiling; null restores defaults. */
export function setUpstreamRequestCompressionForTests(next: { compressor?: Compressor | null; maxBodyBytes?: number | null }): void {
  if (next.compressor !== undefined) compressor = next.compressor ?? defaultCompressor;
  if (next.maxBodyBytes !== undefined) maxBodyBytes = next.maxBodyBytes ?? MAX_COMPRESSIBLE_BODY_BYTES;
}

export interface CompressedUpstreamBody {
  body: CodedBytes;
  encoding: Exclude<UpstreamRequestCompression, "off">;
}

/**
 * Compress one final HTTP send body when the operator opted in and the send is eligible.
 *
 * Returns null — send unchanged — for any other destination, a non-string body (an already coded
 * buffer or a stream, which also makes nested passes idempotent), a request that already declares
 * a `content-encoding`, a body outside the size window, or a codec failure. A failure never fails
 * the request: identity is what the proxy sent before this option existed.
 */
export function compressUpstreamRequestBody(
  target: string,
  body: unknown,
  headers: Headers,
  mode: UpstreamRequestCompression = currentUpstreamRequestCompression(),
): CompressedUpstreamBody | null {
  if (mode === "off" || typeof body !== "string" || !isCanonicalCodexResponsesUrl(target)) return null;
  if (headers.has("content-encoding")) return null;
  const size = Buffer.byteLength(body, "utf8");
  if (size < MIN_COMPRESSIBLE_BODY_BYTES || size > maxBodyBytes) return null;
  try {
    return { body: compressor(mode, Buffer.from(body, "utf8")), encoding: mode };
  } catch {
    // Deliberately silent: the error could only describe the body, and identity is still correct.
    return null;
  }
}
