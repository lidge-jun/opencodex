/**
 * Provider-origin reachability health and the optional logical-request circuit.
 *
 * Issue #914 owns the observational ledger. The circuit is deliberately opt-in:
 * a threshold of 0 preserves the ledger-only behavior. Only proven
 * `connect_neutral` failures may settle a lease as host failure; timeout, reset,
 * HTTP, redirect, authentication, and local failures remain outside this module.
 */

export const UPSTREAM_HOST_HEALTH_MAX_ENTRIES = 128;
export const UPSTREAM_HOST_FAILURE_WINDOW_MS = 10 * 60_000;
export const UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS = 30_000;
export const UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD = 20;

export type UpstreamHostHealthEntry = {
  consecutiveFailures: number;
  lastFailureAt: number;
  lastFailureCode?: string;
  cooldownUntil?: number;
  /** Recency marker for stalest-first pruning (not health semantics). */
  lastTouch: number;
};

/** Opaque ownership token for one admitted logical request. */
export type UpstreamHostAdmissionLease = Readonly<{
  key: string;
  leaseId: symbol;
  generation: number;
  halfOpen: boolean;
}>;

export type UpstreamHostAdmission =
  | { kind: "admitted"; lease: UpstreamHostAdmissionLease | null }
  | { kind: "blocked"; retryAfterSeconds: number };

type InternalUpstreamHostHealth = UpstreamHostHealthEntry & {
  generation: number;
  activeLeaseIds: Set<symbol>;
  halfOpenLeaseId?: symbol;
  /**
   * Leases admitted in the generation that immediately preceded the current
   * cooldown. They are stale for failure settlement, but a real HTTP response
   * from one still proves the origin is reachable and may close this cooldown.
   */
  cooldownSuccessLeaseIds?: Set<symbol>;
  /** True only when the entry is owned by opt-in circuit admissions. */
  circuitManaged: boolean;
};

const hostHealth = new Map<string, InternalUpstreamHostHealth>();
let nextGenerationValue = 0;

export function upstreamHostHealthKey(provider: string, host: string): string {
  return `${provider}|${host.toLowerCase()}`;
}

export function normalizeUpstreamHostCircuitThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return 0;
  return Math.min(value, UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD);
}

function nextGeneration(): number {
  nextGenerationValue = nextGenerationValue >= Number.MAX_SAFE_INTEGER ? 1 : nextGenerationValue + 1;
  return nextGenerationValue;
}

function snapshot(entry: InternalUpstreamHostHealth): UpstreamHostHealthEntry {
  return {
    consecutiveFailures: entry.consecutiveFailures,
    lastFailureAt: entry.lastFailureAt,
    lastTouch: entry.lastTouch,
    ...(entry.lastFailureCode !== undefined ? { lastFailureCode: entry.lastFailureCode } : {}),
    ...(entry.cooldownUntil !== undefined ? { cooldownUntil: entry.cooldownUntil } : {}),
  };
}

function newEntry(now: number, circuitManaged: boolean): InternalUpstreamHostHealth {
  return {
    consecutiveFailures: 0,
    lastFailureAt: 0,
    lastTouch: now,
    generation: nextGeneration(),
    activeLeaseIds: new Set(),
    circuitManaged,
  };
}

function advanceGeneration(entry: InternalUpstreamHostHealth): void {
  entry.generation = nextGeneration();
  entry.activeLeaseIds.clear();
  delete entry.halfOpenLeaseId;
  delete entry.cooldownSuccessLeaseIds;
}

function removeExpiredUnleased(now: number): void {
  for (const [key, entry] of hostHealth) {
    if (entry.activeLeaseIds.size > 0) continue;
    if (
      entry.consecutiveFailures === 0
      || (entry.cooldownUntil === undefined
        && now - entry.lastFailureAt > UPSTREAM_HOST_FAILURE_WINDOW_MS)
    ) {
      hostHealth.delete(key);
    }
  }
}

function oldestUnleasedKey(now: number): string | undefined {
  let preferred: [string, number] | undefined;
  let cooling: [string, number] | undefined;
  for (const [key, entry] of hostHealth) {
    if (entry.activeLeaseIds.size > 0) continue;
    const candidate: [string, number] = [key, entry.lastTouch];
    if (entry.cooldownUntil !== undefined && entry.cooldownUntil > now) {
      if (!cooling || candidate[1] < cooling[1]) cooling = candidate;
    } else if (!preferred || candidate[1] < preferred[1]) {
      preferred = candidate;
    }
  }
  return preferred?.[0] ?? cooling?.[0];
}

function pruneTo(limit: number, now: number): void {
  removeExpiredUnleased(now);
  while (hostHealth.size > limit) {
    const key = oldestUnleasedKey(now);
    if (!key) return; // Active leases may temporarily exceed the retention cap.
    hostHealth.delete(key);
  }
}

function makeRoom(now: number): void {
  pruneTo(UPSTREAM_HOST_HEALTH_MAX_ENTRIES - 1, now);
}

function issueLease(
  key: string,
  entry: InternalUpstreamHostHealth,
  halfOpen: boolean,
  now: number,
): UpstreamHostAdmissionLease {
  const leaseId = Symbol(halfOpen ? "upstream-host-half-open" : "upstream-host-admission");
  entry.activeLeaseIds.add(leaseId);
  entry.lastTouch = now;
  if (halfOpen) entry.halfOpenLeaseId = leaseId;
  return { key, leaseId, generation: entry.generation, halfOpen };
}

function matchingEntry(lease: UpstreamHostAdmissionLease): InternalUpstreamHostHealth | null {
  const entry = hostHealth.get(lease.key);
  if (!entry || entry.generation !== lease.generation || !entry.activeLeaseIds.has(lease.leaseId)) {
    return null;
  }
  if (lease.halfOpen && entry.halfOpenLeaseId !== lease.leaseId) return null;
  return entry;
}

function settleLease(entry: InternalUpstreamHostHealth, lease: UpstreamHostAdmissionLease): void {
  entry.activeLeaseIds.delete(lease.leaseId);
  if (entry.halfOpenLeaseId === lease.leaseId) delete entry.halfOpenLeaseId;
}

/**
 * Admit one logical request. A disabled threshold returns a null lease and has
 * byte-for-byte compatible call-site behavior with the observational ledger.
 */
export function acquireUpstreamHostAdmission(
  key: string,
  thresholdValue: unknown,
  now = Date.now(),
): UpstreamHostAdmission {
  const threshold = normalizeUpstreamHostCircuitThreshold(thresholdValue);
  if (threshold === 0) return { kind: "admitted", lease: null };

  pruneTo(UPSTREAM_HOST_HEALTH_MAX_ENTRIES, now);
  let entry = hostHealth.get(key);
  if (
    entry?.activeLeaseIds.size === 0
    && entry.cooldownUntil === undefined
    && entry.consecutiveFailures > 0
    && now - entry.lastFailureAt > UPSTREAM_HOST_FAILURE_WINDOW_MS
  ) {
    hostHealth.delete(key);
    entry = undefined;
  }
  if (!entry) {
    makeRoom(now);
    entry = newEntry(now, true);
    hostHealth.set(key, entry);
  } else if (!entry.circuitManaged) {
    // Observational history predating opt-in admission must not count toward
    // opening the circuit. Start a fresh fenced generation.
    entry.consecutiveFailures = 0;
    entry.lastFailureAt = 0;
    entry.circuitManaged = true;
    delete entry.lastFailureCode;
    delete entry.cooldownUntil;
    advanceGeneration(entry);
  }

  if (entry.cooldownUntil !== undefined) {
    if (entry.cooldownUntil > now) {
      return {
        kind: "blocked",
        retryAfterSeconds: Math.max(1, Math.ceil((entry.cooldownUntil - now) / 1_000)),
      };
    }
    if (entry.halfOpenLeaseId !== undefined) {
      return { kind: "blocked", retryAfterSeconds: 1 };
    }
    advanceGeneration(entry);
    return { kind: "admitted", lease: issueLease(key, entry, true, now) };
  }

  return { kind: "admitted", lease: issueLease(key, entry, false, now) };
}

/** Release an admitted request without recording transport evidence. */
export function releaseUpstreamHostAdmission(
  lease: UpstreamHostAdmissionLease | null | undefined,
  now = Date.now(),
): boolean {
  if (!lease) return false;
  const entry = matchingEntry(lease);
  if (!entry) return false;
  settleLease(entry, lease);
  entry.lastTouch = now;
  if (entry.activeLeaseIds.size === 0 && entry.consecutiveFailures === 0) {
    hostHealth.delete(lease.key);
  }
  pruneTo(UPSTREAM_HOST_HEALTH_MAX_ENTRIES, now);
  return true;
}

/**
 * Downgrade circuit-owned state when the operator disables the circuit.
 * Failure history remains observational, but cooldown and all in-flight lease
 * authority are revoked so disabled-mode traffic can update the ledger normally.
 */
export function disableUpstreamHostCircuitForKey(key: string, now = Date.now()): boolean {
  const entry = hostHealth.get(key);
  if (!entry?.circuitManaged) return false;
  entry.circuitManaged = false;
  delete entry.cooldownUntil;
  advanceGeneration(entry);
  entry.lastTouch = now;
  if (entry.consecutiveFailures === 0) hostHealth.delete(key);
  else pruneTo(UPSTREAM_HOST_HEALTH_MAX_ENTRIES, now);
  return true;
}

/** Record one terminal logical `connect_neutral` failure. */
export function recordUpstreamHostFailure(
  key: string,
  opts: {
    code?: string;
    now?: number;
    threshold?: unknown;
    lease?: UpstreamHostAdmissionLease | null;
  } = {},
): void {
  const now = opts.now ?? Date.now();
  const hasCircuitSettlement = Object.hasOwn(opts, "lease");
  // An integrated logical request may already have settled its lease on an
  // earlier physical response. Later retry completions carry explicit null and
  // must not mutate a newer generation opened by another request.
  if (hasCircuitSettlement && !opts.lease) return;
  // Legacy callers without an admission lease continue to populate only the
  // observational ledger. Circuit mutation is fenced to explicitly admitted
  // logical requests so an unwired side path cannot open it accidentally.
  const threshold = opts.lease
    ? normalizeUpstreamHostCircuitThreshold(opts.threshold)
    : 0;
  let entry: InternalUpstreamHostHealth | undefined;
  if (opts.lease) {
    entry = matchingEntry(opts.lease) ?? undefined;
    if (!entry || opts.lease.key !== key) return; // stale completion cannot mutate a newer generation
    settleLease(entry, opts.lease);
  } else {
    entry = hostHealth.get(key);
    if (entry?.circuitManaged) {
      const stale = entry.activeLeaseIds.size === 0
        && entry.cooldownUntil === undefined
        && now - entry.lastFailureAt > UPSTREAM_HOST_FAILURE_WINDOW_MS;
      if (!stale) return;
      hostHealth.delete(key);
      entry = undefined;
    }
  }
  if (!entry) {
    makeRoom(now);
    entry = newEntry(now, opts.lease !== undefined);
    hostHealth.set(key, entry);
  }

  const reopens = opts.lease?.halfOpen === true || entry.cooldownUntil !== undefined;
  const stale = entry.consecutiveFailures === 0
    || (!reopens && now - entry.lastFailureAt > UPSTREAM_HOST_FAILURE_WINDOW_MS);
  entry.consecutiveFailures = reopens && threshold > 0
    ? Math.max(threshold, entry.consecutiveFailures + 1)
    : stale ? 1 : entry.consecutiveFailures + 1;
  entry.lastFailureAt = now;
  entry.lastTouch = now;
  const code = typeof opts.code === "string" && opts.code !== ""
    ? opts.code
    : entry.lastFailureCode;
  if (code !== undefined) entry.lastFailureCode = code;

  if (threshold > 0 && (reopens || entry.consecutiveFailures >= threshold)) {
    entry.cooldownUntil = now + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS;
    // The failing lease was settled above. Preserve only its still-in-flight
    // same-generation peers as one-shot reachability proofs. advanceGeneration
    // invalidates them for every other mutation and for any later half-open generation.
    const concurrentSuccessLeaseIds = new Set(entry.activeLeaseIds);
    advanceGeneration(entry);
    if (concurrentSuccessLeaseIds.size > 0) {
      entry.cooldownSuccessLeaseIds = concurrentSuccessLeaseIds;
    }
  } else {
    delete entry.cooldownUntil;
  }
  pruneTo(UPSTREAM_HOST_HEALTH_MAX_ENTRIES, now);
}

/** Any real HTTP response from the admitted logical request proves reachability. */
export function resetUpstreamHostHealth(
  key: string,
  lease?: UpstreamHostAdmissionLease | null,
  now = Date.now(),
): boolean {
  if (lease === null) return false;
  if (lease === undefined) {
    const entry = hostHealth.get(key);
    if (entry?.circuitManaged) return false;
    return hostHealth.delete(key);
  }
  if (lease.key !== key) return false;
  let entry = matchingEntry(lease);
  if (!entry) {
    const coolingEntry = hostHealth.get(key);
    if (
      coolingEntry?.cooldownUntil === undefined
      || !coolingEntry.cooldownSuccessLeaseIds?.delete(lease.leaseId)
    ) return false;
    entry = coolingEntry;
  } else {
    settleLease(entry, lease);
  }
  entry.consecutiveFailures = 0;
  entry.lastFailureAt = 0;
  entry.lastTouch = now;
  delete entry.lastFailureCode;
  delete entry.cooldownUntil;
  if (entry.activeLeaseIds.size === 0) hostHealth.delete(key);
  pruneTo(UPSTREAM_HOST_HEALTH_MAX_ENTRIES, now);
  return true;
}

export function getUpstreamHostHealth(key: string): UpstreamHostHealthEntry | null {
  const entry = hostHealth.get(key);
  if (!entry || entry.consecutiveFailures === 0) return null;
  return snapshot(entry);
}

/** Test hook: clear the whole ledger. */
export function clearUpstreamHostHealth(): void {
  hostHealth.clear();
}
