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
 *
 * Affinity is process-local (lost on restart). Cooldown uses Retry-After when present,
 * otherwise a default backoff. 401/403 credential failures should set needsReauth on the
 * store (existing OAuth path) so the account is excluded from eligibility.
 */
import { createHash } from "node:crypto";
import { setActiveAccount, getAccountSet, getAccountCredential } from "./store";
import { getCachedProviderAccountQuota } from "../providers/quota";
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import type { OcxConfig } from "../types";

const PROVIDER = "anthropic";
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 2_000;
const UNKNOWN_USAGE_SCORE = 100;
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;
/** Cap same-request 429 rotations so short Retry-After cannot infinite-loop. */
export const ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST = 3;

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

const TOKEN_SKEW_MS = 60_000;

/** Background `local-cli` slots with expired access are not pool-eligible (identity adoption risk). */
function isPoolCredentialUsable(accountId: string, now: number): boolean {
  const cred = getAccountCredential(PROVIDER, accountId);
  if (!cred) return false;
  if (cred.source !== "local-cli") return true;
  if (canRefreshAnthropicPoolAccount(accountId)) return true;
  return cred.expires > now + TOKEN_SKEW_MS;
}

export function getEligibleAnthropicAccounts(now = Date.now()): string[] {
  const set = getAccountSet(PROVIDER);
  if (!set) return [];
  return set.accounts
    .filter(account =>
      account.needsReauth !== true
      && !isCooled(account.id, now)
      && isPoolCredentialUsable(account.id, now))
    .map(account => account.id);
}

/** Earliest remaining cooldown among cooled Anthropic accounts, for client Retry-After. */
export function getAnthropicPoolRetryAfterSeconds(now = Date.now()): number | null {
  const set = getAccountSet(PROVIDER);
  if (!set) return null;
  let earliest: number | null = null;
  for (const account of set.accounts) {
    const snap = getAnthropicAccountHealthSnapshot(account.id, now);
    if (!snap?.cooldownUntil) continue;
    if (earliest === null || snap.cooldownUntil < earliest) earliest = snap.cooldownUntil;
  }
  if (earliest === null || earliest <= now) return null;
  return Math.max(1, Math.ceil((earliest - now) / 1000));
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

function pruneExpiredAffinity(now: number): void {
  for (const [key, entry] of sessionAffinity) {
    if (now - entry.lastUsedAt > AFFINITY_IDLE_TTL_MS) sessionAffinity.delete(key);
  }
  if (sessionAffinity.size <= MAX_AFFINITY_ENTRIES) return;
  const sorted = [...sessionAffinity.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  const drop = sessionAffinity.size - MAX_AFFINITY_ENTRIES;
  for (let i = 0; i < drop; i++) sessionAffinity.delete(sorted[i]![0]);
}

export type AnthropicAccountSelectionReason =
  | "pool-disabled"
  | "affinity"
  | "active"
  | "lowest-usage"
  | "only-eligible"
  | "none"
  | "all-cooled";

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
  pruneExpiredAffinity(now);
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
      if (stillThere && !isCooled(affined.accountId, now) && isPoolCredentialUsable(affined.accountId, now)) {
        affined.lastUsedAt = now;
        return { accountId: affined.accountId, reason: "affinity" };
      }
      sessionAffinity.delete(key);
    }
  }

  const threshold = anthropicAutoSwitchThreshold(config);
  const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
    && !isCooled(set.activeAccountId, now)
    && isPoolCredentialUsable(set.activeAccountId, now);

  let accountId: string | null = null;
  let reason: AnthropicAccountSelectionReason = "none";

  if (threshold > 0) {
    // Unknown usage must NOT force a switch away from the healthy active account.
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

  if (key) {
    sessionAffinity.set(key, { accountId, lastUsedAt: now });
    pruneExpiredAffinity(now);
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
  pruneExpiredAffinity(now);
}

export function clearAnthropicSessionAffinityForAccount(accountId: string): void {
  for (const [key, entry] of sessionAffinity) {
    if (entry.accountId === accountId) sessionAffinity.delete(key);
  }
}

/**
 * Record a 429 for `failedAccountId`, cool it, clear its affinity, and pick a failover
 * account. Does NOT promote the store active account — caller should promote only after a
 * successful retry (or token resolve).
 */
export function rotateAnthropicAccountOn429(
  config: OcxConfig,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  sessionKey?: string | null,
  now = Date.now(),
): string | null {
  if (!isAnthropicAccountPoolEnabled(config)) return null;

  const parsedRetry = parseRetryAfterMs(retryAfterHeader, now);
  const cooldownMs = parsedRetry ?? DEFAULT_COOLDOWN_MS;
  upstreamHealth.set(failedAccountId, {
    cooldownUntil: now + cooldownMs,
    cooldownSource: parsedRetry ? "retry-after" : "default",
  });
  clearAnthropicSessionAffinityForAccount(failedAccountId);

  const next = pickLowestUsage(failedAccountId, now);
  if (!next) {
    console.warn("[anthropic-pool] all eligible Anthropic OAuth accounts are in cooldown; returning 429");
    return null;
  }

  if (sessionKey?.trim()) {
    sessionAffinity.set(sessionKey.trim(), { accountId: next, lastUsedAt: now });
    pruneExpiredAffinity(now);
  }
  console.warn(
    `[anthropic-pool] 429 on ${formatAnthropicAccountOrdinal(failedAccountId)}; failing over to ${formatAnthropicAccountOrdinal(next)}`,
  );
  return next;
}

/** Promote dashboard active account after a validated failover target is usable. */
export function promoteAnthropicActiveAccount(accountId: string): void {
  void setActiveAccount(PROVIDER, accountId).catch(() => { /* best-effort */ });
}

/**
 * Resolve a bearer for pool traffic without adopting a newer global Claude CLI
 * credential into a background multiauth `local-cli` slot (same fail-closed rule
 * as quota probes).
 */
export async function getAnthropicPoolAccessToken(accountId: string): Promise<string> {
  const stored = getAccountCredential(PROVIDER, accountId);
  if (!stored) {
    const { OAuthLoginRequiredError } = await import("./index");
    throw new OAuthLoginRequiredError(PROVIDER);
  }
  if (stored.expires > Date.now() + TOKEN_SKEW_MS) return stored.access;
  if (!canRefreshAnthropicPoolAccount(accountId)) {
    throw new Error("background local-cli token expired; refuse CLI-adopting refresh for pool");
  }
  const { getValidAccessTokenForAccount } = await import("./index");
  return getValidAccessTokenForAccount(PROVIDER, accountId);
}

/**
 * Whether the pool may refresh this account's token. Background `local-cli` slots must not
 * adopt the global Claude CLI credential (same fail-closed rule as quota probes).
 */
export function canRefreshAnthropicPoolAccount(accountId: string): boolean {
  const set = getAccountSet(PROVIDER);
  const cred = getAccountCredential(PROVIDER, accountId);
  if (!cred) return false;
  if (cred.source !== "local-cli") return true;
  return set?.activeAccountId === accountId;
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

/**
 * Build a sticky session key from Claude/Responses headers.
 * Prefer true session/thread ids; do not use Desktop shared cache-cohort prompt_cache_key
 * alone (those collide across conversations).
 */
export function anthropicSessionKeyFromParts(input: {
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  promptCacheKey?: string | null;
  clientThreadId?: string | null;
  /** When true, prompt_cache_key is a shared Desktop cohort — ignore it for affinity. */
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
