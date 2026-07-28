import { fetchMainAccountInfo, listCodexAuthAccounts } from "../codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/main-account";
import { resolveEnvValue } from "../config";
import { getValidAccessToken, getValidAccessTokenForAccount } from "../oauth";
import { getAccountCredential, getAccountSet, getCredential } from "../oauth/store";
import { antigravityUserAgent } from "../adapters/client-fingerprint";
import { getProviderRegistryEntry, providerCodexAccountMode } from "./registry";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "./openai-tiers";

/** Match oauth/index REFRESH_SKEW_MS — use stored access without refresh when still fresh. */
const ACCOUNT_TOKEN_SKEW_MS = 60_000;

const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_CODE_USAGE_URL = `${KIMI_CODE_BASE_URL}/usages`;
/** Keep a failed probe's previous row at most this long before dropping it. */
const LAST_GOOD_MAX_AGE_MS = 30 * 60_000;

export interface ProviderQuotaWindow {
  label: string;
  percent: number;
  resetAt?: number;
}

export interface ProviderQuota {
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  monthlyPercent?: number;
  monthlyResetAt?: number;
  customWindows?: ProviderQuotaWindow[];
  updatedAt: number;
}

export interface ProviderQuotaReport {
  provider: string;
  label: string;
  source: string;
  quota: ProviderQuota;
  updatedAt: number;
  reverseEngineered?: boolean;
}

export interface ProviderQuotaResponse {
  generatedAt: number;
  reports: ProviderQuotaReport[];
}

let cache: { key: string; ts: number; response: ProviderQuotaResponse } | null = null;
const inflight = new Map<string, { epoch: number; promise: Promise<ProviderQuotaResponse> }>();
/** Bumped on cache clear and on force-refresh start; stale-epoch probes lose commit authority. */
let invalidationEpoch = 0;

/** Invalidate the report cache (e.g. after switching a provider's active account). */
export function clearProviderQuotaCache(): void {
  cache = null;
  invalidationEpoch += 1;
}

function cacheKey(config: OcxConfig): string {
  const providers = Object.entries(config.providers)
    .map(([name, provider]) => `${name}:${provider.adapter}:${provider.authMode ?? "key"}:${providerCodexAccountMode(name, provider) ?? "none"}:${provider.disabled === true ? "off" : "on"}:${provider.baseUrl}`)
    .sort()
    .join("|");
  return `${config.defaultProvider}|${config.activeCodexAccountId ?? ""}|${providers}`;
}

function hasQuotaRows(quota: ProviderQuota | null | undefined): quota is ProviderQuota {
  if (!quota) return false;
  return typeof quota.fiveHourPercent === "number"
    || typeof quota.weeklyPercent === "number"
    || typeof quota.monthlyPercent === "number"
    || !!quota.customWindows?.some(window => typeof window.percent === "number");
}

function providerLabel(providerId: string): string {
  return getProviderRegistryEntry(providerId)?.label ?? providerId;
}

function normalizeResetAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    // Cursor Connect RPC returns billingCycleEnd as a unix-ms decimal string ("1771077734000").
    // Date.parse treats that as invalid; numeric epoch strings must be handled explicitly.
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizePercent(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  return numeric === undefined ? undefined : Math.max(0, Math.min(100, numeric));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isBuiltInChatGptForwardProvider(name: string, provider: OcxProviderConfig): boolean {
  return name === OPENAI_CODEX_PROVIDER_ID && isCanonicalOpenAiForwardProvider(provider);
}

function report(provider: string, source: string, quota: ProviderQuota): ProviderQuotaReport | null {
  if (!hasQuotaRows(quota)) return null;
  return {
    provider,
    label: providerLabel(provider),
    source,
    quota,
    updatedAt: quota.updatedAt,
  };
}

async function fetchChatGptForwardQuota(
  config: OcxConfig,
  provider: string,
  providerConfig: OcxProviderConfig,
  forceRefresh: boolean,
): Promise<ProviderQuotaReport | null> {
  if (providerCodexAccountMode(provider, providerConfig) === "direct") {
    const main = await fetchMainAccountInfo(forceRefresh);
    const quota = main.quota ? { ...main.quota, updatedAt: Date.now() } as ProviderQuota : null;
    return quota ? report(provider, "chatgpt:wham", quota) : null;
  }
  const accounts = await listCodexAuthAccounts(config, forceRefresh);
  const activeId = config.activeCodexAccountId || MAIN_CODEX_ACCOUNT_ID;
  const active = accounts.find(account => account.id === activeId)
    ?? accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)
    ?? accounts[0];
  const quota = active?.quota ? { ...active.quota, updatedAt: active.quota.updatedAt ?? Date.now() } as ProviderQuota : null;
  return quota ? report(provider, "chatgpt:wham", quota) : null;
}

function centsValue(value: unknown): number | undefined {
  const rec = asRecord(value);
  return rec ? toFiniteNumber(rec.val) : undefined;
}

async function fetchXaiQuota(provider: string): Promise<ProviderQuotaReport | null> {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken("xai");
  } catch {
    return null;
  }
  const response = await fetch("https://cli-chat-proxy.grok.com/v1/billing", {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await response.json().catch(() => null));
  const config = asRecord(body?.config);
  if (!config) return null;
  const limitCents = centsValue(config.monthlyLimit);
  const usedCents = centsValue(config.used);
  if (limitCents === undefined || usedCents === undefined || limitCents <= 0) return null;
  const percent = normalizePercent((usedCents / limitCents) * 100);
  if (percent === undefined) return null;
  const quota: ProviderQuota = {
    monthlyPercent: percent,
    monthlyResetAt: normalizeResetAt(config.billingPeriodEnd),
    updatedAt: Date.now(),
  };
  return report(provider, "xai:grok-billing", quota);
}

function parseClaudeBucket(value: unknown): { percent?: number; resetAt?: number } | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const percent = normalizePercent(rec.utilization);
  const resetAt = normalizeResetAt(rec.resets_at);
  if (percent === undefined && resetAt === undefined) return null;
  return { percent, resetAt };
}

/** Claude's OAuth usage endpoint, probed with ONE account's own bearer token. */
const anthropicUsageInflight = new Map<string, Promise<ProviderQuota | null>>();

async function fetchAnthropicUsageQuota(accessToken: string): Promise<ProviderQuota | null> {
  const joinable = anthropicUsageInflight.get(accessToken);
  if (joinable) return joinable;

  const probe = (async (): Promise<ProviderQuota | null> => {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "claude-cli/2.1.63 (external, cli)",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = asRecord(await response.json().catch(() => null));
    if (!body) return null;
    const fiveHour = parseClaudeBucket(body.five_hour);
    const sevenDay = parseClaudeBucket(body.seven_day);
    const opus = parseClaudeBucket(body.seven_day_opus);
    const sonnet = parseClaudeBucket(body.seven_day_sonnet);
    const customWindows: ProviderQuotaWindow[] = [];
    if (opus?.percent !== undefined) customWindows.push({ label: "Opus", percent: opus.percent, ...(opus.resetAt !== undefined ? { resetAt: opus.resetAt } : {}) });
    if (sonnet?.percent !== undefined) customWindows.push({ label: "Sonnet", percent: sonnet.percent, ...(sonnet.resetAt !== undefined ? { resetAt: sonnet.resetAt } : {}) });
    const quota: ProviderQuota = {
      // Claude's 5-hour window is a first-class rate limit, same as the Codex login 5h/weekly
      // rows: report it in the canonical fields so the dashboard renders it with the standard
      // "5-hour limit" label and ordering instead of as a generic extra window.
      ...(fiveHour?.percent !== undefined ? { fiveHourPercent: fiveHour.percent } : {}),
      ...(fiveHour?.resetAt !== undefined ? { fiveHourResetAt: fiveHour.resetAt } : {}),
      ...(sevenDay?.percent !== undefined ? { weeklyPercent: sevenDay.percent } : {}),
      ...(sevenDay?.resetAt !== undefined ? { weeklyResetAt: sevenDay.resetAt } : {}),
      ...(customWindows.length > 0 ? { customWindows } : {}),
      updatedAt: Date.now(),
    };
    // Empty / schema-changed payloads must not cache as "success with no bars".
    return hasQuotaRows(quota) ? quota : null;
  })().finally(() => {
    if (anthropicUsageInflight.get(accessToken) === probe) anthropicUsageInflight.delete(accessToken);
  });
  anthropicUsageInflight.set(accessToken, probe);
  return probe;
}

async function fetchAnthropicQuota(provider: string): Promise<ProviderQuotaReport | null> {
  // Capture the account we intend to probe before awaiting — a mid-flight active
  // switch must not seed the wrong account's cache with this response.
  const probedAccountId = getAccountSet("anthropic")?.activeAccountId;
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken("anthropic");
  } catch {
    return null;
  }
  const quota = await fetchAnthropicUsageQuota(accessToken);
  if (!quota) return null;
  // Share the active-account probe with the per-account cache so Providers-page
  // loads do not double-hit Anthropic's rate-limited usage endpoint.
  if (probedAccountId) {
    const stillOwnsToken = getAccountCredential("anthropic", probedAccountId)?.access === accessToken;
    if (stillOwnsToken) {
      accountQuotaCache.set(accountCacheKey("anthropic", probedAccountId), { ts: Date.now(), quota });
    }
  }
  return report(provider, "anthropic:oauth-usage", quota);
}

// ---------------------------------------------------------------------------
// Per-account quota (multiauth)
// ---------------------------------------------------------------------------

/**
 * Anthropic reports usage per CREDENTIAL, so every logged-in account can be probed with its
 * own bearer token — the active-account selection and the local usage log are irrelevant here.
 * Mirrors the Codex pool behaviour (codex/auth-api.ts:fetchPoolAccountQuota), including a
 * per-account TTL so N accounts cost at most N upstream calls per window.
 *
 * The TTL is deliberately longer than the provider-level one: this path multiplies by account
 * count, and Anthropic rate-limits the usage endpoint (observed 429 under repeated probing).
 */
const ACCOUNT_QUOTA_TTL_MS = 10 * 60_000;
type AccountQuotaCacheEntry = {
  ts: number;
  quota: ProviderQuota | null;
  /** Last probe failed (429 / network / expired login); still may hold last-good quota. */
  unavailable?: true;
};
const accountQuotaCache = new Map<string, AccountQuotaCacheEntry>();
const accountQuotaInflight = new Map<string, Promise<AccountQuotaCacheEntry>>();

export interface ProviderAccountQuota {
  accountId: string;
  quota: ProviderQuota | null;
  /** Set when the probe could not reach upstream (expired login, 429, network). */
  unavailable?: true;
}

/** Providers whose per-account quota can be probed. Extend as other OAuth APIs are covered. */
export function supportsPerAccountQuota(provider: string): boolean {
  return provider === "anthropic";
}

function accountCacheKey(provider: string, accountId: string): string {
  return `${provider}\u0000${accountId}`;
}

/**
 * Synchronous last-good per-account quota read for routing. Never probes the network.
 * Returns null when nothing is cached (or the cached row has no bars).
 */
export function getCachedProviderAccountQuota(provider: string, accountId: string): ProviderQuota | null {
  const entry = accountQuotaCache.get(accountCacheKey(provider, accountId));
  return entry?.quota ?? null;
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

/** Drop cached per-account rows (all, or just one provider's). */
export function clearAccountQuotaCache(provider?: string): void {
  if (!provider) {
    accountQuotaCache.clear();
    accountQuotaInflight.clear();
    return;
  }
  const prefix = `${provider}\u0000`;
  for (const key of [...accountQuotaCache.keys()]) {
    if (key.startsWith(prefix)) accountQuotaCache.delete(key);
  }
  // Drop in-flight probes too so a late resolve cannot repopulate after logout/remove.
  for (const key of [...accountQuotaInflight.keys()]) {
    if (key.startsWith(prefix)) accountQuotaInflight.delete(key);
  }
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
async function getTokenForAccountQuotaProbe(provider: string, accountId: string): Promise<string> {
  const stored = getAccountCredential(provider, accountId);
  if (!stored) throw new Error("account credential missing");
  if (stored.expires > Date.now() + ACCOUNT_TOKEN_SKEW_MS) return stored.access;
  const activeId = getAccountSet(provider)?.activeAccountId;
  if (activeId !== accountId && stored.source === "local-cli") {
    throw new Error("background local-cli token expired; skip CLI-adopting refresh for quota probe");
  }
  return getValidAccessTokenForAccount(provider, accountId);
}

async function fetchAccountQuota(
  provider: string,
  accountId: string,
  forceRefresh: boolean,
): Promise<AccountQuotaCacheEntry> {
  const key = accountCacheKey(provider, accountId);
  const cached = accountQuotaCache.get(key);
  if (!forceRefresh && cached && Date.now() - cached.ts < ACCOUNT_QUOTA_TTL_MS) return cached;
  const joinable = accountQuotaInflight.get(key);
  if (joinable) return joinable;

  const probe = (async (): Promise<AccountQuotaCacheEntry> => {
    try {
      const token = await getTokenForAccountQuotaProbe(provider, accountId);
      const quota = await fetchAnthropicUsageQuota(token);
      if (!quota) {
        // Preserve last-good bars and mark unavailable; advance TTL so failures
        // negative-cache instead of re-probing on every GUI poll.
        const entry: AccountQuotaCacheEntry = {
          ts: Date.now(),
          quota: cached?.quota ?? null,
          unavailable: true,
        };
        accountQuotaCache.set(key, entry);
        return entry;
      }
      const entry: AccountQuotaCacheEntry = { ts: Date.now(), quota };
      accountQuotaCache.set(key, entry);
      return entry;
    } catch {
      const entry: AccountQuotaCacheEntry = {
        ts: Date.now(),
        quota: cached?.quota ?? null,
        unavailable: true,
      };
      accountQuotaCache.set(key, entry);
      return entry;
    }
  })().finally(() => {
    if (accountQuotaInflight.get(key) === probe) accountQuotaInflight.delete(key);
  });
  accountQuotaInflight.set(key, probe);
  return probe;
}

/**
 * Per-account quota rows for a provider's logged-in accounts. Probes run in parallel; a
 * single failing account never blocks the others.
 */
export async function fetchProviderAccountQuotas(
  provider: string,
  forceRefresh = false,
): Promise<ProviderAccountQuota[]> {
  if (!supportsPerAccountQuota(provider)) return [];
  const set = getAccountSet(provider);
  if (!set) return [];
  return await Promise.all(set.accounts.map(async account => {
    const entry = await fetchAccountQuota(provider, account.id, forceRefresh);
    return {
      accountId: account.id,
      quota: entry.quota,
      ...(entry.unavailable ? { unavailable: true as const } : {}),
    };
  }));
}

function normalizedBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.search || url.hash) return null;
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function quotaResetAt(row: Record<string, unknown>): number | undefined {
  return normalizeResetAt(row.resetTime ?? row.resetAt ?? row.reset_time ?? row.reset_at);
}

function isCanonicalKimiCodeBaseUrl(baseUrl: string): boolean {
  return normalizedBaseUrl(baseUrl) === KIMI_CODE_BASE_URL;
}

/** Prefer the nested `data` shell when the outer object is only an envelope. */
function unwrapKimiQuotaPayload(value: unknown): Record<string, unknown> | null {
  const body = asRecord(value);
  if (!body) return null;
  const nested = asRecord(body.data);
  if (!nested) return body;
  // A null/non-usable outer field is a placeholder, not data — an envelope like
  // { usage: null, data: { usage: {...} } } must still unwrap to the nested payload.
  const usable = (field: unknown): boolean => field !== undefined && field !== null;
  const outerHasUsage = usable(body.usage) || usable(body.limits) || usable(body.totalQuota);
  const nestedHasUsage = usable(nested.usage) || usable(nested.limits) || usable(nested.totalQuota);
  return !outerHasUsage && nestedHasUsage ? nested : body;
}

function kimiLimitLabel(item: Record<string, unknown>, detail: Record<string, unknown>): string {
  return [item.name, item.title, item.scope, detail.name, detail.title]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function parseKimiQuotaRow(value: unknown, resetFallback?: Record<string, unknown>): { percent: number; resetAt?: number } | null {
  const row = asRecord(value);
  if (!row) return null;
  const resetAt = quotaResetAt(row) ?? (resetFallback ? quotaResetAt(resetFallback) : undefined);
  const limit = toFiniteNumber(row.limit);
  if (limit !== undefined && limit > 0) {
    let used = toFiniteNumber(row.used);
    if (used === undefined) {
      const remaining = toFiniteNumber(row.remaining);
      if (remaining !== undefined) used = limit - remaining;
    }
    if (used !== undefined) {
      const percent = normalizePercent((used / limit) * 100);
      if (percent !== undefined) return { percent, ...(resetAt !== undefined ? { resetAt } : {}) };
    }
  }
  // Some payloads expose utilisation directly when limit/used arithmetic is absent.
  const direct = normalizePercent(row.utilization ?? row.percent ?? row.usedPercent ?? row.used_percent);
  return direct === undefined ? null : { percent: direct, ...(resetAt !== undefined ? { resetAt } : {}) };
}

function isKimiFiveHourLimit(item: Record<string, unknown>, detail: Record<string, unknown>, window: Record<string, unknown>): boolean {
  const duration = toFiniteNumber(window.duration ?? item.duration ?? detail.duration);
  const unit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "").toUpperCase();
  if ((unit.includes("MINUTE") && duration === 300) || (unit.includes("HOUR") && duration === 5)) return true;
  return /(^|\b)5\s*(?:h|hour)/.test(kimiLimitLabel(item, detail));
}

function isKimiWeeklyLimit(item: Record<string, unknown>, detail: Record<string, unknown>, window: Record<string, unknown>): boolean {
  const duration = toFiniteNumber(window.duration ?? item.duration ?? detail.duration);
  const unit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "").toUpperCase();
  if ((unit.includes("DAY") && duration === 7) || (unit.includes("HOUR") && duration === 168)) return true;
  return /weekly|7\s*(?:d|day)/.test(kimiLimitLabel(item, detail));
}

function parseKimiQuotaPayload(value: unknown): ProviderQuota | null {
  const body = unwrapKimiQuotaPayload(value);
  if (!body) return null;
  let weekly = parseKimiQuotaRow(body.usage);
  const total = parseKimiQuotaRow(body.totalQuota);
  let fiveHour: { percent: number; resetAt?: number } | null = null;
  if (Array.isArray(body.limits)) {
    for (const rawItem of body.limits) {
      const item = asRecord(rawItem);
      if (!item) continue;
      const detail = asRecord(item.detail) ?? item;
      const window = asRecord(item.window) ?? {};
      if (!fiveHour && isKimiFiveHourLimit(item, detail, window)) {
        fiveHour = parseKimiQuotaRow(detail, window);
      }
      if (!weekly && isKimiWeeklyLimit(item, detail, window)) {
        weekly = parseKimiQuotaRow(detail, window);
      }
      if (fiveHour && weekly) break;
    }
  }
  const quota: ProviderQuota = {
    ...(fiveHour ? {
      fiveHourPercent: fiveHour.percent,
      ...(fiveHour.resetAt !== undefined ? { fiveHourResetAt: fiveHour.resetAt } : {}),
    } : {}),
    ...(weekly ? {
      weeklyPercent: weekly.percent,
      ...(weekly.resetAt !== undefined ? { weeklyResetAt: weekly.resetAt } : {}),
    } : {}),
    ...(total ? { customWindows: [{ label: "Total subscription credits", percent: total.percent, ...(total.resetAt !== undefined ? { resetAt: total.resetAt } : {}) }] } : {}),
    updatedAt: Date.now(),
  };
  return hasQuotaRows(quota) ? quota : null;
}

async function resolveKimiQuotaBearer(config: OcxProviderConfig): Promise<string | null> {
  if (config.authMode === "oauth") {
    try {
      return await getValidAccessToken("kimi");
    } catch {
      return null;
    }
  }
  // ACTIVE key only: silently walking apiKeyPool when the primary env reference is
  // unresolved would render a quota bar for a DIFFERENT account than the one routing
  // requests — a wrong meter is worse than no meter.
  const primary = resolveEnvValue(config.apiKey)?.trim();
  return primary || null;
}

async function fetchKimiQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaReport | null> {
  // Never release credentials to a user-edited or lookalike provider host.
  if (!isCanonicalKimiCodeBaseUrl(config.baseUrl)) return null;
  const accessToken = await resolveKimiQuotaBearer(config);
  if (!accessToken) return null;
  const response = await fetch(KIMI_CODE_USAGE_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const quota = parseKimiQuotaPayload(await response.json().catch(() => null));
  return quota ? report(provider, "kimi:usages", quota) : null;
}

/** Cursor included usage via api2.cursor.sh (Bearer from OAuth) — unofficial, may change. */
async function fetchCursorQuota(provider: string): Promise<ProviderQuotaReport | null> {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken("cursor");
  } catch {
    return null;
  }

  const authHeaders = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "opencodex-quota",
  } as const;

  // Prefer dashboard period usage (Pro/Team/Ultra spend allowance in USD cents).
  // Field names follow Cursor's Connect RPC shape (limit/remaining/includedSpend), not usedCents.
  try {
    const periodRes = await fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (periodRes.ok) {
      const body = asRecord(await periodRes.json().catch(() => null));
      const planUsage = asRecord(body?.planUsage);
      if (planUsage) {
        const resetAt = normalizeResetAt(body?.billingCycleEnd ?? planUsage.billingCycleEnd ?? body?.periodEnd);

        // Primary meter: overall included allowance (Cursor Settings → Usage total %).
        // autoPercentUsed / apiPercentUsed are secondary pools and must not replace the total.
        const limit = toFiniteNumber(planUsage.limit ?? planUsage.limitCents ?? planUsage.totalLimitCents);
        const remaining = toFiniteNumber(planUsage.remaining ?? planUsage.remainingCents);
        const includedSpend = toFiniteNumber(planUsage.includedSpend ?? planUsage.usedCents ?? planUsage.used);
        const totalSpend = toFiniteNumber(planUsage.totalSpend);
        let used: number | undefined;
        if (includedSpend !== undefined) used = includedSpend;
        else if (limit !== undefined && remaining !== undefined) used = Math.max(0, limit - remaining);
        else if (totalSpend !== undefined) used = totalSpend;
        const totalPercent = normalizePercent(planUsage.totalPercentUsed ?? planUsage.percentUsed)
          ?? (limit !== undefined && limit > 0 && used !== undefined
            ? normalizePercent((used / limit) * 100)
            : undefined);

        const autoPercent = normalizePercent(planUsage.autoPercentUsed);
        const apiPercent = normalizePercent(planUsage.apiPercentUsed);
        const customWindows: ProviderQuotaWindow[] = [];
        if (autoPercent !== undefined) {
          customWindows.push({
            label: "First-party models",
            percent: autoPercent,
            ...(resetAt !== undefined ? { resetAt } : {}),
          });
        }
        if (apiPercent !== undefined) {
          customWindows.push({
            label: "API usage",
            percent: apiPercent,
            ...(resetAt !== undefined ? { resetAt } : {}),
          });
        }

        if (totalPercent !== undefined || customWindows.length > 0) {
          const built = report(provider, "cursor:period-usage", {
            ...(totalPercent !== undefined ? {
              monthlyPercent: totalPercent,
              ...(resetAt !== undefined ? { monthlyResetAt: resetAt } : {}),
            } : {}),
            ...(customWindows.length > 0 ? { customWindows } : {}),
            updatedAt: Date.now(),
          });
          if (built) return { ...built, reverseEngineered: true };
        }
      }
    }
  } catch {
    /* fall through */
  }

  // /api/usage/summary — same host, sometimes richer than /auth/usage for Team plans.
  try {
    const summaryRes = await fetch("https://api2.cursor.sh/api/usage/summary", {
      headers: authHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (summaryRes.ok) {
      const body = asRecord(await summaryRes.json().catch(() => null));
      const individual = asRecord(body?.individualUsage);
      const plan = asRecord(individual?.plan);
      if (plan) {
        const used = toFiniteNumber(plan.used);
        const limit = toFiniteNumber(plan.limit);
        const percent = normalizePercent(plan.totalPercentUsed)
          ?? (used !== undefined && limit !== undefined && limit > 0
            ? normalizePercent((used / limit) * 100)
            : undefined);
        if (percent !== undefined) {
          const built = report(provider, "cursor:usage-summary", {
            monthlyPercent: percent,
            monthlyResetAt: normalizeResetAt(body?.billingCycleEnd),
            updatedAt: Date.now(),
          });
          if (built) return { ...built, reverseEngineered: true };
        }
      }
    }
  } catch {
    /* fall through to /auth/usage */
  }

  const response = await fetch("https://api2.cursor.sh/auth/usage", {
    headers: authHeaders,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await response.json().catch(() => null));
  if (!body) return null;

  // Prefer the gpt-4 bucket (historical "fast requests"); else first model with used+limit.
  let used: number | undefined;
  let limit: number | undefined;
  const gpt4 = asRecord(body["gpt-4"]);
  if (gpt4) {
    used = toFiniteNumber(gpt4.numRequests ?? gpt4.used);
    limit = toFiniteNumber(gpt4.maxRequestUsage ?? gpt4.limit ?? gpt4.maxRequests);
  }
  if (used === undefined || limit === undefined || limit <= 0) {
    for (const [key, value] of Object.entries(body)) {
      if (key === "startOfMonth" || key === "billingCycleStart") continue;
      const bucket = asRecord(value);
      if (!bucket) continue;
      const bucketUsed = toFiniteNumber(bucket.numRequests ?? bucket.used);
      const bucketLimit = toFiniteNumber(bucket.maxRequestUsage ?? bucket.limit ?? bucket.maxRequests);
      if (bucketUsed !== undefined && bucketLimit !== undefined && bucketLimit > 0) {
        used = bucketUsed;
        limit = bucketLimit;
        break;
      }
    }
  }
  if (used === undefined || limit === undefined || limit <= 0) return null;
  const percent = normalizePercent((used / limit) * 100);
  if (percent === undefined) return null;
  const startOfMonth = normalizeResetAt(body.startOfMonth ?? body.billingCycleStart);
  // Next reset = same day next month, computed in UTC to avoid timezone-shifted rollover.
  const monthlyResetAt = startOfMonth !== undefined
    ? (() => {
        const start = new Date(startOfMonth);
        return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate());
      })()
    : undefined;
  const built = report(provider, "cursor:auth-usage", {
    monthlyPercent: percent,
    ...(monthlyResetAt !== undefined ? { monthlyResetAt } : {}),
    updatedAt: Date.now(),
  });
  return built ? { ...built, reverseEngineered: true } : null;
}

function quotaInfoEntries(modelInfo: Record<string, unknown>): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const add = (value: unknown, tier?: string) => {
    const rec = asRecord(value);
    if (!rec) return;
    entries.push(tier ? { ...rec, tier } : rec);
  };
  const addArray = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) add(entry);
  };

  if (Array.isArray(modelInfo.quotaInfo)) addArray(modelInfo.quotaInfo);
  else add(modelInfo.quotaInfo);
  addArray(modelInfo.quotaInfos);

  const byTier = asRecord(modelInfo.quotaInfoByTier);
  if (byTier) {
    for (const [tier, value] of Object.entries(byTier)) {
      if (Array.isArray(value)) {
        for (const entry of value) add(entry, tier);
      } else {
        add(value, tier);
      }
    }
  }
  return entries;
}

function classifyAntigravityFamily(modelId: string, modelInfo: Record<string, unknown>, quotaInfo: Record<string, unknown>): "Gem" | "Cla" | null {
  const displayName = typeof modelInfo.displayName === "string" ? modelInfo.displayName : "";
  const tier = typeof quotaInfo.tier === "string" ? quotaInfo.tier : "";
  const haystack = `${modelId} ${displayName} ${tier}`.toLowerCase();
  if (haystack.includes("gemini")) return "Gem";
  if (haystack.includes("claude") || haystack.includes("opus") || haystack.includes("sonnet") || haystack.includes("gpt-oss") || haystack.includes("gpt_oss")) return "Cla";
  return null;
}

function antigravityUsedPercent(quotaInfo: Record<string, unknown>): number | undefined {
  const remaining = normalizePercent(toFiniteNumber(quotaInfo.remainingFraction) !== undefined
    ? toFiniteNumber(quotaInfo.remainingFraction)! * 100
    : toFiniteNumber(quotaInfo.remainingPercentage) !== undefined
      ? toFiniteNumber(quotaInfo.remainingPercentage)! * 100
      : undefined);
  if (remaining === undefined) return undefined;
  return normalizePercent(100 - remaining);
}

async function fetchAntigravityQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaReport | null> {
  const credential = getCredential("google-antigravity");
  if (!credential?.projectId) return null;
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken("google-antigravity");
  } catch {
    return null;
  }
  const baseUrl = (config.baseUrl || "https://daily-cloudcode-pa.googleapis.com").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ project: credential.projectId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await response.json().catch(() => null));
  const models = asRecord(body?.models);
  if (!models) return null;

  const windows = new Map<string, ProviderQuotaWindow>();
  for (const [modelId, rawModelInfo] of Object.entries(models)) {
    const modelInfo = asRecord(rawModelInfo);
    if (!modelInfo) continue;
    for (const quotaInfo of quotaInfoEntries(modelInfo)) {
      const label = classifyAntigravityFamily(modelId, modelInfo, quotaInfo);
      if (!label || windows.has(label)) continue;
      const percent = antigravityUsedPercent(quotaInfo);
      if (percent === undefined) continue;
      windows.set(label, {
        label,
        percent,
        ...(normalizeResetAt(quotaInfo.resetTime) !== undefined ? { resetAt: normalizeResetAt(quotaInfo.resetTime) } : {}),
      });
    }
  }

  const customWindows = ["Gem", "Cla"].flatMap(label => {
    const window = windows.get(label);
    return window ? [window] : [];
  });
  if (customWindows.length === 0) return null;
  return report(provider, "google-antigravity:fetchAvailableModels", {
    customWindows,
    updatedAt: Date.now(),
  });
}

async function maybeFetchProviderQuota(
  name: string,
  provider: OcxProviderConfig,
  config: OcxConfig,
  forceRefresh: boolean,
): Promise<ProviderQuotaReport | null> {
  if (provider.disabled === true) return null;
  try {
    if (isBuiltInChatGptForwardProvider(name, provider)) return fetchChatGptForwardQuota(config, name, provider, forceRefresh);
    if (provider.authMode === "oauth" && name === "xai") return fetchXaiQuota(name);
    if (provider.authMode === "oauth" && name === "anthropic") return fetchAnthropicQuota(name);
    if (provider.authMode === "oauth" && name === "cursor") return fetchCursorQuota(name);
    if (provider.authMode === "oauth" && name === "google-antigravity") return fetchAntigravityQuota(name, provider);
    // Kimi Code `/usages` accepts OAuth or coding-plan API keys, but only on the canonical
    // host and only for real key auth — forward/local modes carry no credential of ours.
    if (provider.authMode === "oauth" && name === "kimi") return fetchKimiQuota(name, provider);
    if (provider.authMode === "key" && isCanonicalKimiCodeBaseUrl(provider.baseUrl)) {
      return fetchKimiQuota(name, provider);
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchProviderQuotaReports(config: OcxConfig, forceRefresh = false): Promise<ProviderQuotaResponse> {
  const key = cacheKey(config);
  const now = Date.now();
  // The cache fast path must not extend a preserved last-good row past its 30-minute bound:
  // a row preserved at age 29:59 plus a full 5-minute TTL would otherwise serve until ~35min.
  const cacheFresh = cache && cache.key === key && now - cache.ts < CACHE_TTL_MS
    && cache.response.reports.every(item => now - item.updatedAt < LAST_GOOD_MAX_AGE_MS);
  if (!forceRefresh && cacheFresh) return cache!.response;
  const joinable = inflight.get(key);
  if (!forceRefresh && joinable && joinable.epoch === invalidationEpoch) return joinable.promise;
  // A forced probe takes commit authority: older in-flight probes must not overwrite its result.
  if (forceRefresh) invalidationEpoch += 1;
  const epoch = invalidationEpoch;

  const promise = (async (): Promise<ProviderQuotaResponse> => {
    const previous = cache && cache.key === key ? cache.response.reports : [];
    const fresh = (await Promise.all(
      Object.entries(config.providers).map(([name, provider]) => maybeFetchProviderQuota(name, provider, config, forceRefresh)),
    )).filter((item): item is ProviderQuotaReport => item !== null);

    // Keep bounded last-good rows when a probe fails (e.g. transient upstream flake); never
    // re-stamp their timestamps, and drop rows older than LAST_GOOD_MAX_AGE_MS.
    // Note: the cache key encodes the provider set (name/adapter/authMode/disabled/baseUrl),
    // so previous rows always correspond to currently configured, enabled providers — a
    // disabled or removed provider changes the key and starts from an empty previous set.
    const cutoff = Date.now() - LAST_GOOD_MAX_AGE_MS;
    const byProvider = new Map<string, ProviderQuotaReport>();
    for (const item of previous) {
      if (item.updatedAt >= cutoff) byProvider.set(item.provider, item);
    }
    for (const item of fresh) byProvider.set(item.provider, item);

    const response = { generatedAt: Date.now(), reports: [...byProvider.values()] };
    // Commit only when this probe still holds authority (no clear/force superseded it).
    if (epoch === invalidationEpoch) cache = { key, ts: Date.now(), response };
    return response;
  })();

  const entry = { epoch, promise };
  inflight.set(key, entry);
  try {
    return await promise;
  } finally {
    if (inflight.get(key) === entry) inflight.delete(key);
  }
}
