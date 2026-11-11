/** One source selection for display and advisory usage; neither projection invents absent limits. */
import { asRecord, toFiniteNumber } from "../quota-wire";

type UsageWindow = "5h" | "weekly" | "fable" | "opus" | "sonnet";
export interface AnthropicUsageBucket {
  window: UsageWindow;
  row: Record<string, unknown>;
  percentField: "percent" | "utilization";
  /** Share of the weekly limit this scoped family may consume, from `weekly_scoped_shares`. */
  weeklyAllowancePercent?: number;
}
const legacyFields = { "5h": "five_hour", weekly: "seven_day", fable: "seven_day_fable",
  opus: "seven_day_opus", sonnet: "seven_day_sonnet" } as const;

/** Only these producer-proven model families may constrain routing. Unknown labels stay private. */
function scopedFamily(row: Record<string, unknown>): "fable" | "opus" | "sonnet" | undefined {
  const display = asRecord(asRecord(row.scope)?.model)?.display_name;
  if (typeof display !== "string") return undefined;
  const label = display.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").toLowerCase();
  return (["fable", "opus", "sonnet"] as const).find(family => label.includes(family));
}

/**
 * A family window's usage restated on the shared weekly scale.
 *
 * A scoped percent is relative to the family's own allowance: Fable at 60% of an allowance
 * that is 50% of the week has 20 weekly points left, not 40. Ranking that compares a family
 * request across accounts must use this figure alongside the shared weekly percent; a window
 * without a valid allowance keeps its own percent. 100 maps to 100, so exhaustion is unchanged.
 */
export function familyWeeklyEquivalentPercent(window: { percent?: number; weeklyAllowancePercent?: number }): number | undefined {
  const percent = window.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  const allowance = window.weeklyAllowancePercent;
  if (typeof allowance !== "number" || !Number.isFinite(allowance) || allowance <= 0 || allowance > 100) return percent;
  const used = Math.max(0, Math.min(100, percent));
  return percent >= 100 ? percent : 100 - allowance * (100 - used) / 100;
}

/**
 * `weekly_scoped_shares[]` names, by raw `limits` index, the share of the weekly limit a scoped
 * row may consume (Fable: "up to 50% of your weekly limit"). Only a recognized scoped row,
 * routed or display-only, receives it; a malformed, out-of-range or conflicting share is ignored.
 */
function applyWeeklyShares(body: Record<string, unknown>, scopedRows: Map<number, AnthropicUsageBucket>): void {
  if (!Array.isArray(body.weekly_scoped_shares)) return;
  const conflicted = new Set<AnthropicUsageBucket>();
  for (const raw of body.weekly_scoped_shares) {
    const share = asRecord(raw);
    const index = share?.limit_index;
    const allowance = toFiniteNumber(share?.allowance_percent_of_weekly);
    if (typeof index !== "number" || !Number.isInteger(index) || allowance === undefined || allowance <= 0 || allowance > 100) continue;
    const bucket = scopedRows.get(index);
    if (!bucket || conflicted.has(bucket)) continue;
    if (bucket.weeklyAllowancePercent !== undefined && bucket.weeklyAllowancePercent !== allowance) {
      delete bucket.weeklyAllowancePercent;
      conflicted.add(bucket);
      continue;
    }
    bucket.weeklyAllowancePercent = allowance;
  }
}

/**
 * Recognized rows supersede legacy duplicates even when skipped or malformed; duplicates
 * and malformed shared measurements make family enumeration incomplete. Shared finite
 * measurements apply regardless of the binding flag, though an unknown flag also makes
 * enumeration incomplete. A null legacy five_hour requires an explicitly active session.
 * Scoped rows retain active-only behavior for routing; an inactive scoped row is returned
 * separately as display-only evidence. Unknown kinds/families cannot clear refusals.
 */
export function anthropicUsageBuckets(body: Record<string, unknown>): {
  buckets: AnthropicUsageBucket[]; displayBuckets: AnthropicUsageBucket[]; familyEnumeration: boolean;
} {
  const selected = new Map<UsageWindow, AnthropicUsageBucket>();
  const displayOnly = new Map<UsageWindow, AnthropicUsageBucket>();
  const represented = new Set<UsageWindow>();
  const scopedRows = new Map<number, AnthropicUsageBucket>();
  const limits = Array.isArray(body.limits) ? body.limits : [];
  let familyEnumeration = Array.isArray(body.limits);
  for (const [index, raw] of limits.entries()) {
    const row = asRecord(raw);
    const window = row?.kind === "session" ? "5h" : row?.kind === "weekly_all" ? "weekly"
      : row?.kind === "weekly_scoped" ? scopedFamily(row) : undefined;
    if (!row || !window) { familyEnumeration = false; continue; }
    if (represented.has(window)) { familyEnumeration = false; continue; }
    represented.add(window);
    if (window === "5h" || window === "weekly") {
      const flag = row.is_active;
      if (flag !== undefined && typeof flag !== "boolean") familyEnumeration = false;
      if (toFiniteNumber(row.percent) === undefined) { familyEnumeration = false; continue; }
      if (window === "5h" && body.five_hour === null && flag !== true) continue;
      selected.set(window, { window, row, percentField: "percent" });
      continue;
    }
    if (row.is_active === false) {
      // Display-only rows still carry their share, so a dashboard can say "up to 50% of the week".
      const bucket: AnthropicUsageBucket = { window, row, percentField: "percent" };
      displayOnly.set(window, bucket);
      scopedRows.set(index, bucket);
      continue;
    }
    if (row.is_active !== undefined && row.is_active !== true) { familyEnumeration = false; continue; }
    if (toFiniteNumber(row.percent) === undefined) familyEnumeration = false;
    const bucket: AnthropicUsageBucket = { window, row, percentField: "percent" };
    selected.set(window, bucket);
    scopedRows.set(index, bucket);
  }
  applyWeeklyShares(body, scopedRows);
  for (const window of Object.keys(legacyFields) as UsageWindow[]) {
    if (represented.has(window)) continue;
    const row = asRecord(body[legacyFields[window]]);
    if (row) selected.set(window, { window, row, percentField: "utilization" });
  }
  // Stable canonical order, independent of how upstream orders limits.
  const ordered = (source: Map<UsageWindow, AnthropicUsageBucket>) => (Object.keys(legacyFields) as UsageWindow[])
    .flatMap(window => {
      const bucket = source.get(window);
      return bucket ? [bucket] : [];
    });
  return { buckets: ordered(selected), displayBuckets: ordered(displayOnly), familyEnumeration };
}
