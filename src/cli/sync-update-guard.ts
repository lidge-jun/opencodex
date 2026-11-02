import { getConfigDir } from "../config/paths";
import { inspectUpdateMarker, tryAcquireUpdateSyncMutex } from "../update/sync-update-mutex";

/** Hold the home-scoped update/sync mutex until the complete sync operation settles. */
export async function withSyncUpdateGuard(run: () => Promise<number>): Promise<number> {
  const lease = tryAcquireUpdateSyncMutex(getConfigDir(), "sync");
  if (lease.kind !== "acquired") {
    console.error("update-in-flight");
    return 7;
  }
  try {
    if (inspectUpdateMarker(getConfigDir()) !== "free") {
      console.error("update-in-flight");
      return 7;
    }
    return await run();
  } finally { lease.release(); }
}
