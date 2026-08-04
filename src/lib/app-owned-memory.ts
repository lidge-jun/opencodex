export type AppOwnedRetainedCategory = "logs" | "caches" | "blobs" | "continuation";
export type AppOwnedObservedCategory = "translator" | "serialized_tails";

export interface RetainedStoreSnapshot {
  count: number;
  bytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  oldestAt: number | null;
}

export interface RetainedStoreRegistration {
  id: string;
  category: AppOwnedRetainedCategory;
  snapshot(): RetainedStoreSnapshot;
  evictOldest(): number;
}

export interface ObservedBufferRegistration {
  id: string;
  category: AppOwnedObservedCategory;
  snapshot(): { currentBytes: number; highWaterBytes: number; active: number };
}

export interface AppOwnedBytesSnapshot {
  budgetBytes: number;
  retainedBytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  overBudgetBytes: number;
  stores: Record<string, RetainedStoreSnapshot>;
  observedInFlight: Record<string, { currentBytes: number; highWaterBytes: number; active: number }>;
  enforcement: {
    runs: number;
    entriesDemoted: number;
    bytesReleased: number;
    noEvictableCandidate: number;
    snapshotFailures: number;
    oldestAtContractViolations: number;
  };
}

export const DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;
/**
 * The budget above is an eviction target, not a hard resident limit: active/pinned
 * state may temporarily keep retained bytes above it. Every pin-capable owner has
 * its own finite admission cap; their documented aggregate must remain below this
 * process-owned hard ceiling.
 */
export const APP_OWNED_WORST_CASE_PINNED_BYTES = 512 * 1024 * 1024;
export const MIN_APP_OWNED_MEMORY_BUDGET_MB = 64;
export const MAX_APP_OWNED_MEMORY_BUDGET_MB = 4_096;

const CATEGORY_ORDER: readonly AppOwnedRetainedCategory[] = [
  "logs",
  "caches",
  "blobs",
  "continuation",
];
const WARN_INTERVAL_MS = 60_000;
const ZERO_RETAINED_SNAPSHOT: RetainedStoreSnapshot = {
  count: 0,
  bytes: 0,
  evictableBytes: 0,
  pinnedBytes: 0,
  oldestAt: null,
};
const ZERO_OBSERVED_SNAPSHOT = { currentBytes: 0, highWaterBytes: 0, active: 0 };

const retainedStores = new Map<string, RetainedStoreRegistration>();
const observedBuffers = new Map<string, ObservedBufferRegistration>();
let budgetBytes = DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES;
let lastSaturationWarningAt = Number.NEGATIVE_INFINITY;
const enforcementCounters = {
  runs: 0,
  entriesDemoted: 0,
  bytesReleased: 0,
  noEvictableCandidate: 0,
  snapshotFailures: 0,
  oldestAtContractViolations: 0,
};
let isEnforcing = false;

export function resolveAppOwnedMemoryBudgetBytes(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_APP_OWNED_MEMORY_BUDGET_MB
    && value <= MAX_APP_OWNED_MEMORY_BUDGET_MB
    ? value * 1024 * 1024
    : DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES;
}

export function registerRetainedStore(registration: RetainedStoreRegistration): () => void {
  retainedStores.set(registration.id, registration);
  return () => {
    if (retainedStores.get(registration.id) === registration) retainedStores.delete(registration.id);
  };
}

export function registerObservedBuffer(registration: ObservedBufferRegistration): () => void {
  observedBuffers.set(registration.id, registration);
  return () => {
    if (observedBuffers.get(registration.id) === registration) observedBuffers.delete(registration.id);
  };
}

export function configureAppOwnedMemoryBudget(bytes: number): void {
  budgetBytes = bytes;
}

function retainedSnapshot(registration: RetainedStoreRegistration): RetainedStoreSnapshot {
  try {
    return registration.snapshot();
  } catch {
    enforcementCounters.snapshotFailures += 1;
    return { ...ZERO_RETAINED_SNAPSHOT };
  }
}

function observedSnapshot(
  registration: ObservedBufferRegistration,
): { currentBytes: number; highWaterBytes: number; active: number } {
  try {
    return registration.snapshot();
  } catch {
    enforcementCounters.snapshotFailures += 1;
    return { ...ZERO_OBSERVED_SNAPSHOT };
  }
}

export function appOwnedBytesSnapshot(): AppOwnedBytesSnapshot {
  return appOwnedBytesSnapshotFrom(retainedSnapshots().stores);
}

function appOwnedBytesSnapshotFrom(
  retained: ReadonlyMap<string, RetainedStoreSnapshot>,
): AppOwnedBytesSnapshot {
  const stores: Record<string, RetainedStoreSnapshot> = {};
  let retainedBytes = 0;
  let evictableBytes = 0;
  let pinnedBytes = 0;
  for (const registration of retainedStores.values()) {
    const snapshot = retained.get(registration.id) ?? ZERO_RETAINED_SNAPSHOT;
    stores[registration.id] = snapshot;
    retainedBytes += snapshot.bytes;
    evictableBytes += snapshot.evictableBytes;
    pinnedBytes += snapshot.pinnedBytes;
  }

  const observedInFlight: AppOwnedBytesSnapshot["observedInFlight"] = {};
  for (const registration of observedBuffers.values()) {
    observedInFlight[registration.id] = observedSnapshot(registration);
  }

  return {
    budgetBytes,
    retainedBytes,
    evictableBytes,
    pinnedBytes,
    overBudgetBytes: Math.max(0, retainedBytes - budgetBytes),
    stores,
    observedInFlight,
    enforcement: { ...enforcementCounters },
  };
}

function nextCandidate(
  snapshots: ReadonlyMap<string, RetainedStoreSnapshot>,
  ineligible: Set<string>,
): RetainedStoreRegistration | undefined {
  for (const category of CATEGORY_ORDER) {
    let candidate: RetainedStoreRegistration | undefined;
    let candidateAt = Number.POSITIVE_INFINITY;
    for (const registration of retainedStores.values()) {
      if (registration.category !== category || ineligible.has(registration.id)) continue;
      const snapshot = snapshots.get(registration.id);
      if (!snapshot || snapshot.evictableBytes <= 0) continue;
      const oldestAt = snapshot.oldestAt;
      if (oldestAt === null || !Number.isFinite(oldestAt)) {
        enforcementCounters.oldestAtContractViolations += 1;
        ineligible.add(registration.id);
        continue;
      }
      if (!candidate || oldestAt < candidateAt) {
        candidate = registration;
        candidateAt = oldestAt;
      }
    }
    if (candidate) return candidate;
  }
  return undefined;
}

function retainedSnapshots(): { total: number; stores: Map<string, RetainedStoreSnapshot> } {
  const stores = new Map<string, RetainedStoreSnapshot>();
  let total = 0;
  for (const registration of retainedStores.values()) {
    const snapshot = retainedSnapshot(registration);
    stores.set(registration.id, snapshot);
    total += snapshot.bytes;
  }
  return { total, stores };
}

function warnPinnedSaturation(): void {
  const at = Date.now();
  if (at - lastSaturationWarningAt < WARN_INTERVAL_MS) return;
  lastSaturationWarningAt = at;
  console.warn("[app-owned-memory] retained state remains over budget with no evictable candidate");
}

export function enforceAppOwnedMemoryBudget(): AppOwnedBytesSnapshot {
  if (isEnforcing) return appOwnedBytesSnapshot();
  isEnforcing = true;
  enforcementCounters.runs += 1;
  try {
    const ineligible = new Set<string>();
    const current = retainedSnapshots();
    while (current.total > budgetBytes) {
      const candidate = nextCandidate(current.stores, ineligible);
      if (!candidate) {
        enforcementCounters.noEvictableCandidate += 1;
        warnPinnedSaturation();
        break;
      }

      let reportedReleased = 0;
      try {
        reportedReleased = candidate.evictOldest();
      } catch {
        ineligible.add(candidate.id);
        continue;
      }
      const previousSnapshot = current.stores.get(candidate.id) ?? ZERO_RETAINED_SNAPSHOT;
      const nextSnapshot = retainedSnapshot(candidate);
      current.stores.set(candidate.id, nextSnapshot);
      const nextTotal = Math.max(0, current.total - previousSnapshot.bytes + nextSnapshot.bytes);
      const actualReleased = Math.max(0, current.total - nextTotal);
      if (reportedReleased <= 0 || actualReleased <= 0) {
        ineligible.add(candidate.id);
      } else {
        enforcementCounters.entriesDemoted += 1;
        enforcementCounters.bytesReleased += actualReleased;
      }
      current.total = nextTotal;
    }
    return appOwnedBytesSnapshotFrom(current.stores);
  } finally {
    isEnforcing = false;
  }
}

export function resetAppOwnedMemoryForTests(): void {
  retainedStores.clear();
  observedBuffers.clear();
  budgetBytes = DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES;
  lastSaturationWarningAt = Number.NEGATIVE_INFINITY;
  enforcementCounters.runs = 0;
  enforcementCounters.entriesDemoted = 0;
  enforcementCounters.bytesReleased = 0;
  enforcementCounters.noEvictableCandidate = 0;
  enforcementCounters.snapshotFailures = 0;
  enforcementCounters.oldestAtContractViolations = 0;
  isEnforcing = false;
}
