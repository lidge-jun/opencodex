import type { Server, ServerWebSocket } from "bun";
import {
  LIVE_SIDEBAND_UPSTREAM_OPEN_TIMEOUT_MS,
  MAX_WS_FRAME_BYTES,
  WEBSOCKET_IDLE_TIMEOUT_SECONDS,
  attachLiveSidebandUpstream,
  clientCloseForUpstream,
  closeLiveSideband,
  closeLiveSidebandBeforeUpgrade,
  enqueueLiveSidebandPendingFrame,
  exceedsLiveSidebandFrameByteLimit,
  openLiveSidebandUpstream,
  sendUpstreamFrame,
  webSocketFrameBytes,
} from "./live-sideband";
import { markActivity } from "../../lib/sidecar-tracker";
import {
  buildWarmupCompletionFrames,
  buildWsErrorFrame,
  selectForwardHeaders,
  sendJsonFrame,
  buildResponsesWsData,
  sendResponseToWebSocket,
  sendTextFrame,
  type WsData,
} from "../ws-bridge";
import {
  CodexAccountCooldownError,
  cooldownErrorMessage,
} from "../../codex/auth-context";
import { codexAccountNamespaceForModel } from "../../codex/account-namespace-match";
import {
  registerCodexWebSocket,
  tryReserveCodexWebSocket,
  unregisterCodexWebSocket,
  updateCodexWebSocketAuthContext,
} from "../../codex/websocket-registry";
import {
  formatErrorResponse,
  type ResponsesTerminalStatus,
} from "../../bridge";
import {
  isDraining,
  registerTurn,
  tryAdmitTurn,
  unregisterTurn,
  type ActiveTurnLease,
} from "../lifecycle";
import {
  addFinalRequestLog,
  httpStatusForRequestLogTerminal,
  inspectResponseLogSsePayload,
  nextRequestLogId,
  recordFirstOutput,
  type RequestLogContext,
  type RequestLogEntry,
} from "../request-log";
import {
  corsHeaders,
  managementCorsHeaders,
  isAllowedRequestOrigin,
  isAllowedManagementOrigin,
  isApiAuthRequired,
  jsonResponse,
  admissionFields,
  resolveApiAuth,
  resolveResponsesApiAuth,
  type RequestPolicyView,
  withCors,
  withManagementCors,
} from "../auth-cors";
import {
  disableResponsesRequestTimeout,
  handleResponses,
  handleResponsesCompact,
} from "../responses";
import {
  handleLive,
  logLiveSidebandFrame,
  parseLiveSidebandTarget,
  resolveLiveSidebandUpgrade,
} from "../live";
import type { ServeOptionsContext } from "./serve-options";

/**
 * The WebSocket half of the Bun.serve options, split out of serve-options.ts to keep that file
 * under the 2,000-line ratchet threshold. The body is the original handler verbatim; it reads the
 * same startServer context the HTTP half does, so it takes the same context object.
 */
export function createWebsocketHandler(ctx: ServeOptionsContext) {
  const { config, deps } = ctx;
  return {
      maxPayloadLength: MAX_WS_FRAME_BYTES,
      idleTimeout: WEBSOCKET_IDLE_TIMEOUT_SECONDS,
      // Responses WebSocket data plane (phase 120.2). Re-frames the same SSE pipeline onto the
      // socket: parse response.create → run handleResponses unchanged → pump its SSE body as WS
      // Text frames. response.processed is a no-op ack. close() aborts the upstream (RC2 parity).
      // Live sideband sockets (kind=live-sideband) are a transparent bidirectional relay instead.
      open(ws: ServerWebSocket<WsData>) {
        if (ws.data.kind === "remote-workspace-agent") {
          const open = ws.data.remoteWorkspaceOpen;
          if (!open) {
            ws.close(1011, "remote workspace connection unavailable");
            return;
          }
          try {
            ws.data.remoteWorkspaceConnection = open(ws);
          } catch {
            ws.close(1011, "remote workspace connection failed");
          }
          return;
        }
        if (ws.data.kind === "live-sideband") {
          if (!ws.data.liveTurnAdmissionLease) {
            closeLiveSideband(ws, 1013, "server busy");
            return;
          }
          attachLiveSidebandUpstream(ws, deps.liveSidebandWebSocketFactory);
          return;
        }
        if (!ws.data.admissionLease) {
          ws.close(1013, "server busy");
          return;
        }
        ws.data.admissionLease.bind(ws);
        registerCodexWebSocket(ws);
      },
      message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        if (ws.data.kind === "remote-workspace-agent") {
          try {
            ws.data.remoteWorkspaceConnection?.receive(raw);
          } catch {
            ws.close(1008, "remote workspace protocol error");
          }
          return;
        }
        if (ws.data.kind === "live-sideband") {
          if (ws.data.liveClosing) return;
          if (ws.data.liveValidateFrame && !ws.data.liveValidateFrame(raw)) {
            closeLiveSideband(ws, 1008, "invalid audio event");
            return;
          }
          const rawBytes = webSocketFrameBytes(raw);
          if (exceedsLiveSidebandFrameByteLimit(rawBytes)) {
            closeLiveSideband(ws, 1009, "message too large");
            return;
          }
          logLiveSidebandFrame("c2u", raw);
          const upstream = ws.data.liveUpstream;
          if (!upstream || upstream.readyState === WebSocket.CONNECTING || !ws.data.liveOpened) {
            const enqueueResult = enqueueLiveSidebandPendingFrame(ws.data, raw, rawBytes);
            if (enqueueResult === "too-many-frames") {
              closeLiveSideband(ws, 1009, "too many pending frames");
              return;
            }
            if (enqueueResult === "too-many-bytes") {
              closeLiveSideband(ws, 1009, "too many pending bytes");
              return;
            }
            return;
          }
          if (upstream.readyState !== WebSocket.OPEN) {
            closeLiveSideband(ws, 1011, "upstream not open");
            return;
          }
          try {
            sendUpstreamFrame(upstream, raw);
            if (ws.data.liveMaxSessionMs !== undefined && upstream.bufferedAmount > MAX_WS_FRAME_BYTES) {
              closeLiveSideband(ws, 1013, "audio upstream backpressure");
            }
          } catch {
            closeLiveSideband(ws, 1011, "upstream send failed");
          }
          return;
        }
        const rawBytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
        if (rawBytes > MAX_WS_FRAME_BYTES) {
          sendJsonFrame(ws, buildWsErrorFrame(413, {
            type: "invalid_request_error",
            message: "WebSocket response.create frame is too large",
          }));
          ws.close(1009, "message too large");
          return;
        }
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as Record<string, unknown>;
        } catch {
          return; // text-only contract; ignore unparseable frames
        }
        if (frame.type === "response.processed") return; // ack — no-op
        if (frame.type !== "response.create") return;
        markActivity("ws response.create");

        ws.data.cancel?.();
        const turnId = (ws.data.turnId ?? 0) + 1;
        ws.data.turnId = turnId;
        const isCurrent = () => ws.data.turnId === turnId;
        const turnAbort = new AbortController();
        const cancelTurn = () => {
          turnAbort.abort("websocket turn superseded or closed");
        };
        ws.data.cancel = cancelTurn;
        // A socket may carry several response.create frames. Clear the previous
        // account before resolving this frame so a failed Multi resolution cannot
        // leave stale invalidation ownership behind.
        updateCodexWebSocketAuthContext(ws, undefined);

        if (frame.generate === false) {
          for (const payload of buildWarmupCompletionFrames(frame)) {
            if (!isCurrent()) return;
            sendTextFrame(ws, payload);
          }
          if (ws.data.cancel === cancelTurn) ws.data.cancel = undefined;
          return;
        }

        const turnAdmissionLease = tryAdmitTurn(ws.data.sessionLaneId);
        if (!turnAdmissionLease) {
          sendJsonFrame(ws, buildWsErrorFrame(503, {
            type: "server_error",
            code: "server_busy",
            message: "active turns capacity reached",
            retryable: true,
          }, new Headers({ "Retry-After": "1" })));
          if (ws.data.cancel === cancelTurn) ws.data.cancel = undefined;
          return;
        }

        const payload: Record<string, unknown> = { ...frame };
        delete payload.type;
        turnAdmissionLease.bindAbortController(turnAbort);
        void (async () => {
          const start = Date.now();
          const requestId = nextRequestLogId(start);
          // Resolved once at the handshake — a frame has no request headers left
          // to re-resolve from. Optional on WsData like every other member, so
          // narrow rather than assume: an unattributed frame is preferable to a
          // fabricated attribution.
          const wsAdmission = ws.data.admission;
          const logCtx: RequestLogContext = {
            model: "unknown",
            provider: "unknown",
            ...(wsAdmission ? admissionFields(wsAdmission) : {}),
            inboundProtocol: "responses",
          };
          let logged = false;
          const finalizeLog = (
            status: number,
            meta?: Pick<RequestLogEntry, "terminalStatus" | "closeReason">,
          ) => {
            if (logged) return;
            logged = true;
            addFinalRequestLog(requestId, start, logCtx, status, meta);
          };
          const baseHeaders = ws.data.headers ?? new Headers();
          const fwd = new Headers({ "content-type": "application/json" });
          baseHeaders.forEach((value, key) => fwd.set(key, value));
          const req = new Request("http://localhost/v1/responses", {
            method: "POST",
            headers: fwd,
            body: JSON.stringify({ ...payload, stream: true }),
          });
          try {
            let terminalRecorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined;
            const response = await handleResponses(req, config, logCtx, {
              ...(wsAdmission ? { admission: wsAdmission } : {}),
              forceEmptyResponseId: true,
              inboundTransport: "websocket",
              abortSignal: turnAbort.signal,
              turnAdmissionLease,
              onFirstOutput: () => recordFirstOutput(logCtx, start),
              onCodexAuthContextResolved: context => updateCodexWebSocketAuthContext(ws, context),
              recordTerminalOutcomes: false,
              setTerminalOutcomeRecorder: recorder => {
                terminalRecorder = recorder;
              },
            });
            await sendResponseToWebSocket(ws, response, isCurrent, {
              onSsePayload: payload => inspectResponseLogSsePayload(logCtx, payload),
              onTerminal: status => {
                terminalRecorder?.(status, logCtx.terminalHttpStatus);
                finalizeLog(httpStatusForRequestLogTerminal(status, logCtx), {
                  terminalStatus: status,
                  closeReason: "terminal",
                });
              },
            });
            if (!logged) finalizeLog(turnAbort.signal.aborted ? 499 : response.status);
          } catch (err) {
            if (!isCurrent()) return;
            try {
              if (err instanceof CodexAccountCooldownError) {
                finalizeLog(429);
                // Codex Desktop rides this WS transport, so it must carry the same
                // actionable text as HTTP; a frame has no headers, hence message-only.
                const accountSelector = typeof payload.model === "string"
                  ? codexAccountNamespaceForModel(config.codexAccountNamespaces, payload.model)
                  : undefined;
                sendJsonFrame(ws, buildWsErrorFrame(429, {
                  type: "rate_limit_error",
                  message: cooldownErrorMessage(err, accountSelector),
                }));
                return;
              }
              finalizeLog(502);
              sendJsonFrame(ws, buildWsErrorFrame(502, {
                type: "proxy_error",
                message: err instanceof Error ? err.message : String(err),
              }));
            } catch {
              /* socket already gone or send dropped */
            }
          } finally {
            turnAdmissionLease.release();
            if (!logged && turnAbort.signal.aborted) finalizeLog(499);
            if (ws.data.cancel === cancelTurn) ws.data.cancel = undefined;
          }
        })();
      },
      close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
        if (ws.data.kind === "remote-workspace-agent") {
          ws.data.remoteWorkspaceClose?.();
          return;
        }
        if (ws.data.kind === "live-sideband") {
          // Carry the client's own close through to the upstream instead of reporting every
          // hang-up as a plain 1000.
          const forwarded = clientCloseForUpstream(code, reason);
          closeLiveSideband(ws, forwarded.code, forwarded.reason);
          return;
        }
        unregisterCodexWebSocket(ws);
        ws.data.admissionLease?.release();
        ws.data.admissionLease = undefined;
        ws.data.cancel?.(); // RC2: abort the upstream when the client disconnects
      },
  } as const;
}
