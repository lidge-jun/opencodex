import { getConfigDir } from "../config/paths";
import { acquireSyncGuard, inspectUpdateMarker, inspectUpdateSyncMutex, parentHoldsSyncMutex, refuseSync, staleUpdateMarkerHint } from "../update/sync-update-mutex";

/** Hold the home-scoped update/sync mutex until the complete sync operation settles. */
export async function withSyncUpdateGuard(run: () => Promise<number>, args: readonly string[] = []): Promise<number> {
  const home = getConfigDir();
  if (process.env.OCX_SYNC_MUTEX_HELD_BY) {
    const deadline = Date.now() + 2_000;
    while (!parentHoldsSyncMutex(home) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (!parentHoldsSyncMutex(home)) return refuseSync(inspectUpdateSyncMutex(home) === "sync" ? "sync-in-progress" : "update-in-flight", args);
  }
  if (parentHoldsSyncMutex(home)) {
    const detail: { witnessless?: boolean } = {};
    return inspectUpdateMarker(home, { detail }) === "free"
      ? await run()
      : refuseSync("update-in-flight", args, detail.witnessless ? staleUpdateMarkerHint(home) : []);
  }
  const lease = acquireSyncGuard(home, args);
  if (lease.kind === "refused") return lease.exit;
  try {
    return await run();
  } finally { lease.release(); }
}
