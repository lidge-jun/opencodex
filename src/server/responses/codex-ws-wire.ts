import { MAX_CLIENT_SSE_FRAME_BYTES } from "../sse-frame-buffer";
// If the 101 never arrives (network black hole), give SSE a chance well before
// the caller's connect timeout (default 200s) would fire.
export const UPGRADE_DEADLINE_MS = 10_000;
export const CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS = 30_000;
// Keep the push-based WS transport inside the same memory envelope as the
// bounded SSE relays that consume this response. Unlike fetch response bodies,
// a WebSocket cannot be paused when a ReadableStream applies backpressure, so
// an upstream that outruns the consumer must be disconnected.
export const MAX_CODEX_WS_FRAME_BYTES = MAX_CLIENT_SSE_FRAME_BYTES;
export const MAX_CODEX_WS_QUEUE_BYTES = 8 * 1024 * 1024;
// The backend drops any inbound message of 16 MiB or more: it closes the socket
// (1009) without a Responses terminal event, which reaches clients as a bare
// 502 upstream_server_error. Measured against the live endpoint 2026-08-23:
// 16,777,000 B completed, 16,777,300 B closed in ~1s, every time. The same
// request body succeeds over HTTP SSE, so the ceiling belongs to this transport
// alone (see #2426). A full-replay thread reaches it with ~11 pasted
// screenshots, and then never recovers, because each retry resends the frame.
export const MAX_CODEX_WS_CREATE_FRAME_BYTES = 16 * 1024 * 1024;
// Bun frames the payload it is handed, so the send-side budget is the JSON text
// itself, and nothing is appended between the check and the send. The margin is
// a conservative cushion, not a computed requirement: it covers RFC 6455 frame
// overhead in case the backend counts it (14 bytes at this payload size — an
// 8-byte extended length plus a 4-byte client mask, leaving ~65.5 KiB spare),
// and it leaves room for a future caller that appends to the frame.
const CODEX_WS_CREATE_FRAME_MARGIN_BYTES = 64 * 1024;
export const CODEX_WS_CREATE_FRAME_LIMIT_BYTES =
  MAX_CODEX_WS_CREATE_FRAME_BYTES - CODEX_WS_CREATE_FRAME_MARGIN_BYTES;
/** Close code the backend uses for an oversized message (RFC 6455 "message too big"). */
const WS_CLOSE_MESSAGE_TOO_BIG = 1009;

const codexWsUpstreamResponses = new WeakSet<Response>();
const quotaObservedResponses = new WeakSet<Response>();

/** Quota arrived directly at its captured account; do not replay old HTTP prelude headers. */
export function isCodexWsQuotaObservedResponse(response: Response): boolean {
  return quotaObservedResponses.has(response);
}

/** True only for a successful Codex WebSocket upgrade, never an HTTP fallback. */
export function isCodexWsUpstreamResponse(response: Response): boolean {
  return codexWsUpstreamResponses.has(response);
}


export function markCodexWsResponse(response: Response, observed: boolean): void {
  codexWsUpstreamResponses.add(response);
  if (observed) quotaObservedResponses.add(response);
}

const CLOSED_BEFORE_TERMINAL = "codex websocket closed before a Responses terminal event";

export type ResponsesWsRelayEvent = {
  type: string;
  text: string;
  payload: Record<string, unknown>;
};

/**
 * Responses WebSocket uses `response.done` as its terminal event, while the
 * SSE Responses surface uses status-specific terminal events. Normalize the
 * WS-only discriminator before relaying so the existing SSE consumers can
 * settle the turn and the socket close cannot be mistaken for a drop. Unknown
 * or missing status values fail closed instead of being reported as success.
 */
export function normalizeResponsesWsRelayEvent(text: string): ResponsesWsRelayEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.type !== "string") return null;
  // A native error may be pretty-printed JSON. SSE prefixes one data line;
  // embedded physical newlines would otherwise truncate the JSON for readers.
  if (record.type !== "response.done") return {
    type: record.type, text: /[\r\n]/.test(text) ? JSON.stringify(record) : text, payload: record,
  };

  const response = record.response;
  const status = response && typeof response === "object" && !Array.isArray(response)
    ? (response as Record<string, unknown>).status
    : undefined;
  const type = status === "completed"
    ? "response.completed"
    : status === "failed"
      ? "response.failed"
      : status === "incomplete" || status === "cancelled"
        ? "response.incomplete"
        : "response.failed";
  const normalizedRecord: Record<string, unknown> = { ...record, type };
  if (type === "response.failed" && status !== "failed") {
    normalizedRecord.response = response && typeof response === "object" && !Array.isArray(response)
      ? { ...(response as Record<string, unknown>), status: "failed" }
      : { status: "failed" };
  }
  return { type, text: JSON.stringify(normalizedRecord), payload: normalizedRecord };
}

/**
 * The close code is the only thing that separates "the backend refused this
 * payload" from "the network dropped", and both used to reach the caller as the
 * same bare 502. Naming the oversized case here puts that distinction in the
 * message the client receives.
 *
 * It does NOT reach the request log as a typed code. The eager relay turns any
 * stream error into a generic `upstream_reset` synthetic terminal
 * (`relay.ts`, `relay-eager.ts`) without feeding that frame back through the
 * inspector, so `/api/logs` keeps neither this message nor a specific code —
 * only `streamAborted`. Machine-readable typing would mean changing the error
 * taxonomy, which is deliberately out of scope for this transport fix.
 */
export function closedBeforeTerminalMessage(event: unknown): string {
  const detail = event as { code?: unknown; reason?: unknown } | null | undefined;
  const code = typeof detail?.code === "number" ? detail.code : null;
  const reason = typeof detail?.reason === "string" ? detail.reason.trim() : "";
  if (code === null) return CLOSED_BEFORE_TERMINAL;
  const suffix = reason ? ` ${code} ${reason}` : ` ${code}`;
  if (code === WS_CLOSE_MESSAGE_TOO_BIG) {
    return `codex websocket rejected the request frame as too large (close${suffix});`
      + ` requests at or above ${MAX_CODEX_WS_CREATE_FRAME_BYTES} bytes must use the HTTP SSE transport`;
  }
  return `${CLOSED_BEFORE_TERMINAL} (close${suffix})`;
}

/**
 * True when the `response.create` frame is at or above the backend's inbound
 * message ceiling, so this turn must take the HTTP SSE path instead.
 *
 * Sizing a 16 MiB string should not cost a 16 MiB copy. UTF-8 never encodes
 * below one byte per UTF-16 code unit and never above three, so both tails are
 * settled from the string length alone; only the narrow band between them pays
 * for a real byte count, and `Buffer.byteLength` measures without allocating.
 */
export function codexWsCreateFrameExceedsLimit(
  frameText: string,
  limitBytes: number = CODEX_WS_CREATE_FRAME_LIMIT_BYTES,
): boolean {
  if (frameText.length >= limitBytes) return true;
  if (frameText.length * 3 < limitBytes) return false;
  return Buffer.byteLength(frameText, "utf8") >= limitBytes;
}
