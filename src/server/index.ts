import { markActivity } from "../lib/sidecar-tracker";
import {
  buildWarmupCompletionFrames,
  buildWsErrorFrame,
  selectForwardHeaders,
  sendJsonFrame,
  sendResponseToWebSocket,
  sendTextFrame,
  type WsData,
} from "./ws-bridge";
import type { Server, ServerWebSocket } from "bun";
import {
  DEFAULT_SUBAGENT_MODELS,
  applyProxyEnv,
  loadConfig,
  saveConfig,
  websocketsEnabled,
} from "../config";
import {
  clearLoginState, getLoginStatus, getOAuthCredentialProjectId, getValidAccessToken, isOAuthProvider,
  listOAuthProviders, reconcileOAuthProviders, startLoginFlow, UnsupportedOAuthProviderError, upsertOAuthProvider,
} from "../oauth";
import { invalidateCodexModelsCache } from "../codex/catalog";
import {
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  resolveCodexAuthContext,
  type CodexAuthContext,
} from "../codex/auth-context";
export {
  clearThreadAccountMap,
  formatCodexProviderForLog,
  resolveCodexAccountForThread,
} from "../codex/routing";
import { formatCodexProviderForLog } from "../codex/routing";
import { registerCodexWebSocket, unregisterCodexWebSocket, updateCodexWebSocketAuthContext } from "../codex/websocket-registry";
import { resolveGuiFilePath, rootFallbackPayload, serveGuiFile } from "./gui-static";
export { resolveGuiFilePath, rootFallbackPayload } from "./gui-static";
export { resolveAdapter } from "./adapter-resolve";
import { formatErrorResponse, type ResponsesTerminalStatus } from "../bridge";
import {
  drainAndShutdown,
  getActiveTurnCount,
  isDraining,
  registerTurn,
  setServerRef,
  trackStreamLifetime,
  unregisterTurn,
} from "./lifecycle";
export {
  drainAndShutdown,
  getActiveTurnCount,
  isDraining,
  registerTurn,
  trackStreamLifetime,
  unregisterTurn,
} from "./lifecycle";
import {
  addFinalRequestLog,
  httpStatusForRequestLogTerminal,
  httpStatusForTerminalStatus,
  inspectResponseLogSsePayload,
  nextRequestLogId,
  type RequestLogContext,
  type RequestLogEntry,
} from "./request-log";
export {
  addFinalRequestLog,
  filterRequestLogs,
  httpStatusForTerminalStatus,
  httpStatusFromTerminalError,
  nextRequestLogId,
  requestLogErrorCode,
  requestLogSpeedLabel,
  usageFromResponsesPayload,
  type RequestLogContext,
  type RequestLogEntry,
} from "./request-log";
import {
  consumeForInspection,
  relaySseWithHeartbeat,
  relayWithAbort,
  responseWithDeferredRequestLog,
  sanitizePassthroughHeaders,
} from "./relay";
export {
  consumeForInspection,
  relaySseWithFailedTail,
  relaySseWithHeartbeat,
  relayWithAbort,
  responseWithDeferredRequestLog,
  sanitizePassthroughHeaders,
} from "./relay";
import {
  assertServerAuthConfig,
  corsHeaders,
  hasValidApiAuth,
  isAllowedRequestOrigin,
  isApiAuthRequired,
  isLoopbackHostname,
  jsonResponse,
  requireApiAuth,
  safeConfigDTO,
  setCorsOrigin,
  withCors,
} from "./auth-cors";
export {
  assertServerAuthConfig,
  corsHeaders,
  hasValidApiAuth,
  isApiAuthRequired,
  isLoopbackHostname,
  jsonResponse,
  safeConfigDTO,
} from "./auth-cors";
import { disableResponsesRequestTimeout, handleResponses, handleResponsesCompact } from "./responses";
export { disableResponsesRequestTimeout, linkAbortSignal } from "./responses";
import { handleImages } from "./images";
import { handleSearch } from "./search";
import { fetchAllModels, handleManagementAPI, VERSION } from "./management-api";

const MAX_WS_FRAME_BYTES = 50 * 1024 * 1024;
const WEBSOCKET_IDLE_TIMEOUT_SECONDS = 0;

// GUI static serving extracted to ./server/gui-static. Re-exported below to keep the
// "../src/server" import surface stable for tests/callers.

// Adapter resolution + wire-protocol override extracted to ./server/adapter-resolve.

// Source invariant for tests/passthrough-abort.test.ts after the pure module split:
// if (isEventStream && upstreamResponse.body) {
// upstreamResponse.body.tee()
// process.platform === "win32"
// ? nativeBody
// relaySseWithFailedTail(nativeBody, upstream)
// new Response(clientBody
// markNativePassthroughSseResponse
// const body = relayWithAbort(upstreamResponse.body, upstream);
// function responseWithDeferredRequestLog
// isNativePassthroughSseResponse(response)
// trackSseForRequestLog(
// export function relaySseWithHeartbeat

export function startServer(port?: number) {
  const config = loadConfig();
  applyProxyEnv(config);
  assertServerAuthConfig(config);
  // Refresh OAuth provider presets (models/noReasoningModels) from the registry so a proxy update
  // adding/dropping models reaches existing configs on start — not just fresh installs.
  reconcileOAuthProviders(config);
  // Ensure the ChatGPT passthrough provider exists so gpt-* models route correctly.
  if (!config.providers["chatgpt"]) {
    upsertOAuthProvider(config, "chatgpt");
    saveConfig(config);
  }
  // Seed default featured subagent models on first run only (UNSET → defaults). A user-set list,
  // even [], is left alone so GUI removals persist.
  if (config.subagentModels === undefined) {
    config.subagentModels = [...DEFAULT_SUBAGENT_MODELS];
    saveConfig(config);
  }
  // Sidecar model migration (KST 2026-07-10 06:00 = UTC 2026-07-09 21:00): auto-migrate the old
  // gpt-5.4-mini default to gpt-5.6-luna for both search and vision sidecars. Only touches configs
  // still on the old default — explicit user choices are preserved.
  {
    const SIDECAR_MIGRATION_CUTOFF = Date.UTC(2026, 6, 9, 21, 0); // July 9 21:00 UTC = KST July 10 06:00
    if (Date.now() >= SIDECAR_MIGRATION_CUTOFF) {
      let migrated = false;
      if (config.webSearchSidecar?.model === "gpt-5.4-mini") {
        config.webSearchSidecar = { ...config.webSearchSidecar, model: "gpt-5.6-luna" };
        migrated = true;
      }
      if (config.visionSidecar?.model === "gpt-5.4-mini") {
        config.visionSidecar = { ...config.visionSidecar, model: "gpt-5.6-luna" };
        migrated = true;
      }
      if (migrated) saveConfig(config);
    }
  }
  invalidateCodexModelsCache();

  const listenPort = port ?? config.port ?? 10100;
  setCorsOrigin(listenPort);

  // Canonicalize an explicit "localhost" bind to IPv4 so it matches the injected base_url (which
  // resolves localhost→127.0.0.1): on Windows `localhost` resolves ::1-first, but the injected URL
  // is 127.0.0.1, so binding literal "localhost" would reintroduce the F4 refusal. Wildcards
  // (0.0.0.0/::) and specific hosts are left untouched so intentional exposure is preserved.
  const bindHost = /^localhost$/i.test(config.hostname ?? "") ? "127.0.0.1" : (config.hostname ?? "127.0.0.1");

  const server: Server<WsData> = Bun.serve<WsData>({
    port: listenPort,
    hostname: bindHost,
    idleTimeout: 255,
    async fetch(req, requestServer): Promise<Response> {
      const url = new URL(req.url);
      markActivity(`${req.method} ${url.pathname}`);

      if (req.method === "OPTIONS") {
        if (!isAllowedRequestOrigin(req, config)) {
          return new Response(null, { status: 403, headers: corsHeaders() });
        }
        return new Response(null, { status: 204, headers: corsHeaders(req, config) });
      }

      // Responses WebSocket (phase 120.2). Codex upgrades the same /v1/responses path; auth is
      // handshake-time only, so capture inbound headers and thread them into the pipeline.
      if (url.pathname === "/v1/responses" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (isDraining()) {
          return new Response("Service shutting down", { status: 503, headers: { ...corsHeaders(req, config), "Retry-After": "5" } });
        }
        const apiAuthError = requireApiAuth(req, config, "data-plane");
        if (apiAuthError) return withCors(apiAuthError, req, config);
        if (!isAllowedRequestOrigin(req, config)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "WebSocket upgrade blocked: non-local Origin"), req, config);
        }
        // WS transport gate: Codex's built-in `openai` provider hardcodes supports_websockets=true,
        // so under Design B it always tries the WS transport first. When the feature is off, reject
        // the upgrade with 426 — codex-rs maps a connect-time UPGRADE_REQUIRED to a clean
        // session-scoped HTTP fallback (client.rs WebsocketStreamOutcome::FallbackToHttp) instead of
        // surfacing broken-pipe errors from sockets a "disabled" feature would otherwise accept.
        if (!websocketsEnabled(config)) {
          return withCors(formatErrorResponse(426, "upgrade_required", "Responses WebSocket transport is disabled; use HTTP"), req, config);
        }
        let authCtx: CodexAuthContext;
        try {
          authCtx = await resolveCodexAuthContext(req.headers, config);
        } catch (err) {
          if (err instanceof CodexAccountCooldownError) {
            return withCors(formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down"), req, config);
          }
          if (err instanceof CodexThreadAffinityExpiredError) {
            return withCors(formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session"), req, config);
          }
          if (err instanceof CodexAuthContextError) {
            const safeAccountLabel = formatCodexProviderForLog("chatgpt", err.accountId, config);
            console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed during websocket upgrade; reauthentication required`);
            return withCors(formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication"), req, config);
          }
          throw err;
        }
        if (server.upgrade(req, {
          data: {
            headers: selectForwardHeaders(req.headers),
            authContext: authCtx,
          },
        })) return undefined as unknown as Response;
        return withCors(formatErrorResponse(426, "upgrade_required", "WebSocket upgrade failed"), req, config);
      }

      if (url.pathname === "/healthz" && req.method === "GET") {
        // service/pid/port let CLI liveness reject foreign 200s and verify pid identity.
        return jsonResponse({ status: "ok", service: "opencodex", version: VERSION, uptime: process.uptime(), pid: process.pid, port: listenPort }, 200, req, config);
      }

      if (url.pathname.startsWith("/api/")) {
        const apiAuthError = requireApiAuth(req, config, "management");
        if (apiAuthError) return withCors(apiAuthError, req, config);
        const mgmtResponse = await handleManagementAPI(req, url, config);
        if (mgmtResponse) return withCors(mgmtResponse, req, config);
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        const apiAuthError = requireApiAuth(req, config, "data-plane");
        if (apiAuthError) return withCors(apiAuthError, req, config);
        if (!isAllowedRequestOrigin(req, config)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, config);
        }
        const goModels = await fetchAllModels(config);
        const { applyNativeVisibility, buildCatalogEntries, disabledNativeSlugs, loadCatalogTemplate, nativeOpenAiSlugs, orderForSubagents, filterCatalogVisibleModels, visibleNativeSlugs } = await import("../codex/catalog");
        const nativeSlugs = nativeOpenAiSlugs();
        const goEnabled = filterCatalogVisibleModels(goModels, config);
        const goOrdered = orderForSubagents(goEnabled, config.subagentModels);
        if (url.searchParams.has("client_version")) {
          // Codex client → Codex catalog shape: native gpt + namespaced routed models,
          // cloned from a native template so required fields (base_instructions, etc.) are present.
          // Pass the subagent picks so featured models lead by priority (matches the on-disk file).
          // Disabled natives stay in the catalog shape with visibility "hide" (mirrors the
          // on-disk sync; codex-rs keeps them out of the picker itself).
          const maMode = config.multiAgentMode === "v1" || config.multiAgentMode === "v2" ? config.multiAgentMode : "default";
          const entries = buildCatalogEntries(loadCatalogTemplate(), nativeSlugs, goOrdered, config.subagentModels, websocketsEnabled(config), maMode as "v1" | "default" | "v2");
          return jsonResponse({ models: applyNativeVisibility(entries, disabledNativeSlugs(config)) }, 200, req, config);
        }
        // OpenAI list shape: native gpt bare + routed models namespaced "<provider>/<id>"
        // (pure availability list — disabled natives are omitted entirely).
        const data = [
          ...visibleNativeSlugs(config).map(id => ({ id, object: "model", created: 0, owned_by: "openai" })),
          ...goOrdered.map(m => ({ id: `${m.provider}/${m.id}`, object: "model", created: 0, owned_by: m.owned_by ?? m.provider })),
        ];
        return jsonResponse({ object: "list", data }, 200, req, config);
      }

      // Remote compaction v1 (codex-rs with Feature::RemoteCompactionV2 off — the default).
      // Must be matched BEFORE the /v1/responses POST branch never sees it (distinct path) and
      // before the /v1/* 404 guard below.
      if (url.pathname === "/v1/responses/compact" && req.method === "POST") {
        if (isDraining()) {
          return new Response("Service shutting down", { status: 503, headers: { ...corsHeaders(req, config), "Retry-After": "5" } });
        }
        const apiAuthError = requireApiAuth(req, config, "data-plane");
        if (apiAuthError) return withCors(apiAuthError, req, config);
        if (!isAllowedRequestOrigin(req, config)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, config);
        }
        return withCors(await handleResponsesCompact(req, config), req, config);
      }

      if (
        req.method === "POST"
        && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits")
      ) {
        disableResponsesRequestTimeout(req, requestServer);
        if (isDraining()) {
          return new Response("Service shutting down", {
            status: 503,
            headers: { ...corsHeaders(req, config), "Retry-After": "5" },
          });
        }
        const apiAuthError = requireApiAuth(req, config, "data-plane");
        if (apiAuthError) return withCors(apiAuthError, req, config);
        if (!isAllowedRequestOrigin(req, config)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, config);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = { model: "image_gen", provider: "unknown" };
        const endpoint = url.pathname.endsWith("/edits") ? "edits" as const : "generations" as const;
        const response = await handleImages(req, config, endpoint, logCtx);
        addFinalRequestLog(requestId, start, logCtx, response.status, response.status === 499 ? { closeReason: "client_cancel" } : undefined);
        return withCors(response, req, config);
      }

      if (url.pathname === "/v1/alpha/search" && req.method === "POST") {
        disableResponsesRequestTimeout(req, requestServer);
        if (isDraining()) {
          return new Response("Service shutting down", {
            status: 503,
            headers: { ...corsHeaders(req, config), "Retry-After": "5" },
          });
        }
        const apiAuthError = requireApiAuth(req, config, "data-plane");
        if (apiAuthError) return withCors(apiAuthError, req, config);
        if (!isAllowedRequestOrigin(req, config)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, config);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = { model: "web_search", provider: "unknown" };
        const response = await handleSearch(req, config, logCtx);
        addFinalRequestLog(
          requestId,
          start,
          logCtx,
          response.status,
          response.status === 499 ? { closeReason: "client_cancel" } : undefined,
        );
        return withCors(response, req, config);
      }

      if (url.pathname === "/v1/responses" && req.method === "POST") {
        disableResponsesRequestTimeout(req, requestServer);
        if (isDraining()) {
          return new Response("Service shutting down", { status: 503, headers: { ...corsHeaders(req, config), "Retry-After": "5" } });
        }
        const apiAuthError = requireApiAuth(req, config, "data-plane");
        if (apiAuthError) return withCors(apiAuthError, req, config);
        if (!isAllowedRequestOrigin(req, config)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, config);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx = { model: "unknown", provider: "unknown" };
        let logged = false;
        const finalizeNativePassthroughLog = (
          status: number,
          meta: { terminalStatus?: ResponsesTerminalStatus; closeReason: "terminal" | "client_cancel" },
        ) => {
          if (logged) return;
          logged = true;
          addFinalRequestLog(requestId, start, logCtx, status, meta);
        };
        const response = await handleResponses(req, config, logCtx, {
          abortSignal: req.signal,
          onNativePassthroughTerminal: status => {
            finalizeNativePassthroughLog(httpStatusForTerminalStatus(status), {
              terminalStatus: status,
              closeReason: "terminal",
            });
          },
          onNativePassthroughCancel: () => {
            finalizeNativePassthroughLog(499, { closeReason: "client_cancel" });
          },
        });
        return withCors(responseWithDeferredRequestLog(response, requestId, start, logCtx), req, config);
      }

      // Data-plane guard: unknown /v1/* paths must fail with JSON 404, never fall through to the
      // GUI static handler (extensionless paths would get index.html with HTTP 200 and codex-rs
      // endpoint clients — memories/*, realtime/* — would surface confusing
      // serde decode errors instead of a clean not-found).
      if (url.pathname.startsWith("/v1/")) {
        return withCors(formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`), req, config);
      }

      const guiFile = serveGuiFile(url.pathname);
      if (guiFile) return guiFile;
      if (url.pathname === "/" && req.method === "GET") {
        return jsonResponse(rootFallbackPayload());
      }

      return withCors(formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`), req, config);
    },
    websocket: {
      idleTimeout: WEBSOCKET_IDLE_TIMEOUT_SECONDS,
      // Responses WebSocket data plane (phase 120.2). Re-frames the same SSE pipeline onto the
      // socket: parse response.create → run handleResponses unchanged → pump its SSE body as WS
      // Text frames. response.processed is a no-op ack. close() aborts the upstream (RC2 parity).
      open(ws: ServerWebSocket<WsData>) {
        registerCodexWebSocket(ws);
      },
      message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
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

        if (frame.generate === false) {
          for (const payload of buildWarmupCompletionFrames(frame)) {
            if (!isCurrent()) return;
            sendTextFrame(ws, payload);
          }
          if (ws.data.cancel === cancelTurn) ws.data.cancel = undefined;
          return;
        }

        const payload: Record<string, unknown> = { ...frame };
        delete payload.type;
        registerTurn(turnAbort);
        void (async () => {
          const start = Date.now();
          const requestId = nextRequestLogId(start);
          const logCtx = { model: "unknown", provider: "unknown" };
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
          let authCtx: CodexAuthContext;
          let selectedForwardHeaders: Headers;
          try {
            authCtx = await resolveCodexAuthContext(baseHeaders, config);
            selectedForwardHeaders = headersForCodexAuthContext(baseHeaders, authCtx);
            updateCodexWebSocketAuthContext(ws, authCtx);
          } catch (err) {
            if (!isCurrent()) return;
            if (err instanceof CodexAccountCooldownError) {
              finalizeLog(429);
              sendJsonFrame(ws, buildWsErrorFrame(429, {
                type: "rate_limit_error",
                message: "Selected Codex account is cooling down",
              }));
              return;
            }
            if (err instanceof CodexThreadAffinityExpiredError) {
              finalizeLog(409);
              sendJsonFrame(ws, buildWsErrorFrame(409, {
                type: "invalid_request_error",
                message: "Codex thread account affinity expired; start a new session",
              }));
              return;
            }
            if (err instanceof CodexAuthContextError) {
              const safeAccountLabel = formatCodexProviderForLog("chatgpt", err.accountId, config);
              console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed during websocket turn; reauthentication required`);
              finalizeLog(401);
              sendJsonFrame(ws, buildWsErrorFrame(401, {
                type: "authentication_error",
                message: "Selected Codex account needs reauthentication",
              }));
              return;
            }
            finalizeLog(502);
            sendJsonFrame(ws, buildWsErrorFrame(502, {
              type: "proxy_error",
              message: err instanceof Error ? err.message : String(err),
            }));
            return;
          }
          const fwd = new Headers({ "content-type": "application/json" });
          selectedForwardHeaders.forEach((value, key) => fwd.set(key, value));
          const req = new Request("http://localhost/v1/responses", {
            method: "POST",
            headers: fwd,
            body: JSON.stringify({ ...payload, stream: true }),
          });
          try {
            let terminalRecorder: ((status: ResponsesTerminalStatus) => void) | undefined;
            const response = await handleResponses(req, config, logCtx, {
              forceEmptyResponseId: true,
              abortSignal: turnAbort.signal,
              authContext: authCtx,
              selectedForwardHeaders,
              recordTerminalOutcomes: false,
              setTerminalOutcomeRecorder: recorder => {
                terminalRecorder = recorder;
              },
            });
            await sendResponseToWebSocket(ws, response, isCurrent, {
              onSsePayload: payload => inspectResponseLogSsePayload(logCtx, payload),
              onTerminal: status => {
                terminalRecorder?.(status);
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
                sendJsonFrame(ws, buildWsErrorFrame(429, {
                  type: "rate_limit_error",
                  message: "Selected Codex account is cooling down",
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
            unregisterTurn(turnAbort);
            if (!logged && turnAbort.signal.aborted) finalizeLog(499);
            if (ws.data.cancel === cancelTurn) ws.data.cancel = undefined;
          }
        })();
      },
      close(ws: ServerWebSocket<WsData>) {
        unregisterCodexWebSocket(ws);
        ws.data.cancel?.(); // RC2: abort the upstream when the client disconnects
      },
    },
  });

  setServerRef(server);
  const actualPort = server.port ?? listenPort;
  setCorsOrigin(actualPort);

  console.log(`🚀 opencodex proxy running on http://localhost:${actualPort}`);
  console.log(`   POST /v1/responses → provider translation`);
  console.log(`   GET  /healthz      → health check`);
  console.log(`   GET  /api/*        → management API`);
  console.log(`   GET  /             → GUI dashboard`);

  // Prime pool-account quota in the background so the rotation engine has real
  // usage scores from the first routing decision, even when the dashboard is
  // never opened (the common CLI/WSL case). Fire-and-forget: never blocks the
  // listener, and a blocked network silently no-ops (see Phase 30 diagnostics).
  import("../codex/auth-api")
    .then(({ primeCodexPoolQuotas }) => primeCodexPoolQuotas(config, "startup"))
    .catch(() => {});

  return server;
}
