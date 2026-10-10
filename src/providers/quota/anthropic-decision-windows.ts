/** Raw advisory projection; compatibility display clamping/rounding remains unchanged. */
import type { DecisionQuotaWindow } from "../quota-decision-snapshot";
import { normalizeResetAt, toFiniteNumber } from "../quota-wire";
/** Return a plain object value, or undefined for non-objects and arrays. */
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** Normalize a reset value; an explicit invalid reset becomes NaN so it cannot read as an undated valid measurement. */
function reset(value: unknown): number | undefined {
  // Explicit invalid reset must not become an apparently undated valid measurement.
  return value === undefined || value === null ? undefined : normalizeResetAt(value) ?? NaN;
}
/** Extract raw decision windows (5h, weekly and per-model families) from an Anthropic usage body, keeping invalid resets distinct from display parsing. */
export function rawAnthropicUsageWindows(body: Record<string, unknown>, observedAt: number): DecisionQuotaWindow[] {
  const rows: DecisionQuotaWindow[] = [];
  /** Append one window when its percentage is a finite number, carrying its normalized reset. */
  const add = (window: DecisionQuotaWindow["window"], raw: unknown, percentField: string) => {
    const row = record(raw);
    const percent = toFiniteNumber(row?.[percentField]);
    if (percent === undefined) return;
    const resetAt = reset(row?.resets_at);
    rows.push({ window, percent, observedAt, ...(resetAt !== undefined ? { resetAt } : {}) });
  };
  for (const [window, field] of [["5h", "five_hour"], ["weekly", "seven_day"], ["fable", "seven_day_fable"], ["opus", "seven_day_opus"], ["sonnet", "seven_day_sonnet"]] as const) add(window, body[field], "utilization");
  for (const limit of Array.isArray(body.limits) ? body.limits : []) {
    const row = record(limit);
    if (row?.kind !== "weekly_scoped") continue;
    const display = record(record(row.scope)?.model)?.display_name;
    if (typeof display !== "string") continue;
    const label = display.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").toLowerCase();
    const family = (["fable", "opus", "sonnet"] as const).find(family => label.includes(family));
    if (family) add(family, row, "percent");
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
