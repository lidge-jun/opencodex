/**
 * The replacement side of a restart handoff: a start that finds its own draining parent.
 *
 * A dashboard drain-and-restart, a join into a Child and the standalone recycle all spawn a
 * detached `ocx start` and hand it `OCX_RESTART_PARENT_PID` (`src/server/restart-replacement.ts`).
 * The deadline and listener-stop-fallback handoffs spawn before the old listener is certainly
 * gone, so the replacement's owner probe can still reach the parent. Refusing that "proxy already
 * running" left no proxy at all a moment later, when the parent exited.
 *
 * So the owner probe runs through {@link probeOwnerPastRestartParent}: while the live owner is
 * exactly the restart parent (`decideStartWithLiveOwner` answers `"await-parent"`), it waits for
 * that process to exit, re-probing once a second in case the parent stops answering first, and
 * then hands back a fresh probe. The wait is bounded; a parent that outlives it is refused like
 * any other live proxy. Nothing here signals the parent, and the wait costs nothing on an ordinary
 * start, which carries no marker.
 *
 * {@link takeRestartHandoffMarkers} also consumes the handoff-log flag: a replacement whose output
 * its parent sent to `restart-handoff.log` bounds that file itself from then on
 * (`armRestartHandoffLogCap` in `src/server/restart-replacement.ts`). It consumes the desktop app's
 * supervision marker too, so a later restart exits to the app instead of spawning past it.
 */
import { isProcessAlive } from "../lib/process-control";
import { takeDesktopSupervisedMarker, takeRestartParentMarker } from "../lib/system-restart-contract";
import { armRestartHandoffLogCap, type RestartHandoffLogCapIo } from "../server/restart-replacement";
import { decideStartWithLiveOwner } from "./dispatch";

export { takeRestartParentMarker };

/**
 * Consume everything a parent handed this start, before its first probe: arm the handoff log's cap
 * when the flag is set, record the desktop app's supervision, and return the restart-parent pid,
 * honored only for this process's real parent. Every marker is removed from `env`, so no later child
 * inherits one.
 */
export function takeRestartHandoffMarkers(
  env: Record<string, string | undefined>,
  logCap: RestartHandoffLogCapIo = {},
): number | null {
  armRestartHandoffLogCap(env, logCap);
  takeDesktopSupervisedMarker(env);
  return takeRestartParentMarker(env);
}

/** How long a replacement waits for its own draining parent before refusing it. */
export const RESTART_PARENT_EXIT_TIMEOUT_MS = 30_000;
const PARENT_EXIT_POLL_MS = 100;
const OWNER_REPROBE_MS = 1_000;

export interface OwnerProbeResult {
  live: { pid: number | null; port: number } | null;
}

export interface RestartParentOwnerInput {
  restartParentPid: number | null;
  requestedPort: number | undefined;
  ocxService: string | undefined;
}

export interface RestartParentWaitIo {
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  log?: (line: string) => void;
}

function isRestartParent(owner: OwnerProbeResult, input: RestartParentOwnerInput): boolean {
  if (owner.live === null) return false;
  return decideStartWithLiveOwner({
    livePort: owner.live.port,
    livePid: owner.live.pid,
    ...input,
  }) === "await-parent";
}

/**
 * Run the start's owner probe, waiting out this process's own restart parent when that is the
 * owner it found. Returns the last probe result: after the parent exited or stopped answering,
 * a fresh one; after the timeout, the one that still names the parent, which the caller refuses.
 */
export async function probeOwnerPastRestartParent<T extends OwnerProbeResult>(
  probe: () => Promise<T>,
  input: RestartParentOwnerInput,
  io: RestartParentWaitIo = {},
): Promise<T> {
  let owner = await probe();
  if (input.restartParentPid === null || !isRestartParent(owner, input)) return owner;
  const parentPid = input.restartParentPid;
  const isAlive = io.isAlive ?? isProcessAlive;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? Bun.sleep;
  const log = io.log ?? ((line: string) => console.log(line));
  const timeoutMs = io.timeoutMs ?? RESTART_PARENT_EXIT_TIMEOUT_MS;
  log(`Waiting for the restarting OpenCodex process (PID ${parentPid}) to hand over its port...`);
  const deadline = now() + timeoutMs;
  let reprobeAt = now() + OWNER_REPROBE_MS;
  while (now() < deadline) {
    if (!isAlive(parentPid)) return probe();
    if (now() >= reprobeAt) {
      owner = await probe();
      if (!isRestartParent(owner, input)) return owner;
      reprobeAt = now() + OWNER_REPROBE_MS;
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(PARENT_EXIT_POLL_MS, remainingMs));
  }
  log(`The restarting OpenCodex process (PID ${parentPid}) did not exit within ${Math.round(timeoutMs / 1000)}s.`);
  return owner;
}
