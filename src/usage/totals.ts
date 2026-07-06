import type { OcxUsage } from "../types";

function cacheDetailTokens(usage: OcxUsage): number | undefined {
  const hasRead = typeof usage.cacheReadInputTokens === "number";
  const hasCreate = typeof usage.cacheCreationInputTokens === "number";
  if (!hasRead && !hasCreate) return undefined;
  return (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
}

export function usageInputTokensWithCacheDetail(usage: OcxUsage): number {
  const cacheDetailTotal = cacheDetailTokens(usage);
  return usage.inputTokens + (cacheDetailTotal ?? 0);
}

export function usageDisplayTotalTokens(usage: OcxUsage | undefined, storedTotal?: number): number | undefined {
  if (!usage) return storedTotal;
  const baseTotal = usage.inputTokens + usage.outputTokens;
  const explicitTotal = usage.totalTokens ?? storedTotal;
  const cacheDetailTotal = cacheDetailTokens(usage);
  if (cacheDetailTotal !== undefined) {
    const detailedTotal = baseTotal + cacheDetailTotal;
    return typeof explicitTotal === "number" ? Math.max(explicitTotal, detailedTotal) : detailedTotal;
  }
  return explicitTotal ?? baseTotal;
}
