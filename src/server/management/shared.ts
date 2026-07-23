import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogModel } from "../../codex/catalog";
import { catalogModelSlug, invalidateCodexModelsCache, nativeModelRows, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  multiAgentGuidanceEnabled,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfig,
} from "../../config";
import {
  clearLoginState,
  getLoginStatus,
  isPublicOAuthProvider,
  listOAuthProviders,
  startLoginFlow,
  submitManualLoginCode,
  upsertOAuthProvider,
} from "../../oauth";
import { removeCredential } from "../../oauth/store";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../../oauth/key-providers";
import { deriveProviderPresets } from "../../providers/derive";
import { providerCodexAccountMode } from "../../providers/registry";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
import { resolveCodexHomeDir } from "../../codex/home";
import { scanStorage } from "../../storage/scanner";
import { readUsageEntries } from "../../usage/log";
import { getUsageDebugLogEntries } from "../../usage/debug";
import { parseRange, parseUsageSurface, summarizeUsage } from "../../usage/summary";
import { stripCodexRuntimeProviderFields } from "../../codex/auth-context";
import { getProviderRegistryEntry } from "../../providers/registry";
import { getDebugLogEntries } from "../../lib/debug-log-buffer";
import { getInjectionDebugLogEntries } from "../../lib/injection-debug-log";
import {
  clearDebugSettings,
  clearDebugSetting,
  getDebugSettings,
  setDebugSettings,
  type DebugFlag,
} from "../../lib/debug-settings";
import type { OcxClaudeCodeConfig, OcxConfig, OcxCustomModel, OcxProviderConfig } from "../../types";
import { drainAndShutdown } from "../lifecycle";
import { filterRequestLogs, getRequestLogEntries, type RequestLogEntry } from "../request-log";
import { estimateComboCost, estimateRequestCost, effectiveServiceTier, normalizeCostTokens, tokensPerSecond } from "../../usage/cost";
import type { PersistedUsageAttempt } from "../../usage/log";
import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO } from "../auth-cors";
import { applySystemEnvToggle } from "../system-env";


export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseDebugLogQuery(url: URL): { after: number; limit: number } {
  const after = Number(url.searchParams.get("after") ?? url.searchParams.get("since") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "500");
  return {
    after: Number.isFinite(after) && after > 0 ? after : 0,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : 500,
  };
}

// ---- /api/logs display metrics (devlog/_plan/260720_toks_speed_price_columns/020) ----
// Derived at response time only; NEVER persisted to the request log or usage.jsonl.

export type MetricUnavailableReason =
  | "usage_missing" | "usage_unsupported" | "output_missing" | "invalid_duration"
  | "price_unmatched" | "invalid_cache_breakdown"
  | "invalid_usage" | "combo_attempt_unavailable";

export type TokPerSecondResult =
  | { kind: "value"; value: number; estimated: boolean }
  | { kind: "unavailable"; reason: MetricUnavailableReason };

export type CostEstimateReason = "usage_estimated" | "cache_detail_missing" | "expected_price_overlay";

export type CostResult =
  | { kind: "value"; estimate: NonNullable<ReturnType<typeof estimateRequestCost>>; estimateReasons: CostEstimateReason[] }
  | { kind: "unavailable"; reason: MetricUnavailableReason };

export type MetricSource = Pick<RequestLogEntry, "provider" | "model" | "durationMs" | "usageStatus" | "usage" | "requestedServiceTier" | "configuredServiceTier" | "responseServiceTier"> & {
  attempts?: readonly PersistedUsageAttempt[];
};

export function tokPerSecondResult(entry: Pick<MetricSource, "durationMs" | "usageStatus" | "usage">): TokPerSecondResult {
  if (!entry.usage) return { kind: "unavailable", reason: "usage_missing" };
  if (entry.usageStatus === "unsupported") return { kind: "unavailable", reason: "usage_unsupported" };
  const value = tokensPerSecond(entry.usage.outputTokens, entry.durationMs);
  if (value === null) {
    return {
      kind: "unavailable",
      reason: entry.usage.outputTokens <= 0 ? "output_missing" : "invalid_duration",
    };
  }
  return { kind: "value", value, estimated: entry.usageStatus === "estimated" || entry.usage.estimated === true };
}

export function unavailableCostReason(entry: MetricSource): MetricUnavailableReason {
  // Normalizer-first classification: the landed normalizer recovers legacy
  // cachedInputTokens=read+write rows via retry, so a raw read+write>input
  // pre-check would misclassify recoverable rows (020 audit blocker #2).
  if (!entry.usage && !entry.attempts?.length) return "usage_missing";
  if (entry.usageStatus === "unsupported") return "usage_unsupported";
  if (entry.attempts?.length) return "combo_attempt_unavailable";
  if (!entry.usage) return "usage_missing";
  if (!normalizeCostTokens(entry.usage)) {
    const effectiveRead = entry.usage.cacheReadInputTokens ?? entry.usage.cachedInputTokens ?? 0;
    const effectiveWrite = entry.usage.cacheCreationInputTokens ?? 0;
    const finite = [entry.usage.inputTokens, entry.usage.outputTokens, effectiveRead, effectiveWrite]
      .every(v => Number.isFinite(v) && v >= 0);
    return finite ? "invalid_cache_breakdown" : "invalid_usage";
  }
  return "price_unmatched";
}

export function costResult(entry: MetricSource): CostResult {
  const tier = effectiveServiceTier(entry);
  const estimate = entry.attempts?.length
    ? estimateComboCost(entry.attempts, undefined, tier)
    : estimateRequestCost({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus, serviceTier: tier });
  if (!estimate) return { kind: "unavailable", reason: unavailableCostReason(entry) };
  const estimateReasons = [
    entry.usageStatus === "estimated" || entry.usage?.estimated ? "usage_estimated" as const : undefined,
    entry.usage && entry.usage.cachedInputTokens === undefined
      && entry.usage.cacheReadInputTokens === undefined
      && entry.usage.cacheCreationInputTokens === undefined ? "cache_detail_missing" as const : undefined,
    estimate.price?.source === "expected" || estimate.attempts?.some(a => a.price.source === "expected")
      ? "expected_price_overlay" as const : undefined,
  ].filter((reason): reason is CostEstimateReason => reason !== undefined);
  return { kind: "value", estimate, estimateReasons };
}

export function requestLogDto(entry: RequestLogEntry): Record<string, unknown> {
  return {
    ...entry,
    displayMetrics: {
      tokPerSecond: tokPerSecondResult(entry),
      cost: costResult(entry),
    },
    ...(entry.attempts?.length
      ? {
        attempts: entry.attempts.map(attempt => ({
          ...attempt,
          displayMetrics: {
            tokPerSecond: tokPerSecondResult(attempt),
            cost: costResult({ ...attempt, attempts: undefined, requestedServiceTier: entry.requestedServiceTier, configuredServiceTier: entry.configuredServiceTier, responseServiceTier: entry.responseServiceTier }),
          },
        })),
      }
      : {}),
  };
}

/**
 * Live routed-provider models for the proxy's /api/* and /v1/models endpoints. Delegates to the
 * canonical, TTL-cached `gatherRoutedModels` (single source of truth) — so the GUI/codex endpoints
 * share the same fetch, the same per-provider cache (dedups Codex's frequent /v1/models polling),
 * and the same stale fallback when a provider blips, instead of a parallel uncached copy.
 */
export async function fetchAllModels(config: OcxConfig): Promise<CatalogModel[]> {
  const { gatherRoutedModels } = await import("../../codex/catalog");
  return gatherRoutedModels(config);
}

export function stripRegistryOnlyStaticHeaders(name: string, provider: OcxProviderConfig): OcxProviderConfig {
  const entry = getProviderRegistryEntry(name);
  if (!entry?.staticHeaders || !provider.headers) return provider;
  const headerEntries = Object.entries(provider.headers);
  const staticEntries = Object.entries(entry.staticHeaders);
  if (headerEntries.length !== staticEntries.length) return provider;
  const matchesRegistryStaticHeaders = staticEntries.every(([key, value]) => provider.headers?.[key] === value);
  if (!matchesRegistryStaticHeaders) return provider;
  const { headers: _headers, ...rest } = provider;
  return rest;
}

