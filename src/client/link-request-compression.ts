import { compressedBodyDecodeLimit } from "../server/request-decompress";
import { createInboundBodyBudget, type InboundBodyBudget } from "../server/inbound-body-budget";
import {
  LINK_REQUEST_COMPRESSIBLE_PATHS, LINK_REQUEST_COMPRESSION_MAX_BYTES, LINK_REQUEST_COMPRESSION_MIN_BYTES, LINK_REQUEST_ZSTD_FEATURE,
} from "../link/request-compression";

/**
 * What all bodies being prepared at once may hold: each reserves twice its declared length (its
 * bytes and their zstd form) until the Home answered and the transport flushed it or tore its request down, and a body that does not fit now streams
 * unchanged instead of waiting. Four bodies at the 16 MiB bound fill it.
 */
export const LINK_REQUEST_PREPARE_BUDGET_BYTES = 128 * 1024 * 1024;
export const linkRequestPrepareBudget: InboundBodyBudget = createInboundBodyBudget(LINK_REQUEST_PREPARE_BUDGET_BYTES, 0);

/** One body ready for the link: the caller's bytes and, when it paid off, their zstd form. */
export interface PreparedLinkBody { raw: Uint8Array<ArrayBuffer>; zstd: Uint8Array<ArrayBuffer> | null }

export type LinkBodyCompressor = (raw: Uint8Array) => Promise<Uint8Array>;

/** One-shot zstd, level 3, per body. Never a streaming context reused across bodies. */
export const defaultLinkBodyCompressor: LinkBodyCompressor = raw => Bun.zstdCompress(raw, { level: 3 });

/**
 * Whether a request body may be buffered and compressed: a POST on a route whose Home handler
 * decodes Content-Encoding, carrying no Content-Encoding of its own, with a declared length above
 * the threshold and within the buffering bound. A chunked body (no declared length) streams as is.
 */
export function linkRequestCompressible(url: URL, req: Request, declaredLength: string | null): boolean {
  if (req.method !== "POST" || !req.body || !LINK_REQUEST_COMPRESSIBLE_PATHS.has(url.pathname)) return false;
  if (req.headers.has("content-encoding") || declaredLength === null || !/^\d+$/.test(declaredLength)) return false;
  const length = Number(declaredLength);
  return length > LINK_REQUEST_COMPRESSION_MIN_BYTES && length <= LINK_REQUEST_COMPRESSION_MAX_BYTES;
}

/**
 * Read exactly the declared bytes into one buffer. More than declared is refused, and so is a body
 * that ends cleanly with fewer: forwarding that shorter slice would tell the Home it is complete.
 */
export async function readDeclaredBody(body: ReadableStream<Uint8Array>, declared: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  const out = new Uint8Array(declared);
  let filled = 0;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (next.value.byteLength > declared - filled) throw new RangeError("link request body longer than declared");
      out.set(next.value, filled);
      filled += next.value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* a pending cancel may hold it */ }
  }
  if (filled !== declared) throw new RangeError("link request body shorter than declared");
  return out;
}

/**
 * The zstd form when compression succeeds, saves bytes, and stays within the ratio the Home's
 * decoder admits (`compressedBodyDecodeLimit`, the policy `link-request-zstd/1` names); otherwise
 * null and the raw body goes, which the Home admits under its ordinary limit as before.
 */
export async function compressLinkBody(raw: Uint8Array, compress: LinkBodyCompressor = defaultLinkBodyCompressor): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const out = await compress(raw);
    return out instanceof Uint8Array && out.byteLength > 0 && out.byteLength < raw.byteLength
      && raw.byteLength <= compressedBodyDecodeLimit(out.byteLength, Number.POSITIVE_INFINITY) ? out as Uint8Array<ArrayBuffer> : null;
  } catch {
    return null;
  }
}

/** The body for one connection, given the features its Home just named. */
export function chooseLinkBody(prepared: PreparedLinkBody, homeFeatures: readonly string[] | null): { body: Uint8Array<ArrayBuffer>; headers: Record<string, string> } {
  if (prepared.zstd && homeFeatures?.includes(LINK_REQUEST_ZSTD_FEATURE)) {
    return { body: prepared.zstd, headers: { "content-encoding": "zstd", "content-length": String(prepared.zstd.byteLength) } };
  }
  return { body: prepared.raw, headers: { "content-length": String(prepared.raw.byteLength) } };
}
