import type { UsageResponse } from "./usage-model";
import { USAGE_APPS } from "../../../../src/usage/app-breakdown";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const optional = (row: Record<string, unknown>, names: string[], check: (value: unknown) => boolean) => names.every(name => row[name] === undefined || check(row[name]));
const numeric = (row: Record<string, unknown>, names: string[]) => names.every(name => integer(row[name]));
const appClients = new Set<string>(USAGE_APPS);

function validApps(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > appClients.size) return false;
  const seen = new Set<string>();
  return value.every(row => {
    if (!record(row) || typeof row.client !== "string" || !appClients.has(row.client) || seen.has(row.client)
      || !numeric(row, ["requests", "measuredRequests", "pricedRequests", "unpricedRequests"])
      || !finite(row.totalTokens) || !finite(row.shareRatio) || (row.shareRatio as number) > 1
      || !(row.estimatedCostUsd === undefined && row.pricedRequests === 0 || finite(row.estimatedCostUsd))) return false;
    seen.add(row.client);
    return true;
  });
}

function safeNumbers(value: unknown, depth = 0): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return true;
  if (depth >= 16) return false;
  return Object.values(value).every(child => safeNumbers(child, depth + 1));
}

/** Validate every field consumed by the Usage report before publishing a shared resource. */
export function isUsageReport(value: unknown): value is UsageResponse {
  if (!record(value) || !validApps(value.apps) || !safeNumbers(value) || !record(value.summary) || !Array.isArray(value.days) || !Array.isArray(value.models) || !Array.isArray(value.providers)
    || !integer(value.generatedAt) || (value.since !== null && !integer(value.since))
    || typeof value.historyTruncated !== "boolean" || typeof value.entriesTruncated !== "boolean"
    || !integer(value.truncatedPrefixBytes) || !integer(value.entriesDropped) || !integer(value.legacyUnclassifiedRequests)
    || !optional(value, ["snapshotWindowStart", "snapshotWindowEnd"], timestamp => timestamp === null || (typeof timestamp === "number" && Number.isSafeInteger(timestamp)))
    || (value.usageIncomplete !== undefined && typeof value.usageIncomplete !== "boolean")
    || (value.usageIncompleteReason !== undefined && (value.usageIncomplete !== true || value.usageIncompleteReason !== "oversized_rows"))) return false;
  const summary = value.summary;
  if (!numeric(summary, ["requests", "measuredRequests", "reportedRequests", "unreportedRequests", "unsupportedRequests", "estimatedRequests"])
    || !["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens", "totalTokens"].every(name => finite(summary[name]))
    || !finite(summary.coverageRatio) || (summary.coverageRatio as number) > 1
    || !optional(summary, ["cacheReadInputTokens", "cacheCreationInputTokens", "cacheObservedInputTokens", "throughputOutputTokens", "throughputDurationMs"], finite)
    || !optional(summary, ["pricedRequests", "unpricedRequests", "unmeteredRequests", "throughputSamples", "attemptCount", "sends", "settledSends", "unresolvedSends", "spendRequests", "cacheObservedRequests", "cacheSynthesizedRequests", "cacheUnknownRequests"], integer)
    || !optional(summary, ["estimatedCostUsd", "throughputTokensPerSec"], finite)
    || !optional(value, ["legacyUnclassifiedRequests"], integer)) return false;
  if (!value.days.every(day => record(day) && typeof day.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.date)
    && numeric(day, ["requests", "measuredRequests", "reportedRequests"]) && finite(day.totalTokens) && optional(day, ["estimatedCostUsd"], finite)
    && Array.isArray(day.models) && day.models.every((model: unknown) => record(model) && typeof model.model === "string" && typeof model.provider === "string" && numeric(model, ["requests"]) && finite(model.totalTokens) && optional(model, ["attemptCount"], integer) && optional(model, ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "cacheObservedInputTokens"], finite)))) return false;
  const validRow = (row: unknown, model: boolean) => record(row) && typeof row.provider === "string" && (!model || typeof row.model === "string")
    && numeric(row, ["requests", "measuredRequests", "reportedRequests", "estimatedRequests"]) && finite(row.totalTokens)
    && (!model || (finite(row.inputTokens) && finite(row.outputTokens)))
    && finite(row.shareRatio)
    && optional(row, ["inputTokens", "outputTokens", "cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "cacheObservedInputTokens"], finite)
    && optional(row, ["pricedRequests", "unpricedRequests", "unmeteredRequests", "throughputSamples", "attemptCount"], integer)
    && optional(row, ["estimatedCostUsd", "throughputTokensPerSec"], finite)
    && (row.cacheHitRate === undefined || row.cacheHitRate === null || finite(row.cacheHitRate))
    && (row.resolvedModel === undefined || typeof row.resolvedModel === "string");
  return value.models.every(model => validRow(model, true)) && value.providers.every(provider => validRow(provider, false));
}
