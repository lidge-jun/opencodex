import { readRecentUsageEntries, type PersistedUsageEntry } from "../src/usage/log";
import { normalizeSideChatCacheMetrics } from "../src/usage/side-chat-cache";

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return { samples: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? null };
}

export function summarizeSideChatCache(entries: PersistedUsageEntry[]) {
  const reasons: Record<string, number> = {}, phases: Record<string, number> = {}, snapshotOutcomes: Record<string, number> = {};
  const timings: Record<string, number[]> = { prepareMs: [], completionMs: [], normalizeMs: [], hashMs: [], matchMs: [], requestOrAttemptMs: [], firstOutputMs: [] };
  const cache = { hit: 0, miss: 0, unknown: 0, invalid: 0, noInput: 0, inputTokens: 0, cachedInputTokens: 0 };
  const byPhase: Record<string, { samples: number; hits: number; misses: number; unknown: number }> = {};
  let samples = 0, expiredEntries = 0, evictedEntries = 0;
  let latestRetention: { observedAt: number; requestTimestamp: number; retainedSnapshots: number; retainedBindings: number; estimatedRetainedBytes: number } | null = null;
  for (const entry of entries) {
    for (const row of entry.attempts?.length ? entry.attempts : [entry]) {
      const metrics = normalizeSideChatCacheMetrics(row.sideChatCache);
      if (!metrics) continue;
      samples++;
      reasons[metrics.reason] = (reasons[metrics.reason] ?? 0) + 1;
      phases[metrics.phase] = (phases[metrics.phase] ?? 0) + 1;
      snapshotOutcomes[metrics.snapshotOutcome] = (snapshotOutcomes[metrics.snapshotOutcome] ?? 0) + 1;
      const phase = byPhase[metrics.phase] ??= { samples: 0, hits: 0, misses: 0, unknown: 0 };
      phase.samples++;
      timings.prepareMs.push(metrics.prepareMs);
      for (const key of ["completionMs", "normalizeMs", "hashMs", "matchMs"] as const) if (metrics[key] !== undefined) timings[key].push(metrics[key]);
      for (const [key, value] of [["requestOrAttemptMs", row.durationMs], ["firstOutputMs", row.firstOutputMs]] as const) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) timings[key].push(value);
      }
      expiredEntries += metrics.expiredEntries; evictedEntries += metrics.evictedEntries;
      if (metrics.observedAt !== undefined && (!latestRetention || metrics.observedAt >= latestRetention.observedAt)) latestRetention = { observedAt: metrics.observedAt, requestTimestamp: entry.timestamp,
        retainedSnapshots: metrics.retainedSnapshots, retainedBindings: metrics.retainedBindings, estimatedRetainedBytes: metrics.estimatedRetainedBytes };
      const input = row.usage?.inputTokens, cached = row.usage?.cachedInputTokens;
      if (row.usageStatus !== "reported" || input === undefined || cached === undefined) { cache.unknown++; phase.unknown++; }
      else if (!Number.isSafeInteger(input) || !Number.isSafeInteger(cached) || input < 0 || cached < 0 || cached > input) { cache.invalid++; phase.unknown++; }
      else if (input === 0) { cache.noInput++; phase.unknown++; }
      else {
        cache[cached > 0 ? "hit" : "miss"]++; phase[cached > 0 ? "hits" : "misses"]++;
        cache.inputTokens += input; cache.cachedInputTokens += cached;
      }
    }
  }
  return { rowsRead: entries.length, samples, reasons, phases, snapshotOutcomes, byPhase, expiredEntries, evictedEntries, latestRetention,
    timingsMs: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, distribution(values)])),
    cache: { ...cache, cachedInputRatio: cache.inputTokens ? cache.cachedInputTokens / cache.inputTokens : null } };
}

if (import.meta.main) {
  const [limitArg = "1000", requestId] = process.argv.slice(2);
  const limit = Number(limitArg);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Usage: bun scripts/side-chat-cache-report.ts [1..10000 recent rows] [request-id]");
  const rows = readRecentUsageEntries(limit);
  console.log(JSON.stringify(summarizeSideChatCache(requestId ? rows.filter(row => row.requestId === requestId) : rows), null, 2));
}
