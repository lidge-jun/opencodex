import { saveConfig } from "../config";
import { isCodexAccountGenerationLive, readCodexAccountRecord } from "./account-store";
import { codexAccountLogLabel } from "./account-label";
import { isCodexAccountUsable } from "./account-usability";
import { isAccountNeedsReauth, markAccountNeedsReauth } from "./account-runtime-state";
import { CODEX_UNKNOWN_USAGE_SCORE, getAccountQuota } from "./quota";
import { MAIN_CODEX_ACCOUNT_ID, getMainAccountPlan } from "./main-account";
import type { OcxConfig } from "../types";

type ThreadAffinityEntry = {
  accountId: string;
  generation: number;
  createdAt: number;
  lastUsedAt: number;
  // Last time the bound account's quota threshold was re-evaluated for this
  // thread (interval-gated to avoid per-request flapping). See REEVAL_INTERVAL_MS.
  lastReevalAt: number;
};

export type CodexThreadResolution =
  | { status: "selected"; accountId: string }
  | { status: "none" }
  | { status: "expired"; accountId: string };

const threadAccountMap = new Map<string, ThreadAffinityEntry>();
type CodexUpstreamHealth = {
  consecutiveFailures: number;
  lastFailureStatus?: number;
  lastFailureAt?: number;
  cooldownUntil?: number;
};

const CODEX_DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
const CODEX_MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60_000;
export const CODEX_FAILURE_WINDOW_MS = 5 * 60_000;
export const CODEX_THREAD_AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
export const CODEX_THREAD_AFFINITY_MAX_ENTRIES = 2048;
// Min interval between quota threshold re-evaluations for a single bound thread.
// Well under the 5h/weekly quota windows, but enough to stop per-request flapping.
export const CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS = 60_000;

const upstreamHealth = new Map<string, CodexUpstreamHealth>();

export type CodexUpstreamOutcome = number | "connect_error" | "timeout";
export type CodexUpstreamOutcomeClass = "success" | "credential" | "quota" | "transient" | "caller" | "unknown";
export type CodexUpstreamOutcomeMeta = {
  retryAfter?: string | null;
  resetAt?: unknown | unknown[];
  now?: number;
};

function hasConfiguredPoolAccount(config: OcxConfig, accountId: string): boolean {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return isCodexAccountUsable(config, accountId);
  return (config.codexAccounts ?? []).some(account => !account.isMain && account.id === accountId);
}

export function clearThreadAccountMap(): void {
  threadAccountMap.clear();
}

export function clearThreadAccountMapForAccount(accountId: string): void {
  for (const [threadId, entry] of threadAccountMap) {
    if (entry.accountId === accountId) threadAccountMap.delete(threadId);
  }
}

export function clearCodexUpstreamHealth(): void {
  upstreamHealth.clear();
}

export function clearCodexUpstreamHealthForAccount(accountId: string): void {
  upstreamHealth.delete(accountId);
}

export function getCodexUpstreamHealth(
  accountId: string,
): CodexUpstreamHealth | null {
  return upstreamHealth.get(accountId) ?? null;
}

export function computeCodexUsageScore(quota: {
  weeklyPercent?: number;
  monthlyPercent?: number;
} | null, plan?: string | null): number {
  if (!quota) return CODEX_UNKNOWN_USAGE_SCORE;
  const normalizedPlan = plan?.trim().toLowerCase();
  if (normalizedPlan === "go" || normalizedPlan === "free") {
    return typeof quota.monthlyPercent === "number" && Number.isFinite(quota.monthlyPercent)
      ? quota.monthlyPercent
      : CODEX_UNKNOWN_USAGE_SCORE;
  }
  const values = [quota.weeklyPercent, quota.monthlyPercent]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : CODEX_UNKNOWN_USAGE_SCORE;
}

export function classifyCodexUpstreamOutcome(outcome: CodexUpstreamOutcome): CodexUpstreamOutcomeClass {
  if (outcome === "connect_error" || outcome === "timeout") return "transient";
  if (!Number.isFinite(outcome)) return "unknown";
  if (outcome >= 200 && outcome < 300) return "success";
  if (outcome === 401 || outcome === 403) return "credential";
  if (outcome === 429) return "quota";
  if (outcome >= 400 && outcome < 500) return "caller";
  if (outcome >= 500 && outcome < 600) return "transient";
  return "unknown";
}

function clampCooldownMs(ms: number): number {
  return Math.min(Math.max(ms, 1), CODEX_MAX_QUOTA_COOLDOWN_MS);
}

export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) return clampCooldownMs(Math.ceil(seconds * 1000));
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? clampCooldownMs(delay) : undefined;
}

function resetTimestampMs(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

export function parseResetCooldownMs(resetAt: unknown | unknown[] | undefined, now = Date.now()): number | undefined {
  const values = Array.isArray(resetAt) ? resetAt : [resetAt];
  let best: number | undefined;
  for (const value of values) {
    const timestamp = resetTimestampMs(value);
    if (timestamp === undefined) continue;
    const delay = timestamp - now;
    if (delay <= 0) continue;
    const clamped = clampCooldownMs(delay);
    if (best === undefined || clamped < best) best = clamped;
  }
  return best;
}

export function computeQuotaCooldownUntil(meta: CodexUpstreamOutcomeMeta = {}): number {
  const now = meta.now ?? Date.now();
  const retryAfterMs = parseRetryAfterMs(meta.retryAfter, now);
  const resetCooldownMs = retryAfterMs === undefined ? parseResetCooldownMs(meta.resetAt, now) : undefined;
  return now + (retryAfterMs ?? resetCooldownMs ?? CODEX_DEFAULT_QUOTA_COOLDOWN_MS);
}

export function getCodexAccountCooldownUntil(accountId: string, now = Date.now()): number | null {
  const cooldownUntil = upstreamHealth.get(accountId)?.cooldownUntil;
  return typeof cooldownUntil === "number" && Number.isFinite(cooldownUntil) && cooldownUntil > now ? cooldownUntil : null;
}

export function isCodexAccountInCooldown(accountId: string, now = Date.now()): boolean {
  return getCodexAccountCooldownUntil(accountId, now) !== null;
}

function isCodexAccountSelectable(config: OcxConfig, accountId: string, now: number): boolean {
  return !isCodexAccountInCooldown(accountId, now) && isCodexAccountUsable(config, accountId);
}

function isThreadAffinityExpired(entry: ThreadAffinityEntry, now: number): boolean {
  return now - entry.lastUsedAt > CODEX_THREAD_AFFINITY_IDLE_TTL_MS;
}

function isThreadAffinityGenerationLive(entry: ThreadAffinityEntry): boolean {
  return isCodexAccountGenerationLive(entry.accountId, entry.generation);
}

function pruneExpiredThreadAffinities(now: number): void {
  for (const [threadId, entry] of threadAccountMap) {
    if (isThreadAffinityExpired(entry, now)) threadAccountMap.delete(threadId);
  }
}

function pruneLruThreadAffinities(): void {
  while (threadAccountMap.size > CODEX_THREAD_AFFINITY_MAX_ENTRIES) {
    let oldestThreadId: string | null = null;
    let oldestLastUsedAt = Number.POSITIVE_INFINITY;
    for (const [threadId, entry] of threadAccountMap) {
      if (entry.lastUsedAt < oldestLastUsedAt) {
        oldestThreadId = threadId;
        oldestLastUsedAt = entry.lastUsedAt;
      }
    }
    if (!oldestThreadId) return;
    threadAccountMap.delete(oldestThreadId);
  }
}

function bindThreadAffinity(threadId: string, accountId: string, now: number): void {
  const record = readCodexAccountRecord(accountId);
  if (!record?.credential || record.deletedAt != null) return;
  pruneExpiredThreadAffinities(now);
  const previous = threadAccountMap.get(threadId);
  threadAccountMap.set(threadId, {
    accountId,
    generation: record.generation,
    createdAt: previous?.createdAt ?? now,
    lastUsedAt: now,
    lastReevalAt: now,
  });
  pruneLruThreadAffinities();
}

function getEligiblePoolAccounts(config: OcxConfig, excludeId?: string, now = Date.now()): string[] {
  const ids = (config.codexAccounts ?? []).flatMap(account =>
    !account.isMain && account.id !== excludeId && !isAccountNeedsReauth(account.id)
      && !isCodexAccountInCooldown(account.id, now)
      && isCodexAccountUsable(config, account.id)
      ? [account.id]
      : [],
  );
  // The main Codex account is not stored in config.codexAccounts; include it as a
  // first-class rotation candidate when its read-only token is usable (Option A).
  if (
    excludeId !== MAIN_CODEX_ACCOUNT_ID
    && !isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)
    && !isCodexAccountInCooldown(MAIN_CODEX_ACCOUNT_ID, now)
    && isCodexAccountUsable(config, MAIN_CODEX_ACCOUNT_ID)
  ) {
    ids.unshift(MAIN_CODEX_ACCOUNT_ID);
  }
  return ids;
}

function getPoolAccountPlan(config: OcxConfig, accountId: string): string | undefined {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return getMainAccountPlan();
  return (config.codexAccounts ?? []).find(account => !account.isMain && account.id === accountId)?.plan;
}

function pickLowerUsageAccount(config: OcxConfig, active: string, activeUsage: number, now: number): string {
  let best = active;
  let bestUsage = activeUsage;
  for (const id of getEligiblePoolAccounts(config, active, now)) {
    const usage = computeCodexUsageScore(getAccountQuota(id), getPoolAccountPlan(config, id));
    if (usage < bestUsage) {
      best = id;
      bestUsage = usage;
    }
  }
  return best;
}

export function pickLowestUsageCodexAccount(config: OcxConfig, excludeId?: string, now = Date.now()): string | null {
  let best: string | null = null;
  let bestUsage = Number.POSITIVE_INFINITY;
  for (const id of getEligiblePoolAccounts(config, excludeId, now)) {
    const usage = computeCodexUsageScore(getAccountQuota(id), getPoolAccountPlan(config, id));
    if (usage < bestUsage) {
      best = id;
      bestUsage = usage;
    }
  }
  return best;
}

function setActiveCodexAccount(config: OcxConfig, accountId: string): void {
  if (config.activeCodexAccountId === accountId) return;
  config.activeCodexAccountId = accountId;
  saveConfig(config);
}

function isUnknownUsage(usage: number): boolean {
  return usage >= CODEX_UNKNOWN_USAGE_SCORE;
}

// Round-robin among eligible unknown-quota candidates. `getEligiblePoolAccounts`
// already returns a deterministic order (config order, main unshifted first) and
// excludes the active id, so taking the first eligible unknown is a stable rotation
// without any new per-account state.
function pickNextUnknownAccount(config: OcxConfig, active: string, now: number): string | null {
  const eligible = getEligiblePoolAccounts(config, active, now)
    .filter(id => isUnknownUsage(computeCodexUsageScore(getAccountQuota(id), getPoolAccountPlan(config, id))));
  return eligible.length > 0 ? eligible[0]! : null;
}

function applyQuotaAutoSwitch(config: OcxConfig, active: string, now: number): string {
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold <= 0) return active;
  const quota = getAccountQuota(active);
  const activeUsage = computeCodexUsageScore(quota, getPoolAccountPlan(config, active));
  if (activeUsage < threshold) return active;
  const best = pickLowerUsageAccount(config, active, activeUsage, now);
  if (best !== active) {
    setActiveCodexAccount(config, best);
    return best;
  }

  // Deadlock guard: active is over threshold but no candidate scored strictly
  // lower. When the active itself is unknown, every candidate is likely unknown
  // too (100 < 100 never fires), which pins the pool to one account whose real
  // usage we cannot see (e.g. quota never primed on WSL). Rotate to the next
  // eligible unknown so rotation is not stuck; known-but-saturated accounts are
  // intentionally left alone so a genuinely hot pool stays visible.
  if (isUnknownUsage(activeUsage)) {
    const next = pickNextUnknownAccount(config, active, now);
    if (next) {
      console.warn(`[codex-routing] quota unknown for active "${active}"; rotating to "${next}" (all candidates unknown, threshold=${threshold})`);
      setActiveCodexAccount(config, next);
      return next;
    }
    console.warn(`[codex-routing] quota unknown for active "${active}" and no eligible rotation target; staying put`);
  }
  return active;
}

function shouldFailover(config: OcxConfig, accountId: string, now: number): boolean {
  const threshold = config.upstreamFailoverThreshold ?? 3;
  if (threshold <= 0) return false;
  const health = upstreamHealth.get(accountId);
  if (health?.lastFailureAt && now - health.lastFailureAt > CODEX_FAILURE_WINDOW_MS) return false;
  return !!health && health.consecutiveFailures >= threshold;
}

function applyFailureFailover(config: OcxConfig, active: string, now: number): string {
  if (!shouldFailover(config, active, now)) return active;
  const best = pickLowestUsageCodexAccount(config, active, now);
  if (best) {
    setActiveCodexAccount(config, best);
    return best;
  }
  return active;
}

export function resolveCodexAccountForThread(
  threadId: string | null,
  config: OcxConfig,
  now = Date.now(),
): string | null {
  const resolution = resolveCodexAccountForThreadDetailed(threadId, config, now);
  return resolution.status === "selected" ? resolution.accountId : null;
}

export function resolveCodexAccountForThreadDetailed(
  threadId: string | null,
  config: OcxConfig,
  now = Date.now(),
): CodexThreadResolution {
  if (threadId && threadAccountMap.has(threadId)) {
    const entry = threadAccountMap.get(threadId)!;
    if (isThreadAffinityExpired(entry, now)) {
      threadAccountMap.delete(threadId);
      return { status: "expired", accountId: entry.accountId };
    }
    if (
      isThreadAffinityGenerationLive(entry)
      && isCodexAccountSelectable(config, entry.accountId, now)
    ) {
      entry.lastUsedAt = now;
      // Periodic quota re-eval: a long-lived bound thread must still switch when
      // it crosses autoSwitchThreshold and a strictly-cooler account exists.
      // Without this the reuse branch returns before applyQuotaAutoSwitch and the
      // thread stays pinned for the full idle TTL (the WSL "never switches" report).
      if (now - entry.lastReevalAt >= CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS) {
        entry.lastReevalAt = now;
        const threshold = config.autoSwitchThreshold ?? 80;
        if (threshold > 0) {
          const usage = computeCodexUsageScore(
            getAccountQuota(entry.accountId),
            getPoolAccountPlan(config, entry.accountId),
          );
          if (usage >= threshold) {
            const best = pickLowerUsageAccount(config, entry.accountId, usage, now);
            if (best !== entry.accountId) {
              setActiveCodexAccount(config, best);
              bindThreadAffinity(threadId, best, now); // rebinds + resets clocks
              return { status: "selected", accountId: best };
            }
          }
        }
      }
      return { status: "selected", accountId: entry.accountId };
    }
    threadAccountMap.delete(threadId);
  }
  let active = config.activeCodexAccountId;
  if (!active) return { status: "none" };
  if (!isCodexAccountSelectable(config, active, now)) {
    const fallback = pickLowestUsageCodexAccount(config, active, now);
    if (fallback) {
      setActiveCodexAccount(config, fallback);
      active = fallback;
    } else if (hasConfiguredPoolAccount(config, active)) {
      return { status: "selected", accountId: active };
    } else {
      return { status: "none" };
    }
  }
  active = applyQuotaAutoSwitch(config, active, now);
  active = applyFailureFailover(config, active, now);
  if (!isCodexAccountUsable(config, active)) {
    return hasConfiguredPoolAccount(config, active) ? { status: "selected", accountId: active } : { status: "none" };
  }
  if (isCodexAccountInCooldown(active, now)) {
    return hasConfiguredPoolAccount(config, active) ? { status: "selected", accountId: active } : { status: "none" };
  }
  if (threadId) bindThreadAffinity(threadId, active, now);
  return { status: "selected", accountId: active };
}

export function recordCodexUpstreamOutcome(
  config: OcxConfig,
  accountId: string | null,
  outcome: CodexUpstreamOutcome,
  meta: CodexUpstreamOutcomeMeta = {},
): void {
  if (!accountId) return;
  const now = meta.now ?? Date.now();
  const outcomeClass = classifyCodexUpstreamOutcome(outcome);
  if (outcomeClass === "success") {
    const cooldownUntil = getCodexAccountCooldownUntil(accountId, now);
    if (cooldownUntil) upstreamHealth.set(accountId, { consecutiveFailures: 0, cooldownUntil });
    else upstreamHealth.delete(accountId);
    return;
  }
  if (outcomeClass === "caller") return;

  const lastFailureStatus = typeof outcome === "number" ? outcome : 0;
  if (outcomeClass === "credential") {
    upstreamHealth.set(accountId, {
      consecutiveFailures: 1,
      lastFailureStatus,
      lastFailureAt: now,
    });
    markAccountNeedsReauth(accountId);
    clearThreadAccountMapForAccount(accountId);
    return;
  }

  if (outcomeClass === "quota") {
    upstreamHealth.set(accountId, {
      consecutiveFailures: 0,
      lastFailureStatus,
      lastFailureAt: now,
      cooldownUntil: computeQuotaCooldownUntil(meta),
    });
    clearThreadAccountMapForAccount(accountId);
    if (config.activeCodexAccountId === accountId) {
      const fallback = pickLowestUsageCodexAccount(config, accountId, now);
      if (fallback) setActiveCodexAccount(config, fallback);
    }
    return;
  }

  const current = upstreamHealth.get(accountId);
  const stale = current?.lastFailureAt ? now - current.lastFailureAt > CODEX_FAILURE_WINDOW_MS : false;
  const cooldownUntil = getCodexAccountCooldownUntil(accountId, now) ?? undefined;
  upstreamHealth.set(accountId, {
    consecutiveFailures: stale ? 1 : (current?.consecutiveFailures ?? 0) + 1,
    lastFailureStatus,
    lastFailureAt: now,
    ...(cooldownUntil ? { cooldownUntil } : {}),
  });
  if (config.activeCodexAccountId === accountId) applyFailureFailover(config, accountId, now);
}

export function formatCodexProviderForLog(providerName: string, accountId: string | null, config: OcxConfig): string {
  if (!accountId) return providerName;
  // The main Codex login participates in rotation as "main-pool" (MAIN_CODEX_ACCOUNT_ID) but is the
  // same physical account as the "main" passthrough (null accountId). Log both under the base provider
  // name so usage/tokens aggregate into a single row instead of splitting into `chatgpt` + `chatgpt-main`.
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return providerName;
  const account = (config.codexAccounts ?? []).find(a => !a.isMain && a.id === accountId);
  return account ? `${providerName}-${codexAccountLogLabel(account)}` : providerName;
}
