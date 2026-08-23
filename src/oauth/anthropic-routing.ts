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
 * Affinity and cooldown delegate to `src/routing/account-pool/` (process-local).
 * 401/403 credential failures should set needsReauth on the store (existing OAuth path)
 * so the account is excluded from eligibility.
 */
import { setActiveAccount, getAccountSet, getAccountCredential } from "./store";
import { getCachedProviderAccountQuota } from "../providers/quota";
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import {
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  notePoolRotationFailure,
  pickRoundRobinAccount,
  POOL_KEY_ANTHROPIC,
  seedPoolRotationAccount,
} from "../codex/pool-rotation";
import type { OcxAccountPoolRotationStrategy, OcxConfig } from "../types";
import {
  ACCOUNT_POOL_MAX_FAILOVERS,
  affinitySizeForTests,
  bindSessionAffinity,
  buildSessionKeyFromParts,
  clearAccountPoolState,
  clearAffinityState,
  clearResolveState,
  clearSessionAffinityForAccount,
  getPoolCooldownRegistry,
  getSessionAffinity,
  isAccountPoolEligible,
  isRateLimitStickWait,
  normalizeAffinityComponent,
  recordPoolAccountCooldown,
  resolvePoolAccount,
  touchSessionAffinity,
  type AccountPoolPlugin,
} from "../routing/account-pool";

const PROVIDER = "anthropic";
const UNKNOWN_USAGE_SCORE = 100;
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;
/** Cap same-request 429 rotations so short Retry-After cannot infinite-loop. */
export const ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST = ACCOUNT_POOL_MAX_FAILOVERS;

export interface AnthropicAccountPoolConfig {
  enabled?: boolean;
  /** Usage % for new-session pick. Default 80. 0 = disable quota-based pick (active / affinity only). */
  autoSwitchThreshold?: number;
  /** New-session rotation strategy. Default quota (today's behaviour). */
  strategy?: OcxAccountPoolRotationStrategy;
  /** Successful new-session binds retained on one round-robin selection. Default 1; range 1..100. */
  stickyLimit?: number;
}

const anthropicPoolPlugin: AccountPoolPlugin = {
  poolKey: POOL_KEY_ANTHROPIC,
  sessionKeyFromRequest: buildSessionKeyFromParts,
  listEligibleAccountIds(now) {
    const set = getAccountSet(PROVIDER);
    if (!set) return [];
    return set.accounts
      .filter(account =>
        account.needsReauth !== true
        && isPoolCredentialUsable(account.id, now))
      .map(account => account.id);
  },
  usageScore(accountId) {
    return anthropicUsageScore(accountId);
  },
};

const TOKEN_SKEW_MS = 60_000;

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

export function getAnthropicAccountHealthSnapshot(
  accountId: string,
  now = Date.now(),
): { cooldownUntil?: number; cooldownSource?: "retry-after" | "default" } | null {
  const entry = getPoolCooldownRegistry(POOL_KEY_ANTHROPIC).get(accountId, now);
  if (!entry) return null;
  const source = entry.source === "retry-after" ? "retry-after" : "default";
  return { cooldownUntil: entry.until, cooldownSource: source };
}

export function clearAnthropicAccountCooldown(accountId: string): boolean {
  const registry = getPoolCooldownRegistry(POOL_KEY_ANTHROPIC);
  const had = registry.get(accountId) !== null;
  registry.clear(accountId);
  return had;
}

export function sweepExpiredAnthropicRoutingHealth(now = Date.now()): number {
  return getPoolCooldownRegistry(POOL_KEY_ANTHROPIC).sweep(now);
}

/** Test / logout helper. */
export function clearAnthropicAccountPoolState(): void {
  clearAccountPoolState(POOL_KEY_ANTHROPIC);
}

export function anthropicSessionAffinitySizeForTests(): number {
  return affinitySizeForTests(POOL_KEY_ANTHROPIC);
}

function hasKnownUsage(accountId: string): boolean {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  return typeof quota?.fiveHourPercent === "number" && Number.isFinite(quota.fiveHourPercent);
}

function anthropicUsageScore(accountId: string): number {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  if (!quota || typeof quota.fiveHourPercent !== "number" || !Number.isFinite(quota.fiveHourPercent)) {
    return UNKNOWN_USAGE_SCORE;
  }
  return Math.max(0, Math.min(100, quota.fiveHourPercent));
}

/** Background `local-cli` slots with expired access are not pool-eligible (identity adoption risk). */
function isPoolCredentialUsable(accountId: string, now: number): boolean {
  const cred = getAccountCredential(PROVIDER, accountId);
  if (!cred) return false;
  if (cred.source !== "local-cli") return true;
  if (canRefreshAnthropicPoolAccount(accountId)) return true;
  return cred.expires > now + TOKEN_SKEW_MS;
}

function isAnthropicAccountEligible(accountId: string, now: number): boolean {
  return isAccountPoolEligible(POOL_KEY_ANTHROPIC, accountId, now, {
    allowStickWait: isRateLimitStickWait(POOL_KEY_ANTHROPIC, accountId, now),
  });
}

export function getEligibleAnthropicAccounts(now = Date.now()): string[] {
  const set = getAccountSet(PROVIDER);
  if (!set) return [];
  return set.accounts
    .filter(account =>
      account.needsReauth !== true
      && isAnthropicAccountEligible(account.id, now)
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
  let bestScore = anthropicUsageScore(best);
  for (let i = 1; i < eligible.length; i++) {
    const id = eligible[i]!;
    const score = anthropicUsageScore(id);
    if (score < bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

/** Next eligible Anthropic account in stable order after `afterId` (wrapping). */
function pickNextFillFirstAnthropicAccount(
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
  return pickLowestUsage(excludeId, now);
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
  if (!hasKnownUsage(accountId)) return true;
  return anthropicUsageScore(accountId) < threshold;
}

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

function resolveAnthropicFillFirst(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  set: NonNullable<ReturnType<typeof getAccountSet>>,
  now: number,
): AnthropicAccountSelection {
  const key = normalizeAffinityComponent(sessionKey);
  if (key) {
    const affined = getSessionAffinity(POOL_KEY_ANTHROPIC, key, now);
    if (affined) {
      const stillThere = set.accounts.some(a => a.id === affined.accountId && a.needsReauth !== true);
      if (
        stillThere
        && isAnthropicAccountEligible(affined.accountId, now)
        && isPoolCredentialUsable(affined.accountId, now)
      ) {
        touchSessionAffinity(POOL_KEY_ANTHROPIC, key, now);
        return { accountId: affined.accountId, reason: "affinity" };
      }
      clearSessionAffinityForAccount(POOL_KEY_ANTHROPIC, affined.accountId);
    }
  }

  if (!key) {
    const activeOk = set.accounts.some(a => a.id === set.activeAccountId && a.needsReauth !== true)
      && isAnthropicAccountEligible(set.activeAccountId, now)
      && isPoolCredentialUsable(set.activeAccountId, now);
    if (activeOk) {
      return { accountId: set.activeAccountId, reason: "active" };
    }
  }

  const picked = pickFillFirstAnthropicAccount(config, now);
  if (!picked) {
    const anyCooled = set.accounts.some(a => !isAnthropicAccountEligible(a.id, now));
    return { accountId: null, reason: anyCooled ? "all-cooled" : "none" };
  }

  if (key && normalizeAffinityComponent(picked)) {
    bindSessionAffinity(POOL_KEY_ANTHROPIC, key, picked, now);
  }
  return { accountId: picked, reason: "fill-first" };
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

  if (anthropicPoolStrategy(config) === "fill-first") {
    return resolveAnthropicFillFirst(sessionKey, config, set, now);
  }

  const kernelResult = resolvePoolAccount(
    anthropicPoolPlugin,
    sessionKey ?? null,
    {
      strategy: anthropicPoolStrategy(config) === "round-robin" ? "round-robin" : "quota",
      enabled: true,
      activeAccountId: set.activeAccountId,
      stickyLimit: stickyLimitForPool(config),
      autoSwitchThreshold: anthropicAutoSwitchThreshold(config),
    },
    now,
  );

  return {
    accountId: kernelResult.accountId,
    reason: kernelResult.reason as AnthropicAccountSelectionReason,
  };
}

export function bindAnthropicSessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  bindSessionAffinity(POOL_KEY_ANTHROPIC, sessionKey, accountId, now);
}

export function clearAnthropicSessionAffinityForAccount(accountId: string): void {
  clearSessionAffinityForAccount(POOL_KEY_ANTHROPIC, accountId);
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

  recordPoolAccountCooldown(
    POOL_KEY_ANTHROPIC,
    failedAccountId,
    "rate_limit",
    retryAfterHeader,
    now,
  );
  clearSessionAffinityForAccount(POOL_KEY_ANTHROPIC, failedAccountId);
  notePoolRotationFailure(POOL_KEY_ANTHROPIC, failedAccountId);

  const next = pickAlternateAnthropicAccount(config, failedAccountId, now);
  if (!next) {
    console.warn("[anthropic-pool] all eligible Anthropic OAuth accounts are in cooldown; returning 429");
    return null;
  }

  const affinityKey = normalizeAffinityComponent(sessionKey);
  if (affinityKey && normalizeAffinityComponent(next)) {
    bindSessionAffinity(POOL_KEY_ANTHROPIC, affinityKey, next, now);
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
  clearAffinityState(POOL_KEY_ANTHROPIC);
  clearResolveState(POOL_KEY_ANTHROPIC);
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
  return buildSessionKeyFromParts(input);
}
