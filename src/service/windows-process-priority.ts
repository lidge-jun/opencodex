import { constants as osConstants, setPriority } from "node:os";

/**
 * Windows proxy scheduling priority.
 *
 * The Task Scheduler definition runs the proxy at NORMAL (task XML `<Priority>4</Priority>`,
 * #3682). On a host saturated by unrelated NORMAL-priority work (Defender scans, encoders,
 * emulators), the proxy's main thread can sit runnable-but-unscheduled for seconds, so
 * `/healthz` misses the 750 ms CLI liveness ceiling and every verb reports "Proxy not
 * reachable" while the listener is up. ABOVE_NORMAL lets the Windows scheduler pick the
 * mostly idle proxy ahead of that work without HIGH's ability to starve the desktop.
 *
 * Best-effort and never fatal: a refused priority change leaves the process at NORMAL.
 * Processes the proxy spawns do not inherit ABOVE_NORMAL; Windows only propagates IDLE and
 * BELOW_NORMAL classes to children. `OCX_DISABLE_PRIORITY_BOOST=1` opts out.
 */
export interface ProcessPriorityDeps {
  platform: NodeJS.Platform;
  disabled: () => boolean;
  setPriority: (pid: number, priority: number) => void;
}

const defaults: ProcessPriorityDeps = {
  platform: process.platform,
  disabled: () => process.env.OCX_DISABLE_PRIORITY_BOOST === "1",
  setPriority,
};

export type ProcessPriorityResult = "raised" | "skipped" | "failed";

export function raiseWindowsProxyPriority(deps: ProcessPriorityDeps = defaults): ProcessPriorityResult {
  if (deps.platform !== "win32" || deps.disabled()) return "skipped";
  try {
    deps.setPriority(0, osConstants.priority.PRIORITY_ABOVE_NORMAL);
    return "raised";
  } catch {
    return "failed";
  }
}
