const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_RECOVERIES = 32;
const CACHE_TTL_MS = 15 * 60 * 1000;

export type AgentTaskRecoveryResolutionFailureReason =
  | "recovery_unavailable"
  | "caller_cancelled"
  | "recovery_http_rejected"
  | "recovery_timeout"
  | "recovery_aborted"
  | "recovery_transport_error"
  | "recovery_invalid_output";

/** Shared flights carry bounded failures; only successful plaintext enters the cache. */
export type AgentTaskRecoveryResolution =
  | { readonly recovered: true; readonly assignment: string }
  | { readonly recovered: false; readonly reason: AgentTaskRecoveryResolutionFailureReason };

interface RecoveryCacheEntry {
  assignment: string;
  bytes: number;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

interface RecoveryFlight {
  controller: AbortController;
  promise: Promise<AgentTaskRecoveryResolution>;
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
  request: (signal: AbortSignal) => Promise<AgentTaskRecoveryResolution>,
): RecoveryFlight | null {
  const active = RECOVERY_FLIGHTS.get(key);
  if (active) return active;
  if (RECOVERY_FLIGHTS.size >= MAX_CONCURRENT_RECOVERIES) return null;

  const controller = new AbortController();
  const flight: RecoveryFlight = {
    controller,
    promise: Promise.resolve({ recovered: false, reason: "recovery_unavailable" }),
    waiters: 0,
    settled: false,
  };
  flight.promise = request(controller.signal)
    .then((result): AgentTaskRecoveryResolution => {
      if (controller.signal.aborted) return { recovered: false, reason: "recovery_aborted" };
      if (result.recovered) insertRecoveryCacheEntry(key, result.assignment, maxEntries);
      return result;
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
): Promise<AgentTaskRecoveryResolution> {
  if (abortSignal?.aborted) return { recovered: false, reason: "caller_cancelled" };
  flight.waiters += 1;
  let onAbort: (() => void) | undefined;
  try {
    if (!abortSignal) return await flight.promise;
    const cancelled = new Promise<AgentTaskRecoveryResolution>((resolve) => {
      onAbort = () => resolve({ recovered: false, reason: "caller_cancelled" });
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
  const result = await resolveCachedAgentTaskRecoveryWithResult(key, maxEntries, async signal => {
    const assignment = await request(signal);
    return assignment
      ? { recovered: true, assignment }
      : { recovered: false, reason: "recovery_unavailable" };
  }, abortSignal);
  return result.recovered ? result.assignment : null;
}

export async function resolveCachedAgentTaskRecoveryWithResult(
  key: string,
  maxEntries: number,
  request: (signal: AbortSignal) => Promise<AgentTaskRecoveryResolution>,
  abortSignal?: AbortSignal,
): Promise<AgentTaskRecoveryResolution> {
  if (abortSignal?.aborted) return { recovered: false, reason: "caller_cancelled" };
  sweepRecoveryCache(Date.now(), maxEntries);
  const cached = RECOVERY_CACHE.get(key)?.assignment;
  if (cached) return { recovered: true, assignment: cached };
  const flight = startRecoveryFlight(key, maxEntries, request);
  return flight ? waitForRecoveryFlight(flight, abortSignal) : { recovered: false, reason: "recovery_unavailable" };
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

/** Read an existing recovery without starting a request or extending its lifetime. */
export function cachedAgentTaskRecovery(key: string): string | null {
  const entry = RECOVERY_CACHE.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    deleteRecoveryCacheEntry(key, entry);
    return null;
  }
  return entry.assignment;
}
