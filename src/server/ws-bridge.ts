import { isolateCodexPoolAccountHeaders } from "../codex/forward-transport-headers";
import { isUntypedBareUpstreamError } from "./bare-upstream-error";
import type { NativeResponseControl } from "./responses/native-response-control";
import type { HandleResponsesOptions } from "./responses/core-options";
import type { ServerWebSocket } from "bun";
import { responsesJsonEventSequence } from "./responses-json-events";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import type { CodexAuthContext } from "../codex/auth-context";
import { headersForCodexAuthContext } from "../codex/auth-context";
import type { ResponsesTerminalStatus } from "../bridge";
import type { DataPlaneAdmission } from "./auth-cors";
import type { AdmissionLease, AdmissionReservation } from "../lib/admission";
import { BoundedSseFrameBuffer, MAX_CLIENT_SSE_FRAME_BYTES } from "./sse-frame-buffer";
import type { LinkTrafficFlow } from "../link/traffic";
import { sseDataPayload as parseSseBlock } from "./sse-payload-rewrite";
import { safeResponseHeaders } from "./safe-response-headers";
import type { AudioSocketTarget } from "./audio-dictation";
import type { CodexWebSocketActivity } from "../codex/websocket-activity";
import { AGENT_ASSERTION_HEADER } from "../lib/authorization-scheme";
import { isProxyError } from "../lib/client-error-body";
import { WORKFLOW_LOCAL_REFUSAL_HEADER } from "../lib/workflow-budget";
import { NativeContinuationRefusalError } from "./responses/native-continuation-refusal";
import type { UsageClient } from "../usage/client";
import { LINK_WS_LIMITS, linkPumpTimer, linkPumpWaitObserver } from "./index/link-websocket-limits";

export { safeResponseHeaders } from "./safe-response-headers";

const OPEN = 1;
type ResponsesTerminalReporter = (status: ResponsesTerminalStatus) => void;
type ResponsesPayloadObserver = (payload: string) => void;

export interface WsData {
  client?: UsageClient;
  responsesActivity?: CodexWebSocketActivity;
  nativeControl?: NativeResponseControl;
  /** Content-free per-turn explanation; never a model capability assertion. */
  nativeSteeringUnavailable?: string;
  headers?: Headers; // base inbound forward headers only; per-turn auth refresh injects current pool tokens
  /**
   * Resolved once at the handshake. Auth is handshake-time only on this path, so
   * the per-frame log contexts have no request headers left to re-resolve from.
   * Optional like every other member here: a socket object can exist before the
   * handshake fills it, and an unattributed frame is preferable to a fabricated
   * attribution.
   */
  admission?: DataPlaneAdmission;
  /** Local-only loopback replay identity; revalidated each turn without retaining its secret. */
  replayPrincipal?: HandleResponsesOptions["replayPrincipal"];
  authContext?: CodexAuthContext; // last resolved account decision for observability/registry cleanup
  cancel?: () => void; // cancels the in-flight stream reader/fetch
  turnId?: number; // monotonically increasing per socket; prevents stale frames after replacement turns
  /** Fixed-size logical session lane derived at the HTTP upgrade boundary. */
  sessionLaneId?: string;
  /** Discriminator: Responses reframing vs transparent live/realtime sideband relay. */
  kind?: "responses" | "live-sideband" | "remote-workspace-agent";
  remoteWorkspaceConnection?: { receive(raw: string | Uint8Array): void };
  remoteWorkspaceOpen?: (socket: ServerWebSocket<WsData>) => { receive(raw: string | Uint8Array): void };
  remoteWorkspaceClose?: () => void;
  liveUpstream?: WebSocket;
  liveUpstreamUrl?: string;
  liveUpstreamHeaders?: Record<string, string>;
  liveUpstreamProtocols?: string[];
  liveValidateFrame?: AudioSocketTarget["validateFrame"];
  liveFinish?: AudioSocketTarget["finish"];
  liveOutcome?: number | "timeout" | "connect_error";
  liveMaxSessionMs?: number;
  liveFinalizationMs?: number;
  liveFinalizing?: boolean;
  liveConnectTimer?: ReturnType<typeof setTimeout>;
  liveSessionTimer?: ReturnType<typeof setTimeout>;
  liveAbortSignal?: AbortSignal;
  liveAbortListener?: () => void;
  livePending?: Array<string | Buffer>;
  /** Total encoded bytes retained in livePending while the upstream connects. */
  livePendingBytes?: number;
  liveOpened?: boolean;
  /** Owns captured frames and terminal state until the downstream relay attaches. */
  liveUpstreamHandoff?: LiveSidebandUpstreamHandoff;
  /** Once teardown starts, ignore new client frames until the upstream closes. */
  liveClosing?: boolean;
  /** Terminates a stalled close without releasing ownership before transport closure. */
  liveCloseFallback?: ReturnType<typeof setTimeout>;
  /** Turn/account ownership retained for the complete sideband socket lifetime. */
  liveTurnAdmissionLease?: AdmissionLease;
  admissionLease?: AdmissionReservation<ServerWebSocket<WsData>>;
  /** Set only on Remote Link sockets: native steering and injection are unavailable there. */
  nativeControlDisabled?: boolean;
  /** Present only on a Remote Link socket (src/server/index/link-websocket.ts). */
  link?: LinkSocketBinding;
  /** Remote Link sockets only: one observer per admitted turn, by the handler's turn id. */
  linkTurnObserver?: (turnId: number) => import("./link-turn").LinkTurnObserver;
  /** Remote Link sockets only: the turn's cleanup ran, so its capture entry goes. */
  linkTurnEnded?: (turnId: number) => void;
}

/** The verified identity and lease owner of one Remote Link socket; no secret is kept. */
export interface LinkSocketBinding {
  readonly linkId: string;
  readonly keyId: string;
  readonly fingerprint: string;
  /** Set once the socket is fenced (revoked or switched off); later frames are dropped. */
  fenced: boolean;
  /** Releases every lease of the upgrade exactly once, from the close callback. */
  readonly leases: { closed(): void };
  /** Set by the link pump while it waits for Bun's drain; the link handler calls it on drain and close. */
  drained?: () => void;
  /** This socket's flow in the Home's per-link traffic book: message payload bytes each way (link-websocket.ts). */
  traffic?: LinkTrafficFlow;
}

export interface LiveSidebandUpstreamFailure {
  status: number;
  code: string;
  message: string;
  closeCode?: number;
  closeReason?: string;
}

export type LiveSidebandUpstreamTakeover =
  | { ok: true; frames: Array<string | Buffer> }
  | { ok: false; failure: LiveSidebandUpstreamFailure };

export interface LiveSidebandUpstreamHandoff {
  /** Observe failure before the downstream upgrade without ending capture. */
  failure(): LiveSidebandUpstreamFailure | undefined;
  /** Atomically ends capture and transfers buffered frames or terminal state. */
  take(): LiveSidebandUpstreamTakeover;
}

/**
 * Build the Responses WebSocket upgrade payload.
 *
 * Extracted so the handshake's contract is testable: `server.upgrade` hands its
 * `data` straight to the socket, and a client has no way to read `ws.data` back.
 * A test that only asserts "the socket opened" would still pass if the admission
 * were dropped from the payload, so the payload itself is what gets asserted.
 */
export function buildResponsesWsData(
  headers: Headers,
  admission: DataPlaneAdmission,
  admissionLease?: AdmissionReservation<ServerWebSocket<WsData>>,
  sessionLaneId?: string,
  client?: UsageClient,
  replayPrincipal?: HandleResponsesOptions["replayPrincipal"],
): WsData {
  // Auth is handshake-time only on this path: the per-frame contexts have no
  // request headers left to re-resolve from, so the decision rides along here.
  return {
    headers,
    admission,
    ...(replayPrincipal ? { replayPrincipal } : {}),
    ...(client ? { client } : {}),
    ...(admissionLease ? { admissionLease } : {}),
    ...(sessionLaneId ? { sessionLaneId } : {}),
  };
}

export class WsSendDroppedError extends Error {
  constructor() {
    super("websocket send dropped the message");
  }
}

/** Capture inbound WS auth and metadata for reconstructed turns; provider egress filters again. */
export function selectForwardHeaders(
  headers: Headers,
  codexOverride?: { accessToken: string; chatgptAccountId: string; kind?: "pool" | "main-pool" },
): Headers {
  const selected = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = headers.get(name);
    if (value !== null) selected.set(name, value);
  }
  // WS turns rebuild an HTTP request from this snapshot. Keep original client
  // identity available for the same per-provider policy used by HTTP requests.
  // These are not credentials and do not extend the outbound provider allowlist.
  for (const name of ["user-agent", "x-codex-app-version"]) {
    const value = headers.get(name);
    if (value !== null) selected.set(name, value);
  }
  if (codexOverride) {
    selected.set("authorization", `Bearer ${codexOverride.accessToken}`);
    selected.set("chatgpt-account-id", codexOverride.chatgptAccountId);
    if (codexOverride.kind !== "main-pool") isolateCodexPoolAccountHeaders(selected, codexOverride.chatgptAccountId);
    else selected.delete("x-oai-attestation");
  } else {
    // Kept for the WS turn pipeline, which drops it again everywhere except first-party Direct.
    const assertion = headers.get(AGENT_ASSERTION_HEADER);
    if (assertion) selected.set(AGENT_ASSERTION_HEADER, assertion);
  }
  return selected;
}

export function selectForwardHeadersForAuthContext(headers: Headers, ctx: CodexAuthContext): Headers {
  return headersForCodexAuthContext(headers, ctx);
}

export function buildWarmupCompletionFrames(frame: Record<string, unknown>): string[] {
  const createdAt = Math.floor(Date.now() / 1000);
  const baseResponse: Record<string, unknown> = {
    id: "",
    object: "response",
    created_at: createdAt,
    model: typeof frame.model === "string" ? frame.model : undefined,
    output: [],
  };
  return [
    JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: { ...baseResponse, status: "in_progress" },
    }),
    JSON.stringify({
      type: "response.completed",
      sequence_number: 1,
      response: { ...baseResponse, status: "completed" },
    }),
  ];
}

export function sendTextFrame(ws: ServerWebSocket<WsData>, payload: string): void {
  if (ws.readyState !== OPEN) throw new WsSendDroppedError();
  const result = ws.send(payload);
  if (result === 0) throw new WsSendDroppedError();
  // Bun returns -1 when queued with backpressure. That is accepted; a later 0 is the hard failure.
  // A link socket counts what Bun took, queued or written; a local socket has no flow and pays one property read.
  const flow = ws.data.link?.traffic;
  if (flow) flow.fromHome(Buffer.byteLength(payload));
}

export function sendJsonFrame(ws: ServerWebSocket<WsData>, payload: Record<string, unknown>): void {
  sendTextFrame(ws, JSON.stringify(payload));
}

export function buildWsErrorFrame(
  status: number,
  error: Record<string, unknown>,
  headers?: Headers,
): Record<string, unknown> {
  return {
    type: "error",
    status,
    error,
    headers: headers ? safeResponseHeaders(headers) : {},
  };
}

function payloadType(payload: string): string | null {
  try {
    const json = JSON.parse(payload) as { type?: unknown };
    return typeof json.type === "string" ? json.type : null;
  } catch {
    return null;
  }
}

function terminalStatusFromType(type: string): ResponsesTerminalStatus | null {
  switch (type) {
    case "response.completed":
      return "completed";
    case "response.failed":
      return "failed";
    case "response.incomplete":
      return "incomplete";
    default:
      return null;
  }
}

function protocolError(message: string): Record<string, unknown> {
  return {
    type: "protocol_error",
    code: "websocket_protocol_error",
    message,
  };
}

function sendProtocolError(ws: ServerWebSocket<WsData>, status: number, message: string): void {
  sendJsonFrame(ws, buildWsErrorFrame(status, protocolError(message)));
}

/**
 * Report an upstream-pump failure to the client. Errors that carry a structured
 * code (for example the undeclared-tool guard's undeclared_tool_call) keep it so
 * clients see the same rejection identity as the SSE path; everything else stays
 * a generic protocol error.
 */
function sendUpstreamError(ws: ServerWebSocket<WsData>, status: number, err: unknown): void {
  const code = err != null && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;
  const message = err instanceof Error ? err.message : String(err);
  sendJsonFrame(ws, buildWsErrorFrame(status, code
    ? { type: "upstream_error", code, message }
    : protocolError(message)));
}

export async function pumpResponsesSseToWebSocket(
  ws: ServerWebSocket<WsData>,
  sseStream: ReadableStream<Uint8Array>,
  options: {
    isCurrent?: () => boolean;
    untilEof?: boolean;
    onTerminal?: ResponsesTerminalReporter;
    onSsePayload?: ResponsesPayloadObserver;
    /** The body is the upstream itself (native control), so no relay tail follows a bare envelope. */
    rawUpstream?: boolean;
  } = {},
): Promise<void> {
  const reader = sseStream.getReader();
  const isCurrent = options.isCurrent ?? (() => true);
  let clientCancelled = false;
  let terminalReported = false;
  const reportTerminal = (status: ResponsesTerminalStatus) => {
    if (terminalReported || clientCancelled || !isCurrent()) return;
    terminalReported = true;
    options.onTerminal?.(status);
  };
  const cancel = () => {
    clientCancelled = true;
    wakeLinkWait?.();
    void reader.cancel().catch(() => {});
  };
  ws.data.cancel = cancel;

  // Remote Link sockets only (design T4 6.2): after a send that leaves more than the threshold
  // buffered, wait for Bun's drain before the next event, even within one upstream chunk, and feed
  // the framer one bounded slice of a chunk at a time. Local sockets keep the single synchronous loop.
  const link = ws.data.link;
  let wakeLinkWait: (() => void) | undefined;
  let linkStopped = false;
  const waitForLinkDrain = async (): Promise<void> => {
    if (!link || ws.getBufferedAmount() <= LINK_WS_LIMITS.sendThresholdBytes) return;
    let stalled = false;
    const observer = linkPumpWaitObserver();
    observer?.(true);
    await new Promise<void>(resolve => {
      const clock = linkPumpTimer();
      // One deadline for the whole wait, however many drain callbacks arrive before it ends.
      const timer = clock.start(() => { stalled = true; done(); }, LINK_WS_LIMITS.sendStallMs);
      function done(): void {
        clock.stop(timer);
        if (link!.drained === drained) link!.drained = undefined;
        if (wakeLinkWait === done) wakeLinkWait = undefined;
        resolve();
      }
      // Bun's drain means "ready for more", not "below the threshold": re-check on every callback.
      function drained(): void {
        if (!clientCancelled && ws.readyState === OPEN && ws.getBufferedAmount() > LINK_WS_LIMITS.sendThresholdBytes) return;
        done();
      }
      link.drained = drained;
      wakeLinkWait = done;
    });
    observer?.(false);
    if (stalled && !clientCancelled) {
      try { ws.close(1011, "link websocket send stalled"); } catch { /* already closing */ }
      throw new WsSendDroppedError();
    }
  };
  const slicesOf = (chunk: Uint8Array): Uint8Array[] => {
    if (!link || chunk.byteLength <= LINK_WS_LIMITS.framerSliceBytes) return [chunk];
    const slices: Uint8Array[] = [];
    for (let offset = 0; offset < chunk.byteLength; offset += LINK_WS_LIMITS.framerSliceBytes) {
      slices.push(chunk.subarray(offset, offset + LINK_WS_LIMITS.framerSliceBytes));
    }
    return slices;
  };

  const decoder = new TextDecoder();
  const framer = new BoundedSseFrameBuffer();
  let terminalSeen = false;
  let lastTerminal: ResponsesTerminalStatus | undefined;

  const handlePayload = (payload: string): boolean => {
    if (!isCurrent()) return true;
    if (payload === "[DONE]") return false;
    const type = payloadType(payload);
    let untypedBare = false;
    if (!type) {
      try { untypedBare = isUntypedBareUpstreamError(JSON.parse(payload)); } catch { /* protocol error below */ }
    }
    // A relayed stream follows an untyped envelope with its own response.failed, so the envelope
    // waits for it. A raw upstream body has no such tail: the envelope stays the protocol error
    // it always was and is not recorded as a verdict the client never received.
    if (!(untypedBare && options.rawUpstream)) {
      try {
        options.onSsePayload?.(payload);
      } catch {
        /* payload observation must not affect WebSocket delivery */
      }
    }
    if (untypedBare && !options.rawUpstream) return false;
    if (!type) {
      reportTerminal("incomplete");
      sendProtocolError(ws, 502, "Invalid JSON payload in upstream SSE frame");
      terminalSeen = true;
      void reader.cancel().catch(() => {});
      return true;
    }
    if (terminalSeen) return true;
    sendTextFrame(ws, payload);
    if (options.untilEof && type === "response.created") lastTerminal = undefined;
    const terminalStatus = type === "error" && options.untilEof ? "failed" : terminalStatusFromType(type);
    if (terminalStatus) {
      if (options.untilEof) { lastTerminal = terminalStatus; return false; }
      reportTerminal(terminalStatus);
      terminalSeen = true;
      void reader.cancel().catch(() => {});
      return true;
    }
    return false;
  };

  try {
    reading: while (!terminalSeen) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const slice of slicesOf(value)) {
        for (const frame of framer.feed(slice)) {
          const payload = parseSseBlock(decoder.decode(frame.block));
          if (payload && handlePayload(payload)) continue reading;
          if (link) {
            await waitForLinkDrain();
            if (clientCancelled || ws.readyState !== OPEN) { linkStopped = true; break reading; }
          }
        }
      }
    }
    // A link pump stopped by a cancel or close mid-chunk has nothing left to deliver or report.
    if (linkStopped) return;
    const tail = framer.finish();
    if (!terminalSeen && tail.byteLength > 0) {
      const payload = parseSseBlock(decoder.decode(tail));
      if (payload) handlePayload(payload);
    }
    if (options.untilEof && lastTerminal && isCurrent() && !clientCancelled) {
      reportTerminal(lastTerminal);
      terminalSeen = true;
    }
    if (!terminalSeen && isCurrent() && !clientCancelled) {
      reportTerminal("incomplete");
      sendProtocolError(ws, 502, "Upstream stream ended before response terminal event");
    }
  } catch (err) {
    framer.dispose();
    if (err instanceof WsSendDroppedError) throw err;
    if (!terminalSeen
      && isCurrent()
      && ws.readyState === OPEN
      && !(err instanceof WsSendDroppedError)) {
      reportTerminal(err instanceof NativeContinuationRefusalError ? "failed" : "incomplete");
      try {
        if (err instanceof NativeContinuationRefusalError) await sendResponseToWebSocket(ws, err.response, isCurrent);
        else sendUpstreamError(ws, 502, err);
      } catch (sendErr) {
        // If delivery is already dropped, there is no useful error frame left
        // to send. Swallow only that expected transport signal; other failures
        // still surface to the caller after the upstream reader is released.
        if (!(sendErr instanceof WsSendDroppedError)) throw sendErr;
      }
    }
  } finally {
    framer.dispose();
    // Framing errors can occur while the upstream body is still live. Always
    // release the reader, even when terminal/send paths already cancelled it.
    void reader.cancel().catch(() => {});
    if (ws.data.cancel === cancel) ws.data.cancel = undefined;
  }
}

export function sendResponsesJsonAsEvents(
  ws: ServerWebSocket<WsData>,
  response: Record<string, unknown>,
  onTerminal?: ResponsesTerminalReporter,
  onPayload?: ResponsesPayloadObserver,
): void {
  const sendObservedFrame = (payload: Record<string, unknown>) => {
    const text = JSON.stringify(payload);
    try {
      onPayload?.(text);
    } catch {
      /* payload observation must not affect WebSocket delivery */
    }
    sendTextFrame(ws, text);
  };
  const finalStatus = response.status === "failed" || response.status === "incomplete"
    ? response.status
    : "completed";
  for (const frame of responsesJsonEventSequence(response)) {
    sendObservedFrame(frame);
  }
  onTerminal?.(finalStatus);
}

/**
 * Remote Link sockets only (design T4 6.2): wait until the send buffer is at or below the threshold, re-checking on
 * every drain callback, under one stall deadline for the whole wait. A stall closes the socket with 1011 and throws,
 * as the SSE pump does; a closed socket or a cancelled turn ends the wait, and only a live, current turn's stall
 * closes the socket.
 */
async function waitForLinkSendRoom(ws: ServerWebSocket<WsData>, turn: { cancelled: boolean; wake?: () => void; isCurrent: () => boolean }): Promise<void> {
  const link = ws.data.link;
  if (!link || turn.cancelled || ws.getBufferedAmount() <= LINK_WS_LIMITS.sendThresholdBytes) return;
  let stalled = false;
  const observer = linkPumpWaitObserver();
  observer?.(true);
  await new Promise<void>(resolve => {
    const clock = linkPumpTimer();
    const timer = clock.start(() => { stalled = true; done(); }, LINK_WS_LIMITS.sendStallMs);
    function done(): void {
      clock.stop(timer);
      if (link!.drained === drained) link!.drained = undefined;
      if (turn.wake === done) turn.wake = undefined;
      resolve();
    }
    function drained(): void {
      if (!turn.cancelled && ws.readyState === OPEN && ws.getBufferedAmount() > LINK_WS_LIMITS.sendThresholdBytes) return;
      done();
    }
    link.drained = drained;
    turn.wake = done;
  });
  observer?.(false);
  if (stalled && !turn.cancelled && turn.isCurrent()) {
    try { ws.close(1011, "link websocket send stalled"); } catch { /* already closing */ }
    throw new WsSendDroppedError();
  }
}

/**
 * sendResponsesJsonAsEvents for a link socket: each synthesized event waits for send room first, the turn's cancel
 * (supersession or close) ends that wait, and an event larger than the client frame limit is never sent: the turn
 * ends incomplete with the 502 error frame the SSE pump sends for an oversized upstream frame.
 */
async function sendResponsesJsonAsLinkEvents(
  ws: ServerWebSocket<WsData>,
  response: Record<string, unknown>,
  isCurrent: () => boolean,
  onTerminal?: ResponsesTerminalReporter,
  onPayload?: ResponsesPayloadObserver,
): Promise<void> {
  const finalStatus = response.status === "failed" || response.status === "incomplete" ? response.status : "completed";
  const turn: { cancelled: boolean; wake?: () => void; isCurrent: () => boolean } = { cancelled: false, isCurrent };
  const previous = ws.data.cancel;
  const cancel = () => {
    turn.cancelled = true;
    turn.wake?.();
    previous?.();
  };
  ws.data.cancel = cancel;
  try {
    for (const frame of responsesJsonEventSequence(response)) {
      await waitForLinkSendRoom(ws, turn);
      if (turn.cancelled || !isCurrent() || ws.readyState !== OPEN) return;
      const text = JSON.stringify(frame);
      if (Buffer.byteLength(text) > MAX_CLIENT_SSE_FRAME_BYTES) {
        onTerminal?.("incomplete");
        sendJsonFrame(ws, buildWsErrorFrame(502, protocolError("synthesized response event exceeded " + MAX_CLIENT_SSE_FRAME_BYTES + " bytes")));
        return;
      }
      try { onPayload?.(text); } catch { /* payload observation must not affect WebSocket delivery */ }
      sendTextFrame(ws, text);
    }
    onTerminal?.(finalStatus);
  } finally {
    if (ws.data.cancel === cancel) ws.data.cancel = previous;
  }
}

function errorPayloadFromText(text: string): Record<string, unknown> {
  try {
    const json = JSON.parse(text) as { error?: unknown };
    if (json.error && typeof json.error === "object" && !Array.isArray(json.error)) {
      return json.error as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {
    type: "upstream_error",
    message: text ? text.slice(0, 500) : "Upstream request failed",
  };
}

export async function sendResponseToWebSocket(
  ws: ServerWebSocket<WsData>,
  response: Response,
  isCurrent: () => boolean,
  options: {
    untilEof?: boolean;
    onTerminal?: ResponsesTerminalReporter;
    onSsePayload?: ResponsesPayloadObserver;
    rawUpstream?: boolean;
  } = {},
): Promise<void> {
  if (!isCurrent()) {
    await response.body?.cancel().catch(() => {});
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (!isCurrent()) return;
    const frame = buildWsErrorFrame(response.status, errorPayloadFromText(text), response.headers);
    const refusal = isProxyError(response) ? response.headers.get(WORKFLOW_LOCAL_REFUSAL_HEADER) : null;
    if (refusal) (frame.headers as Record<string, string>)[WORKFLOW_LOCAL_REFUSAL_HEADER] = refusal;
    sendJsonFrame(ws, frame);
    return;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.body) {
    options.onTerminal?.("incomplete");
    sendJsonFrame(ws, buildWsErrorFrame(502, {
      type: "protocol_error",
      code: "websocket_protocol_error",
      message: `Unexpected successful upstream response without a body (${response.status})`,
    }, response.headers));
    return;
  }

  if (contentType.includes("text/event-stream")) {
    await pumpResponsesSseToWebSocket(ws, response.body, {
      isCurrent,
      untilEof: options.untilEof,
      onTerminal: options.onTerminal,
      onSsePayload: options.onSsePayload,
      rawUpstream: options.rawUpstream,
    });
    return;
  }

  if (contentType.includes("application/json")) {
    const text = await response.text();
    if (!isCurrent()) return;
    const json = JSON.parse(text) as Record<string, unknown>;
    if (ws.data.link) await sendResponsesJsonAsLinkEvents(ws, json, isCurrent, options.onTerminal, options.onSsePayload);
    else sendResponsesJsonAsEvents(ws, json, options.onTerminal, options.onSsePayload);
    return;
  }

  const { prefix, stream } = await readBoundedPrefix(response.body);
  if (!isCurrent()) {
    await stream.cancel().catch(() => {});
    return;
  }
  if (looksLikeSse(prefix)) {
    await pumpResponsesSseToWebSocket(ws, stream, {
      isCurrent,
      untilEof: options.untilEof,
      onTerminal: options.onTerminal,
      onSsePayload: options.onSsePayload,
      rawUpstream: options.rawUpstream,
    });
    return;
  }

  const text = await new Response(stream).text();
  if (!isCurrent()) return;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    if (ws.data.link) await sendResponsesJsonAsLinkEvents(ws, json, isCurrent, options.onTerminal, options.onSsePayload);
    else sendResponsesJsonAsEvents(ws, json, options.onTerminal, options.onSsePayload);
    return;
  }

  options.onTerminal?.("incomplete");
  sendJsonFrame(ws, buildWsErrorFrame(502, {
    type: "protocol_error",
    code: "websocket_protocol_error",
    message: `Unexpected successful non-SSE upstream response (${contentType || "missing content-type"})`,
  }, response.headers));
}

export async function readBoundedPrefix(
  body: ReadableStream<Uint8Array>,
  maxBytes = 4096,
): Promise<{ prefix: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let remainder: Uint8Array | undefined;
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, maxBytes - total);
    if (take > 0) {
      chunks.push(value.slice(0, take));
      total += take;
    }
    if (take < value.byteLength) {
      remainder = value.slice(take);
      break;
    }
  }
  const prefix = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.byteLength > 0) controller.enqueue(prefix);
      if (remainder && remainder.byteLength > 0) controller.enqueue(remainder);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { prefix, stream };
}

export function looksLikeSse(prefix: Uint8Array): boolean {
  const text = new TextDecoder().decode(prefix);
  return /^\s*(event:|data:)/.test(text);
}
