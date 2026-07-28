/**
 * Dashboard memory-card drain-and-restart (#563).
 *
 * Longer than POST /api/stop's short drain: waits up to 60s for active turns,
 * then respawns. Never runs restoreNativeCodex / stripGrokConfig — this is a
 * recycle to reclaim RSS, not a teardown.
 *
 * Respawn policy (matches real supervisor configs in src/service.ts):
 * - Supervised child (`OCX_SERVICE=1` + service installed): exit(1) so
 *   failure-only supervisors (systemd Restart=on-failure, WinSW onfailure,
 *   Task Scheduler ERRORLEVEL loop) bring the proxy back.
 * - Otherwise: detached `ocx start --port <live>` (bypasses ensure's
 *   codexAutoStart gate), mark recycle so exit cleanup keeps injection, exit(0).
 * - If detached spawn fails (sync throw or pre-start `error`): exit(1) without
 *   markRecycling — after drain the listen socket is already closed, so a latch
 *   reset cannot recover serving. Clear inherited `OCX_SERVICE` so exit cleanup
 *   can restore Codex/Grok fences (ensure/tray daemons set the marker without a
 *   real supervisor). Log only a stable errno code — never the raw message
 *   (paths in ENOENT often include the OS username).
 */
import { spawn } from "node:child_process";
import {
  drainAndShutdown,
  getActiveTurnCount,
  getServerListenPort,
  isDraining,
  markRecyclingForExit,
  setDraining,
} from "../lifecycle";
import { isServiceInstalled } from "../../service";
import { readRuntimePort } from "../../config";

/** Fixed v1 drain window for the memory-card action (not config-driven). */
export const MEMORY_DRAIN_RESTART_MS = 60_000;

export interface SystemRestartIo {
  drainAndShutdown?: typeof drainAndShutdown;
  isServiceInstalled?: () => boolean;
  isSupervisedServiceChild?: () => boolean;
  /** Must resolve only after the replacement process has actually started. */
  spawnStart?: (port?: number) => void | Promise<void>;
  markRecycling?: () => void;
  exitProcess?: (code: number) => void;
  schedule?: (fn: () => void | Promise<void>, ms: number) => void;
  isDraining?: () => boolean;
  setDraining?: (value: boolean) => void;
  getActiveTurnCount?: () => number;
  listenPort?: () => number | undefined;
}

let restartIo: SystemRestartIo = {};
/** Prevents double-scheduling in the 200ms window before drainAndShutdown sets draining. */
let restartAccepted = false;

/** Test seam — reset between tests. */
export function setSystemRestartIoForTests(io: SystemRestartIo = {}): void {
  restartIo = io;
  restartAccepted = false;
}

function resolveListenPort(): number | undefined {
  const live = getServerListenPort();
  if (live) return live;
  const runtime = readRuntimePort(process.pid);
  if (runtime && runtime.port > 0) return runtime.port;
  return undefined;
}

function isSupervisedServiceChild(): boolean {
  return process.env.OCX_SERVICE === "1" && isServiceInstalled();
}

/** Stable, path-free spawn failure label for logs (never interpolate err.message). */
function spawnFailureCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) return code;
  }
  return "spawn_failed";
}

function spawnDetachedStart(port?: number): Promise<void> {
  const args = [process.argv[1], "start"];
  if (typeof port === "number" && Number.isFinite(port) && port > 0 && port <= 65535) {
    args.push("--port", String(Math.trunc(port)));
  }
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, OCX_SERVICE: "1" },
      });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.once("error", (err) => {
      finish(() => reject(err));
    });
    child.once("spawn", () => {
      finish(() => {
        child.unref();
        resolve();
      });
    });
  });
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
    // Reject new data-plane traffic immediately (503), before the 200ms response-flush delay.
    (io.setDraining ?? setDraining)(true);
    schedule(async () => {
      const drain = io.drainAndShutdown ?? drainAndShutdown;
      await drain(undefined, MEMORY_DRAIN_RESTART_MS);
      const supervised = (io.isSupervisedServiceChild ?? isSupervisedServiceChild)();
      if (supervised) {
        // Failure-only supervisors ignore exit(0); intentional non-zero triggers respawn.
        (io.exitProcess ?? ((code: number) => { process.exit(code); }))(1);
        return;
      }
      const port = (io.listenPort ?? resolveListenPort)();
      const exitProcess = io.exitProcess ?? ((code: number) => { process.exit(code); });
      try {
        await (io.spawnStart ?? spawnDetachedStart)(port);
      } catch (err) {
        console.warn(
          `⚠️  Drain-and-restart spawn failed (${spawnFailureCode(err)}); exiting without replacement`,
        );
        // Listen socket is already stopped; do not markRecycling — no child to inherit fences.
        // ensure/tray children inherit OCX_SERVICE=1 without an installed service; clear it so
        // syncCleanup can restore Codex/Grok fences instead of leaving clients pointed at a dead port.
        delete process.env.OCX_SERVICE;
        exitProcess(1);
        return;
      }
      (io.markRecycling ?? markRecyclingForExit)();
      exitProcess(0);
    }, 200);
  }

  return {
    accepted: true,
    alreadyDraining,
    activeTurnCount,
    drainTimeoutMs: MEMORY_DRAIN_RESTART_MS,
  };
}
