const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_RECOVERIES = 32;
const CACHE_TTL_MS = 15 * 60 * 1000;

interface RecoveryCacheEntry {
  assignment: string;
  bytes: number;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

interface RecoveryFlight {
  controller: AbortController;
  promise: Promise<string | null>;
  waiters: number;
  settled: boolean;
}

const RECOVERY_CACHE = new Map<string, RecoveryCacheEntry>();
const RECOVERY_FLIGHTS = new Map<string, RecoveryFlight>();
let recoveryCacheBytes = 0;

function deleteRecoveryCacheEntry(key: string, expected?: RecoveryCacheEntry): void {
  const entry = RECOVERY_CACHE.get(key);
  if (!entry || (expected && entry !== expected)) return;
  RECOVERY_CACHE.delete(key);
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  recoveryCacheBytes = Math.max(0, recoveryCacheBytes - entry.bytes);
}

function sweepRecoveryCache(now: number, maxEntries: number): void {
  for (const [key, entry] of RECOVERY_CACHE) {
    if (entry.expiresAt > now) continue;
    deleteRecoveryCacheEntry(key, entry);
  }
  while (RECOVERY_CACHE.size > maxEntries || recoveryCacheBytes > MAX_CACHE_BYTES) {
    const oldest = RECOVERY_CACHE.keys().next().value;
    if (oldest === undefined) break;
    deleteRecoveryCacheEntry(oldest);
  }
}

function insertRecoveryCacheEntry(key: string, assignment: string, maxEntries: number): void {
  const replaced = RECOVERY_CACHE.get(key);
  if (replaced) deleteRecoveryCacheEntry(key, replaced);
  const insertedAt = Date.now();
  const entry: RecoveryCacheEntry = {
    assignment,
    bytes: Buffer.byteLength(assignment),
    expiresAt: insertedAt + CACHE_TTL_MS,
    expiryTimer: null,
  };
  entry.expiryTimer = setTimeout(
    () => deleteRecoveryCacheEntry(key, entry),
    CACHE_TTL_MS,
  );
  entry.expiryTimer.unref?.();
  RECOVERY_CACHE.set(key, entry);
  recoveryCacheBytes += entry.bytes;
  sweepRecoveryCache(insertedAt, maxEntries);
}

function startRecoveryFlight(
  key: string,
  maxEntries: number,
  request: (signal: AbortSignal) => Promise<string | null>,
): RecoveryFlight | null {
  const active = RECOVERY_FLIGHTS.get(key);
  if (active) return active;
  if (RECOVERY_FLIGHTS.size >= MAX_CONCURRENT_RECOVERIES) return null;

  const controller = new AbortController();
  const flight: RecoveryFlight = {
    controller,
    promise: Promise.resolve(null),
    waiters: 0,
    settled: false,
  };
  flight.promise = request(controller.signal)
    .then((assignment) => {
      if (!assignment || controller.signal.aborted) return null;
      insertRecoveryCacheEntry(key, assignment, maxEntries);
      return assignment;
    })
    .finally(() => {
      flight.settled = true;
      if (RECOVERY_FLIGHTS.get(key) === flight) RECOVERY_FLIGHTS.delete(key);
    });
  RECOVERY_FLIGHTS.set(key, flight);
  return flight;
}

async function waitForRecoveryFlight(
  flight: RecoveryFlight,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (abortSignal?.aborted) return null;
  flight.waiters += 1;
  let onAbort: (() => void) | undefined;
  try {
    if (!abortSignal) return await flight.promise;
    const cancelled = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    });
    return await Promise.race([flight.promise, cancelled]);
  } finally {
    if (onAbort) abortSignal?.removeEventListener("abort", onAbort);
    flight.waiters = Math.max(0, flight.waiters - 1);
    if (flight.waiters === 0 && !flight.settled) {
      flight.controller.abort(new DOMException("All recovery callers cancelled", "AbortError"));
    }
  }
}

export async function resolveCachedAgentTaskRecovery(
  key: string,
  maxEntries: number,
  request: (signal: AbortSignal) => Promise<string | null>,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (abortSignal?.aborted) return null;
  sweepRecoveryCache(Date.now(), maxEntries);
  const cached = RECOVERY_CACHE.get(key)?.assignment;
  if (cached) return cached;
  const flight = startRecoveryFlight(key, maxEntries, request);
  return flight ? waitForRecoveryFlight(flight, abortSignal) : null;
}

export function discardCachedAgentTaskRecovery(key: string): void {
  deleteRecoveryCacheEntry(key);
}

export function resetAgentTaskRecoveryCache(): void {
  for (const flight of RECOVERY_FLIGHTS.values()) {
    flight.controller.abort(new DOMException("Recovery state reset", "AbortError"));
  }
  RECOVERY_FLIGHTS.clear();
  for (const key of [...RECOVERY_CACHE.keys()]) deleteRecoveryCacheEntry(key);
}

export function agentTaskRecoveryWaiterCountForTests(): number {
  let count = 0;
  for (const flight of RECOVERY_FLIGHTS.values()) count += flight.waiters;
  return count;
}

export function agentTaskRecoveryCacheSnapshotForTests(): { entries: number; bytes: number } {
  return { entries: RECOVERY_CACHE.size, bytes: recoveryCacheBytes };
}
