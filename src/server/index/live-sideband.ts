import {
  buildWarmupCompletionFrames,
  buildWsErrorFrame,
  selectForwardHeaders,
  sendJsonFrame,
  buildResponsesWsData,
  sendResponseToWebSocket,
  sendTextFrame,
  type LiveSidebandUpstreamFailure,
  type LiveSidebandUpstreamHandoff,
  type WsData,
} from "../ws-bridge";
import type { Server, ServerWebSocket } from "bun";
import { handleLive, logLiveSidebandFrame, parseLiveSidebandTarget, resolveLiveSidebandUpgrade } from "../live";
import { RESPONSE_TTL_MS } from "../../responses/state";

export const MAX_WS_FRAME_BYTES = 50 * 1024 * 1024;
/**
 * 0 means Bun never closes an idle socket, and this one value covers every socket kind the
 * server accepts — the live sideband relay, where a quiet call is normal, and the Responses data
 * plane, where quiet means the client is simply between turns.
 *
 * It is coupled to `RESPONSE_TTL_MS` whether or not anyone says so, which is why it is said here.
 * A codex-rs client caches its `WebsocketSession` across turns and chains `previous_response_id`
 * onto it; it only clears `last_request`/`last_response_rx` when it finds the connection closed.
 * So a socket that outlives retention is a client that keeps referencing continuation state this
 * process has already evicted. Two settings can hold that line and only these two:
 *
 * - a FINITE idle timeout below `MAX_WEBSOCKET_IDLE_TIMEOUT_SECONDS`, which closes the socket
 *   first and lets the client reset its own chain, or
 * - this 0, which obliges the proxy to fail closed on the expired reference instead —
 *   `server/responses/request-prepare.ts` returns `previous_response_not_found`, the error
 *   codex-rs recognizes on a WebSocket turn and answers by replaying its full input.
 *
 * What must never happen is neither: an immortal socket plus a destination that silently accepts
 * the orphaned delta. `tests/responses/ws-endpoint.test.ts` holds exactly that pair together.
 * Raising the timeout off 0 is still worth doing for its own reasons (a dead peer holds a socket
 * forever today), and Bun caps the value at 255 seconds, well inside the bound below.
 */
export const WEBSOCKET_IDLE_TIMEOUT_SECONDS = 0;
/** Ceiling a finite websocket idle timeout must stay under, in seconds. See above. */
export const MAX_WEBSOCKET_IDLE_TIMEOUT_SECONDS = Math.floor(RESPONSE_TTL_MS / 1_000);

const LIVE_SIDEBAND_PENDING_MAX = 32;
const LIVE_SIDEBAND_PENDING_BYTES_MAX = 1024 * 1024;
const LIVE_SIDEBAND_CLOSE_FALLBACK_MS = 1_000;
/**
 * Bound the pre-upgrade upstream handshake. A sideband join that cannot reach 101
 * must fail the client upgrade promptly rather than hold it open indefinitely.
 */
export const LIVE_SIDEBAND_UPSTREAM_OPEN_TIMEOUT_MS = 10_000;

/**
 * Outcome of the upstream sideband handshake performed before the client upgrade.
 *
 * `ok: false` carries the HTTP status the client upgrade must fail with. Only an
 * upgrade failure reaches codex-rs as a connect error, and only a connect error
 * ends its sideband reconnect loop (`realtime_conversation/sideband.rs`: the `Err`
 * arm always breaks). A 101 followed by a close is instead read as `TransportLost`
 * and retried forever against the same, permanently dead call id.
 */
export type LiveSidebandUpstreamOpenResult =
  | {
      ok: true;
      socket: WebSocket;
      /** Owns capture and terminal events until the downstream relay attaches. */
      handoff: LiveSidebandUpstreamHandoff;
    }
  | { ok: false; status: number; code: string; message: string; socket?: WebSocket };

export function exceedsLiveSidebandFrameByteLimit(frameBytes: number): boolean {
  return frameBytes > MAX_WS_FRAME_BYTES;
}

export function exceedsLiveSidebandPendingByteLimit(pendingBytes: number, incomingBytes: number): boolean {
  return incomingBytes > LIVE_SIDEBAND_PENDING_BYTES_MAX - pendingBytes;
}

export function webSocketFrameBytes(frame: string | ArrayBuffer | ArrayBufferView | Blob | Buffer): number {
  if (typeof frame === "string") return Buffer.byteLength(frame);
  if (frame instanceof ArrayBuffer || ArrayBuffer.isView(frame)) return frame.byteLength;
  return frame.size;
}

export type LiveSidebandPendingEnqueueResult = "queued" | "too-many-frames" | "too-many-bytes";

export function enqueueLiveSidebandPendingFrame(
  data: Pick<WsData, "livePending" | "livePendingBytes">,
  frame: string | Buffer,
  frameBytes = webSocketFrameBytes(frame),
): LiveSidebandPendingEnqueueResult {
  const pending = data.livePending ?? (data.livePending = []);
  if (pending.length >= LIVE_SIDEBAND_PENDING_MAX) return "too-many-frames";
  const pendingBytes = data.livePendingBytes ?? 0;
  if (exceedsLiveSidebandPendingByteLimit(pendingBytes, frameBytes)) return "too-many-bytes";
  pending.push(frame);
  data.livePendingBytes = pendingBytes + frameBytes;
  return "queued";
}

export type LiveSidebandWebSocketFactory = (
  url: string,
  headers: Record<string, string>,
  protocols?: string[],
) => WebSocket;

function releaseLiveSidebandAdmission(ws: ServerWebSocket<WsData>): void {
  ws.data.liveTurnAdmissionLease?.release();
  ws.data.liveTurnAdmissionLease = undefined;
}

/**
 * Send one live-sideband frame to the upstream socket.
 *
 * Bun's `WebSocket.send` accepts `string | Blob | BufferSource`, but the DOM-lib
 * `Buffer` can be backed by a `SharedArrayBuffer`, which `BufferSource` rejects.
 * `Uint8Array.from` copies into a fresh `ArrayBuffer`-backed view, so a frame
 * arriving from `node:buffer` still round-trips byte-for-byte.
 */
export function sendUpstreamFrame(upstream: WebSocket, frame: string | Buffer): void {
  if (typeof frame === "string") {
    upstream.send(frame);
    return;
  }
  upstream.send(Uint8Array.from(frame));
}

function finalizeLiveSideband(ws: ServerWebSocket<WsData>, upstream?: WebSocket): void {
  if (upstream && ws.data.liveUpstream !== upstream) return;
  if (ws.data.liveCloseFallback !== undefined) {
    clearTimeout(ws.data.liveCloseFallback);
    ws.data.liveCloseFallback = undefined;
  }
  ws.data.liveUpstream = undefined;
  ws.data.livePending = undefined;
  ws.data.livePendingBytes = undefined;
  if (ws.data.liveConnectTimer !== undefined) clearTimeout(ws.data.liveConnectTimer);
  if (ws.data.liveSessionTimer !== undefined) clearTimeout(ws.data.liveSessionTimer);
  ws.data.liveConnectTimer = undefined;
  ws.data.liveSessionTimer = undefined;
  ws.data.liveUpstreamHeaders = undefined;
  ws.data.liveUpstreamProtocols = undefined;
  ws.data.liveValidateFrame = undefined;
  if (ws.data.liveAbortListener) ws.data.liveAbortSignal?.removeEventListener("abort", ws.data.liveAbortListener);
  ws.data.liveAbortSignal = undefined;
  ws.data.liveAbortListener = undefined;
  ws.data.cancel = undefined;
  const finish = ws.data.liveFinish;
  ws.data.liveFinish = undefined;
  try { finish?.(ws.data.liveOutcome); }
  catch { console.warn("[audio] upstream accounting failed during close"); }
  finally { releaseLiveSidebandAdmission(ws); }
}

function armLiveSidebandCloseFallback(ws: ServerWebSocket<WsData>, upstream: WebSocket): void {
  if (ws.data.liveCloseFallback !== undefined) return;
  ws.data.liveCloseFallback = setTimeout(() => {
    ws.data.liveCloseFallback = undefined;
    if (ws.data.liveUpstream !== upstream) return;
    if (upstream.readyState === WebSocket.CLOSED) {
      finalizeLiveSideband(ws, upstream);
      return;
    }
    // A close frame was already sent below. Retry once, but never surrender
    // native-main ownership while the authenticated transport remains live.
    try {
      upstream.close(1000, "upstream close timeout");
    } catch {
      /* upstream is already unusable */
    }
    // Some implementations transition synchronously without delivering the
    // close event. That is still an observed CLOSED transport and is safe to
    // finalize. CONNECTING/CLOSING peers keep the lease so profile switching
    // fails at its own bounded drain deadline instead of racing live traffic.
    // The earlier CLOSED check narrowed `readyState` to 0|1|2 in the type
    // system, but the socket can still transition to CLOSED (3) before this
    // fallback fires; the cast keeps the runtime-identical check.
    if ((upstream.readyState as number) === 3) finalizeLiveSideband(ws, upstream);
  }, LIVE_SIDEBAND_CLOSE_FALLBACK_MS);
}

export function closeLiveSidebandBeforeUpgrade(
  upstream: WebSocket,
  release: () => void,
  code = 1000,
  reason = "",
): void {
  // There is no downstream socket to own this transport yet. Mirror
  // closeLiveSideband's bounded close contract directly: release only after a
  // close event or an observed CLOSED state, never merely after requesting close.
  let released = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    if (fallback !== undefined) clearTimeout(fallback);
    release();
  };
  upstream.addEventListener("close", releaseOnce, { once: true });
  if (upstream.readyState === WebSocket.CLOSED) {
    releaseOnce();
    return;
  }
  fallback = setTimeout(() => {
    if (upstream.readyState === WebSocket.CLOSED) {
      releaseOnce();
      return;
    }
    try {
      upstream.close(1000, "upstream close timeout");
    } catch {
      /* retain ownership until CLOSED is observed */
    }
    if ((upstream.readyState as number) === 3) releaseOnce();
  }, LIVE_SIDEBAND_CLOSE_FALLBACK_MS);
  try {
    upstream.close(code, reason);
  } catch {
    /* the bounded fallback retries without releasing ownership */
  }
  if ((upstream.readyState as number) === 3) releaseOnce();
}

export function closeLiveSideband(ws: ServerWebSocket<WsData>, code = 1000, reason = ""): void {
  if (ws.data.liveClosing) return;
  ws.data.liveClosing = true;
  if (ws.data.liveConnectTimer !== undefined) clearTimeout(ws.data.liveConnectTimer);
  if (ws.data.liveSessionTimer !== undefined) clearTimeout(ws.data.liveSessionTimer);
  ws.data.liveConnectTimer = undefined;
  ws.data.liveSessionTimer = undefined;
  ws.data.livePending = undefined;
  ws.data.livePendingBytes = undefined;
  ws.data.cancel = undefined;
  const upstream = ws.data.liveUpstream;
  // Bun's `WebSocket` type narrows `readyState` to 0|1|2 even though the DOM
  // constant CLOSED is 3; the numeric literal is the runtime-identical check.
  if (!upstream || upstream.readyState === 3) {
    finalizeLiveSideband(ws, upstream);
  } else {
    // The sideband holds a native-main admission lease. Do not release it just
    // because the downstream left: its authenticated upstream remains live
    // until the close event arrives or the transport is observed CLOSED. The
    // bounded fallback only retries close; it does not release ownership.
    armLiveSidebandCloseFallback(ws, upstream);
    try {
      upstream.close(code, reason);
    } catch {
      /* the fallback retries close without releasing ownership */
    }
  }
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason);
    }
  } catch {
    /* client already gone */
  }
}

/**
 * Dial the upstream sideband and report whether its handshake reached 101.
 *
 * Bun's client WebSocket does not surface the upstream handshake status, so the
 * result is "opened" or "failed" and nothing finer. That is sufficient for the
 * property this exists to guarantee: the client is never told the relay is live
 * when it is not. Frames the upstream sends before the client socket exists are
 * captured and handed back by `drain`, because a session preamble such as
 * `session.created` arrives immediately after the upstream opens.
 */
export function openLiveSidebandUpstream(
  url: string,
  headers: Record<string, string>,
  createWebSocket: LiveSidebandWebSocketFactory = (socketUrl, socketHeaders) => (
    new WebSocket(socketUrl, { headers: socketHeaders } as unknown as string[])
  ),
  timeoutMs: number = LIVE_SIDEBAND_UPSTREAM_OPEN_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<LiveSidebandUpstreamOpenResult> {
  return new Promise(resolve => {
    let socket: WebSocket;
    try {
      socket = createWebSocket(url, headers);
    } catch {
      resolve({ ok: false, status: 502, code: "upstream_error", message: "voice upstream connect failed" });
      return;
    }

    const buffered: Array<string | Buffer> = [];
    let bufferedBytes = 0;
    let capturing = true;
    let settled = false;
    let terminalFailure: LiveSidebandUpstreamFailure | undefined;
    let removeAbortListener = (): void => {};

    const finish = (result: LiveSidebandUpstreamOpenResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeAbortListener();
      resolve(result);
    };
    const timer = setTimeout(() => {
      const failure = { status: 504, code: "upstream_timeout", message: "voice upstream did not open in time" };
      terminalFailure = failure;
      capturing = false;
      buffered.length = 0;
      bufferedBytes = 0;
      finish({ ok: false, ...failure, socket });
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const failCapture = (failure: LiveSidebandUpstreamFailure): void => {
      if (!capturing || terminalFailure) return;
      terminalFailure = failure;
      capturing = false;
      buffered.length = 0;
      bufferedBytes = 0;
      finish({ ok: false, ...failure, socket });
      try {
        socket.close(1009, "sideband preamble overflow");
      } catch {
        /* the terminal failure is already retained for the downstream handoff */
      }
    };
    const handoff: LiveSidebandUpstreamHandoff = {
      failure: () => terminalFailure,
      take: () => {
        capturing = false;
        if (terminalFailure) return { ok: false, failure: terminalFailure };
        const frames = buffered.slice();
        buffered.length = 0;
        bufferedBytes = 0;
        return { ok: true, frames };
      },
    };

    socket.addEventListener("message", event => {
      if (!capturing) return;
      const frameBytes = webSocketFrameBytes(event.data);
      if (exceedsLiveSidebandFrameByteLimit(frameBytes)) {
        failCapture({ status: 502, code: "upstream_overflow", message: "voice upstream preamble frame is too large" });
        return;
      }
      if (buffered.length >= LIVE_SIDEBAND_PENDING_MAX) {
        failCapture({ status: 502, code: "upstream_overflow", message: "voice upstream sent too many preamble frames" });
        return;
      }
      if (exceedsLiveSidebandPendingByteLimit(bufferedBytes, frameBytes)) {
        failCapture({ status: 502, code: "upstream_overflow", message: "voice upstream preamble is too large" });
        return;
      }
      if (typeof event.data === "string") buffered.push(event.data);
      else if (event.data instanceof ArrayBuffer) buffered.push(Buffer.from(new Uint8Array(event.data)));
      else if (ArrayBuffer.isView(event.data)) {
        buffered.push(Buffer.from(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)));
      } else return;
      bufferedBytes += frameBytes;
    });
    socket.addEventListener("open", () => {
      finish({
        ok: true,
        socket,
        handoff,
      });
    });
    socket.addEventListener("error", () => {
      const failure = { status: 502, code: "upstream_error", message: "voice upstream rejected the sideband join" };
      terminalFailure ??= failure;
      capturing = false;
      buffered.length = 0;
      bufferedBytes = 0;
      finish({ ok: false, ...terminalFailure, socket });
      try {
        socket.close();
      } catch {
        /* the terminal failure is already retained */
      }
    });
    socket.addEventListener("close", event => {
      const failure = {
        status: 502,
        code: "upstream_error",
        message: `voice upstream closed before opening (code ${event.code})`,
        closeCode: event.code,
        closeReason: event.reason,
      };
      terminalFailure ??= failure;
      capturing = false;
      buffered.length = 0;
      bufferedBytes = 0;
      finish({ ok: false, ...terminalFailure, socket });
    });
    const abortOpen = (): void => {
      const failure = { status: 499, code: "request_cancelled", message: "voice sideband join was cancelled" };
      terminalFailure ??= failure;
      capturing = false;
      buffered.length = 0;
      bufferedBytes = 0;
      finish({ ok: false, ...terminalFailure, socket });
      try {
        socket.close();
      } catch {
        /* the cancelled join no longer owns the socket */
      }
    };
    if (signal) {
      signal.addEventListener("abort", abortOpen, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abortOpen);
      if (signal.aborted) abortOpen();
    }
  });
}

export function attachLiveSidebandUpstream(
  ws: ServerWebSocket<WsData>,
  createWebSocket: LiveSidebandWebSocketFactory = (url, headers, protocols) => (
    new WebSocket(url, { headers, protocols } as unknown as string[])
  ),
): void {
  if (ws.data.liveAbortSignal?.aborted) {
    closeLiveSideband(ws, 1000, "audio connection canceled");
    return;
  }
  const preOpened = ws.data.liveUpstream;
  let upstream: WebSocket;
  if (preOpened) {
    upstream = preOpened;
  } else {
    const url = ws.data.liveUpstreamUrl;
    if (!url) {
      closeLiveSideband(ws, 1011, "missing upstream");
      return;
    }
    try {
      // Bun accepts per-handshake headers; the DOM lib types only list protocol arrays.
      upstream = createWebSocket(url, ws.data.liveUpstreamHeaders ?? {}, ws.data.liveUpstreamProtocols);
    } catch {
      closeLiveSideband(ws, 1011, "upstream connect failed");
      return;
    }
  }
  ws.data.liveUpstream = upstream;
  ws.data.liveUpstreamHeaders = undefined;
  ws.data.liveUpstreamProtocols = undefined;
  ws.data.liveClosing = false;
  ws.data.cancel = () => closeLiveSideband(ws, 1000, "client closed");
  if (ws.data.liveMaxSessionMs !== undefined) {
    ws.data.liveConnectTimer = setTimeout(() => {
      ws.data.liveOutcome = "timeout";
      closeLiveSideband(ws, 1011, "audio connection timed out");
    }, 10_000);
    ws.data.liveSessionTimer = setTimeout(() => closeLiveSideband(ws, 1000, "audio session expired"), ws.data.liveMaxSessionMs);
  }

  upstream.addEventListener("close", (event) => {
    if (ws.data.liveUpstream !== upstream) return;
    if (ws.data.liveFinish && !ws.data.liveClosing && event.code !== 1000) ws.data.liveOutcome = "connect_error";
    ws.data.liveClosing = true;
    finalizeLiveSideband(ws, upstream);
    try {
      const external = ws.data.liveMaxSessionMs !== undefined;
      const validCode = event.code === 1000 || (event.code >= 1001 && event.code <= 1014 && ![1004, 1005, 1006].includes(event.code))
        || (event.code >= 3000 && event.code <= 4999);
      ws.close(external && !validCode ? 1011 : event.code || 1000, external ? "audio upstream closed" : event.reason || "");
    } catch {
      /* ignore */
    }
  });
  upstream.addEventListener("error", () => {
    if (ws.data.liveUpstream !== upstream) return;
    if (ws.data.liveFinish && !ws.data.liveClosing) ws.data.liveOutcome = "connect_error";
    closeLiveSideband(ws, 1011, "upstream error");
  });
  if (ws.data.liveAbortSignal) {
    ws.data.liveAbortListener = () => closeLiveSideband(ws, 1000, "audio connection canceled");
    ws.data.liveAbortSignal.addEventListener("abort", ws.data.liveAbortListener, { once: true });
    if (ws.data.liveAbortSignal.aborted) closeLiveSideband(ws, 1000, "audio connection canceled");
  }

  if (preOpened) {
    // The upstream opened before this socket existed, so its `open` event has already
    // fired and the listener below will never run. Its early frames were captured for
    // us; forward the capture now rather than dropping the session preamble.
    const handoff = ws.data.liveUpstreamHandoff;
    ws.data.liveUpstreamHandoff = undefined;
    const takeover = handoff?.take();
    if (!takeover?.ok || preOpened.readyState !== WebSocket.OPEN) {
      const failure = takeover && !takeover.ok ? takeover.failure : undefined;
      closeLiveSideband(
        ws,
        failure?.closeCode ?? 1011,
        failure?.closeReason ?? "upstream closed before relay attachment",
      );
      return;
    }
    ws.data.liveOpened = true;
    // The upstream opened before this socket existed, so the "open" listener
    // below can never fire for it. Disarm the connect watchdog exactly as that
    // listener would, or every session with a max lifetime is force-closed ten
    // seconds after attach. The session timer stays armed: it bounds the whole
    // session, not the connect phase.
    if (ws.data.liveConnectTimer !== undefined) clearTimeout(ws.data.liveConnectTimer);
    ws.data.liveConnectTimer = undefined;
    for (const frame of takeover.frames) {
      try {
        // Mirror the live message listener exactly: same ceiling, same diagnostic
        // record. These frames are upstream-to-client like any other.
        if (exceedsLiveSidebandFrameByteLimit(webSocketFrameBytes(frame))) {
          closeLiveSideband(ws, 1009, "message too large");
          return;
        }
        logLiveSidebandFrame("u2c", frame);
        ws.send(frame);
      } catch {
        closeLiveSideband(ws, 1011, "client send failed");
        return;
      }
    }
  }

  upstream.addEventListener("open", () => {
    if (ws.data.liveUpstream !== upstream || ws.data.liveClosing) return;
    ws.data.liveOpened = true;
    if (ws.data.liveConnectTimer !== undefined) clearTimeout(ws.data.liveConnectTimer);
    ws.data.liveConnectTimer = undefined;
    // An accepted transport alone does not prove inference/quota recovery.
    // Keep healthy closes neutral; explicit transport failures are recorded below.
    const pending = ws.data.livePending ?? [];
    ws.data.livePending = undefined;
    ws.data.livePendingBytes = undefined;
    for (const frame of pending) {
      try {
        sendUpstreamFrame(upstream, frame);
      } catch {
        closeLiveSideband(ws, 1011, "upstream send failed");
        return;
      }
    }
  });
  upstream.addEventListener("message", (event) => {
    if (ws.data.liveUpstream !== upstream || ws.data.liveClosing) return;
    try {
      if (exceedsLiveSidebandFrameByteLimit(webSocketFrameBytes(event.data))) {
        closeLiveSideband(ws, 1009, "message too large");
        return;
      }
      logLiveSidebandFrame("u2c", event.data);
      let sent: number;
      if (typeof event.data === "string") sent = ws.send(event.data);
      else if (event.data instanceof ArrayBuffer) sent = ws.send(event.data);
      else if (ArrayBuffer.isView(event.data)) {
        sent = ws.send(event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength));
      } else sent = ws.send(event.data as Buffer);
      if (ws.data.liveMaxSessionMs !== undefined && (sent === 0 || ws.getBufferedAmount() > MAX_WS_FRAME_BYTES)) {
        closeLiveSideband(ws, 1013, "audio client backpressure");
      }
    } catch {
      closeLiveSideband(ws, 1011, "client send failed");
    }
  });
}
