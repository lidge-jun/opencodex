import { createHash } from "node:crypto";
import { getValidAccessTokenForAccount } from "../../oauth";
import { getAccountCredential, getAccountSet } from "../../oauth/store";
import type { GenerationContext } from "../../lib/state-store-sweeper";
import { ACCOUNT_QUOTA_TTL_MS, toFiniteNumber } from "../quota-wire";
import { clearKiroAccountUsageState, reconcileKiroAccountUsageState } from "../kiro-usage";
import { cancelPendingAccountQuotaPersist, readPersistedAccountQuotas, schedulePersistAccountQuotas } from "../account-quota-disk";
import { replaceCachedProviderQuotas } from "../quota-routing-cache";
import { getProviderRegistryEntry } from "../registry";
import { getProviderQuotaReportCache, hasQuotaRows, routingEvidence, setProviderQuotaReportCache } from "./report-cache";
import { isCanonicalCommandCodeBaseUrl, isCanonicalKimiCodeBaseUrl } from "./vendor-probes-key";
import type { AccountQuotaMode, ProviderQuota, ProviderQuotaWindow, QuotaFailureCode } from "../quota-types";
import type { OcxConfig, OcxProviderConfig } from "../../types";

/** Match oauth/index REFRESH_SKEW_MS — use stored access without refresh when still fresh. */
const ACCOUNT_TOKEN_SKEW_MS = 60_000;

/**
 * Anthropic and Kiro both report usage per CREDENTIAL, so every logged-in account can be
 * probed with its own bearer token — the active-account selection and the local usage log
 * are irrelevant here. Mirrors the Codex pool behaviour
 * (codex/auth-api.ts:fetchPoolAccountQuota), including a per-account TTL so N accounts cost
 * at most N upstream calls per window. `ACCOUNT_QUOTA_TTL_MS` lives in `quota-wire.ts`
 * because the Kiro exhaustion reader applies the same staleness bound.
 */
export type AccountQuotaCacheEntry = {
  ts: number;
  quota: ProviderQuota | null;
  /** Last probe failed (429 / network / expired login); still may hold last-good quota. */
  unavailable?: true;
  quotaFailure?: QuotaFailureCode;
  quotaFailureIsCurrent?: () => boolean;
  /** Private new-reader identity; never persisted or serialized. */
  identity?: string;
  isCurrent?: () => boolean;
};
/** Expired measurements become unknown; missing reset evidence never implies a fresh allowance. */
export function normalizeAnthropicQuota(quota: ProviderQuota | null | undefined, now: number): ProviderQuota | null {
  if (!quota) return null;
  const validReset = (resetAt: unknown): resetAt is number => typeof resetAt === "number"
    && Number.isFinite(resetAt) && resetAt > 0 && Number.isFinite(new Date(resetAt).getTime());
  let result = quota;
  for (const [percent, reset] of [
    ["fiveHourPercent", "fiveHourResetAt"],
    ["weeklyPercent", "weeklyResetAt"],
    ["monthlyPercent", "monthlyResetAt"],
  ] as const) {
    const resetAt = quota[reset];
    if (resetAt === undefined) continue;
    const valid = validReset(resetAt);
    if (valid && resetAt > now) continue;
    if (result === quota) result = { ...quota };
    if (valid) delete result[percent];
    delete result[reset];
  }
  // Persisted rows validate only the outer quota object, so custom data may be malformed.
  if (quota.customWindows !== undefined) {
    const windows = Array.isArray(quota.customWindows) ? quota.customWindows : [];
    const retained: ProviderQuotaWindow[] = [];
    let changed = !Array.isArray(quota.customWindows);
    for (const window of windows) {
      if (!window || typeof window !== "object" || typeof window.label !== "string" || !window.label.trim()
        || typeof window.percent !== "number" || !Number.isFinite(window.percent)
        || window.percent < 0 || window.percent > 100) {
        changed = true;
        continue;
      }
      if (validReset(window.resetAt) && window.resetAt <= now) {
        changed = true;
        continue;
      }
      if (window.resetAt !== undefined && !validReset(window.resetAt)) {
        const normalized = { ...window };
        delete normalized.resetAt;
        retained.push(normalized);
        changed = true;
      } else {
        retained.push(window);
      }
    }
    if (changed) {
      if (result === quota) result = { ...quota };
      if (retained.length) result.customWindows = retained;
      else delete result.customWindows;
    }
  }
  return hasQuotaRows(result) ? result : null;
}

export const accountQuotaCache = new Map<string, AccountQuotaCacheEntry>();
export let explicitAccountEpoch = 0;

/**
 * Seed the cache from the last run, once.
 *
 * Without this a restart forgets every measurement, so the pool opens its next turn with
 * no idea which account has room — the exact blindness pre-dispatch selection exists to
 * remove. A hydrated row is still subject to the ordinary TTL, so it orders the first
 * request and is replaced by a live probe immediately after.
 */
let diskHydrated = false;
export function hydrateAccountQuotaCache(): void {
  if (diskHydrated) return;
  diskHydrated = true;
  for (const [key, quota] of readPersistedAccountQuotas()) {
    // Disk stores observation time, not the Anthropic usage probe's clock.
    if (!accountQuotaCache.has(key)) {
      const anthropic = key.startsWith("anthropic\u0000");
      accountQuotaCache.set(key, {
        ts: anthropic ? 0 : quota.updatedAt,
        quota: anthropic ? normalizeAnthropicQuota(quota, Date.now()) : quota,
      });
    }
  }
}

export function persistAccountQuotaCache(): void {
  schedulePersistAccountQuotas(function* () {
    const now = Date.now();
    for (const [key, entry] of accountQuotaCache) {
      const quota = key.startsWith("anthropic\u0000") ? normalizeAnthropicQuota(entry.quota, now) : entry.quota;
      if (quota) yield [key, quota] as [string, ProviderQuota];
    }
  });
}
export const accountQuotaInflight = new Map<string, Promise<AccountQuotaCacheEntry>>();
let lastReconciledGeneration = 0;
let liveAccountQuotaKeys = new Set<string>();
let liveProviderQuotaKeys = new Set<string>();

export function mayCommitAccountQuotaKey(key: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration || liveAccountQuotaKeys.has(key);
}

export function mayCommitProviderQuotaKey(key: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration || liveProviderQuotaKeys.has(key);
}

export interface ProviderAccountQuota {
  accountId: string;
  quota: ProviderQuota | null;
  /** Set when the probe could not reach upstream (expired login, 429, network). */
  unavailable?: true;
  quotaFailure?: QuotaFailureCode;
  quotaFailureIsCurrent?: () => boolean;
  isCurrent?: () => boolean;
}

/** Providers whose per-account quota can be probed. Extend as other OAuth APIs are covered. */
export function supportsPerAccountQuota(provider: string): boolean {
  return provider === "anthropic" || provider === "kiro" || provider === "google-antigravity"
    || explicitAccountReader(provider);
}

export function explicitAccountReader(provider: string): boolean {
  return provider === "xai" || provider === "cursor" || provider === "kimi" || provider === "command-code";
}

export function providerOAuthAccountQuotaMode(provider: string): AccountQuotaMode {
  return hasPassiveAccountQuota(provider) ? "passive" : supportsPerAccountQuota(provider) ? "probe" : "unsupported";
}

export function accountCacheKey(provider: string, accountId: string): string {
  return `${provider}\u0000${accountId}`;
}

/**
 * Synchronous last-good per-account quota read for routing. Never probes the network.
 * Returns null when nothing is cached (or the cached row has no bars).
 */
export function getCachedProviderAccountQuota(provider: string, accountId: string): ProviderQuota | null {
  const entry = accountQuotaCache.get(accountCacheKey(provider, accountId));
  if (entry?.isCurrent && !entry.isCurrent()) return null;
  return provider === "anthropic" ? normalizeAnthropicQuota(entry?.quota, Date.now()) : entry?.quota ?? null;
}

/** Test-only: seed or clear the per-account quota cache without probing upstream. */
export function setCachedProviderAccountQuotaForTests(
  provider: string,
  accountId: string,
  quota: ProviderQuota | null,
): void {
  const key = accountCacheKey(provider, accountId);
  if (quota === null) {
    accountQuotaCache.delete(key);
    return;
  }
  accountQuotaCache.set(key, { ts: Date.now(), quota });
}

/** Unified headers report utilization fractions and epoch-second reset times. */
function anthropicHeaderResetAt(value: string | null): number | undefined {
  const seconds = toFiniteNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const timestamp = seconds * 1000;
  return Number.isFinite(new Date(timestamp).getTime()) ? timestamp : undefined;
}

export function parseAnthropicRateLimitHeaders(headers: Headers): ProviderQuota | null {
  const fiveHourPercent = normalizeUtilizationFraction(headers.get("anthropic-ratelimit-unified-5h-utilization"));
  const weeklyPercent = normalizeUtilizationFraction(headers.get("anthropic-ratelimit-unified-7d-utilization"));
  if (fiveHourPercent === undefined && weeklyPercent === undefined) return null;
  const fiveHourResetAt = anthropicHeaderResetAt(headers.get("anthropic-ratelimit-unified-5h-reset"));
  const weeklyResetAt = anthropicHeaderResetAt(headers.get("anthropic-ratelimit-unified-7d-reset"));
  return {
    ...(fiveHourPercent !== undefined ? { fiveHourPercent } : {}),
    ...(fiveHourPercent !== undefined && fiveHourResetAt !== undefined ? { fiveHourResetAt } : {}),
    ...(weeklyPercent !== undefined ? { weeklyPercent } : {}),
    ...(weeklyPercent !== undefined && weeklyResetAt !== undefined ? { weeklyResetAt } : {}),
    updatedAt: Date.now(),
  };
}

/** Reject unknown scales; round fraction conversion for persisted/displayed percentages. */
function normalizeUtilizationFraction(value: string | null): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || numeric > 1) return undefined;
  return Math.round(numeric * 10_000) / 100;
}

/**
 * Merge serving-account observations without advancing the usage probe's clock or
 * erasing model-specific windows. The caller owns credential attribution; this guard
 * prevents a retired account key from being revived by an older config generation.
 */
export function recordAnthropicAccountQuotaFromHeaders(
  accountId: string,
  headers: Headers,
  writerGeneration: number,
): void {
  if (!accountId) return;
  const observed = parseAnthropicRateLimitHeaders(headers);
  if (!observed) return;
  const key = accountCacheKey("anthropic", accountId);
  if (!mayCommitAccountQuotaKey(key, writerGeneration)) return;
  // Hydrate before writing, for the same reason `recordPassiveAccountQuota` does: this write
  // arrives unprompted from the request path, and `persistAccountQuotaCache` serializes the
  // whole map. Landing before any reader has hydrated would persist this single row and erase
  // every other provider's saved row.
  hydrateAccountQuotaCache();
  const previous = accountQuotaCache.get(key);
  accountQuotaCache.set(key, {
    ...previous,
    // Headers do not prove that the last usage probe succeeded.
    ts: previous?.ts ?? 0,
    quota: normalizeAnthropicQuota({
      ...normalizeAnthropicQuota(previous?.quota, observed.updatedAt), ...observed,
    }, observed.updatedAt),
  });
  persistAccountQuotaCache();
}

/**
 * Providers whose per-account quota is OBSERVED in-band, never probed.
 *
 * Deliberately separate from `supportsPerAccountQuota` rather than folded into it. That
 * predicate gates explicit upstream readers. Meta publishes no quota endpoint, so it
 * remains a cache-only observation even when every probe reader is account-scoped.
 */
export function hasPassiveAccountQuota(provider: string): boolean {
  return provider === "meta-muse";
}

/**
 * Record a quota observed in-band on a streaming turn.
 *
 * The CALLER captures `writerGeneration` when it resolves the serving credential, not
 * this function at write time. A streaming turn is a long await, and a generation
 * captured immediately before the write cannot see a config or account change that
 * happened EARLIER in the same turn — which is exactly the case the fence exists for.
 */
export function recordPassiveAccountQuota(
  provider: string,
  accountId: string,
  quota: ProviderQuota,
  writerGeneration: number,
): void {
  if (!hasPassiveAccountQuota(provider) || !accountId) return;
  const key = accountCacheKey(provider, accountId);
  if (!mayCommitAccountQuotaKey(key, writerGeneration)) return;
  // Hydrate BEFORE writing, not only on the read path. `persistAccountQuotaCache`
  // serializes the whole in-memory map, so a passive write that lands before anything
  // has read the cache would persist this one row and erase every other provider's
  // saved row -- and `diskHydrated` would then stop any later reader from recovering
  // them. A probe writer cannot hit this because its own read hydrates first; an
  // observation arrives unprompted, so it must hydrate itself.
  hydrateAccountQuotaCache();
  accountQuotaCache.set(key, { ts: Date.now(), quota });
  // Persisted so a restart keeps the last observation: with no probe to re-establish it,
  // a forgotten row stays forgotten until the user happens to run another streaming turn.
  persistAccountQuotaCache();
  // sweepExpiredOnWrite is deliberately NOT called. Existing probe writers call it
  // because they run on a poll; this runs on the request path, where a state sweep does
  // not belong. Passive rows are still reclaimed by generation reconciliation
  // (reconcileProviderAccountQuotaRows) and by the disk reader's age bound.
}

/**
 * Cache-only per-account rows for a passive provider. Never probes, never refreshes.
 *
 * An account with no observation is OMITTED rather than returned with `quota: null` and
 * `unavailable`: that pair means "a probe was attempted and failed", and no probe was
 * ever attempted here. A user who has not yet run a streaming turn simply has no
 * measurement, which is not an error state.
 */
export function readPassiveProviderAccountQuotas(provider: string): ProviderAccountQuota[] {
  if (!hasPassiveAccountQuota(provider)) return [];
  // Idempotent, and otherwise only reached from probe paths a passive provider never
  // enters — without it a restart shows nothing until the next streaming turn, even
  // though the row is sitting on disk.
  hydrateAccountQuotaCache();
  const set = getAccountSet(provider);
  if (!set) return [];
  const rows: ProviderAccountQuota[] = [];
  for (const account of set.accounts) {
    const entry = accountQuotaCache.get(accountCacheKey(provider, account.id));
    if (entry?.quota) rows.push({ accountId: account.id, quota: entry.quota });
  }
  return rows;
}

export function sweepExpiredProviderAccountQuotaRows(now = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of accountQuotaCache) {
    // Anthropic observations extend retention, never the usage probe's eligibility clock.
    const retainedAt = key.startsWith("anthropic\u0000")
      ? Math.max(entry.ts, entry.quota?.updatedAt ?? 0)
      : entry.ts;
    if (retainedAt + ACCOUNT_QUOTA_TTL_MS > now) continue;
    accountQuotaCache.delete(key);
    removed += 1;
  }
  return removed;
}

export function reconcileProviderAccountQuotaRows(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  let removed = 0;
  for (const key of accountQuotaCache.keys()) {
    if (context.oauthAccountKeys.has(key)) continue;
    accountQuotaCache.delete(key);
    removed += 1;
  }
  // Kiro exhaustion rows are keyed identically, so they retire with their quota row; a
  // verdict outliving its account would hand the replacement a cooldown it never earned.
  removed += reconcileKiroAccountUsageState(context.oauthAccountKeys);
  const cachedReports = getProviderQuotaReportCache();
  if (cachedReports) {
    const reports = cachedReports.response.reports.filter(report => context.providerNames.has(report.provider));
    removed += cachedReports.response.reports.length - reports.length;
    setProviderQuotaReportCache({ ...cachedReports, response: { ...cachedReports.response, reports } });
    replaceCachedProviderQuotas(reports, routingEvidence);
  }
  liveAccountQuotaKeys = new Set(context.oauthAccountKeys);
  liveProviderQuotaKeys = new Set(context.providerNames);
  lastReconciledGeneration = context.generation;
  return removed;
}

/** Test-only reset so a direct reconcile call in one file cannot leak across files. */
export function resetProviderQuotaReconcileStateForTests(): void {
  lastReconciledGeneration = 0;
  liveAccountQuotaKeys = new Set();
  liveProviderQuotaKeys = new Set();
}

/** Drop cached per-account rows (all, or just one provider's). */
export function clearAccountQuotaCache(provider?: string): void {
  explicitAccountEpoch += 1;
  if (!provider) {
    accountQuotaCache.clear();
    accountQuotaInflight.clear();
    clearKiroAccountUsageState();
    // A cleared cache must not be re-seeded from the file it was just cleared of, and any
    // pending write of the old rows is abandoned.
    diskHydrated = false;
    cancelPendingAccountQuotaPersist();
    return;
  }
  const prefix = `${provider}\u0000`;
  for (const key of [...accountQuotaCache.keys()]) {
    if (key.startsWith(prefix)) accountQuotaCache.delete(key);
  }
  clearKiroAccountUsageState(prefix);
  // Drop in-flight probes too so a late resolve cannot repopulate after logout/remove.
  for (const key of [...accountQuotaInflight.keys()]) {
    if (key.startsWith(prefix)) accountQuotaInflight.delete(key);
  }
  persistAccountQuotaCache();
}

/**
 * Resolve a bearer for quota probing without silently adopting a newer global
 * Claude CLI credential into a background multiauth slot.
 *
 * - Fresh stored access → use as-is (no refresh).
 * - Active account with expired access → normal refresh path.
 * - Background `local-cli` with expired access → fail closed (unavailable):
 *   `getValidAccessTokenForAccount` can persist a mismatched Claude CLI identity.
 * - Background ordinary OAuth (`source !== "local-cli"`) → safe to refresh;
 *   Anthropic's lock only adopts disk credentials for `local-cli` rows.
 */
export async function getTokenForAccountQuotaProbe(provider: string, accountId: string): Promise<string> {
  const stored = getAccountCredential(provider, accountId);
  if (!stored) throw new Error("account credential missing");
  if (stored.expires > Date.now() + ACCOUNT_TOKEN_SKEW_MS) return stored.access;
  const activeId = getAccountSet(provider)?.activeAccountId;
  if (activeId !== accountId && stored.source === "local-cli") {
    throw new Error("background local-cli token expired; skip CLI-adopting refresh for quota probe");
  }
  return getValidAccessTokenForAccount(provider, accountId);
}

export function explicitQuotaConfig(provider: string, configured?: OcxProviderConfig): OcxProviderConfig | undefined {
  if (configured) return configured;
  const entry = getProviderRegistryEntry(provider);
  return entry ? { adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: "oauth" } : undefined;
}

export function explicitQuotaIdentity(provider: string, accountId: string, configured?: OcxProviderConfig): string | undefined {
  const credential = getAccountCredential(provider, accountId);
  const target = explicitQuotaConfig(provider, configured);
  if (!credential || !target) return undefined;
  return quotaCredentialIdentity(provider, accountId, credential, target);
}

export function quotaCredentialIdentity(provider: string, accountId: string, credential: NonNullable<ReturnType<typeof getAccountCredential>>, target: OcxProviderConfig): string {
  return createHash("sha256").update(JSON.stringify([
    provider, accountId, credential.access, credential.refresh, credential.expires,
    credential.accountId, credential.projectId, credential.source,
    target.adapter, target.baseUrl, target.authMode, target.disabled === true,
  ])).digest("hex");
}

export function explicitQuotaDestination(provider: string, config: OcxProviderConfig): boolean {
  if (config.disabled === true || config.authMode !== "oauth") return false;
  if (provider === "kimi") return isCanonicalKimiCodeBaseUrl(config.baseUrl);
  if (provider === "command-code") return isCanonicalCommandCodeBaseUrl(config.baseUrl);
  // These readers use fixed canonical billing origins, never config.baseUrl.
  return provider === "xai" || provider === "cursor";
}
