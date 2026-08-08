import { markActivity } from "../lib/sidecar-tracker";
import {
  buildWarmupCompletionFrames,
  buildWsErrorFrame,
  selectForwardHeaders,
  sendJsonFrame,
  buildResponsesWsData,
  sendResponseToWebSocket,
  sendTextFrame,
  type WsData,
} from "./ws-bridge";
import type { Server, ServerWebSocket } from "bun";
import {
  DEFAULT_SUBAGENT_MODELS,
  applyProxyEnv,
  armClaudeCodeBaseline,
  loadConfig,
  saveConfig,
  websocketsEnabled,
} from "../config";
import { reconcileOAuthProviders } from "../oauth";
import { withCatalogWriteSerialization } from "../codex/catalog-write-serialization";
import { invalidateCodexModelsCacheWithPermit } from "../codex/catalog/sync";
import { getCodexHome } from "../codex/paths";
import { shouldSyncCodexOnStart } from "../codex/desired-state";
import { inspectNativeCodexOwnership } from "../integrations/native/ownership-preflight";
import { registerCodexCooldownRecoveryProbeWorker } from "../codex/auth-api";
import { startMemoryWatchdog } from "./memory-watchdog";
import {
  reconcileLiveStateStores,
  setLiveStateStoreConfig,
} from "../lib/state-store-registrations";
import { startStateStoreSweeper } from "../lib/state-store-sweeper";
import {
  configureAppOwnedMemoryBudget,
  enforceAppOwnedMemoryBudget,
  resolveAppOwnedMemoryBudgetBytes,
} from "../lib/app-owned-memory";
import {
  registerAppOwnedMemorySweepFallback,
  registerDefaultAppOwnedMemoryStores,
  registerDefaultAppOwnedObservedBuffers,
} from "../lib/app-owned-memory-stores";
import { setStorageCleanupPolicyLiveSink } from "../storage/policy";
import { setStorageCleanupPolicyJobLiveApply } from "../storage/policy-job";
import { scheduleStorageCleanupStartupRun, startStorageCleanupScheduler } from "../storage/policy-scheduler";
import { runOpenAiTierStartupMigration } from "../providers/openai-tier-startup";
import { runAlibabaRegionStartupMigration } from "../providers/alibaba-region-startup";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { providerCodexAccountMode } from "../providers/registry";
import type { StorageCleanupPolicy } from "../types";
import {
  CodexAccountCooldownError,
  cooldownErrorMessage,
} from "../codex/auth-context";
import { codexAccountNamespaceForModel } from "../codex/account-namespace-match";
export {
  clearThreadAccountMap,
  formatCodexProviderForLog,
  resolveCodexAccountForThread,
} from "../codex/routing";
import { formatCodexProviderForLog } from "../codex/routing";
import { CatalogGatherBusyError } from "../codex/catalog/provider-fetch";
import { registerCodexWebSocket, tryReserveCodexWebSocket, unregisterCodexWebSocket, updateCodexWebSocketAuthContext } from "../codex/websocket-registry";
import { resolveGuiFilePath, rootFallbackPayload, serveGuiFile, serveSessionBootstrap } from "./gui-static";
export { resolveGuiFilePath, rootFallbackPayload } from "./gui-static";
export { resolveAdapter } from "./adapter-resolve";
import { formatErrorResponse, type ResponsesTerminalStatus } from "../bridge";
import {
  drainAndShutdown,
  getActiveTurnCount,
  isDraining,
  registerTurn,
  runListenerShutdown,
  setServerRef,
  trackStreamLifetime,
  tryAdmitTurn,
  unregisterTurn,
  type ActiveTurnLease,
} from "./lifecycle";
export {
  drainAndShutdown,
  getActiveTurnCount,
  isDraining,
  isRecyclingForExit,
  markRecyclingForExit,
  registerTurn,
  trackStreamLifetime,
  unregisterTurn,
} from "./lifecycle";
import {
  addFinalRequestLog,
  hydrateRequestLogsFromDisk,
  httpStatusForRequestLogTerminal,
  httpStatusForTerminalStatus,
  inspectResponseLogSsePayload,
  nextRequestLogId,
  recordFirstOutput,
  type RequestLogContext,
  type RequestLogEntry,
} from "./request-log";
export {
  addFinalRequestLog,
  filterRequestLogs,
  hydrateRequestLogsFromDisk,
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
  managementCorsHeaders,
  isAllowedRequestOrigin,
  isAllowedManagementOrigin,
  isApiAuthRequired,
  isLoopbackHostname,
  jsonResponse,
  admissionFields,
  resolveApiAuth,
  resolveResponsesApiAuth,
  requestPolicyView,
  type RequestPolicyView,
  safeConfigDTO,
  setCorsOrigin,
  withCors,
  withManagementCors,
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
import { handleClaudeCountTokens, handleClaudeMessages } from "./claude-messages";
import { handleChatCompletions } from "./chat-completions";
import { anthropicErrorResponse } from "../claude/outbound";
import { buildDesktop3pRegistry } from "../claude/desktop-3p";
import { runClaudeAuthModeMigration } from "../claude/auth-mode-migration";
import {
  bindNativeMainStartupLifecycle,
  releaseNativeMainStartupLifecycle,
  startNativeMainStartupLifecycle,
  type NativeMainStartupGateDeps,
  type NativeMainStartupLifecycle,
} from "../codex/native-profile-startup";
import { handleImages } from "./images";
import { handleLive, logLiveSidebandFrame, parseLiveSidebandTarget, resolveLiveSidebandUpgrade } from "./live";
import { handleSearch } from "./search";
import { fetchAllModels, handleManagementAPI, VERSION, type ManagementApiDeps } from "./management-api";
import {
  initializeManagementAuthState,
  issueGuiSession,
  managementPrincipal,
  requireManagementAuth,
  type ManagementAuthState,
} from "./management-auth";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof,
  createLocalAttestationSecret,
} from "../lib/local-management-attestation";
import { SYSTEM_RESTART_CAPABILITY_VERSION } from "../lib/system-restart-contract";
import { createReadinessGate, type ReadinessGate } from "./readiness";

const MAX_WS_FRAME_BYTES = 50 * 1024 * 1024;
const WEBSOCKET_IDLE_TIMEOUT_SECONDS = 0;
const LIVE_SIDEBAND_PENDING_MAX = 32;
const LIVE_SIDEBAND_CLOSE_FALLBACK_MS = 1_000;

type LiveSidebandWebSocketFactory = (
  url: string,
  headers: Record<string, string>,
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
function sendUpstreamFrame(upstream: WebSocket, frame: string | Buffer): void {
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
  ws.data.cancel = undefined;
  releaseLiveSidebandAdmission(ws);
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

function closeLiveSideband(ws: ServerWebSocket<WsData>, code = 1000, reason = ""): void {
  if (ws.data.liveClosing) return;
  ws.data.liveClosing = true;
  ws.data.livePending = undefined;
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

function attachLiveSidebandUpstream(
  ws: ServerWebSocket<WsData>,
  createWebSocket: LiveSidebandWebSocketFactory = (url, headers) => (
    new WebSocket(url, { headers } as unknown as string[])
  ),
): void {
  const url = ws.data.liveUpstreamUrl;
  if (!url) {
    closeLiveSideband(ws, 1011, "missing upstream");
    return;
  }
  let upstream: WebSocket;
  try {
    // Bun accepts per-handshake headers; the DOM lib types only list protocol arrays.
    upstream = createWebSocket(url, ws.data.liveUpstreamHeaders ?? {});
  } catch {
    closeLiveSideband(ws, 1011, "upstream connect failed");
    return;
  }
  ws.data.liveUpstream = upstream;
  ws.data.liveClosing = false;
  ws.data.cancel = () => closeLiveSideband(ws, 1000, "client closed");

  upstream.addEventListener("open", () => {
    if (ws.data.liveUpstream !== upstream || ws.data.liveClosing) return;
    ws.data.liveOpened = true;
    const pending = ws.data.livePending ?? [];
    ws.data.livePending = undefined;
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
      logLiveSidebandFrame("u2c", event.data);
      if (typeof event.data === "string") ws.send(event.data);
      else if (event.data instanceof ArrayBuffer) ws.send(event.data);
      else if (ArrayBuffer.isView(event.data)) {
        ws.send(event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength));
      } else ws.send(event.data as Buffer);
    } catch {
      closeLiveSideband(ws, 1011, "client send failed");
    }
  });
  upstream.addEventListener("close", (event) => {
    if (ws.data.liveUpstream !== upstream) return;
    ws.data.liveClosing = true;
    finalizeLiveSideband(ws, upstream);
    try {
      ws.close(event.code || 1000, event.reason || "");
    } catch {
      /* ignore */
    }
  });
  upstream.addEventListener("error", () => {
    if (ws.data.liveUpstream !== upstream) return;
    closeLiveSideband(ws, 1011, "upstream error");
  });
}

// GUI static serving extracted to ./server/gui-static. Re-exported below to keep the
// "../src/server" import surface stable for tests/callers.

// Adapter resolution + wire-protocol override extracted to ./server/adapter-resolve.

// Source invariant for tests/passthrough-abort.test.ts after the pure module split:
// if (isEventStream && upstreamResponse.body) {
// const repairConfig = route.provider.responsesItemIdRepair;
// const needsClientRewrite = imageGenCallAliases.size > 0
// #314 gated shape: win32 always uses the terminal-aware eager relay so a keep-alive
// upstream cannot hold Codex open after response.completed; darwin no-rewrite traffic
// requires explicit config-eager opt-in (`auto` always stays tee on darwin).
// selectEagerPath(process.platform, needsClientRewrite, config.streamMode ?? "auto")
// relaySseEagerBounded(upstreamResponse.body, turnAc,
// new Response(eagerBody,
// Default shape (tee + background inspection):
// upstreamResponse.body.tee()
// const repairedBody = hasResponsesItemIdRepair(repairConfig)
// relaySseWithFailedTail(repairedBody, upstream)
// new Response(clientBody
// markNativePassthroughSseResponse
// const body = relayWithAbort(upstreamResponse.body, upstream);
// function responseWithDeferredRequestLog
// isNativePassthroughSseResponse(response)
// trackSseForRequestLog(
// export function relaySseWithHeartbeat

export interface StartServerDeps {
  /** Test-only seam; production always initializes its own management credential state. */
  managementAuthState?: ManagementAuthState;
  /** Test-only route dependencies, forwarded only after management admission succeeds. */
  managementApi?: ManagementApiDeps;
  /** Test-only native-main recovery dependencies; production constructs the normal manager. */
  nativeMainStartup?: NativeMainStartupGateDeps;
  /** Test-only seam for an upstream that cannot complete its WebSocket close handshake. */
  liveSidebandWebSocketFactory?: LiveSidebandWebSocketFactory;
  /** Test-only seam; production derives a fresh local-attestation secret per process. */
  localAttestationSecret?: string;
  /** Optional readiness gate; a fresh pending gate is created when omitted. */
  readinessGate?: ReadinessGate;
}

/*
 * #1046. `startServer` rewrites the Codex models cache during boot, and an
 * app-server that started earlier keeps its own in-memory model list. The stale
 * warning is not emitted here: `handleStart` runs a catalog sync moments later,
 * so warning now would read an mtime that write is about to move, and both sites
 * calling the helper independently would warn twice. This records the fact; the
 * CLI start path owns the single decision.
 *
 * A caller that starts a server without `handleStart` (tests, embedded use)
 * deliberately gets no warning — lifecycle diagnostics belong to whoever owns
 * the lifecycle.
 */
let startupCacheInvalidationWrote = false;

/** #1046: did this process's startup cache invalidation actually write? */
export function consumeStartupCacheInvalidationWrite(): boolean {
  const wrote = startupCacheInvalidationWrote;
  startupCacheInvalidationWrote = false;
  return wrote;
}

export function startServer(port?: number, deps: StartServerDeps = {}): Server<WsData> {
  const localAttestationSecret = deps.localAttestationSecret ?? createLocalAttestationSecret();
  const config = runAlibabaRegionStartupMigration(runOpenAiTierStartupMigration(loadConfig()));
  setLiveStateStoreConfig(config);
  applyProxyEnv(config);
  assertServerAuthConfig(config);
  const managementAuth = deps.managementAuthState ?? initializeManagementAuthState(config);
  // Arm synchronously before listen. A pending journal therefore makes __main__ unusable
  // before any request can resolve its physical credential, while health/management/Pool stay live.
  // Refresh OAuth provider presets (models/noReasoningModels) from the registry so a proxy update
  // adding/dropping models reaches existing configs on start — not just fresh installs.
  reconcileOAuthProviders(config);
  reconcileLiveStateStores();
  // Seed default featured subagent models on first run only (UNSET → defaults). A user-set list,
  // even [], is left alone so GUI removals persist.
  if (config.subagentModels === undefined) {
    config.subagentModels = [...DEFAULT_SUBAGENT_MODELS];
    saveConfig(config);
  }
  // authMode migration (devlog 260726_claude_auth_auto/015): before "auto" existed,
  // choosing Subscription DELETED the key, so a pre-upgrade block with no authMode is
  // indistinguishable from "never chose". Pin those to subscription once so an upgrade
  // never silently moves a deliberate subscriber onto proxy.
  if (runClaudeAuthModeMigration(config)) saveConfig(config);
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
  // Startup cache invalidation is best-effort and must never block the server from
  // serving. It now takes K so it cannot race a convergence commit, but both the
  // home resolution and the acquisition can fail on a machine with no Codex home —
  // `getCodexHome()` THROWS when CODEX_HOME names a missing directory, which would
  // otherwise turn "no Codex installed" into "proxy will not start".
  try {
    const startupCodexHome = getCodexHome();
    // #1046: record whether this actually rewrote the cache. `handleStart` ORs this
    // with the later startup sync and warns ONCE about stale app-servers; warning
    // here instead would read a catalog mtime the sync is about to move.
    const outcome = withCatalogWriteSerialization(startupCodexHome, permit =>
      invalidateCodexModelsCacheWithPermit(permit, startupCodexHome));
    // A refused permit is not a write; only a completed run that returned true is.
    startupCacheInvalidationWrote = outcome.kind === "completed" && outcome.value === true;
  } catch { /* no readable Codex home: nothing to invalidate */ }
  // Arm the `claudeCode` hand-edit guard (devlog 260726_claude_auth_auto/040 H1) BEFORE
  // the server can serve a request, and AFTER the startup migrations above — those run
  // against a config nobody else holds and are the documented exception to the save
  // boundary, so the baseline should reflect what they wrote. Arming is eager on
  // purpose: a lazy "arm on first save" loses exactly the hand edit made before that
  // first save, which is the case the guard exists for.
  armClaudeCodeBaseline(config);
  // usage.jsonl already persists every request; rehydrate the in-memory Logs ring so
  // /api/logs (and the GUI) survive `ocx stop` / `ocx start` process restarts.
  hydrateRequestLogsFromDisk();
  // #314: warn-only RSS observability (unref'd, idempotent — safe under repeated
  // startServer(0) in tests). Snapshot surfaces via GET /api/system/memory.
  startMemoryWatchdog();
  registerDefaultAppOwnedMemoryStores();
  registerDefaultAppOwnedObservedBuffers();
  registerAppOwnedMemorySweepFallback();
  configureAppOwnedMemoryBudget(resolveAppOwnedMemoryBudgetBytes(config.appOwnedMemoryBudgetMb));
  enforceAppOwnedMemoryBudget();
  registerCodexCooldownRecoveryProbeWorker(config);
  startStateStoreSweeper();
  // Issue #42 Phase 3: opt-in archived auto-cleanup (default OFF). Unref'd hourly
  // tick for daily/weekly; startup evaluation is fire-and-forget after listen.
  // Heavy work runs in a Worker via the single-flight job controller.
  // Keep live config.policy in sync when background runs advance nextRun/lastRun.
  const applyPolicy = (policy: StorageCleanupPolicy) => {
    config.storageCleanupPolicy = policy;
  };
  setStorageCleanupPolicyLiveSink(applyPolicy);
  setStorageCleanupPolicyJobLiveApply(applyPolicy);
  startStorageCleanupScheduler();

  const listenPort = port ?? config.port ?? 10100;
  setCorsOrigin(listenPort);

  // Canonicalize an explicit "localhost" bind to IPv4 so it matches the injected base_url (which
  // resolves localhost→127.0.0.1): on Windows `localhost` resolves ::1-first, but the injected URL
  // is 127.0.0.1, so binding literal "localhost" would reintroduce the F4 refusal. Wildcards
  // (0.0.0.0/::) and specific hosts are left untouched so intentional exposure is preserved.
  const configuredHost = config.hostname?.trim();
  const bindHost = !configuredHost || /^localhost$/i.test(configuredHost) ? "127.0.0.1" : configuredHost;

  // Unauthenticated loopback listener (#1102). Off unless explicitly enabled.
  const loopbackListener = config.unauthenticatedLoopbackListener;
  const loopbackListenerPort = loopbackListener?.enabled ? loopbackListener.port : null;

  /**
   * Which listener a request arrived on, expressed as the only thing that differs: the bind
   * address the auth and CORS decisions should see.
   *
   * The public listener passes the shared config through untouched, so its behaviour is
   * byte-identical to before. The loopback listener substitutes 127.0.0.1, which is what makes
   * `isApiAuthRequired` return false for it — the same code path a plain loopback bind has
   * always taken, including the Host-header check inside `isAllowedRequestOrigin`.
   *
   * Built per request rather than once per listener so a management-API config change is
   * picked up immediately instead of being frozen at listen time.
   */
  const publicPolicy = (): RequestPolicyView => config;
  const loopbackPolicy = (): RequestPolicyView => requestPolicyView(config, "127.0.0.1");
  void publicPolicy;

  /**
   * Routes the unauthenticated loopback listener will serve. Everything else 404s.
   *
   * This is an allowlist rather than a filter applied to the public handler, because a filter
   * inverts the failure mode: a route added later would be reachable here by default. The four
   * entries are exactly what a directly-spawned `codex app-server` needs.
   *
   * `GET /v1/models` is on the list for a reason that is easy to miss. When catalog
   * materialization fails or finds no source, `syncCodex` warns and injects with
   * `catalogPath: null`; Codex then builds an ONLINE model manager and `model/list` refreshes
   * through `GET {base_url}/models`. Returning 404 there would leave the picker on its bundled
   * fallback — fixing the direct-spawn host while breaking its model list.
   */
  function loopbackRouteAllowed(url: URL, req: Request): boolean {
    const path = url.pathname;
    if (path === "/v1/responses") {
      return req.method === "POST" || req.headers.get("upgrade")?.toLowerCase() === "websocket";
    }
    if (path === "/v1/responses/compact") return req.method === "POST";
    if (path === "/v1/models") return req.method === "GET";
    return false;
  }

  // Codex treats empty / non-JSON 503 bodies as "Unknown error" (#452). Keep Retry-After and
  // the server_is_overloaded code so clients can back off, but always return a JSON envelope.
  // These two run BEFORE the auth/origin checks, so they need the receiving listener's policy
  // explicitly (#1102). Reaching for the shared `config` here would attach public-policy CORS
  // headers to a 503 on the loopback listener — no model runs and no credential is spent, but
  // it is the one error path that would answer a rebinding origin with its own origin echoed
  // back.
  function drainingResponse(req: Request, policy: RequestPolicyView): Response {
    const response = formatErrorResponse(503, "server_error", "Service shutting down");
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders(req, policy))) {
      headers.set(name, value);
    }
    headers.set("Retry-After", "5");
    return new Response(response.body, { status: 503, headers });
  }

  function serverBusyResponse(req: Request, resource: string, policy: RequestPolicyView): Response {
    return withCors(new Response(JSON.stringify({
      error: { type: "server_error", code: "server_busy", message: `${resource} capacity reached` },
    }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "1" },
    }), req, policy);
  }

  async function runAdmittedHttpTurn(
    req: Request,
    policy: RequestPolicyView,
    work: (lease: ActiveTurnLease) => Promise<Response>,
  ): Promise<Response> {
    const lease = tryAdmitTurn();
    if (!lease) return serverBusyResponse(req, "active turns", policy);
    let response: Response;
    try {
      response = await work(lease);
    } catch (error) {
      lease.release();
      throw error;
    }
    if (!lease.isTransferred()) {
      lease.release();
    }
    return response;
  }

  // Readiness gate: one PRIVATE controller per startServer invocation, captured
  // by this listener's closure. Starting/failing a second server in the same
  // process can never reset or mutate this gate. handleStart creates the gate,
  // passes it in, and transitions it after the post-startup sync settles. When
  // no gate is supplied (tests, ad-hoc starts) a fresh pending gate is created.
  const readinessGate = deps.readinessGate ?? createReadinessGate();
  // Actual bound port, filled in after Bun.serve binds so /readyz reports the
  // real ephemeral port for startServer(0). /healthz keeps its existing port
  // field (the requested listenPort) byte-for-byte.
  let boundPort: number | null = null;

  // Native-main startup ownership creates several SQLite coordination files in
  // CODEX_HOME. When the user has disabled the Codex integration, starting the
  // proxy must not manufacture those Codex artifacts merely to serve other
  // clients; no Codex request can use this lifecycle in that state.
  const nativeOwnership = inspectNativeCodexOwnership();
  const nativeMainLifecycle: NativeMainStartupLifecycle = shouldSyncCodexOnStart(config)
    && nativeOwnership.ownership !== "foreign"
    ? startNativeMainStartupLifecycle(deps.nativeMainStartup)
    : {
      homeId: null,
      settled: Promise.resolve({ status: "ready", homeId: null }),
      release: async () => {},
    };
  let server: Server<WsData>;
  let loopbackServer: Server<WsData> | null = null;
  try {
    const serveOptions = {
      idleTimeout: 255,
      async fetch(req: Request, requestServer: Server<WsData>): Promise<Response> {
      // The unauthenticated loopback listener (#1102) serves a fixed allowlist and nothing
      // else. Rejecting here, before any handler runs, is what keeps the surface from growing
      // silently when a route is added below.
      if (requestServer === loopbackServer && !loopbackRouteAllowed(new URL(req.url), req)) {
        return withCors(
          formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${new URL(req.url).pathname}`),
          req,
          loopbackPolicy(),
        );
      }
      // Auth and CORS decisions below read `policy`, not `config`. For the public listener the
      // two are the same object, so its behaviour is unchanged; for the loopback listener the
      // view substitutes 127.0.0.1 as the bind address, which is what routes it through the
      // same code path a plain loopback bind has always taken — Host-header check included.
      // Routing, provider selection and response bodies keep using `config`.
      const policy: RequestPolicyView = requestServer === loopbackServer ? loopbackPolicy() : config;
      const url = new URL(req.url);
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
          data: buildResponsesWsData(selectForwardHeaders(req.headers), admission, websocketLease),
        })) return undefined as unknown as Response;
        websocketLease.release();
        return withCors(formatErrorResponse(426, "upgrade_required", "WebSocket upgrade failed"), req, policy);
      }

      if (url.pathname === "/healthz" && req.method === "GET") {
        // service/pid/port let CLI liveness reject foreign 200s and verify pid identity.
        const healthPort = server.port ?? listenPort;
        const response = jsonResponse({
          status: "ok",
          service: "opencodex",
          version: VERSION,
          uptime: process.uptime(),
          pid: process.pid,
          port: healthPort,
          restartCapability: SYSTEM_RESTART_CAPABILITY_VERSION,
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
          port: boundPort ?? listenPort,
          status,
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
          port: boundPort ?? requestServer.port ?? listenPort,
        };
        const apiAuthError = requireManagementAuth(req, managementAuth, config, localManagementAuth);
        if (apiAuthError) return withManagementCors(apiAuthError, req, config);
        // Which credential passed the gate, resolved from the same session table the
        // gate used. Consent-bearing routes need this: request headers are forgeable
        // by anything holding the admin token, the credential is not.
        const principal = managementPrincipal(req, managementAuth, config, localManagementAuth) ?? undefined;
        const mgmtResponse = await handleManagementAPI(req, url, config, deps.managementApi, principal);
        if (mgmtResponse) return withManagementCors(mgmtResponse, req, config);
        return withManagementCors(formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`), req, config);
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        // Model discovery never forwards Authorization upstream, so the broader admission
        // set (Authorization / x-api-key / x-opencodex-api-key) is safe here and required by
        // remote OpenAI-style bearer clients and Claude gateway discovery (anthropic-version).
        const admission = resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        let goModels;
        try {
          goModels = await fetchAllModels(config);
        } catch (error) {
          if (error instanceof CatalogGatherBusyError) {
            return withCors(new Response(JSON.stringify({ error: { type: "server_error", code: "catalog_busy", message: error.message } }), {
              status: 503,
              headers: { "content-type": "application/json", "Retry-After": "1" },
            }), req, policy);
          }
          throw error;
        }
        const { applyNativeVisibility, buildCatalogEntries, configuredNativeAliasSlugs, desktopAllowlistSuppressedNativeSlugs, disabledNativeSlugs, exactComboCatalogSlugs, loadCatalogTemplate, NATIVE_OPENAI_MODELS, nativeOpenAiSlugs, nativeReasoningEfforts, nativeDefaultReasoningEffort, orderForSubagents, filterCatalogVisibleModels, shouldIncludeAccountBoundNativeOpenAi, shouldIncludeNativeOpenAi, uniqueCatalogModelsForRawPublicList, visibleCodexAccountSelectors, visibleNativeSlugs, desktopVisibleNativeSlugs } = await import("../codex/catalog");
        const includeNativeOpenAi = shouldIncludeNativeOpenAi(config);
        const includeAccountBoundNativeOpenAi = shouldIncludeAccountBoundNativeOpenAi(config);
        const nativeSlugs = includeNativeOpenAi ? nativeOpenAiSlugs() : [];
        const disabledNatives = disabledNativeSlugs(config);
        const disabledModels = new Set(config.disabledModels ?? []);
        const shadowedNativeSlugs = configuredNativeAliasSlugs(config);
        const suppressedBareNativeSlugs = desktopAllowlistSuppressedNativeSlugs(config);
        const accountSelectors = includeAccountBoundNativeOpenAi
          ? visibleCodexAccountSelectors(config)
          : [];
        const goEnabled = filterCatalogVisibleModels(goModels, config);
        const goOrdered = orderForSubagents(goEnabled, config.subagentModels);
        // Claude Code / Claude Desktop gateway model discovery (GET /v1/models with
        // Anthropic-style headers; 003 G1-G8 + devlog 131). Entries use the official
        // ModelInfo shape incl. capabilities (effort ladder / thinking) — Desktop 3P can
        // only learn capabilities through discovery, and Claude Code 2.1.207 strips the
        // extra fields (backward-safe). Ids are the claude-opus-4-8-{code} Desktop
        // aliases; legacy claude-ocx-* ids keep decoding via resolveAlias. Detection:
        // anthropic-version header (Claude Code sends it) or explicit ?flavor=anthropic.
        // Codex catalog (client_version) and the OpenAI list shape below stay byte-identical.
        const wantsAnthropicList = req.headers.get("anthropic-version") !== null
          || url.searchParams.get("flavor") === "anthropic";
        if (wantsAnthropicList && !url.searchParams.has("client_version")) {
          if (config.claudeCode?.enabled === false) return jsonResponse({ data: [] }, 200, req, policy);
          // Build Desktop 3P registry so inbound alias resolution works for subsequent requests.
          buildDesktop3pRegistry(
            [...desktopVisibleNativeSlugs(config)],
            goOrdered.map(m => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow })),
            config.claudeCode?.desktopProfile,
          );
          const { buildAnthropicModelInfos } = await import("../claude/model-info");
          const { resolveAutoContext } = await import("../claude/context-windows");
          const { activeDesktop3pAlias } = await import("../claude/desktop-3p");
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
          const data = buildAnthropicModelInfos([...desktopVisibleNativeSlugs(config)], goOrdered, resolveAutoContext(config.claudeCode), idStyle, activeDesktop3pAlias);
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
            ? NATIVE_OPENAI_MODELS
            : nativeSlugs;
          const entries = buildCatalogEntries(loadCatalogTemplate(), catalogNativeSlugs, goOrdered, config.subagentModels, websocketsEnabled(config), maMode as "v1" | "default" | "v2", exactComboCatalogSlugs(config), accountSelectors, suppressedBareNativeSlugs);
          return jsonResponse({
            models: applyNativeVisibility(
              entries,
              disabledModels,
              accountSelectors.length > 0,
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
          if (efforts.length === 0) return {};
          const defaultEffort = configuredDefault && efforts.includes(configuredDefault)
            ? configuredDefault
            : efforts.includes("medium") ? "medium" : efforts.includes("high") ? "high" : efforts[0];
          return {
            supports_reasoning_effort: true,
            reasoning_effort: defaultEffort,
            reasoning_efforts: efforts.map(effort => grokEffortOption(effort, effort === defaultEffort)),
          };
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
          });
        // Selector-active discovery follows the same complete supported set as the Codex catalog
        // for both bare and qualified rows. Without selectors, the live catalog continues to own
        // bare availability.
        const selectorNativeSlugs = accountSelectors.length > 0
          ? NATIVE_OPENAI_MODELS.filter(slug => !disabledNatives.has(slug))
          : [];
        const visibleNatives = includeNativeOpenAi
          ? accountSelectors.length > 0
            ? selectorNativeSlugs.filter(slug => !shadowedNativeSlugs.has(slug))
            : visibleNativeSlugs(config)
          : [];
        const visibleAccountNatives = accountSelectors.flatMap(selector =>
          selectorNativeSlugs.flatMap(metadataId => {
            const id = `${selector}/${metadataId}`;
            return disabledModels.has(id) ? [] : [{ id, metadataId }];
          })
        );
        const data = [
          ...visibleNatives.map(id => nativeModelRow(id)),
          ...visibleAccountNatives.map(({ id, metadataId }) => nativeModelRow(id, metadataId)),
          ...uniqueCatalogModelsForRawPublicList(goOrdered).map(m => ({
            id: m.alias ?? `${m.provider}/${m.id}`,
            object: "model",
            created: 0,
            owned_by: m.owned_by ?? m.provider,
            ...grokEffortFields(m.reasoningEfforts ?? [], m.defaultReasoningEffort),
          })),
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
          ...admissionFields(admission),
          inboundProtocol: "responses",
        };
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => {
          let response: Response;
          try {
            response = await handleResponsesCompact(req, config, logCtx, turnAdmissionLease);
          } catch {
            response = formatErrorResponse(500, "server_error", "Unexpected compact request failure");
          }
          addFinalRequestLog(requestId, start, logCtx, response.status,
            response.status === 499 ? { closeReason: "client_cancel" } : undefined);
          return withCors(response, req, policy);
        });
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
          ...admissionFields(admission),
        };
        const endpoint = url.pathname.endsWith("/edits") ? "edits" as const : "generations" as const;
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => {
          const response = await handleImages(req, config, endpoint, logCtx, turnAdmissionLease);
          addFinalRequestLog(requestId, start, logCtx, response.status, response.status === 499 ? { closeReason: "client_cancel" } : undefined);
          return withCors(response, req, policy);
        });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/opencodex/artifacts/")) {
        const admission = resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        const id = decodeURIComponent(url.pathname.slice("/v1/opencodex/artifacts/".length));
        const { resolveArtifactPath } = await import("../images/artifacts");
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
          ...admissionFields(admission),
        };
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => {
          const response = await handleSearch(req, config, logCtx, turnAdmissionLease);
          addFinalRequestLog(requestId, start, logCtx, response.status,
            response.status === 499 ? { closeReason: "client_cancel" } : undefined);
          return withCors(response, req, policy);
        });
      }

      if (url.pathname === "/v1/responses" && req.method === "POST") {
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
          ...admissionFields(admission),
          inboundProtocol: "responses",
        };
        let logged = false;
        const finalizeNativePassthroughLog = (
          status: number,
          meta: { terminalStatus?: ResponsesTerminalStatus; closeReason: "terminal" | "client_cancel" },
        ) => {
          if (logged) return;
          logged = true;
          addFinalRequestLog(requestId, start, logCtx, status, meta);
        };
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => {
          const response = await handleResponses(req, config, logCtx, {
            turnAdmissionLease,
            abortSignal: req.signal,
            onFirstOutput: () => recordFirstOutput(logCtx, start),
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
          return withCors(responseWithDeferredRequestLog(response, requestId, start, logCtx), req, policy);
        });
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
        return runAdmittedHttpTurn(req, policy, async () => withCors(await handleClaudeCountTokens(req, config), req, policy));
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
          ...admissionFields(admission),
          inboundProtocol: "messages",
        };
        // Logging is finalized inside handleClaudeMessages (Responses-vocab tap on the
        // pre-translation stream + native passthrough callbacks) — do not re-wrap the
        // translated Anthropic stream here.
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => withCors(
          await handleClaudeMessages(req, config, logCtx, { requestId, start, turnAdmissionLease }),
          req,
          config,
        ));
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
          ...admissionFields(admission),
          inboundProtocol: "chat",
        };
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => withCors(
          await handleChatCompletions(req, config, logCtx, { requestId, start, turnAdmissionLease }),
          req,
          config,
        ));
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
        const admission = resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = {
          model: "gpt-live",
          provider: "unknown",
          ...admissionFields(admission),
        };
        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => {
          const response = await handleLive(req, config, logCtx, turnAdmissionLease);
          addFinalRequestLog(
            requestId,
            start,
            logCtx,
            response.status,
            response.status === 499 ? { closeReason: "client_cancel" } : undefined,
          );
          return withCors(response, req, policy);
        });
      }

      // Voice / Realtime sideband WebSocket: Frameless joins /v1/live/{callId}; Realtime v1 joins
      // /v1/realtime?call_id= (or /v1/realtime/calls/{callId}). Transparent bidirectional relay.
      const liveSidebandTarget = req.headers.get("upgrade")?.toLowerCase() === "websocket"
        ? parseLiveSidebandTarget(url.pathname, url.searchParams)
        : null;
      if (liveSidebandTarget) {
        if (isDraining()) {
          return drainingResponse(req, policy);
        }
        const admission = resolveApiAuth(req, policy);
        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
        if (!isAllowedRequestOrigin(req, policy)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "WebSocket upgrade blocked: non-local Origin"), req, policy);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx: RequestLogContext = {
          model: "gpt-live",
          provider: "unknown",
          ...admissionFields(admission),
        };
        const turnAdmissionLease = tryAdmitTurn();
        if (!turnAdmissionLease) return serverBusyResponse(req, "active turns", policy);
        let resolved;
        try {
          resolved = await resolveLiveSidebandUpgrade(req, config, logCtx, liveSidebandTarget, turnAdmissionLease);
        } catch (error) {
          turnAdmissionLease.release();
          throw error;
        }
        if (resolved instanceof Response) {
          turnAdmissionLease.release();
          addFinalRequestLog(requestId, start, logCtx, resolved.status);
          return withCors(resolved, req, policy);
        }
        addFinalRequestLog(requestId, start, logCtx, 101);
        if (requestServer.upgrade(req, {
          data: {
            kind: "live-sideband",
            liveUpstreamUrl: resolved.upstreamWsUrl,
            liveUpstreamHeaders: resolved.headers,
            livePending: [],
            liveOpened: false,
            liveTurnAdmissionLease: turnAdmissionLease,
          } satisfies WsData,
        })) return undefined as unknown as Response;
        turnAdmissionLease.release();
        return withCors(formatErrorResponse(426, "upgrade_required", "WebSocket upgrade failed"), req, policy);
      }

      // Data-plane guard: unknown /v1/* paths must fail with JSON 404, never fall through to the
      // GUI static handler (extensionless paths would get index.html with HTTP 200 and codex-rs
      // endpoint clients — memories/*, realtime/* — would surface confusing
      // serde decode errors instead of a clean not-found).
      if (url.pathname.startsWith("/v1/")) {
        return withCors(formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`), req, policy);
      }

      const guiSessionCandidate = req.method === "GET" && (url.pathname === "/" || !url.pathname.includes("."))
        ? issueGuiSession(req, config, managementAuth)
        : null;
      // Dedicated bootstrap path: answer without requiring a packaged GUI build, so the
      // Vite dev server can mint an origin-bound loopback session on a fresh checkout.
      if (url.pathname === "/opencodex-session" && guiSessionCandidate) {
        return serveSessionBootstrap(guiSessionCandidate);
      }
      const guiFile = serveGuiFile(url.pathname, undefined, guiSessionCandidate ?? undefined);
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
      // Live sideband sockets (kind=live-sideband) are a transparent bidirectional relay instead.
      open(ws: ServerWebSocket<WsData>) {
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
        if (ws.data.kind === "live-sideband") {
          if (ws.data.liveClosing) return;
          logLiveSidebandFrame("c2u", raw);
          const upstream = ws.data.liveUpstream;
          if (!upstream || upstream.readyState === WebSocket.CONNECTING || !ws.data.liveOpened) {
            const pending = ws.data.livePending ?? (ws.data.livePending = []);
            if (pending.length >= LIVE_SIDEBAND_PENDING_MAX) {
              closeLiveSideband(ws, 1009, "too many pending frames");
              return;
            }
            pending.push(raw);
            return;
          }
          if (upstream.readyState !== WebSocket.OPEN) {
            closeLiveSideband(ws, 1011, "upstream not open");
            return;
          }
          try {
            sendUpstreamFrame(upstream, raw);
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

        const turnAdmissionLease = tryAdmitTurn();
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
      close(ws: ServerWebSocket<WsData>) {
        if (ws.data.kind === "live-sideband") {
          closeLiveSideband(ws);
          return;
        }
        unregisterCodexWebSocket(ws);
        ws.data.admissionLease?.release();
        ws.data.admissionLease = undefined;
        ws.data.cancel?.(); // RC2: abort the upstream when the client disconnects
      },
    },
    } as const;

    server = Bun.serve<WsData>({ ...serveOptions, port: listenPort, hostname: bindHost });

    // Both binds are one startup transaction (#1102). If the loopback bind fails after the
    // public one succeeded, leaving the public listener up would strand it: the CLI's port
    // retry would read the failure as a public-port conflict and pick a different port,
    // accumulating listeners. Roll back and rethrow the original error instead.
    if (loopbackListenerPort !== null) {
      try {
        loopbackServer = Bun.serve<WsData>({
          ...serveOptions,
          port: loopbackListenerPort,
          hostname: "127.0.0.1",
        });
      } catch (error) {
        try {
          // startServer is synchronous, so this rollback cannot await. Bun begins closing the
          // listen socket on the call itself; the caller sees the original bind error either
          // way, and the alternative — leaving the public listener up — is the failure this
          // rollback exists to prevent.
          void server.stop(true);
        } catch {
          /* the original bind error is the one worth reporting */
        }
        throw error;
      }
    }
  } catch (error) {
    void nativeMainLifecycle.release();
    throw error;
  }

  bindNativeMainStartupLifecycle(server, nativeMainLifecycle);
  const nativeStop = server.stop.bind(server);
  const loopbackListenerRef = loopbackServer;
  Object.defineProperty(server, "stop", {
    configurable: true,
    value: async (closeActiveConnections?: boolean): Promise<void> => {
      // The orchestration lives in `runListenerShutdown` so its two competing properties —
      // cleanup completes, failure propagates — are testable without a live socket.
      await runListenerShutdown(
        [
          () => nativeStop(closeActiveConnections),
          ...(loopbackListenerRef
            ? [() => loopbackListenerRef.stop(closeActiveConnections)]
            : []),
        ],
        () => releaseNativeMainStartupLifecycle(server),
      );
    },
  });
  setServerRef(server);
  const actualPort = server.port ?? listenPort;
  boundPort = actualPort;
  setCorsOrigin(actualPort);

  console.log(`🚀 opencodex proxy running on http://localhost:${actualPort}`);
  console.log(`   POST /v1/responses → provider translation`);
  console.log(`   POST /v1/chat/completions → OpenAI-compatible clients`);
  console.log(`   GET  /healthz      → health check`);
  console.log(`   GET  /api/*        → management API`);
  console.log(`   GET  /             → GUI dashboard`);

  if (loopbackServer) {
    // Loud on every start, not once at enable time. An operator who inherits a config, or
    // who forgot, has to be able to see that an unauthenticated surface is live without
    // reading the file.
    const loopbackPort = loopbackServer.port ?? loopbackListenerPort;
    console.warn(`⚠️  Unauthenticated loopback listener active on http://127.0.0.1:${loopbackPort}`);
    console.warn(`   Any local process can use it without a credential — it spends account`);
    console.warn(`   quota and paid provider credentials, and can starve authenticated`);
    console.warn(`   remote clients. Not for shared or multi-tenant hosts.`);
  }

  // Prime pool-account quota in the background so the rotation engine has real
  // usage scores from the first routing decision, even when the dashboard is
  // never opened (the common CLI/WSL case). Fire-and-forget: never blocks the
  // listener, and a blocked network silently no-ops (see Phase 30 diagnostics).
  const openAiProvider = config.providers.openai;
  if (
    openAiProvider
    && openAiProvider.disabled !== true
    && isCanonicalOpenAiForwardProvider(openAiProvider)
    && providerCodexAccountMode("openai", openAiProvider) === "pool"
  ) {
    import("../codex/auth-api")
      .then(({ primeCodexPoolQuotas }) => primeCodexPoolQuotas(config, "startup"))
      .catch(() => {});
  }

  // Opt-in storage policy (default OFF). Never blocks listen; cancellable on shutdown.
  scheduleStorageCleanupStartupRun();

  return server;
}
