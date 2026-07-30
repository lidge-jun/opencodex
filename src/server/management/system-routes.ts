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
 * conversation retention rather than the runtime allocator.
 *
 * `activeTurnCount` / `isDraining` are scalar lifecycle counters for the
 * dashboard drain-and-restart confirm UX — never request bodies or IDs.
 */
import { decideEagerRelay } from "../../lib/bun-stream-caps";
import { getActiveTurnCount, isDraining } from "../lifecycle";
import { getActiveMemoryWatchdog, observedMemoryCounter } from "../memory-watchdog";
import { responseStateMetrics } from "../../responses/state";
import { jsonResponse } from "../auth-cors";
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
    return jsonResponse({
      pid: process.pid,
      bunVersion: Bun.version,
      bunRevision: Bun.revision,
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
      streamMode,
      eagerRelay: process.platform === "win32" ? decideEagerRelay(streamMode) : null,
      watchdog,
      activeTurnCount: getActiveTurnCount(),
      isDraining: isDraining(),
    });
  }

  if (url.pathname === "/api/system/restart" && req.method === "POST") {
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

  return null;
}
