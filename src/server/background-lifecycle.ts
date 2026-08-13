import type { StorageCleanupPolicy } from "../types";
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

type ProcessLoops = {
  memoryWatchdog: MemoryWatchdog;
  stateStoreSweeper: ReturnType<typeof startStateStoreSweeper>;
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
  let memoryWatchdog: MemoryWatchdog | null = null;
  let stateStoreSweeper: ReturnType<typeof startStateStoreSweeper> | null = null;
  try {
    memoryWatchdog = startMemoryWatchdog();
    stateStoreSweeper = startStateStoreSweeper();
    setLivePolicyOwner(applyPolicy);
    startStorageCleanupScheduler();
    return { memoryWatchdog, stateStoreSweeper };
  } catch (error) {
    memoryWatchdog?.stop();
    stateStoreSweeper?.stop();
    stopStorageCleanupScheduler();
    setLivePolicyOwner(null);
    throw error;
  }
}

function stopProcessLoops(): void {
  const loops = processLoops;
  processLoops = null;
  loops?.memoryWatchdog.stop();
  loops?.stateStoreSweeper.stop();
  stopStorageCleanupScheduler();
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