import { resolveProviderApiKey } from "../key-store";
import { getProviderRegistryEntry, registryEntryForProviderDestination } from "../registry";
import { isCanonicalOllamaCloudUrl } from "../../adapters/ollama-native-url";
import { providerEgressFetchInit, resolveProviderEgress } from "../../lib/provider-egress";
import { configuredOutboundFetch } from "../../lib/proxy-env";
import { QUOTA_JSON_READ_FAILURE, asRecord, normalizePercent, normalizeResetAt, readQuotaJson, REQUEST_TIMEOUT_MS, toFiniteNumber } from "../quota-wire";
import {
  AUTHORITATIVE_EMPTY_QUOTA,
  hasQuotaRows,
  keyReport,
  report,
  TERMINAL_QUOTA_FAILURE,
  type ProviderQuotaProbeResult,
  type ProviderQuotaReport,
} from "./report-cache";
import { getTokenForAccountQuotaProbe } from "./account-cache";
import type { AccountQuotaMode, ProviderQuota, ProviderQuotaCreditsUsd } from "../quota-types";
import type { OcxProviderConfig } from "../../types";

// A quota probe must use the provider's inference route so it neither reports a false healthy path nor leaks a key through another exit.
async function quotaFetch(providerName: string, config: OcxProviderConfig, url: string, init: RequestInit): Promise<Response> {
  const egress = resolveProviderEgress({ providerName, provider: config, url });
  return configuredOutboundFetch(url, { ...init, ...providerEgressFetchInit(egress) });
}

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

function zaiQuotaMonitorHost(baseUrl: string): string | null {
  // Admission and destination selection must share one mapping: admitting a new
  // international wire must never fall through to the CN host/authentication scheme.
  switch (normalizedBaseUrl(baseUrl)) {
    case ZAI_BASE_URL:
    case `${ZAI_BASE_URL}/api/coding/paas/v4`:
    case `${ZAI_BASE_URL}/api/anthropic`:
    case `${ZAI_BASE_URL}/api/v1`:
      return ZAI_BASE_URL;
    case ZAI_CN_BASE_URL:
    case `${ZAI_CN_BASE_URL}/api/coding/paas/v4`:
    case `${ZAI_CN_BASE_URL}/api/v1`:
      return ZAI_CN_BASE_URL;
    default:
      return null;
  }
}

function isCanonicalZaiBaseUrl(baseUrl: string): boolean {
  return zaiQuotaMonitorHost(baseUrl) !== null;
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
    quotaFetch(provider, config, `${A6API_BASE_URL}/dashboard/billing/subscription`, {
      headers, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
    quotaFetch(provider, config, `${A6API_BASE_URL}/api/usage/token/`, {
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
    // Every row is an API-credit constraint on inference, so the display quota is also
    // the routing projection. Passing it explicitly is the opt-in.
    const quota: ProviderQuota = {
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
    };
    return keyReport(provider, "a6api:billing", quota, config, apiKey, quota);
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
  const quota: ProviderQuota = {
    creditsUsd: {
      used: usedUsd,
      limit: limitUsd,
      remaining: remainingUsd,
      percent,
      ...expiry,
    },
    customWindows: [{ label, percent }],
    updatedAt: Date.now(),
  };
  // The credit balance funds inference itself, so display and routing scope agree.
  return keyReport(provider, "a6api:billing", quota, config, apiKey, quota);
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
  const response = await quotaFetch(provider, config, OPENCODE_GO_USAGE_URL, {
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
  return keyReport(provider, "opencode-go:usage", quota, config, apiKey, quota);
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
  const response = await quotaFetch(provider, config, `${OPENROUTER_BASE_URL}/key`, {
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
  // The per-key spending cap stops every request this credential can make, so the
  // whole report is inference-wide routing evidence.
  const quota: ProviderQuota = {
    customWindows: [{ label, percent }],
    updatedAt: Date.now(),
  };
  return keyReport(provider, "openrouter:key-info", quota, config, apiKey, quota);
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
  const response = await quotaFetch(provider, config, `${DEEPSEEK_BASE_URL}/user/balance`, {
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
  const response = await quotaFetch(provider, config, `${CLINE_BASE_URL}/api/v1/users/me/plan/usage-limits`, {
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
  return windows > 0 ? keyReport(provider, "cline:plan-usage-limits", quota, config, apiKey, quota) : null;
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
  const response = await quotaFetch(provider, config, OLLAMA_CLOUD_USAGE_URL, {
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
  return quota ? keyReport(provider, "ollama-cloud:usage", quota, config, apiKey, quota) : null;
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
  const monitorHost = zaiQuotaMonitorHost(config.baseUrl);
  if (!monitorHost) return null;
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!apiKey) return null;
  const authorization = monitorHost === ZAI_CN_BASE_URL ? apiKey : `Bearer ${apiKey}`;
  const response = await quotaFetch(provider, config, `${monitorHost}/api/monitor/usage/quota/limit`, {
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
    return quota
      ? keyReport(provider, "zai:quota-limit", quota, config, apiKey, quota)
      : AUTHORITATIVE_EMPTY_QUOTA;
  }
  const legacy = parseZaiQuotaLegacyFields(data);
  if (!legacy) return null;
  // The legacy monthly figure also carries MCP usage; it is display evidence, not
  // proof that model inference is unavailable. Modern TOKEN_LIMIT rows above are scoped.
  const inferenceQuota = { ...legacy };
  delete inferenceQuota.monthlyPercent;
  delete inferenceQuota.monthlyResetAt;
  return keyReport(provider, "zai:quota-limit", legacy, config, apiKey, inferenceQuota);
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
  const response = await quotaFetch(provider, config, remainsUrl, {
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
  const response = await quotaFetch(provider, config, `${host}/users/me/balance`, {
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
  const response = await quotaFetch(provider, config, `${VENICE_BASE_URL}/billing/balance`, {
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
  const response = await quotaFetch(provider, config, `${SYNTHETIC_BASE_URL}/quotas`, {
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
  const inferenceQuota = { ...quota };
  delete inferenceQuota.customWindows; // search.hourly does not constrain model inference.
  return windows > 0 ? keyReport(provider, "synthetic:quotas", quota, config, apiKey, inferenceQuota) : null;
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
  const response = await quotaFetch(provider, config, `${DEEPINFRA_BASE_URL}/payment/checklist?compute_owed=true`, {
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
  const response = await quotaFetch(provider, config, `${NEURALWATT_BASE_URL}/quota`, {
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


export function normalizedBaseUrl(value: string): string | null {
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

export function isCanonicalKimiCodeBaseUrl(baseUrl: string): boolean {
  return normalizedBaseUrl(baseUrl) === KIMI_CODE_BASE_URL;
}

export function isCanonicalCommandCodeBaseUrl(baseUrl: string): boolean {
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

export async function fetchKimiQuota(provider: string, config: OcxProviderConfig, accessToken: string): Promise<ProviderQuotaReport | null> {
  // Never release credentials to a user-edited or lookalike provider host.
  if (!isCanonicalKimiCodeBaseUrl(config.baseUrl)) return null;
  if (!accessToken) return null;
  const response = await quotaFetch(provider, config, KIMI_CODE_USAGE_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const quota = parseKimiQuotaPayload(await readQuotaJson(response));
  return quota ? keyReport(provider, "kimi:usages", quota, config, accessToken, quota) : null;
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
async function fetchCommandCodeJson(
  provider: string,
  config: OcxProviderConfig,
  url: string,
  bearer: string,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await quotaFetch(provider, config, url, {
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
  provider: string,
  config: OcxProviderConfig,
  bearer: string,
  credits: Record<string, unknown> | null,
  orgQuery: string,
): Promise<ProviderQuotaCreditsUsd | undefined> {
  if (!credits) return undefined;
  const subscriptionBody = await fetchCommandCodeJson(provider, config, `${COMMAND_CODE_SUBSCRIPTIONS_URL}${orgQuery}`, bearer);
  const subscription = asRecord(subscriptionBody?.data) ?? subscriptionBody;
  const periodStart = typeof subscription?.currentPeriodStart === "string" ? subscription.currentPeriodStart.trim() : "";
  // Unscoped /usage/summary is lifetime spend; mixing it with current-cycle
  // remaining pools produces a wrong percent. Omit creditsUsd until a period exists.
  if (!periodStart) return undefined;
  const sinceQuery = `${orgQuery ? "&" : "?"}since=${encodeURIComponent(periodStart)}`;
  const expiresAt = normalizeResetAt(subscription?.currentPeriodEnd);
  const summaryBody = await fetchCommandCodeJson(provider, config, `${COMMAND_CODE_USAGE_URL}${orgQuery}${sinceQuery}`, bearer);
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
export async function fetchCommandCodeQuota(provider: string, config: OcxProviderConfig, bearer: string): Promise<ProviderQuotaProbeResult> {
  // Never release credentials to a user-edited or lookalike provider host.
  if (!isCanonicalCommandCodeBaseUrl(config.baseUrl)) return null;
  if (!bearer) return null;
  const whoamiBody = await fetchCommandCodeJson(provider, config, COMMAND_CODE_WHOAMI_URL, bearer);
  const whoami = asRecord(whoamiBody?.data) ?? whoamiBody;
  const org = asRecord(whoami?.org);
  const orgId = typeof org?.id === "string" && org.id.trim() ? org.id.trim() : null;
  const orgQuery = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  const response = await quotaFetch(provider, config, `${COMMAND_CODE_CREDITS_URL}${orgQuery}`, {
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
  const creditsUsd = await fetchCommandCodeSpend(provider, config, bearer, credits, orgQuery);
  const quota: ProviderQuota = {
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
  };
  // Rolling windows and the credit balance both gate inference on this bearer.
  return keyReport(provider, "command-code:credits", quota, config, bearer, quota);
}


type KeyQuotaReader = (name: string, provider: OcxProviderConfig) => Promise<ProviderQuotaProbeResult>;

/** Same selector drives cheap capabilities and uncached reads; never resolves credentials. */
export function keyQuotaReaderForProvider(name: string, provider: OcxProviderConfig): KeyQuotaReader | null {
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
  // #4201: the Responses preset is the same domestic GLM Coding Plan subscription on the OpenAI
  // Responses wire, so it reads the same monitor endpoint. Eligibility stays a name list AND the
  // canonical-URL guard: the guard is what keeps BigModel's bare-key Authorization from reaching a
  // lookalike host, so a same-named custom destination still dispatches nothing.
  if (["zai", "glm", "glm-cn", "zhipu-bigmodel-coding", "zhipu-bigmodel-responses"].includes(name) && isCanonicalZaiBaseUrl(provider.baseUrl)) return fetchZaiQuota;
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
