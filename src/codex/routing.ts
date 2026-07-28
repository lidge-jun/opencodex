import { randomUUID } from "node:crypto";
import { saveConfigPreservingClaudeCode } from "../config";
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
  /** Consecutive healthy terminals observed while recovering from escalation level 2+. */
  consecutiveSuccesses?: number;
  lastFailureStatus?: number;
  lastFailureAt?: number;
  /** Hard cooldown (quota 429). Survives a later 2xx; blocks auth + selection. */
  cooldownUntil?: number;
  /** When the current cooldown was recorded; origin of the probe interval clock. */
  cooldownSince?: number;
  /**
   * What produced the cooldown. An explicit Retry-After is a literal retry
   * directive and is never probed; a quota resetAt only announces a window
   * refresh, so it may be probed early (#433).
   */
  cooldownSource?: CodexCooldownSource;
  /**
   * Bumped on every cooldown write. A probe lease records the generation it was
   * issued for so a lease cannot clear a cooldown that a later 429 replaced.
   */
  cooldownGeneration?: number;
  /**
   * Identity of the in-flight probe. A cooled-down account sends no traffic, so
   * no organic 2xx can prove recovery; only the outcome carrying this id may
   * clear the cooldown.
   */
  probeLeaseId?: string;
  /** Cooldown generation at the moment the lease was granted. */
  probeLeaseGeneration?: number;
  /** Last probe grant or conclusion; paces the probe interval. */
  lastProbeAt?: number;
  /**
   * Soft avoid after connect_error / timeout / transient 5xx. Cleared on 2xx.
   * Blocks pool selection + thread affinity reuse so a sticky session can leave a
   * flaky account without throwing CodexAccountCooldownError (hard-only).
   */
  softAvoidUntil?: number;
};

const CODEX_DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
const CODEX_MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60_000;
/**
 * A weekly/monthly quota `resetAt` announces when the window refreshes; it is not
 * a "come back after this" directive like Retry-After. Plan quota routinely frees
 * up long before the advertised reset, so cap reset-derived cooldowns far below
 * the Retry-After ceiling (#433).
 */
const CODEX_MAX_RESET_DERIVED_COOLDOWN_MS = 15 * 60_000;
/** Minimum gap between probe leases for one cooled-down account. */
export const CODEX_QUOTA_PROBE_INTERVAL_MS = 5 * 60_000;
export const CODEX_FAILURE_WINDOW_MS = 5 * 60_000;
/** How long a transient failure keeps the account out of pool selection. */
export const CODEX_TRANSIENT_SOFT_AVOID_MS = 30_000;
const CODEX_TRANSIENT_SOFT_AVOID_ESCALATION_MS = [
  CODEX_TRANSIENT_SOFT_AVOID_MS,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
] as const;
export const CODEX_THREAD_AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
export const CODEX_THREAD_AFFINITY_MAX_ENTRIES = 2048;
// Min interval between quota threshold re-evaluations for a single bound thread.
// Well under the 5h/weekly quota windows, but enough to stop per-request flapping.
export const CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS = 60_000;

const upstreamHealth = new Map<string, CodexUpstreamHealth>();

export type CodexUpstreamOutcome = number | "connect_error" | "timeout";
export type CodexUpstreamOutcomeClass = "success" | "credential" | "quota" | "transient" | "caller" | "unknown";
export type CodexCooldownSource = "retry-after" | "reset-derived" | "default";
export type CodexUpstreamOutcomeMeta = {
  retryAfter?: string | null;
  resetAt?: unknown | unknown[];
  now?: number;
  /** When set, clears affinity for this thread immediately on transient failure. */
  threadId?: string | null;
  /**
   * Probe lease held by this request, when it was admitted through an active
   * quota cooldown. Only the outcome carrying the current lease may clear the
   * cooldown (#433).
   */
  probeLeaseId?: string;
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
  // 402 Payment Required is treated as quota exhaustion for pool cooldown/failover
  // (same-request alternate retry records this outcome for the depleted account).
  if (outcome === 429 || outcome === 402) return "quota";
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
    // A far-future reset must not pin the account for the full Retry-After
    // ceiling: quota usually frees up well before the advertised window (#433).
    const clamped = Math.min(clampCooldownMs(delay), CODEX_MAX_RESET_DERIVED_COOLDOWN_MS);
    if (best === undefined || clamped < best) best = clamped;
  }
  return best;
}

export function computeQuotaCooldown(meta: CodexUpstreamOutcomeMeta = {}): {
  until: number;
  source: CodexCooldownSource;
} {
  const now = meta.now ?? Date.now();
  const retryAfterMs = parseRetryAfterMs(meta.retryAfter, now);
  if (retryAfterMs !== undefined) return { until: now + retryAfterMs, source: "retry-after" };
  const resetCooldownMs = parseResetCooldownMs(meta.resetAt, now);
  if (resetCooldownMs !== undefined) return { until: now + resetCooldownMs, source: "reset-derived" };
  return { until: now + CODEX_DEFAULT_QUOTA_COOLDOWN_MS, source: "default" };
}

export function computeQuotaCooldownUntil(meta: CodexUpstreamOutcomeMeta = {}): number {
  return computeQuotaCooldown(meta).until;
}

/**
 * Grant at most one probe lease per interval for a cooled-down account.
 *
 * A cooled-down account is short-circuited locally, so it never sends traffic and
 * no organic 2xx can prove that upstream quota recovered — the cooldown can only
 * end by expiry or a proxy restart (#433). Releasing a single probe breaks that
 * deadlock. Explicit Retry-After cooldowns are excluded: those are literal retry
 * directives, not window announcements.
 *
 * Returns the lease id, or null when no probe may go out right now.
 */
export function tryAcquireCodexQuotaProbeLease(accountId: string, now = Date.now()): string | null {
  if (!canAcquireCodexQuotaProbeLease(accountId, now)) return null;
  const health = upstreamHealth.get(accountId)!;
  const probeLeaseId = randomUUID();
  upstreamHealth.set(accountId, {
    ...health,
    probeLeaseId,
    probeLeaseGeneration: health.cooldownGeneration ?? 0,
    lastProbeAt: now,
  });
  return probeLeaseId;
}

/** Side-effect-free check mirroring {@link tryAcquireCodexQuotaProbeLease} eligibility. */
export function canAcquireCodexQuotaProbeLease(accountId: string, now = Date.now()): boolean {
  const health = upstreamHealth.get(accountId);
  if (!health) return false;
  const cooldownUntil = health.cooldownUntil;
  if (typeof cooldownUntil !== "number" || !Number.isFinite(cooldownUntil) || cooldownUntil <= now) return false;
  if (health.cooldownSource === "retry-after") return false;
  if (health.probeLeaseId !== undefined) return false;
  const origin = health.lastProbeAt ?? health.cooldownSince ?? cooldownUntil;
  return now - origin >= CODEX_QUOTA_PROBE_INTERVAL_MS;
}

/**
 * Hand a probe lease back without recording an upstream outcome. Used by paths
 * that take a lease and then fail before any request reaches upstream.
 */
export function releaseCodexQuotaProbeLease(accountId: string, leaseId: string, now = Date.now()): void {
  const health = upstreamHealth.get(accountId);
  if (!health || health.probeLeaseId !== leaseId) return;
  upstreamHealth.set(accountId, withProbeLeaseReleased(health, now));
}

/**
 * True when this outcome belongs to the account's in-flight probe. The
 * undefined-id guard matters: without it an outcome carrying no lease would match
 * an account holding no lease and be mistaken for the probe owner.
 */
function ownsProbeLease(health: CodexUpstreamHealth | undefined, meta: CodexUpstreamOutcomeMeta): boolean {
  return meta.probeLeaseId !== undefined && meta.probeLeaseId === health?.probeLeaseId;
}

/**
 * True when the owning probe may still clear the cooldown. A later 429 bumps the
 * generation, so a probe that started under an older cooldown must not erase the
 * newer restriction (which may carry an explicit Retry-After).
 */
function probeMayClearCooldown(health: CodexUpstreamHealth | undefined, meta: CodexUpstreamOutcomeMeta): boolean {
  return ownsProbeLease(health, meta)
    && (health!.probeLeaseGeneration ?? 0) === (health!.cooldownGeneration ?? 0);
}

/** Strip the in-flight lease while preserving every hard-cooldown field. */
function withProbeLeaseReleased(health: CodexUpstreamHealth, now: number): CodexUpstreamHealth {
  const { probeLeaseId: _id, probeLeaseGeneration: _gen, ...rest } = health;
  return { ...rest, lastProbeAt: now };
}

/**
 * Hard-cooldown bookkeeping that ordinary success/transient transitions rebuild
 * their health object from. Dropping these would let one late unrelated response
 * erase a Retry-After source, a cooldown generation, or someone else's live probe.
 */
function preservedCooldownFields(health: CodexUpstreamHealth | undefined): Partial<CodexUpstreamHealth> {
  if (!health) return {};
  const { consecutiveFailures: _f, consecutiveSuccesses: _s, lastFailureStatus: _st, lastFailureAt: _at, softAvoidUntil: _sa, ...cooldownFields } = health;
  return cooldownFields;
}

/** Manual selection resets transient routing evidence without bypassing a real 429 cooldown. */
export function resetCodexRoutingForManualSelection(accountId: string): void {
  clearThreadAccountMap();
  const current = upstreamHealth.get(accountId);
  if (!current) return;
  const preserved = preservedCooldownFields(current);
  if (Object.keys(preserved).length === 0) upstreamHealth.delete(accountId);
  else upstreamHealth.set(accountId, { consecutiveFailures: 0, ...preserved });
}

export function getCodexAccountCooldownUntil(accountId: string, now = Date.now()): number | null {
  const cooldownUntil = upstreamHealth.get(accountId)?.cooldownUntil;
  return typeof cooldownUntil === "number" && Number.isFinite(cooldownUntil) && cooldownUntil > now ? cooldownUntil : null;
}

/** Read-only cooldown snapshot for shared OAuth health projection (no write side effects). */
export function getCodexAccountHealthSnapshot(accountId: string, now = Date.now()): {
  cooldownUntil?: number;
  cooldownSource?: CodexCooldownSource;
} | null {
  const cooldownUntil = getCodexAccountCooldownUntil(accountId, now);
  if (cooldownUntil === null) return null;
  const source = upstreamHealth.get(accountId)?.cooldownSource;
  return {
    cooldownUntil,
    ...(source ? { cooldownSource: source } : {}),
  };
}

export function isCodexAccountInCooldown(accountId: string, now = Date.now()): boolean {
  return getCodexAccountCooldownUntil(accountId, now) !== null;
}

/**
 * Manually lift a hard quota cooldown without touching failure history.
 *
 * Injected Codex routing makes this proxy the ONLY model path for Codex Desktop, so a
 * cooldown that outlives the real upstream limit reads to the user as "the whole app is
 * broken" with no escape but editing config.toml. This is that escape hatch.
 *
 * Deliberately narrow:
 * - Failure counters and softAvoid survive. Clearing a cooldown says "the quota window
 *   moved", not "this account is healthy"; failover must keep its knowledge.
 * - Dropping `probeLeaseId` is what stops a stale in-flight probe from later "proving"
 *   recovery against a NEWER cooldown: {@link ownsProbeLease} needs the id to match.
 *   `cooldownGeneration` is preserved and bumped as redundancy only — a fresh 429 already
 *   bumps it in {@link recordCodexUpstreamOutcome}, so the bump here is not load-bearing
 *   today and is kept so the invariant survives a future change that retains the lease.
 *
 * Returns false when the account carried no live cooldown (already expired or never set).
 */
export function clearCodexAccountCooldown(accountId: string, now = Date.now()): boolean {
  const health = upstreamHealth.get(accountId);
  if (!health) return false;
  const cooldownUntil = health.cooldownUntil;
  if (typeof cooldownUntil !== "number" || !Number.isFinite(cooldownUntil) || cooldownUntil <= now) return false;
  const {
    cooldownUntil: _until,
    cooldownSince: _since,
    cooldownSource: _source,
    probeLeaseId: _leaseId,
    probeLeaseGeneration: _leaseGeneration,
    ...rest
  } = health;
  upstreamHealth.set(accountId, {
    ...rest,
    cooldownGeneration: (health.cooldownGeneration ?? 0) + 1,
    lastProbeAt: now,
  });
  return true;
}

export function getCodexAccountSoftAvoidUntil(accountId: string, now = Date.now()): number | null {
  const softAvoidUntil = upstreamHealth.get(accountId)?.softAvoidUntil;
  return typeof softAvoidUntil === "number" && Number.isFinite(softAvoidUntil) && softAvoidUntil > now
    ? softAvoidUntil
    : null;
}

export function isCodexAccountSoftAvoided(accountId: string, now = Date.now()): boolean {
  return getCodexAccountSoftAvoidUntil(accountId, now) !== null;
}

function isCodexAccountSelectable(config: OcxConfig, accountId: string, now: number): boolean {
  return !isCodexAccountInCooldown(accountId, now)
    && !isCodexAccountSoftAvoided(accountId, now)
    && isCodexAccountUsable(config, accountId);
}

function isThreadAffinityExpired(entry: ThreadAffinityEntry, now: number): boolean {
  return now - entry.lastUsedAt > CODEX_THREAD_AFFINITY_IDLE_TTL_MS;
}

function isThreadAffinityGenerationLive(entry: ThreadAffinityEntry): boolean {
  if (entry.accountId === MAIN_CODEX_ACCOUNT_ID) return entry.generation === 0;
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
  const record = accountId === MAIN_CODEX_ACCOUNT_ID ? undefined : readCodexAccountRecord(accountId);
  if (accountId !== MAIN_CODEX_ACCOUNT_ID && (!record?.credential || record.deletedAt != null)) return;
  pruneExpiredThreadAffinities(now);
  const previous = threadAccountMap.get(threadId);
  threadAccountMap.set(threadId, {
    accountId,
    generation: accountId === MAIN_CODEX_ACCOUNT_ID ? 0 : record!.generation,
    createdAt: previous?.createdAt ?? now,
    lastUsedAt: now,
    lastReevalAt: now,
  });
  pruneLruThreadAffinities();
}

function getEligiblePoolAccounts(config: OcxConfig, excludeId?: string, now = Date.now()): string[] {
  const ids = (config.codexAccounts ?? [])
    .filter(account => !account.isMain && account.id !== excludeId && !isAccountNeedsReauth(account.id))
    .filter(account => !isCodexAccountInCooldown(account.id, now))
    .filter(account => !isCodexAccountSoftAvoided(account.id, now))
    .filter(account => isCodexAccountUsable(config, account.id))
    .map(account => account.id);
  // The main Codex account is not stored in config.codexAccounts; include it as a
  // first-class rotation candidate when its read-only token is usable (Option A).
  if (
    excludeId !== MAIN_CODEX_ACCOUNT_ID
    && !isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)
    && !isCodexAccountInCooldown(MAIN_CODEX_ACCOUNT_ID, now)
    && !isCodexAccountSoftAvoided(MAIN_CODEX_ACCOUNT_ID, now)
    && isCodexAccountUsable(config, MAIN_CODEX_ACCOUNT_ID)
  ) {
    ids.unshift(MAIN_CODEX_ACCOUNT_ID);
  }
  return ids;
}

export function getPoolAccountPlan(config: OcxConfig, accountId: string): string | undefined {
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
  saveConfigPreservingClaudeCode(config);
}

function isUnknownUsage(usage: number): boolean {
  return usage >= CODEX_UNKNOWN_USAGE_SCORE;
}

function applyQuotaAutoSwitch(config: OcxConfig, active: string, now: number): string {
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold <= 0) return active;
  const quota = getAccountQuota(active);
  const activeUsage = computeCodexUsageScore(quota, getPoolAccountPlan(config, active));
  // Unknown usage is not evidence that a user's explicit selection crossed the
  // threshold. Wait for quota priming instead of rotating among guesses.
  if (isUnknownUsage(activeUsage)) return active;
  if (activeUsage < threshold) return active;
  const best = pickLowerUsageAccount(config, active, activeUsage, now);
  if (best !== active) {
    setActiveCodexAccount(config, best);
    return best;
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

/**
 * Side-effect-free preview of the Codex pool account native routing would prefer.
 * Used for subagent fallback quota decisions before final auth.
 *
 * Does not mutate activeCodexAccountId, thread affinity, config on disk, or probe leases.
 * Mirrors {@link resolveCodexAccountForThreadDetailed} account choice, including returning a
 * configured cooled account so callers can evaluate probe/quota availability.
 */
export function previewCodexAccountForRequest(
  threadId: string | null,
  config: OcxConfig,
  now = Date.now(),
): string | null {
  if (threadId && threadAccountMap.has(threadId)) {
    const entry = threadAccountMap.get(threadId)!;
    if (
      !isThreadAffinityExpired(entry, now)
      && isThreadAffinityGenerationLive(entry)
      && isCodexAccountSelectable(config, entry.accountId, now)
      && !shouldFailover(config, entry.accountId, now)
    ) {
      const threshold = config.autoSwitchThreshold ?? 80;
      if (threshold > 0) {
        const usage = computeCodexUsageScore(
          getAccountQuota(entry.accountId),
          getPoolAccountPlan(config, entry.accountId),
        );
        if (!isUnknownUsage(usage) && usage >= threshold) {
          const best = pickLowerUsageAccount(config, entry.accountId, usage, now);
          if (best !== entry.accountId) return best;
        }
      }
      return entry.accountId;
    }
    // Stale/unusable affinity is ignored for preview (no map mutation).
  }

  let active = config.activeCodexAccountId ?? null;
  if (!active) {
    return pickLowestUsageCodexAccount(config, undefined, now);
  }
  if (!isCodexAccountSelectable(config, active, now)) {
    const fallback = pickLowestUsageCodexAccount(config, active, now);
    if (fallback) active = fallback;
    else if (hasConfiguredPoolAccount(config, active)) return active;
    else return null;
  }

  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold > 0) {
    const usage = computeCodexUsageScore(getAccountQuota(active), getPoolAccountPlan(config, active));
    if (!isUnknownUsage(usage) && usage >= threshold) {
      active = pickLowerUsageAccount(config, active, usage, now);
    }
  }
  if (shouldFailover(config, active, now)) {
    const best = pickLowestUsageCodexAccount(config, active, now);
    if (best) active = best;
  }
  if (!isCodexAccountUsable(config, active)) {
    return hasConfiguredPoolAccount(config, active) ? active : null;
  }
  if (isCodexAccountInCooldown(active, now)) {
    return hasConfiguredPoolAccount(config, active) ? active : null;
  }
  return active;
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
      // Affined threads must leave a failing account once the streak trips failover
      // (soft-avoid covers the first-hit case; this catches post-avoid residual streaks).
      && !shouldFailover(config, entry.accountId, now)
    ) {
      entry.lastUsedAt = now;
      // Periodic quota re-eval: a long-lived bound thread must still switch when
      // it crosses autoSwitchThreshold and a strictly-cooler account exists.
      // Without this the reuse branch returns before applyQuotaAutoSwitch and the
      // thread stays pinned for the full idle TTL (the WSL "never switches" report).
      // Over-threshold pins re-eval immediately so a depleted primary does not keep
      // serving for up to 60s after a secondary with quota is available (#584).
      const threshold = config.autoSwitchThreshold ?? 80;
      const usage = threshold > 0
        ? computeCodexUsageScore(
          getAccountQuota(entry.accountId),
          getPoolAccountPlan(config, entry.accountId),
        )
        : 0;
      const overThreshold = threshold > 0 && !isUnknownUsage(usage) && usage >= threshold;
      if (overThreshold || now - entry.lastReevalAt >= CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS) {
        entry.lastReevalAt = now;
        if (overThreshold) {
          const best = pickLowerUsageAccount(config, entry.accountId, usage, now);
          if (best !== entry.accountId) {
            setActiveCodexAccount(config, best);
            bindThreadAffinity(threadId, best, now); // rebinds + resets clocks
            return { status: "selected", accountId: best };
          }
        }
      }
      return { status: "selected", accountId: entry.accountId };
    }
    threadAccountMap.delete(threadId);
  }
  let active = config.activeCodexAccountId;
  if (!active) {
    const selected = pickLowestUsageCodexAccount(config, undefined, now);
    if (!selected) return { status: "none" };
    setActiveCodexAccount(config, selected);
    active = selected;
  }
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
    const current = upstreamHealth.get(accountId);
    const cooldownUntil = getCodexAccountCooldownUntil(accountId, now);
    // A leased probe that is still on its own cooldown generation proves the
    // account recovered: clear the hard cooldown outright (#433).
    if (cooldownUntil && probeMayClearCooldown(current, meta)) {
      upstreamHealth.delete(accountId);
      return;
    }
    // Owning probe on a stale generation: the lease is done, but a newer 429
    // replaced the cooldown in the meantime, so only give the lease back.
    // Non-owners keep every hard-cooldown field, including someone else's live lease.
    const base = ownsProbeLease(current, meta) ? withProbeLeaseReleased(current!, now) : current;
    const preserved = preservedCooldownFields(base);
    const failoverEnabled = (config.upstreamFailoverThreshold ?? 3) > 0;
    if (failoverEnabled && current && current.consecutiveFailures >= 2) {
      const consecutiveSuccesses = (current.consecutiveSuccesses ?? 0) + 1;
      if (consecutiveSuccesses < 2) {
        upstreamHealth.set(accountId, {
          ...base!,
          ...preserved,
          consecutiveSuccesses,
        });
        return;
      }
    }
    // Level 1 clears immediately; escalated accounts need two consecutive healthy terminals.
    // Hard quota cooldown intentionally survives either recovery path.
    if (cooldownUntil) upstreamHealth.set(accountId, { consecutiveFailures: 0, ...preserved });
    else upstreamHealth.delete(accountId);
    return;
  }
  if (outcomeClass === "caller") {
    // A 4xx does not change account health, but it does conclude an in-flight
    // probe — otherwise the lease would never be handed back.
    const current = upstreamHealth.get(accountId);
    if (ownsProbeLease(current, meta)) {
      upstreamHealth.set(accountId, withProbeLeaseReleased(current!, now));
    }
    return;
  }

  const lastFailureStatus = typeof outcome === "number" ? outcome : 0;
  if (outcomeClass === "credential") {
    // 401/403 quarantines the account for reauth. That supersedes quota state
    // entirely: a cooldown (and any probe lease) on an unusable account is moot.
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
    const prior = upstreamHealth.get(accountId);
    const { until, source } = computeQuotaCooldown(meta);
    // Every cooldown write bumps the generation so a probe issued against the
    // previous cooldown can no longer clear this one (#433).
    const cooldownGeneration = (prior?.cooldownGeneration ?? 0) + 1;
    // A failed probe concludes its lease; an unrelated 429 leaves the live probe alone.
    const ownsLease = ownsProbeLease(prior, meta);
    upstreamHealth.set(accountId, {
      consecutiveFailures: 0,
      lastFailureStatus,
      lastFailureAt: now,
      cooldownUntil: until,
      cooldownSince: now,
      cooldownSource: source,
      cooldownGeneration,
      ...(ownsLease
        ? { lastProbeAt: now }
        : {
          ...(prior?.probeLeaseId !== undefined ? { probeLeaseId: prior.probeLeaseId } : {}),
          ...(prior?.probeLeaseGeneration !== undefined ? { probeLeaseGeneration: prior.probeLeaseGeneration } : {}),
          ...(prior?.lastProbeAt !== undefined ? { lastProbeAt: prior.lastProbeAt } : {}),
        }),
    });
    clearThreadAccountMapForAccount(accountId);
    if (config.activeCodexAccountId === accountId) {
      const fallback = pickLowestUsageCodexAccount(config, accountId, now);
      if (fallback) setActiveCodexAccount(config, fallback);
    }
    return;
  }

  // transient (connect_error / timeout / 5xx)
  const current = upstreamHealth.get(accountId);
  // A transient failure concludes an owning probe; an unrelated 5xx must not
  // consume someone else's live lease or drop hard-cooldown bookkeeping (#433).
  const transientBase = ownsProbeLease(current, meta) ? withProbeLeaseReleased(current!, now) : current;
  const stale = current?.lastFailureAt ? now - current.lastFailureAt > CODEX_FAILURE_WINDOW_MS : false;
  const hardCooldownUntil = getCodexAccountCooldownUntil(accountId, now) ?? undefined;
  // Soft avoid + affinity clears are part of failover. When threshold is 0, leave
  // sticky sessions alone (same as shouldFailover / applyFailureFailover no-ops).
  const failoverThreshold = config.upstreamFailoverThreshold ?? 3;
  const consecutiveFailures = stale ? 1 : (current?.consecutiveFailures ?? 0) + 1;
  const failoverReady = failoverThreshold > 0 && consecutiveFailures >= failoverThreshold;
  const escalationMs = CODEX_TRANSIENT_SOFT_AVOID_ESCALATION_MS[
    Math.min(Math.max(consecutiveFailures - failoverThreshold, 0), CODEX_TRANSIENT_SOFT_AVOID_ESCALATION_MS.length - 1)
  ]!;
  const softAvoidUntil = failoverReady
    ? Math.max(
      getCodexAccountSoftAvoidUntil(accountId, now) ?? 0,
      now + escalationMs,
    )
    : undefined;
  upstreamHealth.set(accountId, {
    ...preservedCooldownFields(transientBase),
    consecutiveFailures,
    lastFailureStatus,
    lastFailureAt: now,
    ...(hardCooldownUntil ? { cooldownUntil: hardCooldownUntil } : {}),
    ...(softAvoidUntil !== undefined ? { softAvoidUntil } : {}),
  });
  // Drop this thread's pin immediately so the next continue can rebind without
  // waiting for the soft-avoid selectable check. Guard: only delete when the
  // thread is still pinned to the FAILING account — a late failure from account A
  // must not delete a newer healthy binding to account B (race: T→A, A fails,
  // T→B, late A failure must not delete B's mapping).
  if (failoverReady && meta.threadId) {
    const bound = threadAccountMap.get(meta.threadId);
    if (bound?.accountId === accountId) threadAccountMap.delete(meta.threadId);
  }
  // Once the account is past the failover streak, clear every thread still pinned
  // to it — matching 429 affinity behavior so "continue" cannot stay on a bad peer.
  if (shouldFailover(config, accountId, now)) {
    clearThreadAccountMapForAccount(accountId);
  }
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
