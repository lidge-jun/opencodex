export type CodexUpstreamHostKey = string & { readonly __codexUpstreamHostKey: unique symbol };

export interface CodexUpstreamHostHealthSnapshot {
  consecutiveFailures: number;
  lastFailureAt: number;
  cooldownUntil?: number;
}

export type CodexUpstreamHostProbeLease = Readonly<{
  key: CodexUpstreamHostKey;
  leaseId: symbol;
}>;

export type CodexUpstreamHostAdmission =
  | { kind: "admitted"; probeLease: CodexUpstreamHostProbeLease | null }
  | { kind: "blocked"; retryAfterSeconds: number };

type CodexUpstreamHostHealth = CodexUpstreamHostHealthSnapshot & {
  lastTouchedAt: number;
  halfOpenLeaseId?: symbol;
};

export const CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD = 3;
export const CODEX_UPSTREAM_HOST_FAILURE_WINDOW_MS = 5 * 60_000;
export const CODEX_UPSTREAM_HOST_COOLDOWN_MS = 30_000;
export const CODEX_UPSTREAM_HOST_MAX_ENTRIES = 128;

const upstreamHostHealth = new Map<CodexUpstreamHostKey, CodexUpstreamHostHealth>();

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

function removeExpiredEntries(now: number): void {
  for (const [key, health] of upstreamHostHealth) {
    // A tripped circuit survives its cooldown so the next logical request must
    // pass through the atomic half-open admission below. The bounded map still
    // evicts abandoned entries when capacity is needed.
    if (health.cooldownUntil === undefined
      && now - health.lastFailureAt > CODEX_UPSTREAM_HOST_FAILURE_WINDOW_MS) {
      upstreamHostHealth.delete(key);
    }
  }
}

function makeRoom(now: number): void {
  removeExpiredEntries(now);
  while (upstreamHostHealth.size >= CODEX_UPSTREAM_HOST_MAX_ENTRIES) {
    let oldestKey: CodexUpstreamHostKey | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, health] of upstreamHostHealth) {
      if (health.lastTouchedAt < oldestAt) {
        oldestKey = key;
        oldestAt = health.lastTouchedAt;
      }
    }
    if (!oldestKey) break;
    upstreamHostHealth.delete(oldestKey);
  }
}

export function getCodexUpstreamHostHealth(
  key: CodexUpstreamHostKey,
  now = Date.now(),
): CodexUpstreamHostHealthSnapshot | null {
  const health = upstreamHostHealth.get(key);
  if (!health) return null;
  if (health.cooldownUntil === undefined
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
  if (!health?.cooldownUntil) return null;
  if (health.cooldownUntil <= now) return null;
  return health.cooldownUntil;
}

export function acquireCodexUpstreamHostAdmission(
  key: CodexUpstreamHostKey,
  now = Date.now(),
): CodexUpstreamHostAdmission {
  const health = upstreamHostHealth.get(key);
  if (!health) return { kind: "admitted", probeLease: null };
  if (health.cooldownUntil === undefined) {
    if (now - health.lastFailureAt > CODEX_UPSTREAM_HOST_FAILURE_WINDOW_MS) {
      upstreamHostHealth.delete(key);
    }
    return { kind: "admitted", probeLease: null };
  }
  if (health.cooldownUntil > now) {
    return {
      kind: "blocked",
      retryAfterSeconds: Math.max(1, Math.ceil((health.cooldownUntil - now) / 1_000)),
    };
  }
  if (health.halfOpenLeaseId !== undefined) {
    return { kind: "blocked", retryAfterSeconds: 1 };
  }

  const leaseId = Symbol("codex-upstream-host-probe");
  health.halfOpenLeaseId = leaseId;
  health.lastTouchedAt = now;
  return { kind: "admitted", probeLease: { key, leaseId } };
}

/** Release a half-open probe without recording host or account evidence. */
export function releaseCodexUpstreamHostProbeLease(
  lease: CodexUpstreamHostProbeLease | null | undefined,
): boolean {
  if (!lease) return false;
  const health = upstreamHostHealth.get(lease.key);
  if (!health || health.halfOpenLeaseId !== lease.leaseId) return false;
  delete health.halfOpenLeaseId;
  return true;
}

export function recordCodexUpstreamHostFailure(
  key: CodexUpstreamHostKey,
  now = Date.now(),
): CodexUpstreamHostHealthSnapshot {
  const current = upstreamHostHealth.get(key);
  const reopensCircuit = current?.cooldownUntil !== undefined;
  const stale = !current || (!reopensCircuit
    && now - current.lastFailureAt > CODEX_UPSTREAM_HOST_FAILURE_WINDOW_MS);
  const consecutiveFailures = reopensCircuit
    ? Math.max(CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD, current.consecutiveFailures + 1)
    : stale ? 1 : current.consecutiveFailures + 1;
  const cooldownUntil = reopensCircuit || consecutiveFailures >= CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD
    ? now + CODEX_UPSTREAM_HOST_COOLDOWN_MS
    : undefined;
  if (!current) makeRoom(now);
  const next: CodexUpstreamHostHealth = {
    consecutiveFailures,
    lastFailureAt: now,
    lastTouchedAt: now,
    ...(cooldownUntil !== undefined ? { cooldownUntil } : {}),
  };
  upstreamHostHealth.set(key, next);
  return snapshot(next);
}

/** Any HTTP response proves that the configured provider host was reachable. */
export function recordCodexUpstreamHostResponse(key: CodexUpstreamHostKey): void {
  upstreamHostHealth.delete(key);
}

export function isCodexUpstreamRedirectStatus(status: number): boolean {
  return status === 300 || status === 301 || status === 302 || status === 303
    || status === 307 || status === 308;
}

export function clearCodexUpstreamHostHealth(): void {
  upstreamHostHealth.clear();
}
