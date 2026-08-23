import { getAccountSet } from "./store";
import {
  bindSessionAffinity,
  buildSessionKeyFromParts,
  clearAffinityState,
  clearSessionAffinityForAccount,
  getSessionAffinity,
  normalizeAffinityComponent,
  touchSessionAffinity,
} from "../routing/account-pool";

/**
 * Process-local Antigravity account health (cooldowns). Stored in an in-memory
 * `Map<string, AntigravityAccountHealth>` for the lifetime of this process only —
 * cooldowns reset on restart and are not shared across workers.
 */
export type AntigravityCooldownReason = "rate_limited" | "quota_exhausted" | "geo_blocked";

const POOL_KEY_ANTIGRAVITY = "google-antigravity";
/** Short rate-limit stick-wait: retry the same account instead of hopping. Never wait on quota/geo. */
export const ANTIGRAVITY_STICK_WAIT_MAX_MS = 5_000;

const DEFAULT_RATE_LIMITED_COOLDOWN_MS = 5_000;
const MAX_RATE_LIMITED_COOLDOWN_MS = 60_000;
const DEFAULT_QUOTA_EXHAUSTED_COOLDOWN_MS = 24 * 60 * 60_000;
const MAX_QUOTA_EXHAUSTED_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
const GEO_BLOCKED_COOLDOWN_MS = 24 * 60 * 60_000;

type AntigravityAccountHealth = {
  cooldownUntil: number;
  reason: AntigravityCooldownReason;
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
    accountHealth.set(accountId, { cooldownUntil, reason });
  }
}

export function getAntigravityAccountCooldown(
  accountId: string,
  now = Date.now(),
): { cooldownUntil: number; reason: AntigravityCooldownReason } | undefined {
  const health = accountHealth.get(accountId);
  if (!health) return undefined;
  if (health.cooldownUntil <= now) {
    accountHealth.delete(accountId);
    return undefined;
  }
  return { cooldownUntil: health.cooldownUntil, reason: health.reason };
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

/** Test helper: reset process-local cooldown state between cases. */
export function clearAntigravityRoutingHealthForTests(): void {
  accountHealth.clear();
}

export function isAntigravityRateLimitStickWait(accountId: string, now = Date.now()): boolean {
  const health = getAntigravityAccountCooldown(accountId, now);
  if (!health || health.reason !== "rate_limited") return false;
  const remaining = health.cooldownUntil - now;
  return remaining > 0 && remaining <= ANTIGRAVITY_STICK_WAIT_MAX_MS;
}

/** Milliseconds to wait before retrying the same account on 429, or null when failover should run. */
export function antigravity429StickWaitMs(accountId: string, now = Date.now()): number | null {
  if (!isAntigravityRateLimitStickWait(accountId, now)) return null;
  const health = getAntigravityAccountCooldown(accountId, now);
  if (!health) return null;
  const remaining = health.cooldownUntil - now;
  return remaining > 0 ? remaining : null;
}

export function isAntigravityAccountEligible(accountId: string, now = Date.now()): boolean {
  if (!isAntigravityAccountInCooldown(accountId, now)) return true;
  return isAntigravityRateLimitStickWait(accountId, now);
}

export function getEligibleAntigravityAccounts(now = Date.now()): string[] {
  const set = getAccountSet(POOL_KEY_ANTIGRAVITY);
  if (!set) return [];
  return set.accounts
    .filter(account => isAntigravityAccountEligible(account.id, now))
    .map(account => account.id);
}

export type AntigravityAccountSelectionReason =
  | "affinity"
  | "active"
  | "failover"
  | "none"
  | "all-cooled";

export interface AntigravityAccountSelection {
  accountId: string | null;
  reason: AntigravityAccountSelectionReason;
}

function bindAntigravityAffinityIfPossible(
  sessionKey: string | null | undefined,
  accountId: string,
  now: number,
): void {
  bindSessionAffinity(POOL_KEY_ANTIGRAVITY, sessionKey, accountId, now);
}

/**
 * Failover-only account pick: stick bound sessions, default new sessions to the store active
 * account, and hop only when the chosen account is cooled (except short rate-limit stick-wait).
 * Does not call setActiveAccount.
 */
export function resolveAntigravityAccountForSession(
  sessionKey: string | null | undefined,
  now = Date.now(),
): AntigravityAccountSelection {
  const set = getAccountSet(POOL_KEY_ANTIGRAVITY);
  if (!set || set.accounts.length === 0) return { accountId: null, reason: "none" };

  const accountIds = set.accounts.map(account => account.id);
  const activeId = set.activeAccountId;
  const key = normalizeAffinityComponent(sessionKey);

  if (key) {
    const affined = getSessionAffinity(POOL_KEY_ANTIGRAVITY, key, now);
    if (affined) {
      if (isAntigravityAccountEligible(affined.accountId, now)) {
        touchSessionAffinity(POOL_KEY_ANTIGRAVITY, key, now);
        return { accountId: affined.accountId, reason: "affinity" };
      }
      const next = nextAntigravityAccount(accountIds, affined.accountId, now);
      if (next) {
        bindAntigravityAffinityIfPossible(sessionKey, next, now);
        return { accountId: next, reason: "failover" };
      }
      clearSessionAffinityForAccount(POOL_KEY_ANTIGRAVITY, affined.accountId);
      const anyCooled = accountIds.some(id => !isAntigravityAccountEligible(id, now));
      return { accountId: null, reason: anyCooled ? "all-cooled" : "none" };
    }
  }

  if (activeId && isAntigravityAccountEligible(activeId, now)) {
    bindAntigravityAffinityIfPossible(sessionKey, activeId, now);
    return { accountId: activeId, reason: "active" };
  }

  const next = nextAntigravityAccount(accountIds, activeId, now);
  if (next) {
    bindAntigravityAffinityIfPossible(sessionKey, next, now);
    return { accountId: next, reason: "failover" };
  }

  const anyCooled = accountIds.some(id => !isAntigravityAccountEligible(id, now));
  return { accountId: null, reason: anyCooled ? "all-cooled" : "none" };
}

export function bindAntigravitySessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  bindAntigravityAffinityIfPossible(sessionKey, accountId, now);
}

/**
 * Pick the next Antigravity account after a rate-limit 429. Cooldown is recorded upstream
 * (google-http). Does not promote the global active account.
 */
export function rotateAntigravityAccountOn429(
  failedAccountId: string,
  sessionKey: string | null | undefined,
  now = Date.now(),
): string | null {
  if (antigravity429StickWaitMs(failedAccountId, now) !== null) return null;

  const set = getAccountSet(POOL_KEY_ANTIGRAVITY);
  if (!set) return null;
  const accountIds = set.accounts.map(account => account.id);

  clearSessionAffinityForAccount(POOL_KEY_ANTIGRAVITY, failedAccountId);

  const next = nextAntigravityAccount(accountIds, failedAccountId, now);
  if (!next) return null;

  bindAntigravityAffinityIfPossible(sessionKey, next, now);
  return next;
}

/** Test / logout helper. */
export function clearAntigravityAccountPoolState(): void {
  clearAffinityState(POOL_KEY_ANTIGRAVITY);
}

export function antigravitySessionKeyFromParts(input: {
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  promptCacheKey?: string | null;
  clientThreadId?: string | null;
  promptCacheKeyIsSharedCohort?: boolean;
}): string | null {
  return buildSessionKeyFromParts(input);
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
