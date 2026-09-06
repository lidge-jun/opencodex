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
 * Affinity is process-local (lost on restart). Cooldown uses Retry-After when present, else
 * the reset time of whichever rate-limit window upstream reports as rejected, else a default
 * backoff. 401/403 credential failures should set needsReauth on the store (existing OAuth
 * path) so the account is excluded from eligibility.
 */
import { createHash } from "node:crypto";
import { captureOAuthAccountSelection, commitOAuthAccountSelection, credentialGeneration, getAccountSet, getAccountCredential, getAccountCredentialWithStatus } from "./store";
import type { OAuthAccessSnapshot } from "./index";
import { getCachedProviderAccountQuota } from "../providers/quota";
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import {
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  notePoolRotationFailure,
  notePoolRotationSuccess,
  pickRoundRobinAccount,
  peekRoundRobinAccount,
  POOL_KEY_ANTHROPIC,
  seedPoolRotationAccount,
} from "../codex/pool-rotation";
import type { OcxAccountPoolQuotaWindow, OcxAccountPoolRotationStrategy, OcxConfig } from "../types";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";
import { retainedUtf8Bytes } from "../lib/admission";

/**
 * The read side of a `Headers` object, so a caller can pass the live upstream response's
 * headers without this module importing anything from the server layer -- and so a test can
 * hand it a plain `new Headers({...})`.
 */
export type AnthropicRateLimitHeaders = Pick<Headers, "get">;

const PROVIDER = "anthropic";
/**
 * The cooldown for a refusal that states nothing about when it ends.
 *
 * A fixed short backoff and no ceiling of its own: with no upstream evidence there is
 * nothing to bound. The old 15-minute MAX_COOLDOWN_MS capped the STATED durations instead
 * and was removed with that clamp -- keeping it would have described a limit that no
 * remaining path applies. `generic-account-failover.ts` still has its own copy for the
 * providers it serves.
 */
const DEFAULT_COOLDOWN_MS = 60_000;
/**
 * Ceiling for a cooldown derived from an upstream-stated reset time.
 *
 * Anthropic's five-hour window answers a drained account with `Retry-After: 7999` and a
 * matching `anthropic-ratelimit-unified-5h-reset`. Clamping that to 15 minutes does not
 * shorten the ban -- upstream keeps refusing -- it only makes the pool re-offer the same
 * exhausted account every quarter hour and hand the client another 429. Five hours plus a
 * margin covers the longest window Anthropic publishes; anything beyond it is treated as a
 * wire anomaly rather than a fact.
 */
const MAX_MEASURED_COOLDOWN_MS = 6 * 60 * 60_000;
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

/**
 * Where a cooldown's length came from. Same vocabulary as `CodexCooldownSource`, because it
 * answers the same question for the same reason: `retry-after` is upstream answering THIS
 * refusal, `reset-derived` is upstream stating when the spent window reopens, and `default`
 * is our own guess. The dashboard renders the first as a rate limit and the rest as quota,
 * which is exactly the distinction a reset-derived cooldown carries -- collapsing it into
 * `retry-after` would report a drained five-hour window as request-rate throttling.
 */
type AnthropicCooldownSource = "retry-after" | "reset-derived" | "default";

interface AccountHealth {
  cooldownUntil: number;
  cooldownSource: AnthropicCooldownSource;
}

interface AffinityEntry {
  accountId: string;
  lastUsedAt: number;
}

const upstreamHealth = new Map<string, AccountHealth>();
const sessionAffinity = new Map<string, AffinityEntry>();
type OAuthAccountSelection = NonNullable<ReturnType<typeof captureOAuthAccountSelection>>;
// Undefined means this runtime has not admitted a selection yet; null means consumed.
// The startup baseline comes from the authoritative store, never a second persisted pin.
let manualPreference: OAuthAccountSelection | null | undefined;

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

/**
 * A Retry-After header as a cooldown length in ms.
 *
 * Both forms the RFC allows are a STATEMENT by upstream about when it will serve this
 * account again, so both are bounded by MAX_MEASURED_COOLDOWN_MS rather than by the
 * 15-minute ceiling that used to apply here. Truncating a stated 2h13m to 15 minutes was
 * the bug: it does not shorten the ban, it just re-offers the exhausted account four times
 * an hour, and each attempt spends a real request to earn another 429.
 */
function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_MEASURED_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? Math.min(delay, MAX_MEASURED_COOLDOWN_MS) : undefined;
}

/**
 * The cooldown implied by the account's own rate-limit headers, when they say a window is
 * spent.
 *
 * Retry-After is not always present on an Anthropic 429, but
 * `anthropic-ratelimit-unified-*-status: rejected` plus a `-reset` epoch always is, and it
 * names the exact second the window reopens. Only a REJECTED window counts: an `allowed`
 * window's reset is just the end of the current period, and cooling an account until then
 * would bench a healthy account for hours.
 *
 * With more than one window rejected the answer is the LATEST reset, not the earliest. The
 * limiter is AND-composed -- upstream refuses while ANY window rejects -- so an account whose
 * 5-hour bucket rolls in three minutes is still refused for the five days its weekly window
 * needs. Cooling to the earliest reset would re-offer that account every three minutes for
 * five days, which is the re-offer loop this whole path exists to end.
 */
function parseRateLimitResetMs(headers: AnthropicRateLimitHeaders | null | undefined, now: number): number | undefined {
  if (!headers) return undefined;
  let latest: number | undefined;
  for (const window of ["5h", "7d"] as const) {
    if (headers.get(`anthropic-ratelimit-unified-${window}-status`)?.trim() !== "rejected") continue;
    const resetSeconds = Number(headers.get(`anthropic-ratelimit-unified-${window}-reset`)?.trim());
    if (!Number.isFinite(resetSeconds) || resetSeconds <= 0) continue;
    const resetAt = resetSeconds * 1000;
    if (resetAt <= now) continue;
    if (latest === undefined || resetAt > latest) latest = resetAt;
  }
  if (latest === undefined) return undefined;
  return Math.min(latest - now, MAX_MEASURED_COOLDOWN_MS);
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
  manualPreference = undefined;
  quorumCache = null;
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

/**
 * How long a quorum answer may be reused before the store is consulted again.
 *
 * This predicate now runs on the INITIAL resolution of every Anthropic request, not just after a
 * 429, so an uncached implementation puts a synchronous file read in front of ordinary traffic:
 * `getAccountSet` goes through `loadAuthStore`, which has no cache of its own and chmods the
 * config dir, chmods the secret, reads the whole file and normalizes it on every call.
 *
 * Two seconds matches the generic module's `PRESENCE_CACHE_TTL_MS` for the same reason: short
 * enough that a login in another window is visible before the operator can switch back and send a
 * prompt, long enough that a burst of requests shares one read. The cache holds a BOOLEAN derived
 * from a count — never a credential, never an account id.
 *
 * Staleness is bounded by consequence, not only by the TTL. Explicit invalidation covers the
 * roster mutations this module can see (rotation, pool-state reset, affinity clear on account
 * removal, manual selection), but not one it cannot: a 401 elsewhere flagging an account
 * `needsReauth` drops the real quorum to one while a cached `true` survives for up to 2s.
 *
 * That window is harmless in both directions, which is why it is left rather than plumbed
 * through the store. A stale `true` only lets the caller ASK for an alternate;
 * `pickAlternateAnthropicAccount` re-reads the roster through `getEligibleAnthropicAccounts`,
 * skips the reauth-flagged account and returns `null`, so the 429 surfaces exactly as it would
 * have. A stale `false` costs one un-rotated 429 and self-corrects on the next read. Neither
 * can dispatch on an unusable credential, which is the only outcome worth adding a store hook
 * to prevent.
 */
const QUORUM_CACHE_TTL_MS = 2_000;

let quorumCache: { value: boolean; readAt: number } | null = null;

/**
 * Whether a 429 has somewhere to go: two or more accounts that could serve traffic if asked.
 *
 * Reactive failover is a safety net, not a routing policy. It runs only AFTER upstream refused,
 * it cannot spread load across a healthy session, and it cannot fire at all unless the operator
 * deliberately logged in twice. So it activates on presence, exactly like an `apiKeyPool` of two
 * keys does in `providers/key-failover.ts` -- and unlike the PROACTIVE pool (affinity,
 * quota-ranked new-session picks, `autoSwitchThreshold`, `strategy`), which changes which
 * account serves a healthy request and therefore stays behind `anthropicAccountPool.enabled`.
 *
 * Cooldowns are deliberately ignored here. They are transient and per-request, while this
 * answers the durable question "did the operator store a second account". Counting a cooled
 * account as absent would switch the feature off for the length of the cooldown -- precisely
 * when it is needed.
 *
 * `isPoolCredentialUsable` is still applied, so the fail-closed background `local-cli` rule
 * holds: an expired background slot is not a quorum and cannot be adopted.
 */
export function hasAnthropicFailoverQuorum(now = Date.now()): boolean {
  // Monotonic guard: a caller-supplied `now` that predates the cached read (tests pass explicit
  // clocks) must not be served from a future entry.
  if (quorumCache && now >= quorumCache.readAt && now - quorumCache.readAt < QUORUM_CACHE_TTL_MS) {
    return quorumCache.value;
  }
  const set = getAccountSet(PROVIDER);
  let value = false;
  if (set) {
    let usable = 0;
    for (const account of set.accounts) {
      if (account.needsReauth === true) continue;
      if (!isPoolCredentialUsable(account.id, now)) continue;
      if (++usable >= 2) { value = true; break; }
    }
  }
  quorumCache = { value, readAt: now };
  return value;
}

/** Test seam and manual-recovery hook: force the next quorum question to re-read the store. */
export function forgetAnthropicFailoverQuorum(): void {
  quorumCache = null;
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
    return peekRoundRobinAccount(POOL_KEY_ANTHROPIC, eligible, stickyLimitForPool(config));
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
  | "manual"
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
    const picked = peekRoundRobinAccount(POOL_KEY_ANTHROPIC, eligible, limit);
    if (!picked) return null;
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

  if (manualPreference === undefined) {
    manualPreference = set.selectionRevision !== undefined
      ? { accountId: set.activeAccountId, revision: set.selectionRevision }
      : null;
  }

  if (!isAnthropicAccountPoolEnabled(config)) {
    return { accountId: set.activeAccountId, reason: "pool-disabled" };
  }

  // A manual choice is a one-dispatch preference, not a lower-priority quota hint.
  // Consume it only after admission commits, so a failed token lookup cannot spend it.
  if (manualPreference) {
    if (manualPreference.accountId !== set.activeAccountId || manualPreference.revision !== set.selectionRevision) {
      manualPreference = null;
    } else {
      const chosen = manualPreference.accountId;
      const quota = getCachedProviderAccountQuota(PROVIDER, chosen);
      const exhausted = [quota?.fiveHourPercent, quota?.weeklyPercent, quota?.monthlyPercent,
        ...(quota?.customWindows ?? []).map(window => window.percent)]
        .some(percent => typeof percent === "number" && percent >= 100);
      if (!exhausted && getEligibleAnthropicAccounts(now).includes(chosen)) {
        return { accountId: chosen, reason: "manual" };
      }
    }
  }

  const key = normalizeAffinityComponent(sessionKey);
  if (key) {
    const affined = sessionAffinity.get(key);
    if (affined && now - affined.lastUsedAt <= AFFINITY_IDLE_TTL_MS) {
      const stillThere = set.accounts.some(a => a.id === affined.accountId && a.needsReauth !== true);
      if (stillThere && !isCooled(affined.accountId, now) && isPoolCredentialUsable(affined.accountId, now)) {
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
  // The roster just lost or changed a member. This is the account-removal path, so the next
  // activation question must re-read rather than answer from a count taken while the account
  // was still present -- otherwise a delete leaves a stale quorum for the length of the TTL.
  quorumCache = null;
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
  rateLimitHeaders?: AnthropicRateLimitHeaders | null,
): string | null {
  // Reactive 429 failover is NOT gated on the pool flag. That flag buys PROACTIVE routing --
  // session affinity, quota-ranked new-session selection, autoSwitchThreshold, strategy -- all
  // of which move a HEALTHY request and stay opt-in. Rotating away from an account upstream has
  // just rate-limited is a different thing: it only ever runs after a refusal, and stranding a
  // 429 while a second logged-in account sits idle is a defect, not a configuration choice.
  // Presence is the activation rule, the same one an apiKeyPool of two keys already uses.
  if (!isAnthropicAccountPoolEnabled(config) && !hasAnthropicFailoverQuorum(now)) return null;

  // Retry-After first: it is the header written FOR this decision. The rejected window's
  // reset is the fallback, because a 429 that omits Retry-After still carries it -- and
  // without that fallback such a refusal cools for the 60s default and the exhausted
  // account is back in the rotation a minute later.
  const parsedRetry = parseRetryAfterMs(retryAfterHeader, now);
  const resetDerived = parsedRetry === undefined ? parseRateLimitResetMs(rateLimitHeaders, now) : undefined;
  const cooldownMs = parsedRetry ?? resetDerived ?? DEFAULT_COOLDOWN_MS;
  upstreamHealth.set(failedAccountId, {
    cooldownUntil: now + cooldownMs,
    cooldownSource: parsedRetry !== undefined
      ? "retry-after"
      : resetDerived !== undefined ? "reset-derived" : "default",
  });
  sweepExpiredOnWrite(now);
  clearAnthropicSessionAffinityForAccount(failedAccountId);
  notePoolRotationFailure(POOL_KEY_ANTHROPIC, failedAccountId);
  // A rotation means the roster in use just changed; do not answer the next activation question
  // from a count read taken before the failure.
  quorumCache = null;

  // The pool's strategy is a PROACTIVE policy. When the pool is disabled, reactive
  // presence-only recovery must not silently reactivate round-robin/fill-first merely
  // because those dormant values remain in config. The quota picker is the neutral
  // recovery policy already used by the default strategy.
  const next = isAnthropicAccountPoolEnabled(config)
    ? pickAlternateAnthropicAccount(config, failedAccountId, now)
    : pickLowestUsage(config, failedAccountId, now);
  if (!next) {
    console.warn("[anthropic-pool] all eligible Anthropic OAuth accounts are in cooldown; returning 429");
    return null;
  }

  console.warn(
    `[anthropic-pool] 429 on ${formatAnthropicAccountOrdinal(failedAccountId)}; failing over to ${formatAnthropicAccountOrdinal(next)}`,
  );
  return next;
}

export interface AnthropicSelectionRoutingOptions {
  config: OcxConfig;
  sessionKey?: string | null;
  reason?: AnthropicAccountSelectionReason;
  expectedCredentialGeneration?: string;
}

/** Commit the selected account before dispatch; rejected proposals have no routing side effects. */
export async function promoteAnthropicActiveAccount(
  accountId: string,
  expectedSelection: OAuthAccountSelection | null,
  options: AnthropicSelectionRoutingOptions,
): Promise<OAuthAccountSelection | null> {
  if (!expectedSelection || !isPoolCredentialUsable(accountId, Date.now()) || isCooled(accountId, Date.now())) return null;
  const committed = await commitOAuthAccountSelection(PROVIDER, accountId, {
    expectedSelection,
    expectedCredentialGeneration: options.expectedCredentialGeneration,
    requireUsableAccount: true,
  });
  if (!committed) return null;
  return commitAnthropicSelectionRouting(accountId, expectedSelection, committed, options) ? committed : null;
}

/** Main's shared selection owner calls this only after its authoritative commit succeeds. */
export function commitAnthropicSelectionRouting(
  accountId: string,
  expectedSelection: OAuthAccountSelection,
  committed: OAuthAccountSelection,
  options: AnthropicSelectionRoutingOptions,
): boolean {
  if (committed.accountId !== accountId) return false;
  const current = captureOAuthAccountSelection(PROVIDER);
  if (current?.accountId !== committed.accountId || current.revision !== committed.revision) return false;
  if (isAnthropicAccountPoolEnabled(options.config)) {
    if (anthropicPoolStrategy(options.config) === "round-robin" && options.reason !== "affinity") {
      const limit = stickyLimitForPool(options.config);
      const picked = pickRoundRobinAccount(POOL_KEY_ANTHROPIC, getEligibleAnthropicAccounts(), limit);
      if (picked !== accountId) seedPoolRotationAccount(POOL_KEY_ANTHROPIC, accountId);
      notePoolRotationSuccess(POOL_KEY_ANTHROPIC, accountId, limit);
    }
    bindAnthropicSessionAffinity(options.sessionKey, accountId);
  }
  if (manualPreference === undefined || (manualPreference?.accountId === expectedSelection.accountId
    && manualPreference.revision === expectedSelection.revision)) manualPreference = null;
  return true;
}

/**
 * Manual selection resets session affinity and seeds the RR ring so the next
 * unbound new session honors the operator-chosen account (Codex parity).
 */
export function resetAnthropicRoutingForManualSelection(accountId: string): void {
  sessionAffinity.clear();
  manualPreference = captureOAuthAccountSelection(PROVIDER);
  seedPoolRotationAccount(POOL_KEY_ANTHROPIC, accountId);
  // A manual account selection is an operator statement about the roster; do not answer the
  // next activation question from a count read before it.
  quorumCache = null;
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

/** Resolve through the pool's local-CLI restrictions, then bind the exact returned generation. */
export async function getAnthropicPoolAccessSnapshot(accountId: string): Promise<OAuthAccessSnapshot> {
  const accessToken = await getAnthropicPoolAccessToken(accountId);
  const row = getAccountCredentialWithStatus(PROVIDER, accountId);
  if (!row || row.needsReauth || row.credential.access !== accessToken
    || row.credential.expires <= Date.now()) {
    throw new Error("Anthropic pool credential changed during account selection");
  }
  return { provider: PROVIDER, accountId, accessToken, generation: credentialGeneration(row.credential) };
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
