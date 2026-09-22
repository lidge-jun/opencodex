import { currentServiceHomes, serviceStatePathsForOpenCodexHome } from "../../service";
import {
  createWindowsTaskListingCache,
  inspectNativeCodexOwnership,
  type NativeCodexOwnership,
  type OwnershipInspection,
} from "../../integrations/native/ownership-preflight";
import { registerCodexQuotaAutoRefreshWorker } from "../../codex/quota-auto-refresh";
import {
  consumeForInspection,
  relaySseWithHeartbeat,
  relayWithAbort,
  responseWithDeferredRequestLog,
  sanitizePassthroughHeaders,
} from "../relay";
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
} from "../auth-cors";
import {
  bindNativeMainStartupLifecycle,
  blockNativeMainStartupForUnownedServiceHome,
  prepareNativeMainStartupLifecycle,
  releaseNativeMainStartupLifecycle,
  type NativeMainStartupGateDeps,
  type NativeMainStartupLifecycle,
} from "../../codex/native-profile-startup";
import { fetchAllModels, handleManagementAPI, VERSION, type ManagementApiDeps } from "../management-api";
import {
  createManagementSessionControl,
  initializeManagementAuthState,
  issueGuiSession,
  managementPrincipal,
  requireManagementAuth,
  type ManagementAuthState,
} from "../management-auth";
import { createReadinessGate, type ReadinessGate } from "../readiness";
import {
  createRuntimePackageTreeIntegrityGuard,
  type PackageTreeIntegrityGuard,
} from "../../lib/package-tree-integrity";
import type { LiveSidebandWebSocketFactory } from "./live-sideband";
import {
  MAX_CONFIGURABLE_INBOUND_BODY_BYTES,
  MIN_CONFIGURABLE_INBOUND_BODY_BYTES,
  resolveInboundBodyLimitBytes,
} from "../request-decompress";

// GUI static serving extracted to ./server/gui-static. Re-exported below to keep the
// "../src/server" import surface stable for tests/callers.

// Adapter resolution + wire-protocol override extracted to ./server/adapter-resolve.

// Source invariant for tests/responses/passthrough-abort.test.ts after the pure module split:
// if (isEventStream && upstreamResponse.body) {
// const repairConfig = route.provider.responsesItemIdRepair;
// const needsClientRewrite = imageGenCallAliases.size > 0
// #314 gated shape: win32 always uses the terminal-aware eager relay so a keep-alive
// upstream cannot hold Codex open after response.completed; darwin no-rewrite traffic
// requires explicit config-eager opt-in (`auto` always stays tee on darwin).
// selectEagerPath(process.platform, needsClientRewrite, config.streamMode ?? "auto")
// Codex upstream WS runtime gating and the forced bounded single-reader branch
// are owned by responses/ws-upstream.ts and responses/core.ts respectively.
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

const REQUEST_LOG_ID_RESPONSE_HEADER = "x-opencodex-request-id";

export function withRequestLogId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set(REQUEST_LOG_ID_RESPONSE_HEADER, requestId);
  // A custom `x-` header is not CORS-safelisted, so cross-origin JavaScript gets null from
  // `response.headers.get()` even though the header is on the wire. Naming it here is what
  // makes the id readable by a browser client — the only caller that needs a correlation id
  // it did not send itself.
  //
  // Appending to whatever `withCors` already set, rather than overwriting, keeps this
  // independent of the CORS layer: if the data plane later exposes another header, both
  // survive. Duplicate names are harmless, and the header stays absent from responses that
  // never reach this wrapper, so no management or rejected-origin response is widened.
  const exposed = headers.get("Access-Control-Expose-Headers");
  const already = (exposed ?? "")
    .split(",")
    .some(name => name.trim().toLowerCase() === REQUEST_LOG_ID_RESPONSE_HEADER);
  if (!already) {
    headers.set(
      "Access-Control-Expose-Headers",
      exposed ? `${exposed}, ${REQUEST_LOG_ID_RESPONSE_HEADER}` : REQUEST_LOG_ID_RESPONSE_HEADER,
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export interface StartServerDeps {
  /** Test-only seam; production always initializes its own management credential state. */
  managementAuthState?: ManagementAuthState;
  /** Test-only route dependencies, forwarded only after management admission succeeds. */
  managementApi?: ManagementApiDeps;
  /** Test-only native-main recovery dependencies; production constructs the normal manager. */
  nativeMainStartup?: NativeMainStartupGateDeps;
  /** Test-only ownership evidence; production inspects the installed service state. */
  inspectNativeCodexOwnership?: typeof inspectNativeCodexOwnership;
  /** Test-only service-home resolver; production resolves the current homes directly. */
  resolveServiceHomes?: typeof currentServiceHomes;
  /** Test-only seam for an upstream that cannot complete its WebSocket close handshake. */
  liveSidebandWebSocketFactory?: LiveSidebandWebSocketFactory;
  /** Test-only seam; production derives a fresh local-attestation secret per process. */
  localAttestationSecret?: string;
  /** Optional readiness gate; a fresh pending gate is created when omitted. */
  readinessGate?: ReadinessGate;
  /** Test-only package-tree observation; production captures package.json identity at boot. */
  packageTreeIntegrity?: PackageTreeIntegrityGuard;
  /** Test-only seam for observing quota-worker registration ownership. */
  registerCodexQuotaAutoRefreshWorker?: typeof registerCodexQuotaAutoRefreshWorker;
}

export function inspectStartupOwnership(
  deps: StartServerDeps,
  currentHomes: ReturnType<typeof currentServiceHomes> | null,
  statePaths: readonly string[] | null,
  windowsTaskListingCache?: ReturnType<typeof createWindowsTaskListingCache>,
): OwnershipInspection {
  try {
    if (currentHomes === null || statePaths === null) {
      return {
        ownership: "unknown",
        reason: "startup service-home resolution failed",
      };
    }
    if (deps.inspectNativeCodexOwnership) {
      return deps.inspectNativeCodexOwnership({ currentHomes, statePaths, windowsTaskListingCache });
    }
    return inspectNativeCodexOwnership({ currentHomes, statePaths, windowsTaskListingCache });
  } catch {
    return {
      ownership: "unknown",
      reason: "service-home ownership inspection failed",
    };
  }
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
/**
 * The composition root owns WHEN the startup cache invalidation runs, but the flag lives here
 * with its reader. An ES import binding is read-only, so the root cannot assign to it across
 * the module boundary the way it did when both sides were one file. This setter is that
 * assignment, kept next to the reader so the two cannot drift apart.
 */
export function setStartupCacheInvalidationWrite(wrote: boolean): void {
  startupCacheInvalidationWrote = wrote;
}

export function consumeStartupCacheInvalidationWrite(): boolean {
  const wrote = startupCacheInvalidationWrote;
  startupCacheInvalidationWrote = false;
  return wrote;
}

export function warnAgentTaskRecoveryStartup(config: {
  agentTaskRecovery?: { enabled?: boolean };
}): void {
  if (config.agentTaskRecovery?.enabled !== true) return;
  console.warn("⚠️  Experimental encrypted V2 task recovery is enabled.");
  console.warn("   A scoped cache miss may send an additional authenticated request to ChatGPT and may consume quota or add latency; concurrent misses can share one request.");
  console.warn("   Recovered plaintext assignment data is retained only in a bounded, process-local in-memory cache; exact fidelity is not guaranteed and the path depends on undocumented backend behavior.");
}

/**
 * Resolved once, before any listener binds. The clamp is silent inside the resolver so it
 * stays pure and per-request cheap; the operator is told here instead, once, because a
 * config value that was quietly reduced is exactly the thing they would otherwise debug
 * against the wrong limit.
 */
export function resolveInboundBodyLimitWithWarning(config: { maxInboundBodyBytes?: number }): number {
  const limit = resolveInboundBodyLimitBytes(config.maxInboundBodyBytes);
  const requested = config.maxInboundBodyBytes;
  if (requested !== undefined && requested > 0 && requested !== limit) {
    console.warn(
      `[server] maxInboundBodyBytes=${requested} is outside the supported range `
      + `[${MIN_CONFIGURABLE_INBOUND_BODY_BYTES}, ${MAX_CONFIGURABLE_INBOUND_BODY_BYTES}]; `
      + `using ${limit} bytes.`,
    );
  }
  return limit;
}

export function warnPlaintextV2AgentMessagesStartup(config: { plaintextV2AgentMessages?: boolean }): void {
  if (config.plaintextV2AgentMessages !== true) return;
  console.warn("⚠️  Experimental plaintext V2 agent messages are enabled.");
  console.warn("   Eligible ChatGPT collaboration calls may carry plaintext message arguments. HTTPS remains encrypted, but task text may be retained in Codex history, selected providers, and local response/debug state.");
  console.warn("   This depends on undocumented ChatGPT and Codex behavior; it does not decrypt existing tasks.");
}
