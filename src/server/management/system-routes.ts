/**
 * /api/system/* — service-process runtime/memory introspection (#314 WP3)
 * and the memory-card drain-and-restart action (#563).
 *
 * Rides the standard management gate: every /api/* request already passed
 * the independent management-auth gate + the origin check before dispatch, so these
 * routes add no auth of their own. NEVER expose this data on the
 * unauthenticated /healthz surface.
 *
 * The payload is scalar-only (numbers, enum strings, booleans): no paths, no
 * tokens, no account identifiers. `external` and `arrayBuffers` keep Windows
 * diagnostics honest when RSS/working-set counters under-report committed
 * retention. `jscHeap` (bun:jsc heapStats) is useful context, but on Bun 1.3.14
 * it is not a standalone leak discriminator. `responseState` attributes growth
 * further: it is the proxy's previous_response_id continuation store, so a
 * growing responseState.totalBytes under rising observed memory points at
 * conversation retention rather than the runtime allocator. Spill counts,
 * payload-byte totals, tombstones, and failure counters remain finite scalars;
 * response ids, filenames, digests, paths, and payload content never leave the owner.
 *
 * `activeTurnCount` / `isDraining` are scalar lifecycle counters for the
 * dashboard drain-and-restart confirm UX — never request bodies or IDs.
 */
import { selectEagerPath } from "../../lib/bun-stream-caps";
import { reportedBunRuntimeSource } from "../../lib/bun-runtime";
import { getActiveTurnCount, isDraining } from "../lifecycle";
import { getActiveMemoryWatchdog, observedMemoryCounter } from "../memory-watchdog";
import { responseStateMetrics } from "../../responses/state";
import { appOwnedBytesSnapshot } from "../../lib/app-owned-memory";
import { readWindowsReplaceRetryCounters } from "../../lib/windows-atomic-replace";
import {
  SYSTEM_RESTART_EXPECTED_PID_HEADER,
  parseExpectedSystemRestartPid,
} from "../../lib/system-restart-contract";
import {
  CODEX_APP_SERVER_STATE_PATH,
  CODEX_RESTART_PATH,
} from "../../lib/codex-restart-contract";
import { jsonResponse } from "../auth-cors";
import { getInspectionCounters } from "../relay";
import type {
  performCodexRestart,
  readCodexAppServerState,
} from "../../codex/app-server-restart-service";
import type { ManagementContext } from "./context";
import { acceptSystemRestart } from "./system-restart";

const ENDPOINT_SAMPLE_LIMIT = 60;

export async function handleSystemRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname === "/api/system/memory" && req.method === "GET") {
    const usage = process.memoryUsage();
    let jscHeap: { heapSize: number; heapCapacity: number; objectCount: number } | null = null;
    try {
      const { heapStats } = await import("bun:jsc");
      const stats = heapStats();
      jscHeap = {
        heapSize: stats.heapSize,
        heapCapacity: stats.heapCapacity,
        objectCount: stats.objectCount,
      };
    } catch {
      /* non-Bun tooling or unavailable introspection — omit the discriminator */
    }
	    const watchdogInstance = getActiveMemoryWatchdog();
	    const observed = observedMemoryCounter({
	      rss: usage.rss,
	      external: usage.external,
	      arrayBuffers: usage.arrayBuffers,
	    });
    const watchdog = watchdogInstance
      ? (() => {
        const snap = watchdogInstance.snapshot();
	        return {
	          warnThresholdBytes: snap.warnThresholdBytes,
	          lastWarnAt: snap.lastWarnAt,
	          observedBytes: snap.observedBytes,
	          observedMetric: snap.observedMetric,
	          samples: snap.samples.slice(-ENDPOINT_SAMPLE_LIMIT),
	        };
      })()
      : null;
    const streamMode = config.streamMode ?? "auto";
    /**
     * No request-specific rewrite context exists on this route, so report the
     * effective no-client-rewrite baseline. Individual rewrite requests still
     * stay on tee even when this baseline says eager.
     */
    const eagerRelay = selectEagerPath(process.platform, false, streamMode);
    return jsonResponse({
      pid: process.pid,
      bunVersion: Bun.version,
      bunRevision: Bun.revision,
      // Recorded at launch, not resolved now: absent means "this service predates the
      // marker", which callers must report as unknown rather than guess.
      bunRuntimeSource: reportedBunRuntimeSource(),
      platform: process.platform,
      uptimeSeconds: process.uptime(),
      rss: usage.rss,
      heapUsed: usage.heapUsed,
	      heapTotal: usage.heapTotal,
	      external: usage.external,
	      arrayBuffers: usage.arrayBuffers,
	      observedBytes: observed.observedBytes,
	      observedMetric: observed.observedMetric,
	      jscHeap,
      responseState: responseStateMetrics(),
      appOwnedBytes: appOwnedBytesSnapshot(),
      inspectionCounters: getInspectionCounters(),
      streamMode,
      eagerRelay,
      watchdog,
      activeTurnCount: getActiveTurnCount(),
      isDraining: isDraining(),
    });
  }

  /**
   * Windows atomic-replace retry counters.
   *
   * A sibling route rather than a field on /api/system/memory: that payload is
   * memory-shaped, and appending unrelated filesystem counters to it makes both
   * harder to consume.
   *
   * Keys are `publisher:CODE` where publisher is a closed union
   * (ReplacePublisher) and never a path — a path could carry a username. The
   * type is what enforces that; a text scan cannot see a runtime value.
   */
  if (url.pathname === "/api/system/windows-replace-retries" && req.method === "GET") {
    return jsonResponse({ counters: readWindowsReplaceRetryCounters() });
  }
  if (url.pathname === "/api/system/restart" && req.method === "POST") {
    const expectedPid = parseExpectedSystemRestartPid(
      req.headers.get(SYSTEM_RESTART_EXPECTED_PID_HEADER),
    );
    if (expectedPid.kind === "invalid") {
      return jsonResponse({
        success: false,
        error: "Invalid restart target identity.",
      }, 400, req, config);
    }
    if (expectedPid.kind === "present" && expectedPid.pid !== process.pid) {
      return jsonResponse({
        success: false,
        error: "Restart target identity changed.",
      }, 409, req, config);
    }

    // Longer informed drain than /api/stop; does not tear down Codex/Grok injection.
    const result = acceptSystemRestart();
    return jsonResponse({
      success: true,
      message: result.alreadyDraining
        ? "Drain already in progress."
        : "Draining in-flight requests, then restarting.",
      activeTurnCount: result.activeTurnCount,
      drainTimeoutMs: result.drainTimeoutMs,
      alreadyDraining: result.alreadyDraining,
    }, 202, req, config);
  }

  if (
    (url.pathname === CODEX_APP_SERVER_STATE_PATH && req.method === "GET")
    || (url.pathname === CODEX_RESTART_PATH && req.method === "POST")
  ) {
    // Resolved inside the path check, not at the top of this function: every
    // /api/system/* request runs through here, and an unconditional import would
    // pull the platform process-enumeration helpers into requests that never
    // touch them.
    // An explicit branch rather than `??`: the seam is an optional property, and
    // narrowing through a nullish default keeps its `undefined` in the union.
    let service: {
      readState: typeof readCodexAppServerState;
      performRestart: typeof performCodexRestart;
    };
    const injected = ctx.deps.codexRestartService;
    if (injected) {
      service = injected;
    } else {
      const module = await import("../../codex/app-server-restart-service");
      service = {
        readState: module.readCodexAppServerState,
        performRestart: module.performCodexRestart,
      };
    }
    if (req.method === "GET") {
      return jsonResponse(service.readState(), 200, req, config);
    }
    return jsonResponse(await service.performRestart(), 200, req, config);
  }

  return null;
}
