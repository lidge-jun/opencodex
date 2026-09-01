// Upstream WebSocket transport for the ChatGPT Codex backend.
//
// Why this exists: the Codex backend serves the responses_websockets path from
// a measurably faster queue than the plain SSE POST path. Measured 2026-08-12
// KST (same account, same payload, strictly sequential): gpt-5.6-luna TTFT p50
// ~1.0s over WS vs ~3.9s over SSE. Codex CLI itself defaults to the WS
// transport; opencodex previously always POSTed SSE, which is where its extra
// 2-3s of TTFT came from.
//
// The wrapper only swaps the transport. It dials wss:// with the same headers,
// sends the JSON body as a single `response.create` frame, and re-encodes the
// returned event frames as an SSE byte stream, so every downstream consumer
// (passthrough relay, adapter parsers, usage sniffing) is unchanged.

import { MAX_CLIENT_SSE_FRAME_BYTES } from "../sse-frame-buffer";
import { compareBunVersions } from "../../lib/bun-stream-caps";

const CODEX_RESPONSES_HTTP_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_RESPONSES_WS_URL = "wss://chatgpt.com/backend-api/codex/responses";
const WS_BETA = "responses_websockets=2026-02-06";

/**
 * Dial URL for a request URL. The canonical ChatGPT backend keeps its constant;
 * an operator-opted OpenAI-compatible upstream swaps https for wss on the same
 * path so gateways that serve the Responses WebSocket protocol on their
 * /v1/responses path get the same fast lane. Plain HTTP remains on SSE because
 * a provider WS handshake would otherwise send credentials and request data
 * without transport encryption.
 */
function wsUpstreamUrlFor(httpUrl: string): string {
  if (httpUrl === CODEX_RESPONSES_HTTP_URL) return CODEX_RESPONSES_WS_URL;
  return httpUrl.replace(/^http(s?):/, "ws$1:");
}

/**
 * An operator-opted OpenAI-compatible upstream only joins the WS lane for
 * Responses endpoints: the WebSocket path speaks the Responses event protocol,
 * and every downstream consumer (adapter parsers, usage sniffing, SSE relay)
 * assumes that wire. Other paths (chat completions, images, search) stay HTTP.
 */
function isResponsesWebsocketEligibleUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:"
    && parsed.pathname.endsWith("/responses");
}
// If the 101 never arrives (network black hole), give SSE a chance well before
// the caller's connect timeout (default 200s) would fire.
const UPGRADE_DEADLINE_MS = 10_000;
// Keep the push-based WS transport inside the same memory envelope as the
// bounded SSE relays that consume this response. Unlike fetch response bodies,
// a WebSocket cannot be paused when a ReadableStream applies backpressure, so
// an upstream that outruns the consumer must be disconnected.
export const MAX_CODEX_WS_FRAME_BYTES = MAX_CLIENT_SSE_FRAME_BYTES;
export const MAX_CODEX_WS_QUEUE_BYTES = 8 * 1024 * 1024;
export const MIN_BOUNDED_CODEX_WS_BUN_VERSION = "1.4.0";
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

export type BunRuntimeIdentity = {
  version: string;
  versionWithSha: string;
};

export type BunRuntimeGateInput = string | BunRuntimeIdentity;

const codexWsUpstreamResponses = new WeakSet<Response>();

/** True only for a successful Codex WebSocket upgrade, never an HTTP fallback. */
export function isCodexWsUpstreamResponse(response: Response): boolean {
  return codexWsUpstreamResponses.has(response);
}

export function currentBunRuntimeIdentity(): BunRuntimeIdentity {
  return {
    version: Bun.version,
    versionWithSha: Bun.version_with_sha,
  };
}

function boundedRelayVersion(input: BunRuntimeGateInput): string | null {
  if (typeof input === "string") return input.trim() || null;
  const numericVersion = input.version.trim();
  const numericMatch = /^(\d+\.\d+\.\d+)$/.exec(numericVersion);
  const detailedMatch = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+\([0-9a-fA-F]+\)$/.exec(
    input.versionWithSha.trim(),
  );
  if (!numericMatch || !detailedMatch) return null;
  const detailedNumeric = /^(\d+\.\d+\.\d+)/.exec(detailedMatch[1])?.[1];
  return detailedNumeric === numericMatch[1] ? detailedMatch[1] : null;
}

/**
 * Bun 1.3.14 does not propagate a stalled HTTP response socket back to a JS
 * ReadableStream producer on Windows. A real raw-TCP slow-client probe drained
 * the entire upstream despite the eager relay queue; Bun 1.4.0-canary.1 stopped
 * below one MiB. Prereleases still fail closed; release builds before 1.4.0
 * fall back to HTTP SSE.
 */
export function bunSupportsBoundedCodexWsRelay(
  runtime: BunRuntimeGateInput = currentBunRuntimeIdentity(),
): boolean {
  const version = boundedRelayVersion(runtime);
  if (!version) return false;
  if (/^\d+\.\d+\.\d+-/.test(version.trim())) return false;
  const comparison = compareBunVersions(version, MIN_BOUNDED_CODEX_WS_BUN_VERSION);
  return comparison !== null && comparison >= 0;
}

export function shouldUseCodexWsUpstream(
  url: string,
  init?: RequestInit,
  runtime: BunRuntimeGateInput = currentBunRuntimeIdentity(),
  upstreamWebsocketConfigured = false,
): boolean {
  if (!bunSupportsBoundedCodexWsRelay(runtime)) return false;
  if (url !== CODEX_RESPONSES_HTTP_URL && !upstreamWebsocketConfigured) return false;
  if (upstreamWebsocketConfigured && !isResponsesWebsocketEligibleUrl(url)) return false;
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return false;
  const body = init?.body;
  if (typeof body !== "string") return false;
  // Only root-level stream:true selects WS: JSON-mode calls keep the HTTP path
  // because the WS path only speaks the event protocol, and a nested
  // {"metadata":{"stream":true}} must not flip the transport. Parsing (not
  // substring matching) also keeps whitespace-formatted bodies routable.
  try {
    const parsed = JSON.parse(body) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).stream === true;
  } catch {
    return false;
  }
}

const CLOSED_BEFORE_TERMINAL = "codex websocket closed before a Responses terminal event";

type ResponsesWsRelayEvent = {
  type: string;
  text: string;
};

/**
 * Responses WebSocket uses `response.done` as its terminal event, while the
 * SSE Responses surface uses status-specific terminal events. Normalize the
 * WS-only discriminator before relaying so the existing SSE consumers can
 * settle the turn and the socket close cannot be mistaken for a drop. Unknown
 * or missing status values fail closed instead of being reported as success.
 */
function normalizeResponsesWsRelayEvent(text: string): ResponsesWsRelayEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.type !== "string") return null;
  if (record.type !== "response.done") return { type: record.type, text };

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
  return { type, text: JSON.stringify(normalizedRecord) };
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
function closedBeforeTerminalMessage(event: unknown): string {
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

export function codexWsUpstreamFetch(
  url: string,
  init: RequestInit,
  sseFallback: typeof globalThis.fetch,
  runtime: BunRuntimeGateInput = currentBunRuntimeIdentity(),
): Promise<Response> {
  if (!bunSupportsBoundedCodexWsRelay(runtime)) {
    return sseFallback(url, init);
  }
  const signal = init.signal ?? undefined;
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  }

  let frameText: string;
  try {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // The WS create frame is implicitly streaming; the backend rejects the
    // HTTP-only `stream` flag inside a frame.
    delete body.stream;
    frameText = JSON.stringify({ ...body, type: "response.create" });
  } catch {
    return sseFallback(url, init);
  }

  // Decide before dialing. Once the socket is open the caller already holds a
  // streaming Response, so the oversized close can only be surfaced as a stream
  // error — and a resend at that point could double-generate. Measuring the
  // frame we are about to send keeps the whole failure mode unreachable.
  if (codexWsCreateFrameExceedsLimit(frameText)) {
    return sseFallback(url, init);
  }

  const headers: Record<string, string> = {};
  new Headers(init.headers ?? {}).forEach((value, key) => {
    // HTTP-body framing headers do not apply to a WS handshake.
    if (key === "content-type" || key === "content-length" || key === "accept" || key === "accept-encoding") return;
    headers[key] = value;
  });
  headers["openai-beta"] = headers["openai-beta"]
    ? headers["openai-beta"].includes("responses_websockets")
      ? headers["openai-beta"]
      : `${headers["openai-beta"]}, ${WS_BETA}`
    : WS_BETA;
  // A genuine caller `originator` is already in these headers via the forward
  // set. Never fabricate one here: pool/forward traffic must not impersonate
  // Codex CLI, per the metadata-integrity contract. (The backend's fast lane
  // keys on WS + originator, so callers without the tag simply keep their own
  // provenance and scheduling.)

  return new Promise<Response>((resolve, reject) => {
    let ws: WebSocket;
    try {
      // Bun accepts per-handshake headers; the DOM lib types only list protocol arrays.
      ws = new WebSocket(wsUpstreamUrlFor(url), { headers } as unknown as string[]);
    } catch {
      resolve(sseFallback(url, init));
      return;
    }

    let opened = false;
    let settledPreOpen = false;
    let terminal = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();

    const failStream = (message: string) => {
      if (terminal) return;
      terminal = true;
      try { controller?.error(new Error(message)); } catch { /* stream already done */ }
      try { ws.close(); } catch { /* already closing */ }
    };

    const upgradeTimer = setTimeout(() => {
      if (opened || settledPreOpen) return;
      settledPreOpen = true;
      try { ws.close(); } catch { /* already closing */ }
      resolve(sseFallback(url, init));
    }, UPGRADE_DEADLINE_MS);

    const onAbort = () => {
      if (!opened) {
        if (settledPreOpen) return;
        // Settle BEFORE close(): the close handler treats a pre-open close as
        // an upgrade rejection and would dial the SSE fallback for a request
        // the caller just cancelled.
        settledPreOpen = true;
        clearTimeout(upgradeTimer);
        try { ws.close(); } catch { /* already closing */ }
        reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      if (controller && !terminal) {
        terminal = true;
        // Mirror an aborted fetch: the body read rejects with the abort reason.
        try { controller.error(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")); } catch { /* stream already done */ }
      }
      // Error the body before close(): test doubles and some runtimes dispatch
      // close synchronously, and the caller's abort reason must stay authoritative.
      try { ws.close(); } catch { /* already closing */ }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    ws.addEventListener("open", () => {
      if (settledPreOpen) return;
      clearTimeout(upgradeTimer);
      try {
        ws.send(frameText);
      } catch {
        // send() throwing means the frame never left, so no upstream turn
        // started and the SSE resend cannot double-generate. Falling back
        // (instead of erroring a synthetic 200 body) keeps the pre-stream
        // HTTP error/refresh/failover machinery in charge.
        settledPreOpen = true;
        try { ws.close(); } catch { /* already closing */ }
        resolve(sseFallback(url, init));
        return;
      }
      opened = true;
      const stream = new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
        cancel() { try { ws.close(); } catch { /* already closing */ } },
      }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_CODEX_WS_QUEUE_BYTES }));
      const response = new Response(stream, {
        status: 200,
        // The 101 response headers (x-codex-*-reset-at quota hints) are not
        // exposed by Bun's WebSocket; the periodic quota poller covers those.
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
      codexWsUpstreamResponses.add(response);
      resolve(response);
    });

    ws.addEventListener("message", (event) => {
      if (!controller || terminal) return;
      const text = typeof event.data === "string" ? event.data : "";
      if (!text) return;
      // UTF-8 byte length is always at least the JS string length. Reject this
      // cheap lower bound before parsing so an obviously oversized frame does
      // not create another large object graph.
      if (text.length > MAX_CODEX_WS_FRAME_BYTES) {
        failStream("codex websocket frame exceeds the response size limit");
        return;
      }
      const rawEncodedText = encoder.encode(text);
      if (rawEncodedText.byteLength > MAX_CODEX_WS_FRAME_BYTES) {
        failStream("codex websocket frame exceeds the response size limit");
        return;
      }
      const normalized = normalizeResponsesWsRelayEvent(text);
      if (!normalized) return;
      const { type } = normalized;
      const encodedText = normalized.text === text ? rawEncodedText : encoder.encode(normalized.text);
      if (encodedText.byteLength > MAX_CODEX_WS_FRAME_BYTES) {
        failStream("codex websocket frame exceeds the response size limit");
        return;
      }
      // Relay only the event surface the SSE path produces today. WS-only
      // frames (codex.rate_limits, responsesapi.websocket_timing) are dropped
      // so downstream clients see exactly the stream shape they always got.
      if (!type.startsWith("response.") && type !== "error") return;
      const prefix = encoder.encode(`event: ${type}\ndata: `);
      const suffix = encoder.encode("\n\n");
      const frameBytes = prefix.byteLength + encodedText.byteLength + suffix.byteLength;
      if (frameBytes > MAX_CLIENT_SSE_FRAME_BYTES) {
        failStream("codex websocket frame exceeds the response size limit");
        return;
      }
      const availableBytes = controller.desiredSize ?? 0;
      if (frameBytes > availableBytes) {
        failStream("codex websocket response exceeded the buffered queue limit");
        return;
      }
      const sseFrame = new Uint8Array(frameBytes);
      sseFrame.set(prefix);
      sseFrame.set(encodedText, prefix.byteLength);
      sseFrame.set(suffix, prefix.byteLength + encodedText.byteLength);
      try {
        controller.enqueue(sseFrame);
      } catch {
        failStream("codex websocket response stream closed while enqueueing");
        return;
      }
      if (type === "response.completed" || type === "response.failed" || type === "response.incomplete" || type === "error") {
        terminal = true;
        try { controller.close(); } catch { /* already closed */ }
        try { ws.close(); } catch { /* already closing */ }
      }
    });

    ws.addEventListener("close", (event: unknown) => {
      signal?.removeEventListener("abort", onAbort);
      if (!opened) {
        if (settledPreOpen) return;
        settledPreOpen = true;
        clearTimeout(upgradeTimer);
        // Upgrade rejected (401/403/429/5xx). Retry over plain SSE so the real
        // HTTP status reaches the existing refresh/rotation handlers. No turn
        // started upstream, so the resend cannot double-generate.
        resolve(sseFallback(url, init));
        return;
      }
      if (controller && !terminal) {
        terminal = true;
        // Connection dropped before a Responses terminal event. A clean EOF
        // here would reach clients with no response.completed/failed at all —
        // relaySseWithFailedTail() only synthesizes a failed terminal when the
        // body read THROWS. Error the stream like a reset TCP socket.
        try { controller.error(new Error(closedBeforeTerminalMessage(event))); } catch { /* stream already done */ }
      }
    });

    ws.addEventListener("error", () => {
      /* Bun always follows error with close; the close handler settles. */
    });
  });
}
