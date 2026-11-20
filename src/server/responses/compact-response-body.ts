import { formatErrorResponse } from "../../bridge/errors";
import { formatClientRetryAfter } from "../../lib/client-retry-after";
import { carryReplayRefusal } from "../../lib/upstream-retry";
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

export function compactResponseTooLargeError(): Response {
  return new Response(JSON.stringify({
    error: {
      message: "Compact response exceeded 32 MiB",
      type: "compact_response_too_large",
      code: "compact_response_too_large",
    },
  }), { status: 502, headers: { "Content-Type": "application/json" } });
}

/**
 * Headers a client needs to back off correctly after a pool rejection. The buffered
 * response is rebuilt from scratch, so anything not listed here is dropped — which is
 * what silently discarded `Retry-After` and the reset hints from a 429 before.
 * Deliberately narrow: no hop-by-hop headers, no content-length (the buffered body sets
 * its own), no cookies.
 */
const COMPACT_PASSTHROUGH_HEADERS = [
  "retry-after",
  "x-codex-primary-reset-at",
  "x-codex-secondary-reset-at",
  "x-codex-tertiary-reset-at",
  // A relayed 3xx keeps its Location so the client can follow it (#914).
  "location",
];

function compactResponseHeaders(upstream: Response): Headers {
  const headers = new Headers({ "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
  for (const name of COMPACT_PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value === null) continue;
    if (name === "retry-after") {
      // Retry advice leaves as an integer this proxy formats, never the upstream bytes.
      const advice = formatClientRetryAfter(value);
      if (advice !== undefined) headers.set(name, advice);
    } else headers.set(name, value);
  }
  return headers;
}

export async function bufferCompactResponse(
  upstream: Response,
  signal: AbortSignal,
  stallTimeoutSec?: number,
  localUpstream?: boolean,
): Promise<Response> {
  const headers = compactResponseHeaders(upstream);
  try {
    if (signal.aborted) {
      // No reader is attached yet. Cancellation must not wait for a broken source's cleanup.
      void upstream.body?.cancel(signal.reason).catch(() => undefined);
      return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    }
    if (!upstream.body) return carryReplayRefusal(upstream, new Response(null, { status: upstream.status, statusText: upstream.statusText, headers }));
    const bytes = await readCompactResponseBytes(upstream, signal, stallTimeoutSec);
    if (signal.aborted) return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    return carryReplayRefusal(upstream, new Response(bytes, { status: upstream.status, statusText: upstream.statusText, headers }));
  } catch (error) {
    if (signal.aborted) return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    if (error instanceof CompactResponseTooLargeError) return carryReplayRefusal(upstream, compactResponseTooLargeError());
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return carryReplayRefusal(upstream, Response.json({ error: {
        message: "Compact response body stalled",
        type: "upstream_stall_timeout",
        code: "upstream_stall_timeout",
      } }, { status: 504 }));
    }
    return carryReplayRefusal(upstream, formatErrorResponse(502, "upstream_error", "Failed to read compact response"));
  }
}
