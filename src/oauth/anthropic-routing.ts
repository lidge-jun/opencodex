/**
 * Opt-in Anthropic OAuth account pool (#294).
 *
 * Default OFF. When enabled:
 * - Sticky session affinity across requests that share a session key
 * - 429 cools the failed account and fails over to another eligible account
 * - New sessions prefer the lowest known fiveHour usage (#493 cache) when above threshold
 *
 * Intentionally narrower than the Codex pool: no mid-session quota rotation,
 * soft-avoid ladders, or probe leases. Anthropic OAuth is ToS-sensitive.
 */
import { createHash } from "node:crypto";
import { setActiveAccount, getAccountSet } from "./store";
import { getCachedProviderAccountQuota } from "../providers/quota";
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import type { OcxConfig } from "../types";

const PROVIDER = "anthropic";
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
const UNKNOWN_USAGE_SCORE = 100;
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;

export interface AnthropicAccountPoolConfig {
  enabled?: boolean;
  /** Usage % for new-session pick. Default 80. 0 = disable quota-based pick (active / affinity only). */
  autoSwitchThreshold?: number;
}

interface AccountHealth {
  cooldownUntil: number;
  cooldownSource: "retry-after" | "default";
}

interface AffinityEntry {
  accountId: string;
  lastUsedAt: number;
}

const upstreamHealth = new Map<string, AccountHealth>();
const sessionAffinity = new Map<string, AffinityEntry>();

export function anthropicAccountPoolConfig(config: OcxConfig): AnthropicAccountPoolConfig {
  const raw = config.anthropicAccountPool;
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

export function isAnthropicAccountPoolEnabled(config: OcxConfig): boolean {
  return anthropicAccountPoolConfig(config).enabled === true;
}

export function anthropicAutoSwitchThreshold(config: OcxConfig): number {
  const value = anthropicAccountPoolConfig(config).autoSwitchThreshold;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) return value;
  return DEFAULT_AUTO_SWITCH_THRESHOLD;
}

function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
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

export function getAnthropicAccountHealthSnapshot(
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

export function clearAnthropicAccountCooldown(accountId: string): boolean {
  return upstreamHealth.delete(accountId);
}

/** Test / logout helper. */
export function clearAnthropicAccountPoolState(): void {
  upstreamHealth.clear();
  sessionAffinity.clear();
}

function isCooled(accountId: string, now: number): boolean {
  return getAnthropicAccountHealthSnapshot(accountId, now) !== null;
}

function usageScore(accountId: string): number {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  if (!quota || typeof quota.fiveHourPercent !== "number" || !Number.isFinite(quota.fiveHourPercent)) {
    return UNKNOWN_USAGE_SCORE;
  }
  return Math.max(0, Math.min(100, quota.fiveHourPercent));
}

export function getEligibleAnthropicAccounts(now = Date.now()): string[] {
  const set = getAccountSet(PROVIDER);
  if (!set) return [];
  return set.accounts
    .filter(account => account.needsReauth !== true && !isCooled(account.id, now))
    .map(account => account.id);
}

function pickLowestUsage(excludeId: string | undefined, now: number): string | null {
  const eligible = getEligibleAnthropicAccounts(now).filter(id => id !== excludeId);
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

export type AnthropicAccountSelectionReason =
  | "pool-disabled"
  | "affinity"
  | "active"
  | "lowest-usage"
  | "only-eligible"
  | "none";

export interface AnthropicAccountSelection {
  accountId: string | null;
  reason: AnthropicAccountSelectionReason;
}

/**
 * Resolve which Anthropic OAuth account should serve this session.
 * When the pool is disabled, always returns the store's active account.
 */
export function resolveAnthropicAccountForSession(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  now = Date.now(),
): AnthropicAccountSelection {
  const set = getAccountSet(PROVIDER);
  if (!set || set.accounts.length === 0) return { accountId: null, reason: "none" };

  if (!isAnthropicAccountPoolEnabled(config)) {
    return { accountId: set.activeAccountId, reason: "pool-disabled" };
  }

  const key = sessionKey?.trim() || "";
  if (key) {
    const affined = sessionAffinity.get(key);
    if (affined && now - affined.lastUsedAt <= AFFINITY_IDLE_TTL_MS) {
      const stillThere = set.accounts.some(a => a.id === affined.accountId && a.needsReauth !== true);
      if (stillThere && !isCooled(affined.accountId, now)) {
        affined.lastUsedAt = now;
        return { accountId: affined.accountId, reason: "affinity" };
      }
      sessionAffinity.delete(key);
    }
  }

  const threshold = anthropicAutoSwitchThreshold(config);
  const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
    && !isCooled(set.activeAccountId, now);

  let accountId: string | null = null;
  let reason: AnthropicAccountSelectionReason = "none";

  if (threshold > 0) {
    const activeScore = activeOk ? usageScore(set.activeAccountId) : UNKNOWN_USAGE_SCORE;
    if (activeOk && activeScore < threshold) {
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

  if (accountId && key) {
    sessionAffinity.set(key, { accountId, lastUsedAt: now });
  }
  return { accountId, reason };
}

export function bindAnthropicSessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  const key = sessionKey?.trim();
  if (!key) return;
  sessionAffinity.set(key, { accountId, lastUsedAt: now });
}

export function clearAnthropicSessionAffinityForAccount(accountId: string): void {
  for (const [key, entry] of sessionAffinity) {
    if (entry.accountId === accountId) sessionAffinity.delete(key);
  }
}

/**
 * Record a 429 for `failedAccountId`, cool it, clear its affinity, and pick a failover
 * account. Optionally promotes the store active account to the failover for dashboard parity.
 */
export function rotateAnthropicAccountOn429(
  config: OcxConfig,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  sessionKey?: string | null,
  now = Date.now(),
): string | null {
  if (!isAnthropicAccountPoolEnabled(config)) return null;

  const cooldownMs = parseRetryAfterMs(retryAfterHeader, now) ?? DEFAULT_COOLDOWN_MS;
  upstreamHealth.set(failedAccountId, {
    cooldownUntil: now + cooldownMs,
    cooldownSource: parseRetryAfterMs(retryAfterHeader, now) ? "retry-after" : "default",
  });
  clearAnthropicSessionAffinityForAccount(failedAccountId);

  const next = pickLowestUsage(failedAccountId, now);
  if (!next) {
    console.warn("[anthropic-pool] all eligible Anthropic OAuth accounts are in cooldown; returning 429");
    return null;
  }

  void setActiveAccount(PROVIDER, next).catch(() => { /* best-effort dashboard sync */ });
  if (sessionKey?.trim()) {
    sessionAffinity.set(sessionKey.trim(), { accountId: next, lastUsedAt: now });
  }
  console.warn(
    `[anthropic-pool] 429 on ${formatAnthropicAccountOrdinal(failedAccountId)}; failing over to ${formatAnthropicAccountOrdinal(next)}`,
  );
  return next;
}

export function formatAnthropicAccountOrdinal(accountId: string): string {
  return fallbackCodexAccountLogLabel(accountId);
}

export function formatAnthropicProviderForLog(
  providerName: string,
  accountId: string | null | undefined,
  _config?: OcxConfig,
): string {
  if (!accountId) return providerName;
  return `${providerName}-${formatAnthropicAccountOrdinal(accountId)}`;
}

/** Build a sticky session key from common Claude / Responses headers and cache keys. */
export function anthropicSessionKeyFromParts(input: {
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  promptCacheKey?: string | null;
  clientThreadId?: string | null;
}): string | null {
  const raw = (
    input.clientThreadId
    ?? input.sessionIdHeader
    ?? input.threadIdHeader
    ?? input.promptCacheKey
    ?? ""
  ).trim();
  if (!raw) return null;
  // Cap length / normalize — affinity map should not store huge cache keys verbatim.
  if (raw.length <= 128) return raw;
  return createHash("sha256").update(raw).digest("hex");
}
