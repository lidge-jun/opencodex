import { remoteWorkspaceEnabled } from "../remote-control/workspace-activation";
import { AuxiliaryListenerBindError } from "./ports";
import { runAdmittedBodyWork } from "./inbound-body-admission";
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
} from "./ws-bridge";
import type { Server, ServerWebSocket } from "bun";
import {
  applyProxyEnv,
  armClaudeCodeBaseline,
  loadConfig,
  saveConfig,
  getConfigDir,
  loopbackCompanionBindError,
  websocketsEnabled,
} from "../config";
import { flushConfigDirHardening } from "../config/paths";
import { migrateStartupSubagentModels } from "./subagent-models-startup";
import { migrateStartupXaiResponses } from "./xai-responses-startup";
import { migrateStartupZaiResponses } from "./zai-responses-startup";
import { reconcileOAuthProviders } from "../oauth";
import { withCatalogWriteSerialization } from "../codex/catalog-write-serialization";
import { invalidateCodexModelsCacheWithPermit } from "../codex/catalog/sync";
import { currentServiceHomes, serviceStatePathsForOpenCodexHome } from "../service";
import { shouldSyncCodexOnStart } from "../codex/desired-state";
import { effectiveLoopbackListenerPort } from "../codex/loopback-target";
import {
  createWindowsTaskListingCache,
  inspectNativeCodexOwnership,
  type NativeCodexOwnership,
  type OwnershipInspection,
} from "../integrations/native/ownership-preflight";
import {
  createResetCreditWhamClient,
  registerCodexCooldownRecoveryProbeWorker,
} from "../codex/auth-api";
import { activateResetCreditAutoRedeem } from "../codex/reset-credit-auto-redeem";
import { registerCodexQuotaAutoRefreshWorker } from "../codex/quota-auto-refresh";
import {
  reconcileLiveStateStores,
  setLiveStateStoreConfig,
} from "../lib/state-store-registrations";
import { startUserCostOverlayReconciler } from "../usage/user-cost-overlay-reconciler";
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
import { acquireServerBackgroundLifecycle } from "./background-lifecycle";
import { startPackageRefresh, stopPackageRefresh } from "../update/refresh-scheduler";
import { activateLab, labActivationRequired } from "../lib/lab-activation";
import { runOpenAiTierStartupMigration } from "../providers/openai-tier-startup";
import { runAlibabaRegionStartupMigration } from "../providers/alibaba-region-startup";
import { runModelRenameStartupMigration } from "../providers/model-rename-startup";
import { runDevinProviderMergeStartupMigration } from "../providers/devin-provider-merge-migration";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { providerCodexAccountMode } from "../providers/registry";
import type { StorageCleanupPolicy } from "../types";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/main-account";
export {
  clearThreadAccountMap,
  formatCodexProviderForLog,
  resolveCodexAccountForThread,
} from "../codex/routing";
import { resolveGuiFilePath, rootFallbackPayload, serveGuiFile, serveSessionBootstrap } from "./gui-static";
export { resolveGuiFilePath, rootFallbackPayload } from "./gui-static";
export { resolveAdapter } from "./adapter-resolve";
export { noteExplicitShutdownRequested } from "./management/system-restart";
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
  hydrateRequestLogsFromDisk,
  httpStatusForRequestLogTerminal,
  inspectResponseLogSsePayload,
  nextRequestLogId,
  recordFirstOutput,
  type RequestLogContext,
  type RequestLogEntry,
} from "./request-log";
import { sessionLaneIdFromRequest } from "./request-log-conversation";
import { setUsageLedgerRetention } from "./usage-ledger-retention";
import { admitHttpWorkflowTurn, workflowDecisionRefusalResponse, type WorkflowRefusalLog } from "./workflow-refusal";
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
export {
  consumeForInspection,
  codexSafetyBufferingFilterOptions,
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
  type DataPlaneAdmission,
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
export { disableResponsesRequestTimeout, linkAbortSignal } from "./responses";
import { runClaudeAuthModeMigration } from "../claude/auth-mode-migration";
import { runRetiredCodexModelMigration } from "../codex/retired-model-migration";
import {
  bindNativeMainStartupLifecycle,
  blockNativeMainStartupForUnownedServiceHome,
  prepareNativeMainStartupLifecycle,
  releaseNativeMainStartupLifecycle,
  type NativeMainStartupGateDeps,
  type NativeMainStartupLifecycle,
} from "../codex/native-profile-startup";
import { EXTERNAL_CALL_PREFIX, LiveCallBindings } from "./live-call-bindings";
import { contextEndpoint, contextRelayActivated } from "../codex/context-compat";
import { fetchAllModels, handleManagementAPI, VERSION, type ManagementApiDeps } from "./management-api";
import {
  createManagementSessionControl,
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
import { createReadinessGate, type ReadinessGate } from "./readiness";
import { createServeOptions, type ServerIngress } from "./index/serve-options";
import { createOptionalListenerSet, LINK_INGRESS_HOSTNAME } from "./index/optional-listeners";
import { createPackageTreeIntegrityGuardForServer } from "./index/package-tree-guard";
import { inspectStartupOwnership, resolveInboundBodyLimitWithWarning, setStartupCacheInvalidationWrite, warnAgentTaskRecoveryStartup, warnPlaintextV2AgentMessagesStartup, type StartServerDeps } from "./index/startup-warnings";
import { acquireSpendLedgerServerLifecycle, recordFailedStartRollback, type SpendLedgerServerLifecycle } from "./index/spend-ledger-lifecycle";
export { waitForFailedStartRollback } from "./index/spend-ledger-lifecycle";

export function startServer(port?: number, deps: StartServerDeps = {}): Server<WsData> {
  const spendLedgerLifecycle = acquireSpendLedgerServerLifecycle(getConfigDir());
  try { return startServerWithSpendLedgerOwner(port, deps, spendLedgerLifecycle); }
  catch (error) { recordFailedStartRollback(error, spendLedgerLifecycle.releaseAfterFailedStart()); throw error; }
}

function startServerWithSpendLedgerOwner(port: number | undefined, deps: StartServerDeps, spendLedgerLifecycle: SpendLedgerServerLifecycle): Server<WsData> {
  const localAttestationSecret = deps.localAttestationSecret ?? createLocalAttestationSecret();
  // Captured before loadConfig() starts the optional ACL flight so stop() drains the same dir
  // even if OPENCODEX_HOME changes underneath a long-lived process.
  const startupConfigDir = getConfigDir();
  const startupConfig = migrateStartupSubagentModels(
    runModelRenameStartupMigration(
      runDevinProviderMergeStartupMigration(
        runAlibabaRegionStartupMigration(runOpenAiTierStartupMigration(loadConfig())),
      ),
    ),
  );
  // Reconcile disk-backed presets first: it replaces provider rows and must not undo
  // an in-memory wire upgrade when that upgrade's persistence is temporarily unavailable.
  reconcileOAuthProviders(startupConfig);
  const config = migrateStartupZaiResponses(migrateStartupXaiResponses(startupConfig));
  warnPlaintextV2AgentMessagesStartup(config);
  warnAgentTaskRecoveryStartup(config);
  setLiveStateStoreConfig(config);
  applyProxyEnv(config, true);
  assertServerAuthConfig(config);
  const managementAuth = deps.managementAuthState ?? initializeManagementAuthState(config);
  const managementSessionControl = createManagementSessionControl(managementAuth);
  let userCostOverlayReconciler: { stop(): void } | null = null;
  const liveCallBindings = new LiveCallBindings();
  // Arm synchronously before listen. A pending journal therefore makes __main__ unusable
  // before any request can resolve its physical credential, while health/management/Pool stay live.
  reconcileLiveStateStores();
  // authMode migration (devlog 260726_claude_auth_auto/015): before "auto" existed,
  // choosing Subscription DELETED the key, so a pre-upgrade block with no authMode is
  // indistinguishable from "never chose". Pin those to subscription once so an upgrade
  // never silently moves a deliberate subscriber onto proxy.
  if (runClaudeAuthModeMigration(config)) saveConfig(config);
  // Retired Codex-login models: a stored gpt-5.4-mini is a guaranteed 404 for the search and
  // vision sidecars and for pool warmup, so it moves to gpt-5.6-luna. Extracted so the rule is
  // testable on its own; see src/codex/retired-model-migration.ts for why exact equality also
  // rewrites an explicit choice.
  if (runRetiredCodexModelMigration(config)) saveConfig(config);
  // Resolve unattended service-home authority before any Codex lock, cache, owner,
  // journal, or credential path. Both positive foreign evidence and an unprovable
  // ownership state are non-authority.
  setStartupCacheInvalidationWrite(false);
  const resolveServiceHomes = deps.resolveServiceHomes ?? currentServiceHomes;
  let startupOwnershipHomes: ReturnType<typeof currentServiceHomes> | null = null;
  let startupOwnershipStatePaths: readonly string[] | null = null;
  // #2923: retain a successful fallback listing only within the first startup
  // ownership decision. A targeted query's bytes are not a Task Scheduler state
  // generation, so the later race-sensitive decision must take a fresh listing.
  // Runtime ownership retries below intentionally omit this startup-local memo too.
  const startupWindowsTaskListingCache = createWindowsTaskListingCache();
  try {
    const homes = resolveServiceHomes();
    const statePaths = serviceStatePathsForOpenCodexHome(homes.opencodexHome);
    startupOwnershipHomes = homes;
    startupOwnershipStatePaths = statePaths;
  } catch { /* inspection below stays unknown */ }
  const startupCacheOwnership = inspectStartupOwnership(
    deps,
    startupOwnershipHomes,
    startupOwnershipStatePaths,
    startupWindowsTaskListingCache,
  );
  // Startup cache invalidation is best-effort and applies only when startup sync is enabled.
  // Check OFF before taking K: on Windows K resolves SID + LocalAppData through PowerShell,
  // and run 35093667426 exceeded healthy controls by 33.8 s against that 30 s child budget.
  // The permit callback still re-reads intent under K to close a concurrent disable race.
  if (shouldSyncCodexOnStart(config) && startupCacheOwnership.ownership === "owned" && startupOwnershipHomes !== null) {
    try {
      const startupCodexHome = startupOwnershipHomes.codexHome;
      // #1046: record whether this actually rewrote the cache. `handleStart` ORs this
      // with the later startup sync and warns ONCE about stale app-servers; warning
      // here instead would read a catalog mtime the sync is about to move.
      const outcome = withCatalogWriteSerialization(startupCodexHome, permit =>
        invalidateCodexModelsCacheWithPermit(permit, startupCodexHome));
      // A refused permit is not a write; only a completed run that returned true is.
      setStartupCacheInvalidationWrite(outcome.kind === "completed" && outcome.value === true);
    } catch { /* no readable Codex home: nothing to invalidate */ }
  }
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
  registerDefaultAppOwnedMemoryStores();
  registerDefaultAppOwnedObservedBuffers();
  registerAppOwnedMemorySweepFallback();
  configureAppOwnedMemoryBudget(resolveAppOwnedMemoryBudgetBytes(config.appOwnedMemoryBudgetMb));
  enforceAppOwnedMemoryBudget();
  // Observe-only mode still journals physical sends, so every server owns before configuring.
  spendLedgerLifecycle.configure(config.spend);
  // After ownership: a second server on the same home is refused above, so the process running
  // this line is the only one appending to usage.jsonl and the only one that may compact it.
  setUsageLedgerRetention(config.usageLedgerMaxBytes);
  registerCodexCooldownRecoveryProbeWorker(config);
  // Issue #42 Phase 3: opt-in archived auto-cleanup (default OFF). Unref'd hourly
  // tick for daily/weekly; startup evaluation is fire-and-forget after listen.
  // Heavy work runs in a Worker via the single-flight job controller.
  // Keep live config.policy in sync when background runs advance nextRun/lastRun.
  const applyPolicy = (policy: StorageCleanupPolicy) => {
    config.storageCleanupPolicy = policy;
  };

  const listenPort = port ?? config.port ?? 10100;
  setCorsOrigin(listenPort);

  // Canonicalize an explicit "localhost" bind (including its fully-qualified spelling) to IPv4
  // so it matches the injected base_url (which
  // resolves localhost→127.0.0.1): on Windows `localhost` resolves ::1-first, but the injected URL
  // is 127.0.0.1, so binding literal "localhost" would reintroduce the F4 refusal. Wildcards
  // (0.0.0.0/::) and specific hosts are left untouched so intentional exposure is preserved.
  const configuredHost = config.hostname?.trim();
  const bindHost = !configuredHost || /^localhost\.?$/i.test(configuredHost) ? "127.0.0.1" : configuredHost;

  // Unauthenticated loopback listener (#1102). Off unless explicitly enabled.
  // A port-less enabled entry is the companion form: same port as the public listener, on
  // 127.0.0.1 (#4236). Refuse an impossible pair here, before any bind, so a hand edit that
  // bypassed validateConfigCandidate reports the collision rather than EADDRINUSE from a
  // rollback that looks like a foreign process holding the port.
  const loopbackListener = config.unauthenticatedLoopbackListener;
  if (loopbackListener?.enabled === true && loopbackListener.port === undefined) {
    const companionError = loopbackCompanionBindError(config.hostname, listenPort);
    if (companionError) throw new Error(companionError);
  }
  const loopbackListenerPort = effectiveLoopbackListenerPort(config, listenPort);
  // Hub management ingress is a third, management-only listener. Its address is intentionally
  // fixed: the kernel loopback bind is the trust boundary that permits Tailscale identity headers.
  const managementIngress = config.runtimeRole === "hub" ? config.hub?.managementIngress : undefined;
  const managementIngressPort = managementIngress?.enabled ? managementIngress.port : null;

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
   * inverts the failure mode: a route added later would be reachable here by default. The
   * entries below are exactly what a directly-spawned `codex app-server` needs.
   *
   * `POST /v1/alpha/search` is the native Codex web-search relay. Codex issues it against the
   * same base URL as `/v1/responses`, so leaving it off the list turned every native web search
   * on the direct-spawn host into a 404 (#3192). The handler still runs its own admission, so a
   * loopback caller without a ChatGPT credential is refused inside it rather than by this gate.
   *
   * The standalone Images client uses the same base URL for its two POST routes. Their handler
   * keeps the paid upstream behind its own admission and forward-credential checks, so admit only
   * the exact methods and paths it serves (#3428).
   *
   * `POST /v1/messages` (Anthropic wire) and `POST /v1/chat/completions` (OpenAI chat wire)
   * are the inference endpoints the hub's OWN local clients speak: `ocx claude` and the
   * `system-env` injection and Claude Desktop 3P dial the first, Cursor Private Inference, the
   * vision `routed-describe` helper and aside/opencode the second (#4236). On a hub whose
   * public listener binds a tailnet address there is no other local socket for them, so
   * leaving them off this list left every non-Codex local client pointed at a closed port.
   * Both handlers resolve their own admission from the RECEIVING listener's policy view — the
   * same resolver and the same loopback short-circuit `/v1/responses` already uses — so this
   * adds a wire, not a trust level. `/api/*` is deliberately still absent: local management
   * discovery goes to the authenticated management surface, never to this listener.
   *
   * `POST /v1/messages/count_tokens` completes that Anthropic wire. It is admitted on a
   * narrower argument than the other two rather than on symmetry: it spends no provider quota,
   * reaches no stored credential, and returns a token count computed from the request body the
   * caller already holds. Withholding it bought no confinement — the same caller may POST the
   * whole conversation to `/v1/messages` on this socket — and cost Claude Code its server-side
   * count, which it then silently replaces with a local estimate. `/api/*`, `/healthz`,
   * `/readyz` and the GUI remain 404 here, which is the boundary that actually matters.
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
    if (path === "/v1/messages" || path === "/v1/chat/completions") return req.method === "POST";
    if (path === "/v1/messages/count_tokens") return req.method === "POST";
    if (path === "/v1/audio/transcriptions") return req.method === "POST";
    if (path === "/v1/audio/transcriptions/stream") return req.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (path === "/v1/alpha/search") return req.method === "POST";
    if (contextEndpoint(path)) return req.method === "POST";
    if (path === "/v1/images/generations" || path === "/v1/images/edits") {
      return req.method === "POST";
    }
    if (path === "/v1/models") return req.method === "GET";
    // Realtime voice — a directly-spawned `codex app-server` needs these for desktop voice
    // the same way it needs /v1/responses. Two shapes, same trust model as /v1/responses:
    //  - standalone sessions (codex-rs thread/realtime/start, WebSocket transport):
    //    WebSocket upgrades on the bare /v1/realtime and /v1/live paths only;
    //  - WebRTC calls (desktop v3 voice): POST call-create on /v1/live or
    //    /v1/realtime/calls, then the sideband join as a WebSocket upgrade on the keyed
    //    /v1/live/{callId}, /v1/realtime/calls/{callId}, or /v1/realtime?call_id= form
    //    (the join reaches this listener through the injected
    //    experimental_realtime_ws_base_url; openai/codex #35830).
    // Plain HTTP on the upgrade paths stays rejected.
    const isWebSocketUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (path === "/v1/realtime") return isWebSocketUpgrade;
    if (path === "/v1/live") return isWebSocketUpgrade || req.method === "POST";
    if (path === "/v1/realtime/calls") return req.method === "POST";
    if (/^\/v1\/(?:live|realtime\/calls)\/[^/]+\/?$/.test(path)) return isWebSocketUpgrade;
    return false;
  }

  /**
   * Routes the loopback hub-management listener will serve. This is default-deny so adding a
   * data-plane or health route to the public handler cannot silently expose it through Tailscale
   * Serve. A dotted GUI path is admitted only when it resolves to a packaged file; extensionless
   * GETs intentionally retain the existing SPA fallback.
   */
  function managementIngressRouteAllowed(url: URL, req: Request): boolean {
    const rawPath = url.pathname;
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return remoteWorkspaceEnabled(config) && rawPath === "/remote-workspace/agent";
    }
    if (rawPath === "/remote-workspace/pair") return remoteWorkspaceEnabled(config) && req.method === "POST";
    if (rawPath === "/opencodex-session") return req.method === "GET" || req.method === "POST";
    if (rawPath.startsWith("/api/")) return true;
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      return false;
    }
    if (
      decodedPath.startsWith("/v1/")
      || decodedPath === "/healthz"
      || decodedPath === "/readyz"
    ) return false;
    if (decodedPath === "/" || !decodedPath.includes(".")) return true;
    return serveGuiFile(rawPath) !== null;
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

  function packageTreeChangedResponse(req: Request, policy: RequestPolicyView, message: string): Response {
    return withCors(new Response(JSON.stringify({
      error: { type: "server_error", code: "package_tree_changed", message },
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }), req, policy);
  }

  async function runAdmittedHttpTurn(
    req: Request,
    policy: RequestPolicyView,
    work: (lease: ActiveTurnLease) => Promise<Response>,
    refusalLog?: WorkflowRefusalLog,
  ): Promise<Response> {
    const lease = tryAdmitTurn(sessionLaneIdFromRequest(req.headers));
    if (!lease) return serverBusyResponse(req, "active turns", policy);
    // Root, lane, and the refusal that follows from them, all live in ./workflow-refusal.
    const workflow = admitHttpWorkflowTurn(req.headers);
    if (workflow && !workflow.admitted) {
      lease.release();
      // withCors, because without Access-Control-Allow-Origin the exposed refusal header is
      // still unreadable to a browser dashboard -- which made exposing it pointless.
      return withCors(workflowDecisionRefusalResponse(workflow, undefined, refusalLog), req, policy);
    }
    if (workflow?.admitted) lease.attach(workflow.lease);
    let response: Response;
    try {
      response = await runAdmittedBodyWork(req, policy, config.maxInboundBodyBytes, () => work(lease), refusalLog);
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
  const packageTreeIntegrity = createPackageTreeIntegrityGuardForServer(deps);
  // Actual bound port, filled in after Bun.serve binds so /readyz reports the
  // real ephemeral port for startServer(0). /healthz keeps its existing port
  // field (the requested listenPort) byte-for-byte.
  let boundPort: number | null = null;

  // Native-main startup ownership creates several SQLite coordination files in
  // CODEX_HOME. When the user has disabled the Codex integration, starting the
  // proxy must not manufacture those Codex artifacts merely to serve other
  // clients; no Codex request can use this lifecycle in that state.
  // Re-probe here instead of trusting the earlier cache decision: startup work
  // between the two sites must not widen the service-install race.
  const nativeOwnership = inspectStartupOwnership(
    deps,
    startupOwnershipHomes,
    startupOwnershipStatePaths,
  );
  const preparedNativeMainLifecycle = nativeOwnership.ownership !== "foreign"
    && startupOwnershipHomes !== null
    ? prepareNativeMainStartupLifecycle(
      deps.nativeMainStartup,
      { codexHome: startupOwnershipHomes.codexHome, configDir: startupOwnershipHomes.opencodexHome },
    )
    : null;
  let retryOwnershipHomes = startupOwnershipHomes;
  let retryOwnershipStatePaths = startupOwnershipStatePaths;
  let retryPreparedNativeMainLifecycle = preparedNativeMainLifecycle;
  const reprobeNativeOwnership = (): NativeCodexOwnership => {
    // If startup could not resolve the homes at all, preserve a bounded retry
    // without guessing an authority. The first successful resolution is pinned
    // together with its service-state paths before ownership is inspected.
    if (retryOwnershipHomes === null || retryOwnershipStatePaths === null) {
      try {
        const homes = resolveServiceHomes();
        const statePaths = serviceStatePathsForOpenCodexHome(homes.opencodexHome);
        retryOwnershipHomes = homes;
        retryOwnershipStatePaths = statePaths;
      } catch {
        return "unknown";
      }
    }
    const homes = retryOwnershipHomes;
    const statePaths = retryOwnershipStatePaths;
    const answer = inspectStartupOwnership(deps, homes, statePaths).ownership;
    if (answer !== "owned") return answer;
    retryPreparedNativeMainLifecycle ??= prepareNativeMainStartupLifecycle(
      deps.nativeMainStartup,
      { codexHome: homes.codexHome, configDir: homes.opencodexHome },
    );
    // An ownership verdict without a lifecycle bound to that same home is not
    // enough to reopen native-main admission.
    return retryPreparedNativeMainLifecycle ? "owned" : "unknown";
  };
  const ownershipRetryOptions = {
    reprobe: reprobeNativeOwnership,
    expectedHomeId: () => retryPreparedNativeMainLifecycle?.homeId ?? null,
    startOwnedLifecycle: () => {
      if (!retryPreparedNativeMainLifecycle) {
        throw new Error("Native-main ownership became known before its startup lifecycle was prepared.");
      }
      return retryPreparedNativeMainLifecycle.start();
    },
  };
  const nativeMainLifecycle: NativeMainStartupLifecycle = shouldSyncCodexOnStart(config)
    ? nativeOwnership.ownership === "owned"
      ? preparedNativeMainLifecycle
        ? preparedNativeMainLifecycle.start()
        : blockNativeMainStartupForUnownedServiceHome(
          "ownership-unknown",
          ownershipRetryOptions,
        )
      : nativeOwnership.ownership === "foreign"
        ? blockNativeMainStartupForUnownedServiceHome("foreign-ownership")
        : blockNativeMainStartupForUnownedServiceHome(
          "ownership-unknown",
          // #2108: an `unknown` verdict means the probe could not answer, not that this host
          // is unownable. Hand the fence a way to re-ask so a host that becomes answerable
          // after boot reopens on its own instead of needing `ocx restart`. A `foreign`
          // verdict ignores this by design — that one is a fact, not a question.
          ownershipRetryOptions,
        )
    : {
      homeId: null,
      settled: Promise.resolve({ status: "ready", homeId: null }),
      release: async () => {},
    };
  let server: Server<WsData>;
  let loopbackServer: Server<WsData> | null = null;
  let managementIngressServer: Server<WsData> | null = null;
  const optionalListeners = createOptionalListenerSet<WsData>();
  const inboundBodyLimitBytes = resolveInboundBodyLimitWithWarning(config);

  function ingressForServer(requestServer: Server<WsData>): ServerIngress {
    const optionalIngress = optionalListeners.ingressOf(requestServer);
    if (optionalIngress !== undefined) return optionalIngress;
    if (requestServer === loopbackServer) return "unauthenticated-loopback";
    if (requestServer === managementIngressServer) return "hub-management";
    return "public";
  }
  const linkPolicy = (): RequestPolicyView => requestPolicyView(config, LINK_INGRESS_HOSTNAME, { allowedKeyIds: optionalListeners.linkAdmissionKeyIds() });
  let backgroundLifecycle: ReturnType<typeof acquireServerBackgroundLifecycle> | null = null;
  let unregisterQuotaAutoRefresh: (() => void) | null = null;
  let remoteWorkspaceStopping = false;
  let remoteWorkspaceShutdown: (() => Promise<void>) | undefined;
  const managementApiDeps: ManagementApiDeps = {
    ...deps.managementApi,
    remoteWorkspaceStopping: () => remoteWorkspaceStopping,
    onRemoteWorkspaceShutdown: shutdown => { remoteWorkspaceShutdown = shutdown; }, linkSupervisor: () => optionalListeners.linkSupervisor(), linkListener: () => optionalListeners,
  };
  let workspaceRuntimeFlight: Promise<typeof import("../remote-control/workspace-runtime")> | undefined;
  const loadRemoteWorkspaceRuntime = () => {
    workspaceRuntimeFlight ??= import("../remote-control/workspace-runtime");
    remoteWorkspaceShutdown = async () => {
      const runtime = await workspaceRuntimeFlight!;
      const sessions = deps.managementApi?.remoteWorkspaceSessions ?? runtime.initializedRemoteWorkspaceSessionsForConfig(config);
      const hub = deps.managementApi?.remoteWorkspaceHub ?? runtime.initializedRemoteWorkspaceHubForConfig(config);
      try { await sessions?.shutdown(); } finally { hub?.closeAllConnections(); }
    };
    return workspaceRuntimeFlight;
  };
  try {
    backgroundLifecycle = acquireServerBackgroundLifecycle(applyPolicy);
    unregisterQuotaAutoRefresh = (deps.registerCodexQuotaAutoRefreshWorker
      ?? registerCodexQuotaAutoRefreshWorker)(config);
    // External `ocx config set` / direct config.json edits run in other
    // processes; poll the file so Logs/Usage display prices follow them live.
    // Started inside the guarded startup transaction so the catch below can
    // release the owner-scoped lease on any listener failure.
    userCostOverlayReconciler = startUserCostOverlayReconciler({ liveConfig: config });
    const serveOptions = createServeOptions({
      drainingResponse,
      ingressForServer,
      loopbackRouteAllowed,
      managementIngressRouteAllowed,
      linkRouteAllowed: optionalListeners.linkRouteAllowed, linkPolicy, onAuthenticatedCatalog: optionalListeners.notifyAuthenticatedCatalog,
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
      get server() { return server; },
      get boundPort() { return boundPort; },
      get remoteWorkspaceStopping() { return remoteWorkspaceStopping; },
    });

    server = spendLedgerLifecycle.track(Bun.serve<WsData>({ ...serveOptions, port: listenPort, hostname: bindHost }));

    // Both binds are one startup transaction (#1102). If the loopback bind fails after the
    // public one succeeded, leaving the public listener up would strand it: the CLI's port
    // retry would read the failure as a public-port conflict and pick a different port,
    // accumulating listeners. Roll back and rethrow the original error instead.
    if (loopbackListenerPort !== null) {
      try {
        loopbackServer = spendLedgerLifecycle.track(Bun.serve<WsData>({
          ...serveOptions,
          port: loopbackListenerPort,
          hostname: "127.0.0.1",
        }));
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
        throw new AuxiliaryListenerBindError("unauthenticatedLoopbackListener", loopbackListenerPort, "127.0.0.1", error);
      }
    }
    if (managementIngressPort !== null) {
      try {
        managementIngressServer = spendLedgerLifecycle.track(Bun.serve<WsData>({
          ...serveOptions,
          port: managementIngressPort,
          hostname: "127.0.0.1",
        }));
      } catch (error) {
        // Preserve the management bind failure while synchronously initiating rollback of every
        // listener already opened in this startup transaction. startServer must not become async.
        for (const bound of [loopbackServer, server]) {
          if (!bound) continue;
          try { void bound.stop(true); } catch { /* report the original bind error */ }
        }
        throw new AuxiliaryListenerBindError("hub.managementIngress", managementIngressPort, "127.0.0.1", error);
      }
    }
    optionalListeners.start({ config, publicPort: server.port ?? listenPort, requestedPort: listenPort,
      maxRequestBodySize: inboundBodyLimitBytes, dispatch: (req, requestServer) => serveOptions.fetch(req, requestServer) });
  } catch (error) {
    unregisterQuotaAutoRefresh?.();
    userCostOverlayReconciler?.stop();
    backgroundLifecycle?.releaseAfterFailedStart();
    void nativeMainLifecycle.release();
    throw error;
  }

  bindNativeMainStartupLifecycle(server, nativeMainLifecycle);
  const nativeStop = server.stop.bind(server);
  const loopbackListenerRef = loopbackServer;
  const managementIngressRef = managementIngressServer;
  let packageRefreshStopped = false;
  Object.defineProperty(server, "stop", {
    configurable: true,
    value: async (closeActiveConnections?: boolean): Promise<void> => {
      remoteWorkspaceStopping = true;
      liveCallBindings.clear();
      // Disarm the package-tree restart timer before listener teardown: a queued
      // replacement callback must not call acceptSystemRestart() after stop() has
      // begun, or it would schedule a drain-and-restart on a stopped server.
      if (!packageRefreshStopped) {
        packageRefreshStopped = true;
        stopPackageRefresh();
      }
      packageTreeIntegrity.dispose();
      // The orchestration lives in `runListenerShutdown` so its two competing properties —
      // cleanup completes, failure propagates — are testable without a live socket.
      await runListenerShutdown(
        [
          () => nativeStop(closeActiveConnections),
          ...(loopbackListenerRef
            ? [() => loopbackListenerRef.stop(closeActiveConnections)]
            : []),
          ...(managementIngressRef
            ? [() => managementIngressRef.stop(closeActiveConnections)]
            : []),
          () => optionalListeners.stop(),
          async () => { await remoteWorkspaceShutdown?.(); },
          async () => {
            try {
              userCostOverlayReconciler?.stop();
            } finally {
              unregisterQuotaAutoRefresh?.();
            }
          },
        ],
        async listenersStopped => {
          try {
            await backgroundLifecycle.release();
            await releaseNativeMainStartupLifecycle(server);
          } finally {
            // icacls.exe from hardenConfigDir() holds the config dir open; a caller that
            // removes the dir right after stop() settles would hit EPERM/EBUSY on Windows
            // otherwise. Config hardening still flushes when an earlier release rejects. The
            // spend owner is retained when a listener stop failed because the socket may live.
            try { if (listenersStopped) spendLedgerLifecycle.release(); }
            finally { await flushConfigDirHardening(startupConfigDir); }
          }
        },
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
    if (loopbackListener?.enabled === true && loopbackListener.port === undefined) {
      // The companion form is the intended one-port hub topology, not a surprise surface: the
      // public listener is already on a non-loopback address, so this line states where local
      // processes go rather than warning about a second port nobody asked for.
      console.log(`🔁 Loopback companion active on http://127.0.0.1:${loopbackPort} — same port as the public listener; local processes need no credential`);
    } else {
      console.warn(`⚠️  Unauthenticated loopback listener active on http://127.0.0.1:${loopbackPort}`);
      console.warn(`   Any local process can use it without a credential — it spends account`);
      console.warn(`   quota and paid provider credentials, and can starve authenticated`);
      console.warn(`   remote clients. Not for shared or multi-tenant hosts.`);
    }
  }

  if (managementIngressServer) {
    const managementPort = managementIngressServer.port ?? managementIngressPort;
    console.log(`🔒 Hub management ingress active on http://127.0.0.1:${managementPort}`);
    console.log(`   GUI and /api/*; opted-in Remote Workspace pairing/agent only; data, health, and readiness are disabled.`);
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
    import("../codex/plan-from-token")
      .then(({ reconcileCodexPlansFromTokens }) => {
        try {
          reconcileCodexPlansFromTokens(config);
        } catch {
          // Derived plan metadata must not block WHAM priming.
        }
        return import("../codex/auth-api");
      })
      .then(({ primeCodexPoolQuotas }) => primeCodexPoolQuotas(config, "startup"))
      .catch(() => {});
  }

  // Opt-in storage policy (default OFF). Never blocks listen; cancellable on shutdown.
  backgroundLifecycle.scheduleStartupRun();

  // Compatibility Lab is optional: wire it only for installs that actually use it -- any
  // routing profile, or automation enabled on disk. This runs synchronously before
  // startServer returns, in the same turn as Bun.serve, so a policy route can never be
  // evaluated before its evidence provider is registered. That ordering is load-bearing:
  // the subagent-fallback chain routes synchronously and has nowhere to await.
  const labConfigDir = getConfigDir();
  if (labActivationRequired(config, labConfigDir)) {
    activateLab(config, labConfigDir);
  }

  // Reset-credit auto-redemption (#822) is opt-in; a default install constructs nothing here.
  // Activation is synchronous (timer registration only); network work happens on the timer.
  if (config.resetCreditAutoRedeem?.enabled === true) {
    activateResetCreditAutoRedeem(config, {
      accountId: MAIN_CODEX_ACCOUNT_ID,
      ...createResetCreditWhamClient(config, MAIN_CODEX_ACCOUNT_ID),
    });
  }

  startPackageRefresh();
  return server;
}

export { LIVE_SIDEBAND_UPSTREAM_OPEN_TIMEOUT_MS, MAX_WS_FRAME_BYTES, attachLiveSidebandUpstream, enqueueLiveSidebandPendingFrame, exceedsLiveSidebandFrameByteLimit, exceedsLiveSidebandPendingByteLimit, openLiveSidebandUpstream } from "./index/live-sideband";
export type { LiveSidebandPendingEnqueueResult, LiveSidebandUpstreamOpenResult } from "./index/live-sideband";
export { consumeStartupCacheInvalidationWrite, warnAgentTaskRecoveryStartup, warnPlaintextV2AgentMessagesStartup } from "./index/startup-warnings";
export type { StartServerDeps } from "./index/startup-warnings";
