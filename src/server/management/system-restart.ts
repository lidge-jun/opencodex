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
 * - The replacement is spawned by `src/server/restart-replacement.ts`: it carries
 *   `OCX_RESTART_PARENT_PID` and its output goes to the bounded `restart-handoff.log`.
 *   Only after a completed drain (the handoff waits for health) is a replacement that
 *   exits before it answers retried, twice, inside the readiness budget. A deadline,
 *   failed-drain or listener-stop-fallback handoff resolves on spawn and exits: the
 *   replacement's own parent wait and port reclaim cover it, and any other early exit
 *   there is not retried.
 * - If detached spawn fails (sync throw, pre-start `error`, or every attempt exited
 *   early): exit(1) without markRecycling — after drain the listen socket is already
 *   closed, so a latch reset cannot recover serving. Clear inherited `OCX_SERVICE`
 *   so exit cleanup can restore Codex/Grok fences when a stale service marker has no
 *   viable supervisor. Log only a stable errno code — never the raw message
 *   (paths in ENOENT often include the OS username).
 * - Except after a committed client connection (a join into a Child): Codex already
 *   routes to the client runtime the next start serves on this port, so the failed
 *   handoff still marks recycling and exit cleanup keeps that routing instead of
 *   silently falling back to native Codex.
 */
import {
  acquireTemporaryDrain,
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
import { readClientConnectionState } from "../../client/state";
import { withSiblingMarker } from "../../codex/sibling-start";
import { readRuntimePort } from "../../config/process-state";
import { spendLedgerRestartEnvironment } from "../../lib/spend-ledger-owner";
import { MEMORY_DRAIN_RESTART_MS } from "../../lib/system-restart-contract";
import { spawnReplacementStart } from "../restart-replacement";

export { MEMORY_DRAIN_RESTART_MS, REPLACEMENT_READY_TIMEOUT_MS } from "../../lib/system-restart-contract";
export { waitForReplacementReady, type ReplacementReadinessIo } from "../restart-replacement";
export const DEADLINE_LISTENER_STOP_TIMEOUT_MS = 5_000;

export interface SystemRestartIo {
  acquireTemporaryDrain?: () => { release(): void } | null;
  drainAndShutdown?: typeof drainAndShutdown;
  /** True when a background service can actually respawn this process after exit(1). */
  isServiceViable?: () => boolean;
  isSupervisedServiceChild?: () => boolean;
  /** Ordinary start; deadline handoff may defer health until parent exit releases OS locks. */
  spawnStart?: (port?: number, waitForHealthBeforeParentExit?: boolean) => void | Promise<void>;
  /** Idempotent listener close; must settle before an ordinary start is spawned. */
  stopListener?: () => void | Promise<void>;
  markRecycling?: () => void;
  /** True once a client connection has committed (a join into a Child); read only after a failed handoff. */
  isClientConnected?: () => boolean;
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

export interface SystemRestartAdmission {
  /** Only the caller that created this pending restart receives its veto. */
  onAccepted?: (veto: () => void) => void;
  /** Recheck external authority before draining or handing off. */
  beforeScheduledDrain?: () => boolean;
}

let restartIo: SystemRestartIo = {};
/** Prevents double-scheduling in the 200ms window before drainAndShutdown sets draining. */
let restartAccepted = false;

type RestartDrainOutcome = "completed" | "failed" | "rejected" | "deadline";
type BoundedSettlementOutcome = "completed" | "rejected" | "deadline";

function waitForRestartDrain(
  drainPromise: Promise<boolean | void>,
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
      succeeded => finish(succeeded === false ? "failed" : "completed"),
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

/**
 * Set when an operator-initiated shutdown (signal or management stop) begins. An automatic
 * restart that is already draining cannot tell its own listener stop from an independent one,
 * so it consults this instead and never hands off after the process was asked to stop.
 */
let explicitShutdownRequested = false;
export function noteExplicitShutdownRequested(): void {
  explicitShutdownRequested = true;
}

/** Test seam — reset between tests. */
export function setSystemRestartIoForTests(io: SystemRestartIo = {}): void {
  restartIo = io;
  restartAccepted = false;
  explicitShutdownRequested = false;
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

/**
 * After a failed handoff, keep Codex routing when a client connection has committed.
 *
 * `connectClient` already pointed Codex at the client runtime that the next start (a service
 * relaunch, the desktop app, or `ocx start`) serves on this same port. Restoring native Codex here
 * would be a silent local fallback while client state says connected. An unreadable state is not
 * proof of a join, so it keeps today's restore.
 */
function keepRoutingForCommittedClient(io: SystemRestartIo): void {
  let connected = false;
  try {
    connected = (io.isClientConnected ?? (() => readClientConnectionState().kind === "connected"))();
  } catch {
    connected = false;
  }
  if (connected) (io.markRecycling ?? markRecyclingForExit)();
}

/**
 * The replacement's environment before `spawnReplacementStart` adds the restart-parent marker and
 * the runtime provenance: never under a service marker, a sibling's replacement stays a sibling,
 * and only a parent-exit handoff marks the bounded spend-ledger lease wait.
 */
export function replacementStartEnvironment(
  waitForHealthBeforeParentExit: boolean,
  parentPid: number = process.pid,
): NodeJS.ProcessEnv {
  // A sibling's replacement stays a sibling even if the owner is down while it probes.
  const sourceEnv: NodeJS.ProcessEnv = withSiblingMarker(process.env);
  delete sourceEnv.OCX_SERVICE;
  return spendLedgerRestartEnvironment(
    sourceEnv,
    waitForHealthBeforeParentExit ? undefined : parentPid,
  );
}

function spawnDetachedStart(
  port?: number,
  waitForHealthBeforeParentExit = true,
): Promise<void> {
  let env: NodeJS.ProcessEnv;
  try {
    env = replacementStartEnvironment(waitForHealthBeforeParentExit);
  } catch (err) {
    return Promise.reject(err);
  }
  return spawnReplacementStart({ port, waitForHealth: waitForHealthBeforeParentExit, env });
}

async function completeDeferredParentExitHandoff(
  io: SystemRestartIo,
  exitProcess: (code: number) => void,
  port: number | undefined,
  phase: "deadline" | "listener-stop fallback",
  canHandoff: () => boolean = () => true,
): Promise<void> {
  if (!canHandoff()) return;
  try {
    await (io.spawnStart ?? spawnDetachedStart)(port, false);
  } catch (err) {
    console.warn(
      `Drain-and-restart ${phase} spawn failed (${spawnFailureCode(err)}); exiting without replacement`,
    );
    delete process.env.OCX_SERVICE;
    keepRoutingForCommittedClient(io);
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
  canHandoff: () => boolean = () => true,
): Promise<void> {
  if (!canHandoff()) return;
  const supervised = (io.isSupervisedServiceChild ?? (() => isSupervisedServiceChild(io)))();
  if (supervised) {
    // Failure-only supervisors ignore exit(0); intentional non-zero triggers respawn.
    if (!canHandoff()) return;
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
  await completeDeferredParentExitHandoff(io, exitProcess, port, "deadline", canHandoff);
}

/**
 * Accept a drain-and-restart request. Returns immediately; the drain +
 * respawn runs on a short timer so the HTTP response can flush first.
 * Idempotent while already draining: returns the accepted shape again.
 */
export function acceptSystemRestart(io: SystemRestartIo = restartIo, admission: SystemRestartAdmission = {}): {
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
    const automatic = Boolean(admission.onAccepted);
    const temporaryDrain = automatic
      ? (io.acquireTemporaryDrain ?? (() => acquireTemporaryDrain("automatic-restart")))()
      : null;
    const releasePending = () => {
      temporaryDrain?.release();
      restartAccepted = false;
    };
    if (automatic && !temporaryDrain) {
      restartAccepted = false;
      return { accepted: true, alreadyDraining: true, activeTurnCount, drainTimeoutMs: MEMORY_DRAIN_RESTART_MS };
    }
    let pending = true;
    let vetoed = false;
    admission.onAccepted?.(() => {
      if (!pending) return;
      pending = false;
      vetoed = true;
      releasePending();
    });
    const now = io.now ?? Date.now;
    const restartDeadlineMs = now() + MEMORY_DRAIN_RESTART_MS;
    // Reject new data-plane traffic immediately (503), before the 200ms response-flush delay.
    if (!automatic) {
      if (io.beginShutdownDrain) io.beginShutdownDrain();
      else if (io.setDraining) io.setDraining(true);
      else beginShutdownDrain();
    }
    schedule(async () => {
      if (vetoed) return;
      pending = false;
      const canHandoff = () => {
        // Only admission-bound (automatic) restarts yield to an explicit stop; manual restart
        // requests keep their existing semantics.
        if (admission.onAccepted && explicitShutdownRequested) return false;
        try { return admission.beforeScheduledDrain?.() ?? true; }
        catch { return false; } // Unknown ownership is not authority to restart.
      };
      if (!canHandoff()) { releasePending(); return; }
      if (automatic) {
        if (io.beginShutdownDrain) io.beginShutdownDrain();
        else if (!io.setDraining) beginShutdownDrain();
        temporaryDrain?.release();
      }
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
      if (!canHandoff()) return;
      const exitProcess = io.exitProcess ?? ((code: number) => { process.exit(code); });
      if (drainOutcome === "deadline") {
        console.warn("Drain-and-restart deadline expired; forcing terminal restart handoff");
        await completeDeadlineRestartHandoff(io, exitProcess, restartPort, scheduleDeadline, canHandoff);
        return;
      }
      if (drainOutcome === "failed" || drainOutcome === "rejected") {
        // drainAndShutdown stops the listener in finally. Even if ancillary cleanup
        // rejects, an accepted restart must still reach replacement or terminal exit.
        console.warn("Drain-and-restart cleanup failed; continuing terminal restart handoff");
      }
      const supervised = (io.isSupervisedServiceChild ?? (() => isSupervisedServiceChild(io)))();
      if (supervised) {
        // Failure-only supervisors ignore exit(0); intentional non-zero triggers respawn.
        if (!canHandoff()) return;
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
          canHandoff,
        );
        return;
      }
      try {
        if (!canHandoff()) return;
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
        // this unsupervised parent restores clients after the failed handoff — unless a
        // committed client connection already owns that routing.
        delete process.env.OCX_SERVICE;
        keepRoutingForCommittedClient(io);
        exitProcess(1);
        return;
      }
      (io.markRecycling ?? markRecyclingForExit)();
      exitProcess(drainOutcome === "failed" || drainOutcome === "rejected" ? 1 : 0);
    }, 200);
  }

  return {
    accepted: true,
    alreadyDraining,
    activeTurnCount,
    drainTimeoutMs: MEMORY_DRAIN_RESTART_MS,
  };
}
