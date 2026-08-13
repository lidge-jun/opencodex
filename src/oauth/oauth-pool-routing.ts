/**
 * Generic OAuth account pool router (multiauth).
 *
 * Mirrors the Codex pool rotation strategy (priority tiers, quota headroom,
 * sticky session affinity, 429/transient failover, RR / fill-first / quota
 * strategies) for OAuth providers that can hold multiple accounts, so all
 * multi-account providers share one rotation engine instead of per-provider
 * copies.
 *
 * Default OFF per provider (config.xxxAccountPool.enabled !== true). When
 * enabled:
 * - Sticky session affinity across requests that share a session key
 * - 429 cools the failed account and fails over to another eligible account
 * - New sessions use `strategy` (default quota): lowest known fiveHour usage,
 *   round-robin, or fill-first — affinity still wins for bound sessions
 * - Selection order (priority) and manual pin behave like the Codex pool
 *
 * Affinity/health is process-local (lost on restart). Cooldown uses
 * Retry-After when present, otherwise a default backoff. 401/403 credential
 * failures should set needsReauth on the store (existing OAuth path) so the
 * account is excluded from eligibility.
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
  selectPriorityTier,
  seedPoolRotationAccount,
} from "../codex/pool-rotation";
import type { OcxAccountPoolRotationStrategy, OcxConfig } from "../types";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";
import { retainedUtf8Bytes } from "../lib/admission";

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 2_000;
const MAX_AFFINITY_COMPONENT_BYTES = 512;
const UNKNOWN_USAGE_SCORE = 100;
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;
/** Cap same-request 429 rotations so short Retry-After cannot infinite-loop. */
export const OAUTH_POOL_MAX_FAILOVERS_PER_REQUEST = 3;
/** Transient failures before the account is softly avoided (Codex parity). */
const FAILOVER_THRESHOLD = 3;
/** How long a transient failure keeps the account out of pool selection. */
const TRANSIENT_SOFT_AVOID_MS = 30_000;
/** Window past which a failure streak no longer counts. */
const FAILURE_WINDOW_MS = 5 * 60_000;

export interface OAuthAccountPoolConfig {
  enabled?: boolean;
  /** Usage % for new-session pick. Default 80. 0 = disable quota-based pick (active / affinity only). */
  autoSwitchThreshold?: number;
  /** New-session rotation strategy. Default quota (today's behaviour). */
  strategy?: OcxAccountPoolRotationStrategy;
  /** Successful new-session binds retained on one round-robin selection. Default 1; range 1..100. */
  stickyLimit?: number;
  /** Selection order per account id, higher used earlier. */
  accountPriorities?: Record<string, number>;
  /** Account id manually pinned by the operator. */
  activeAccountPinned?: string;
}

export interface OAuthPoolProviderHooks {
  /** Config slice for this provider (e.g. config.anthropicAccountPool). */
  configOf: (config: OcxConfig) => OAuthAccountPoolConfig | undefined;
  /** Selection order lookup; higher used earlier. Absent => 0. */
  priorityOf: (config: OcxConfig) => (accountId: string) => number;
  /** Manually pinned account id (tier ceiling), if any. */
  pinnedOf: (config: OcxConfig) => string | undefined;
  /** Pool key for the shared RR ring. */
  poolKey: string;
}

export interface OAuthPoolProviderState {
  /** Process-local upstream health per account. */
  upstreamHealth: Map<string, AccountHealth>;
  /** Sticky session affinity. */
  sessionAffinity: Map<string, AffinityEntry>;
  /** Whether the provider's own pool state has been seeded for tests. */
  seeded: boolean;
}

interface AccountHealth {
  cooldownUntil: number;
  cooldownSource: "retry-after" | "default";
  /** Transient-failure streak for soft-avoid. */
  consecutiveFailures?: number;
  lastFailureAt?: number;
  softAvoidUntil?: number;
}

interface AffinityEntry {
  accountId: string;
  lastUsedAt: number;
}

const stateByProvider = new Map<string, OAuthPoolProviderState>();

function stateFor(provider: string): OAuthPoolProviderState {
  let state = stateByProvider.get(provider);
  if (!state) {
    state = { upstreamHealth: new Map(), sessionAffinity: new Map(), seeded: true };
    stateByProvider.set(provider, state);
  }
  return state;
}

function normalizeAffinityComponent(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized && retainedUtf8Bytes(normalized) <= MAX_AFFINITY_COMPONENT_BYTES ? normalized : "";
}

function providerConfig(config: OcxConfig, hooks: OAuthPoolProviderHooks): OAuthAccountPoolConfig {
  const raw = hooks.configOf(config);
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

export function isOAuthPoolEnabled(config: OcxConfig, hooks: OAuthPoolProviderHooks): boolean {
  return providerConfig(config, hooks).enabled === true;
}

export function oauthPoolAutoSwitchThreshold(config: OcxConfig, hooks: OAuthPoolProviderHooks): number {
  const value = providerConfig(config, hooks).autoSwitchThreshold;
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

export function getOAuthPoolAccountHealthSnapshot(
  provider: string,
  accountId: string,
  now = Date.now(),
): { cooldownUntil?: number; cooldownSource?: AccountHealth["cooldownSource"] } | null {
  const entry = stateFor(provider).upstreamHealth.get(accountId);
  if (!entry) return null;
  if (entry.cooldownUntil <= now) {
    stateFor(provider).upstreamHealth.delete(accountId);
    return null;
  }
  return { cooldownUntil: entry.cooldownUntil, cooldownSource: entry.cooldownSource };
}

export function clearOAuthPoolAccountCooldown(provider: string, accountId: string): boolean {
  return stateFor(provider).upstreamHealth.delete(accountId);
}

export function sweepExpiredOAuthPoolRoutingHealth(provider?: string, now = Date.now()): number {
  if (provider === undefined) {
    let removed = 0;
    for (const name of stateByProvider.keys()) removed += sweepExpiredOAuthPoolRoutingHealth(name, now);
    return removed;
  }
  let removed = 0;
  const health = stateFor(provider).upstreamHealth;
  for (const [accountId, entry] of health) {
    if (entry.cooldownUntil > now) continue;
    health.delete(accountId);
    removed += 1;
  }
  return removed;
}

/** Test / logout helper. */
export function clearOAuthPoolState(provider: string): void {
  stateByProvider.delete(provider);
}

export function oauthPoolSessionAffinitySizeForTests(provider: string): number {
  return stateFor(provider).sessionAffinity.size;
}

function isCooled(provider: string, accountId: string, now: number): boolean {
  return getOAuthPoolAccountHealthSnapshot(provider, accountId, now) !== null;
}

function hasKnownUsage(provider: string, accountId: string): boolean {
  const quota = getCachedProviderAccountQuota(provider, accountId);
  return typeof quota?.fiveHourPercent === "number" && Number.isFinite(quota.fiveHourPercent);
}

function usageScore(provider: string, accountId: string): number {
  const quota = getCachedProviderAccountQuota(provider, accountId);
  if (!quota || typeof quota.fiveHourPercent !== "number" || !Number.isFinite(quota.fiveHourPercent)) {
    return UNKNOWN_USAGE_SCORE;
  }
  return Math.max(0, Math.min(100, quota.fiveHourPercent));
}

const TOKEN_SKEW_MS = 60_000;

/** Background `local-cli` slots with expired access are not pool-eligible (identity adoption risk). */
function isPoolCredentialUsable(provider: string, accountId: string, now: number, canRefresh: (accountId: string) => boolean): boolean {
  const cred = getAccountCredential(provider, accountId);
  if (!cred) return false;
  if (cred.source !== "local-cli") return true;
  if (canRefresh(accountId)) return true;
  return cred.expires > now + TOKEN_SKEW_MS;
}

export interface OAuthPoolEligibilityHooks {
  /** Whether this account's token may be refreshed in the background (local-cli identity rule). */
  canRefresh: (accountId: string) => boolean;
  /** Usable-credential predicate; default reads the account store. */
  isUsable?: (accountId: string) => boolean;
}

export function getEligibleOAuthPoolAccounts(
  provider: string,
  hooks: OAuthPoolProviderHooks,
  eligibility: OAuthPoolEligibilityHooks,
  excludeId?: string,
  now = Date.now(),
): string[] {
  const set = getAccountSet(provider);
  if (!set) return [];
  return set.accounts
    .filter(account =>
      account.id !== excludeId
      && account.needsReauth !== true
      && !isCooled(provider, account.id, now)
      && !isSoftAvoided(provider, account.id, now)
      && isPoolCredentialUsable(provider, account.id, now, eligibility.canRefresh)
      && (eligibility.isUsable?.(account.id) ?? true))
    .map(account => account.id);
}

function isSoftAvoided(provider: string, accountId: string, now: number): boolean {
  const entry = stateFor(provider).upstreamHealth.get(accountId);
  if (!entry?.softAvoidUntil) return false;
  if (entry.softAvoidUntil <= now) return false;
  return true;
}

/** Earliest remaining cooldown among cooled accounts, for client Retry-After. */
export function getOAuthPoolRetryAfterSeconds(provider: string, now = Date.now()): number | null {
  const set = getAccountSet(provider);
  if (!set) return null;
  let earliest: number | null = null;
  for (const account of set.accounts) {
    const snap = getOAuthPoolAccountHealthSnapshot(provider, account.id, now);
    if (!snap?.cooldownUntil) continue;
    if (earliest === null || snap.cooldownUntil < earliest) earliest = snap.cooldownUntil;
  }
  if (earliest === null || earliest <= now) return null;
  return Math.max(1, Math.ceil((earliest - now) / 1000));
}

/** Next eligible account in stable order after `afterId` (wrapping). */
function pickNextFillFirstAccount(
  provider: string,
  config: OcxConfig,
  hooks: OAuthPoolProviderHooks,
  afterId: string,
  eligible: readonly string[],
): string | null {
  if (eligible.length === 0) return null;
  const ordered = [...eligible].sort((a, b) => a.localeCompare(b));
  const set = getAccountSet(provider);
  const stableAll = set
    ? [...set.accounts.map(a => a.id)].sort((a, b) => a.localeCompare(b))
    : ordered;
  const startIdx = stableAll.indexOf(afterId);
  if (startIdx < 0) {
    for (const id of ordered) {
      if (isActiveUnderFillFirstThreshold(provider, config, hooks, id)) return id;
    }
    return ordered[0] ?? null;
  }
  // Skip successors that are also at/above threshold (known drained usage).
  let fallback: string | null = null;
  for (let step = 1; step <= stableAll.length; step++) {
    const candidate = stableAll[(startIdx + step) % stableAll.length]!;
    if (!eligible.includes(candidate)) continue;
    if (!fallback) fallback = candidate;
    if (isActiveUnderFillFirstThreshold(provider, config, hooks, candidate)) return candidate;
  }
  return fallback ?? ordered[0] ?? null;
}

function pickAlternateAccount(
  provider: string,
  config: OcxConfig,
  hooks: OAuthPoolProviderHooks,
  eligibility: OAuthPoolEligibilityHooks,
  excludeId: string,
  now: number,
): string | null {
  const strategy = oauthPoolStrategy(config, hooks);
  const eligible = eligibleWithPriority(provider, config, hooks, eligibility, now, excludeId);
  if (strategy === "round-robin") {
    return pickRoundRobinAccount(hooks.poolKey, eligible, stickyLimitForPool(config, hooks));
  }
  if (strategy === "fill-first") {
    return pickNextFillFirstAccount(provider, config, hooks, excludeId, eligible);
  }
  return pickLowestUsageAmong(provider, eligible);
}

function pruneExpiredAffinity(provider: string, now: number): void {
  const affinity = stateFor(provider).sessionAffinity;
  for (const [key, entry] of affinity) {
    if (now - entry.lastUsedAt > AFFINITY_IDLE_TTL_MS) affinity.delete(key);
  }
  if (affinity.size <= MAX_AFFINITY_ENTRIES) return;
  const sorted = [...affinity.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  const drop = affinity.size - MAX_AFFINITY_ENTRIES;
  for (let i = 0; i < drop; i++) affinity.delete(sorted[i]![0]);
}

export type OAuthPoolSelectionReason =
  | "pool-disabled"
  | "affinity"
  | "active"
  | "lowest-usage"
  | "only-eligible"
  | "round-robin"
  | "fill-first"
  | "priority-preemption"
  | "quota-switch"
  | "failover"
  | "none"
  | "all-cooled";

export interface OAuthPoolSelection {
  accountId: string | null;
  reason: OAuthPoolSelectionReason;
}

function stickyLimitForPool(config: OcxConfig, hooks: OAuthPoolProviderHooks): number {
  return normalizeAccountPoolStickyLimit(providerConfig(config, hooks).stickyLimit);
}

function oauthPoolStrategy(config: OcxConfig, hooks: OAuthPoolProviderHooks): OcxAccountPoolRotationStrategy {
  return normalizeAccountPoolStrategy(providerConfig(config, hooks).strategy);
}

function isActiveUnderFillFirstThreshold(provider: string, config: OcxConfig, hooks: OAuthPoolProviderHooks, accountId: string): boolean {
  const threshold = oauthPoolAutoSwitchThreshold(config, hooks);
  if (threshold <= 0) return true;
  // Unknown usage must not force fill-first to abandon the active account.
  if (!hasKnownUsage(provider, accountId)) return true;
  return usageScore(provider, accountId) < threshold;
}

/**
 * Fill-first: keep eligible active under threshold; otherwise advance to the next
 * eligible id in stable sorted order after the current active (wrapping).
 */
function pickFillFirstAccount(
  provider: string,
  config: OcxConfig,
  hooks: OAuthPoolProviderHooks,
  eligible: readonly string[],
): string | null {
  if (eligible.length === 0) return null;

  const set = getAccountSet(provider);
  const active = set?.activeAccountId;
  if (active && eligible.includes(active) && isActiveUnderFillFirstThreshold(provider, config, hooks, active)) {
    return active;
  }

  if (!active || !set) {
    const ordered = [...eligible].sort((a, b) => a.localeCompare(b));
    for (const id of ordered) {
      if (isActiveUnderFillFirstThreshold(provider, config, hooks, id)) return id;
    }
    return ordered[0] ?? null;
  }

  return pickNextFillFirstAccount(provider, config, hooks, active, eligible);
}

/**
 * Unbound new-session pick for round-robin / fill-first. Returns null to fall through
 * to the legacy quota path (or when the strategy is quota).
 */
function pickUnboundStrategyAccount(
  provider: string,
  config: OcxConfig,
  hooks: OAuthPoolProviderHooks,
  eligible: readonly string[],
): { accountId: string; reason: "round-robin" | "fill-first" } | null {
  const strategy = oauthPoolStrategy(config, hooks);
  if (strategy === "quota") return null;

  if (strategy === "round-robin") {
    const limit = stickyLimitForPool(config, hooks);
    const picked = pickRoundRobinAccount(hooks.poolKey, eligible, limit);
    if (!picked) return null;
    notePoolRotationSuccess(hooks.poolKey, picked, limit);
    return { accountId: picked, reason: "round-robin" };
  }

  if (strategy === "fill-first") {
    const picked = pickFillFirstAccount(provider, config, hooks, eligible);
    if (!picked) return null;
    return { accountId: picked, reason: "fill-first" };
  }

  return null;
}

/**
 * Narrow the eligible list to the highest selection-order tier that still has
 * usable quota, with the manual pin as a tier ceiling (Codex parity).
 */
function applyPriorityTier(
  provider: string,
  config: OcxConfig,
  hooks: OAuthPoolProviderHooks,
  eligibility: OAuthPoolEligibilityHooks,
  ids: readonly string[],
  now: number,
): readonly string[] {
  return selectPriorityTier(
    ids,
    hooks.priorityOf(config),
    id => isActiveUnderFillFirstThreshold(provider, config, hooks, id),
    hooks.pinnedOf(config),
  );
}

function eligibleWithPriority(
  provider: string,
  config: OcxConfig,
  hooks: OAuthPoolProviderHooks,
  eligibility: OAuthPoolEligibilityHooks,
  now: number,
  excludeId?: string,
): string[] {
  const base = getEligibleOAuthPoolAccounts(provider, hooks, eligibility, excludeId, now);
  return [...applyPriorityTier(provider, config, hooks, eligibility, base, now)];
}

/** Coolest account in an already-selected candidate list; first index wins ties. */
function pickLowestUsageAmong(provider: string, ids: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const score = usageScore(provider, id);
    if (score < bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

function shouldFailover(provider: string, accountId: string, now: number): boolean {
  const health = stateFor(provider).upstreamHealth.get(accountId);
  if (health?.lastFailureAt && now - health.lastFailureAt > FAILURE_WINDOW_MS) return false;
  return !!health && (health.consecutiveFailures ?? 0) >= FAILOVER_THRESHOLD;
}

/**
 * Resolve which OAuth account should serve this session.
 * When the pool is disabled, always returns the store's active account.
 */
export function resolveOAuthPoolAccountForSession(
  provider: string,
  sessionKey: string | null | undefined,
  config: OcxConfig,
  hooks: OAuthPoolProviderHooks,
  eligibility: OAuthPoolEligibilityHooks,
  now = Date.now(),
): OAuthPoolSelection {
  pruneExpiredAffinity(provider, now);
  const set = getAccountSet(provider);
  if (!set || set.accounts.length === 0) return { accountId: null, reason: "none" };

  if (!isOAuthPoolEnabled(config, hooks)) {
    return { accountId: set.activeAccountId, reason: "pool-disabled" };
  }

  const affinity = stateFor(provider).sessionAffinity;
  const key = normalizeAffinityComponent(sessionKey);
  if (key) {
    const affined = affinity.get(key);
    if (affined && now - affined.lastUsedAt <= AFFINITY_IDLE_TTL_MS) {
      const stillThere = set.accounts.some(a => a.id === affined.accountId && a.needsReauth !== true);
      if (stillThere && !isCooled(provider, affined.accountId, now)
        && !isSoftAvoided(provider, affined.accountId, now)
        && isPoolCredentialUsable(provider, affined.accountId, now, eligibility.canRefresh)
        && !shouldFailover(provider, affined.accountId, now)) {
        affined.lastUsedAt = now;
        return { accountId: affined.accountId, reason: "affinity" };
      }
      affinity.delete(key);
    }
  }

  const strategy = oauthPoolStrategy(config, hooks);
  // Selection order is a boundary, not a quota-only preference: every strategy
  // must rotate only inside the highest usable tier (or the manual pin's tier).
  const eligible = eligibleWithPriority(provider, config, hooks, eligibility, now);
  // No session identity (Desktop turns without a sticky key): hold the current
  // active under RR/fill-first instead of treating every turn as a new session.
  if (!key && (strategy === "round-robin" || strategy === "fill-first")) {
    const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
      && eligible.includes(set.activeAccountId)
      && !isCooled(provider, set.activeAccountId, now)
      && !isSoftAvoided(provider, set.activeAccountId, now)
      && isPoolCredentialUsable(provider, set.activeAccountId, now, eligibility.canRefresh);
    if (activeOk) {
      return { accountId: set.activeAccountId, reason: "active" };
    }
  }

  const strategyPick = pickUnboundStrategyAccount(provider, config, hooks, eligible);
  if (strategyPick) {
    if (key && normalizeAffinityComponent(strategyPick.accountId)) {
      affinity.set(key, { accountId: strategyPick.accountId, lastUsedAt: now });
      pruneExpiredAffinity(provider, now);
    }
    return { accountId: strategyPick.accountId, reason: strategyPick.reason };
  }

  const threshold = oauthPoolAutoSwitchThreshold(config, hooks);
  const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
    && eligible.includes(set.activeAccountId)
    && !isCooled(provider, set.activeAccountId, now)
    && !isSoftAvoided(provider, set.activeAccountId, now)
    && isPoolCredentialUsable(provider, set.activeAccountId, now, eligibility.canRefresh);

  let accountId: string | null = null;
  let reason: OAuthPoolSelectionReason = "none";

  // Priority preemption: a higher-ordered account with headroom replaces the
  // active, unless a live pin lowers the tier ceiling (Codex parity). This
  // applies regardless of the active account's usage so an operator's ordering
  // is honored on the next unbound session.
  const pinned = hooks.pinnedOf(config);
  const pinnedLive = pinned !== undefined && eligible.includes(pinned) && isActiveUnderFillFirstThreshold(provider, config, hooks, pinned);
  if (!pinnedLive && eligible.length > 0 && !eligible.includes(set.activeAccountId)) {
    const preemptCandidate = pickLowestUsageAmong(provider, eligible.filter(id => isActiveUnderFillFirstThreshold(provider, config, hooks, id)));
    if (preemptCandidate) {
      accountId = preemptCandidate;
      reason = "priority-preemption";
    }
  }

  if (!accountId) {
    if (threshold > 0) {
      // Unknown usage must NOT force a switch away from the healthy active account.
      if (activeOk && (!hasKnownUsage(provider, set.activeAccountId) || usageScore(provider, set.activeAccountId) < threshold)) {
        accountId = set.activeAccountId;
        reason = "active";
      } else {
        const picked = pickLowestUsageAmong(provider, eligible);
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
      const picked = pickLowestUsageAmong(provider, eligible.filter(id => id !== set.activeAccountId));
      if (picked) {
        accountId = picked;
        reason = "only-eligible";
      }
    }
  }

  if (!accountId) {
    const anyCooled = set.accounts.some(a => isCooled(provider, a.id, now));
    return { accountId: null, reason: anyCooled ? "all-cooled" : "none" };
  }

  if (key && normalizeAffinityComponent(accountId)) {
    affinity.set(key, { accountId, lastUsedAt: now });
    pruneExpiredAffinity(provider, now);
  }
  return { accountId, reason };
}

export function bindOAuthPoolSessionAffinity(
  provider: string,
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  const key = normalizeAffinityComponent(sessionKey);
  if (!key || !normalizeAffinityComponent(accountId)) return;
  stateFor(provider).sessionAffinity.set(key, { accountId, lastUsedAt: now });
  pruneExpiredAffinity(provider, now);
}

export function clearOAuthPoolSessionAffinityForAccount(provider: string, accountId: string): void {
  const affinity = stateFor(provider).sessionAffinity;
  for (const [key, entry] of affinity) {
    if (entry.accountId === accountId) affinity.delete(key);
  }
}

/**
 * Record a 429 for `failedAccountId`, cool it, clear its affinity, and pick a failover
 * account. Does NOT promote the store active account — caller should promote only after a
 * successful retry (or token resolve).
 */
export function rotateOAuthPoolAccountOn429(
  provider: string,
  config: OcxConfig,
  hooks: OAuthPoolProviderHooks,
  eligibility: OAuthPoolEligibilityHooks,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  sessionKey?: string | null,
  now = Date.now(),
): string | null {
  if (!isOAuthPoolEnabled(config, hooks)) return null;

  const parsedRetry = parseRetryAfterMs(retryAfterHeader, now);
  const health = stateFor(provider).upstreamHealth;
  health.set(failedAccountId, {
    cooldownUntil: now + (parsedRetry ?? DEFAULT_COOLDOWN_MS),
    cooldownSource: parsedRetry ? "retry-after" : "default",
  });
  sweepExpiredOnWrite(now);
  clearOAuthPoolSessionAffinityForAccount(provider, failedAccountId);
  notePoolRotationFailure(hooks.poolKey, failedAccountId);

  const next = pickAlternateAccount(provider, config, hooks, eligibility, failedAccountId, now);
  if (!next) {
    console.warn(`[oauth-pool:${provider}] all eligible ${provider} OAuth accounts are in cooldown; returning 429`);
    return null;
  }

  const affinityKey = normalizeAffinityComponent(sessionKey);
  if (affinityKey && normalizeAffinityComponent(next)) {
    stateFor(provider).sessionAffinity.set(affinityKey, { accountId: next, lastUsedAt: now });
    pruneExpiredAffinity(provider, now);
  }
  console.warn(
    `[oauth-pool:${provider}] 429 on ${formatOAuthPoolAccountOrdinal(failedAccountId)}; failing over to ${formatOAuthPoolAccountOrdinal(next)}`,
  );
  return next;
}

/** Promote dashboard active account after a validated failover target is usable. */
export function promoteOAuthPoolActiveAccount(provider: string, accountId: string): void {
  void setActiveAccount(provider, accountId).catch(() => { /* best-effort */ });
}

/**
 * Manual selection resets session affinity and seeds the RR ring so the next
 * unbound new session honors the operator-chosen account (Codex parity).
 */
export function resetOAuthPoolRoutingForManualSelection(provider: string, hooks: OAuthPoolProviderHooks, accountId: string): void {
  stateFor(provider).sessionAffinity.clear();
  seedPoolRotationAccount(hooks.poolKey, accountId);
}

/**
 * Resolve a bearer for pool traffic without adopting a newer global provider
 * CLI credential into a background multiauth `local-cli` slot (same fail-closed
 * rule as quota probes).
 */
export async function getOAuthPoolAccessToken(provider: string, accountId: string, canRefresh: (accountId: string) => boolean): Promise<string> {
  const stored = getAccountCredential(provider, accountId);
  if (!stored) {
    const { OAuthLoginRequiredError } = await import("./index");
    throw new OAuthLoginRequiredError(provider);
  }
  if (stored.expires > Date.now() + TOKEN_SKEW_MS) return stored.access;
  if (!canRefresh(accountId)) {
    throw new Error("background local-cli token expired; refuse CLI-adopting refresh for pool");
  }
  const { getValidAccessTokenForAccount } = await import("./index");
  return getValidAccessTokenForAccount(provider, accountId);
}

export function formatOAuthPoolAccountOrdinal(accountId: string): string {
  return fallbackCodexAccountLogLabel(accountId);
}

export function formatOAuthPoolProviderForLog(
  providerName: string,
  accountId: string | null | undefined,
  _config?: OcxConfig,
): string {
  if (!accountId) return providerName;
  return `${providerName}-${formatOAuthPoolAccountOrdinal(accountId)}`;
}

/**
 * Build a sticky session key from request headers.
 * Prefer true session/thread ids; do not use a shared cache-cohort prompt_cache_key
 * alone (those collide across conversations).
 */
export function oauthPoolSessionKeyFromParts(input: {
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
