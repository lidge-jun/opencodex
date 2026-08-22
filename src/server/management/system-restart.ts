/**
 * Dashboard memory-card drain-and-restart (#563).
 *
 * Longer than POST /api/stop's short drain: waits up to 60s for active turns,
 * then respawns. Never runs restoreNativeCodex / stripGrokConfig — this is a
 * recycle to reclaim RSS, not a teardown.
 *
 * Respawn policy (matches real supervisor configs in src/service.ts):
 * - Supervised child (`OCX_SERVICE=1` + viable service): exit(1) so
 *   failure-only supervisors (systemd Restart=on-failure, WinSW onfailure,
 *   Task Scheduler ERRORLEVEL loop) bring the proxy back.
 * - Otherwise: detached `ocx start --port <live>` (bypasses ensure's
 *   codexAutoStart gate), mark recycle so exit cleanup keeps injection, exit(0).
 *   Installed-but-stale/missing service assets are NOT treated as supervised —
 *   exit(1) would leave the proxy dead with `Service: installed, stale or missing
 *   service assets` and a /healthz timeout.
 * - If detached spawn fails (sync throw or pre-start `error`): exit(1) without
 *   markRecycling — after drain the listen socket is already closed, so a latch
 *   reset cannot recover serving. Clear inherited `OCX_SERVICE` so exit cleanup
 *   can restore Codex/Grok fences when a stale service marker has no viable
 *   supervisor. Log only a stable errno code — never the raw message
 *   (paths in ENOENT often include the OS username).
 */
import { spawn } from "node:child_process";
import {
  beginShutdownDrain,
  drainAndShutdown,
  getActiveTurnCount,
  getServerListenPort,
  isDraining,
  isShutdownDraining,
  markRecyclingForExit,
  stopServerListener,
} from "../lifecycle";
import { isServiceViable } from "../../service";
import { readRuntimePort } from "../../config";
import { withProcessRuntimeProvenance } from "../../lib/bun-runtime";
import { selfLaunchArgv } from "../../lib/self-launch-argv";
import {
  MEMORY_DRAIN_RESTART_MS,
  REPLACEMENT_READY_TIMEOUT_MS,
} from "../../lib/system-restart-contract";
import { findLiveProxy } from "../proxy-liveness";

export { MEMORY_DRAIN_RESTART_MS, REPLACEMENT_READY_TIMEOUT_MS } from "../../lib/system-restart-contract";
export const DEADLINE_LISTENER_STOP_TIMEOUT_MS = 5_000;
const REPLACEMENT_READY_POLL_MS = 150;

export interface ReplacementReadinessIo {
  findLive?: typeof findLiveProxy;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SystemRestartIo {
  drainAndShutdown?: typeof drainAndShutdown;
  /** True when a background service can actually respawn this process after exit(1). */
  isServiceViable?: () => boolean;
  isSupervisedServiceChild?: () => boolean;
  /** Ordinary start; deadline handoff may defer health until parent exit releases OS locks. */
  spawnStart?: (port?: number, waitForHealthBeforeParentExit?: boolean) => void | Promise<void>;
  /** Idempotent listener close; must settle before an ordinary start is spawned. */
  stopListener?: () => void | Promise<void>;
  markRecycling?: () => void;
  exitProcess?: (code: number) => void;
  schedule?: (fn: () => void | Promise<void>, ms: number) => void;
  scheduleDeadline?: (fn: () => void, ms: number) => () => void;
  isDraining?: () => boolean;
  isShutdownDraining?: () => boolean;
  beginShutdownDrain?: () => boolean;
  setDraining?: (value: boolean) => void;
  getActiveTurnCount?: () => number;
  listenPort?: () => number | undefined;
  now?: () => number;
}

let restartIo: SystemRestartIo = {};
/** Prevents double-scheduling in the 200ms window before drainAndShutdown sets draining. */
let restartAccepted = false;

type RestartDrainOutcome = "completed" | "rejected" | "deadline";
type BoundedSettlementOutcome = "completed" | "rejected" | "deadline";

function waitForRestartDrain(
  drainPromise: Promise<void>,
  deadlineMs: number,
  now: () => number,
  scheduleDeadline: NonNullable<SystemRestartIo["scheduleDeadline"]>,
): Promise<RestartDrainOutcome> {
  const remainingMs = Math.max(0, deadlineMs - now());
  if (remainingMs === 0) {
    // Observe any late rejection even though orchestration is already terminal.
    void drainPromise.catch(() => {});
    return Promise.resolve("deadline");
  }
  return new Promise<RestartDrainOutcome>((resolve) => {
    let settled = false;
    let cancelDeadline: (() => void) | undefined;
    const finish = (outcome: RestartDrainOutcome) => {
      if (settled) return;
      settled = true;
      cancelDeadline?.();
      resolve(outcome);
    };
    cancelDeadline = scheduleDeadline(() => finish("deadline"), remainingMs);
    if (settled) cancelDeadline();
    void drainPromise.then(
      () => finish("completed"),
      () => finish("rejected"),
    );
  });
}

function waitForBoundedSettlement(
  promise: Promise<void>,
  timeoutMs: number,
  scheduleDeadline: NonNullable<SystemRestartIo["scheduleDeadline"]>,
): Promise<BoundedSettlementOutcome> {
  return new Promise<BoundedSettlementOutcome>((resolve) => {
    let settled = false;
    let cancelDeadline: (() => void) | undefined;
    const finish = (outcome: BoundedSettlementOutcome) => {
      if (settled) return;
      settled = true;
      cancelDeadline?.();
      resolve(outcome);
    };
    cancelDeadline = scheduleDeadline(() => finish("deadline"), timeoutMs);
    if (settled) cancelDeadline();
    void promise.then(
      () => finish("completed"),
      () => finish("rejected"),
    );
  });
}

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

function isSupervisedServiceChild(io: SystemRestartIo = {}): boolean {
  if (process.env.OCX_SERVICE !== "1") return false;
  // Presence is not enough: stale/missing service assets report installed but will not
  // respawn after exit(1). Dashboard status/recovery must fall through to detached start.
  return (io.isServiceViable ?? isServiceViable)();
}

/** Stable, path-free spawn failure label for logs (never interpolate err.message). */
function spawnFailureCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) return code;
  }
  return "spawn_failed";
}

function handoffError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

export async function waitForReplacementReady(
  expectedPid: number | undefined,
  parentPid: number,
  expectedPort: number | undefined,
  io: ReplacementReadinessIo = {},
): Promise<boolean> {
  const findLive = io.findLive ?? findLiveProxy;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? Bun.sleep;
  const deadline = now() + REPLACEMENT_READY_TIMEOUT_MS;
  while (now() < deadline) {
    try {
      const live = await findLive({
        deadlineAt: deadline,
        nowFn: now,
        sleepFn: sleep,
      });
      // A probe that began within budget can still return after it. Never accept
      // delayed health as proof once the shared absolute handoff budget expired.
      if (now() >= deadline) return false;
      if (
        live
        && live.pid !== null
        && live.pid !== parentPid
        && (expectedPid === undefined || live.pid === expectedPid)
        && (expectedPort === undefined || live.port === expectedPort)
      ) {
        return true;
      }
    } catch {
      // A not-yet-bound replacement is indistinguishable from a transient
      // liveness failure here; keep polling inside the one bounded window.
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(REPLACEMENT_READY_POLL_MS, remainingMs));
  }
  return false;
}

function spawnDetachedStart(
  port?: number,
  waitForHealthBeforeParentExit = true,
): Promise<void> {
  const args = ["start"];
  const expectedPort = typeof port === "number" && Number.isFinite(port) && port > 0 && port <= 65535
    ? Math.trunc(port)
    : undefined;
  if (expectedPort !== undefined) {
    args.push("--port", String(expectedPort));
  }
  const launchArgs = selfLaunchArgv(args);
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.OCX_SERVICE;
      child = spawn(process.execPath, launchArgs, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: withProcessRuntimeProvenance(env),
      });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("spawn", onSpawn);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill(); } catch { /* best-effort failed-start cleanup */ }
        }
        try { child.unref(); } catch { /* best-effort */ }
        reject(error);
        return;
      }
      child.unref();
      resolve();
    };
    const onError = (err: Error) => { finish(err); };
    const onExit = () => { finish(handoffError("child_exit")); };
    const onSpawn = () => {
      if (!waitForHealthBeforeParentExit) {
        // A deadline may have been caused by native-main ownership cleanup.
        // Let the ordinary child survive parent exit, which releases those OS locks.
        finish();
        return;
      }
      void waitForReplacementReady(child.pid, process.pid, expectedPort).then(
        ready => {
          if (!ready) {
            console.warn(
              "Drain-and-restart replacement is still alive after the readiness window; allowing it to continue after parent exit",
            );
          }
          // Never kill a live ordinary start at its valid reclaim boundary. Parent
          // exit is the final resource release the child may still be waiting for.
          finish();
        },
        err => finish(err),
      );
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("spawn", onSpawn);
  });
}

async function completeDeferredParentExitHandoff(
  io: SystemRestartIo,
  exitProcess: (code: number) => void,
  port: number | undefined,
  phase: "deadline" | "listener-stop fallback",
): Promise<void> {
  try {
    await (io.spawnStart ?? spawnDetachedStart)(port, false);
  } catch (err) {
    console.warn(
      `Drain-and-restart ${phase} spawn failed (${spawnFailureCode(err)}); exiting without replacement`,
    );
    delete process.env.OCX_SERVICE;
    exitProcess(1);
    return;
  }
  (io.markRecycling ?? markRecyclingForExit)();
  exitProcess(0);
}

async function completeDeadlineRestartHandoff(
  io: SystemRestartIo,
  exitProcess: (code: number) => void,
  port: number | undefined,
  scheduleDeadline: NonNullable<SystemRestartIo["scheduleDeadline"]>,
): Promise<void> {
  const supervised = (io.isSupervisedServiceChild ?? (() => isSupervisedServiceChild(io)))();
  if (supervised) {
    // Failure-only supervisors ignore exit(0); intentional non-zero triggers respawn.
    exitProcess(1);
    return;
  }

  const stopPromise = Promise.resolve().then(
    () => (io.stopListener ?? (() => stopServerListener()))(),
  );
  const stopOutcome = await waitForBoundedSettlement(
    stopPromise,
    DEADLINE_LISTENER_STOP_TIMEOUT_MS,
    scheduleDeadline,
  );
  if (stopOutcome === "rejected") {
    console.warn("Drain-and-restart deadline listener stop failed; continuing parent-exit handoff");
  } else if (stopOutcome === "deadline") {
    console.warn("Drain-and-restart deadline listener stop timed out; continuing parent-exit handoff");
  }
  // The ordinary child must survive parent exit: a failed/pending socket close
  // or overdue cleanup is completed by process teardown, without a hidden mode.
  await completeDeferredParentExitHandoff(io, exitProcess, port, "deadline");
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
  const shutdownActive = io.isShutdownDraining
    ?? io.isDraining
    ?? isShutdownDraining;
  const alreadyDraining = restartAccepted || shutdownActive();
  const activeTurnCount = (io.getActiveTurnCount ?? getActiveTurnCount)();
  const schedule = io.schedule ?? ((fn, ms) => { setTimeout(() => { void fn(); }, ms); });

  if (!alreadyDraining) {
    restartAccepted = true;
    const now = io.now ?? Date.now;
    const restartDeadlineMs = now() + MEMORY_DRAIN_RESTART_MS;
    // Reject new data-plane traffic immediately (503), before the 200ms response-flush delay.
    if (io.beginShutdownDrain) io.beginShutdownDrain();
    else if (io.setDraining) io.setDraining(true);
    else beginShutdownDrain();
    schedule(async () => {
      // Preserve the live binding before drainAndShutdown (or its deadline race)
      // closes the listener and makes both the server ref and runtime metadata stale.
      const restartPort = (io.listenPort ?? resolveListenPort)();
      const drain = io.drainAndShutdown ?? drainAndShutdown;
      const remainingMs = Math.max(0, restartDeadlineMs - now());
      const drainPromise = Promise.resolve().then(() => drain(undefined, remainingMs));
      const scheduleDeadline = io.scheduleDeadline ?? ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      });
      const drainOutcome = await waitForRestartDrain(drainPromise, restartDeadlineMs, now, scheduleDeadline);
      const exitProcess = io.exitProcess ?? ((code: number) => { process.exit(code); });
      if (drainOutcome === "deadline") {
        console.warn("Drain-and-restart deadline expired; forcing terminal restart handoff");
        await completeDeadlineRestartHandoff(io, exitProcess, restartPort, scheduleDeadline);
        return;
      }
      if (drainOutcome === "rejected") {
        // drainAndShutdown stops the listener in finally. Even if ancillary cleanup
        // rejects, an accepted restart must still reach replacement or terminal exit.
        console.warn("Drain-and-restart cleanup failed; continuing terminal restart handoff");
      }
      const supervised = (io.isSupervisedServiceChild ?? (() => isSupervisedServiceChild(io)))();
      if (supervised) {
        // Failure-only supervisors ignore exit(0); intentional non-zero triggers respawn.
        (io.exitProcess ?? ((code: number) => { process.exit(code); }))(1);
        return;
      }
      try {
        await (io.stopListener ?? (() => stopServerListener()))();
      } catch {
        console.warn("Drain-and-restart listener stop failed; continuing parent-exit handoff");
        await completeDeferredParentExitHandoff(
          io,
          exitProcess,
          restartPort,
          "listener-stop fallback",
        );
        return;
      }
      try {
        // A rejected drain has uncertain cleanup ownership, so it uses the same
        // parent-exit handoff as a deadline. Only a fully completed drain waits
        // for replacement health in the old process.
        await (io.spawnStart ?? spawnDetachedStart)(restartPort, drainOutcome === "completed");
      } catch (err) {
        console.warn(
          `⚠️  Drain-and-restart spawn failed (${spawnFailureCode(err)}); exiting without replacement`,
        );
        // Listen socket is already stopped; do not markRecycling — no child to inherit fences.
        // No replacement inherited the routing. Clear a stale service marker so
        // this unsupervised parent restores clients after the failed handoff.
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
