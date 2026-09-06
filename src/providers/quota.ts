import { createHash } from "node:crypto";
import {
  effectiveCodexAuthAccountId,
  fetchMainAccountInfoSnapshot,
  listCodexAuthAccountsSnapshot,
  withSparkVisibility,
} from "../codex/auth-api";
import type { StoredAccountQuota } from "../codex/quota";
import { isMainAccountIdentityGenerationLive } from "../codex/main-account-cache";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/main-account";
import { codexPlanKey } from "../codex/plan";
import { resolveEnvValue } from "../config";
import { resolveProviderApiKey } from "./key-store";
import { getValidAccessToken, getValidAccessTokenForAccount } from "../oauth";
import { getAccountCredential, getAccountSet, getCredential } from "../oauth/store";
import { antigravityUserAgent } from "../adapters/client-fingerprint";
import { isCanonicalOllamaCloudUrl } from "../adapters/ollama-native-url";
import { providerOutboundPost, providerRedirectError, type ProviderOutboundDependencies } from "../lib/provider-outbound";
import { apiKeyPoolEntryId } from "./api-keys";
import { XAI_GROK_CLIENT_VERSION, XAI_GROK_COMPATIBILITY } from "./xai-transport";
import { getProviderRegistryEntry, providerCodexAccountMode, registryEntryForProviderDestination } from "./registry";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "./openai-tiers";
import {
  captureConfigGeneration,
  sweepExpiredOnWrite,
  type GenerationContext,
} from "../lib/state-store-sweeper";
import {
  ACCOUNT_QUOTA_TTL_MS,
  asRecord,
  CACHE_TTL_MS,
  normalizePercent,
  normalizeResetAt,
  QUOTA_JSON_READ_FAILURE,
  readQuotaJson,
  REQUEST_TIMEOUT_MS,
  toFiniteNumber,
} from "./quota-wire";
import {
  clearCachedProviderQuotas,
  replaceCachedProviderQuotas,
} from "./quota-routing-cache";
import {
  aggregateCodexPoolCapacity,
  CODEX_CAPACITY_MAX_QUOTA_AGE_MS,
  type CodexCapacityAggregation,
  type CodexCapacityQuota,
} from "./codex-capacity";
import type {
  AccountQuotaMode,
  ProviderQuota,
  ProviderQuotaCreditsUsd,
  ProviderQuotaWindow,
} from "./quota-types";
import {
  clearKiroAccountUsageState,
  commitKiroAccountUsageState,
  fetchKiroUsageSnapshot,
  type KiroUsageSnapshot,
  kiroUsageContextForAccount,
  reconcileKiroAccountUsageState,
} from "./kiro-usage";
import {
  cancelPendingAccountQuotaPersist,
  readPersistedAccountQuotas,
  schedulePersistAccountQuotas,
} from "./account-quota-disk";
import { clearProviderApiKeyQuotaCache, mapQuotaRoster, readProviderApiKeyQuotas, type ProviderApiKeyQuota } from "./quota-key-accounts";

export type { ProviderQuota, ProviderQuotaCreditsUsd, ProviderQuotaWindow } from "./quota-types";

/** Match oauth/index REFRESH_SKEW_MS — use stored access without refresh when still fresh. */
const ACCOUNT_TOKEN_SKEW_MS = 60_000;
/** Successful provider quota payloads are small; reject oversized or stalled JSON before parsing. */
export { QUOTA_RESPONSE_MAX_BYTES } from "./quota-wire";
const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_CODE_USAGE_URL = `${KIMI_CODE_BASE_URL}/usages`;
const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai";
const COMMAND_CODE_WHOAMI_URL = `${COMMAND_CODE_BASE_URL}/alpha/whoami`;
const COMMAND_CODE_CREDITS_URL = `${COMMAND_CODE_BASE_URL}/alpha/billing/credits`;
const COMMAND_CODE_SUBSCRIPTIONS_URL = `${COMMAND_CODE_BASE_URL}/alpha/billing/subscriptions`;
const COMMAND_CODE_USAGE_URL = `${COMMAND_CODE_BASE_URL}/alpha/usage/summary`;
const A6API_BASE_URL = "https://api.a6api.com";
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_USAGE_URL = `${OPENCODE_GO_BASE_URL}/usage`;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const CLINE_BASE_URL = "https://api.cline.bot";
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com";
const OLLAMA_CLOUD_USAGE_URL = `${OLLAMA_CLOUD_BASE_URL}/api/usage`;
const ZAI_BASE_URL = "https://api.z.ai";
const ZAI_CN_BASE_URL = "https://open.bigmodel.cn";
const MINIMAX_REMAINS_URL = "https://www.minimax.io/v1/token_plan/remains";
const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
const SYNTHETIC_BASE_URL = "https://api.synthetic.new/v2";
const DEEPINFRA_BASE_URL = "https://api.deepinfra.com";
const NEURALWATT_BASE_URL = "https://api.neuralwatt.com/v1";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const XAI_CREDITS_URL = `${XAI_BILLING_URL}?format=credits`;
/** Keep a failed probe's previous row at most this long before dropping it. */
const LAST_GOOD_MAX_AGE_MS = CODEX_CAPACITY_MAX_QUOTA_AGE_MS;
const nativeMainReportGenerations = new WeakMap<ProviderQuotaReport, number>();
const accountReportCurrent = new WeakMap<ProviderQuotaReport, () => boolean>();
let providerQuotaBeforePublishForTests: (() => void | Promise<void>) | null = null;

/** Test-only seam for identity/config invalidation after probes but before publication. */
export function setProviderQuotaBeforePublishForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  providerQuotaBeforePublishForTests = hook;
}
const TERMINAL_QUOTA_FAILURE = Symbol("terminal-quota-failure");
/**
 * The probe succeeded and the upstream authoritatively reported NO model-quota windows.
 *
 * Distinct from `null`, which means "this probe told us nothing" and deliberately preserves
 * the last-good row for up to 30 minutes. Collapsing the two would let a stale report outlive
 * the authoritative answer that replaced it: a GLM plan whose payload carries only MCP
 * `TIME_LIMIT` rows has no model windows, and the dashboard and quota-aware routing must stop
 * showing the previous token windows rather than keep them for another half hour.
 *
 * Suppression is shared with `TERMINAL_QUOTA_FAILURE`; only the reason differs.
 */
const AUTHORITATIVE_EMPTY_QUOTA = Symbol("authoritative-empty-quota");
type ProviderQuotaProbeResult =
  | ProviderQuotaReport
  | null
  | typeof TERMINAL_QUOTA_FAILURE
  | typeof AUTHORITATIVE_EMPTY_QUOTA;

export interface ProviderQuotaReport {
  provider: string;
  label: string;
  source: string;
  quota: ProviderQuota;
  updatedAt: number;
  reverseEngineered?: boolean;
  /**
   * The row was OBSERVED in-band on a streaming turn rather than probed.
   *
   * Age means something different for these. A probed provider re-reads on its own TTL,
   * so a row older than the last-good bound means the probe is failing and showing it
   * would misrepresent a live number. A passive provider publishes no endpoint at all
   * (`hasPassiveAccountQuota`), so its last observation is not a stale reading of
   * something fresher — it is the only measurement that exists, and dropping it leaves
   * the operator with nothing. Consumers that enforce a freshness bound must exempt
   * these and state the observation age instead.
   */
  observed?: boolean;
  aggregation?: CodexCapacityAggregation;
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
  clearCachedProviderQuotas();
  clearProviderApiKeyQuotaCache();
  invalidationEpoch += 1;
}

function cacheKey(config: OcxConfig): string {
  const providers = Object.entries(config.providers)
    .map(([name, provider]) => {
      const resolvedKey = typeof provider.apiKey === "string"
        ? resolveProviderApiKey(provider.apiKey)?.trim()
        : undefined;
      const activeKeyId = resolvedKey ? apiKeyPoolEntryId(resolvedKey) : "none";
      return `${name}:${provider.adapter}:${provider.authMode ?? "key"}:${providerCodexAccountMode(name, provider) ?? "none"}:${provider.disabled === true ? "off" : "on"}:${provider.baseUrl}:${activeKeyId}`;
    })
    .sort()
    .join("|");
  return `${config.defaultProvider}|${providers}`;
}

type CodexAuthAccountsSnapshotPromise = ReturnType<typeof listCodexAuthAccountsSnapshot>;

function hasCodexPoolProvider(config: OcxConfig): boolean {
  return Object.entries(config.providers).some(([name, provider]) => (
    provider.disabled !== true
    && isBuiltInChatGptForwardProvider(name, provider)
    && providerCodexAccountMode(name, provider) !== "direct"
  ));
}

function quotaSignatureValue(quota: CodexCapacityQuota | null): unknown {
  if (!quota) return null;
  return {
    fiveHourPercent: quota.fiveHourPercent,
    fiveHourResetAt: quota.fiveHourResetAt,
    weeklyPercent: quota.weeklyPercent,
    weeklyResetAt: quota.weeklyResetAt,
    monthlyPercent: quota.monthlyPercent,
    monthlyResetAt: quota.monthlyResetAt,
    updatedAt: quota.updatedAt,
    customWindows: [...(quota.customWindows ?? [])]
      .map(window => ({ label: window.label, percent: window.percent, resetAt: window.resetAt }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function providerQuotaFromCodexQuota(
  quota: StoredAccountQuota | Omit<StoredAccountQuota, "updatedAt"> | null | undefined,
): CodexCapacityQuota | null {
  if (!quota) return null;
  // Every Codex-sourced provider report funnels through here — the pooled path via
  // listCodexAuthAccountsSnapshot and the `direct` path via fetchMainAccountInfoSnapshot, which
  // never touches the Codex Auth DTO. Applying the Spark preference at this one point is what
  // stops the row surviving on /api/provider-quotas after the operator switched it off.
  quota = withSparkVisibility(quota ?? null) ?? quota;
  return {
    ...(quota.shortPercent !== undefined ? { fiveHourPercent: quota.shortPercent } : {}),
    ...(quota.shortResetAt !== undefined ? { fiveHourResetAt: quota.shortResetAt } : {}),
    ...(quota.weeklyPercent !== undefined ? { weeklyPercent: quota.weeklyPercent } : {}),
    ...(quota.weeklyResetAt !== undefined ? { weeklyResetAt: quota.weeklyResetAt } : {}),
    ...(quota.monthlyPercent !== undefined ? { monthlyPercent: quota.monthlyPercent } : {}),
    ...(quota.monthlyResetAt !== undefined ? { monthlyResetAt: quota.monthlyResetAt } : {}),
    ...(quota.customWindows !== undefined ? { customWindows: quota.customWindows } : {}),
    updatedAt: "updatedAt" in quota ? quota.updatedAt : Date.now(),
  };
}

/** Hash only presentation-relevant state; account ids and email addresses never enter the key. */
function cacheKeyWithAggregationState(
  config: OcxConfig,
  prefetchedSnapshot?: CodexAuthAccountsSnapshotPromise,
): string | Promise<string> {
  const base = cacheKey(config);
  if (!hasCodexPoolProvider(config)) return base;
  return (async () => {
    try {
      const activeId = effectiveCodexAuthAccountId(config);
      const snapshot = await (prefetchedSnapshot ?? listCodexAuthAccountsSnapshot(config, false));
      const rows = snapshot.accounts.map(account => ({
        isMain: account.isMain,
        active: account.id === activeId,
        plan: codexPlanKey(account.plan) ?? null,
        paused: account.paused,
        needsReauth: account.needsReauth === true,
        quota: quotaSignatureValue(providerQuotaFromCodexQuota(account.quota)),
      }));
      const canonicalRows = rows.map(row => JSON.stringify(row)).sort();
      const digest = createHash("sha256").update(JSON.stringify(canonicalRows)).digest("hex").slice(0, 24);
      return `${base}|codex-pool:${digest}`;
    } catch {
      return `${base}|codex-pool:unavailable`;
    }
  })();
}

function publicCapacityWindow(window: import("./codex-capacity").CodexCapacityWindowAggregation) {
  const { totalWeight: _totalWeight, consumedWeight: _consumedWeight, remainingWeight: _remainingWeight, ...safe } = window;
  return safe;
}

/** Management API metadata intentionally omits configured/weighted unit counts. */
function publicCapacityAggregation(
  aggregation: CodexCapacityAggregation,
  presentation: NonNullable<CodexCapacityAggregation["presentation"]>,
): CodexCapacityAggregation {
  const safeCurrentAccount = presentation === "coverage-only" && aggregation.currentAccount
    ? { ...aggregation.currentAccount, quota: null }
    : aggregation.currentAccount;
  return {
    ...aggregation,
    presentation,
    ...(safeCurrentAccount ? { currentAccount: safeCurrentAccount } : {}),
    ...(aggregation.fiveHour ? { fiveHour: publicCapacityWindow(aggregation.fiveHour) } : {}),
    ...(aggregation.weekly ? { weekly: publicCapacityWindow(aggregation.weekly) } : {}),
    ...(aggregation.monthly ? { monthly: publicCapacityWindow(aggregation.monthly) } : {}),
    ...(aggregation.customWindows ? {
      customWindows: aggregation.customWindows.map(window => ({
        label: window.label,
        ...publicCapacityWindow(window),
      })),
    } : {}),
  };
}

function hasQuotaRows(quota: ProviderQuota | null | undefined): quota is ProviderQuota {
  if (!quota) return false;
  return typeof quota.fiveHourPercent === "number"
    || typeof quota.weeklyPercent === "number"
    || typeof quota.monthlyPercent === "number"
    || quota.creditsUsd?.unlimited === true
    || typeof quota.creditsUsd?.percent === "number"
    || !!quota.customWindows?.some(window => typeof window.percent === "number");
}

function providerLabel(providerId: string): string {
  return getProviderRegistryEntry(providerId)?.label ?? providerId;
}

/** Test-only access to the quota reader's deadline and cancellation contract. */
export async function readProviderQuotaJsonForTests(response: Response, timeoutMs: number): Promise<unknown> {
  const result = await readQuotaJson(response, timeoutMs);
  return result === QUOTA_JSON_READ_FAILURE ? null : result;
}

function isBuiltInChatGptForwardProvider(name: string, provider: OcxProviderConfig): boolean {
  return name === OPENAI_CODEX_PROVIDER_ID && isCanonicalOpenAiForwardProvider(provider);
}

function isCanonicalA6apiBaseUrl(baseUrl: string): boolean {
  const normalized = normalizedBaseUrl(baseUrl);
  return normalized === A6API_BASE_URL || normalized === `${A6API_BASE_URL}/v1`;
}

function isCanonicalOpenCodeGoBaseUrl(baseUrl: string): boolean {
  return normalizedBaseUrl(baseUrl) === OPENCODE_GO_BASE_URL;
}

function isCanonicalOpenRouterBaseUrl(baseUrl: string): boolean {
  const normalized = normalizedBaseUrl(baseUrl);
  return normalized === OPENROUTER_BASE_URL;
}

function isCanonicalDeepSeekBaseUrl(baseUrl: string): boolean {
  const normalized = normalizedBaseUrl(baseUrl);
  return normalized === DEEPSEEK_BASE_URL || normalized === `${DEEPSEEK_BASE_URL}/v1`;
}

function isCanonicalClineBaseUrl(baseUrl: string): boolean {
  const normalized = normalizedBaseUrl(baseUrl);
  return normalized === CLINE_BASE_URL || normalized === `${CLINE_BASE_URL}/api/v1`;
}

function isCanonicalOllamaCloudBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    return isCanonicalOllamaCloudUrl(baseUrl);
  } catch {
    return false;
  }
}

function isCanonicalZaiBaseUrl(baseUrl: string): boolean {
  const normalized = normalizedBaseUrl(baseUrl);
  return normalized === ZAI_BASE_URL
    || normalized === `${ZAI_BASE_URL}/api/coding/paas/v4`
    || normalized === ZAI_CN_BASE_URL
    || normalized === `${ZAI_CN_BASE_URL}/api/coding/paas/v4`
    // BigModel serves the same GLM Coding Plan on the OpenAI Responses wire at /api/v1.
    || normalized === `${ZAI_CN_BASE_URL}/api/v1`;
}

function isCanonicalMinimaxBaseUrl(baseUrl: string): boolean {
  const normalized = normalizedBaseUrl(baseUrl);
  return normalized === "https://api.minimax.io/v1" || normalized === "https://api.minimaxi.com/v1";
}

function isCanonicalMoonshotBaseUrl(baseUrl: string): boolean {
  const normalized = normalizedBaseUrl(baseUrl);
  return normalized === MOONSHOT_BASE_URL || normalized === "https://api.moonshot.cn/v1";
}

function isCanonicalVeniceBaseUrl(baseUrl: string): boolean {
  return normalizedBaseUrl(baseUrl) === VENICE_BASE_URL;
}

function isCanonicalSyntheticBaseUrl(baseUrl: string): boolean {
  const normalized = normalizedBaseUrl(baseUrl);
  return normalized === SYNTHETIC_BASE_URL || normalized === "https://api.synthetic.new/openai/v1";
}

function isCanonicalDeepInfraBaseUrl(baseUrl: string): boolean {
  const normalized = normalizedBaseUrl(baseUrl);
  return normalized === DEEPINFRA_BASE_URL || normalized === `${DEEPINFRA_BASE_URL}/v1/openai`;
}

function isCanonicalNeuralwattBaseUrl(baseUrl: string): boolean {
  return normalizedBaseUrl(baseUrl) === NEURALWATT_BASE_URL;
}

function a6apiPayload(value: unknown): Record<string, unknown> | null {
  const body = asRecord(value);
  return asRecord(body?.data) ?? body;
}

function firstFinite(record: Record<string, unknown> | null, names: string[]): number | undefined {
  if (!record) return undefined;
  for (const name of names) {
    const value = toFiniteNumber(record[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

async function fetchA6apiQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  // Never send a configured API key to a lookalike host or through a redirect.
  if (!isCanonicalA6apiBaseUrl(config.baseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const headers = { Accept: "application/json", Authorization: `Bearer ${apiKey}` } as const;
  const [subscriptionResponse, tokenResponse] = await Promise.all([
    fetch(`${A6API_BASE_URL}/dashboard/billing/subscription`, {
      headers, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
    fetch(`${A6API_BASE_URL}/api/usage/token/`, {
      headers, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  ]);
  if (!subscriptionResponse.ok || !tokenResponse.ok) {
    const statuses = [subscriptionResponse.status, tokenResponse.status];
    // 408/429 are transient (timeout/throttle), not invalid-account signals: keep the
    // last-good row like 5xx/network failures. 401/403 (bad key) and 404 (contract change)
    // stay terminal.
    return statuses.some(status => status >= 400 && status < 500 && status !== 429 && status !== 408)
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const [subscriptionBody, tokenBody] = await Promise.all([
    readQuotaJson(subscriptionResponse),
    readQuotaJson(tokenResponse),
  ]);
  if (subscriptionBody === QUOTA_JSON_READ_FAILURE || tokenBody === QUOTA_JSON_READ_FAILURE) return null;
  const subscription = a6apiPayload(subscriptionBody);
  const token = a6apiPayload(tokenBody);
  const unlimited = token?.unlimited_quota === true
    || token?.unlimited_quota === 1
    || token?.unlimited_quota === "true";
  const normalizedExpiry = normalizeResetAt(token?.expires_at);
  const expiry = normalizedExpiry && normalizedExpiry > 0
    ? { expiresAt: normalizedExpiry }
    : {};
  if (unlimited) {
    return report(provider, "a6api:billing", {
      creditsUsd: {
        used: 0,
        limit: 0,
        remaining: 0,
        percent: 0,
        unlimited: true,
        ...expiry,
      },
      customWindows: [{ label: "Unlimited API credits", percent: 0 }],
      updatedAt: Date.now(),
    });
  }
  const limitUsd = firstFinite(subscription, ["hard_limit_usd"]);
  const grantedUnits = firstFinite(token, ["total_granted"]);
  const usedUnits = firstFinite(token, ["total_used"]);
  const availableUnits = firstFinite(token, ["total_available"]);
  const reconciledUnits = usedUnits !== undefined && availableUnits !== undefined
    ? usedUnits + availableUnits
    : undefined;
  const reconciliationTolerance = grantedUnits !== undefined
    ? Math.abs(grantedUnits) * 1e-9
    : 0;
  if (limitUsd === undefined || grantedUnits === undefined || usedUnits === undefined
    || availableUnits === undefined || limitUsd <= 0 || grantedUnits <= 0
    || usedUnits < 0 || availableUnits < 0
    || reconciledUnits === undefined
    || Math.abs(reconciledUnits - grantedUnits) > reconciliationTolerance) return TERMINAL_QUOTA_FAILURE;
  const usdPerUnit = limitUsd / grantedUnits;
  const usedUsd = usedUnits * usdPerUnit;
  const remainingUsd = Math.max(0, availableUnits * usdPerUnit);
  const percent = normalizePercent((usedUsd / limitUsd) * 100);
  if (percent === undefined) return TERMINAL_QUOTA_FAILURE;
  const label = `API credits ($${remainingUsd.toFixed(2)} of $${limitUsd.toFixed(2)} remaining)`;
  return report(provider, "a6api:billing", {
    creditsUsd: {
      used: usedUsd,
      limit: limitUsd,
      remaining: remainingUsd,
      percent,
      ...expiry,
    },
    customWindows: [{ label, percent }],
    updatedAt: Date.now(),
  });
}

function parseOpenCodeGoUsageWindow(value: unknown): { percent: number; resetAt?: number } | null {
  const row = asRecord(value);
  if (!row) return null;
  const percent = normalizePercent(row.percent);
  if (percent === undefined) return null;
  const resetAt = normalizeResetAt(row.resetsAt);
  return { percent, ...(resetAt !== undefined ? { resetAt } : {}) };
}

async function fetchOpenCodeGoQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  // Never send a configured API key when the provider destination is not the built-in Go endpoint.
  if (!isCanonicalOpenCodeGoBaseUrl(config.baseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const response = await fetch(OPENCODE_GO_USAGE_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const body = asRecord(await readQuotaJson(response));
  const usage = asRecord(body?.usage);
  if (!usage) return null;
  const rolling = parseOpenCodeGoUsageWindow(usage.rolling);
  const weekly = parseOpenCodeGoUsageWindow(usage.weekly);
  const monthly = parseOpenCodeGoUsageWindow(usage.monthly);
  const quota: ProviderQuota = {
    ...(rolling ? {
      fiveHourPercent: rolling.percent,
      ...(rolling.resetAt !== undefined ? { fiveHourResetAt: rolling.resetAt } : {}),
    } : {}),
    ...(weekly ? {
      weeklyPercent: weekly.percent,
      ...(weekly.resetAt !== undefined ? { weeklyResetAt: weekly.resetAt } : {}),
    } : {}),
    ...(monthly ? {
      monthlyPercent: monthly.percent,
      ...(monthly.resetAt !== undefined ? { monthlyResetAt: monthly.resetAt } : {}),
    } : {}),
    updatedAt: Date.now(),
  };
  return report(provider, "opencode-go:usage", quota);
}

/**
 * OpenRouter `GET /api/v1/key` — the key's own credit balance and optional
 * per-key spending cap. `limit` is the configured cap (absent = uncapped);
 * `usage` is lifetime spend; `limit_remaining` is what is left of the cap.
 * When no cap is set there is no hard limit to meter against, so no bar is
 * produced — the provider falls back to its documented reference.
 */
async function fetchOpenRouterQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  // Never send a configured API key to a lookalike host or through a redirect.
  if (!isCanonicalOpenRouterBaseUrl(config.baseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const response = await fetch(`${OPENROUTER_BASE_URL}/key`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const body = asRecord(await readQuotaJson(response));
  const data = asRecord(body?.data) ?? body;
  if (!data) return null;
  const limit = toFiniteNumber(data.limit);
  const limitRemaining = toFiniteNumber(data.limit_remaining);
  const usage = toFiniteNumber(data.usage);
  // A successful no-cap response is a DELIBERATE change, not a transient
  // failure: the old capped row must be dropped, not preserved as last-good.
  if (limit === undefined || limit <= 0) return TERMINAL_QUOTA_FAILURE;
  // Prefer the authoritative remaining-cap value when present: `usage` is
  // lifetime accumulated spend and overstates a reset or re-capped key.
  const used = limitRemaining !== undefined
    ? Math.max(0, limit - limitRemaining)
    : usage !== undefined && usage >= 0 ? usage : undefined;
  if (used === undefined) return null;
  const percent = normalizePercent((used / limit) * 100);
  if (percent === undefined) return null;
  const remaining = Math.max(0, limit - used);
  const label = `API credits ($${remaining.toFixed(2)} of $${limit.toFixed(2)} remaining)`;
  return report(provider, "openrouter:key-info", {
    customWindows: [{ label, percent }],
    updatedAt: Date.now(),
  });
}

/**
 * DeepSeek `GET /user/balance` — the account's granted + topped-up credit
 * balance. The payload places `total_balance` / `granted_balance` inside
 * entries of `balance_infos` (one row per currency); the row for the account's
 * currency is selected by preference. `granted_balance` is a CURRENT balance
 * component, not the original grant ceiling, so no consumed percentage is
 * fabricated — the balance is reported as a balance-only window.
 */
async function fetchDeepSeekQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  if (!isCanonicalDeepSeekBaseUrl(config.baseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const response = await fetch(`${DEEPSEEK_BASE_URL}/user/balance`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const body = asRecord(await readQuotaJson(response));
  // The payload nests balances under `balance_infos` rows keyed by currency;
  // prefer a USD row, then CNY, then the first row that parses.
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos as unknown[] : null;
  const rows = infos
    ? infos.map((raw): Record<string, unknown> | null => asRecord(raw)).filter((r): r is Record<string, unknown> => r !== null)
    : [];
  const pick = (currency: string): Record<string, unknown> | null =>
    rows.find(row => String(row.currency ?? "").toUpperCase() === currency) ?? null;
  const preferred = pick("USD") ?? pick("CNY") ?? rows[0] ?? null;
  if (!preferred) return null;
  const totalBalance = toFiniteNumber(preferred.total_balance);
  const grantedBalance = toFiniteNumber(preferred.granted_balance);
  const toppedUp = toFiniteNumber(preferred.topped_up_balance);
  const balance = totalBalance ?? grantedBalance ?? toppedUp;
  if (balance === undefined || balance < 0) return null;
  const label = grantedBalance !== undefined && grantedBalance > 0
    ? `API balance ($${balance.toFixed(2)} total, $${grantedBalance.toFixed(2)} granted)`
    : `API balance ($${balance.toFixed(2)})`;
  return report(provider, "deepseek:balance", {
    customWindows: [{ label, percent: 0 }],
    updatedAt: Date.now(),
  });
}

/**
 * ClinePass `GET /api/v1/users/me/plan/usage-limits` — the subscription's
 * rolling five-hour, weekly, and monthly utilization, matching the existing
 * ProviderQuota windows directly. The endpoint 404s (or returns a null plan)
 * for accounts without an active ClinePass, which is a no-report, not an error.
 */
async function fetchClineQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  if (!isCanonicalClineBaseUrl(config.baseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const response = await fetch(`${CLINE_BASE_URL}/api/v1/users/me/plan/usage-limits`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    // 404 = no active plan; a plain "no plan" is a no-report, everything else
    // 4xx (except 408/429) is a credential/contract problem.
    if (response.status === 404) return null;
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const body = asRecord(await readQuotaJson(response));
  const data = asRecord(body?.data) ?? body;
  const limits = Array.isArray(data?.limits) ? data.limits : null;
  if (!limits) return null;
  const quota: ProviderQuota = { updatedAt: Date.now() };
  let windows = 0;
  for (const raw of limits) {
    const row = asRecord(raw);
    if (!row) continue;
    const percent = normalizePercent(row.percentUsed);
    if (percent === undefined) continue;
    const resetAt = normalizeResetAt(row.resetsAt);
    if (row.type === "five_hour") {
      quota.fiveHourPercent = percent;
      if (resetAt !== undefined) quota.fiveHourResetAt = resetAt;
      windows += 1;
    } else if (row.type === "weekly") {
      quota.weeklyPercent = percent;
      if (resetAt !== undefined) quota.weeklyResetAt = resetAt;
      windows += 1;
    } else if (row.type === "monthly") {
      quota.monthlyPercent = percent;
      if (resetAt !== undefined) quota.monthlyResetAt = resetAt;
      windows += 1;
    }
  }
  return windows > 0 ? report(provider, "cline:plan-usage-limits", quota) : null;
}

/**
 * Ollama Cloud `GET https://ollama.com/api/usage` — returns account usage.
 * Legacy plans report rolling 5-hour `limits.session.usage` and 7-day
 * `limits.weekly.usage`. Migrated monthly-credit plans report
 * `limits.monthly.usage`. `usage` values are normalized fractions (0..1).
 */
function parseOllamaPercent(usageValue: unknown): number | undefined {
  const usage = toFiniteNumber(usageValue);
  if (usage === undefined || usage < 0) return undefined;
  const percent = Math.round(usage * 10000) / 100;
  return normalizePercent(percent);
}

export function parseOllamaCloudQuota(body: Record<string, unknown> | null): ProviderQuota | null {
  if (!body) return null;
  const limits = asRecord(body.limits);
  if (!limits) return null;

  const quota: ProviderQuota = { updatedAt: Date.now() };
  let windows = 0;

  const session = asRecord(limits.session);
  if (session) {
    const percent = parseOllamaPercent(session.usage);
    if (percent !== undefined) {
      quota.fiveHourPercent = percent;
      windows += 1;
    }
  }

  const weekly = asRecord(limits.weekly);
  if (weekly) {
    const percent = parseOllamaPercent(weekly.usage);
    if (percent !== undefined) {
      quota.weeklyPercent = percent;
      windows += 1;
    }
  }

  const monthly = asRecord(limits.monthly);
  if (monthly) {
    const percent = parseOllamaPercent(monthly.usage);
    if (percent !== undefined) {
      quota.monthlyPercent = percent;
      windows += 1;
    }
  }

  return windows > 0 ? quota : null;
}

async function fetchOllamaCloudQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  const effectiveBaseUrl = config.baseUrl ?? getProviderRegistryEntry(provider)?.baseUrl ?? "";
  if (!isCanonicalOllamaCloudBaseUrl(effectiveBaseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const response = await fetch(OLLAMA_CLOUD_USAGE_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    if (response.status === 404) return null;
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const body = asRecord(await readQuotaJson(response));
  const quota = parseOllamaCloudQuota(body);
  return quota ? report(provider, "ollama-cloud:usage", quota) : null;
}

/**
 * Z.AI GLM Coding Plan `GET /api/monitor/usage/quota/limit` — the coding-plan
 * limits arrive as a `limits` array of `TOKENS_LIMIT` (newer plans call the
 * same rows `CREDIT_LIMIT`) and `TIME_LIMIT` rows. `TOKENS_LIMIT`/`CREDIT_LIMIT`
 * rows carry the window length as `unit`/`number`: unit 3 is hours (number 5 →
 * the rolling five-hour window), unit 6 is weeks (number 1 → the weekly
 * window). Every row's `percentage` is the consumed share (falling
 * back to `currentValue`/`usage` when absent) and `nextResetTime` (unix ms)
 * the window reset.
 *
 * `TIME_LIMIT` rows are deliberately ignored (issue #1168). They are the shared
 * monthly MCP *call* allowance for Web Search / Web Reader / Zread — not a
 * model-token budget — and `ProviderQuota.monthlyPercent` is consumed as a
 * model-capacity signal: `headroomOf()` in `src/oauth/account-quota-rank.ts`
 * takes the MAX across every window, so a user who spent their MCP search
 * allowance would be ranked as having no model capacity left, and the dashboard
 * would draw a full monthly bar for a plan whose model tokens are untouched.
 * A payload carrying only `TIME_LIMIT` rows therefore reports no quota at all,
 * which is the honest answer rather than a fabricated one.
 */
export function parseZaiQuotaLimits(data: Record<string, unknown> | null): ProviderQuota | null {
  const limits = Array.isArray(data?.limits) ? data.limits as unknown[] : null;
  if (!limits) return null;
  const quota: ProviderQuota = { updatedAt: Date.now() };
  let windows = 0;
  for (const raw of limits) {
    const row = asRecord(raw);
    if (!row) continue;
    // Gate on row type before deriving a percentage: an MCP row must not even
    // contribute a parsed value to a model-quota report.
    if (row.type !== "TOKENS_LIMIT" && row.type !== "CREDIT_LIMIT") continue;
    const resetAt = normalizeResetAt(row.nextResetTime);
    let percent = normalizePercent(row.percentage);
    if (percent === undefined) {
      const used = toFiniteNumber(row.currentValue);
      const total = toFiniteNumber(row.usage);
      if (used !== undefined && total !== undefined && total > 0) {
        percent = normalizePercent((used / total) * 100);
      }
    }
    if (percent === undefined) continue;
    const unit = toFiniteNumber(row.unit);
    const number = toFiniteNumber(row.number);
    if (unit === 3 && number === 5) {
      quota.fiveHourPercent = percent;
      if (resetAt !== undefined) quota.fiveHourResetAt = resetAt;
      windows += 1;
    } else if (unit === 6 && number === 1) {
      quota.weeklyPercent = percent;
      if (resetAt !== undefined) quota.weeklyResetAt = resetAt;
      windows += 1;
    }
  }
  return windows > 0 ? quota : null;
}

/**
 * Legacy Z.AI payload shape: percent fields with window identifiers directly on
 * the data object (optionally nested under `quota`). Kept as a fallback so
 * older responses keep rendering when the `limits` array is absent.
 */
function parseZaiQuotaLegacyFields(data: Record<string, unknown> | null): ProviderQuota | null {
  if (!data) return null;
  const quota: ProviderQuota = { updatedAt: Date.now() };
  let windows = 0;
  const percentAt = (key: string): number | undefined => {
    const value = normalizePercent(data[key]);
    if (value !== undefined) return value;
    const nested = asRecord(data.quota);
    return nested ? normalizePercent(nested[key]) : undefined;
  };
  const fiveHour = percentAt("fiveHourPercent") ?? percentAt("fiveHourUsage") ?? percentAt("fiveHourUsed");
  const weekly = percentAt("weeklyPercent") ?? percentAt("weeklyUsage") ?? percentAt("weeklyUsed");
  const monthly = percentAt("monthlyPercent") ?? percentAt("mcpPercent") ?? percentAt("monthlyMCPUsage");
  if (fiveHour !== undefined) {
    quota.fiveHourPercent = fiveHour;
    windows += 1;
  }
  if (weekly !== undefined) {
    quota.weeklyPercent = weekly;
    windows += 1;
  }
  if (monthly !== undefined) {
    quota.monthlyPercent = monthly;
    windows += 1;
  }
  return windows > 0 ? quota : null;
}

/**
 * Fetches the Z.AI GLM Coding Plan quota — on whichever region the provider
 * points at (api.z.ai or open.bigmodel.cn). The `limits` array shape is
 * preferred; older field-name payloads fall back to the legacy parser.
 *
 * Authentication differs by host (issue #1168). `api.z.ai` takes the API key as
 * a Bearer token per Z.AI's API reference; `open.bigmodel.cn` expects the key
 * directly in `Authorization` with no scheme prefix and answers a Bearer header
 * with an auth error, which is why BigModel Coding Plan quota never rendered.
 * The host is already canonicalized by `isCanonicalZaiBaseUrl` above and
 * `redirect: "error"` stays set, so the bare key cannot travel to a lookalike
 * host or follow a redirect off-origin.
 */
async function fetchZaiQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  if (!isCanonicalZaiBaseUrl(config.baseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const normalized = normalizedBaseUrl(config.baseUrl);
  const monitorHost = normalized === ZAI_BASE_URL || normalized === `${ZAI_BASE_URL}/api/coding/paas/v4`
    ? ZAI_BASE_URL
    : ZAI_CN_BASE_URL;
  const authorization = monitorHost === ZAI_CN_BASE_URL ? apiKey : `Bearer ${apiKey}`;
  const response = await fetch(`${monitorHost}/api/monitor/usage/quota/limit`, {
    headers: { Accept: "application/json", Authorization: authorization },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const body = asRecord(await readQuotaJson(response));
  if (!body || body.success === false) return null;
  const data = asRecord(body.data) ?? body;
  if (Array.isArray(data?.limits)) {
    const quota = parseZaiQuotaLimits(data);
    // A well-formed `limits[]` we fully understood is authoritative even when it yields no
    // model window — for example a plan reporting only the monthly MCP `TIME_LIMIT` row.
    // Returning `null` here would preserve the previous token windows for up to 30 minutes
    // and keep quota-aware routing acting on a report the provider has already superseded.
    return quota ? report(provider, "zai:quota-limit", quota) : AUTHORITATIVE_EMPTY_QUOTA;
  }
  const legacy = parseZaiQuotaLegacyFields(data);
  return legacy ? report(provider, "zai:quota-limit", legacy) : null;
}

/**
 * MiniMax Token Plan `GET /v1/token_plan/remains` — the subscription's
 * remaining quota as a countdown-time value (ms). The endpoint does not expose
 * the plan's total duration, so no percentage is fabricated from a presumed
 * window: the remaining time is reported as a duration-only window. When the
 * API supplies a total (`total_time` / `plan_duration_ms`), a consumed share
 * is derived from it. Region selects the host: `minimax` → www.minimax.io,
 * `minimax-cn` → api.minimaxi.com.
 */
async function fetchMinimaxQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  if (!isCanonicalMinimaxBaseUrl(config.baseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const cnHost = normalizedBaseUrl(config.baseUrl)?.startsWith("https://api.minimaxi.com");
  const remainsUrl = cnHost ? "https://api.minimaxi.com/v1/token_plan/remains" : MINIMAX_REMAINS_URL;
  const response = await fetch(remainsUrl, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const body = asRecord(await readQuotaJson(response));
  if (!body || body.success === false) return null;
  const data = asRecord(body.data) ?? body;
  const remainsMs = toFiniteNumber(data.remains_time ?? data.remainsTime);
  if (remainsMs === undefined || remainsMs < 0) return null;
  const hours = Math.floor(remainsMs / 3_600_000);
  const label = `Token Plan remaining (${hours}h)`;
  // Only derive a consumed share when the API actually reports the plan total;
  // a presumed window (e.g. 30 days) would fabricate utilization. A valid
  // response that omits the total after a prior refresh had it is a DELIBERATE
  // contract change — the old row must be dropped (terminal), not preserved as
  // a transient last-good.
  const totalMs = toFiniteNumber(data.total_time ?? data.plan_duration_ms ?? data.total_duration_ms);
  if (totalMs === undefined || totalMs <= 0) return TERMINAL_QUOTA_FAILURE;
  const consumed = Math.max(0, totalMs - remainsMs);
  const percent = normalizePercent((consumed / totalMs) * 100);
  if (percent === undefined) return null;
  return report(provider, "minimax:token-plan-remains", {
    customWindows: [{ label, percent }],
    updatedAt: Date.now(),
  });
}

/**
 * Moonshot/Kimi `GET /v1/users/me/balance` — the account's available balance
 * (voucher + cash). Renders a single balance window against the sum of
 * voucher + cash when positive (there is no per-window rate limit to meter).
 */
async function fetchMoonshotQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  if (!isCanonicalMoonshotBaseUrl(config.baseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const host = normalizedBaseUrl(config.baseUrl)?.startsWith("https://api.moonshot.cn") ? "https://api.moonshot.cn/v1" : MOONSHOT_BASE_URL;
  const response = await fetch(`${host}/users/me/balance`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const body = asRecord(await readQuotaJson(response));
  const data = asRecord(body?.data) ?? body;
  if (!data) return null;
  const available = toFiniteNumber(data.available_balance);
  const voucher = toFiniteNumber(data.voucher_balance);
  const cash = toFiniteNumber(data.cash_balance);
  if (available === undefined || available < 0) return null;
  // Moonshot exposes no per-window quota ceiling, only a balance — report it
  // as a balance-only window (percent 0) rather than a fabricated utilization.
  // Currency is host-scoped: China platform (api.moonshot.cn) bills in CNY;
  // the international platform (api.moonshot.ai) bills in USD. Do not force
  // either side into the other unit — the number is correct, only the unit
  // must match the host.
  const isChinaHost = host.startsWith("https://api.moonshot.cn");
  const money = (n: number) => isChinaHost ? `¥${n.toFixed(2)}` : `$${n.toFixed(2)}`;
  const unit = isChinaHost ? "CNY" : "USD";
  const label = voucher !== undefined && cash !== undefined
    ? `Balance (${money(available)} ${unit} available, ${money(voucher)} voucher)`
    : `Balance (${money(available)} ${unit} available)`;
  return report(provider, "moonshot:balance", {
    customWindows: [{ label, percent: 0 }],
    updatedAt: Date.now(),
  });
}

/**
 * Venice `GET /api/v1/billing/balance` — DIEM (native credits) or USD balance.
 * Shows the remaining balance; epoch allocation progress when present.
 */
async function fetchVeniceQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  if (!isCanonicalVeniceBaseUrl(config.baseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const response = await fetch(`${VENICE_BASE_URL}/billing/balance`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const body = asRecord(await readQuotaJson(response));
  const data = asRecord(body?.data) ?? body;
  if (!data) return null;
  const diemBalance = toFiniteNumber(data.balance);
  const usdBalance = toFiniteNumber(data.balance_usd);
  const epochUsed = toFiniteNumber(data.diem_epoch_used);
  const epochAllocated = toFiniteNumber(data.diem_epoch_allocated);
  if (diemBalance === undefined && usdBalance === undefined) return null;
  const label = diemBalance !== undefined
    ? `DIEM balance (${Math.round(diemBalance)})`
    : `USD balance ($${usdBalance?.toFixed(2) ?? "?"})`;
  if (epochAllocated !== undefined && epochAllocated > 0 && epochUsed !== undefined) {
    const percent = normalizePercent((epochUsed / epochAllocated) * 100);
    if (percent === undefined) return null;
    return report(provider, "venice:billing-balance", {
      customWindows: [{ label, percent }],
      updatedAt: Date.now(),
    });
  }
  return report(provider, "venice:billing-balance", {
    customWindows: [{ label, percent: 0 }],
    updatedAt: Date.now(),
  });
}

/**
 * Synthetic `GET /v2/quotas` — the known quota lanes (rolling 5-hour,
 * weekly token, search-hourly) mapped onto the quota windows.
 */
async function fetchSyntheticQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  if (!isCanonicalSyntheticBaseUrl(config.baseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const response = await fetch(`${SYNTHETIC_BASE_URL}/quotas`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const body = asRecord(await readQuotaJson(response));
  const data = asRecord(body?.data) ?? body;
  const quota: ProviderQuota = { updatedAt: Date.now() };
  let windows = 0;
  const percentAt = (key: string): number | undefined => {
    const value = normalizePercent(data?.[key]);
    if (value !== undefined) return value;
    const nested = asRecord(data?.quota) ?? asRecord(data?.quotas);
    return nested ? normalizePercent(nested[key]) : undefined;
  };
  const fiveHour = percentAt("rollingFiveHourLimit");
  const weekly = percentAt("weeklyTokenLimit");
  if (fiveHour !== undefined) {
    quota.fiveHourPercent = fiveHour;
    windows += 1;
  }
  if (weekly !== undefined) {
    quota.weeklyPercent = weekly;
    windows += 1;
  }
  const search = asRecord(data?.search);
  const searchHourly = search ? normalizePercent(search.hourly) : undefined;
  if (searchHourly !== undefined) {
    quota.customWindows = [...(quota.customWindows ?? []), { label: "Search hourly", percent: searchHourly }];
    windows += 1;
  }
  return windows > 0 ? report(provider, "synthetic:quotas", quota) : null;
}

/**
 * DeepInfra `GET /payment/checklist?compute_owed=true` — prepaid balance,
 * recent spend, spending limit, and suspension state. Renders a balance
 * window (prepaid funds are a negative `stripe_balance` → positive available).
 */
async function fetchDeepInfraQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  if (!isCanonicalDeepInfraBaseUrl(config.baseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const response = await fetch(`${DEEPINFRA_BASE_URL}/payment/checklist?compute_owed=true`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const body = asRecord(await readQuotaJson(response));
  const data = asRecord(body?.data) ?? body;
  if (!data) return null;
  const stripeBalance = toFiniteNumber(data.stripe_balance);
  const spendLimit = toFiniteNumber(data.spending_limit);
  const total = toFiniteNumber(data.total_amount_due);
  if (stripeBalance === undefined) return null;
  // Prepaid funds are negative; a positive value is money owed.
  const available = stripeBalance < 0 ? -stripeBalance : 0;
  if (spendLimit !== undefined && spendLimit > 0) {
    const spent = total !== undefined && total > 0 ? total : Math.max(0, spendLimit - available);
    const percent = normalizePercent((spent / spendLimit) * 100);
    if (percent === undefined) return null;
    return report(provider, "deepinfra:billing-checklist", {
      customWindows: [{ label: `Billing cycle spend ($${spent.toFixed(2)} of $${spendLimit.toFixed(2)})`, percent }],
      updatedAt: Date.now(),
    });
  }
  return report(provider, "deepinfra:billing-checklist", {
    customWindows: [{ label: `Prepaid balance ($${available.toFixed(2)})`, percent: 0 }],
    updatedAt: Date.now(),
  });
}

/**
 * Neuralwatt `GET /v1/quota` — subscription kWh usage (primary window) and
 * prepaid USD credit balance (secondary).
 */
async function fetchNeuralwattQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  if (!isCanonicalNeuralwattBaseUrl(config.baseUrl)) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const response = await fetch(`${NEURALWATT_BASE_URL}/quota`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const body = asRecord(await readQuotaJson(response));
  const data = asRecord(body?.data) ?? body;
  const quota: ProviderQuota = { updatedAt: Date.now() };
  let windows = 0;
  const subscription = asRecord(data?.subscription);
  const kwhUsed = subscription ? toFiniteNumber(subscription.kwh_used) : undefined;
  const kwhIncluded = subscription ? toFiniteNumber(subscription.kwh_included) : undefined;
  if (kwhUsed !== undefined && kwhIncluded !== undefined && kwhIncluded > 0) {
    const percent = normalizePercent((kwhUsed / kwhIncluded) * 100);
    if (percent !== undefined) {
      quota.fiveHourPercent = percent;
      const periodEnd = subscription ? normalizeResetAt(subscription.current_period_end) : undefined;
      if (periodEnd !== undefined) quota.fiveHourResetAt = periodEnd;
      windows += 1;
    }
  }
  const balance = asRecord(data?.balance);
  const totalCredits = balance ? toFiniteNumber(balance.total_credits_usd) : undefined;
  const remainingCredits = balance ? toFiniteNumber(balance.credits_remaining_usd) : undefined;
  if (totalCredits !== undefined && totalCredits > 0 && remainingCredits !== undefined) {
    // Utilization is CONSUMED credits, not the remaining share.
    const used = Math.max(0, totalCredits - remainingCredits);
    const percent = normalizePercent((used / totalCredits) * 100);
    if (percent !== undefined) {
      quota.customWindows = [...(quota.customWindows ?? []), { label: "Prepaid credits", percent }];
      windows += 1;
    }
  }
  return windows > 0 ? report(provider, "neuralwatt:quota", quota) : null;
}

function report(
  provider: string,
  source: string,
  quota: ProviderQuota,
  aggregation?: CodexCapacityAggregation,
): ProviderQuotaReport | null {
  if (!hasQuotaRows(quota)) return null;
  return {
    provider,
    label: providerLabel(provider),
    source,
    quota,
    updatedAt: quota.updatedAt,
    ...(aggregation ? { aggregation } : {}),
  };
}

function tagNativeMainReport(
  value: ProviderQuotaReport | null,
  generation: number,
): ProviderQuotaReport | null {
  if (value) nativeMainReportGenerations.set(value, generation);
  return value;
}

function isProviderQuotaReportCurrent(value: ProviderQuotaReport): boolean {
  const generation = nativeMainReportGenerations.get(value);
  return (generation === undefined || isMainAccountIdentityGenerationLive(generation))
    && (accountReportCurrent.get(value)?.() ?? true);
}

async function fetchChatGptForwardQuota(
  config: OcxConfig,
  provider: string,
  providerConfig: OcxProviderConfig,
  forceRefresh: boolean,
  prefetchedSnapshot?: CodexAuthAccountsSnapshotPromise,
): Promise<ProviderQuotaReport | null> {
  if (providerCodexAccountMode(provider, providerConfig) === "direct") {
    const snapshot = await fetchMainAccountInfoSnapshot(forceRefresh);
    const quota = providerQuotaFromCodexQuota(snapshot.info.quota);
    if (quota) quota.updatedAt = Date.now();
    return quota
      ? tagNativeMainReport(report(provider, "chatgpt:wham", quota), snapshot.mainIdentityGeneration)
      : null;
  }
  const snapshot = await (prefetchedSnapshot ?? listCodexAuthAccountsSnapshot(config, forceRefresh));
  const accounts = snapshot.accounts;
  const activeId = effectiveCodexAuthAccountId(config);
  const capacityAccounts = accounts.map(account => ({
    ...account,
    active: account.id === activeId,
    quota: providerQuotaFromCodexQuota(account.quota),
  }));
  const active = capacityAccounts.find(account => account.active)
    ?? capacityAccounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)
    ?? capacityAccounts[0];
  const now = Date.now();
  const capacity = aggregateCodexPoolCapacity(capacityAccounts, now);
  if (capacity.aggregation && capacity.quota) {
    return tagNativeMainReport(
      report(
        provider,
        "chatgpt:wham",
        capacity.quota as ProviderQuota,
        publicCapacityAggregation(capacity.aggregation, "aggregate"),
      ),
      snapshot.mainIdentityGeneration,
    );
  }
  const activeUsable = !!active && !active.paused && active.needsReauth !== true;
  const quota = activeUsable && active?.quota
    ? { ...active.quota, updatedAt: active.quota.updatedAt ?? Date.now() } as CodexCapacityQuota
    : null;
  const quotaFresh = !!quota
    && Number.isFinite(quota.updatedAt)
    && now - quota.updatedAt < CODEX_CAPACITY_MAX_QUOTA_AGE_MS;
  if (quota && quotaFresh) {
    const fallback = report(
      provider,
      "chatgpt:wham",
      quota as ProviderQuota,
      capacity.aggregation
        ? publicCapacityAggregation(capacity.aggregation, "effective-account-fallback")
        : undefined,
    );
    return tagNativeMainReport(fallback, snapshot.mainIdentityGeneration);
  }
  if (capacity.aggregation) {
    const updatedAt = Date.now();
    return tagNativeMainReport(
      {
        provider,
        label: providerLabel(provider),
        source: "chatgpt:wham",
        quota: { updatedAt },
        updatedAt,
        aggregation: publicCapacityAggregation(capacity.aggregation, "coverage-only"),
      },
      snapshot.mainIdentityGeneration,
    );
  }
  return null;
}

function centsValue(value: unknown): number | undefined {
  const rec = asRecord(value);
  return rec ? toFiniteNumber(rec.val) : undefined;
}

/** Decode JWT payload `sub` for xAI weekly credits when the stored credential lacks accountId. */
function xaiUserIdFromAccessToken(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Grok Build weekly credits envelope:
 * `{ config: { creditUsagePercent?, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end } } }`.
 * Omitted percent is treated as 0 (proto3 default).
 */
export function parseXaiCreditsResponse(value: unknown): { percent: number; resetAt?: number } | null {
  const body = asRecord(value);
  const config = asRecord(body?.config);
  if (!config) return null;
  const period = asRecord(config.currentPeriod);
  if (!period || period.type !== "USAGE_PERIOD_TYPE_WEEKLY") return null;
  let percent = 0;
  if (config.creditUsagePercent !== undefined) {
    const normalized = normalizePercent(config.creditUsagePercent);
    if (normalized === undefined) return null;
    percent = normalized;
  }
  const resetAt = normalizeResetAt(period.end);
  return {
    percent,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

async function fetchXaiWeeklyCredits(accessToken: string, userId: string): Promise<ProviderQuota | null> {
  try {
    const response = await fetch(XAI_CREDITS_URL, {
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        [XAI_GROK_COMPATIBILITY.headers.tokenAuth]: "xai-grok-cli",
        [XAI_GROK_COMPATIBILITY.headers.authenticateResponse]: "authenticate-response",
        "x-userid": userId,
        [XAI_GROK_COMPATIBILITY.headers.clientVersion]: XAI_GROK_CLIENT_VERSION,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = parseXaiCreditsResponse(await readQuotaJson(response));
    if (!parsed) return null;
    return {
      weeklyPercent: parsed.percent,
      ...(parsed.resetAt !== undefined ? { weeklyResetAt: parsed.resetAt } : {}),
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

async function fetchXaiQuota(provider: string, context: { accessToken: string; upstreamAccountId?: string }): Promise<ProviderQuotaReport | null> {
  const { accessToken } = context;

  // Prefer the SuperGrok weekly credits window that actually gates prompting (#1283).
  const userId = context.upstreamAccountId?.trim() || xaiUserIdFromAccessToken(accessToken);
  if (userId) {
    const weekly = await fetchXaiWeeklyCredits(accessToken, userId);
    if (weekly) return report(provider, "xai:grok-billing-credits", weekly);
  }

  // Legacy monthly dollar pool — retained when weekly is unavailable.
  try {
    const response = await fetch(XAI_BILLING_URL, {
      redirect: "error",
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = asRecord(await readQuotaJson(response));
    const config = asRecord(body?.config);
    if (!config) return null;
    const limitCents = centsValue(config.monthlyLimit);
    const usedCents = centsValue(config.used);
    if (limitCents === undefined || usedCents === undefined || limitCents <= 0) return null;
    const percent = normalizePercent((usedCents / limitCents) * 100);
    if (percent === undefined) return null;
    return report(provider, "xai:grok-billing", {
      monthlyPercent: percent,
      monthlyResetAt: normalizeResetAt(config.billingPeriodEnd),
      updatedAt: Date.now(),
    });
  } catch {
    return null;
  }
}

function parseClaudeBucket(value: unknown): { percent?: number; resetAt?: number } | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const percent = normalizePercent(rec.utilization);
  const resetAt = normalizeResetAt(rec.resets_at);
  if (percent === undefined && resetAt === undefined) return null;
  return { percent, resetAt };
}

function parseClaudeLimit(value: unknown): { label: string; percent: number; resetAt?: number } | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const percent = normalizePercent(rec.percent);
  if (percent === undefined) return null;
  const scope = asRecord(rec.scope);
  const model = asRecord(scope?.model);
  const rawLabel = String(model?.display_name ?? "").trim();
  if (!rawLabel) return null;
  const lowerLabel = rawLabel.toLowerCase();
  const label = lowerLabel.includes("fable") ? "Fable"
    : lowerLabel.includes("opus") ? "Opus"
      : lowerLabel.includes("sonnet") ? "Sonnet"
        : rawLabel;
  const resetAt = normalizeResetAt(rec.resets_at);
  return { label, percent, ...(resetAt !== undefined ? { resetAt } : {}) };
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
    const body = asRecord(await readQuotaJson(response));
    if (!body) return null;
    const fiveHour = parseClaudeBucket(body.five_hour);
    const sevenDay = parseClaudeBucket(body.seven_day);
    const fable = parseClaudeBucket(body.seven_day_fable);
    const opus = parseClaudeBucket(body.seven_day_opus);
    const sonnet = parseClaudeBucket(body.seven_day_sonnet);
    const customWindows: ProviderQuotaWindow[] = [];
    if (fable?.percent !== undefined) customWindows.push({ label: "Fable", percent: fable.percent, ...(fable.resetAt !== undefined ? { resetAt: fable.resetAt } : {}) });
    if (opus?.percent !== undefined) customWindows.push({ label: "Opus", percent: opus.percent, ...(opus.resetAt !== undefined ? { resetAt: opus.resetAt } : {}) });
    if (sonnet?.percent !== undefined) customWindows.push({ label: "Sonnet", percent: sonnet.percent, ...(sonnet.resetAt !== undefined ? { resetAt: sonnet.resetAt } : {}) });
    const knownLabels = new Set(customWindows.map(window => window.label.toLowerCase()));
    const limits = Array.isArray(body.limits) ? body.limits : [];
    for (const rawLimit of limits) {
      const limitRecord = asRecord(rawLimit);
      // `session` and `weekly_all` mirror the canonical five-hour and weekly
      // buckets above; only model-scoped weekly limits add a third window.
      if (String(limitRecord?.kind ?? "").trim().toLowerCase() !== "weekly_scoped") continue;
      const limit = parseClaudeLimit(rawLimit);
      if (!limit || knownLabels.has(limit.label.toLowerCase())) continue;
      knownLabels.add(limit.label.toLowerCase());
      customWindows.push(limit);
    }
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
  const probedAccountKey = probedAccountId ? accountCacheKey("anthropic", probedAccountId) : null;
  const writerGeneration = captureConfigGeneration();
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
  if (probedAccountId && probedAccountKey) {
    const stillOwnsToken = getAccountCredential("anthropic", probedAccountId)?.access === accessToken;
    if (stillOwnsToken && mayCommitAccountQuotaKey(probedAccountKey, writerGeneration)) {
      accountQuotaCache.set(probedAccountKey, { ts: Date.now(), quota });
    }
  }
  return report(provider, "anthropic:oauth-usage", quota);
}

/**
 * Provider-level Kiro row: the active account's usage, shown on the Providers page.
 *
 * The per-account cache is seeded from the same probe so opening that page does not read
 * the active account twice, and the account id is captured before the await so a
 * concurrent account switch cannot file this answer under the wrong account.
 */
async function fetchKiroQuota(provider: string): Promise<ProviderQuotaReport | null> {
  const probedAccountId = getAccountSet("kiro")?.activeAccountId;
  if (!probedAccountId) return null;
  const probedAccountKey = accountCacheKey("kiro", probedAccountId);
  const writerGeneration = captureConfigGeneration();
  let snapshot: KiroUsageSnapshot | null;
  try {
    snapshot = await fetchKiroUsageSnapshot(await kiroUsageContextForAccount(probedAccountId));
  } catch {
    return null;
  }
  if (!snapshot) return null;
  if (mayCommitAccountQuotaKey(probedAccountKey, writerGeneration)) {
    accountQuotaCache.set(probedAccountKey, { ts: Date.now(), quota: snapshot.quota });
    commitKiroAccountUsageState(probedAccountKey, snapshot);
  }
  return report(provider, "kiro:usage-limits", snapshot.quota);
}

/**
 * Provider-level row for a passive provider: the ACTIVE account's last observed
 * subscription windows, the same shape `fetchAnthropicQuota` and `fetchKiroQuota`
 * return.
 *
 * Cache-only. A dashboard load or `ocx account refresh` must never spend an inference
 * turn, so `forceRefresh` does not exist on this path — there is nothing to refresh.
 * `report.updatedAt` is the observation time, which is what both GUI surfaces render
 * as the relative age of the row.
 */
async function fetchPassiveProviderQuota(provider: string): Promise<ProviderQuotaReport | null> {
  const activeId = getAccountSet(provider)?.activeAccountId;
  if (!activeId) return null;
  // Idempotent; without it a proxy restart shows nothing until the next streaming turn
  // even though the last observation is on disk.
  hydrateAccountQuotaCache();
  const entry = accountQuotaCache.get(accountCacheKey(provider, activeId));
  if (!entry?.quota) return null;
  const built = report(provider, `${provider}:subscription-observation`, entry.quota);
  // Tagged here rather than inside report(), which every probed path shares.
  return built ? { ...built, observed: true } : null;
}

// ---------------------------------------------------------------------------
// Per-account quota (multiauth)
// ---------------------------------------------------------------------------

/**
 * Anthropic and Kiro both report usage per CREDENTIAL, so every logged-in account can be
 * probed with its own bearer token — the active-account selection and the local usage log
 * are irrelevant here. Mirrors the Codex pool behaviour
 * (codex/auth-api.ts:fetchPoolAccountQuota), including a per-account TTL so N accounts cost
 * at most N upstream calls per window. `ACCOUNT_QUOTA_TTL_MS` lives in `quota-wire.ts`
 * because the Kiro exhaustion reader applies the same staleness bound.
 */
type AccountQuotaCacheEntry = {
  ts: number;
  quota: ProviderQuota | null;
  /** Last probe failed (429 / network / expired login); still may hold last-good quota. */
  unavailable?: true;
  /** Private new-reader identity; never persisted or serialized. */
  identity?: string;
  isCurrent?: () => boolean;
};
const accountQuotaCache = new Map<string, AccountQuotaCacheEntry>();
let explicitAccountEpoch = 0;

/**
 * Seed the cache from the last run, once.
 *
 * Without this a restart forgets every measurement, so the pool opens its next turn with
 * no idea which account has room — the exact blindness pre-dispatch selection exists to
 * remove. A hydrated row is still subject to the ordinary TTL, so it orders the first
 * request and is replaced by a live probe immediately after.
 */
let diskHydrated = false;
function hydrateAccountQuotaCache(): void {
  if (diskHydrated) return;
  diskHydrated = true;
  for (const [key, quota] of readPersistedAccountQuotas()) {
    if (!accountQuotaCache.has(key)) accountQuotaCache.set(key, { ts: quota.updatedAt, quota });
  }
}

function persistAccountQuotaCache(): void {
  schedulePersistAccountQuotas(function* () {
    for (const [key, entry] of accountQuotaCache) {
      if (entry.quota) yield [key, entry.quota] as [string, ProviderQuota];
    }
  });
}
const accountQuotaInflight = new Map<string, Promise<AccountQuotaCacheEntry>>();
let lastReconciledGeneration = 0;
let liveAccountQuotaKeys = new Set<string>();
let liveProviderQuotaKeys = new Set<string>();

function mayCommitAccountQuotaKey(key: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration || liveAccountQuotaKeys.has(key);
}

function mayCommitProviderQuotaKey(key: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration || liveProviderQuotaKeys.has(key);
}

export interface ProviderAccountQuota {
  accountId: string;
  quota: ProviderQuota | null;
  /** Set when the probe could not reach upstream (expired login, 429, network). */
  unavailable?: true;
  isCurrent?: () => boolean;
}

/** Providers whose per-account quota can be probed. Extend as other OAuth APIs are covered. */
export function supportsPerAccountQuota(provider: string): boolean {
  return provider === "anthropic" || provider === "kiro" || provider === "google-antigravity"
    || explicitAccountReader(provider);
}

function explicitAccountReader(provider: string): boolean {
  return provider === "xai" || provider === "cursor" || provider === "kimi" || provider === "command-code";
}

export function providerOAuthAccountQuotaMode(provider: string): AccountQuotaMode {
  return hasPassiveAccountQuota(provider) ? "passive" : supportsPerAccountQuota(provider) ? "probe" : "unsupported";
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
  if (entry?.isCurrent && !entry.isCurrent()) return null;
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

/**
 * Anthropic's unified rate-limit headers, present on EVERY `/v1/messages` response.
 *
 * The account's own five-hour and seven-day headroom rides along with the answer, so the
 * pool can be told what a turn cost without spending a probe on `/api/oauth/usage`. Two
 * wire details differ from every other reader here and are the reason this parser exists
 * rather than reusing one:
 *
 * - `utilization` is a FRACTION (`0.74`), while `ProviderQuota.*Percent` is 0..100 and
 *   `fetchAnthropicUsageQuota` already reads the probe's `74.0` as a percent. Passing the
 *   header value through `normalizePercent` unscaled would file a 74%-spent account as
 *   0.74% and make the emptiest account look like the freshest.
 * - `reset` is epoch SECONDS; `normalizeResetAt` promotes a sub-1e10 number to
 *   milliseconds, so it is fed the raw value on purpose.
 *
 * Returns null when neither window parses, so a header set that Anthropic renames or drops
 * degrades to "no measurement" — the same state as before the observation existed.
 */
export function parseAnthropicRateLimitHeaders(headers: Headers): ProviderQuota | null {
  const fiveHourPercent = normalizeUtilizationFraction(headers.get("anthropic-ratelimit-unified-5h-utilization"));
  const weeklyPercent = normalizeUtilizationFraction(headers.get("anthropic-ratelimit-unified-7d-utilization"));
  if (fiveHourPercent === undefined && weeklyPercent === undefined) return null;
  const fiveHourResetAt = normalizeResetAt(headers.get("anthropic-ratelimit-unified-5h-reset"));
  const weeklyResetAt = normalizeResetAt(headers.get("anthropic-ratelimit-unified-7d-reset"));
  return {
    ...(fiveHourPercent !== undefined ? { fiveHourPercent } : {}),
    ...(fiveHourResetAt !== undefined ? { fiveHourResetAt } : {}),
    ...(weeklyPercent !== undefined ? { weeklyPercent } : {}),
    ...(weeklyResetAt !== undefined ? { weeklyResetAt } : {}),
    updatedAt: Date.now(),
  };
}

/**
 * A 0..1 utilization fraction as a 0..100 percent.
 *
 * Anthropic sends `1.0` for a fully drained window, so the guard is `> 1` rather than
 * `>= 1`: a value above one is a wire change (or a percent that leaked into a fraction
 * field), and inventing `100` from it would cool an account on a misread. Reject instead --
 * an unmeasured account already has a defined meaning here.
 *
 * Rounded to two decimals because `fraction * 100` is lossy in binary floating point: 0.29
 * yields 28.999999999999996, and the CLI renderers interpolate the percent raw
 * (`account.ts`, `account-extended.ts`) rather than rounding at the edge like the GUI does.
 * The value is also persisted, so an artifact would survive restarts.
 */
function normalizeUtilizationFraction(value: string | null): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || numeric > 1) return undefined;
  return Math.round(numeric * 10_000) / 100;
}

/**
 * File rate-limit headers observed on a live Anthropic turn against the account that served it.
 *
 * Modelled on Codex's `applyAccountQuotaFromUpstreamHeaders`: a pure side effect, fail-soft on
 * anything unparseable, and fenced by a `writerGeneration` the CALLER captured when it resolved
 * the serving credential — not here at write time, because a streaming turn is a long await and
 * a generation read at the end cannot see an account change from the start of the same turn.
 *
 * Unlike `recordPassiveAccountQuota` this is not gated on `hasPassiveAccountQuota`: Anthropic
 * does publish a usage endpoint and stays a probe provider. The headers are a free refresh
 * BETWEEN probes, never a replacement, and two rules keep it that way:
 *
 * - The write MERGES over the existing row. The headers report exactly two windows; the probe
 *   also returns `customWindows` with the model-scoped weekly limits (Opus, Sonnet, Fable),
 *   which nothing on the wire carries. A wholesale replace would delete those bars, and they
 *   are read for real: by the manual-preference exhaustion check in `anthropic-routing.ts` and
 *   by `headroomOf` in `account-quota-rank.ts`, not only by the dashboard.
 * - The entry's `ts` is NOT advanced. `fetchAccountQuota` gates re-probing on that timestamp
 *   (`Date.now() - cached.ts < ACCOUNT_QUOTA_TTL_MS`), so refreshing it on every turn would
 *   silence the probe entirely for any account used more than once per ten minutes: the
 *   observation would both narrow the row and disable the only thing that could widen it again.
 *   The quota's own `updatedAt` still moves, because the numbers it carries really are fresh.
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
    // A row that held only a failed probe (`quota: null`, `unavailable`) is now measured, so
    // that failure flag must not survive the observation which replaced it.
    unavailable: undefined,
    ts: previous?.ts ?? Date.now(),
    quota: { ...(previous?.quota ?? {}), ...observed },
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
    if (entry.ts + ACCOUNT_QUOTA_TTL_MS > now) continue;
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
  if (cache) {
    const reports = cache.response.reports.filter(report => context.providerNames.has(report.provider));
    removed += cache.response.reports.length - reports.length;
    cache = { ...cache, response: { ...cache.response, reports } };
    replaceCachedProviderQuotas(reports);
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

function explicitQuotaConfig(provider: string, configured?: OcxProviderConfig): OcxProviderConfig | undefined {
  if (configured) return configured;
  const entry = getProviderRegistryEntry(provider);
  return entry ? { adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: "oauth" } : undefined;
}

function explicitQuotaIdentity(provider: string, accountId: string, configured?: OcxProviderConfig): string | undefined {
  const credential = getAccountCredential(provider, accountId);
  const target = explicitQuotaConfig(provider, configured);
  if (!credential || !target) return undefined;
  return createHash("sha256").update(JSON.stringify([
    provider, accountId, credential.access, credential.refresh, credential.expires,
    credential.accountId, credential.projectId, credential.source,
    target.adapter, target.baseUrl, target.authMode, target.disabled === true,
  ])).digest("hex");
}

function explicitQuotaDestination(provider: string, config: OcxProviderConfig): boolean {
  if (config.disabled === true || config.authMode !== "oauth") return false;
  if (provider === "kimi") return isCanonicalKimiCodeBaseUrl(config.baseUrl);
  if (provider === "command-code") return isCanonicalCommandCodeBaseUrl(config.baseUrl);
  // These readers use fixed canonical billing origins, never config.baseUrl.
  return provider === "xai" || provider === "cursor";
}

async function readExplicitAccountQuota(provider: string, accountId: string, configured?: OcxProviderConfig): Promise<{
  result: ProviderQuotaProbeResult;
  identity: string | undefined;
  isCurrent: () => boolean;
} | null> {
  const target = explicitQuotaConfig(provider, configured);
  if (!target || !explicitQuotaDestination(provider, target)) return null;
  const config = { ...target };
  const epoch = explicitAccountEpoch;
  const accessToken = await getTokenForAccountQuotaProbe(provider, accountId);
  const credential = getAccountCredential(provider, accountId);
  if (!credential || credential.access !== accessToken) return null;
  // Pair the post-renewal credential with the destination captured before renewal.
  const identity = explicitQuotaIdentity(provider, accountId, config);
  const isCurrent = () => epoch === explicitAccountEpoch
    && identity === explicitQuotaIdentity(provider, accountId, configured);
  if (!isCurrent()) return null;
  let result: ProviderQuotaProbeResult;
  switch (provider) {
    case "xai": result = await fetchXaiQuota(provider, { accessToken, upstreamAccountId: credential.accountId }); break;
    case "cursor": result = await fetchCursorQuota(provider, accessToken); break;
    case "kimi": result = await fetchKimiQuota(provider, config, accessToken); break;
    case "command-code": result = await fetchCommandCodeQuota(provider, config, accessToken); break;
    default: return null;
  }
  return { result, identity, isCurrent };
}

async function fetchExplicitAccountQuota(provider: string, accountId: string, force: boolean, configured?: OcxProviderConfig): Promise<AccountQuotaCacheEntry> {
  const key = accountCacheKey(provider, accountId);
  const identity = explicitQuotaIdentity(provider, accountId, configured);
  const previous = accountQuotaCache.get(key);
  const cached = identity && previous?.identity === identity && previous.isCurrent?.() ? previous : undefined;
  if (!force && cached && Date.now() - cached.ts < ACCOUNT_QUOTA_TTL_MS
    && (!cached.quota || Date.now() - cached.quota.updatedAt < LAST_GOOD_MAX_AGE_MS)) return cached;
  const flightKey = `${key}\u0000${identity ?? "missing"}`;
  const running = accountQuotaInflight.get(flightKey);
  if (running) return running;
  const epoch = explicitAccountEpoch;
  const lastGood = cached?.quota && Date.now() - cached.quota.updatedAt < LAST_GOOD_MAX_AGE_MS ? cached.quota : null;
  const flight = (async (): Promise<AccountQuotaCacheEntry> => {
    let read: Awaited<ReturnType<typeof readExplicitAccountQuota>> = null;
    try { read = await readExplicitAccountQuota(provider, accountId, configured); } catch { /* unavailable */ }
    const isCurrent = read?.isCurrent ?? (() => epoch === explicitAccountEpoch && !!identity
      && identity === explicitQuotaIdentity(provider, accountId, configured));
    const result = read?.result;
    const current = epoch === explicitAccountEpoch && isCurrent();
    const quota = current && result && typeof result !== "symbol" ? result.quota : null;
    const empty = result === AUTHORITATIVE_EMPTY_QUOTA;
    const entry: AccountQuotaCacheEntry = {
      ts: Date.now(),
      quota: quota ?? (current && result !== TERMINAL_QUOTA_FAILURE && !empty
        && lastGood && Date.now() - lastGood.updatedAt < LAST_GOOD_MAX_AGE_MS ? lastGood : null),
      ...(!current || (!quota && !empty) ? { unavailable: true as const } : {}),
      identity: read?.identity ?? identity,
      isCurrent: () => epoch === explicitAccountEpoch && isCurrent(),
    };
    if (entry.isCurrent?.()) accountQuotaCache.set(key, entry);
    return entry;
  })().finally(() => { if (accountQuotaInflight.get(flightKey) === flight) accountQuotaInflight.delete(flightKey); });
  accountQuotaInflight.set(flightKey, flight);
  return flight;
}

async function fetchExplicitCurrentQuota(provider: string, config: OcxProviderConfig, liveConfig: OcxConfig): Promise<ProviderQuotaProbeResult> {
  const id = getAccountSet(provider)?.activeAccountId;
  if (!id) return null;
  const read = await readExplicitAccountQuota(provider, id, config);
  if (!read) return null;
  const isCurrent = () => liveConfig.providers[provider] === config
    && read.isCurrent() && getAccountSet(provider)?.activeAccountId === id;
  if (!isCurrent()) return TERMINAL_QUOTA_FAILURE;
  if (read.result && typeof read.result !== "symbol") accountReportCurrent.set(read.result, isCurrent);
  return read.result;
}

async function fetchAccountQuota(
  provider: string,
  accountId: string,
  forceRefresh: boolean,
  providerConfig?: OcxProviderConfig,
): Promise<AccountQuotaCacheEntry> {
  if (!supportsPerAccountQuota(provider)) return { ts: Date.now(), quota: null, unavailable: true };
  if (explicitAccountReader(provider)) return fetchExplicitAccountQuota(provider, accountId, forceRefresh, providerConfig);
  const key = accountCacheKey(provider, accountId);
  const writerGeneration = captureConfigGeneration();
  const cached = accountQuotaCache.get(key);
  if (!forceRefresh && cached && Date.now() - cached.ts < ACCOUNT_QUOTA_TTL_MS) return cached;
  const joinable = accountQuotaInflight.get(key);
  if (joinable) return joinable;

  const probe = (async (): Promise<AccountQuotaCacheEntry> => {
    try {
      let quota: ProviderQuota | null;
      let kiroSnapshot: KiroUsageSnapshot | null = null;
      if (provider === "kiro") {
        // Kiro resolves the bearer and its routing metadata from ONE account-scoped
        // snapshot. It deliberately does not use getTokenForAccountQuotaProbe: that
        // helper refuses to refresh a background `local-cli` slot because Anthropic's
        // lock can adopt a mismatched Claude CLI identity, but Kiro marks every
        // CLI-imported credential `local-cli`, so the same rule would blank the quota of
        // every inactive pool account the moment its token expired.
        kiroSnapshot = await fetchKiroUsageSnapshot(await kiroUsageContextForAccount(accountId));
        quota = kiroSnapshot?.quota ?? null;
      } else {
        const token = await getTokenForAccountQuotaProbe(provider, accountId);
        if (provider === "google-antigravity") {
          // Per-account Gem/Cla windows (#1082). The project id is part of the stored
          // credential; without it the probe cannot be made, and that is "unavailable",
          // never 0%.
          const projectId = getAccountCredential(provider, accountId)?.projectId;
          if (!projectId) throw new Error("antigravity account has no project id");
          quota = await fetchAntigravityUsageQuota(token, projectId);
        } else if (provider === "anthropic") {
          quota = await fetchAnthropicUsageQuota(token);
        } else {
          return { ts: Date.now(), quota: null, unavailable: true };
        }
      }
      if (!quota) {
        // Preserve last-good bars and mark unavailable; advance TTL so failures
        // negative-cache instead of re-probing on every GUI poll.
        const entry: AccountQuotaCacheEntry = {
          ts: Date.now(),
          quota: cached?.quota ?? null,
          unavailable: true,
        };
        if (mayCommitAccountQuotaKey(key, writerGeneration)) {
          accountQuotaCache.set(key, entry);
          if (provider === "kiro") commitKiroAccountUsageState(key, null);
          sweepExpiredOnWrite(entry.ts);
        }
        return entry;
      }
      const entry: AccountQuotaCacheEntry = { ts: Date.now(), quota };
      if (mayCommitAccountQuotaKey(key, writerGeneration)) {
        accountQuotaCache.set(key, entry);
        // Exhaustion state rides the SAME commit guard as the quota row: a probe from a
        // superseded config generation must not publish either half.
        if (provider === "kiro") commitKiroAccountUsageState(key, kiroSnapshot);
        sweepExpiredOnWrite(entry.ts);
      }
      return entry;
    } catch {
      const entry: AccountQuotaCacheEntry = {
        ts: Date.now(),
        quota: cached?.quota ?? null,
        unavailable: true,
      };
      if (mayCommitAccountQuotaKey(key, writerGeneration)) {
        accountQuotaCache.set(key, entry);
        sweepExpiredOnWrite(entry.ts);
      }
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
  providerConfig?: OcxProviderConfig,
): Promise<ProviderAccountQuota[]> {
  if (!supportsPerAccountQuota(provider)) return [];
  const set = getAccountSet(provider);
  if (!set) return [];
  return mapQuotaRoster(set.accounts, async account => {
    const entry = await fetchAccountQuota(provider, account.id, forceRefresh, providerConfig);
    const result: ProviderAccountQuota = {
      accountId: account.id,
      quota: entry.quota,
      ...(entry.unavailable ? { unavailable: true as const } : {}),
    };
    if (!explicitAccountReader(provider)) return result;
    const identity = entry.identity;
    Object.defineProperty(result, "isCurrent", { value: () => {
      if (entry.isCurrent) return entry.isCurrent();
      const credential = getAccountCredential(provider, account.id);
      return !!credential && (!identity || explicitQuotaIdentity(provider, account.id, providerConfig) === identity);
    } });
    return result;
  });
}

function normalizedBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
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

function isCanonicalCommandCodeBaseUrl(baseUrl: string): boolean {
  const normalized = normalizedBaseUrl(baseUrl);
  // OAuth preset points at the API root; the Provider-API preset at /provider/v1.
  return normalized === COMMAND_CODE_BASE_URL || normalized === `${COMMAND_CODE_BASE_URL}/provider/v1`;
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

async function resolveKimiQuotaBearer(config: OcxProviderConfig, accountId?: string): Promise<string | null> {
  if (config.authMode === "oauth") {
    try {
      return accountId ? await getTokenForAccountQuotaProbe("kimi", accountId) : null;
    } catch {
      return null;
    }
  }
  // ACTIVE key only: silently walking apiKeyPool when the primary env reference is
  // unresolved would render a quota bar for a DIFFERENT account than the one routing
  // requests — a wrong meter is worse than no meter.
  const primary = resolveProviderApiKey(config.apiKey)?.trim();
  return primary || null;
}

async function fetchKimiQuota(provider: string, config: OcxProviderConfig, accessToken: string): Promise<ProviderQuotaReport | null> {
  // Never release credentials to a user-edited or lookalike provider host.
  if (!isCanonicalKimiCodeBaseUrl(config.baseUrl)) return null;
  if (!accessToken) return null;
  const response = await fetch(KIMI_CODE_USAGE_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const quota = parseKimiQuotaPayload(await readQuotaJson(response));
  return quota ? report(provider, "kimi:usages", quota) : null;
}

/**
 * Command Code rolling window: `{ cap, used, resetAt }` off /alpha/billing/credits,
 * normalized to a percent with an optional reset timestamp.
 */
function parseCommandCodeWindow(value: unknown): { percent: number; resetAt?: number } | null {
  const row = asRecord(value);
  if (!row) return null;
  const cap = toFiniteNumber(row.cap);
  const used = toFiniteNumber(row.used);
  if (cap === undefined || used === undefined || cap <= 0 || used < 0) return null;
  const percent = normalizePercent((used / cap) * 100);
  if (percent === undefined) return null;
  const resetAt = quotaResetAt(row);
  return { percent, ...(resetAt !== undefined ? { resetAt } : {}) };
}

/** Soft-fail GET returning a parsed record, or null when unavailable. */
async function fetchCommandCodeJson(url: string, bearer: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return asRecord(await readQuotaJson(response));
  } catch {
    return null;
  }
}

/**
 * Soft-fail period spend (used) against the remaining credit pools → creditsUsd.
 * Period scoping: `since=<currentPeriodStart>` keeps spend aligned with the
 * pools' billing cycle, and `currentPeriodEnd` becomes expiresAt.
 */
async function fetchCommandCodeSpend(
  bearer: string,
  credits: Record<string, unknown> | null,
  orgQuery: string,
): Promise<ProviderQuotaCreditsUsd | undefined> {
  if (!credits) return undefined;
  const subscriptionBody = await fetchCommandCodeJson(`${COMMAND_CODE_SUBSCRIPTIONS_URL}${orgQuery}`, bearer);
  const subscription = asRecord(subscriptionBody?.data) ?? subscriptionBody;
  const periodStart = typeof subscription?.currentPeriodStart === "string" ? subscription.currentPeriodStart.trim() : "";
  // Unscoped /usage/summary is lifetime spend; mixing it with current-cycle
  // remaining pools produces a wrong percent. Omit creditsUsd until a period exists.
  if (!periodStart) return undefined;
  const sinceQuery = `${orgQuery ? "&" : "?"}since=${encodeURIComponent(periodStart)}`;
  const expiresAt = normalizeResetAt(subscription?.currentPeriodEnd);
  const summaryBody = await fetchCommandCodeJson(`${COMMAND_CODE_USAGE_URL}${orgQuery}${sinceQuery}`, bearer);
  const summary = asRecord(summaryBody?.data) ?? summaryBody;
  const used = toFiniteNumber(summary?.totalCost) ?? toFiniteNumber(summary?.totalMonthlyCredits);
  if (used === undefined || used < 0) return undefined;
  const pools = [credits.monthlyCredits, credits.purchasedCredits, credits.freeCredits]
    .map(value => toFiniteNumber(value))
    .filter((value): value is number => value !== undefined);
  // Field presence is what separates a real balance from absent data: an exhausted
  // all-zero account still reports remaining=0, while no remaining-credit field at
  // all means there is nothing to meter.
  if (pools.length === 0) return undefined;
  const remaining = pools.reduce((sum, value) => sum + Math.max(0, value ?? 0), 0);
  const limit = used + remaining;
  const percent = normalizePercent(limit > 0 ? (used / limit) * 100 : 0);
  // Purchased credits roll over past the subscription period end, so an expiry is
  // only truthful when the aggregate contains no non-expiring purchased pool.
  const purchased = toFiniteNumber(credits.purchasedCredits) ?? 0;
  return percent === undefined
    ? undefined
    : {
        used,
        limit,
        remaining,
        percent,
        ...(expiresAt !== undefined && purchased <= 0 ? { expiresAt } : {}),
      };
}

/** OAuth access token or ACTIVE Provider-API key for the Command Code quota probe. */
async function resolveCommandCodeQuotaBearer(config: OcxProviderConfig, accountId?: string): Promise<string | null> {
  if (config.authMode === "oauth") {
    try {
      return accountId ? await getTokenForAccountQuotaProbe("command-code", accountId) : null;
    } catch {
      return null;
    }
  }
  // ACTIVE key only: a quota bar for a different account than the one routing
  // requests is a wrong meter, not a helpful one.
  return resolveProviderApiKey(config.apiKey)?.trim() || null;
}

/**
 * Command Code `GET /alpha/billing/credits` — the same Bearer surface the CLI's
 * usage view uses (windowLimits.fiveHour / windowLimits.weekly), plus soft
 * whoami (team orgId scoping) and subscription-scoped spend for creditsUsd.
 */
async function fetchCommandCodeQuota(provider: string, config: OcxProviderConfig, bearer: string): Promise<ProviderQuotaProbeResult> {
  // Never release credentials to a user-edited or lookalike provider host.
  if (!isCanonicalCommandCodeBaseUrl(config.baseUrl)) return null;
  if (!bearer) return null;
  const whoamiBody = await fetchCommandCodeJson(COMMAND_CODE_WHOAMI_URL, bearer);
  const whoami = asRecord(whoamiBody?.data) ?? whoamiBody;
  const org = asRecord(whoami?.org);
  const orgId = typeof org?.id === "string" && org.id.trim() ? org.id.trim() : null;
  const orgQuery = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  const response = await fetch(`${COMMAND_CODE_CREDITS_URL}${orgQuery}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const raw = asRecord(await readQuotaJson(response));
  const body = asRecord(raw?.data) ?? raw;
  const credits = asRecord(body?.credits);
  const limits = asRecord(body?.windowLimits);
  if (!credits && !limits) return null;
  const fiveHour = parseCommandCodeWindow(limits?.fiveHour);
  const weekly = parseCommandCodeWindow(limits?.weekly);
  const creditsUsd = await fetchCommandCodeSpend(bearer, credits, orgQuery);
  return report(provider, "command-code:credits", {
    ...(fiveHour ? {
      fiveHourPercent: fiveHour.percent,
      ...(fiveHour.resetAt !== undefined ? { fiveHourResetAt: fiveHour.resetAt } : {}),
    } : {}),
    ...(weekly ? {
      weeklyPercent: weekly.percent,
      ...(weekly.resetAt !== undefined ? { weeklyResetAt: weekly.resetAt } : {}),
    } : {}),
    ...(creditsUsd ? { creditsUsd } : {}),
    updatedAt: Date.now(),
  });
}

/** Cursor included usage via api2.cursor.sh (Bearer from OAuth) — unofficial, may change. */
async function fetchCursorQuota(provider: string, accessToken: string): Promise<ProviderQuotaReport | null> {

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
      redirect: "error",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (periodRes.ok) {
      const body = asRecord(await readQuotaJson(periodRes));
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
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (summaryRes.ok) {
      const body = asRecord(await readQuotaJson(summaryRes));
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
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await readQuotaJson(response));
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
  const target = asRecord(quotaInfo.remaining) ?? quotaInfo;
  const remaining = normalizePercent(toFiniteNumber(target.remainingFraction) !== undefined
    ? toFiniteNumber(target.remainingFraction)! * 100
    : toFiniteNumber(target.remainingPercentage) !== undefined
      ? toFiniteNumber(target.remainingPercentage)! * 100
      : undefined);
  if (remaining === undefined) return undefined;
  return normalizePercent(100 - remaining);
}

/** Gem/Cla windows from a `fetchAvailableModels` body; shared by the provider and account probes. */
function antigravityWindowsFromModels(body: Record<string, unknown> | null): ProviderQuotaWindow[] {
  const models = asRecord(body?.models);
  if (!models) return [];

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
  return customWindows;
}

/**
 * Parse Google Antigravity quota from `v1internal:retrieveUserQuotaSummary`.
 * Groups contain Gemini models and Claude/3P models, each with 5h and weekly limit buckets.
 */
function parseAntigravityQuotaSummary(body: Record<string, unknown> | null): ProviderQuota | null {
  const groups = Array.isArray(body?.groups) ? (body.groups as unknown[]) : [];
  if (groups.length === 0) return null;

  const customWindowsMap = new Map<string, ProviderQuotaWindow>();

  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    if (!group) continue;
    const groupName = `${typeof group.displayName === "string" ? group.displayName : ""} ${typeof group.description === "string" ? group.description : ""}`.toLowerCase();
    const isGemini = groupName.includes("gemini");
    const isClaude = groupName.includes("claude") || groupName.includes("3p") || groupName.includes("gpt");

    const buckets = Array.isArray(group.buckets) ? (group.buckets as unknown[]) : [];
    for (const rawBucket of buckets) {
      const bucket = asRecord(rawBucket);
      if (!bucket) continue;
      const windowStr = `${typeof bucket.window === "string" ? bucket.window : ""} ${typeof bucket.bucketId === "string" ? bucket.bucketId : ""} ${typeof bucket.displayName === "string" ? bucket.displayName : ""}`.toLowerCase();
      const percent = antigravityUsedPercent(bucket);
      if (percent === undefined) continue;
      const resetAt = normalizeResetAt(bucket.resetTime);

      const isWeekly = windowStr.includes("week");
      const is5h = windowStr.includes("5h") || windowStr.includes("five");

      if (isGemini) {
        const label = is5h ? "Gem" : isWeekly ? "Gem (Weekly)" : "";
        if (label && !customWindowsMap.has(label)) {
          customWindowsMap.set(label, { label, percent, ...(resetAt !== undefined ? { resetAt } : {}) });
        }
      } else if (isClaude) {
        const label = is5h ? "Cla" : isWeekly ? "Cla (Weekly)" : "";
        if (label && !customWindowsMap.has(label)) {
          customWindowsMap.set(label, { label, percent, ...(resetAt !== undefined ? { resetAt } : {}) });
        }
      } else {
        const baseLabel = typeof group.displayName === "string" ? group.displayName : "Other";
        const label = isWeekly ? `${baseLabel} (Weekly)` : baseLabel;
        if (!customWindowsMap.has(label)) {
          customWindowsMap.set(label, { label, percent, ...(resetAt !== undefined ? { resetAt } : {}) });
        }
      }
    }
  }

  const PREFERRED_ORDER = ["Gem", "Gem (Weekly)", "Cla", "Cla (Weekly)"];
  const customWindows = Array.from(customWindowsMap.values()).sort((a, b) => {
    const ia = PREFERRED_ORDER.indexOf(a.label);
    const ib = PREFERRED_ORDER.indexOf(b.label);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.label.localeCompare(b.label);
  });

  if (customWindows.length === 0) {
    return null;
  }

  return {
    customWindows,
    updatedAt: Date.now(),
  };
}

const ANTIGRAVITY_ACCOUNT_QUOTA_BASE = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_QUOTA_SUMMARY_URL = `${ANTIGRAVITY_ACCOUNT_QUOTA_BASE}/v1internal:retrieveUserQuotaSummary`;
const ANTIGRAVITY_QUOTA_MODELS_URL = `${ANTIGRAVITY_ACCOUNT_QUOTA_BASE}/v1internal:fetchAvailableModels`;

/** Only these fixed accounting destinations may use transparent Fake-IP DNS. */
export function isCanonicalAntigravityQuotaUrl(name: string, url: string): boolean {
  return name === "google-antigravity"
    && (url === ANTIGRAVITY_QUOTA_SUMMARY_URL || url === ANTIGRAVITY_QUOTA_MODELS_URL);
}

let antigravityOutboundDependencies: ProviderOutboundDependencies = {
  isCanonicalUrl: isCanonicalAntigravityQuotaUrl,
};

/** Test seam: inject resolver/pinned transport for provider and per-account probes. */
export function setAntigravityAccountQuotaTransportForTests(dependencies: ProviderOutboundDependencies | null): void {
  antigravityOutboundDependencies = { ...dependencies, isCanonicalUrl: isCanonicalAntigravityQuotaUrl };
}

/**
 * Per-account Antigravity quota (#1082). Always probes Google's own Cloud Code Assist host
 * through the pinned provider-outbound transport: a configured `baseUrl` is a routing choice
 * for requests, not a second source of Google's accounting for a stored credential, and fixing
 * the destination keeps the `provider\0accountId` cache identity exact across config changes.
 * A redirect or non-2xx yields null (unavailable), never a partial row.
 */
export async function fetchAntigravityUsageQuota(accessToken: string, projectId: string): Promise<ProviderQuota | null> {
  const summaryUrl = ANTIGRAVITY_QUOTA_SUMMARY_URL;
  try {
    const summaryResponse = await providerOutboundPost("google-antigravity", { baseUrl: ANTIGRAVITY_ACCOUNT_QUOTA_BASE }, summaryUrl, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": antigravityUserAgent(),
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ project: projectId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, antigravityOutboundDependencies);
    if (await providerRedirectError(summaryResponse, summaryUrl)) return null;
    if (summaryResponse.status === 401 || summaryResponse.status === 403) return null;
    if (summaryResponse.ok) {
      const quota = parseAntigravityQuotaSummary(asRecord(await readQuotaJson(summaryResponse)));
      if (quota) return quota;
    }
  } catch {
    // Fallback to fetchAvailableModels on error
  }

  const url = ANTIGRAVITY_QUOTA_MODELS_URL;
  const response = await providerOutboundPost("google-antigravity", { baseUrl: ANTIGRAVITY_ACCOUNT_QUOTA_BASE }, url, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ project: projectId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, antigravityOutboundDependencies);
  if (await providerRedirectError(response, url)) return null;
  if (!response.ok) return null;
  const customWindows = antigravityWindowsFromModels(asRecord(await readQuotaJson(response)));
  if (customWindows.length === 0) return null;
  return { customWindows, updatedAt: Date.now() };
}

async function fetchAntigravityQuota(provider: string): Promise<ProviderQuotaReport | null> {
  const credential = getCredential("google-antigravity");
  if (!credential?.projectId) return null;
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken("google-antigravity");
  } catch {
    return null;
  }

  // Both probes are pinned to Google's own host through the provider-outbound
  // transport, mirroring `fetchAntigravityUsageQuota` above: a configured `baseUrl` is a
  // routing choice for requests, not a second source of Google's accounting, and these
  // requests carry the account bearer.
  const summaryUrl = ANTIGRAVITY_QUOTA_SUMMARY_URL;
  try {
    const summaryResponse = await providerOutboundPost("google-antigravity", { baseUrl: ANTIGRAVITY_ACCOUNT_QUOTA_BASE }, summaryUrl, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": antigravityUserAgent(),
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ project: credential.projectId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, antigravityOutboundDependencies);
    if (await providerRedirectError(summaryResponse, summaryUrl)) return null;
    if (summaryResponse.status === 401 || summaryResponse.status === 403) return null;
    if (summaryResponse.ok) {
      const quota = parseAntigravityQuotaSummary(asRecord(await readQuotaJson(summaryResponse)));
      if (quota) {
        return report(provider, "google-antigravity:retrieveUserQuotaSummary", quota);
      }
    }
  } catch {
    // Fallback on network/fetch error
  }

  const url = ANTIGRAVITY_QUOTA_MODELS_URL;
  const response = await providerOutboundPost("google-antigravity", { baseUrl: ANTIGRAVITY_ACCOUNT_QUOTA_BASE }, url, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ project: credential.projectId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, antigravityOutboundDependencies);
  if (await providerRedirectError(response, url)) return null;
  if (!response.ok) return null;
  const customWindows = antigravityWindowsFromModels(asRecord(await readQuotaJson(response)));
  if (customWindows.length === 0) return null;
  return report(provider, "google-antigravity:fetchAvailableModels", {
    customWindows,
    updatedAt: Date.now(),
  });
}

type KeyQuotaReader = (name: string, provider: OcxProviderConfig) => Promise<ProviderQuotaProbeResult>;

/** Same selector drives cheap capabilities and uncached reads; never resolves credentials. */
function keyQuotaReaderForProvider(name: string, provider: OcxProviderConfig): KeyQuotaReader | null {
  if (provider.disabled === true || (provider.authMode ?? "key") !== "key") return null;
  if (isCanonicalKimiCodeBaseUrl(provider.baseUrl)) {
    return async (id, config) => {
      const bearer = await resolveKimiQuotaBearer(config);
      return bearer ? fetchKimiQuota(id, config, bearer) : null;
    };
  }
  if (name === "commandcode" && isCanonicalCommandCodeBaseUrl(provider.baseUrl)) {
    return async (id, config) => {
      const bearer = await resolveCommandCodeQuotaBearer(config);
      return bearer ? fetchCommandCodeQuota(id, config, bearer) : null;
    };
  }
  if (registryEntryForProviderDestination(provider)?.id === "opencode-go") return fetchOpenCodeGoQuota;
  if (isCanonicalA6apiBaseUrl(provider.baseUrl)) return fetchA6apiQuota;
  if (name === "openrouter" && isCanonicalOpenRouterBaseUrl(provider.baseUrl)) return fetchOpenRouterQuota;
  if (name === "deepseek" && isCanonicalDeepSeekBaseUrl(provider.baseUrl)) return fetchDeepSeekQuota;
  if (name === "cline-pass" && isCanonicalClineBaseUrl(provider.baseUrl)) return fetchClineQuota;
  if (isCanonicalOllamaCloudBaseUrl(provider.baseUrl ?? getProviderRegistryEntry(name)?.baseUrl)) return fetchOllamaCloudQuota;
  if (["zai", "glm", "glm-cn", "zhipu-bigmodel-coding"].includes(name) && isCanonicalZaiBaseUrl(provider.baseUrl)) return fetchZaiQuota;
  if (["minimax", "minimax-cn"].includes(name) && isCanonicalMinimaxBaseUrl(provider.baseUrl)) return fetchMinimaxQuota;
  if (name === "moonshot" && isCanonicalMoonshotBaseUrl(provider.baseUrl)) return fetchMoonshotQuota;
  if (name === "venice" && isCanonicalVeniceBaseUrl(provider.baseUrl)) return fetchVeniceQuota;
  if (name === "synthetic" && isCanonicalSyntheticBaseUrl(provider.baseUrl)) return fetchSyntheticQuota;
  if (name === "deepinfra" && isCanonicalDeepInfraBaseUrl(provider.baseUrl)) return fetchDeepInfraQuota;
  if (name === "neuralwatt" && isCanonicalNeuralwattBaseUrl(provider.baseUrl)) return fetchNeuralwattQuota;
  return null;
}

export function providerApiKeyQuotaMode(name: string, provider: OcxProviderConfig): AccountQuotaMode {
  return keyQuotaReaderForProvider(name, provider) ? "probe" : "unsupported";
}

export async function fetchProviderApiKeyQuotas(config: OcxConfig, name: string, forceRefresh = false): Promise<ProviderApiKeyQuota[]> {
  const provider = config.providers[name];
  if (!provider || !keyQuotaReaderForProvider(name, provider)) return [];
  return readProviderApiKeyQuotas(config, name, forceRefresh, async (isolatedProvider, isolatedConfig) => {
    const result = await maybeFetchProviderQuota(name, isolatedProvider, isolatedConfig, false);
    if (result === TERMINAL_QUOTA_FAILURE) return { kind: "terminal" };
    if (result === AUTHORITATIVE_EMPTY_QUOTA) return { kind: "empty" };
    return result ? { kind: "quota", quota: result.quota } : { kind: "unavailable" };
  });
}

async function maybeFetchProviderQuota(
  name: string,
  provider: OcxProviderConfig,
  config: OcxConfig,
  forceRefresh: boolean,
  prefetchedCodexSnapshot?: CodexAuthAccountsSnapshotPromise,
): Promise<ProviderQuotaProbeResult> {
  if (provider.disabled === true) return null;
  try {
    if (isBuiltInChatGptForwardProvider(name, provider)) {
      return fetchChatGptForwardQuota(config, name, provider, forceRefresh, prefetchedCodexSnapshot);
    }
    if (provider.authMode === "oauth" && explicitAccountReader(name)) return await fetchExplicitCurrentQuota(name, provider, config);
    if (provider.authMode === "oauth" && name === "anthropic") return fetchAnthropicQuota(name);
    if (provider.authMode === "oauth" && name === "google-antigravity") return await fetchAntigravityQuota(name);
    if (provider.authMode === "oauth" && name === "kiro") return fetchKiroQuota(name);
    // Passive providers (meta-muse): Meta publishes no quota endpoint, so there is no
    // probe to run — the row is the active account's last in-band observation.
    if (provider.authMode === "oauth" && hasPassiveAccountQuota(name)) return fetchPassiveProviderQuota(name);
    const reader = keyQuotaReaderForProvider(name, provider);
    return reader ? reader(name, provider) : null;
  } catch {
    return null;
  }
}

/**
 * Hand freshly committed provider reports to the optional quota-reset observer.
 *
 * Lazy import on purpose: this module is statically reachable from
 * src/server/responses/core.ts (via oauth/anthropic-routing.ts), so a static edge would put
 * the observer and its sink registry on every install's request path.
 *
 * No previous snapshot is passed. The observer keeps its own persisted last-seen map,
 * because `previous` here is bound only when `cache.key === key` and the key digest at
 * cacheKeyWithAggregationState includes quota values and updatedAt — so it is empty exactly
 * when a reset happened.
 *
 * Account identity is resolved SYNCHRONOUSLY, before any await. Two reasons, both observed:
 * pool failover rewrites `activeAccountId` during request routing
 * (promoteAnthropicActiveAccount -> setActiveAccount), so a 429 between this commit and a
 * later async read would attribute this report to a different account and overwrite that
 * account's baseline with these numbers. fetchAnthropicQuota already captures
 * `probedAccountId` before awaiting for exactly this reason; the observer must not be
 * sloppier than the cache it observes.
 *
 * Observations are serialized through a module-level promise chain for the same reason as
 * the codex seam: Bun does not resolve concurrent import() calls in call order, and an
 * out-of-order baseline swap manufactures false resets that then burn the durable
 * idempotence key.
 */
let pendingProviderObservation: Promise<void> = Promise.resolve();

/**
 * Stable per-account observation key for one provider report.
 *
 * OAuth providers key by active account id. Key-auth providers have NO account set, so
 * every key in `apiKeyPool` would collapse onto "default" and rotating from a spent key to
 * a fresh one would read as a reset (measured: 97% -> 12% fired a false surprise). The
 * cache key already discriminates these at cacheKey() via apiKeyPoolEntryId, so this
 * mirrors that discriminator instead of inventing a second notion of identity.
 */
function providerObservationAccountKey(provider: string, config: OcxConfig): string {
  const oauthAccountId = getAccountSet(provider)?.activeAccountId;
  if (oauthAccountId !== undefined) return `${provider}\u0000${oauthAccountId}`;
  const providerConfig = config.providers[provider];
  const resolvedKey = typeof providerConfig?.apiKey === "string"
    ? resolveEnvValue(providerConfig.apiKey)?.trim()
    : undefined;
  const keyId = resolvedKey ? apiKeyPoolEntryId(resolvedKey) : "default";
  return `${provider}\u0000key:${keyId}`;
}

/** Test-only view of the observation account key. */
export function providerObservationAccountKeyForTests(provider: string, config: OcxConfig): string {
  return providerObservationAccountKey(provider, config);
}

function notifyProviderQuotaSnapshot(
  reports: ReadonlyArray<ProviderQuotaReport>,
  config: OcxConfig,
): void {
  if (reports.length === 0) return;
  // Resolved here, synchronously, while the identity is still the one that produced these
  // reports.
  const observations = reports.map(report => ({
    scope: report.provider,
    accountKey: providerObservationAccountKey(report.provider, config),
    quota: report.quota,
  }));
  pendingProviderObservation = pendingProviderObservation
    .then(async () => {
      const observer = await import("../quota/reset-observer");
      if (!observer.hasQuotaResetSink()) return;
      const { providerWindowObservations } = await import("../quota/window-mapping");
      for (const observation of observations) {
        observer.observeQuotaSnapshot({
          scope: observation.scope,
          accountKey: observation.accountKey,
          windows: providerWindowObservations(observation.quota),
        });
      }
    })
    .catch(() => {
      // Detection is best-effort: a quota refresh must never fail because of it. Swallowing
      // here also keeps the chain alive — a rejected link would poison every later one.
    });
}

/** Await the observation chain. Tests only: production never needs to join it. */
export function flushProviderQuotaObservationsForTests(): Promise<void> {
  return pendingProviderObservation;
}

export async function fetchProviderQuotaReports(config: OcxConfig, forceRefresh = false): Promise<ProviderQuotaResponse> {
  // A Pool report's cache signature and provider fetch must share one account snapshot.
  // Preserve force semantics when deciding whether that snapshot refreshes upstream data.
  const prefetchedCodexSnapshot = hasCodexPoolProvider(config)
    ? listCodexAuthAccountsSnapshot(config, forceRefresh)
    : undefined;
  const keyCandidate = cacheKeyWithAggregationState(config, prefetchedCodexSnapshot);
  const key = typeof keyCandidate === "string" ? keyCandidate : await keyCandidate;
  const writerGeneration = captureConfigGeneration();
  const now = Date.now();
  // The cache fast path must not extend a preserved last-good row past its 30-minute bound:
  // a row preserved at age 29:59 plus a full 5-minute TTL would otherwise serve until ~35min.
  // An OBSERVED row is exempt: it carries the observation time, which is older than the bound
  // by construction and never becomes fresher on its own. Without the exemption a single
  // configured passive provider makes this predicate permanently false, so every dashboard
  // poll re-probes every OTHER provider upstream instead of serving the 5-minute cache.
  const cacheFresh = cache && cache.key === key && now - cache.ts < CACHE_TTL_MS
    && cache.response.reports.every(item =>
      (item.observed === true || now - item.updatedAt < LAST_GOOD_MAX_AGE_MS)
      && isProviderQuotaReportCurrent(item));
  if (!forceRefresh && cacheFresh) return cache!.response;
  const joinable = inflight.get(key);
  if (!forceRefresh && joinable && joinable.epoch === invalidationEpoch) return joinable.promise;
  // A forced probe takes commit authority: older in-flight probes must not overwrite its result.
  if (forceRefresh) invalidationEpoch += 1;
  const epoch = invalidationEpoch;

  const promise = (async (): Promise<ProviderQuotaResponse> => {
    const previous = cache && cache.key === key ? cache.response.reports : [];
    const probeResults = await Promise.all(
      Object.entries(config.providers).map(([name, provider]) => (
        maybeFetchProviderQuota(name, provider, config, forceRefresh, prefetchedCodexSnapshot)
      )),
    );
    const fresh = probeResults.filter((item): item is ProviderQuotaReport => (
      item !== null && item !== TERMINAL_QUOTA_FAILURE && item !== AUTHORITATIVE_EMPTY_QUOTA
    ));
    // Both sentinels suppress the previous row. A terminal failure means the response was
    // invalid; an authoritative empty means the response was valid and said there are no
    // model windows. Either way the old row is no longer true, which is what separates them
    // from `null` (told us nothing — keep the last-good row).
    const terminalFailures = new Set(
      Object.keys(config.providers).filter((_, index) => (
        probeResults[index] === TERMINAL_QUOTA_FAILURE
        || probeResults[index] === AUTHORITATIVE_EMPTY_QUOTA
      )),
    );
    await providerQuotaBeforePublishForTests?.();
    let commitKey: string | null = null;
    if (epoch === invalidationEpoch) {
      const commitKeyCandidate = cacheKeyWithAggregationState(config);
      commitKey = typeof commitKeyCandidate === "string" ? commitKeyCandidate : await commitKeyCandidate;
    }

    // Keep bounded last-good rows when a probe fails transiently; terminal-invalid provider
    // responses explicitly suppress their old row. Never re-stamp preserved timestamps.
    // Note: the cache key encodes the provider set (name/adapter/authMode/disabled/baseUrl),
    // so previous rows always correspond to currently configured, enabled providers — a
    // disabled or removed provider changes the key and starts from an empty previous set.
    const cutoff = Date.now() - LAST_GOOD_MAX_AGE_MS;
    const byProvider = new Map<string, ProviderQuotaReport>();
    const generationMismatchedProviders = new Set<string>();
    for (const item of previous) {
      // Same exemption as the fast path. A passive row reaching `previous` is not a probe
      // that went quiet — there is no probe — so age cannot condemn it.
      if (item.observed !== true && item.updatedAt < cutoff) continue;
      if (isProviderQuotaReportCurrent(item)) byProvider.set(item.provider, item);
      else generationMismatchedProviders.add(item.provider);
    }
    for (const item of fresh) {
      if (isProviderQuotaReportCurrent(item)) {
        byProvider.set(item.provider, item);
        generationMismatchedProviders.delete(item.provider);
      } else {
        byProvider.delete(item.provider);
        generationMismatchedProviders.add(item.provider);
      }
    }
    // Terminal-invalid probes suppress their previous row (transient failures keep it).
    for (const provider of terminalFailures) {
      byProvider.delete(provider);
      generationMismatchedProviders.delete(provider);
    }

    const response = { generatedAt: Date.now(), reports: [...byProvider.values()] };
    // Commit only when this probe still holds authority (no clear/force superseded it).
    if (
      epoch === invalidationEpoch
      && commitKey === key
      && generationMismatchedProviders.size === 0
    ) {
      const reports = response.reports.filter(item => mayCommitProviderQuotaKey(item.provider, writerGeneration));
      cache = { key, ts: Date.now(), response: { ...response, reports } };
      replaceCachedProviderQuotas(reports);
      notifyProviderQuotaSnapshot(reports, config);
    }
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
