/** Raw advisory projection; compatibility display clamping/rounding remains unchanged. */
import type { DecisionQuotaWindow } from "../quota-decision-snapshot";
import { normalizeResetAt, toFiniteNumber } from "../quota-wire";
import { anthropicUsageBuckets } from "./anthropic-usage-windows";
/** Normalize a reset value; an explicit invalid reset becomes NaN so it cannot read as an undated valid measurement. */
function reset(value: unknown): number | undefined {
  // Explicit invalid reset must not become an apparently undated valid measurement.
  return value === undefined || value === null ? undefined : normalizeResetAt(value) ?? NaN;
}
/** Extract raw decision windows (5h, weekly and per-model families) from an Anthropic usage body, keeping invalid resets distinct from display parsing. */
export function rawAnthropicUsageWindows(body: Record<string, unknown>, observedAt: number): DecisionQuotaWindow[] {
  const rows: DecisionQuotaWindow[] = [];
  for (const { window, row, percentField } of anthropicUsageBuckets(body).buckets) {
    const percent = toFiniteNumber(row[percentField]);
    if (percent === undefined) continue;
    const resetAt = reset(row.resets_at);
    rows.push({ window, percent, observedAt, ...(resetAt !== undefined ? { resetAt } : {}) });
  }
  return rows;
}
/** Extract decision windows from Anthropic unified rate-limit response headers, converting utilization fractions to percentages. */
export function rawAnthropicHeaderWindows(headers: Headers, observedAt: number): DecisionQuotaWindow[] {
  const rows: DecisionQuotaWindow[] = [];
  for (const [window, wire] of [["5h", "5h"], ["weekly", "7d"], ["fable", "7d_oi"]] as const) {
    const fraction = toFiniteNumber(headers.get(`anthropic-ratelimit-unified-${wire}-utilization`));
    if (fraction === undefined || fraction < 0 || fraction > 1) continue;
    const rawReset = headers.get(`anthropic-ratelimit-unified-${wire}-reset`);
    const seconds = toFiniteNumber(rawReset);
    const resetAt = rawReset === null ? undefined : seconds !== undefined && seconds > 0 ? seconds * 1000 : NaN;
    rows.push({ window, percent: fraction * 100, observedAt, ...(resetAt !== undefined ? { resetAt } : {}) });
  }
  return rows;
}
