import { getConfigDir } from "../config/paths";
import { inspectUpdateMarker, tryAcquireUpdateSyncMutex } from "../update/sync-update-mutex";
import type { FanoutDocument } from "./sync-fanout";

function refuseSync(reason: "update-in-flight" | "sync-in-progress", args: readonly string[]): number {
  const exit = reason === "sync-in-progress" ? 1 : 7;
  console.error(reason);
  if (args.includes("--json")) {
    const document: FanoutDocument = { schema: "ocx.sync.fanout/1", home: { state: "skipped", exit }, fanout: { state: "not-applicable", reason }, children: [] };
    console.log(JSON.stringify(document));
  }
  return exit;
}

/** Hold the home-scoped update/sync mutex until the complete sync operation settles. */
export async function withSyncUpdateGuard(run: () => Promise<number>, args: readonly string[] = []): Promise<number> {
  const lease = tryAcquireUpdateSyncMutex(getConfigDir(), "sync");
  if (lease.kind !== "acquired") {
    return refuseSync(lease.holder === "sync" ? "sync-in-progress" : "update-in-flight", args);
  }
  try {
    if (inspectUpdateMarker(getConfigDir()) !== "free") {
      return refuseSync("update-in-flight", args);
    }
    return await run();
  } finally { lease.release(); }
}
