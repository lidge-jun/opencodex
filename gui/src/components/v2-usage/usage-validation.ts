import type { UsageResponse } from "./usage-model";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const optional = (row: Record<string, unknown>, names: string[], check: (value: unknown) => boolean) => names.every(name => row[name] === undefined || check(row[name]));
const numeric = (row: Record<string, unknown>, names: string[]) => names.every(name => integer(row[name]));

function safeNumbers(value: unknown, depth = 0): boolean {
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (!value || typeof value !== "object") return true;
  if (depth >= 16) return false;
  return Object.values(value).every(child => safeNumbers(child, depth + 1));
}

/** Validate every field consumed by the Usage report before publishing a shared resource. */
export function isUsageReport(value: unknown): value is UsageResponse {
  if (!record(value) || !safeNumbers(value) || !record(value.summary) || !Array.isArray(value.days) || !Array.isArray(value.models) || !Array.isArray(value.providers)
    || !integer(value.generatedAt) || (value.since !== null && !integer(value.since))
    || typeof value.historyTruncated !== "boolean" || typeof value.entriesTruncated !== "boolean"
    || !integer(value.truncatedPrefixBytes) || !integer(value.entriesDropped) || !integer(value.legacyUnclassifiedRequests)) return false;
  const summary = value.summary;
  if (!numeric(summary, ["requests", "measuredRequests", "reportedRequests", "unreportedRequests", "unsupportedRequests", "estimatedRequests", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens", "totalTokens"])
    || !finite(summary.coverageRatio) || (summary.coverageRatio as number) > 1
    || !optional(summary, ["cacheReadInputTokens", "cacheCreationInputTokens", "pricedRequests", "unpricedRequests", "unmeteredRequests", "throughputSamples"], integer)
    || !optional(summary, ["estimatedCostUsd", "throughputTokensPerSec"], finite)
    || !optional(value, ["legacyUnclassifiedRequests"], integer)) return false;
  if (!value.days.every(day => record(day) && typeof day.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.date)
    && numeric(day, ["requests", "measuredRequests", "reportedRequests", "totalTokens"]) && optional(day, ["estimatedCostUsd"], finite)
    && Array.isArray(day.models) && day.models.every((model: unknown) => record(model) && typeof model.model === "string" && typeof model.provider === "string" && numeric(model, ["requests", "totalTokens"])))) return false;
  const validRow = (row: unknown, model: boolean) => record(row) && typeof row.provider === "string" && (!model || typeof row.model === "string")
    && numeric(row, ["requests", "measuredRequests", "reportedRequests", "estimatedRequests", "totalTokens"])
    && (!model || numeric(row, ["inputTokens", "outputTokens"]))
    && finite(row.shareRatio)
    && optional(row, ["cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "cacheObservedInputTokens", "pricedRequests", "unpricedRequests", "unmeteredRequests", "throughputSamples"], integer)
    && optional(row, ["estimatedCostUsd", "throughputTokensPerSec"], finite)
    && (row.cacheHitRate === undefined || row.cacheHitRate === null || finite(row.cacheHitRate))
    && (row.resolvedModel === undefined || typeof row.resolvedModel === "string");
  return value.models.every(model => validRow(model, true)) && value.providers.every(provider => validRow(provider, false));
}
