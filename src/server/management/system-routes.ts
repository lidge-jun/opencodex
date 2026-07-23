/**
 * /api/system/* — service-process runtime/memory introspection (#314 WP3).
 *
 * Rides the standard management gate: every /api/* request already passed
 * requireApiAuth("management") + the origin check before dispatch, so these
 * routes add no auth of their own. NEVER expose this data on the
 * unauthenticated /healthz surface.
 *
 * The payload is scalar-only (numbers, enum strings): no paths, no tokens, no
 * account identifiers. `jscHeap` (bun:jsc heapStats) is the js-vs-native
 * discriminator: a flat JS heap under a growing RSS points at native runtime
 * memory (the #314 shape), not an app-level JS leak.
 */
import { decideEagerRelay } from "../../lib/bun-stream-caps";
import { getActiveMemoryWatchdog } from "../memory-watchdog";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

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
    const watchdog = watchdogInstance
      ? (() => {
        const snap = watchdogInstance.snapshot();
        return {
          warnThresholdBytes: snap.warnThresholdBytes,
          lastWarnAt: snap.lastWarnAt,
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
      jscHeap,
      streamMode,
      eagerRelay: process.platform === "win32" ? decideEagerRelay(streamMode) : null,
      watchdog,
    });
  }
  return null;
}
