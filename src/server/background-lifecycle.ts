import type { StorageCleanupPolicy } from "../types";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { getActiveTurnCount } from "./lifecycle";
import { responseStateMetrics } from "../responses/state";
import { startStateStoreSweeper } from "../lib/state-store-sweeper";
import {
  abortStorageCleanupPolicyJobAsync,
  setStorageCleanupPolicyJobLiveApply,
} from "../storage/policy-job";
import { setStorageCleanupPolicyLiveSink } from "../storage/policy";
import {
  scheduleStorageCleanupStartupRun,
  startStorageCleanupScheduler,
  stopStorageCleanupScheduler,
} from "../storage/policy-scheduler";
import { startQuotaResetPoller, stopQuotaResetPoller } from "../quota/reset-poller";
import {
  startCatalogAutoRefresh,
  stopCatalogAutoRefresh,
  syncCatalogAutoRefreshCadence,
} from "../codex/catalog-auto-refresh";
import {
  cancelQueuedStorageWorkerSpawns,
  drainStorageWorkers,
} from "../storage/worker-lifecycle";
import {
  acquireServerResourceOwner,
  type ServerResourceOwnerLease,
} from "../lib/server-resource-ownership";
import {
  startMemoryWatchdog,
  type MemoryWatchdog,
} from "./memory-watchdog";

type PolicyApply = (policy: StorageCleanupPolicy) => void;

type RecorderHandle = { stop(): void };

type ProcessLoops = {
  diagnostics: RecorderHandle | null;
  memoryWatchdog: MemoryWatchdog | null;
  stateStoreSweeper: ReturnType<typeof startStateStoreSweeper> | null;
};

type LeaseOwner = {
  token: symbol;
  applyPolicy: PolicyApply;
  resources: ServerResourceOwnerLease;
};

export type ServerBackgroundLifecycleLease = {
  scheduleStartupRun(): void;
  release(): Promise<void>;
  releaseAfterFailedStart(): void;
};

const owners: LeaseOwner[] = [];
let processLoops: ProcessLoops | null = null;
let cleanupInProgress = false;

function setLivePolicyOwner(applyPolicy: PolicyApply | null): void {
  setStorageCleanupPolicyLiveSink(applyPolicy);
  setStorageCleanupPolicyJobLiveApply(applyPolicy);
}

function startProcessLoops(applyPolicy: PolicyApply): ProcessLoops {
  const loops: ProcessLoops = { diagnostics: null, memoryWatchdog: null, stateStoreSweeper: null };
  try {
    loops.memoryWatchdog = startMemoryWatchdog();
    if (process.env.OPENCODEX_RUNTIME_DIAGNOSTICS === "1") {
      // Opt-in, and loaded only when it is opted in. The one thing that opts in today is
      // scripts/windows-visible-proxy.ps1 (the desktop launcher, where an event-loop stall is
      // a frozen window), so no other install pays for the recorder or its child process.
      void import("../lib/runtime-diagnostics").then(module => module.startRuntimeDiagnostics(
        join(getConfigDir(), "runtime-diagnostics.jsonl"),
        () => {
          const turns = getActiveTurnCount();
          const state = turns > 0 ? responseStateMetrics() : null;
          return { activeTurns: turns, responseBytes: state?.totalBytes ?? null,
            spillWrites: state?.spillWrites ?? null, spillFailures: state?.spillWriteFailures ?? null,
            spillTimeoutRefusals: state?.spillAclTimeoutMemoRefusals ?? null };
        },
      )).then(recorder => {
        // The identity check is the teardown race: if these loops were replaced or rolled
        // back while the module loaded, the recorder has no owner and stops itself.
        if (processLoops === loops) loops.diagnostics = recorder;
        else recorder.stop();
      }).catch(() => console.warn("[runtime-diagnostics] recorder could not start"));
    }
    loops.stateStoreSweeper = startStateStoreSweeper();
    setLivePolicyOwner(applyPolicy);
    startStorageCleanupScheduler();
    // Opt-in: the tick itself is a no-op unless config.quotaResetNotify is enabled with a
    // sink, and the interval is unref'd, so a default install pays one dormant timer.
    startQuotaResetPoller();
    // The configured cadence is resolved out of band: reading it here would put a static edge
    // to the config barrel on the load-time path the quota boundary guard pins.
    void import("../quota/reset-poller")
      .then(poller => poller.syncQuotaResetPollerCadence())
      .catch(() => {
        // The next tick adopts it.
      });
    // Opt-in: the tick is a no-op unless catalogAutoRefresh.enabled is true, and the
    // interval is unref'd, so a default install pays one dormant timer. The scheduler
    // module keeps every heavy import inside its tick, so naming it statically here
    // costs a module record and nothing else.
    startCatalogAutoRefresh();
    // The scheduler starts at its default cadence because resolving the operator's value
    // reads the config barrel. Fire-and-forget: startup must not await an optional
    // subsystem, and the next tick adopts the cadence anyway.
    void syncCatalogAutoRefreshCadence().catch(() => {
      // The next tick adopts it.
    });
    // Install the delivery sink now rather than waiting out the first poll interval, which is 15
    // minutes by default. Without this, an enabled install would observe nothing for its first
    // quarter hour — including the live request path, which is gated on the sink existing.
    // Fire-and-forget: startup must not await an optional subsystem.
    void import("../quota/reset-activation")
      .then(activation => activation.syncQuotaResetActivation())
      .catch(() => {
        // The next poll tick retries.
      });
    return loops;
  } catch (error) {
    loops.diagnostics?.stop();
    loops.memoryWatchdog?.stop();
    loops.stateStoreSweeper?.stop();
    stopStorageCleanupScheduler();
    stopQuotaResetPoller();
    stopCatalogAutoRefresh();
    setLivePolicyOwner(null);
    throw error;
  }
}

function stopProcessLoops(): void {
  const loops = processLoops;
  processLoops = null;
  loops?.diagnostics?.stop();
  loops?.memoryWatchdog?.stop();
  loops?.stateStoreSweeper?.stop();
  stopStorageCleanupScheduler();
  stopQuotaResetPoller();
  stopCatalogAutoRefresh();
  setLivePolicyOwner(null);
}

async function stopStoragePolicyWorker(): Promise<void> {
  cancelQueuedStorageWorkerSpawns();
  const abortResult = await Promise.allSettled([abortStorageCleanupPolicyJobAsync()]);
  if (abortResult[0]?.status === "rejected") {
    console.warn(
      "[storage] policy worker abort during server stop failed:",
      abortResult[0].reason instanceof Error
        ? abortResult[0].reason.message
        : abortResult[0].reason,
    );
  }
  try {
    await drainStorageWorkers();
  } catch (error) {
    console.warn(
      "[storage] worker drain during server stop failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

function removeOwner(owner: LeaseOwner): boolean {
  const index = owners.findIndex(candidate => candidate.token === owner.token);
  if (index === -1) return false;
  owners.splice(index, 1);
  return true;
}

function releaseOwnerSynchronously(owner: LeaseOwner): "inactive" | "shared" | "last" {
  if (!removeOwner(owner)) return "inactive";
  owner.resources.release();
  const nextOwner = owners.at(-1);
  if (nextOwner) {
    setLivePolicyOwner(nextOwner.applyPolicy);
    return "shared";
  }
  stopProcessLoops();
  return "last";
}

/**
 * Acquire one server's lease on process-wide singleton loops.
 *
 * The first live server starts the loops. Later servers only add a reference and
 * become the current policy sink; out-of-order release restores the newest
 * remaining sink. The final release owns timer and Worker teardown. Resources
 * registered while this server starts are released with this exact lease.
 */
export function acquireServerBackgroundLifecycle(
  applyPolicy: PolicyApply,
): ServerBackgroundLifecycleLease {
  if (cleanupInProgress) {
    throw new Error("server background lifecycle cleanup is still in progress");
  }

  const owner: LeaseOwner = {
    token: Symbol("server-background-lifecycle"),
    applyPolicy,
    resources: acquireServerResourceOwner(),
  };
  try {
    if (!processLoops) {
      processLoops = startProcessLoops(applyPolicy);
    } else {
      setLivePolicyOwner(applyPolicy);
    }
    owners.push(owner);
  } catch (error) {
    owner.resources.release();
    throw error;
  }

  let releaseFlight: Promise<void> | null = null;
  return {
    scheduleStartupRun() {
      if (owners.some(candidate => candidate.token === owner.token)) {
        scheduleStorageCleanupStartupRun();
      }
    },
    release() {
      if (releaseFlight) return releaseFlight;
      const outcome = releaseOwnerSynchronously(owner);
      if (outcome !== "last") {
        releaseFlight = Promise.resolve();
        return releaseFlight;
      }
      cleanupInProgress = true;
      releaseFlight = stopStoragePolicyWorker().finally(() => {
        cleanupInProgress = false;
      });
      return releaseFlight;
    },
    releaseAfterFailedStart() {
      if (releaseFlight) return;
      // Startup evaluation is scheduled only after both listeners bind, so a
      // failed start cannot have spawned a Worker for this lease. Keep rollback
      // synchronous so a caller may immediately retry a different port.
      releaseOwnerSynchronously(owner);
      releaseFlight = Promise.resolve();
    },
  };
}
