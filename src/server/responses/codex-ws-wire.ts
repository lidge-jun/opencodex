import { normalizeResponsesIncompleteReason } from "../../responses/incomplete-reason";
import { MAX_CLIENT_SSE_FRAME_BYTES } from "../sse-frame-buffer";
import {
  isTransientUpstreamStatus,
  markResponseNonReplayable,
  UPSTREAM_CLOSED_BEFORE_RESPONSE_CODE,
  UPSTREAM_NO_RESPONSE_CODE,
} from "../../lib/upstream-retry";
import { isRateLimitOrQuotaFailureMessage, recognizedUpstreamError } from "../../lib/errors";
import type { RequestFailureCause, RequestFailureStage } from "../../lib/request-failure-model";
import { packageVersion } from "../../lib/package-version";
import { registerProviderResponseProvenance } from "../../providers/request-pacing";
// If the 101 never arrives (network black hole), give SSE a chance well before
// the caller's connect timeout (default 200s) would fire.
export const UPGRADE_DEADLINE_MS = 10_000;
// Liveness while the exchange waits for its first response event. The proxy cannot know
// how long the origin legitimately needs before `response.created` (a multi-image replay
// spends that time in prefill; #4083 measured 30 s), and it is not the party that owns
// the slowness policy — the client holds its own deadline and the operator holds
// `connectTimeoutMs`. What the proxy can decide is whether the peer is still there, and
// WebSocket has a native answer: ping. While waiting, the exchange pings every
// CODEX_WS_LIVENESS_PING_INTERVAL_MS on sockets that expose `ping()`; any inbound frame
// or pong resets the silence clock, and only CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS of
// nothing at all settles the exchange as an origin-silence 504. A peer that never pongs
// keeps exactly the previous 90 s bound; a peer that does can never trip it while alive.
export const CODEX_WS_LIVENESS_PING_INTERVAL_MS = 15_000;
export const CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS = 90_000;
// The pinger keeps running after the commit: a tunnel restart or Wi-Fi rejoin can drop the path
// without a FIN or RST, and codex-rs would wait out its 300 s idle timeout. A peer that has ponged
// and then sends no frame and no pong for this many intervals is gone, and the stream fails so the
// client retries. One missed pong is not a verdict.
export const CODEX_WS_COMMITTED_SILENT_INTERVALS = 2;
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

const codexWsUpstreamResponses = new WeakMap<Response, true>();
const quotaObservedResponses = new WeakMap<Response, true>();
const codexWsPreludeProjections = new WeakMap<Response, true>();
registerProviderResponseProvenance(codexWsUpstreamResponses);
registerProviderResponseProvenance(quotaObservedResponses);
registerProviderResponseProvenance(codexWsPreludeProjections);

/** Quota arrived directly at its captured account; do not replay old HTTP prelude headers. */
export function isCodexWsQuotaObservedResponse(response: Response): boolean {
  return quotaObservedResponses.has(response);
}

/** True only for a successful Codex WebSocket upgrade, never an HTTP fallback. */
export function isCodexWsUpstreamResponse(response: Response): boolean {
  return codexWsUpstreamResponses.has(response);
}

/** Pre-response projection; its headers retain the exchange's prelude snapshot. */
export function markCodexWsPreludeProjection(response: Response): void {
  codexWsPreludeProjections.set(response, true);
}

export function isCodexWsPreludeProjection(response: Response): boolean {
  return codexWsPreludeProjections.has(response);
}

export function markCodexWsResponse(response: Response, observed: boolean): void {
  codexWsUpstreamResponses.set(response, true);
  if (observed) quotaObservedResponses.set(response, true);
}

/**
 * The proxy's own version, stamped onto every stage record so a field report
 * can be tied to the exact build that produced it (#4191). Computed locally
 * with the same package.json IIFE management-api.ts / gui-static.ts use —
 * importing management-api from the transport layer would invert the
 * layering and pull the management surface into every WS exchange.
 */
const OCX_VERSION = packageVersion("0.0.0");

/**
 * The durable form of the stage counters, carried out of the exchange on the
 * resolved Response so the logging layer can persist it without the exchange
 * ever seeing a RequestLogContext (#4191).
 *
 * Everything here is a size, a count, a duration, a boolean, or a semver
 * string: no request body, no header, no account identifier, no conversation
 * text, and no close-reason text can reach a record built by the exchange.
 * `requestBytes` is null on a committed success because the happy path never
 * pays the UTF-8 walk of a megabyte replay frame; it is measured on failure,
 * where its size is the evidence.
 */
export type CodexWsStageRecord = Omit<CodexWsFailureStage, "requestBytes"> & {
  /** UTF-8 size of the create frame; null on the committed-success record. */
  requestBytes: number | null;
  /** Numeric upstream close code when the socket closed; null otherwise. */
  closeCode: number | null;
  /** True when the exchange ran on a pooled, previously used session. */
  reused: boolean;
  /** OpenCodex version that produced this record. */
  ocxVersion: string;
  /** Bun runtime version the exchange gated on. */
  bunVersion: string;
  /**
   * Normalized type of the Responses terminal frame that ended a plain exchange, as the upstream
   * sent it and before any tail this proxy synthesizes (#6740). It is what separates an upstream
   * `error` frame from a genuine `response.failed` when both reach a row as the same synthetic 502.
   * Null when no terminal frame arrived, and on native-control exchanges, which can end on an
   * acknowledgement instead. Records written before it existed read as null.
   */
  terminalEvent: CodexWsTerminalEvent | null;
  /** Wrapper status of a terminal `error` frame ({@link codexWsWrapperStatus}); null otherwise. */
  terminalErrorStatus: number | null;
};

/** The frames a plain exchange ends on, closed so a stage record can never carry free text. */
export const CODEX_WS_TERMINAL_EVENTS = [
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
] as const;
export type CodexWsTerminalEvent = typeof CODEX_WS_TERMINAL_EVENTS[number];

export function isCodexWsTerminalEvent(value: unknown): value is CodexWsTerminalEvent {
  return typeof value === "string" && (CODEX_WS_TERMINAL_EVENTS as readonly string[]).includes(value);
}

/**
 * The HTTP status a Codex WebSocket `error` frame states on its wrapper, or undefined.
 *
 * The backend wraps a failure as `{type:"error", status|status_code, error}` and the native client
 * turns that status into an HTTP error of the same status
 * (codex-rs/codex-api/src/endpoint/responses_websocket.rs map_wrapped_websocket_error_event). Only
 * that contract is read: a top-level integer in 100..599 under exactly one of the two aliases, the
 * same rule the pre-commit rejection projection applies.
 */
export function codexWsWrapperStatus(payload: Record<string, unknown>): number | undefined {
  if (payload.type !== "error") return undefined;
  const hasStatus = Object.hasOwn(payload, "status");
  if (hasStatus === Object.hasOwn(payload, "status_code")) return undefined;
  const status = hasStatus ? payload.status : payload.status_code;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An absent or empty `output` array; anything else may already be visible to the client. */
function emptyOutput(response: Record<string, unknown>): boolean {
  const output = response.output;
  return output === undefined || (Array.isArray(output) && output.length === 0);
}

/**
 * Upper bound on how long an exchange may hold empty lifecycle frames while it waits to see
 * whether the upstream refuses the turn before any output (#6969).
 *
 * Field rows put 97.5% of authoritative refusals within 5 s of the first Responses event and
 * 98.2% within 10 s, with nothing gained after that.
 */
export const CODEX_WS_PRE_OUTPUT_REFUSAL_HOLD_MAX_MS = 10_000;

/**
 * The hold one send may use: at most `maxMs` from the first empty lifecycle frame, and never past
 * `until`, an absolute time.
 */
export interface CodexWsPreOutputRefusalHold {
  maxMs: number;
  until: number;
}

/**
 * The hold for a send starting now. The caller's header deadline (`connectTimeoutMs`) starts no
 * earlier than this, so ending every hold by half of it means a held turn always commits well before
 * that deadline could abort it, however late the first lifecycle frame arrives.
 */
export function codexWsPreOutputRefusalHold(connectMs: number, now = Date.now()): CodexWsPreOutputRefusalHold {
  const half = Math.max(0, Math.floor(connectMs / 2));
  return { maxMs: Math.min(CODEX_WS_PRE_OUTPUT_REFUSAL_HOLD_MAX_MS, half), until: now + half };
}

/**
 * A lifecycle frame that commits nothing the client could see or act on (#6969): created,
 * in-progress or queued, carrying a response object whose output is absent or empty. A snapshot
 * with any output item, an unknown event, or a frame addressed to another stream is not one.
 */
export function isEmptyCodexWsLifecycleEvent(payload: Record<string, unknown>): boolean {
  if (payload.type !== "response.created" && payload.type !== "response.in_progress"
    && payload.type !== "response.queued") return false;
  if (payload.stream_id !== undefined) return false;
  return plainRecord(payload.response) && emptyOutput(payload.response);
}

const QUOTA_REFUSAL_IDENTITIES: ReadonlySet<string> = new Set(["usage_limit_reached", "usage_not_included"]);

/** Quota and rate-limit identities keep their own routing: every `rate_limit*` and `*quota*` name. */
function quotaRefusalIdentity(value: string): boolean {
  const name = value.toLowerCase();
  return QUOTA_REFUSAL_IDENTITIES.has(name) || name.startsWith("rate_limit") || name.includes("quota");
}

/**
 * The status of an authoritative upstream refusal that ended a turn before any output (#6969),
 * or undefined.
 *
 * Only structured evidence counts: a bare `error` frame's single wrapper status (the alias the
 * native client turns into an HTTP error of that status, see {@link codexWsWrapperStatus}), or,
 * with no wrapper alias at all, the recognized overload class; and a `response.failed` with an
 * empty output whose error is the recognized overload class. The status must be a transient
 * gateway status. Message wording never authorizes anything here; it can only veto, so a 5xx whose
 * error names quota or a rate limit keeps the routing it has today.
 */
export function codexWsPreOutputRefusalStatus(payload: Record<string, unknown>): number | undefined {
  if (payload.stream_id !== undefined) return undefined;
  let error: unknown;
  let status: number | undefined;
  if (payload.type === "error") {
    error = payload.error;
    if (error !== undefined && !plainRecord(error)) return undefined;
    const statedAlias = Object.hasOwn(payload, "status") || Object.hasOwn(payload, "status_code");
    status = codexWsWrapperStatus(payload);
    // A malformed or doubled alias is not evidence of anything.
    if (statedAlias && status === undefined) return undefined;
    if (status === undefined && plainRecord(error)) status = recognizedUpstreamError(error)?.httpStatus;
  } else if (payload.type === "response.failed") {
    const response = payload.response;
    if (!plainRecord(response) || !emptyOutput(response)) return undefined;
    error = response.error;
    if (!plainRecord(error)) return undefined;
    status = recognizedUpstreamError(error)?.httpStatus;
  } else {
    return undefined;
  }
  if (status === undefined || !isTransientUpstreamStatus(status)) return undefined;
  if (plainRecord(error)) {
    const { code, type, message } = error;
    if ([code, type, message].some(value => value != null && typeof value !== "string")) return undefined;
    if (typeof code === "string" && quotaRefusalIdentity(code)) return undefined;
    if (typeof type === "string" && quotaRefusalIdentity(type)) return undefined;
    if (typeof message === "string" && isRateLimitOrQuotaFailureMessage(message)) return undefined;
  }
  return status;
}

/**
 * The response ids a frame names, for the exchange's replay-eligibility latch (#6969): the nested
 * `response.id` and the top-level `response_id`. Null when a present id is not a string, which the
 * latch treats as a conflict.
 */
export function codexWsFrameResponseIds(payload: Record<string, unknown>): string[] | null {
  const ids: string[] = [];
  const nested = plainRecord(payload.response) ? payload.response.id : undefined;
  for (const value of [nested, payload.response_id]) {
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    if (!ids.includes(value)) ids.push(value);
  }
  return ids;
}

interface PreOutputRefusalRecord {
  restore: (() => Response) | null;
  outcomeRecorded: boolean;
}

const preOutputRefusals = new WeakMap<Response, PreOutputRefusalRecord>();

/**
 * Register a pre-output refusal projection (#6969): a replayable gateway status standing in for a
 * WebSocket exchange whose upstream refused the turn before any output. `restore` rebuilds the
 * 200 event stream the client would have received without the projection.
 */
export function markCodexWsPreOutputRefusal(projection: Response, restore: () => Response): void {
  preOutputRefusals.set(projection, { restore, outcomeRecorded: false });
}

export function isCodexWsPreOutputRefusal(response: Response): boolean {
  return preOutputRefusals.has(response);
}

/** Record that this projection's account outcome was written, so no later owner writes it again. */
export function noteCodexWsPreOutputRefusalOutcome(response: Response): void {
  const record = preOutputRefusals.get(response);
  if (record) record.outcomeRecorded = true;
}

export function codexWsPreOutputRefusalOutcomeRecorded(response: Response): boolean {
  return preOutputRefusals.get(response)?.outcomeRecorded === true;
}

/**
 * The response the client should receive in place of a projection no recovery replaced: the
 * original event stream, byte for byte. Single use; any other response is returned unchanged.
 */
export function restoreCodexWsPreOutputRefusal(response: Response): Response {
  const record = preOutputRefusals.get(response);
  const restore = record?.restore;
  if (!record || !restore) return response;
  record.restore = null;
  return restore();
}

const codexWsStageByResponse = new WeakMap<Response, CodexWsStageRecord>();
registerProviderResponseProvenance(codexWsStageByResponse);

export function markCodexWsStage(response: Response, record: CodexWsStageRecord): void {
  const current = codexWsStageByResponse.get(response);
  if (current) {
    Object.assign(current, record);
    return;
  }
  codexWsStageByResponse.set(response, record);
}

export function readCodexWsStage(response: Response): CodexWsStageRecord | undefined {
  return codexWsStageByResponse.get(response);
}

export function codexWsOcxVersion(): string {
  return OCX_VERSION;
}

/**
 * The honest settlement for an exchange that sent its create frame and never saw a
 * response event.
 *
 * Before this existed the relay committed a 200 SSE Response and errored its body, on the
 * reasoning that a 5xx could make the pre-stream retry wrapper resend the frame. That
 * reasoning was right about the resend and wrong about the status: it turned "no response"
 * into "a response that failed", removed the code a user agent uses for its own retry
 * policy, and neutered the client's first-byte timeout with chunked headers. The client
 * on the direct path receives a gateway status in this situation and retries under its own
 * policy; this response restores that equivalence. The resend is forbidden by the
 * non-replayable marker instead (see upstream-retry.ts), and the structured code lets the
 * combo failover reach the same verdict after it re-parses the body.
 *
 * 504 is the origin's silence (nothing at all, or nothing but liveness, for the tolerated
 * window); 502 is a transport that closed or misbehaved after the send. Both carry the
 * content-free stage detail in the message and the metadata snapshot in the headers, the
 * same way a refused create does, so quota captured during the prelude is not lost.
 */
export function codexWsPreResponseFailure(status: 502 | 504, message: string, prelude: Headers): Response {
  const headers = new Headers(prelude);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  const code = status === 504 ? UPSTREAM_NO_RESPONSE_CODE : UPSTREAM_CLOSED_BEFORE_RESPONSE_CODE;
  const response = new Response(JSON.stringify({ error: { type: "upstream_error", code, message } }), { status, headers });
  markResponseNonReplayable(response);
  return response;
}

const CLOSED_BEFORE_TERMINAL = "codex websocket closed before a Responses terminal event";

/**
 * Content-free stage record for an exchange that ended without a Responses
 * terminal event (#4191).
 *
 * The field report that drove this could not be told apart from a network
 * outage, because every such failure reached the user as one of two bare
 * sentences. Both are true of a socket that was never answered, a socket that
 * carried only quota control frames, and a socket that died mid-response —
 * three different upstream stories with three different owners. These counters
 * are the smallest set that separates them, and every one of them is a size, a
 * count, or a duration: no request body, no header, no account identifier, and
 * no conversation text can reach a message built from this record.
 */
export type CodexWsFailureStage = {
  /** UTF-8 size of the `response.create` frame this exchange dialled with. */
  requestBytes: number;
  /** True once `ws.send()` returned, so the turn may be executing upstream. */
  sent: boolean;
  /** Frames the socket delivered, of any kind, including ones that did not parse. */
  upstreamFrames: number;
  /** Frames the metadata channel claimed (quota, response metadata). */
  controlFrames: number;
  /** Responses events actually written to the downstream SSE body. */
  relayedEvents: number;
  /** Milliseconds from send to the first upstream frame; null when none arrived. */
  firstFrameMs: number | null;
  /**
   * Milliseconds from send to the first non-control Responses event (a
   * `response.*` or `error` frame the relay would hand downstream); null when
   * none arrived. `firstFrameMs` alone cannot separate "the peer answered with
   * quota metadata and went quiet" from "the peer was still working": the
   * first measures any frame, this one measures the turn's own start (#4191).
   */
  firstResponseMs: number | null;
  /** Milliseconds from send to this failure; null when the failure predates the send. */
  elapsedMs: number | null;
  /** Liveness pings the exchange sent, before and after the first response event. */
  pings: number;
  /** Pongs the peer answered with; zero on a peer that never answers pings. */
  pongs: number;
};

/**
 * Which upstream story the counters tell. Ordered by how much the upstream had
 * committed to, because that is what decides who owns the failure — and, for a
 * future maintainer reading #4191, it is deliberately NOT a fallback-eligibility
 * signal. `no-upstream-frame` does not mean the frame was not accepted; the
 * no-replay-after-send contract in `codex-ws-exchange.ts` stands regardless of
 * what this classifier says.
 */
export type CodexWsFailureCause =
  | "before-send"
  | "no-upstream-frame"
  | "no-response-event"
  | "after-response-started";

export function classifyCodexWsFailure(stage: CodexWsFailureStage): CodexWsFailureCause {
  if (!stage.sent) return "before-send";
  if (stage.relayedEvents > 0) return "after-response-started";
  if (stage.upstreamFrames === 0) return "no-upstream-frame";
  return "no-response-event";
}

/**
 * The same four outcomes said in the shared stage-and-cause vocabulary (#4191).
 *
 * A projection, not a second classifier: {@link classifyCodexWsFailure} stays the one place that
 * reads the counters, and this only restates its answer in the words the durable log, the metrics
 * projection and the HTTP path already use. Without it the WebSocket transport is the one surface
 * whose failures cannot be compared with anything else, which is the reported symptom -- every
 * such failure reached the user as one of two bare sentences.
 *
 * It does not relax the transport's own rule. The stage below reports where the exchange got to,
 * and `resendPermission` agrees that everything past `before-send` is refused. When a socket dies
 * under the send, this stage is what the resend gate is asked with (#4191), so the operator's
 * `retryOnReset` grant is the only way past that refusal, as it is for an HTTP reset.
 */
export const CODEX_WS_FAILURE_PROJECTION = {
  /** The create frame never left, so the origin provably never saw this turn. */
  "before-send": { stage: "pre-header", cause: "transport-unsent" },
  /** The frame left and the socket said nothing at all. The turn may be running upstream. */
  "no-upstream-frame": { stage: "pre-header", cause: "transport-ambiguous" },
  /** Control frames only: the peer is alive and answered, but no Responses event arrived. */
  "no-response-event": { stage: "protocol-prelude", cause: "transport-ambiguous" },
  /** Events already reached the caller, so a resend would duplicate output they have seen. */
  "after-response-started": { stage: "semantic-output", cause: "transport-ambiguous" },
} as const satisfies Record<CodexWsFailureCause, { stage: RequestFailureStage; cause: RequestFailureCause }>;

export function projectCodexWsFailure(
  stage: CodexWsFailureStage,
): { stage: RequestFailureStage; cause: RequestFailureCause } {
  return CODEX_WS_FAILURE_PROJECTION[classifyCodexWsFailure(stage)];
}

const socketDeathStages = new WeakMap<Response, RequestFailureStage>();
registerProviderResponseProvenance(socketDeathStages);

/**
 * Record that a pre-response settle came from the socket closing or failing under the send (#4191),
 * rather than from silence, a refused frame or a local limit.
 *
 * A fact about how the exchange ended, not a grant. The settle is the same non-replayable 502
 * either way; whether the turn may go out once more is the resend gate's question, and only the
 * operator's `retryOnReset` grant can answer it yes.
 */
export function markCodexWsSocketDeath(response: Response, stage: CodexWsFailureStage): void {
  socketDeathStages.set(response, projectCodexWsFailure(stage).stage);
}

/**
 * Where the send stood when its socket died: `pre-header` when nothing came back and
 * `protocol-prelude` when frames arrived but none was a Responses event. Undefined for every other
 * response.
 */
export function codexWsSocketDeathStage(response: Response): RequestFailureStage | undefined {
  return socketDeathStages.get(response);
}

/**
 * Render the stage as a suffix appended to an existing failure message.
 *
 * It is a suffix, not an interpolation, on purpose: the close-code tail these
 * messages already carry is matched as a contiguous substring by the callers
 * and tests that read it, so nothing may be inserted ahead of it.
 */
export function codexWsFailureDetail(stage: CodexWsFailureStage): string {
  const duration = (value: number | null): string => (value === null ? "n/a" : `${value}ms`);
  return ` [cause=${classifyCodexWsFailure(stage)} request=${stage.requestBytes}B`
    + ` sent=${stage.sent ? "yes" : "no"} frames=${stage.upstreamFrames}`
    + ` control=${stage.controlFrames} relayed=${stage.relayedEvents}`
    + ` first-frame=${duration(stage.firstFrameMs)} first-response=${duration(stage.firstResponseMs)}`
    + ` elapsed=${duration(stage.elapsedMs)}`
    + ` pings=${stage.pings} pongs=${stage.pongs}]`;
}

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
  const record = normalizeResponsesIncompleteReason(payload as Record<string, unknown>);
  if (typeof record.type !== "string") return null;
  // A native error may be pretty-printed JSON. SSE prefixes one data line;
  // embedded physical newlines would otherwise truncate the JSON for readers.
  if (record.type !== "response.done") return {
    type: record.type, text: record !== payload || /[\r\n]/.test(text) ? JSON.stringify(record) : text, payload: record,
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
 *
 * When a stage is supplied its detail is appended last, after the close-code
 * tail, so the code and reason stay one contiguous substring.
 */
export function closedBeforeTerminalMessage(event: unknown, stage?: CodexWsFailureStage): string {
  const detail = event as { code?: unknown; reason?: unknown } | null | undefined;
  const code = typeof detail?.code === "number" ? detail.code : null;
  const reason = typeof detail?.reason === "string" ? detail.reason.trim() : "";
  const stageDetail = stage ? codexWsFailureDetail(stage) : "";
  if (code === null) return `${CLOSED_BEFORE_TERMINAL}${stageDetail}`;
  const suffix = reason ? ` ${code} ${reason}` : ` ${code}`;
  if (code === WS_CLOSE_MESSAGE_TOO_BIG) {
    return `codex websocket rejected the request frame as too large (close${suffix});`
      + ` requests at or above ${MAX_CODEX_WS_CREATE_FRAME_BYTES} bytes must use the HTTP SSE transport`
      + stageDetail;
  }
  return `${CLOSED_BEFORE_TERMINAL} (close${suffix})${stageDetail}`;
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
