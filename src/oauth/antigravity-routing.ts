export type AntigravityCooldownReason = "rate_limited" | "quota_exhausted" | "geo_blocked";

const DEFAULT_RATE_LIMITED_COOLDOWN_MS = 5_000;
const MAX_RATE_LIMITED_COOLDOWN_MS = 60_000;
const DEFAULT_QUOTA_EXHAUSTED_COOLDOWN_MS = 24 * 60 * 60_000;
const MAX_QUOTA_EXHAUSTED_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
const GEO_BLOCKED_COOLDOWN_MS = 24 * 60 * 60_000;

type AntigravityAccountHealth = {
  cooldownUntil: number;
};

const accountHealth = new Map<string, AntigravityAccountHealth>();

function positiveDurationOrDefault(
  durationMs: number | undefined,
  defaultMs: number,
  maxMs?: number,
): number {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return defaultMs;
  }
  return maxMs === undefined ? durationMs : Math.min(durationMs, maxMs);
}

function cooldownDurationMs(
  reason: AntigravityCooldownReason,
  retryAfterMs: number | undefined,
): number {
  switch (reason) {
    case "rate_limited":
      return positiveDurationOrDefault(
        retryAfterMs,
        DEFAULT_RATE_LIMITED_COOLDOWN_MS,
        MAX_RATE_LIMITED_COOLDOWN_MS,
      );
    case "quota_exhausted":
      return positiveDurationOrDefault(
        retryAfterMs,
        DEFAULT_QUOTA_EXHAUSTED_COOLDOWN_MS,
        MAX_QUOTA_EXHAUSTED_COOLDOWN_MS,
      );
    case "geo_blocked":
      return GEO_BLOCKED_COOLDOWN_MS;
  }
}

export function recordAntigravityCooldown(
  accountId: string,
  reason: AntigravityCooldownReason,
  retryAfterMs?: number,
  now = Date.now(),
): void {
  const cooldownUntil = now + cooldownDurationMs(reason, retryAfterMs);
  const current = accountHealth.get(accountId);
  if (!current || current.cooldownUntil < cooldownUntil) {
    accountHealth.set(accountId, { cooldownUntil });
  }
}

export function isAntigravityAccountInCooldown(accountId: string, now = Date.now()): boolean {
  const health = accountHealth.get(accountId);
  if (!health) return false;
  if (health.cooldownUntil <= now) {
    accountHealth.delete(accountId);
    return false;
  }
  return true;
}

export function nextAntigravityAccount(
  accountIds: string[],
  activeId: string | undefined,
  now = Date.now(),
): string | undefined {
  if (accountIds.length === 0) return undefined;

  const activeIndex = activeId === undefined ? -1 : accountIds.indexOf(activeId);
  const startIndex = activeIndex < 0 ? 0 : activeIndex + 1;
  for (let offset = 0; offset < accountIds.length; offset += 1) {
    const accountId = accountIds[(startIndex + offset) % accountIds.length]!;
    if (activeId !== undefined && accountId === activeId) continue;
    if (!isAntigravityAccountInCooldown(accountId, now)) return accountId;
  }
  return undefined;
}

export function sweepExpiredAntigravityRoutingHealth(now = Date.now()): number {
  let removed = 0;
  for (const [accountId, health] of accountHealth) {
    if (health.cooldownUntil > now) continue;
    accountHealth.delete(accountId);
    removed += 1;
  }
  return removed;
}

export function clearAntigravityAccountCooldown(accountId: string): void {
  accountHealth.delete(accountId);
}

export const ANTIGRAVITY_MISSING_PROJECT_MESSAGE =
  "Antigravity requires a discovered Cloud Code Assist project id (re-run `ocx login google-antigravity`).";

export type BindAntigravityProjectFailure = {
  ok: false;
  status: 400;
  type: "invalid_request_error";
  message: string;
};

export type BindAntigravityProjectSuccess<T extends { project?: string }> = {
  ok: true;
  provider: T & { project: string };
};

/** Pair Cloud Code Assist `project` with the credential in use. Never keep a previous account's id. */
export function bindAntigravityProject<T extends { project?: string }>(
  provider: T,
  projectId: string | undefined,
): BindAntigravityProjectSuccess<T> | BindAntigravityProjectFailure {
  const project = typeof projectId === "string" ? projectId.trim() : "";
  if (!project) {
    return {
      ok: false,
      status: 400,
      type: "invalid_request_error",
      message: ANTIGRAVITY_MISSING_PROJECT_MESSAGE,
    };
  }
  return { ok: true, provider: { ...provider, project } };
}
