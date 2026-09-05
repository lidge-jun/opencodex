/**
 * Google Antigravity OAuth account pool.
 *
 * Automatically rotates across configured Google Antigravity OAuth accounts:
 * - Sticky session affinity across requests that share a session key
 * - 429 / quota limit / ResourceExhausted cools the failed account and fails over to another eligible account
 * - New sessions use `strategy` (default fill-first / round-robin / lowest quota)
 *
 * Cooldown uses Retry-After when present, otherwise a default backoff.
 */
import { createHash } from "node:crypto";
import { setActiveAccount, getAccountSet, getAccountCredential } from "./store";
import { getCachedProviderAccountQuota } from "../providers/quota";
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import {
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  notePoolRotationFailure,
  notePoolRotationSuccess,
  pickRoundRobinAccount,
  POOL_KEY_ANTIGRAVITY,
  seedPoolRotationAccount,
} from "../codex/pool-rotation";
import type { OcxAccountPoolRotationStrategy, OcxConfig } from "../types";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";
import { retainedUtf8Bytes } from "../lib/admission";

const PROVIDER = "google-antigravity";
const DEFAULT_COOLDOWN_MS = 180_000; // 3 minutes for transient rate limits
const MAX_COOLDOWN_MS = 60 * 60_000; // 1 hour max
const DEFAULT_HARD_QUOTA_COOLDOWN_MS = 60 * 60_000; // hard quota with no reset hint
const MAX_HARD_QUOTA_COOLDOWN_MS = 24 * 60 * 60_000;
const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 2_000;
const MAX_AFFINITY_COMPONENT_BYTES = 512;
const UNKNOWN_USAGE_SCORE = 100;
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;
/** Cap same-request 429 rotations so short Retry-After cannot infinite-loop. */
export const ANTIGRAVITY_POOL_MAX_FAILOVERS_PER_REQUEST = 5;

export interface AntigravityAccountPoolConfig {
  enabled?: boolean;
  /** Usage % for new-session pick. Default 80. 0 = disable quota-based pick (active / affinity only). */
  autoSwitchThreshold?: number;
  /** New-session rotation strategy. Default fill-first. */
  strategy?: OcxAccountPoolRotationStrategy;
  /** Successful new-session binds retained on one round-robin selection. Default 1; range 1..100. */
  stickyLimit?: number;
}

interface AccountHealth {
  cooldownUntil: number;
  cooldownSource: "retry-after" | "quota-reset" | "quota-default" | "default";
}

interface AffinityEntry {
  accountId: string;
  lastUsedAt: number;
}

const upstreamHealth = new Map<string, AccountHealth>();
const sessionAffinity = new Map<string, AffinityEntry>();

function asTrimmedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAffinityComponent(value: string | null | undefined): string {
  const normalized = asTrimmedText(value);
  return normalized && retainedUtf8Bytes(normalized) <= MAX_AFFINITY_COMPONENT_BYTES ? normalized : "";
}

export function antigravityAccountPoolConfig(config: OcxConfig): AntigravityAccountPoolConfig {
  const raw = config.antigravityAccountPool ?? (config as unknown as Record<string, unknown>).googleAntigravityAccountPool;
  if (!raw || typeof raw !== "object") return {};
  return raw as AntigravityAccountPoolConfig;
}

export function isAntigravityAccountPoolEnabled(config: OcxConfig): boolean {
  const cfg = antigravityAccountPoolConfig(config);
  if (cfg.enabled !== undefined) return cfg.enabled === true;
  // Enabled by default if more than one account exists
  const set = getAccountSet(PROVIDER);
  return Boolean(set && set.accounts.length > 1);
}

export function antigravityAutoSwitchThreshold(config: OcxConfig): number {
  const value = antigravityAccountPoolConfig(config).autoSwitchThreshold;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) return value;
  return DEFAULT_AUTO_SWITCH_THRESHOLD;
}

function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const text = asTrimmedText(value);
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? Math.min(delay, MAX_COOLDOWN_MS) : undefined;
}

function parseQuotaResetHintMs(value: string | null | undefined): number | undefined {
  const text = asTrimmedText(value);
  if (!text) return undefined;
  const match = /resets?\s+in\s+(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(text);
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const delay = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  if (!Number.isFinite(delay) || delay <= 0) return undefined;
  // Leave a small guard beyond Google's displayed whole-second reset countdown.
  return Math.min(delay + 5_000, MAX_HARD_QUOTA_COOLDOWN_MS);
}

function isHardQuotaError(value: string | null | undefined): boolean {
  const text = value?.toLowerCase() ?? "";
  return text.includes("individual quota reached")
    || text.includes("quota exhausted")
    || text.includes("quota exceeded")
    || text.includes("upgrade your subscription");
}

function isAccountVerificationError(value: string | null | undefined): boolean {
  const text = value?.toLowerCase() ?? "";
  return text.includes("verify your account")
    || text.includes("access denied")
    || text.includes("permission denied");
}

export function getAntigravityAccountHealthSnapshot(
  accountId: string,
  now = Date.now(),
): { cooldownUntil?: number; cooldownSource?: AccountHealth["cooldownSource"] } | null {
  const entry = upstreamHealth.get(accountId);
  if (!entry) return null;
  if (entry.cooldownUntil <= now) {
    upstreamHealth.delete(accountId);
    return null;
  }
  return { cooldownUntil: entry.cooldownUntil, cooldownSource: entry.cooldownSource };
}

export function clearAntigravityAccountCooldown(accountId: string): boolean {
  return upstreamHealth.delete(accountId);
}

export function sweepExpiredAntigravityRoutingHealth(now = Date.now()): number {
  let removed = 0;
  for (const [accountId, health] of upstreamHealth) {
    if (health.cooldownUntil > now) continue;
    upstreamHealth.delete(accountId);
    removed += 1;
  }
  return removed;
}

/** Test / logout helper. */
export function clearAntigravityAccountPoolState(): void {
  upstreamHealth.clear();
  sessionAffinity.clear();
}

export function antigravitySessionAffinitySizeForTests(): number {
  return sessionAffinity.size;
}

function isCooled(accountId: string, now: number): boolean {
  return getAntigravityAccountHealthSnapshot(accountId, now) !== null;
}

function hasKnownUsage(accountId: string): boolean {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  return typeof quota?.fiveHourPercent === "number" && Number.isFinite(quota.fiveHourPercent);
}

function usageScore(accountId: string): number {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  if (!quota || typeof quota.fiveHourPercent !== "number" || !Number.isFinite(quota.fiveHourPercent)) {
    return UNKNOWN_USAGE_SCORE;
  }
  return Math.max(0, Math.min(100, quota.fiveHourPercent));
}

function isPoolCredentialUsable(accountId: string, _now: number): boolean {
  const cred = getAccountCredential(PROVIDER, accountId);
  if (!cred) return false;
  return Boolean(cred.access || cred.refresh);
}

export function getEligibleAntigravityAccounts(now = Date.now()): string[] {
  const set = getAccountSet(PROVIDER);
  if (!set) return [];
  return set.accounts
    .filter(account =>
      account.needsReauth !== true
      && !isCooled(account.id, now)
      && isPoolCredentialUsable(account.id, now))
    .map(account => account.id);
}

/** Earliest remaining cooldown among cooled Antigravity accounts, for client Retry-After. */
export function getAntigravityPoolRetryAfterSeconds(now = Date.now()): number | null {
  const set = getAccountSet(PROVIDER);
  if (!set) return null;
  let earliest: number | null = null;
  for (const account of set.accounts) {
    const snap = getAntigravityAccountHealthSnapshot(account.id, now);
    if (!snap?.cooldownUntil) continue;
    if (earliest === null || snap.cooldownUntil < earliest) earliest = snap.cooldownUntil;
  }
  if (earliest === null || earliest <= now) return null;
  return Math.max(1, Math.ceil((earliest - now) / 1000));
}

function pickLowestUsage(excludeId: string | undefined, now: number): string | null {
  const eligible = getEligibleAntigravityAccounts(now).filter(id => id !== excludeId);
  if (eligible.length === 0) return null;
  let best = eligible[0]!;
  let bestScore = usageScore(best);
  for (let i = 1; i < eligible.length; i++) {
    const id = eligible[i]!;
    const score = usageScore(id);
    if (score < bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

/** Next eligible Antigravity account in stable order after `afterId` (wrapping). */
function pickNextFillFirstAntigravityAccount(
  config: OcxConfig,
  afterId: string,
  eligible: string[],
): string | null {
  if (eligible.length === 0) return null;
  const ordered = [...eligible].sort((a, b) => a.localeCompare(b));
  const set = getAccountSet(PROVIDER);
  const stableAll = set
    ? [...set.accounts.map(a => a.id)].sort((a, b) => a.localeCompare(b))
    : ordered;
  const startIdx = stableAll.indexOf(afterId);
  if (startIdx < 0) {
    for (const id of ordered) {
      if (isActiveUnderFillFirstThreshold(config, id)) return id;
    }
    return ordered[0] ?? null;
  }
  let fallback: string | null = null;
  for (let step = 1; step <= stableAll.length; step++) {
    const candidate = stableAll[(startIdx + step) % stableAll.length]!;
    if (!eligible.includes(candidate)) continue;
    if (!fallback) fallback = candidate;
    if (isActiveUnderFillFirstThreshold(config, candidate)) return candidate;
  }
  return fallback ?? ordered[0] ?? null;
}

function pickAlternateAntigravityAccount(
  config: OcxConfig,
  excludeId: string,
  now: number,
): string | null {
  const strategy = antigravityPoolStrategy(config);
  const eligible = getEligibleAntigravityAccounts(now).filter(id => id !== excludeId);
  if (strategy === "round-robin") {
    return pickRoundRobinAccount(POOL_KEY_ANTIGRAVITY, eligible, stickyLimitForPool(config));
  }
  if (strategy === "fill-first") {
    return pickNextFillFirstAntigravityAccount(config, excludeId, eligible);
  }
  return pickLowestUsage(excludeId, now);
}

function pruneExpiredAffinity(now: number): void {
  for (const [key, entry] of sessionAffinity) {
    if (now - entry.lastUsedAt > AFFINITY_IDLE_TTL_MS) sessionAffinity.delete(key);
  }
  if (sessionAffinity.size <= MAX_AFFINITY_ENTRIES) return;
  const sorted = [...sessionAffinity.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  const drop = sessionAffinity.size - MAX_AFFINITY_ENTRIES;
  for (let i = 0; i < drop; i++) sessionAffinity.delete(sorted[i]![0]);
}

export type AntigravityAccountSelectionReason =
  | "pool-disabled"
  | "affinity"
  | "active"
  | "lowest-usage"
  | "only-eligible"
  | "round-robin"
  | "fill-first"
  | "none"
  | "all-cooled";

export interface AntigravityAccountSelection {
  accountId: string | null;
  reason: AntigravityAccountSelectionReason;
}

function stickyLimitForPool(config: OcxConfig): number {
  return normalizeAccountPoolStickyLimit(antigravityAccountPoolConfig(config).stickyLimit);
}

function antigravityPoolStrategy(config: OcxConfig): OcxAccountPoolRotationStrategy {
  return normalizeAccountPoolStrategy(antigravityAccountPoolConfig(config).strategy ?? "fill-first");
}

function isActiveUnderFillFirstThreshold(config: OcxConfig, accountId: string): boolean {
  const threshold = antigravityAutoSwitchThreshold(config);
  if (threshold <= 0) return true;
  if (!hasKnownUsage(accountId)) return true;
  return usageScore(accountId) < threshold;
}

function pickFillFirstAntigravityAccount(config: OcxConfig, now: number): string | null {
  const eligible = getEligibleAntigravityAccounts(now);
  if (eligible.length === 0) return null;

  const set = getAccountSet(PROVIDER);
  const active = set?.activeAccountId;
  if (active && eligible.includes(active) && isActiveUnderFillFirstThreshold(config, active)) {
    return active;
  }

  if (!active || !set) {
    const ordered = [...eligible].sort((a, b) => a.localeCompare(b));
    for (const id of ordered) {
      if (isActiveUnderFillFirstThreshold(config, id)) return id;
    }
    return ordered[0] ?? null;
  }

  return pickNextFillFirstAntigravityAccount(config, active, eligible);
}

function pickUnboundStrategyAccount(
  config: OcxConfig,
  now: number,
): { accountId: string; reason: "round-robin" | "fill-first" } | null {
  const strategy = antigravityPoolStrategy(config);
  if (strategy === "quota") return null;

  if (strategy === "round-robin") {
    const eligible = getEligibleAntigravityAccounts(now);
    const limit = stickyLimitForPool(config);
    const picked = pickRoundRobinAccount(POOL_KEY_ANTIGRAVITY, eligible, limit);
    if (!picked) return null;
    notePoolRotationSuccess(POOL_KEY_ANTIGRAVITY, picked, limit);
    return { accountId: picked, reason: "round-robin" };
  }

  if (strategy === "fill-first") {
    const picked = pickFillFirstAntigravityAccount(config, now);
    if (!picked) return null;
    return { accountId: picked, reason: "fill-first" };
  }

  return null;
}

export function resolveAntigravityAccountForSession(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  now = Date.now(),
): AntigravityAccountSelection {
  pruneExpiredAffinity(now);
  const set = getAccountSet(PROVIDER);
  if (!set || set.accounts.length === 0) return { accountId: null, reason: "none" };

  if (!isAntigravityAccountPoolEnabled(config)) {
    return { accountId: set.activeAccountId, reason: "pool-disabled" };
  }

  const key = normalizeAffinityComponent(sessionKey);
  if (key) {
    const affined = sessionAffinity.get(key);
    if (affined && now - affined.lastUsedAt <= AFFINITY_IDLE_TTL_MS) {
      const stillThere = set.accounts.some(a => a.id === affined.accountId && a.needsReauth !== true);
      if (stillThere && !isCooled(affined.accountId, now) && isPoolCredentialUsable(affined.accountId, now)) {
        affined.lastUsedAt = now;
        return { accountId: affined.accountId, reason: "affinity" };
      }
      sessionAffinity.delete(key);
    }
  }

  const strategy = antigravityPoolStrategy(config);
  if (!key && (strategy === "round-robin" || strategy === "fill-first")) {
    const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
      && !isCooled(set.activeAccountId, now)
      && isPoolCredentialUsable(set.activeAccountId, now);
    if (activeOk) {
      return { accountId: set.activeAccountId, reason: "active" };
    }
  }

  const strategyPick = pickUnboundStrategyAccount(config, now);
  if (strategyPick) {
    if (key && normalizeAffinityComponent(strategyPick.accountId)) {
      sessionAffinity.set(key, { accountId: strategyPick.accountId, lastUsedAt: now });
      pruneExpiredAffinity(now);
    }
    return { accountId: strategyPick.accountId, reason: strategyPick.reason };
  }

  const threshold = antigravityAutoSwitchThreshold(config);
  const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
    && !isCooled(set.activeAccountId, now)
    && isPoolCredentialUsable(set.activeAccountId, now);

  let accountId: string | null = null;
  let reason: AntigravityAccountSelectionReason = "none";

  if (threshold > 0) {
    if (activeOk && (!hasKnownUsage(set.activeAccountId) || usageScore(set.activeAccountId) < threshold)) {
      accountId = set.activeAccountId;
      reason = "active";
    } else {
      const picked = pickLowestUsage(undefined, now);
      if (picked) {
        accountId = picked;
        reason = activeOk && picked === set.activeAccountId ? "active" : "lowest-usage";
      } else if (activeOk) {
        accountId = set.activeAccountId;
        reason = "active";
      }
    }
  } else if (activeOk) {
    accountId = set.activeAccountId;
    reason = "active";
  } else {
    const picked = pickLowestUsage(set.activeAccountId, now);
    if (picked) {
      accountId = picked;
      reason = "only-eligible";
    }
  }

  if (!accountId) {
    const anyCooled = set.accounts.some(a => isCooled(a.id, now));
    return { accountId: null, reason: anyCooled ? "all-cooled" : "none" };
  }

  if (key && normalizeAffinityComponent(accountId)) {
    sessionAffinity.set(key, { accountId, lastUsedAt: now });
    pruneExpiredAffinity(now);
  }
  return { accountId, reason };
}

export function bindAntigravitySessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  const key = normalizeAffinityComponent(sessionKey);
  if (!key || !normalizeAffinityComponent(accountId)) return;
  sessionAffinity.set(key, { accountId, lastUsedAt: now });
  pruneExpiredAffinity(now);
}

export function clearAntigravitySessionAffinityForAccount(accountId: string): void {
  for (const [key, entry] of sessionAffinity) {
    if (entry.accountId === accountId) sessionAffinity.delete(key);
  }
}

export function rotateAntigravityAccountOn429(
  config: OcxConfig,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  sessionKey?: string | null,
  now = Date.now(),
  errorText?: string | null,
): string | null {
  if (!isAntigravityAccountPoolEnabled(config)) return null;

  const parsedRetry = parseRetryAfterMs(retryAfterHeader, now);
  const quotaReset = parseQuotaResetHintMs(errorText);
  const hardQuota = quotaReset !== undefined || isHardQuotaError(errorText);
  const verification = isAccountVerificationError(errorText);
  const cooldownMs = verification
    ? DEFAULT_HARD_QUOTA_COOLDOWN_MS
    : quotaReset
    ?? parsedRetry
    ?? (hardQuota ? DEFAULT_HARD_QUOTA_COOLDOWN_MS : DEFAULT_COOLDOWN_MS);
  upstreamHealth.set(failedAccountId, {
    cooldownUntil: now + cooldownMs,
    cooldownSource: verification
      ? "quota-default"
      : quotaReset !== undefined
      ? "quota-reset"
      : parsedRetry !== undefined
        ? "retry-after"
        : hardQuota
          ? "quota-default"
          : "default",
  });
  sweepExpiredOnWrite(now);
  clearAntigravitySessionAffinityForAccount(failedAccountId);
  notePoolRotationFailure(POOL_KEY_ANTIGRAVITY, failedAccountId);

  const next = pickAlternateAntigravityAccount(config, failedAccountId, now);
  if (!next) {
    console.warn("[antigravity-pool] all eligible Google Antigravity accounts are in cooldown; returning 429");
    return null;
  }

  const affinityKey = normalizeAffinityComponent(sessionKey);
  if (affinityKey && normalizeAffinityComponent(next)) {
    sessionAffinity.set(affinityKey, { accountId: next, lastUsedAt: now });
    pruneExpiredAffinity(now);
  }
  console.warn(
    "[antigravity-pool] 429/quota on " + formatAntigravityAccountOrdinal(failedAccountId)
      + "; cooldown=" + Math.ceil(cooldownMs / 1000) + "s; failing over to "
      + formatAntigravityAccountOrdinal(next),
  );
  return next;
}

export function promoteAntigravityActiveAccount(accountId: string): void {
  void setActiveAccount(PROVIDER, accountId).catch(() => { /* best-effort */ });
}

export function resetAntigravityRoutingForManualSelection(accountId: string): void {
  sessionAffinity.clear();
  seedPoolRotationAccount(POOL_KEY_ANTIGRAVITY, accountId);
}

export async function getAntigravityPoolAccessSnapshot(
  accountId: string,
): Promise<{ accessToken: string; projectId?: string; accountId: string; generation: string }> {
  const { resolveAccessSnapshotForAccount } = await import("./index");
  const snap = await resolveAccessSnapshotForAccount(PROVIDER, accountId);
  return {
    accessToken: snap.accessToken,
    projectId: snap.projectId,
    accountId: snap.accountId,
    generation: snap.generation,
  };
}

export function formatAntigravityAccountOrdinal(accountId: string): string {
  return fallbackCodexAccountLogLabel(accountId);
}

export function formatAntigravityProviderForLog(
  providerName: string,
  accountId: string | null | undefined,
  _config?: OcxConfig,
): string {
  if (!accountId) return providerName;
  return providerName + "-" + formatAntigravityAccountOrdinal(accountId);
}

export function antigravitySessionKeyFromParts(input: {
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  promptCacheKey?: string | null;
  clientThreadId?: string | null;
  promptCacheKeyIsSharedCohort?: boolean;
}): string | null {
  const preferred = (
    input.clientThreadId
    ?? input.sessionIdHeader
    ?? input.threadIdHeader
    ?? ""
  ).trim();
  if (preferred) {
    return preferred.length <= 128 ? preferred : createHash("sha256").update(preferred).digest("hex");
  }
  if (input.promptCacheKeyIsSharedCohort) return null;
  const cacheKey = input.promptCacheKey?.trim() ?? "";
  if (!cacheKey) return null;
  return cacheKey.length <= 128 ? cacheKey : createHash("sha256").update(cacheKey).digest("hex");
}
