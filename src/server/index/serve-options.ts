import type { Server, ServerWebSocket } from "bun";
import type { StartServerDeps } from "./startup-warnings";
import {
  GUI_PAIRING_EXCHANGE_BODY_LIMIT,
  REMOTE_WORKSPACE_PAIRING_BODY_LIMIT,
  readBoundedRequestText,
  withRemoteCatalogKeyId,
} from "./bounded-request";
import {
  LIVE_SIDEBAND_UPSTREAM_OPEN_TIMEOUT_MS,
  MAX_WS_FRAME_BYTES,
  WEBSOCKET_IDLE_TIMEOUT_SECONDS,
  attachLiveSidebandUpstream,
  closeLiveSideband,
  closeLiveSidebandBeforeUpgrade,
  enqueueLiveSidebandPendingFrame,
  exceedsLiveSidebandFrameByteLimit,
  openLiveSidebandUpstream,
  sendUpstreamFrame,
  webSocketFrameBytes,
} from "./live-sideband";
import {
  withRequestLogId,
} from "./startup-warnings";

import { remoteWorkspaceEnabled } from "../../remote-control/workspace-activation";
import { markActivity } from "../../lib/sidecar-tracker";
import { knownModelIdsForProvider } from "../../router";
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
import { websocketsEnabled } from "../../config";
import { metricsExportEnabled } from "../../config/feature-flags";
import { grokDefaultReasoningEffort } from "../../grok/effort";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { providerCodexAccountMode } from "../../providers/registry";
import {
  codexAccountNamespaceEntries,
  isMainCodexAccountTarget,
} from "../../codex/account-namespaces";
import { MAIN_CODEX_ACCOUNT_ID } from "../../codex/main-account";
import {
  availableAccountGatedNativeModels,
  codexModelEntitlementStateForAccount,
} from "../../codex/model-entitlements";
import { resolveAdmittedCodexModelEntitlements } from "../../codex/model-entitlement-admission";
import { CatalogGatherBusyError } from "../../codex/catalog/provider-fetch";
import {
  registerCodexWebSocket,
  tryReserveCodexWebSocket,
  unregisterCodexWebSocket,
  updateCodexWebSocketAuthContext,
} from "../../codex/websocket-registry";
import {
  rootFallbackPayload,
  serveGuiFile,
  serveSessionBootstrap,
} from "../gui-static";
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
import { sessionLaneIdFromRequest } from "../request-log-conversation";
import { responseWithDeferredRequestLog } from "../relay";
import { createRequestMetricsOwner } from "../request-metrics";
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
import { resolveAdmissionModelScope, routeAllowedByScope } from "../admission-model-scope";
import {
  disableResponsesRequestTimeout,
  handleResponses,
  handleResponsesCompact,
} from "../responses";
import {
  handleClaudeCountTokens,
  handleClaudeMessages,
} from "../claude-messages";
import { handleChatCompletions } from "../chat-completions";
import { anthropicErrorResponse } from "../../claude/outbound";
import {
  buildDesktop3pRegistry,
  generateDesktop3pModels,
} from "../../claude/desktop-3p";
import { buildDesktopDiscoveryInputs } from "../../claude/desktop-discovery-inputs";
import { handleImages } from "../images";
import {
  handleLive,
  logLiveSidebandFrame,
  parseLiveSidebandTarget,
  resolveLiveSidebandUpgrade,
} from "../live";
import { handleAudioTranscriptions } from "../audio-transcriptions";
import {
  resolveAudioAdmission,
  TRANSCRIPTION_MODEL,
} from "../audio-upstream";
import { resolveAudioClient } from "../audio-client";
import { resolveDictationSocket } from "../audio-dictation";
import {
  handleExternalLive,
  resolveExternalLiveSocket,
} from "../audio-live";
import {
  EXTERNAL_CALL_PREFIX,
  type LiveCallBindings,
} from "../live-call-bindings";
import { clearableDeadline } from "../../lib/abort";
import { handleSearch } from "../search";
import { handleContextHistory } from "../context-history";
import {
  codexCompatibleUrl,
  contextEndpoint,
  contextRelayActivated,
} from "../../codex/context-compat";
import {
  fetchAllModels,
  handleManagementAPI,
  VERSION,
  type ManagementApiDeps,
} from "../management-api";
import {
  issueGuiSession,
  managementPrincipal,
  requireManagementAuth,
  type ManagementAuthState,
  type ManagementSessionControl,
} from "../management-auth";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof,
} from "../../lib/local-management-attestation";
import { SYSTEM_RESTART_CAPABILITY_VERSION } from "../../lib/system-restart-contract";
import { LOCAL_PROVIDER_RELOAD_CAPABILITY_VERSION } from "../../lib/local-provider-reload-contract";
import {
  GUI_PAIR_BROWSER_ORIGIN_HEADER,
  GUI_PAIR_CAPABILITY_VERSION,
  GUI_PAIR_PATH,
} from "../../lib/gui-pair-capability";
import {
  GuiPairingGrantRateLimitError,
  consumeGuiPairingGrant,
  createGuiPairingGrant,
} from "../gui-session";
import { recordCursorSeen } from "../../integrations/cursor-seen";
import { detectCursorInstalls } from "../../integrations/cursor-detect";
import { loadCursorEffortTable } from "../../integrations/cursor-effort-table";
import {
  expandCursorEffortRow,
  knownEffortRowIds,
} from "../effort-row";
import {
  catalogFastRowEligible,
  expandFastRow,
} from "../fast-row";
import type { OcxConfig } from "../../types";
import type { PackageTreeIntegrityGuard } from "../../lib/package-tree-integrity";
import type { ReadinessGate } from "../readiness";
import type { WorkflowRefusalLog } from "../workflow-refusal";

import { readyProtocolMetadata } from "../../remote/protocol";
import { modelCapabilityFields } from "../models-capabilities";
import { createWebsocketHandler } from "./websocket-handler";

export type ServerIngress = "public" | "unauthenticated-loopback" | "hub-management";

export interface ServeOptionsContext {
  readonly server: Server<WsData>;
  readonly boundPort: number | null;
  readonly remoteWorkspaceStopping: boolean;

  drainingResponse: (req: Request, policy: RequestPolicyView) => Response;
  ingressForServer: (requestServer: Server<WsData>) => ServerIngress;
  loopbackRouteAllowed: (url: URL, req: Request) => boolean;
  managementIngressRouteAllowed: (url: URL, req: Request) => boolean;
  packageTreeChangedResponse: (
    req: Request,
    policy: RequestPolicyView,
    message: string,
  ) => Response;
  serverBusyResponse: (
    req: Request,
    resource: string,
    policy: RequestPolicyView,
  ) => Response;
  runAdmittedHttpTurn: (
    req: Request,
    policy: RequestPolicyView,
    work: (lease: ActiveTurnLease) => Promise<Response>,
    refusalLog?: WorkflowRefusalLog,
  ) => Promise<Response>;

  config: OcxConfig;
  inboundBodyLimitBytes: number;
  listenPort: number;
  liveCallBindings: LiveCallBindings;
  loadRemoteWorkspaceRuntime: () => Promise<
    typeof import("../../remote-control/workspace-runtime")
  >;
  localAttestationSecret: string;
  loopbackPolicy: () => RequestPolicyView;
  managementApiDeps: ManagementApiDeps;
  managementAuth: ManagementAuthState;
  managementSessionControl: ManagementSessionControl;
  packageTreeIntegrity: PackageTreeIntegrityGuard;
  readinessGate: ReadinessGate;

  deps: StartServerDeps;
  port: number | undefined;
}

export function createServeOptions(ctx: ServeOptionsContext) {
  const {
    drainingResponse,
    ingressForServer,
    loopbackRouteAllowed,
    managementIngressRouteAllowed,
    packageTreeChangedResponse,
    serverBusyResponse,
    runAdmittedHttpTurn,
    config,
    inboundBodyLimitBytes,
    listenPort,
    liveCallBindings,
    loadRemoteWorkspaceRuntime,
    localAttestationSecret,
    loopbackPolicy,
    managementApiDeps,
    managementAuth,
    managementSessionControl,
    packageTreeIntegrity,
    readinessGate,
    deps,
    port,
  } = ctx;
  void port;
  const requestMetrics = metricsExportEnabled(config) ? createRequestMetricsOwner() : undefined;
  const requestMetricsLogContext = requestMetrics ? { requestMetricsRecorder: requestMetrics } : {};
  const requestManagementApiDeps: ManagementApiDeps = requestMetrics
    ? { ...managementApiDeps, requestMetrics: { snapshot: () => requestMetrics.snapshot() } }
    : managementApiDeps;
  const serveOptions = {
      idleTimeout: 255,
      // Bun rejects an oversized body before `fetch` runs, so the listener has to be raised
      // with the admission limit or the opt-in would do nothing. Fixed at bind time: a live
      // `maxInboundBodyBytes` edit needs a restart, which the config doc states.
      maxRequestBodySize: inboundBodyLimitBytes,
      async fetch(req: Request, requestServer: Server<WsData>): Promise<Response> {
      const ingress = ingressForServer(requestServer);
      // The unauthenticated loopback listener (#1102) serves a fixed allowlist and nothing
      // else. Rejecting here, before any handler runs, is what keeps the surface from growing
      // silently when a route is added below.
      if (ingress === "unauthenticated-loopback" && !loopbackRouteAllowed(codexCompatibleUrl(req.url), req)) {
        return withCors(
          formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${new URL(req.url).pathname}`),
          req,
          loopbackPolicy(),
        );
      }
      // Tailscale Serve terminates only on this separately bound loopback socket. Reject before
      // dispatch so no data, readiness, health, WebSocket, or unknown-static handler can run.
      if (ingress === "hub-management" && !managementIngressRouteAllowed(codexCompatibleUrl(req.url), req)) {
        return withCors(
          formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${new URL(req.url).pathname}`),
          req,
          config,
        );
      }
      // Auth and CORS decisions below read `policy`, not `config`. For the public listener the
      // two are the same object, so its behaviour is unchanged; for the loopback listener the
      // view substitutes 127.0.0.1 as the bind address, which is what routes it through the
      // same code path a plain loopback bind has always taken — Host-header check included.
      // Routing, provider selection and response bodies keep using `config`.
      const policy: RequestPolicyView = ingress === "unauthenticated-loopback" ? loopbackPolicy() : config;
      const url = codexCompatibleUrl(req.url);
      markActivity(`${req.method} ${url.pathname}`);

      // Readiness is exact-GET on the literal /readyz path. Compare the DECODED
      // pathname so an encoded variant like /readyz%2F (which decodes to
      // /readyz/) cannot bypass the exact-path rejection and reach the GUI
      // fallback (serveGuiFile decodes the pathname and would serve index.html
      // with 200). Malformed percent-sequences fall back to the raw pathname,
      // which still cannot match the exact literal below.
      let readyzPath: string | undefined;
      try {
        const decoded = decodeURIComponent(url.pathname);
        if (decoded === "/readyz" || decoded === "/readyz/") readyzPath = decoded;
      } catch { /* malformed encoding — not a readiness path */ }

      const packageTreeStatus = packageTreeIntegrity.status();
      if (!packageTreeStatus.ok && (
        url.pathname === "/healthz"
        || readyzPath !== undefined
        || url.pathname.startsWith("/v1/")
      )) {
        const message = "OpenCodex package files changed while this proxy was running; restart OpenCodex before retrying.";
        const response = url.pathname === "/healthz" || readyzPath !== undefined
          ? jsonResponse({
              status: "restart_required",
              service: "opencodex",
              version: VERSION,
              uptime: process.uptime(),
              pid: process.pid,
              port: ctx.boundPort ?? requestServer.port ?? listenPort,
              error: { code: "package_tree_changed", message },
            }, 503, req, policy)
          : packageTreeChangedResponse(req, policy, message);
        const headers = new Headers(response.headers);
        headers.set("Retry-After", "5");
        return new Response(response.body, { status: 503, headers });
      }

      if (req.method === "OPTIONS") {
        // /readyz is exact-GET only; OPTIONS (like POST and the trailing-slash
        // path) must answer the deterministic JSON 404, never the generic 204
        // preflight response that the SPA fallback would otherwise allow.
        if (readyzPath !== undefined) {
          return withCors(formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`), req, policy);
        }
        const managementPreflight = url.pathname.startsWith("/api/");
        const allowed = managementPreflight
          ? isAllowedManagementOrigin(req, config)
          : isAllowedRequestOrigin(req, policy);
        if (!allowed) {
          return new Response(null, { status: 403, headers: corsHeaders() });
        }
        return new Response(null, {
          status: 204,
          headers: managementPreflight ? managementCorsHeaders(req, config) : corsHeaders(req, policy),
        });
      }

      // An OCX-only executor exchanges one short-lived pairing code for a device-scoped
      // token. This is intentionally outside /api: management auth belongs to the browser
      // that created the grant, while the new device owns only that one-time code.
      if (url.pathname === "/remote-workspace/pair" && req.method === "POST") {
        if (!remoteWorkspaceEnabled(config)) {
          return Response.json({ error: "Remote Workspace is not enabled on this OpenCodex instance." }, { status: 404 });
        }
        // Browser JavaScript must use the authenticated dashboard route. Refusing Origin-bearing
        // requests leaves this exchange to an explicit OCX device process and avoids turning a
        // copied pairing code into a cross-site enrollment action.
        if (req.headers.get("origin") !== null) {
          return Response.json({ error: "Remote Workspace device pairing does not accept browser-origin requests." }, {
            status: 403,
            headers: { "cache-control": "no-store" },
          });
        }
        const [{ remoteWorkspaceHubForConfig }, { RemoteWorkspacePairingRateLimitError }] = await Promise.all([
          loadRemoteWorkspaceRuntime(),
          import("../../remote-control/workspace-hub"),
        ]);
        if (ctx.remoteWorkspaceStopping) return Response.json({ error: "Remote Workspace is stopping." }, { status: 503 });
        const hub = deps.managementApi?.remoteWorkspaceHub ?? remoteWorkspaceHubForConfig(config);
        // A loopback socket alone cannot prove that Tailscale Serve supplied its identity header:
        // another local process can connect directly and forge it. Pairing therefore uses only the
        // kernel-observed peer on every listener; proxied management users intentionally share the
        // loopback bucket rather than gaining a header-rotation bypass.
        const peer = requestServer.requestIP(req)?.address ?? "unknown";
        const pairingSource = `${ingress}:${peer}`;
        const rateLimitResponse = (error: unknown): Response | null => {
          if (!(error instanceof RemoteWorkspacePairingRateLimitError)) return null;
          return Response.json({ error: "Remote Workspace pairing is temporarily rate limited." }, {
            status: 429,
            headers: {
              "cache-control": "no-store",
              "retry-after": String(error.retryAfterSeconds),
            },
          });
        };
        try {
          // Check the existing source block before reading or parsing an attacker-controlled body.
          // pairDevice checks again after the await and records only code-shaped authentication
          // failures, so malformed JSON cannot allocate one limiter entry per request.
          hub.assertPairingSourceAllowed(pairingSource);
        } catch (error) {
          const limited = rateLimitResponse(error);
          if (limited) return limited;
          throw error;
        }
        const declaredLength = Number(req.headers.get("content-length") ?? "0");
        if (!Number.isFinite(declaredLength) || declaredLength > REMOTE_WORKSPACE_PAIRING_BODY_LIMIT) {
          return Response.json({ error: "Remote Workspace pairing body is too large." }, { status: 413 });
        }
        const text = await readBoundedRequestText(req, REMOTE_WORKSPACE_PAIRING_BODY_LIMIT);
        if (text === null) return Response.json({ error: "Remote Workspace pairing body is too large." }, { status: 413 });
        if (ctx.remoteWorkspaceStopping) return Response.json({ error: "Remote Workspace is stopping." }, { status: 503 });
        let body: unknown;
        try { body = JSON.parse(text); }
        catch { return Response.json({ error: "Invalid Remote Workspace pairing request." }, { status: 400 }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return Response.json({ error: "Invalid Remote Workspace pairing request." }, { status: 400 });
        }
        const record = body as Record<string, unknown>;
        const required = ["code", "name", "platform", "publicKey", "roots"];
        const allowed = new Set([...required, "capabilities"]);
        if (required.some(key => !Object.hasOwn(record, key))
          || Object.keys(record).some(key => !allowed.has(key))) {
          return Response.json({ error: "Invalid Remote Workspace pairing request." }, { status: 400 });
        }
        try {
          const paired = hub.pairDevice(record, pairingSource);
          return Response.json(paired, { status: 201, headers: { "cache-control": "no-store" } });
        } catch (error) {
          const limited = rateLimitResponse(error);
          if (limited) return limited;
          const message = error instanceof Error ? error.message : "Remote Workspace pairing failed.";
          const conflict = /already in use|limit reached/i.test(message);
          return Response.json({ error: message }, {
            status: conflict ? 409 : 401,
            headers: { "cache-control": "no-store" },
          });
        }
      }

      // Each executor holds one device-scoped bearer and opens one outbound WSS. The token is
      // authenticated only at upgrade and never enters ws.data; subsequent frames are bound to
      // the device identity and per-session signed E2EE handshake.
      if (url.pathname === "/remote-workspace/agent" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!remoteWorkspaceEnabled(config) || req.headers.get("origin") !== null) {
          return Response.json({ error: "Remote Workspace agent upgrade refused." }, { status: 403 });
        }
        const authorization = req.headers.get("authorization") ?? "";
        const match = /^Bearer (ocxrw_[A-Za-z0-9_-]{43})$/.exec(authorization);
        if (!match) return Response.json({ error: "Remote Workspace device authentication required." }, { status: 401 });
        const { remoteWorkspaceHubForConfig } = await loadRemoteWorkspaceRuntime();
        const { RemoteWorkspaceHubAgentConnection } = await import("../../remote-control/workspace-agent-connection");
        if (ctx.remoteWorkspaceStopping) return Response.json({ error: "Remote Workspace is stopping." }, { status: 503 });
        const hub = deps.managementApi?.remoteWorkspaceHub ?? remoteWorkspaceHubForConfig(config);
        const device = hub.authenticateDeviceToken(match[1]!);
        if (!device) return Response.json({ error: "Remote Workspace device authentication failed." }, { status: 401 });
        const upgraded = requestServer.upgrade(req, {
          data: {
            kind: "remote-workspace-agent",
            remoteWorkspaceOpen: socket => {
              const connection = new RemoteWorkspaceHubAgentConnection({
                deviceId: device.id,
                devicePublicKey: device.publicKey,
                hubIdentity: hub.identity(),
                capabilities: device.capabilities,
                onCapabilities: capabilities => hub.updateDeviceCapabilities(device.id, capabilities),
                socket: {
                  send: value => {
                    if (socket.send(value) === 0) throw new Error("remote workspace socket send dropped");
                  },
                  close: (code, reason) => socket.close(code, reason),
                },
              });
              hub.attachConnection(device.id, connection);
              socket.data.remoteWorkspaceClose = () => hub.detachConnection(device.id, connection);
              return connection;
            },
          } satisfies WsData,
        });
        return upgraded
          ? undefined as unknown as Response
          : Response.json({ error: "Remote Workspace WebSocket upgrade failed." }, { status: 426 });
      }

      // Responses WebSocket (phase 120.2). Codex upgrades the same /v1/responses path; auth is
      // handshake-time only, so capture inbound headers and thread them into the pipeline.
      if (url.pathname === "/v1/responses" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (isDraining()) {
          return drainingResponse(req, policy);
        }
        const admission = resolveResponsesApiAuth(req, policy);
        if (!admission) {
          return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        }
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "WebSocket upgrade blocked: non-local Origin"), req, policy);
        }
        // WS transport gate: Codex's built-in `openai` provider hardcodes supports_websockets=true,
        // so under Design B it always tries the WS transport first. When the feature is off, reject
        // the upgrade with 426 — codex-rs maps a connect-time UPGRADE_REQUIRED to a clean
        // session-scoped HTTP fallback (client.rs WebsocketStreamOutcome::FallbackToHttp) instead of
        // surfacing broken-pipe errors from sockets a "disabled" feature would otherwise accept.
        if (!websocketsEnabled(config)) {
          return withCors(formatErrorResponse(426, "upgrade_required", "Responses WebSocket transport is disabled; use HTTP"), req, policy);
        }
        const websocketLease = tryReserveCodexWebSocket();
        if (!websocketLease) return serverBusyResponse(req, "Codex WebSockets", policy);
        // Upgrade on the server that RECEIVED this request, not the captured `server`
        // binding. They are the same object for the public listener, but the
        // unauthenticated loopback listener (#1102) is a second Bun.serve, and handing its
        // request to the public server's upgrade would fail or cross sockets.
        if (requestServer.upgrade(req, {
          data: buildResponsesWsData(
            selectForwardHeaders(req.headers),
            admission,
            websocketLease,
            sessionLaneIdFromRequest(req.headers),
          ),
        })) return undefined as unknown as Response;
        websocketLease.release();
        return withCors(formatErrorResponse(426, "upgrade_required", "WebSocket upgrade failed"), req, policy);
      }

      if (url.pathname === "/healthz" && req.method === "GET") {
        // service/pid/port let CLI liveness reject foreign 200s and verify pid identity.
        const healthPort = ctx.server.port ?? listenPort;
        const response = jsonResponse({
          status: "ok",
          service: "opencodex",
          version: VERSION,
          uptime: process.uptime(),
          pid: process.pid,
          port: healthPort,
          restartCapability: SYSTEM_RESTART_CAPABILITY_VERSION,
          providerReloadCapability: LOCAL_PROVIDER_RELOAD_CAPABILITY_VERSION,
          guiPairCapability: GUI_PAIR_CAPABILITY_VERSION,
        }, 200, req, policy);
        const challenge = req.headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER);
        if (challenge) {
          const proof = createLocalAttestationProof(localAttestationSecret, challenge, process.pid, healthPort);
          if (proof) response.headers.set(LOCAL_ATTESTATION_PROOF_HEADER, proof);
        }
        return response;
      }

      // Readiness: like /healthz this is exact GET and unauthenticated (so a client can
      // back off BEFORE knowing the admission token), but stricter than liveness. The
      // body carries only sanitized identity + the fixed status enum; the sync message,
      // warning text, catalog path, provider output, and account data are never exposed.
      // POST or "/readyz/" must NOT match (exact pathname + GET method): answer them
      // with a JSON 404 here so they can never be silently accepted by the GUI SPA
      // fallback (which would serve index.html with HTTP 200 once gui/dist exists).
      if (readyzPath !== undefined) {
        if (readyzPath !== "/readyz" || req.method !== "GET") {
          return withCors(formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`), req, policy);
        }
        // A draining proxy must never advertise ready: every data-plane branch
        // answers drainingResponse while isDraining() is set, but the one-shot
        // readiness gate is not mutated on shutdown (it is owned by the startup
        // sync). Report pending so `ocx ready --wait` and external supervisors
        // keep polling instead of promoting a proxy that is draining.
        const status = isDraining() ? "pending" : readinessGate.getStatus();
        const body = {
          service: "opencodex",
          version: VERSION,
          uptime: process.uptime(),
          pid: process.pid,
          port: ctx.boundPort ?? listenPort,
          status,
          ...readyProtocolMetadata(config, req),
        };
        if (status === "ready") {
          return jsonResponse(body, 200, req, policy);
        }
        // Pending/failed: 503 with a conservative Retry-After so well-behaved clients
        // (and `ocx ready --wait`) back off instead of hot-looping.
        const resp = jsonResponse(body, 503, req, policy);
        const headers = new Headers(resp.headers);
        headers.set("Retry-After", "1");
        return new Response(resp.body, { status: 503, headers });
      }

      if (url.pathname.startsWith("/api/")) {
        const localManagementAuth = {
          attestationSecret: localAttestationSecret,
          pid: process.pid,
          port: ctx.boundPort ?? requestServer.port ?? listenPort,
        };
        const apiAuthError = requireManagementAuth(req, managementAuth, config, localManagementAuth);
        if (apiAuthError) return withManagementCors(apiAuthError, req, config);
        // Which credential passed the gate, resolved from the same session table the
        // gate used. Consent-bearing routes need this: request headers are forgeable
        // by anything holding the admin token, the credential is not.
        const principal = managementPrincipal(req, managementAuth, config, localManagementAuth) ?? undefined;
        if (url.pathname === GUI_PAIR_PATH) {
          if (req.method !== "POST" || principal !== "gui-pair-capability" || !managementAuth.available) {
            return withManagementCors(Response.json({ error: "GUI pairing capability required" }, { status: 403 }), req, config);
          }
          try {
            const grant = createGuiPairingGrant(
              req.headers.get(GUI_PAIR_BROWSER_ORIGIN_HEADER) ?? "",
              config,
              managementAuth,
            );
            return withManagementCors(Response.json(grant, {
              status: 201,
              headers: { "Cache-Control": "no-store" },
            }), req, config);
          } catch (error) {
            const status = error instanceof GuiPairingGrantRateLimitError ? 429 : 403;
            return withManagementCors(Response.json({ error: "GUI pairing grant refused" }, {
              status,
              ...(status === 429 ? { headers: { "Retry-After": "60" } } : {}),
            }), req, config);
          }
        }
        const mgmtResponse = await handleManagementAPI(req, url, config, requestManagementApiDeps, principal, managementSessionControl);
        if (mgmtResponse) return withManagementCors(mgmtResponse, req, config);
        return withManagementCors(formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`), req, config);
      }

      if (url.pathname === "/v1/catalog" && (req.method === "GET" || req.method === "HEAD")) {
        // #809: remote Codex clients need the model catalog, and the only prior source was
        // GET /api/catalog behind management auth — so operators had to hand out an admin
        // token to read a list of models. This route fixes that on the data plane instead of
        // widening /api/*, which stays exactly as restricted as before.
        //
        // resolveApiAuth (not resolveResponsesApiAuth) for the same reason /v1/models uses
        // it: nothing here forwards a caller credential upstream, so accepting the dedicated
        // header, a recognized bearer, or x-api-key is safe — and rejecting x-api-key would
        // 401 Anthropic-SDK clients holding a perfectly valid data credential.
        const admission = resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        const { serializePersistedCatalog, persistedCodexVersion, MAX_REMOTE_CATALOG_BYTES } = await import("../catalog-download");
        const serialized = await serializePersistedCatalog();
        if (serialized.body === null) {
          // Built directly rather than through formatErrorResponse: that helper derives
          // `code` from the status and message via classifyError, and these two need stable,
          // specific codes. `catalog_not_found` in particular is what lets a caller — and
          // tests/server/api-key-attribution.test.ts — tell "this route exists and has no catalog"
          // apart from "this route is gone", which is the difference between admission proof
          // and a vacuous pass.
          return withCors(
            new Response(JSON.stringify({
              error: { type: "invalid_request_error", code: "catalog_not_found", message: "no materialized catalog is available" },
            }), {
              status: 404,
              headers: { "content-type": "application/json" },
            }),
            req,
            policy,
          );
        }
        // Size policy belongs to this route, not the shared serializer: the management route
        // must keep its existing behavior for a catalog of any supported size.
        if (serialized.bytes !== undefined && serialized.bytes > MAX_REMOTE_CATALOG_BYTES) {
          return withCors(
            new Response(JSON.stringify({
              error: { type: "server_error", code: "catalog_too_large", message: "catalog exceeds the maximum served size" },
            }), {
              status: 507,
              headers: { "content-type": "application/json" },
            }),
            req,
            policy,
          );
        }
        const headers: Record<string, string> = {
          "content-type": "application/json",
          // Identity-varying content behind a credential: never let a shared cache keep it,
          // and never hand out a validator it could revalidate with. `no-cache` alone does
          // not prevent storage — it forces revalidation, and the revalidation is exactly
          // what would cross identities here, because this body varies by key type and key
          // id while the ETag would be derived from bytes alone. A store keyed on URL plus
          // validator could then serve one credential's representation to another. Proving
          // an identity-partitioned cache key across every intermediary in the path is a
          // much larger commitment than the bandwidth a 304 saves on this payload, so this
          // route declines the trade: no-store, no ETag, no 304.
          //
          // GET /api/catalog keeps its validator. That route is management-authenticated
          // and loopback-scoped, and its representation does not vary by data-key identity.
          "cache-control": "no-store",
        };
        const version = await persistedCodexVersion();
        if (version) headers["x-opencodex-codex-version"] = version;
        // No conditional handling: with no validator emitted, an If-None-Match on this route
        // can only have been guessed or copied from elsewhere, and honoring it would
        // reintroduce the cross-identity path above. Every request gets the full body.
        if (serialized.bytes !== undefined) headers["content-length"] = String(serialized.bytes);
        // HEAD returns identical status and headers with no body.
        return withRemoteCatalogKeyId(
          withCors(
            new Response(req.method === "HEAD" ? null : serialized.body, { status: 200, headers }),
            req,
            policy,
          ),
          admission,
        );
      }

      if (url.pathname === "/v1/usage" && req.method === "GET") {
        const { handleHubUsage } = await import("../hub-usage");
        return handleHubUsage(req, config, policy);
      }

      if (url.pathname === "/v1/hub-state" && (req.method === "GET" || req.method === "HEAD")) {
        // #4236: a connected client had no way to learn which providers this hub can actually
        // serve, so `ocx status` on the client reported the CLIENT's empty credential store as
        // if it were the truth — "xai ✗ not logged in" on a machine whose hub has xAI logged
        // in. The fix is one least-privilege data-plane read, in the /v1/catalog (#809)
        // tradition: same admission resolver, same origin check, no parameters, no caller
        // credential forwarded upstream, and a body of booleans plus model ids. Widening
        // `/api/*` or handing the client an admin token to read `GET /api/providers` would
        // have traded a reporting defect for a credential one.
        //
        // What it discloses beyond /v1/catalog and /v1/models, exactly: `hasCredential`,
        // `loggedIn`, `authMode`, the featured roster, and the NAME and adapter of an ENABLED
        // provider those routes omit for want of a usable credential — which is the point of
        // the route. A `disabled` provider is NOT exported (`buildHubState` drops it), because
        // the catalog filters it out too and naming it here would be the only place a data key
        // learns of it.
        //
        // Placed between /v1/catalog and /v1/models so all three least-privilege client reads
        // stay in sight of each other.
        const admission = resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        // Role gate AFTER admission, deliberately: answering an unauthenticated caller would
        // turn this into a free "is that machine a hub?" probe. A standalone or client install
        // gains no surface at all — the route simply does not exist there.
        //
        // Built, not formatErrorResponse'd, for the same reason /v1/catalog builds its 404: the
        // code has to distinguish "this route exists and this host is not a hub" from "this
        // build has no such route", which is the difference between admission proof and a
        // vacuous pass in tests/server/api-key-attribution.test.ts.
        if (config.runtimeRole !== "hub") {
          return withCors(
            new Response(JSON.stringify({
              error: {
                type: "invalid_request_error",
                code: "hub_state_not_a_hub",
                message: "hub state is served only by a host whose runtimeRole is hub",
              },
            }), { status: 404, headers: { "content-type": "application/json" } }),
            req,
            policy,
          );
        }
        const { buildHubState } = await import("../hub-state");
        const { MAX_HUB_STATE_BYTES } = await import("../../remote/hub-state");
        const { oauthLoginSummary } = await import("../../oauth");
        // `true` masks emails, but the projection drops the field entirely; passing the mask
        // anyway means a future refactor that starts copying fields cannot leak a raw address.
        const body = JSON.stringify(buildHubState(config, oauthLoginSummary(true), VERSION));
        const bytes = Buffer.byteLength(body);
        if (bytes > MAX_HUB_STATE_BYTES) {
          return withCors(
            new Response(JSON.stringify({
              error: { type: "server_error", code: "hub_state_too_large", message: "hub state exceeds the maximum served size" },
            }), { status: 507, headers: { "content-type": "application/json" } }),
            req,
            policy,
          );
        }
        return withCors(
          new Response(req.method === "HEAD" ? null : body, {
            status: 200,
            headers: {
              "content-type": "application/json",
              // Varies by credential-bearing identity and by live login state: never cached,
              // and no validator to revalidate with (same rule as /v1/catalog).
              "cache-control": "no-store",
              "content-length": String(bytes),
            },
          }),
          req,
          policy,
        );
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        // #809: the catalog read sits immediately before model discovery because it shares
        // that route's admission rationale exactly. Keep them adjacent so a future change to
        // one is made in sight of the other.
        // Model discovery never forwards Authorization upstream, so the broader admission
        // set (Authorization / x-api-key / x-opencodex-api-key) is safe here and required by
        // remote OpenAI-style bearer clients and Claude gateway discovery (anthropic-version).
        const admission = resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        const wantsDesktopConfig = url.searchParams.get("format") === "desktop-config";
        if (wantsDesktopConfig && (url.searchParams.get("ids") === "cli" || url.searchParams.has("client_version"))) {
          return jsonResponse({ error: "Desktop config format cannot use CLI or client-version selectors" }, 400, req, policy);
        }
        // The Integrations page reports whether a Cursor client has reached this proxy; the
        // recorder keeps only a bounded User-Agent value and a timestamp, in memory.
        recordCursorSeen(req.headers);
        let goModels;
        let modelEntitlements;
        try {
          [goModels, modelEntitlements] = await Promise.all([
            fetchAllModels(config),
            // Codex sends its own client_version on this request, and upstream filters the
            // entitlement roster by it. Passing it through is what stops an entitled account
            // being told it cannot use models a newer client can (#2886).
            // The request signal fences the credential phase too: a client that has already
            // gone away must not keep a native-main token refresh alive, and its late result
            // must not commit on behalf of a request that no longer exists.
            resolveAdmittedCodexModelEntitlements(config, {
              clientVersion: url.searchParams.get("client_version"),
              signal: req.signal,
            }),
          ]);
        } catch (error) {
          if (error instanceof CatalogGatherBusyError) {
            return withCors(new Response(JSON.stringify({ error: { type: "server_error", code: "catalog_busy", message: error.message } }), {
              status: 503,
              headers: { "content-type": "application/json", "Retry-After": "1" },
            }), req, policy);
          }
          throw error;
        }
        const { accountBoundNativeOpenAiSlugsBySelector, applyNativeVisibility, buildCatalogEntries, configuredNativeAliasSlugs, desktopAllowlistSuppressedNativeSlugs, disabledNativeSlugs, exactComboCatalogSlugs, loadCatalogTemplate, NATIVE_OPENAI_MODELS, nativeContextLimits, nativeInputModalities, nativeOpenAiContextWindow, nativeOpenAiMaxOutputTokens, nativeOpenAiContextTier, nativeOpenAiSlugs, nativeReasoningEfforts, nativeDefaultReasoningEffort, shouldIncludeAccountBoundNativeOpenAi, shouldIncludeNativeOpenAi, uniqueCatalogModelsForRawPublicList, visibleCodexAccountSelectors, visibleNativeSlugs, desktopVisibleNativeSlugs } = await import("../../codex/catalog");
        const { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } = await import("../../codex/catalog/native-models");
        const includeNativeOpenAi = shouldIncludeNativeOpenAi(config);
        const includeAccountBoundNativeOpenAi = shouldIncludeAccountBoundNativeOpenAi(config);
        const bareEligibleAccountIds = providerCodexAccountMode(
          OPENAI_CODEX_PROVIDER_ID,
          config.providers[OPENAI_CODEX_PROVIDER_ID],
        ) === "direct" ? new Set([MAIN_CODEX_ACCOUNT_ID]) : undefined;
        const availableBareGatedNativeSlugs = availableAccountGatedNativeModels(
          modelEntitlements,
          bareEligibleAccountIds,
        );
        const availableAccountGatedNativeSlugs = availableAccountGatedNativeModels(modelEntitlements);
        const availableBareNativeSlugs = NATIVE_OPENAI_MODELS.filter(slug => (
          !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableBareGatedNativeSlugs.has(slug)
        ));
        const availableAccountNativeSlugs = NATIVE_OPENAI_MODELS.filter(slug => (
          !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableAccountGatedNativeSlugs.has(slug)
        ));
        const nativeSlugs = includeNativeOpenAi
          ? nativeOpenAiSlugs().filter(slug => (
              !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableBareGatedNativeSlugs.has(slug)
            ))
          : [];
        const disabledNatives = disabledNativeSlugs(config);
        const disabledModels = new Set(config.disabledModels ?? []);
        const exactComboSlugs = exactComboCatalogSlugs(config);
        const shadowedNativeSlugs = configuredNativeAliasSlugs(config);
        const suppressedBareNativeSlugs = new Set([
          ...desktopAllowlistSuppressedNativeSlugs(config),
          ...[...ACCOUNT_GATED_NATIVE_OPENAI_MODELS].filter(slug => !availableBareGatedNativeSlugs.has(slug)),
        ]);
        const accountSelectors = includeAccountBoundNativeOpenAi
          ? visibleCodexAccountSelectors(config)
          : [];
        const accountTargets = new Map(codexAccountNamespaceEntries(config));
        const accountNativeSlugsBySelector = includeAccountBoundNativeOpenAi
          ? new Map([...accountBoundNativeOpenAiSlugsBySelector(config)].map(([selector, slugs]) => {
            const target = accountTargets.get(selector);
            const accountId = target && isMainCodexAccountTarget(target) ? MAIN_CODEX_ACCOUNT_ID : target;
            return [selector, slugs.filter(slug => (
              !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug)
              || (accountId !== undefined
                && codexModelEntitlementStateForAccount(modelEntitlements, accountId, slug) === "granted")
            ))] as const;
          }))
          : new Map<string, readonly string[]>();
        const accountNativeSlugs = [...new Set(
          [...accountNativeSlugsBySelector.values()].flatMap(slugs => [...slugs]),
        )];
        const desktopInputs = buildDesktopDiscoveryInputs({
          config, models: goModels, modelEntitlements,
          desktopNativeCandidates: desktopVisibleNativeSlugs(config),
        });
        const desktopNativeSlugs = desktopInputs.nativeSlugs;
        const goOrdered = desktopInputs.routedModels;
        // Claude Code / Claude Desktop gateway model discovery (GET /v1/models with
        // Anthropic-style headers; 003 G1-G8 + devlog 131). Entries use the official
        // ModelInfo shape incl. capabilities (effort ladder / thinking) — Desktop 3P can
        // only learn capabilities through discovery, and Claude Code 2.1.207 strips the
        // extra fields (backward-safe). Ids are the claude-opus-4-8-{code} Desktop
        // aliases; legacy claude-ocx-* ids keep decoding via resolveAlias. Detection:
        // anthropic-version header (Claude Code sends it) or explicit ?flavor=anthropic.
        // Codex catalog (client_version) and the OpenAI list shape below stay byte-identical.
        const wantsAnthropicList = wantsDesktopConfig || req.headers.get("anthropic-version") !== null
          || url.searchParams.get("flavor") === "anthropic";
        /**
         * Whether a NATIVE slug may carry a Fast sibling.
         *
         * Both halves are required. Upstream asserts the tier per model — the same
         * `additional_speed_tiers` the Codex picker's own toggle is built from — but an
         * operator capability override or the final wire resolution can still make the
         * route ineligible, and `decideTier` would then drop the tier the row advertised.
         *
         * Declared here, above the Claude discovery call, because that call reads it while
         * the raw OpenAI mapper further down does too; defining it there would leave this
         * use in its temporal dead zone.
         */
        const nativeFastEligible = (metadataId: string): boolean =>
          catalogFastRowEligible(config, { provider: OPENAI_CODEX_PROVIDER_ID, id: metadataId, native: true });

        /**
         * Whether a routed catalog row may carry a Fast sibling.
         *
         * A combo is its own namespace with no `config.providers` entry — declaring a
         * provider named `combo` is rejected (combos/types.ts:191) — so provider lookup
         * cannot classify it. Its aggregated `supportsServiceTier` is already true only
         * when EVERY member supports the tier (aggregation.ts:201), which is the right
         * rule for a row that fans out to all of them.
         *
         * Declared beside nativeFastEligible, above the Claude discovery call that reads
         * both; defining it near the raw OpenAI mapper below would leave that use in its
         * temporal dead zone.
         */
        const catalogRowFastEligible = (m: { provider: string; id: string; supportsServiceTier?: boolean }): boolean =>
          catalogFastRowEligible(config, m);

        if (wantsAnthropicList && !url.searchParams.has("client_version")) {
          if (wantsDesktopConfig) {
            const models = config.claudeCode?.enabled === false ? [] : generateDesktop3pModels(
              desktopInputs.nativeSlugs, desktopInputs.routedModels,
              config.claudeCode?.desktopProfile, desktopInputs.nativeContextCap,
            );
            const response = jsonResponse({ version: 1, models }, 200, req, policy);
            response.headers.set("Cache-Control", "no-store");
            return response;
          }
          if (config.claudeCode?.enabled === false) return jsonResponse({ data: [] }, 200, req, policy);
          // Build Desktop 3P registry so inbound alias resolution works for subsequent requests.
          buildDesktop3pRegistry(
            desktopNativeSlugs,
            desktopInputs.routedModels,
            config.claudeCode?.desktopProfile,
            desktopInputs.nativeContextCap,
          );
          const { buildAnthropicModelInfos } = await import("../../claude/model-info");
          const { resolveAutoContext } = await import("../../claude/context-windows");
          const { activeDesktop3pAlias } = await import("../../claude/desktop-3p");
          // Per-surface id family (devlog 050): explicit ?ids= wins; otherwise the
          // Claude Code CLI discovery UA (`claude-code/<version>`, binary n_()) gets
          // readable claude-ocx ids and every other client (Desktop 3P) keeps the
          // hashed family its config was written with. Unknown UA -> hashed (safe).
          const idsParam = url.searchParams.get("ids");
          const idStyle = idsParam === "cli"
            ? "readable" as const
            : idsParam === "desktop"
              ? "desktop3p" as const
              : (/^claude-code\//i.test(req.headers.get("user-agent") ?? "") ? "readable" as const : "desktop3p" as const);
          const data = buildAnthropicModelInfos(
            desktopNativeSlugs,
            goOrdered,
            resolveAutoContext(config.claudeCode),
            idStyle,
            activeDesktop3pAlias,
            desktopInputs.nativeContextCap,
            config.fastMode,
            // Explicit opt-out omits the Fast predicate.
            config.fastRows !== false
              ? (model: { provider: string; id: string; supportsServiceTier?: boolean }) =>
                model.provider === "native"
                  ? nativeFastEligible(model.id)
                  : catalogRowFastEligible(model)
              : undefined,
            { modelPickerOrder: config.modelPickerOrder, featured: config.subagentModels },
          );
          return jsonResponse({ data }, 200, req, policy);
        }
        if (url.searchParams.has("client_version")) {
          // Codex client → Codex catalog shape: native gpt + namespaced routed models,
          // cloned from a native template so required fields (base_instructions, etc.) are present.
          // Pass the subagent picks so featured models lead by priority (matches the on-disk file).
          // Disabled natives stay in the catalog shape with visibility "hide" (mirrors the
          // on-disk sync; codex-rs keeps them out of the picker itself).
          const maMode = config.multiAgentMode === "v1" || config.multiAgentMode === "v2" ? config.multiAgentMode : "default";
          // Account rows use the same hidden-inclusive supported set as on-disk sync. This lets a
          // newly re-enabled native reappear under each selector before the next sync, while the
          // no-selector path keeps nativeOpenAiSlugs()'s existing visibility-sensitive behavior.
          const catalogNativeSlugs = accountSelectors.length > 0
            ? [...new Set([
              ...availableAccountNativeSlugs,
              ...accountNativeSlugs,
            ])]
            : nativeSlugs;
          const entries = buildCatalogEntries(
            loadCatalogTemplate(),
            catalogNativeSlugs,
            goOrdered,
            config.subagentModels,
            websocketsEnabled(config),
            maMode as "v1" | "default" | "v2",
            exactComboSlugs,
            accountSelectors,
            suppressedBareNativeSlugs,
            new Set(),
            nativeContextLimits(config),
            accountNativeSlugs,
            accountNativeSlugsBySelector,
            config.keepNativeChatGptOnV1 === true,
            config.modelPickerOrder,
          );
          return jsonResponse({
            models: applyNativeVisibility(
              entries,
              disabledModels,
              accountSelectors.length > 0,
              new Set(accountNativeSlugs),
            ),
          }, 200, req, policy);
        }
        // OpenAI list shape: native gpt bare + routed models namespaced "<provider>/<id>"
        // (pure availability list — disabled natives are omitted entirely).
        // Grok Build discovers models through this endpoint too, and its model picker only
        // enables /effort for entries that advertise the reasoning ladder in the Grok model
        // catalog shape (supports_reasoning_effort + reasoning_efforts[]). The Codex catalog
        // branch above already carries the same ladders, so mirror them here — native rows
        // from the upstream snapshot, routed rows from the configured provider tiers. The
        // default uses the same canonical fallback as the Codex catalog resolver
        // (configured default, then medium, then high, then the first tier). Extra fields
        // are ignored by plain OpenAI clients.
        const grokEffortOption = (value: string, isDefault: boolean) => ({
          value,
          label: `${value[0].toUpperCase()}${value.slice(1)} Effort`,
          ...(isDefault ? { default: true } : {}),
        });
        const grokEffortFields = (efforts: string[], configuredDefault?: string) => {
          const defaultEffort = grokDefaultReasoningEffort(efforts, configuredDefault);
          if (defaultEffort === undefined) return {};
          return {
            supports_reasoning_effort: true,
            reasoning_effort: defaultEffort,
            reasoning_efforts: efforts.map(effort => grokEffortOption(effort, effort === defaultEffort)),
          };
        };
        // Cursor's local-agent runtime (Private Inference build) reads api_types + capabilities
        // to enable its effort control; every other consumer ignores them. See
        // src/server/models-capabilities.ts.
        const nativeLimits = nativeContextLimits(config);
        const nativeContextInput = (metadataId: string) => {
          const tier = nativeOpenAiContextTier(metadataId, nativeLimits);
          return tier
            ? { contextWindow: tier.defaultWindow, longContextWindow: tier.longWindow }
            : { contextWindow: nativeOpenAiContextWindow(metadataId, nativeLimits) };
        };
        const nativeModelRow = (id: string, metadataId = id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "openai",
            ...grokEffortFields(
              nativeReasoningEfforts(metadataId),
              nativeDefaultReasoningEffort(metadataId),
            ),
            ...modelCapabilityFields({
              reasoningEfforts: nativeReasoningEfforts(metadataId),
              // Cursor "Max Mode": advertise the family's default/long pair (272k/922k for
              // GPT-5.6) so the client can pick per request; without a tier, the effective
              // window is the only value.
              ...nativeContextInput(metadataId),
              maxOutputTokens: nativeOpenAiMaxOutputTokens(metadataId),
              inputModalities: nativeInputModalities(metadataId),
            }),
          });
        // Resolved once per request, not per model: the global fast switch offers the fast
        // identity to clients that have no Fast toggle of their own. Null when the switch is
        // off, so the row mapper does no work and loads no adapter module.
        const cursorFastIdForListing = config.fastMode === true
          ? await (async () => {
            const { cursorFastIdFor } = await import("../../adapters/cursor/catalog");
            return (modelId: string, provider = "cursor") => provider === "cursor" ? cursorFastIdFor(modelId) : undefined;
          })()
          : null;
        // Selector-active discovery follows the same complete supported set as the Codex catalog
        // for both bare and qualified rows. Without selectors, the live catalog continues to own
        // bare availability.
        const selectorNativeSlugs = accountSelectors.length > 0
          ? availableBareNativeSlugs.filter(slug => !disabledNatives.has(slug))
          : [];
        const bareSelectorNativeSlugs = accountSelectors.length > 0
          ? selectorNativeSlugs
          : [];
        const visibleNatives = includeNativeOpenAi
          ? accountSelectors.length > 0
            ? bareSelectorNativeSlugs.filter(slug => !shadowedNativeSlugs.has(slug))
            : visibleNativeSlugs(config)
          : [];
        const visibleAccountNatives = accountSelectors.flatMap(selector =>
          (accountNativeSlugsBySelector.get(selector) ?? []).filter(metadataId => !disabledNatives.has(metadataId)).flatMap(metadataId => {
            const id = `${selector}/${metadataId}`;
            return disabledModels.has(id) ? [] : [{ id, metadataId }];
          })
        );
        // What a scoped key may see, filtered by the same predicate that refuses
        // it on the data plane, so the catalog and the send path cannot disagree.
        // This is a convenience, never the boundary: hiding a row only stops a
        // client that reads the catalog first, which is why the refusal lives on
        // the request path and this filter reuses it rather than replacing it.
        // Filtering happens where the resolved provider and model are still in
        // hand -- a published id is a selector, and re-resolving one here would
        // re-run combo selection just to render a list.
        const listScope = resolveAdmissionModelScope(config, admission);
        const listAllows = (providerName: string, modelId: string): boolean =>
          routeAllowedByScope(listScope, { providerName, modelId });
        // The projection is opt-in. Keep the default path free of Cursor install detection,
        // and resolve the bundle table once for the whole list rather than once per row.
        const effortRowsEnabled = config.cursorEffortRows === true;
        // Explicit opt-out skips policy resolution and additional rows.
        const fastRowsEnabled = config.fastRows !== false;
        // One inventory serves both grammars; building it twice would double the work on a
        // hot path for no benefit.
        const effortRowKnownIds = effortRowsEnabled || fastRowsEnabled
          ? knownEffortRowIds(config)
          : undefined;
        const privateInference = effortRowsEnabled
          ? detectCursorInstalls().find(install => install.build === "private-inference")
          : undefined;
        const cursorEffortTable = effortRowsEnabled
          ? (deps.managementApi?.loadCursorEffortTable ?? loadCursorEffortTable)(privateInference)
          : null;
        const expandedNativeModelRow = (id: string, metadataId = id) => {
          const reasoningEfforts = nativeReasoningEfforts(metadataId);
          return expandCursorEffortRow(nativeModelRow(id, metadataId), reasoningEfforts, config, {
            knownIds: effortRowKnownIds,
            table: cursorEffortTable,
            supportsReasoning: reasoningEfforts.length > 0,
          }).flatMap(row => expandFastRow(
            row,
            // Only the BASE row earns a fast sibling. An effort row already spent the
            // grammar, and the parser requires the stripped base to be routable, so
            // `<base>--<effort>--fast` would publish a row no ingress can resolve.
            row.id === id && nativeFastEligible(metadataId),
            config,
            effortRowKnownIds,
          ));
        };
        const routedRows = await Promise.all(uniqueCatalogModelsForRawPublicList(goOrdered)
          .filter(m => listAllows(m.provider, m.id))
          .map(async m => {
          // Same rule as the anthropic branch: with the global fast switch on, a client
          // that has no Fast toggle is offered the fast identity directly. An operator
          // alias is an explicit decision and still wins.
          const fastModelId = cursorFastIdForListing?.(m.id, m.provider);
          const publicId = m.alias ?? `${m.provider}/${fastModelId ?? m.id}`;
          const isCombo = m.provider === "combo" && exactComboSlugs.has(publicId);
          const provider = config.providers[m.provider];
          const effective = provider
            ? (await import("../../providers/default-aliases")).effectiveModelAliases(
                config,
                provider,
                knownModelIdsForProvider(m.provider, provider, config),
              ).get(m.id)
            : undefined;
          const row = {
            id: publicId,
            object: "model",
            created: 0,
            // This endpoint is an OpenAI-compatible inbound contract. Some clients use
            // owned_by as an adapter selector, so a virtual combo must name that wire
            // adapter rather than the internal catalog authority marker.
            owned_by: isCombo ? "openai" : (m.owned_by ?? m.provider),
            ...(isCombo ? { is_combo: true } : {}),
            ...(effective ? { alias_of: `${provider?.alias || m.provider}/${effective.alias}` } : {}),
            ...grokEffortFields(m.reasoningEfforts ?? [], m.defaultReasoningEffort),
            ...modelCapabilityFields({
              reasoningEfforts: m.reasoningEfforts,
              // contextWindow is already the post-cap effective value; contextCap is the raw
              // operator knob and over-reports models whose real window sits below it.
              contextWindow: m.contextWindow,
              maxOutputTokens: m.maxOutputTokens,
              inputModalities: m.inputModalities,
            }),
          };
          return expandCursorEffortRow(row, m.reasoningEfforts, config, {
            knownIds: effortRowKnownIds,
            table: cursorEffortTable,
            supportsReasoning: (m.reasoningEfforts ?? []).length > 0,
          }).flatMap(expanded => expandFastRow(
            expanded,
            expanded.id === row.id && catalogRowFastEligible(m),
            config,
            effortRowKnownIds,
          ));
        }));
        const data = [
          ...visibleNatives
            .filter(id => listAllows(OPENAI_CODEX_PROVIDER_ID, id))
            .flatMap(id => expandedNativeModelRow(id)),
          ...visibleAccountNatives
            .filter(({ metadataId }) => listAllows(OPENAI_CODEX_PROVIDER_ID, metadataId))
            .flatMap(({ id, metadataId }) => expandedNativeModelRow(id, metadataId)),
          ...routedRows.flat(),
        ];
        return jsonResponse({ object: "list", data }, 200, req, policy);
      }

      // Remote compaction v1 (codex-rs with Feature::RemoteCompactionV2 off — the default).
      // Must be matched BEFORE the /v1/responses POST branch never sees it (distinct path) and
      // before the /v1/* 404 guard below.
      if (url.pathname === "/v1/responses/compact" && req.method === "POST") {
        if (isDraining()) {
          return drainingResponse(req, policy);
        }
        const admission = resolveResponsesApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = {
          model: "unknown",
          provider: "unknown",
          ...requestMetricsLogContext,
          ...admissionFields(admission),
          inboundProtocol: "responses",
        };
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => {
          let response: Response;
          try {
            response = await handleResponsesCompact(req, config, logCtx, turnAdmissionLease, admission, {
              onRequestBodyRead: () => disableResponsesRequestTimeout(req, requestServer),
            });
          } catch {
            response = formatErrorResponse(500, "server_error", "Unexpected compact request failure");
          }
          addFinalRequestLog(requestId, start, logCtx, response.status,
            response.status === 499 ? { closeReason: "client_cancel" } : undefined);
          return withCors(response, req, policy);
        }, { requestId, start, logCtx });
      }

      if (
        req.method === "POST"
        && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits")
      ) {
        disableResponsesRequestTimeout(req, requestServer);
        if (isDraining()) {
          return drainingResponse(req, policy);
        }
        const admission = resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = {
          model: "image_gen",
          provider: "unknown",
          ...requestMetricsLogContext,
          ...admissionFields(admission),
        };
        const endpoint = url.pathname.endsWith("/edits") ? "edits" as const : "generations" as const;
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => {
          const response = await handleImages(req, config, endpoint, logCtx, turnAdmissionLease);
          addFinalRequestLog(requestId, start, logCtx, response.status, response.status === 499 ? { closeReason: "client_cancel" } : undefined);
          return withCors(response, req, policy);
        }, { requestId, start, logCtx });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/opencodex/artifacts/")) {
        const admission = resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        const id = decodeURIComponent(url.pathname.slice("/v1/opencodex/artifacts/".length));
        const { resolveArtifactPath } = await import("../../images/artifacts");
        const artifactPath = resolveArtifactPath(id);
        if (!artifactPath) {
          return withCors(formatErrorResponse(404, "not_found", "artifact not found"), req, policy);
        }
        const file = Bun.file(artifactPath);
        const ext = artifactPath.split(".").pop()?.toLowerCase();
        const contentType =
          ext === "png" ? "image/png"
            : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
              : ext === "webp" ? "image/webp"
                : ext === "gif" ? "image/gif"
                  : "application/octet-stream";
        return withCors(new Response(file, {
          status: 200,
          headers: {
            "content-type": contentType,
            "cache-control": "private, max-age=3600",
            "x-content-type-options": "nosniff",
          },
        }), req, policy);
      }

      if (contextEndpoint(url.pathname) !== undefined && req.method === "POST" && contextRelayActivated()) {
        // No timeout disable here. The relay is a bounded JSON round trip that owns one deadline
        // from entry; removing the idle timeout first would let an unfinished body hold an
        // admitted turn slot indefinitely, before that deadline ever starts.
        if (isDraining()) {
          return drainingResponse(req, policy);
        }
        const admission = resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = {
          model: "context_history",
          provider: "unknown",
          ...requestMetricsLogContext,
          ...admissionFields(admission),
        };
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => {
          const response = await handleContextHistory(req, config, logCtx, contextEndpoint(url.pathname)!,
            turnAdmissionLease, admission, () => resolveApiAuth(req, policy));
          addFinalRequestLog(requestId, start, logCtx, response.status,
            response.status === 499 ? { closeReason: "client_cancel" } : undefined);
          return withCors(response, req, policy);
        }, { requestId, start, logCtx });
      }

      if (url.pathname === "/v1/alpha/search" && req.method === "POST") {
        disableResponsesRequestTimeout(req, requestServer);
        if (isDraining()) {
          return drainingResponse(req, policy);
        }
        const admission = resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = {
          model: "web_search",
          provider: "unknown",
          ...requestMetricsLogContext,
          ...admissionFields(admission),
        };
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => {
          const response = await handleSearch(req, config, logCtx, turnAdmissionLease, admission);
          addFinalRequestLog(requestId, start, logCtx, response.status,
            response.status === 499 ? { closeReason: "client_cancel" } : undefined);
          return withCors(response, req, policy);
        }, { requestId, start, logCtx });
      }

      if (url.pathname === "/v1/responses" && req.method === "POST") {
        if (isDraining()) {
          return drainingResponse(req, policy);
        }
        const admission = resolveResponsesApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = {
          model: "unknown",
          provider: "unknown",
          ...requestMetricsLogContext,
          ...admissionFields(admission),
          inboundProtocol: "responses",
        };
        if (req.headers.get("x-opencodex-grok") === "1") logCtx.surface = "grok";
        let logged = false;
        const finalizeNativePassthroughLog = (
          status: number,
          meta: Pick<RequestLogEntry, "terminalStatus" | "closeReason">,
        ) => {
          if (logged) return;
          logged = true;
          addFinalRequestLog(requestId, start, logCtx, status, meta);
        };
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => {
          let response: Response;
          try {
            response = await handleResponses(req, config, logCtx, {
              turnAdmissionLease,
              admission,
              onRequestBodyRead: () => disableResponsesRequestTimeout(req, requestServer),
              abortSignal: req.signal,
              onFirstOutput: () => recordFirstOutput(logCtx, start),
              onNativePassthroughTerminal: status => {
                finalizeNativePassthroughLog(httpStatusForRequestLogTerminal(status, logCtx), {
                  terminalStatus: status,
                  closeReason: "terminal",
                });
              },
              onNativePassthroughCancel: () => {
                finalizeNativePassthroughLog(499, { closeReason: "client_cancel" });
              },
            });
          } catch (error) {
            // A bounded upstream body can fail before handleResponses returns a client response.
            // Finalize before rethrow so accounting observes the physical send while the caller
            // retains the existing reset/rejection instead of receiving a synthesized response.
            finalizeNativePassthroughLog(
              req.signal.aborted ? 499 : 502,
              { closeReason: req.signal.aborted ? "client_cancel" : "non_stream" },
            );
            throw error;
          }
          return withRequestLogId(
            withCors(responseWithDeferredRequestLog(response, requestId, start, logCtx), req, policy),
            requestId,
          );
        }, { requestId, start, logCtx });
      }

      // Anthropic Messages inbound (Claude Code). count_tokens FIRST (longer path).
      // Claude Code posts `/v1/messages?beta=true` — pathname match ignores the query (003 G9).
      if (url.pathname === "/v1/messages/count_tokens" && req.method === "POST") {
        if (isDraining()) {
          return drainingResponse(req, policy);
        }
        const admission = resolveApiAuth(req, policy);
        if (!admission) {
          return withCors(anthropicErrorResponse(401, "opencodex API key required", "authentication_error"), req, policy);
        }
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(anthropicErrorResponse(403, "cross-origin data-plane request blocked", "permission_error"), req, policy);
        }
        return runAdmittedHttpTurn(req, policy, async () => withCors(
          await handleClaudeCountTokens(req, config, policy),
          req,
          policy,
        ));
      }

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        disableResponsesRequestTimeout(req, requestServer);
        if (isDraining()) {
          return drainingResponse(req, policy);
        }
        const admission = resolveApiAuth(req, policy);
        if (!admission) {
          return withCors(anthropicErrorResponse(401, "opencodex API key required", "authentication_error"), req, policy);
        }
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(anthropicErrorResponse(403, "cross-origin data-plane request blocked", "permission_error"), req, policy);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = {
          model: "unknown",
          provider: "unknown",
          ...requestMetricsLogContext,
          ...admissionFields(admission),
          inboundProtocol: "messages",
        };
        // Logging is finalized inside handleClaudeMessages (Responses-vocab tap on the
        // pre-translation stream + native passthrough callbacks) — do not re-wrap the
        // translated Anthropic stream here.
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => withCors(
          await handleClaudeMessages(req, config, logCtx, { requestId, start, turnAdmissionLease, admission }, policy),
          req,
          policy,
        ), { requestId, start, logCtx });
      }

      // OpenAI Chat Completions inbound (GitHub Copilot App / OpenAI-compatible clients).
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        disableResponsesRequestTimeout(req, requestServer);
        if (isDraining()) {
          return drainingResponse(req, policy);
        }
        const admission = resolveResponsesApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = {
          model: "unknown",
          provider: "unknown",
          ...requestMetricsLogContext,
          ...admissionFields(admission),
          inboundProtocol: "chat",
        };
        // `policy`, not `config`: this route is now served on the unauthenticated loopback
        // listener too (#4236), and only the receiving listener's view produces CORS headers
        // that match the admission decision made above.
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => withCors(
          await handleChatCompletions(req, config, logCtx, { requestId, start, turnAdmissionLease, admission }),
          req,
          policy,
        ), { requestId, start, logCtx });
      }

      if (url.pathname === "/v1/audio/transcriptions" && req.method === "POST") {
        disableResponsesRequestTimeout(req, requestServer);
        if (isDraining()) return drainingResponse(req, policy);
        const admission = resolveAudioAdmission(req.headers, config);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin audio request blocked"), req, policy);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = {
          model: TRANSCRIPTION_MODEL,
          provider: "unknown",
          ...requestMetricsLogContext,
          ...admissionFields(admission),
        };
        return runAdmittedHttpTurn(req, policy, async lease => {
          const response = await handleAudioTranscriptions(req, config, logCtx, admission, lease);
          addFinalRequestLog(requestId, start, logCtx, response.status);
          return withCors(response, req, policy);
        }, { requestId, start, logCtx });
      }

      // ChatGPT / Codex App voice (GPT‑Live / Frameless Bidi) + OpenAI Realtime call-create.
      // Clients hit either /v1/live (Frameless App) or /v1/realtime/calls (codex RealtimeCallClient /
      // public Realtime API). Sideband WS joins are handled just below.
      if (
        req.method === "POST"
        && (url.pathname === "/v1/live" || url.pathname === "/v1/realtime/calls")
      ) {
        disableResponsesRequestTimeout(req, requestServer);
        if (isDraining()) {
          return drainingResponse(req, policy);
        }
        const audioClient = resolveAudioClient(req, config);
        if (audioClient instanceof Response) return withCors(audioClient, req, policy);
        const admission = audioClient?.admission ?? resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = {
          model: "gpt-live",
          provider: "unknown",
          ...requestMetricsLogContext,
          ...admissionFields(admission),
        };
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => {
          const response = audioClient
            ? await handleExternalLive(req, config, logCtx, { client: audioClient, lease: turnAdmissionLease, bindings: liveCallBindings })
            : await handleLive(req, config, logCtx, turnAdmissionLease);
          addFinalRequestLog(
            requestId,
            start,
            logCtx,
            response.status,
            response.status === 499 ? { closeReason: "client_cancel" } : undefined,
          );
          return withCors(response, req, policy);
        }, { requestId, start, logCtx });
      }

      // Voice / Realtime WebSocket relay. Sideband joins: Frameless /v1/live/{callId};
      // Realtime v1 /v1/realtime?call_id= (or /v1/realtime/calls/{callId}). Standalone
      // sessions (codex-rs thread/realtime/start, WebSocket transport — the desktop voice
      // path): /v1/realtime?intent=quicksilver&model= and /v1/live?model=.
      // Transparent bidirectional relay.
      const liveSidebandTarget = req.headers.get("upgrade")?.toLowerCase() === "websocket"
        ? parseLiveSidebandTarget(url.pathname, url.searchParams, url.search.replace(/^\?/, ""))
        : null;
      const dictationSocket = url.pathname === "/v1/audio/transcriptions/stream"
        && req.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (liveSidebandTarget || dictationSocket) {
        if (isDraining()) {
          return drainingResponse(req, policy);
        }
        const audioClient = resolveAudioClient(req, config, dictationSocket);
        if (audioClient instanceof Response) return withCors(audioClient, req, policy);
        if (!audioClient && liveSidebandTarget && "callId" in liveSidebandTarget
          && liveSidebandTarget.callId.startsWith(EXTERNAL_CALL_PREFIX)) {
          return withCors(formatErrorResponse(401, "authentication_error", "Live call requires its creator API key"), req, policy);
        }
        const admission = audioClient?.admission ?? resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "WebSocket upgrade blocked: non-local Origin"), req, policy);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = {
          model: "gpt-live",
          provider: "unknown",
          ...requestMetricsLogContext,
          ...admissionFields(admission),
        };
        let liveRequestFinalized = false;
        const finalizeLiveRequest = (
          status: number,
          meta?: Pick<RequestLogEntry, "terminalStatus" | "closeReason">,
        ): void => {
          if (liveRequestFinalized) return;
          liveRequestFinalized = true;
          addFinalRequestLog(requestId, start, logCtx, status, meta);
        };
        const turnAdmissionLease = tryAdmitTurn(sessionLaneIdFromRequest(req.headers));
        if (!turnAdmissionLease) {
          finalizeLiveRequest(503);
          return serverBusyResponse(req, "active turns", policy);
        }
        const audioController = audioClient ? new AbortController() : undefined;
        if (audioController) registerTurn(audioController, turnAdmissionLease);
        const acquisition = audioController
          ? clearableDeadline(120_000, AbortSignal.any([req.signal, audioController.signal])) : undefined;
        const releaseAcquisition = () => {
          acquisition?.clear();
          if (audioController) unregisterTurn(audioController);
          else turnAdmissionLease.release();
        };
        let resolved;
        try {
          resolved = dictationSocket && audioClient
            ? await resolveDictationSocket(audioClient, config, logCtx, turnAdmissionLease, acquisition?.signal)
            : liveSidebandTarget && audioClient
              ? await resolveExternalLiveSocket(audioClient, config, logCtx, liveSidebandTarget, { lease: turnAdmissionLease, bindings: liveCallBindings, signal: acquisition?.signal })
              : liveSidebandTarget
                ? await resolveLiveSidebandUpgrade(req, config, logCtx, liveSidebandTarget, turnAdmissionLease)
                : formatErrorResponse(401, "authentication_error", "opencodex API key required");
        } catch (error) {
          try { releaseAcquisition(); }
          finally {
            finalizeLiveRequest(req.signal.aborted ? 499 : 500,
              req.signal.aborted ? { closeReason: "client_cancel" } : undefined);
          }
          throw error;
        }
        if (acquisition?.signal.aborted) {
          const status = req.signal.aborted ? 499 : acquisition.didExpire() ? 504 : 503;
          try { if (!(resolved instanceof Response) && "finish" in resolved) resolved.finish(); }
          finally {
            try { releaseAcquisition(); }
            finally { finalizeLiveRequest(status, status === 499 ? { closeReason: "client_cancel" } : undefined); }
          }
          return withCors(formatErrorResponse(status,
            "upstream_error", acquisition.didExpire() ? "Audio connection timed out" : "Audio connection canceled"), req, policy);
        }
        if (resolved instanceof Response) {
          releaseAcquisition();
          finalizeLiveRequest(resolved.status);
          return withCors(resolved, req, policy);
        }
        const audio = "finish" in resolved ? resolved : undefined;
        const finish = audio ? (outcome?: number | "timeout" | "connect_error") => {
          try { audio.finish(outcome); }
          finally { releaseAcquisition(); }
        } : undefined;
        const discardUpgrade = () => {
          if (finish) finish();
          else releaseAcquisition();
        };
        if (req.signal.aborted) {
          try { discardUpgrade(); }
          finally { finalizeLiveRequest(499, { closeReason: "client_cancel" }); }
          return withCors(formatErrorResponse(499, "client_closed_request", "Audio connection canceled"), req, policy);
        }
        const upstreamHandshake = await openLiveSidebandUpstream(
          resolved.upstreamWsUrl,
          resolved.headers,
          (url, headers) => (deps.liveSidebandWebSocketFactory ?? ((socketUrl, socketHeaders, protocols) => (
            new WebSocket(socketUrl, { headers: socketHeaders, protocols } as unknown as string[])
          )))(url, headers, audio?.protocols),
          LIVE_SIDEBAND_UPSTREAM_OPEN_TIMEOUT_MS,
          req.signal,
        );
        if (!upstreamHandshake.ok) {
          if (upstreamHandshake.socket) {
            closeLiveSidebandBeforeUpgrade(upstreamHandshake.socket, () => discardUpgrade());
          } else {
            discardUpgrade();
          }
          finalizeLiveRequest(upstreamHandshake.status,
            upstreamHandshake.status === 499 ? { closeReason: "client_cancel" } : undefined);
          console.error("[live] sideband upstream handshake failed: " + upstreamHandshake.message);
          return withCors(
            formatErrorResponse(upstreamHandshake.status, upstreamHandshake.code, upstreamHandshake.message),
            req,
            policy,
          );
        }
        const handoffFailure = upstreamHandshake.handoff.failure();
        if (handoffFailure || upstreamHandshake.socket.readyState !== WebSocket.OPEN) {
          closeLiveSidebandBeforeUpgrade(upstreamHandshake.socket, () => discardUpgrade());
          const failure = handoffFailure ?? {
            status: 502,
            code: "upstream_error",
            message: "voice upstream closed before client upgrade",
          };
          finalizeLiveRequest(failure.status);
          return withCors(formatErrorResponse(failure.status, failure.code, failure.message), req, policy);
        }
        let upgraded = false;
        try {
          upgraded = requestServer.upgrade(req, {
            ...(audioClient?.protocol ? { headers: { "sec-websocket-protocol": audioClient.protocol } } : {}),
            data: {
              kind: "live-sideband",
              liveUpstream: upstreamHandshake.socket,
              liveUpstreamUrl: resolved.upstreamWsUrl,
              liveUpstreamHeaders: resolved.headers,
              liveUpstreamHandoff: upstreamHandshake.handoff,
              admission,
              liveUpstreamProtocols: audio?.protocols,
              liveValidateFrame: audio?.validateFrame,
              liveMaxSessionMs: audio?.maxSessionMs,
              liveFinish: finish,
              liveAbortSignal: audioController?.signal,
              livePending: [],
              livePendingBytes: 0,
              liveOpened: true,
              liveTurnAdmissionLease: turnAdmissionLease,
            } satisfies WsData,
          });
        } catch {
          try {
            upstreamHandshake.handoff.take();
          } catch {
            /* ignore */
          }
          closeLiveSidebandBeforeUpgrade(upstreamHandshake.socket, () => discardUpgrade());
          finalizeLiveRequest(502);
          return withCors(formatErrorResponse(502, "upstream_error", "Audio WebSocket upgrade failed"), req, policy);
        }
        if (upgraded) {
          acquisition?.clear();
          finalizeLiveRequest(101);
          return undefined as unknown as Response;
        }
        try {
          upstreamHandshake.handoff.take();
        } catch {
          /* ignore */
        }
        closeLiveSidebandBeforeUpgrade(upstreamHandshake.socket, () => discardUpgrade());
        finalizeLiveRequest(426);
        return withCors(formatErrorResponse(426, "upgrade_required", "WebSocket upgrade failed"), req, policy);
      }

      // Data-plane guard: unknown /v1/* paths must fail with JSON 404, never fall through to the
      // GUI static handler (extensionless paths would get index.html with HTTP 200 and codex-rs
      // endpoint clients — memories/*, realtime/* — would surface confusing
      // serde decode errors instead of a clean not-found).
      if (url.pathname.startsWith("/v1/")) {
        return withCors(formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`), req, policy);
      }

      if (url.pathname === "/opencodex-session") {
        if (req.method === "GET") {
          const session = issueGuiSession(req, config, managementAuth, {
            trustedTailscaleIngress: ingress === "hub-management",
          });
          return session
            ? withManagementCors(serveSessionBootstrap(session), req, config)
            : withManagementCors(new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } }), req, config);
        }
        if (req.method === "POST") {
          // This endpoint is reachable WITHOUT a credential — that is the point of a pairing
          // exchange — so the body limit has to hold against a caller who controls the
          // framing. A declared Content-Length is a claim, not a bound: omit the header and
          // `Number(null ?? "0")` is 0, send `Transfer-Encoding: chunked` and there is no
          // header at all. Both used to pass the pre-check and land in `req.text()`, which
          // buffers whatever arrives. The post-check then measured a string the process had
          // already been forced to hold.
          //
          // So the declared length is only a cheap early reject, and the real bound is
          // applied while reading: stop at limit+1 bytes and never accumulate more.
          const declaredLength = Number(req.headers.get("content-length") ?? "0");
          if (!Number.isFinite(declaredLength) || declaredLength > GUI_PAIRING_EXCHANGE_BODY_LIMIT) {
            return withManagementCors(Response.json({ error: "pairing exchange body too large" }, { status: 413, headers: { "Cache-Control": "no-store" } }), req, config);
          }
          const bounded = await readBoundedRequestText(req, GUI_PAIRING_EXCHANGE_BODY_LIMIT);
          if (bounded === null) {
            return withManagementCors(Response.json({ error: "pairing exchange body too large" }, { status: 413, headers: { "Cache-Control": "no-store" } }), req, config);
          }
          const text = bounded;
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            return withManagementCors(Response.json({ error: "invalid pairing exchange body" }, { status: 400, headers: { "Cache-Control": "no-store" } }), req, config);
          }
          if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body as Record<string, unknown>).length !== 1
            || typeof (body as Record<string, unknown>).grant !== "string") {
            return withManagementCors(Response.json({ error: "invalid pairing exchange body" }, { status: 400, headers: { "Cache-Control": "no-store" } }), req, config);
          }
          const pairing = managementAuth.available
            ? consumeGuiPairingGrant(req, body, config, managementAuth, Date.now(), {
              ingress: ingress === "hub-management" ? "hub-management" : "public",
              peerAddress: requestServer.requestIP(req)?.address ?? null,
              tailscaleUser: ingress === "hub-management" ? req.headers.get("Tailscale-User-Login") : null,
              browserOrigin: req.headers.get("Origin") ?? "",
            })
            : null;
          if (pairing && "allowed" in pairing) {
            return withManagementCors(Response.json({ error: "pairing exchange refused" }, {
              status: 429,
              headers: { "Cache-Control": "no-store", "Retry-After": String(pairing.retryAfterSeconds) },
            }), req, config);
          }
          return pairing
            ? withManagementCors(serveSessionBootstrap(pairing), req, config)
            : withManagementCors(new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } }), req, config);
        }
        return withCors(formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`), req, policy);
      }
      const guiSessionCandidate = req.method === "GET" && (url.pathname === "/" || !url.pathname.includes("."))
        ? issueGuiSession(req, config, managementAuth, {
          trustedTailscaleIngress: ingress === "hub-management",
        })
        : null;
      const guiFile = serveGuiFile(
        url.pathname,
        undefined,
        guiSessionCandidate ?? undefined,
        config.runtimeRole ?? "standalone",
        isApiAuthRequired(config),
      );
      if (guiFile) return guiFile;
      if (url.pathname === "/" && req.method === "GET") {
        return jsonResponse(rootFallbackPayload());
      }

      return withCors(formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`), req, config);
    },
    websocket: createWebsocketHandler(ctx, requestMetrics),
  } as const;
  return serveOptions;
}
