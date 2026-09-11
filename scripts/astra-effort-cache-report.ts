import { readRecentUsageEntries, type PersistedUsageEntry } from "../src/usage/log";
import { normalizeAstraEffortCacheMetrics } from "../src/usage/astra-effort-cache";

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) ?? null };
}

export function summarizeAstraEffortCache(entries: PersistedUsageEntry[]) {
  const statuses: Record<string, number> = {};
  const stateOutcomes: Record<string, number> = {};
  const timings = Object.fromEntries(["durationMs", "setupMs", "transactionMs", "historyMs", "closeMs"].map(key => [key, [] as number[]]));
  const cache = { hit: 0, miss: 0, unknown: 0, invalid: 0, inputTokens: 0, cachedInputTokens: 0 };
  let samples = 0;
  for (const entry of entries) {
    for (const row of entry.attempts?.length ? entry.attempts : [entry]) {
      const metrics = normalizeAstraEffortCacheMetrics(row.astraEffortCache);
      if (!metrics) continue;
      samples++;
      statuses[metrics.status] = (statuses[metrics.status] ?? 0) + 1;
      stateOutcomes[metrics.stateOutcome] = (stateOutcomes[metrics.stateOutcome] ?? 0) + 1;
      for (const key of Object.keys(timings) as (keyof typeof metrics)[]) {
        const value = metrics[key];
        if (typeof value === "number") timings[key].push(value);
      }
      const input = row.usage?.inputTokens;
      const cached = row.usage?.cachedInputTokens;
      if (row.usageStatus !== "reported" || input === undefined || cached === undefined) cache.unknown++;
      else if (!Number.isSafeInteger(input) || !Number.isSafeInteger(cached) || input < 0 || cached < 0 || cached > input) cache.invalid++;
      else {
        cache[cached > 0 ? "hit" : "miss"]++;
        cache.inputTokens += input;
        cache.cachedInputTokens += cached;
      }
    }
  }
  return {
    rowsRead: entries.length, samples, statuses, stateOutcomes,
    timingsMs: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, distribution(values)])),
    cache: { ...cache, cachedInputRatio: cache.inputTokens > 0 ? cache.cachedInputTokens / cache.inputTokens : null },
  };
}

if (import.meta.main) {
  const [limitArg = "1000", requestId] = process.argv.slice(2);
  const limit = Number(limitArg);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Usage: bun scripts/astra-effort-cache-report.ts [1..10000 recent rows] [request-id]");
  const entries = readRecentUsageEntries(limit);
  console.log(JSON.stringify(summarizeAstraEffortCache(requestId ? entries.filter(row => row.requestId === requestId) : entries), null, 2));
}
