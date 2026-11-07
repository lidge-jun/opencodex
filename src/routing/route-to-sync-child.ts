import { buildExecArgv, remotePinnedSyncArgv } from "../link/ssh-argv";
import { classifySyncResult } from "../cli/sync-fanout";
import { requireRemotePlatformFramed } from "../link/remote-platform";
import { knownHostsFile, runnerFor } from "../server/management/link-route-state";
import type { ManagementContext } from "../server/management/context";
import type { RouteClientId } from "../link/route-intent";
import type { LinkRecord } from "../link/store";
import { homeRouteIntentWatch } from "../link/route-intent-watch";

/** Reuse pinned sync: never run on a machine that has disconnected or joined another Home. */
export async function syncRouteToChild(link: LinkRecord, ctx: ManagementContext, overwriteConflict = false, overwriteClient?: RouteClientId): Promise<{ state: "synced" | "failed" | "pending"; reason?: string }> {
  if (link.direction === "client-initiated") {
    const notified = homeRouteIntentWatch.notify(link.id);
    return { state: "pending", reason: overwriteConflict
      ? "Reconciliation requested without conflict overwrite; run ocx route to sync --overwrite-conflict on the Child to authorize local overwrites"
      : notified ? "Immediate reconciliation requested; awaiting the Child apply report"
        : "No active Child watcher; pending next sync tick. Run ocx route to sync on the Child for immediate apply" };
  }
  try {
    const runner = runnerFor(ctx);
    const knownHosts = knownHostsFile(ctx);
    const platform = link.remotePlatform ?? await requireRemotePlatformFramed(runner, link.alias, knownHosts);
    const result = await runner.run(buildExecArgv({ alias: link.alias, knownHostsFile: knownHosts, argv: remotePinnedSyncArgv(link.id, platform, overwriteConflict, overwriteClient) }), { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
    const verdict = classifySyncResult(result);
    return verdict.state === "synced" ? { state: "synced" } : { state: "failed", reason: verdict.reason ?? "child-sync-failed" };
  } catch {
    return { state: "failed", reason: "child-sync-unavailable" };
  }
}
