import { readBoundedResponseBytes } from "../../lib/bounded-body";
import { resolveStallTimeoutMs } from "../../stall-timeout";

export const COMPACT_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

export class CompactResponseTooLargeError extends Error {}

export async function readCompactResponseBytes(
  upstream: Response,
  signal?: AbortSignal,
  stallTimeoutSec?: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = Number(upstream.headers.get("content-length"));
  if (!signal?.aborted && Number.isFinite(declaredLength) && declaredLength > COMPACT_RESPONSE_MAX_BYTES) {
    void upstream.body?.cancel("compact_response_too_large").catch(() => undefined);
    throw new CompactResponseTooLargeError();
  }
  // Only non-empty chunks re-arm the body deadline. Keep the compact default bounded
  // even locally, since this read holds an active-turn lease.
  const result = await readBoundedResponseBytes(upstream, {
    signal,
    maxBytes: COMPACT_RESPONSE_MAX_BYTES,
    inactivityTimeoutMs: resolveStallTimeoutMs(stallTimeoutSec),
  });
  if (result.oversized) throw new CompactResponseTooLargeError();
  return result.bytes;
}
