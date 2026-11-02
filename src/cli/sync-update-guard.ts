import { getConfigDir } from "../config/paths";
import { acquireSyncGuard, inspectUpdateMarker, parentHoldsSyncMutex, refuseSync } from "../update/sync-update-mutex";

/** Hold the home-scoped update/sync mutex until the complete sync operation settles. */
export async function withSyncUpdateGuard(run: () => Promise<number>, args: readonly string[] = []): Promise<number> {
  const home = getConfigDir();
  if (parentHoldsSyncMutex(home)) return inspectUpdateMarker(home) === "free" ? await run() : refuseSync("update-in-flight", args);
  const lease = acquireSyncGuard(home, args);
  if (lease.kind === "refused") return lease.exit;
  try {
    return await run();
  } finally { lease.release(); }
}
