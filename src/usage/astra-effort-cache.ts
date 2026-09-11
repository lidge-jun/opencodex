export const ASTRA_EFFORT_CACHE_STATUSES = [
  "unsupported_input", "client_managed", "unsupported_model", "unsupported_effort", "unsupported_mode",
  "multi_agent", "automatic_context_management", "compaction", "missing_thread_identity", "missing_serving_identity",
  "state_limit", "invalid_state", "unavailable_state", "ambiguous_history", "conflicting_retry",
  "missing_user_boundary", "baseline_reset", "replay", "updated",
] as const;

export interface AstraEffortCacheMetrics {
  status: typeof ASTRA_EFFORT_CACHE_STATUSES[number];
  stateOutcome: "skipped" | "committed" | "busy" | "error";
  durationMs: number;
  setupMs?: number;
  transactionMs?: number;
  historyMs?: number;
  closeMs?: number;
  inputItems: number;
  updateCount: number;
}

export interface AstraEffortStoreMeasurement {
  outcome: AstraEffortCacheMetrics["stateOutcome"];
  setupMs?: number;
  transactionMs?: number;
  closeMs?: number;
}

function normalizeMetrics(value: unknown): AstraEffortCacheMetrics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const duration = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 3_600_000;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!ASTRA_EFFORT_CACHE_STATUSES.includes(row.status as AstraEffortCacheMetrics["status"])
    || typeof row.stateOutcome !== "string" || !["skipped", "committed", "busy", "error"].includes(row.stateOutcome)
    || !duration(row.durationMs) || !count(row.inputItems) || !count(row.updateCount)) return undefined;
  const metrics: AstraEffortCacheMetrics = {
    status: row.status as AstraEffortCacheMetrics["status"], stateOutcome: row.stateOutcome as AstraEffortCacheMetrics["stateOutcome"],
    durationMs: row.durationMs, inputItems: row.inputItems, updateCount: row.updateCount,
  };
  for (const key of ["setupMs", "transactionMs", "historyMs", "closeMs"] as const) {
    if (row[key] !== undefined) {
      if (!duration(row[key])) return undefined;
      metrics[key] = row[key];
    }
  }
  return metrics;
}

export function normalizeAstraEffortCacheMetrics(value: unknown): AstraEffortCacheMetrics | undefined {
  try { return normalizeMetrics(value); } catch { return undefined; }
}
