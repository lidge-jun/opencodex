export type CodexUpstreamHostKey = string & { readonly __codexUpstreamHostKey: unique symbol };

export interface CodexUpstreamHostHealthSnapshot {
  consecutiveFailures: number;
  lastFailureAt: number;
  cooldownUntil?: number;
}

/** Opaque capability tying one logical request to the host generation that admitted it. */
export type CodexUpstreamHostAdmissionLease = Readonly<{
  key: CodexUpstreamHostKey;
  leaseId: symbol;
  generation: number;
  halfOpen: boolean;
}>;

export type CodexUpstreamHostAdmission =
  | { kind: "admitted"; lease: CodexUpstreamHostAdmissionLease }
  | { kind: "blocked"; retryAfterSeconds: number };

export interface CodexUpstreamHostFailureOptions {
  /** This logical request received an HTTP response before its terminal rejection. */
  observedResponse?: boolean;
}

type CodexUpstreamHostHealth = CodexUpstreamHostHealthSnapshot & {
  lastTouchedAt: number;
  generation: number;
  activeLeaseIds: Set<symbol>;
  halfOpenLeaseId?: symbol;
};

export const CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD = 3;
export const CODEX_UPSTREAM_HOST_FAILURE_WINDOW_MS = 5 * 60_000;
export const CODEX_UPSTREAM_HOST_COOLDOWN_MS = 30_000;
export const CODEX_UPSTREAM_HOST_MAX_ENTRIES = 128;

const upstreamHostHealth = new Map<CodexUpstreamHostKey, CodexUpstreamHostHealth>();
let nextGenerationValue = 0;

function nextGeneration(): number {
  nextGenerationValue = nextGenerationValue >= Number.MAX_SAFE_INTEGER ? 1 : nextGenerationValue + 1;
  return nextGenerationValue;
}

function normalizedAuthority(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  let hostname = url.hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (!hostname) return null;
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}//${host}:${port}`;
}

export function canonicalCodexUpstreamHostKey(
  providerName: string,
  url: string,
): CodexUpstreamHostKey | null {
  const provider = providerName.trim().toLowerCase();
  if (!provider) return null;
  try {
    const authority = normalizedAuthority(new URL(url));
    return authority ? `${provider}\u0000${authority}` as CodexUpstreamHostKey : null;
  } catch {
    return null;
  }
}

function snapshot(health: CodexUpstreamHostHealth): CodexUpstreamHostHealthSnapshot {
  return {
    consecutiveFailures: health.consecutiveFailures,
    lastFailureAt: health.lastFailureAt,
    ...(health.cooldownUntil !== undefined ? { cooldownUntil: health.cooldownUntil } : {}),
  };
}

function removeExpiredNonLeasedEntries(now: number): void {
  for (const [key, health] of upstreamHostHealth) {
    if (health.activeLeaseIds.size > 0) continue;
    if (health.consecutiveFailures === 0 || (
      health.cooldownUntil === undefined
      && now - health.lastFailureAt > CODEX_UPSTREAM_HOST_FAILURE_WINDOW_MS
    )) {
      upstreamHostHealth.delete(key);
    }
  }
}

function oldestNonLeasedKey(now: number): CodexUpstreamHostKey | undefined {
  let oldestPreferredKey: CodexUpstreamHostKey | undefined;
  let oldestPreferredAt = Number.POSITIVE_INFINITY;
  let oldestCooldownKey: CodexUpstreamHostKey | undefined;
  let oldestCooldownAt = Number.POSITIVE_INFINITY;
  for (const [key, health] of upstreamHostHealth) {
    if (health.activeLeaseIds.size > 0) continue;
    if (health.cooldownUntil !== undefined && health.cooldownUntil > now) {
      if (health.lastTouchedAt < oldestCooldownAt) {
        oldestCooldownKey = key;
        oldestCooldownAt = health.lastTouchedAt;
      }
      continue;
    }
    if (health.lastTouchedAt < oldestPreferredAt) {
      oldestPreferredKey = key;
      oldestPreferredAt = health.lastTouchedAt;
    }
  }
  return oldestPreferredKey ?? oldestCooldownKey;
}

function makeRoom(now: number): void {
  removeExpiredNonLeasedEntries(now);
  while (upstreamHostHealth.size >= CODEX_UPSTREAM_HOST_MAX_ENTRIES) {
    const oldestKey = oldestNonLeasedKey(now);
    if (!oldestKey) return; // Every entry is leased: preserve correctness with temporary overflow.
    upstreamHostHealth.delete(oldestKey);
  }
}

function pruneOverflow(now: number): void {
  removeExpiredNonLeasedEntries(now);
  while (upstreamHostHealth.size > CODEX_UPSTREAM_HOST_MAX_ENTRIES) {
    const oldestKey = oldestNonLeasedKey(now);
    if (!oldestKey) return;
    upstreamHostHealth.delete(oldestKey);
  }
}

function newHealthyState(now: number): CodexUpstreamHostHealth {
  return {
    consecutiveFailures: 0,
    lastFailureAt: 0,
    lastTouchedAt: now,
    generation: nextGeneration(),
    activeLeaseIds: new Set(),
  };
}

function advanceGeneration(health: CodexUpstreamHostHealth): void {
  health.generation = nextGeneration();
  health.activeLeaseIds.clear();
  delete health.halfOpenLeaseId;
}

function issueLease(
  key: CodexUpstreamHostKey,
  health: CodexUpstreamHostHealth,
  halfOpen: boolean,
  now: number,
): CodexUpstreamHostAdmissionLease {
  const leaseId = Symbol(halfOpen ? "codex-upstream-host-half-open" : "codex-upstream-host-admission");
  health.activeLeaseIds.add(leaseId);
  health.lastTouchedAt = now;
  if (halfOpen) health.halfOpenLeaseId = leaseId;
  return { key, leaseId, generation: health.generation, halfOpen };
}

function matchingHealth(lease: CodexUpstreamHostAdmissionLease): CodexUpstreamHostHealth | null {
  const health = upstreamHostHealth.get(lease.key);
  if (!health || health.generation !== lease.generation || !health.activeLeaseIds.has(lease.leaseId)) {
    return null;
  }
  if (lease.halfOpen && health.halfOpenLeaseId !== lease.leaseId) return null;
  return health;
}

function settleLease(
  health: CodexUpstreamHostHealth,
  lease: CodexUpstreamHostAdmissionLease,
): void {
  health.activeLeaseIds.delete(lease.leaseId);
  if (health.halfOpenLeaseId === lease.leaseId) delete health.halfOpenLeaseId;
}

export function getCodexUpstreamHostHealth(
  key: CodexUpstreamHostKey,
  now = Date.now(),
): CodexUpstreamHostHealthSnapshot | null {
  const health = upstreamHostHealth.get(key);
  if (!health || health.consecutiveFailures === 0) return null;
  if (health.activeLeaseIds.size === 0
    && health.cooldownUntil === undefined
    && now - health.lastFailureAt > CODEX_UPSTREAM_HOST_FAILURE_WINDOW_MS) {
    upstreamHostHealth.delete(key);
    return null;
  }
  return snapshot(health);
}

export function getCodexUpstreamHostCooldownUntil(
  key: CodexUpstreamHostKey,
  now = Date.now(),
): number | null {
  const health = upstreamHostHealth.get(key);
  if (!health?.cooldownUntil || health.cooldownUntil <= now) return null;
  return health.cooldownUntil;
}

export function acquireCodexUpstreamHostAdmission(
  key: CodexUpstreamHostKey,
  now = Date.now(),
): CodexUpstreamHostAdmission {
  pruneOverflow(now);
  let health = upstreamHostHealth.get(key);
  if (health?.activeLeaseIds.size === 0
    && health.cooldownUntil === undefined
    && health.consecutiveFailures > 0
    && now - health.lastFailureAt > CODEX_UPSTREAM_HOST_FAILURE_WINDOW_MS) {
    upstreamHostHealth.delete(key);
    health = undefined;
  }
  if (!health) {
    makeRoom(now);
    health = newHealthyState(now);
    upstreamHostHealth.set(key, health);
  }
  if (health.cooldownUntil !== undefined) {
    if (health.cooldownUntil > now) {
      return {
        kind: "blocked",
        retryAfterSeconds: Math.max(1, Math.ceil((health.cooldownUntil - now) / 1_000)),
      };
    }
    if (health.halfOpenLeaseId !== undefined) {
      return { kind: "blocked", retryAfterSeconds: 1 };
    }
    advanceGeneration(health);
    return { kind: "admitted", lease: issueLease(key, health, true, now) };
  }
  return { kind: "admitted", lease: issueLease(key, health, false, now) };
}

/** Release an admitted request without recording host or account evidence. */
export function releaseCodexUpstreamHostAdmissionLease(
  lease: CodexUpstreamHostAdmissionLease | null | undefined,
  now = Date.now(),
): boolean {
  if (!lease) return false;
  const health = matchingHealth(lease);
  if (!health) return false;
  settleLease(health, lease);
  health.lastTouchedAt = now;
  if (health.activeLeaseIds.size === 0 && health.consecutiveFailures === 0) {
    upstreamHostHealth.delete(lease.key);
  }
  pruneOverflow(now);
  return true;
}

export function recordCodexUpstreamHostFailure(
  lease: CodexUpstreamHostAdmissionLease,
  now = Date.now(),
  options: CodexUpstreamHostFailureOptions = {},
): CodexUpstreamHostHealthSnapshot | null {
  const current = matchingHealth(lease);
  if (!current) return null;
  settleLease(current, lease);

  if (options.observedResponse) {
    current.consecutiveFailures = 1;
    current.lastFailureAt = now;
    current.lastTouchedAt = now;
    delete current.cooldownUntil;
    pruneOverflow(now);
    return snapshot(current);
  }

  const reopensCircuit = lease.halfOpen || current.cooldownUntil !== undefined;
  const stale = current.consecutiveFailures === 0
    || (!reopensCircuit && now - current.lastFailureAt > CODEX_UPSTREAM_HOST_FAILURE_WINDOW_MS);
  current.consecutiveFailures = reopensCircuit
    ? Math.max(CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD, current.consecutiveFailures + 1)
    : stale ? 1 : current.consecutiveFailures + 1;
  current.lastFailureAt = now;
  current.lastTouchedAt = now;
  if (reopensCircuit || current.consecutiveFailures >= CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD) {
    current.cooldownUntil = now + CODEX_UPSTREAM_HOST_COOLDOWN_MS;
    advanceGeneration(current);
  } else {
    delete current.cooldownUntil;
  }
  pruneOverflow(now);
  return snapshot(current);
}

/** Any HTTP response from this admitted logical request proves the host was reachable. */
export function recordCodexUpstreamHostResponse(
  lease: CodexUpstreamHostAdmissionLease,
  now = Date.now(),
): boolean {
  const current = matchingHealth(lease);
  if (!current) return false;
  settleLease(current, lease);
  current.consecutiveFailures = 0;
  current.lastFailureAt = 0;
  current.lastTouchedAt = now;
  delete current.cooldownUntil;
  if (current.activeLeaseIds.size === 0) {
    upstreamHostHealth.delete(lease.key);
  }
  pruneOverflow(now);
  return true;
}

export function isCodexUpstreamRedirectStatus(status: number): boolean {
  return status === 300 || status === 301 || status === 302 || status === 303
    || status === 307 || status === 308;
}

export function clearCodexUpstreamHostHealth(): void {
  upstreamHostHealth.clear();
}
