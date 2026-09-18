import type { QuotaHistorySample, QuotaHistoryWindow } from "./quota-history";
import type { PersistedUsageAttempt, PersistedUsageEntry } from "../usage/log";

export const CAPACITY_ASSUMPTIONS = [
  "Quota percentages can be rounded or delayed.",
  "Only retained valid proxy usage rows are observed; external usage is unknown.",
  "Account log labels are assumed stable within each observation interval.",
  "This low-confidence effective-token estimate is not a provider token limit or lower bound.",
] as const;
export const CAPACITY_REASONS = ["insufficient_intervals", "ledger_unavailable", "ledger_truncated", "identity_unavailable", "identity_changed", "ambiguous_usage"] as const;
export type CapacityReason = typeof CAPACITY_REASONS[number];
export function parseCapacityReason(value: unknown): CapacityReason | undefined {
  return CAPACITY_REASONS.find(reason => reason === value);
}
export interface CodexCapacityResult {
  status: "estimated" | "insufficient-evidence";
  estimates: Array<{ window: QuotaHistoryWindow["window"]; estimatedTokens: number; sampleCount: number; confidence: "low" }>;
  reason?: CapacityReason;
  assumptions: readonly string[];
}
export function insufficientCodexCapacity(reason: CapacityReason): CodexCapacityResult {
  return { status: "insufficient-evidence", estimates: [], reason, assumptions: [...CAPACITY_ASSUMPTIONS] };
}
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function reportedTokens(attempt: PersistedUsageAttempt): number | undefined {
  if (attempt.sendCount !== 1 || attempt.usageStatus !== "reported" || attempt.locallyAnswered === true
    || !attempt.usage || attempt.usage.estimated === true
    || !nonnegative(attempt.usage.inputTokens) || !nonnegative(attempt.usage.outputTokens)) return undefined;
  const total = attempt.usage.totalTokens ?? attempt.usage.inputTokens + attempt.usage.outputTokens;
  return nonnegative(total) ? total : undefined;
}

/** Informational inference over raw same-window observations, never an account-selection input. */
export function estimateCodexQuotaCapacity(
  observations: ReadonlyArray<Omit<QuotaHistorySample, "credentialGeneration">>,
  entries: readonly PersistedUsageEntry[],
  label: string,
  sharedQuotaModel: (model: string) => boolean,
): CodexCapacityResult {
  if (entries.length > 10_000) return insufficientCodexCapacity("ledger_truncated");
  const requests = new Map<string, PersistedUsageEntry>();
  for (const entry of entries) {
    const previous = requests.get(entry.requestId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) return insufficientCodexCapacity("ambiguous_usage");
    requests.set(entry.requestId, entry);
  }
  const sorted = [...observations].sort((a, b) => a.observedAt - b.observedAt);
  const estimates: CodexCapacityResult["estimates"] = [];
  for (const windowName of ["short", "weekly", "monthly"] as const) {
    const points = sorted.flatMap(row => {
      const window = row.windows.find(candidate => candidate.family === "account" && candidate.window === windowName);
      return window ? [{ ...window, at: row.observedAt, source: row.source }] : [];
    });
    const samples: number[] = [];
    for (let index = 1; index < points.length; index++) {
      const left = points[index - 1], right = points[index];
      const delta = right.usedPercent - left.usedPercent;
      if (left.source !== right.source || !nonnegative(left.resetAtMs) || left.resetAtMs !== right.resetAtMs
        || left.resetAtMs <= right.at || left.windowSeconds !== right.windowSeconds
        || left.monthlyIsPrimaryWindow !== right.monthlyIsPrimaryWindow
        || right.at <= left.at || delta < 1 || delta > 100 || !Number.isFinite(delta)) continue;
      let tokens = 0;
      let valid = true;
      for (const entry of requests.values()) {
        if (!nonnegative(entry.timestamp) || !nonnegative(entry.durationMs)) continue;
        const end = entry.timestamp + entry.durationMs;
        if (!Number.isFinite(end) || entry.timestamp <= left.at || end > right.at) continue;
        // Untimed or absent physical-attempt evidence cannot be reconstructed from parent totals.
        if (!entry.attempts?.length) continue;
        const attempts = new Map<number, PersistedUsageAttempt>();
        for (const attempt of entry.attempts) {
          const prior = attempts.get(attempt.ordinal);
          if (prior && JSON.stringify(prior) !== JSON.stringify(attempt)) { valid = false; break; }
          attempts.set(attempt.ordinal, attempt);
        }
        if (!valid) break;
        for (const attempt of attempts.values()) {
          if (attempt.accountLogLabel !== label || attempt.adapter !== "openai-responses" || !sharedQuotaModel(attempt.model)) continue;
          const reported = reportedTokens(attempt);
          if (reported === undefined) continue;
          tokens += reported;
        }
      }
      const inferred = tokens * 100 / delta;
      if (valid && tokens > 0 && Number.isFinite(inferred) && inferred > 0) samples.push(inferred);
    }
    if (samples.length) {
      samples.sort((a, b) => a - b);
      const middle = Math.floor(samples.length / 2);
      const median = samples.length % 2 ? samples[middle] : samples[middle - 1] / 2 + samples[middle] / 2;
      const estimatedTokens = Math.round(median);
      if (estimatedTokens > 0) estimates.push({ window: windowName, estimatedTokens, sampleCount: samples.length, confidence: "low" });
    }
  }
  return estimates.length ? { status: "estimated", estimates, assumptions: [...CAPACITY_ASSUMPTIONS] }
    : insufficientCodexCapacity("insufficient_intervals");
}
