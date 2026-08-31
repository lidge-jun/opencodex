import { createHash } from "node:crypto";
import { flushAntigravityReplay } from "../adapters/google-antigravity-replay";
import { flushResponseState } from "../responses/state";
import { setStorageCleanupPolicyLiveSink } from "../storage/policy";
import {
  abortStorageCleanupPolicyJobAsync,
  setStorageCleanupPolicyJobLiveApply,
} from "../storage/policy-job";
import { abortRestoreTrashJobAsync } from "../storage/restore-job";
import { stopStorageCleanupScheduler } from "../storage/policy-scheduler";
import { runOptionalShutdownHooks } from "../lib/optional-shutdown-hooks";
import { stopStateStoreSweeper } from "../lib/state-store-sweeper";
import {
  cancelQueuedStorageWorkerSpawns,
  drainStorageWorkers,
} from "../storage/worker-lifecycle";
import { createAdmissionGate, type AdmissionLease, type AdmissionMetrics } from "../lib/admission";
import { codexWebSocketAdmissionMetrics } from "../codex/websocket-registry";
import { storageMutationAdmissionMetrics } from "../storage/storage-mutation-coordinator";
import { storageWorkerAdmissionMetrics } from "../storage/worker-lifecycle";
import {
  backgroundShellAdmissionMetrics,
  beginBackgroundShellShutdown,
  terminateAllBackgroundShells,
} from "../adapters/cursor/native-exec-shell";
import type { CodexAccountSelectionAdmission } from "../codex/auth-context";
import { releaseNativeMainStartupLifecycle } from "../codex/native-profile-startup";

// ---------------------------------------------------------------------------
// Active turn tracking + graceful shutdown drain
// ---------------------------------------------------------------------------

export const MAX_ACTIVE_TURNS = 256;
export const MAX_ACTIVE_SESSION_LANES = 64;
export const SESSION_LANE_ID_BYTES = 32;
const turnGate = createAdmissionGate("active_turns", MAX_ACTIVE_TURNS);
export interface ActiveTurnLease extends AdmissionLease {
  bindAbortController(ac: AbortController): void;
  beginCodexAccountSelection(): CodexAccountSelectionAdmission;
  isTransferred(): boolean;
}
const activeTurns = new Map<AbortController, ActiveTurnLease>();
const admittedTurns = new Set<ActiveTurnLease>();
const activeSessionLaneRefCounts = new Map<string, number>();
let sessionLanePeak = 0;
let sessionLaneAdmitted = 0;
let sessionLaneRejected = 0;
const knownTurnControllers = new WeakSet<AbortController>();
let turnReleaseMisses = 0;
let shutdownDraining = false;
const temporaryDrainOwners = new Set<symbol>();
const nativeMainDrainOwners = new Set<symbol>();
const temporaryDrainWaiters = new Set<() => void>();
const nativeMainTurns = new Set<ActiveTurnLease>();
let nativeMainSelections = 0;
let legacyDrainLease: AdmissionLease | null = null;
let recyclingForExit = false;
let _serverRef: ReturnType<typeof Bun.serve> | undefined;
let serverStopFlights = new WeakMap<ReturnType<typeof Bun.serve>, Promise<void>>();
let serverStartupReleaseFlights = new WeakMap<ReturnType<typeof Bun.serve>, Promise<void>>();
let releaseServerStartupLifecycleImpl: typeof releaseNativeMainStartupLifecycle = releaseNativeMainStartupLifecycle;

export function setServerRef(server: ReturnType<typeof Bun.serve> | undefined): void { _serverRef = server; }
/**
 * Legacy/test-only drain control. Production scoped operations must use a lease,
 * while process shutdown uses the irreversible shutdown latch.
 */
export function setDraining(value: boolean): void {
  if (value) {
    legacyDrainLease ??= acquireTemporaryDrain("legacy");
  } else {
    legacyDrainLease?.release();
    legacyDrainLease = null;
  }
}

function temporaryDrainCount(): number {
  return temporaryDrainOwners.size + nativeMainDrainOwners.size;
}

function notifyTemporaryDrainsSettled(): void {
  if (temporaryDrainCount() !== 0) return;
  for (const resolve of temporaryDrainWaiters) resolve();
  temporaryDrainWaiters.clear();
}

/** Acquire the single owner-scoped global data-plane fence. */
export function acquireTemporaryDrain(owner: string): AdmissionLease | null {
  if (shutdownDraining || temporaryDrainCount() > 0) return null;
  const token = Symbol(owner);
  temporaryDrainOwners.add(token);
  let active = true;
  return {
    release() {
      if (!active) return;
      active = false;
      temporaryDrainOwners.delete(token);
      notifyTemporaryDrainsSettled();
    },
  };
}

/** Fence only turns that select the native Codex `__main__` account. */
export function acquireNativeMainProfileDrain(owner: string): AdmissionLease | null {
  if (shutdownDraining || temporaryDrainCount() > 0) return null;
  const token = Symbol(owner);
  nativeMainDrainOwners.add(token);
  let active = true;
  return {
    release() {
      if (!active) return;
      active = false;
      nativeMainDrainOwners.delete(token);
      notifyTemporaryDrainsSettled();
    },
  };
}

/** Permanently fence this process for shutdown; scoped lease release cannot clear it. */
export function beginShutdownDrain(): boolean {
  if (shutdownDraining) return false;
  shutdownDraining = true;
  return true;
}

export function isShutdownDraining(): boolean { return shutdownDraining; }

export function waitForTemporaryDrains(): Promise<void> {
  if (temporaryDrainCount() === 0) return Promise.resolve();
  return new Promise(resolve => temporaryDrainWaiters.add(resolve));
}

/** Wait for scoped drains without allowing them to outlive the shutdown deadline. */
async function waitForTemporaryDrainsUntil(deadlineMs: number): Promise<boolean> {
  if (temporaryDrainCount() === 0) return true;
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  if (remainingMs === 0) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(drained);
    };
    timer = setTimeout(() => finish(false), remainingMs);
    void waitForTemporaryDrains().then(() => finish(true));
  });
}

/** Test-only process-lifetime reset. Never call from production recovery paths. */
export function resetLifecycleDrainStateForTests(): void {
  legacyDrainLease?.release();
  legacyDrainLease = null;
  temporaryDrainOwners.clear();
  nativeMainDrainOwners.clear();
  nativeMainTurns.clear();
  activeSessionLaneRefCounts.clear();
  sessionLanePeak = 0;
  sessionLaneAdmitted = 0;
  sessionLaneRejected = 0;
  nativeMainSelections = 0;
  for (const resolve of temporaryDrainWaiters) resolve();
  temporaryDrainWaiters.clear();
  shutdownDraining = false;
  serverStopFlights = new WeakMap<ReturnType<typeof Bun.serve>, Promise<void>>();
  serverStartupReleaseFlights = new WeakMap<ReturnType<typeof Bun.serve>, Promise<void>>();
  releaseServerStartupLifecycleImpl = releaseNativeMainStartupLifecycle;
}
export function tryAdmitTurn(sessionLaneId?: string): ActiveTurnLease | null {
  if (isDraining()) return null;
  const opaqueSessionLaneId = sessionLaneId
    ? createHash("sha256").update(sessionLaneId).digest("hex").slice(0, SESSION_LANE_ID_BYTES)
    : undefined;
  const sessionLaneRefCount = opaqueSessionLaneId
    ? activeSessionLaneRefCounts.get(opaqueSessionLaneId) ?? 0
    : 0;
  if (opaqueSessionLaneId && sessionLaneRefCount === 0 && activeSessionLaneRefCounts.size >= MAX_ACTIVE_SESSION_LANES) {
    sessionLaneRejected += 1;
    return null;
  }
  const gateLease = turnGate.tryAcquire();
  if (!gateLease) return null;
  if (opaqueSessionLaneId) {
    activeSessionLaneRefCounts.set(opaqueSessionLaneId, sessionLaneRefCount + 1);
    if (sessionLaneRefCount === 0) {
      sessionLaneAdmitted += 1;
      sessionLanePeak = Math.max(sessionLanePeak, activeSessionLaneRefCounts.size);
    }
  }
  const controllers = new Set<AbortController>();
  let active = true;
  let transferred = false;
  let nativeMainClaimed = false;
  const lease: ActiveTurnLease = {
    bindAbortController(ac) {
      knownTurnControllers.add(ac);
      if (!active) {
        ac.abort(new Error("turn already settled"));
        return;
      }
      transferred = true;
      controllers.add(ac);
      activeTurns.set(ac, lease);
    },
    beginCodexAccountSelection() {
      const mainProfileDraining = nativeMainDrainOwners.size > 0;
      let selectionActive = !mainProfileDraining;
      let released = false;
      if (selectionActive) nativeMainSelections += 1;
      return {
        mainProfileDraining,
        claimMainProfile() {
          if (released || mainProfileDraining || !active) return false;
          if (!nativeMainClaimed) {
            nativeMainClaimed = true;
            nativeMainTurns.add(lease);
          }
          return true;
        },
        release() {
          if (released) return;
          released = true;
          if (selectionActive) {
            selectionActive = false;
            nativeMainSelections = Math.max(0, nativeMainSelections - 1);
          }
        },
      };
    },
    isTransferred() { return transferred; },
    release() {
      if (!active) return;
      active = false;
      admittedTurns.delete(lease);
      for (const controller of controllers) {
        if (activeTurns.get(controller) === lease) activeTurns.delete(controller);
      }
      controllers.clear();
      nativeMainTurns.delete(lease);
      if (opaqueSessionLaneId) {
        const currentRefCount = activeSessionLaneRefCounts.get(opaqueSessionLaneId);
        if (currentRefCount === 1) activeSessionLaneRefCounts.delete(opaqueSessionLaneId);
        else if (currentRefCount && currentRefCount > 1) {
          activeSessionLaneRefCounts.set(opaqueSessionLaneId, currentRefCount - 1);
        }
      }
      gateLease.release();
    },
  };
  admittedTurns.add(lease);
  return lease;
}
export function codexAccountSelectionForTurn(
  lease?: AdmissionLease,
): (() => CodexAccountSelectionAdmission | undefined) | undefined {
  if (!lease || !("beginCodexAccountSelection" in lease)) return undefined;
  const activeLease = lease as ActiveTurnLease;
  return () => activeLease.beginCodexAccountSelection();
}

/** Promote a physical native-main credential read onto an already admitted turn. */
export function tryClaimNativeMainProfileForTurn(lease?: AdmissionLease): boolean {
  const beginSelection = codexAccountSelectionForTurn(lease);
  if (!beginSelection) return false;
  const selection = beginSelection();
  if (!selection) return false;
  try {
    return !selection.mainProfileDraining && selection.claimMainProfile();
  } finally {
    selection.release();
  }
}

/** Acquire standalone native-main ownership for management/background work. */
export function tryAcquireNativeMainProfileClaim(): AdmissionLease | null {
  const turn = tryAdmitTurn();
  if (!turn) return null;
  if (tryClaimNativeMainProfileForTurn(turn)) return turn;
  turn.release();
  return null;
}

export function registerTurn(ac: AbortController, lease?: AdmissionLease): void {
  if (lease && "bindAbortController" in lease) (lease as ActiveTurnLease).bindAbortController(ac);
}
export function unregisterTurn(ac: AbortController): void {
  const lease = activeTurns.get(ac);
  if (!lease) {
    if (knownTurnControllers.has(ac)) return;
    turnReleaseMisses += 1;
    return;
  }
  lease.release();
}
export function isDraining(): boolean { return shutdownDraining || temporaryDrainOwners.size > 0; }
export function getActiveTurnCount(): number { return turnGate.metrics().active; }
export interface SessionLaneMetrics {
  active: number;
  peak: number;
  admitted: number;
  rejected: number;
  retainedBytes: number;
}
export function sessionLaneMetrics(): SessionLaneMetrics {
  return {
    active: activeSessionLaneRefCounts.size,
    peak: sessionLanePeak,
    admitted: sessionLaneAdmitted,
    rejected: sessionLaneRejected,
    retainedBytes: activeSessionLaneRefCounts.size * SESSION_LANE_ID_BYTES,
  };
}
export function getNativeMainProfileRequestCount(): number {
  return nativeMainSelections + nativeMainTurns.size;
}
export function activeRegistryMetrics(): Record<string, AdmissionMetrics> {
  const turns = turnGate.metrics();
  return {
    activeTurns: { ...turns, releaseMisses: turns.releaseMisses + turnReleaseMisses },
    codexWebSockets: codexWebSocketAdmissionMetrics(),
    cursorBackgroundShells: backgroundShellAdmissionMetrics(),
    storageHomeSlots: storageMutationAdmissionMetrics(),
    storageWorkerReservations: storageWorkerAdmissionMetrics(),
  };
}

export function abortAndReleaseAllTurns(reason: unknown = new Error("server shutdown")): void {
  const owners = [...admittedTurns];
  for (const owner of owners) {
    const controllers = [...activeTurns].filter(([, lease]) => lease === owner).map(([controller]) => controller);
    for (const controller of controllers) controller.abort(reason);
    owner.release();
  }
}
/** Live listen port of the Bun server, when started. */
export function getServerListenPort(): number | undefined {
  const port = _serverRef?.port;
  return typeof port === "number" && port > 0 ? port : undefined;
}

/**
 * Stop one concrete listener exactly once. Deadline restart handoff can race the
 * ordinary drain's finally block; both callers must observe the same stop result
 * before any replacement process is allowed to bind the port.
 */
/**
 * Run every shutdown step, then report whether any of them failed.
 *
 * Extracted from `startServer`'s composite `stop` because the two properties it has to hold
 * pull in opposite directions and neither is testable in place:
 *
 * - Cleanup COMPLETES. A listener whose stop rejects cannot prevent the other listener, or the
 *   native lifecycle release, from running.
 * - Failure PROPAGATES. `stopServerListener` deliberately surfaces a stop rejection so every
 *   caller sees the same result before a replacement binds the port. Swallowing it would let
 *   `drainAndShutdown` report success while a socket is still held.
 *
 * `always` runs after the listeners regardless of their outcome, and its own failure joins the
 * reported set rather than replacing it.
 */
export async function runListenerShutdown(
  steps: Array<() => Promise<void>>,
  always: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await always();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "listener shutdown failed");
}

export function stopServerListener(
  server: ReturnType<typeof Bun.serve> | undefined = _serverRef,
): Promise<void> {
  if (!server) return Promise.resolve();
  const existing = serverStopFlights.get(server);
  if (existing) return existing;
  // Bun's Server.stop returns Promise<void>; fire-and-forget races a
  // follow-on listen and can leave the replacement seeing the old proxy.
  const flight = Promise.resolve().then(() => server.stop(true));
  serverStopFlights.set(server, flight);
  return flight;
}

/** Native-main startup ownership cleanup, separate from the listen socket flight. */
export function releaseServerStartupLifecycle(
  server: ReturnType<typeof Bun.serve> | undefined = _serverRef,
): Promise<void> {
  if (!server) return Promise.resolve();
  const existing = serverStartupReleaseFlights.get(server);
  if (existing) return existing;
  const flight = Promise.resolve().then(() => releaseServerStartupLifecycleImpl(server));
  serverStartupReleaseFlights.set(server, flight);
  return flight;
}

/** Test seam for a held/rejected startup lifecycle release. */
export function setServerStartupLifecycleReleaseForTests(
  release: typeof releaseNativeMainStartupLifecycle | undefined,
): void {
  releaseServerStartupLifecycleImpl = release ?? releaseNativeMainStartupLifecycle;
  serverStartupReleaseFlights = new WeakMap<ReturnType<typeof Bun.serve>, Promise<void>>();
}
/**
 * Mark this process as a recycle (dashboard drain-and-restart). Exit cleanup
 * must keep Codex/Grok/system-env injection so the replacement process inherits
 * a working fence — unlike an intentional `ocx stop` teardown.
 */
export function markRecyclingForExit(): void { recyclingForExit = true; }
export function isRecyclingForExit(): boolean { return recyclingForExit; }

export function trackStreamLifetime(
  body: ReadableStream<Uint8Array>,
  ac: AbortController,
  onDone?: () => void,
  lease?: AdmissionLease,
): ReadableStream<Uint8Array> {
  registerTurn(ac, lease);
  const reader = body.getReader();
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    unregisterTurn(ac);
    onDone?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { finish(); controller.close(); return; }
        controller.enqueue(value);
      } catch (err) {
        finish();
        try { controller.error(err); } catch { /* already closed */ }
      }
    },
    cancel(reason) {
      finish();
      ac.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

export async function drainAndShutdown(
  server: ReturnType<typeof Bun.serve> | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const s = server ?? _serverRef;
  let shutdownSucceeded = true;
  // One absolute budget covers both a pre-existing scoped profile drain and
  // ordinary in-flight turns. A stuck scoped owner must not pin shutdown forever.
  const deadline = Date.now() + Math.max(0, timeoutMs);
  beginShutdownDrain();
  const temporaryDrainsSettled = await waitForTemporaryDrainsUntil(deadline);
  if (!temporaryDrainsSettled) {
    console.warn("Temporary drain lease did not settle before the shutdown deadline; forcing shutdown");
  }
  beginBackgroundShellShutdown();
  try {
    while (admittedTurns.size > 0 && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    if (admittedTurns.size > 0) {
      console.warn(`⚠️  Aborting ${admittedTurns.size} in-flight turn(s) after ${timeoutMs}ms deadline`);
      abortAndReleaseAllTurns(new Error("server shutdown"));
    }

    const shellDrain = await Promise.allSettled([terminateAllBackgroundShells()]);
    const shellResult = shellDrain[0]!;
    if (shellResult.status === "rejected") {
      console.warn("[cursor] background shell drain failed", { rejected: 1 });
    } else if (shellResult.value.unresolved > 0 || shellResult.value.killFailures > 0) {
      console.warn("[cursor] background shell drain incomplete", shellResult.value);
    }

    // Debounced replay-state snapshots may still be pending; flush so the last completed turn's
    // previous_response_id chain and antigravity thought signatures survive the restart this
    // shutdown is usually part of.
    const stateFlush = await Promise.allSettled([flushResponseState(), flushAntigravityReplay()]);
    if (stateFlush[0]?.status === "rejected") {
      shutdownSucceeded = false;
      console.warn("[responses] state flush during shutdown failed");
    }
    if (stateFlush[1]?.status === "rejected") {
      shutdownSucceeded = false;
      console.warn("[antigravity] replay flush during shutdown failed");
    }

    // Tear down opt-in storage policy timers / worker / live-config sink so they cannot fire after stop.
    // Await worker thread exit: on Windows, a still-exiting Bun Worker under
    // `bun test --isolate` panics the whole process at the next realm reclaim.
    // Abort each job independently so one wedged join cannot skip the other,
    // then drain leftovers; failures must not prevent `server.stop`.
    stopStorageCleanupScheduler();
    // Optional subsystems (Compatibility Lab today, anything added later) tear themselves
    // down through hooks registered at activation. A process that never activated one runs
    // nothing here and never loads its module graph.
    runOptionalShutdownHooks();
    stopStateStoreSweeper();
    // The overlay reconciler is owner-scoped: the startServer stop override
    // releases THIS server's lease through runListenerShutdown →
    // userCostOverlayReconciler.stop(), which also recomputes disk-only
    // preservation for any remaining owners. A process-wide stop here would
    // kill reconciliation for every other server in the process, so drain
    // must not call stopUserCostOverlayReconciler().
    cancelQueuedStorageWorkerSpawns();
    const shutdownJoins = await Promise.allSettled([
      abortStorageCleanupPolicyJobAsync(),
      abortRestoreTrashJobAsync(),
    ]);
    for (const result of shutdownJoins) {
      if (result.status === "rejected") {
        console.warn(
          "[storage] worker abort during shutdown failed:",
          result.reason instanceof Error ? result.reason.message : result.reason,
        );
      }
    }
    try {
      await drainStorageWorkers();
    } catch (err) {
      console.warn(
        "[storage] worker drain during shutdown failed:",
        err instanceof Error ? err.message : err,
      );
    }
    setStorageCleanupPolicyLiveSink(null);
    setStorageCleanupPolicyJobLiveApply(null);
  } finally {
    try {
      await stopServerListener(s);
    } finally {
      await releaseServerStartupLifecycle(s);
      // shutdownDraining is a process-lifetime latch. A stopped server must
      // never resume admission merely because shutdown cleanup returned.
    }
  }
  return shutdownSucceeded;
}
