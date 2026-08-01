import { flushResponseState } from "../responses/state";
import { setStorageCleanupPolicyLiveSink } from "../storage/policy";
import {
  abortStorageCleanupPolicyJobAsync,
  setStorageCleanupPolicyJobLiveApply,
} from "../storage/policy-job";
import { abortRestoreTrashJobAsync } from "../storage/restore-job";
import { stopStorageCleanupScheduler } from "../storage/policy-scheduler";
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

// ---------------------------------------------------------------------------
// Active turn tracking + graceful shutdown drain
// ---------------------------------------------------------------------------

export const MAX_ACTIVE_TURNS = 256;
const turnGate = createAdmissionGate("active_turns", MAX_ACTIVE_TURNS);
export interface ActiveTurnLease extends AdmissionLease {
  bindAbortController(ac: AbortController): void;
  isTransferred(): boolean;
}
const activeTurns = new Map<AbortController, ActiveTurnLease>();
const admittedTurns = new Set<ActiveTurnLease>();
const knownTurnControllers = new WeakSet<AbortController>();
let turnReleaseMisses = 0;
let draining = false;
let recyclingForExit = false;
let _serverRef: ReturnType<typeof Bun.serve> | undefined;

export function setServerRef(server: ReturnType<typeof Bun.serve> | undefined): void { _serverRef = server; }
export function setDraining(value: boolean): void { draining = value; }
export function tryAdmitTurn(): ActiveTurnLease | null {
  const gateLease = turnGate.tryAcquire();
  if (!gateLease) return null;
  const controllers = new Set<AbortController>();
  let active = true;
  let transferred = false;
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
    isTransferred() { return transferred; },
    release() {
      if (!active) return;
      active = false;
      admittedTurns.delete(lease);
      for (const controller of controllers) {
        if (activeTurns.get(controller) === lease) activeTurns.delete(controller);
      }
      controllers.clear();
      gateLease.release();
    },
  };
  admittedTurns.add(lease);
  return lease;
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
export function isDraining(): boolean { return draining; }
export function getActiveTurnCount(): number { return turnGate.metrics().active; }
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
): Promise<void> {
  const s = server ?? _serverRef;
  draining = true;
  beginBackgroundShellShutdown();
  try {
    const deadline = Date.now() + timeoutMs;
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

    // Debounced replay-state snapshot may still be pending; flush so the last completed turn's
    // previous_response_id chain survives the restart this shutdown is usually part of.
    const responseStateFlush = await Promise.allSettled([flushResponseState()]);
    if (responseStateFlush[0]?.status === "rejected") {
      console.warn("[responses] state flush during shutdown failed");
    }

    // Tear down opt-in storage policy timers / worker / live-config sink so they cannot fire after stop.
    // Await worker thread exit: on Windows, a still-exiting Bun Worker under
    // `bun test --isolate` panics the whole process at the next realm reclaim.
    // Abort each job independently so one wedged join cannot skip the other,
    // then drain leftovers; failures must not prevent `server.stop`.
    stopStorageCleanupScheduler();
    stopStateStoreSweeper();
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
      s?.stop(true);
    } finally {
      draining = false;
    }
  }
}
