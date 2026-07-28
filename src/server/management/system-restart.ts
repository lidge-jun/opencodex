/**
 * Dashboard memory-card drain-and-restart (#563).
 *
 * Longer than POST /api/stop's short drain: waits up to 60s for active turns,
 * then respawns via detached `ocx ensure` (or lets an installed service
 * respawn). Never runs restoreNativeCodex / stripGrokConfig — this is a
 * recycle to reclaim RSS, not a teardown.
 */
import { spawn } from "node:child_process";
import { drainAndShutdown, getActiveTurnCount, isDraining } from "../lifecycle";
import { isServiceInstalled } from "../../service";

/** Fixed v1 drain window for the memory-card action (not config-driven). */
export const MEMORY_DRAIN_RESTART_MS = 60_000;

export interface SystemRestartIo {
  drainAndShutdown?: typeof drainAndShutdown;
  isServiceInstalled?: () => boolean;
  spawnEnsure?: () => void;
  exitProcess?: (code: number) => void;
  schedule?: (fn: () => void | Promise<void>, ms: number) => void;
  isDraining?: () => boolean;
  getActiveTurnCount?: () => number;
}

let restartIo: SystemRestartIo = {};
/** Prevents double-scheduling in the 200ms window before drainAndShutdown sets draining. */
let restartAccepted = false;

/** Test seam — reset between tests. */
export function setSystemRestartIoForTests(io: SystemRestartIo = {}): void {
  restartIo = io;
  restartAccepted = false;
}

function spawnDetachedEnsure(): void {
  const child = spawn(process.execPath, [process.argv[1], "ensure"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OCX_SERVICE: "1" },
  });
  child.unref();
}

/**
 * Accept a drain-and-restart request. Returns immediately; the drain +
 * respawn runs on a short timer so the HTTP response can flush first.
 * Idempotent while already draining: returns the accepted shape again.
 */
export function acceptSystemRestart(io: SystemRestartIo = restartIo): {
  accepted: true;
  alreadyDraining: boolean;
  activeTurnCount: number;
  drainTimeoutMs: number;
} {
  const alreadyDraining = restartAccepted || (io.isDraining ?? isDraining)();
  const activeTurnCount = (io.getActiveTurnCount ?? getActiveTurnCount)();
  const schedule = io.schedule ?? ((fn, ms) => { setTimeout(() => { void fn(); }, ms); });

  if (!alreadyDraining) {
    restartAccepted = true;
    schedule(async () => {
      const drain = io.drainAndShutdown ?? drainAndShutdown;
      await drain(undefined, MEMORY_DRAIN_RESTART_MS);
      const serviceInstalled = (io.isServiceInstalled ?? isServiceInstalled)();
      // Service supervisors respawn on exit; spawning ensure would race a second start.
      if (!serviceInstalled) {
        (io.spawnEnsure ?? spawnDetachedEnsure)();
      }
      (io.exitProcess ?? ((code: number) => { process.exit(code); }))(0);
    }, 200);
  }

  return {
    accepted: true,
    alreadyDraining,
    activeTurnCount,
    drainTimeoutMs: MEMORY_DRAIN_RESTART_MS,
  };
}
