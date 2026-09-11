export const SIDE_CHAT_CACHE_REASONS = [
  "ineligible", "incompatible-prefix", "missing-parent", "account-or-header-change", "settings-change",
  "multiple-rule-blocks", "instructions-change", "ambiguous-boundary", "empty-inherited-prefix",
  "input-prefix-change", "inherited-with-tail-rules", "inherited-with-developer-boundary",
  "inherited-exact-prefix", "parent-observed", "error",
] as const;

export interface SideChatCacheMetrics {
  reason: typeof SIDE_CHAT_CACHE_REASONS[number];
  phase: "unknown" | "parent" | "unbound-side" | "bound-side";
  snapshotOutcome: "not-observed" | "ineligible" | "stored" | "expired" | "superseded" | "disabled" | "error";
  prepareMs: number;
  observedAt?: number;
  completionMs?: number;
  normalizeMs?: number;
  hashMs?: number;
  matchMs?: number;
  inputItems: number;
  matchedItems: number;
  parentCandidates: number;
  retainedSnapshots: number;
  retainedBindings: number;
  estimatedRetainedBytes: number;
  expiredEntries: number;
  evictedEntries: number;
  threadIdHash?: string;
}

export function normalizeSideChatCacheMetrics(value: unknown): SideChatCacheMetrics | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (!SIDE_CHAT_CACHE_REASONS.includes(row.reason as SideChatCacheMetrics["reason"])
      || !["unknown", "parent", "unbound-side", "bound-side"].includes(row.phase as string)
      || !["not-observed", "ineligible", "stored", "expired", "superseded", "disabled", "error"].includes(row.snapshotOutcome as string)) return undefined;
    const result = { reason: row.reason, phase: row.phase, snapshotOutcome: row.snapshotOutcome } as SideChatCacheMetrics;
    for (const key of ["inputItems", "matchedItems", "parentCandidates", "retainedSnapshots", "retainedBindings", "estimatedRetainedBytes", "expiredEntries", "evictedEntries"] as const) {
      const count = row[key];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
      result[key] = count;
    }
    for (const key of ["prepareMs", "completionMs", "normalizeMs", "hashMs", "matchMs"] as const) {
      const duration = row[key];
      if (key !== "prepareMs" && duration === undefined) continue;
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 3_600_000) return undefined;
      result[key] = duration;
    }
    if (row.observedAt !== undefined) {
      if (typeof row.observedAt !== "number" || !Number.isFinite(row.observedAt) || row.observedAt < 0 || row.observedAt > 8_640_000_000_000_000) return undefined;
      result.observedAt = row.observedAt;
    }
    if (row.threadIdHash !== undefined) {
      if (typeof row.threadIdHash !== "string" || !/^[a-f0-9]{32}$/.test(row.threadIdHash)) return undefined;
      result.threadIdHash = row.threadIdHash;
    }
    return result;
  } catch { return undefined; }
}

export function sideChatCacheLogFields(value: unknown): { sideChatCache?: SideChatCacheMetrics } {
  const metrics = normalizeSideChatCacheMetrics(value);
  return metrics ? { sideChatCache: metrics } : {};
}
