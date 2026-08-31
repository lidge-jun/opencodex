/**
 * Opt-in Anthropic OAuth account pool (#294).
 *
 * Default OFF. When enabled:
 * - Sticky session affinity across requests that share a session key
 * - 429 cools the failed account and fails over to another eligible account
 * - New sessions use `strategy` (default quota): lowest known fiveHour usage (#493),
 *   round-robin, or fill-first — affinity still wins for bound sessions
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
import {
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  notePoolRotationFailure,
  notePoolRotationSuccess,
  pickRoundRobinAccount,
  POOL_KEY_ANTHROPIC,
  seedPoolRotationAccount,
} from "../codex/pool-rotation";
import type { OcxAccountPoolQuotaWindow, OcxAccountPoolRotationStrategy, OcxConfig } from "../types";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";
import { retainedUtf8Bytes } from "../lib/admission";

const PROVIDER = "anthropic";
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 2_000;
const MAX_AFFINITY_COMPONENT_BYTES = 512;
const UNKNOWN_USAGE_SCORE = 100;
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;
const DEFAULT_QUOTA_WINDOW: OcxAccountPoolQuotaWindow = "five-hour";
const VALID_QUOTA_WINDOWS = new Set<OcxAccountPoolQuotaWindow>(["five-hour", "weekly", "max-utilization"]);
/** Cap same-request 429 rotations so short Retry-After cannot infinite-loop. */
export const ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST = 3;

export interface AnthropicAccountPoolConfig {
  enabled?: boolean;
  /** Usage % for new-session pick. Default 80. 0 = disable quota-based pick (active / affinity only). */
  autoSwitchThreshold?: number;
  /** New-session rotation strategy. Default quota (today's behaviour). */
  strategy?: OcxAccountPoolRotationStrategy;
  /** Successful new-session binds retained on one round-robin selection. Default 1; range 1..100. */
  stickyLimit?: number;
  /** Usage window for quota-based scoring. Default "five-hour" (today's behaviour). */
  quotaWindow?: OcxAccountPoolQuotaWindow;
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

function normalizeAffinityComponent(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized && retainedUtf8Bytes(normalized) <= MAX_AFFINITY_COMPONENT_BYTES ? normalized : "";
}

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

/** Strict parse for management APIs — returns null instead of defaulting. */
export function parseAccountPoolQuotaWindow(raw: unknown): OcxAccountPoolQuotaWindow | null {
  if (typeof raw === "string" && VALID_QUOTA_WINDOWS.has(raw as OcxAccountPoolQuotaWindow)) {
    return raw as OcxAccountPoolQuotaWindow;
  }
  return null;
}

export function normalizeAccountPoolQuotaWindow(raw: unknown): OcxAccountPoolQuotaWindow {
  return parseAccountPoolQuotaWindow(raw) ?? DEFAULT_QUOTA_WINDOW;
}

export function anthropicQuotaWindow(config: AnthropicAccountPoolConfig): OcxAccountPoolQuotaWindow {
  return normalizeAccountPoolQuotaWindow(config.quotaWindow);
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

export function sweepExpiredAnthropicRoutingHealth(now = Date.now()): number {
  let removed = 0;
  for (const [accountId, health] of upstreamHealth) {
    if (health.cooldownUntil > now) continue;
    upstreamHealth.delete(accountId);
    removed += 1;
  }
  return removed;
}

/** Test / logout helper. */
export function clearAnthropicAccountPoolState(): void {
  upstreamHealth.clear();
  sessionAffinity.clear();
}

export function anthropicSessionAffinitySizeForTests(): number {
  return sessionAffinity.size;
}

function isCooled(accountId: string, now: number): boolean {
  return getAnthropicAccountHealthSnapshot(accountId, now) !== null;
}

function fiveHourKnown(accountId: string): boolean {
  const percent = getCachedProviderAccountQuota(PROVIDER, accountId)?.fiveHourPercent;
  return typeof percent === "number" && Number.isFinite(percent);
}

function weeklyKnown(accountId: string): boolean {
  const percent = getCachedProviderAccountQuota(PROVIDER, accountId)?.weeklyPercent;
  return typeof percent === "number" && Number.isFinite(percent);
}

function fiveHourScore(accountId: string): number {
  const percent = getCachedProviderAccountQuota(PROVIDER, accountId)?.fiveHourPercent;
  return typeof percent === "number" && Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent))
    : UNKNOWN_USAGE_SCORE;
}

function weeklyScore(accountId: string): number {
  const percent = getCachedProviderAccountQuota(PROVIDER, accountId)?.weeklyPercent;
  return typeof percent === "number" && Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent))
    : UNKNOWN_USAGE_SCORE;
}

function exhausted5h(accountId: string): boolean {
  return fiveHourKnown(accountId) && fiveHourScore(accountId) >= 100;
}

function hasKnownUsage(config: OcxConfig, accountId: string): boolean {
  const window = anthropicQuotaWindow(anthropicAccountPoolConfig(config));
  switch (window) {
    case "five-hour": return fiveHourKnown(accountId);
    case "weekly": return weeklyKnown(accountId);
    case "max-utilization": return fiveHourKnown(accountId) || weeklyKnown(accountId);
  }
}

function usageScore(config: OcxConfig, accountId: string): number {
  const window = anthropicQuotaWindow(anthropicAccountPoolConfig(config));
  switch (window) {
    case "five-hour": return fiveHourScore(accountId);
    case "weekly": return weeklyScore(accountId);
    case "max-utilization": {
      const scores = [
        ...(fiveHourKnown(accountId) ? [fiveHourScore(accountId)] : []),
        ...(weeklyKnown(accountId) ? [weeklyScore(accountId)] : []),
      ];
      return scores.length > 0 ? Math.max(...scores) : UNKNOWN_USAGE_SCORE;
    }
  }
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

interface ScoredAccount {
  accountId: string;
  hasKnownUsage: boolean;
  score: number;
  fiveHourTieBreak: number;
  /** True only under the opt-in weekly window; see compareScoredAccounts. */
  knownFirst: boolean;
}

function compareScoredAccounts(a: ScoredAccount, b: ScoredAccount): number {
  // known-before-unknown belongs to the OPT-IN windows (weekly, max-utilization), not the
  // legacy five-hour default. Applying it unconditionally changed ordering for operators who
  // never opted in: an account measured at 100% would sort ahead of an unmeasured one purely
  // because it had a reading. The accepted scope preserves the five-hour default exactly.
  if (a.knownFirst && b.knownFirst && a.hasKnownUsage !== b.hasKnownUsage) {
    return a.hasKnownUsage ? -1 : 1;
  }
  return a.score - b.score || a.fiveHourTieBreak - b.fiveHourTieBreak;
}

function pickLowestUsage(config: OcxConfig, excludeId: string | undefined, now: number): string | null {
  const window = anthropicQuotaWindow(anthropicAccountPoolConfig(config));
  const unfiltered = getEligibleAnthropicAccounts(now).filter(id => id !== excludeId);
  const available = window === "weekly" ? unfiltered.filter(id => !exhausted5h(id)) : unfiltered;
  const eligible = available.length > 0 ? available : unfiltered;
  if (eligible.length === 0) return null;
  const scored: ScoredAccount[] = eligible.map(accountId => ({
    accountId,
    hasKnownUsage: hasKnownUsage(config, accountId),
    score: usageScore(config, accountId),
    fiveHourTieBreak: window === "five-hour" ? 0 : fiveHourScore(accountId),
    // Every window EXCEPT the legacy five-hour default is an explicit opt-in, so
    // known-before-unknown applies to all of them and to none of the default path.
    knownFirst: window !== "five-hour",
  }));
  let best = scored[0]!;
  for (let i = 1; i < scored.length; i++) {
    const candidate = scored[i]!;
    // Strict `< 0` keeps the earliest eligible account on an exact tie.
    if (compareScoredAccounts(candidate, best) < 0) best = candidate;
  }
  return best.accountId;
}

/** Next eligible Anthropic account in stable order after `afterId` (wrapping). */
function pickNextFillFirstAnthropicAccount(
  config: OcxConfig,
  afterId: string,
  eligible: string[],
): string | null {
  const window = anthropicQuotaWindow(anthropicAccountPoolConfig(config));
  const available = window === "weekly" ? eligible.filter(id => !exhausted5h(id)) : eligible;
  const candidates = available.length > 0 ? available : eligible;
  if (candidates.length === 0) return null;
  const ordered = [...candidates].sort((a, b) => a.localeCompare(b));
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
  // Skip successors that are also at/above threshold (known drained usage).
  let fallback: string | null = null;
  for (let step = 1; step <= stableAll.length; step++) {
    const candidate = stableAll[(startIdx + step) % stableAll.length]!;
    if (!candidates.includes(candidate)) continue;
    if (!fallback) fallback = candidate;
    if (isActiveUnderFillFirstThreshold(config, candidate)) return candidate;
  }
  return fallback ?? ordered[0] ?? null;
}

function pickAlternateAnthropicAccount(
  config: OcxConfig,
  excludeId: string,
  now: number,
): string | null {
  const strategy = anthropicPoolStrategy(config);
  const eligible = getEligibleAnthropicAccounts(now).filter(id => id !== excludeId);
  if (strategy === "round-robin") {
    return pickRoundRobinAccount(POOL_KEY_ANTHROPIC, eligible, stickyLimitForPool(config));
  }
  if (strategy === "fill-first") {
    return pickNextFillFirstAnthropicAccount(config, excludeId, eligible);
  }
  return pickLowestUsage(config, excludeId, now);
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
  | "round-robin"
  | "fill-first"
  | "none"
  | "all-cooled";

export interface AnthropicAccountSelection {
  accountId: string | null;
  reason: AnthropicAccountSelectionReason;
}

function stickyLimitForPool(config: OcxConfig): number {
  return normalizeAccountPoolStickyLimit(anthropicAccountPoolConfig(config).stickyLimit);
}

function anthropicPoolStrategy(config: OcxConfig): OcxAccountPoolRotationStrategy {
  return normalizeAccountPoolStrategy(anthropicAccountPoolConfig(config).strategy);
}

function isActiveUnderFillFirstThreshold(config: OcxConfig, accountId: string): boolean {
  const threshold = anthropicAutoSwitchThreshold(config);
  if (threshold <= 0) return true;
  const window = anthropicQuotaWindow(anthropicAccountPoolConfig(config));
  if (window === "weekly" && exhausted5h(accountId)) return false;
  // Unknown usage must not force fill-first to abandon the active account.
  if (!hasKnownUsage(config, accountId)) return true;
  return usageScore(config, accountId) < threshold;
}

/**
 * Fill-first: keep eligible active under threshold; otherwise advance to the next
 * eligible id in stable sorted order after the current active (wrapping).
 */
function pickFillFirstAnthropicAccount(config: OcxConfig, now: number): string | null {
  const eligible = getEligibleAnthropicAccounts(now);
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

  return pickNextFillFirstAnthropicAccount(config, active, eligible);
}

/**
 * Unbound new-session pick for round-robin / fill-first. Returns null to fall through
 * to the legacy quota path (or when the strategy is quota).
 */
function pickUnboundStrategyAccount(
  config: OcxConfig,
  now: number,
): { accountId: string; reason: "round-robin" | "fill-first" } | null {
  const strategy = anthropicPoolStrategy(config);
  if (strategy === "quota") return null;

  if (strategy === "round-robin") {
    const eligible = getEligibleAnthropicAccounts(now);
    const limit = stickyLimitForPool(config);
    const picked = pickRoundRobinAccount(POOL_KEY_ANTHROPIC, eligible, limit);
    if (!picked) return null;
    notePoolRotationSuccess(POOL_KEY_ANTHROPIC, picked, limit);
    return { accountId: picked, reason: "round-robin" };
  }

  if (strategy === "fill-first") {
    const picked = pickFillFirstAnthropicAccount(config, now);
    if (!picked) return null;
    return { accountId: picked, reason: "fill-first" };
  }

  return null;
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

  const strategy = anthropicPoolStrategy(config);
  // No session identity (Desktop turns without a sticky key): hold the current
  // active under RR/fill-first instead of treating every turn as a new session.
  // Round-robin only when there is a real new-session key (or active is unusable).
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
    // Do not promote active here — token validation may still fail. Callers
    // (responses/core) promote after getAnthropicPoolAccessToken succeeds.
    if (key && normalizeAffinityComponent(strategyPick.accountId)) {
      sessionAffinity.set(key, { accountId: strategyPick.accountId, lastUsedAt: now });
      pruneExpiredAffinity(now);
    }
    return { accountId: strategyPick.accountId, reason: strategyPick.reason };
  }

  const threshold = anthropicAutoSwitchThreshold(config);
  const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
    && !isCooled(set.activeAccountId, now)
    && isPoolCredentialUsable(set.activeAccountId, now);

  let accountId: string | null = null;
  let reason: AnthropicAccountSelectionReason = "none";

  if (threshold > 0) {
    const window = anthropicQuotaWindow(anthropicAccountPoolConfig(config));
    // Unknown usage must NOT force a switch away from the healthy active account.
    if (activeOk
      && !(window === "weekly" && exhausted5h(set.activeAccountId))
      && (!hasKnownUsage(config, set.activeAccountId) || usageScore(config, set.activeAccountId) < threshold)) {
      accountId = set.activeAccountId;
      reason = "active";
    } else {
      const picked = pickLowestUsage(config, undefined, now);
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
    const picked = pickLowestUsage(config, set.activeAccountId, now);
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

export function bindAnthropicSessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  const key = normalizeAffinityComponent(sessionKey);
  if (!key || !normalizeAffinityComponent(accountId)) return;
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
  sweepExpiredOnWrite(now);
  clearAnthropicSessionAffinityForAccount(failedAccountId);
  notePoolRotationFailure(POOL_KEY_ANTHROPIC, failedAccountId);

  const next = pickAlternateAnthropicAccount(config, failedAccountId, now);
  if (!next) {
    console.warn("[anthropic-pool] all eligible Anthropic OAuth accounts are in cooldown; returning 429");
    return null;
  }

  const affinityKey = normalizeAffinityComponent(sessionKey);
  if (affinityKey && normalizeAffinityComponent(next)) {
    sessionAffinity.set(affinityKey, { accountId: next, lastUsedAt: now });
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
 * Manual selection resets session affinity and seeds the RR ring so the next
 * unbound new session honors the operator-chosen account (Codex parity).
 */
export function resetAnthropicRoutingForManualSelection(accountId: string): void {
  sessionAffinity.clear();
  seedPoolRotationAccount(POOL_KEY_ANTHROPIC, accountId);
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
