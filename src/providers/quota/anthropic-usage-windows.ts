/** One source selection for display and advisory usage; neither projection invents absent limits. */
import { asRecord, toFiniteNumber } from "../quota-wire";

type UsageWindow = "5h" | "weekly" | "fable" | "opus" | "sonnet";
export interface AnthropicUsageBucket {
  window: UsageWindow;
  row: Record<string, unknown>;
  percentField: "percent" | "utilization";
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
 * A limits entry supersedes its legacy duplicate even when inactive or unusable.
 * Missing is_active preserves the older limits contract; an unknown flag is not active.
 * Unknown kinds/families leave usable shared windows intact but cannot clear family refusals.
 */
export function anthropicUsageBuckets(body: Record<string, unknown>): {
  buckets: AnthropicUsageBucket[]; familyEnumeration: boolean;
} {
  const selected = new Map<UsageWindow, AnthropicUsageBucket>();
  const represented = new Set<UsageWindow>();
  const limits = Array.isArray(body.limits) ? body.limits : [];
  let familyEnumeration = Array.isArray(body.limits);
  for (const raw of limits) {
    const row = asRecord(raw);
    const window = row?.kind === "session" ? "5h" : row?.kind === "weekly_all" ? "weekly"
      : row?.kind === "weekly_scoped" ? scopedFamily(row) : undefined;
    if (!row || !window) { familyEnumeration = false; continue; }
    if (represented.has(window)) { familyEnumeration = false; continue; }
    represented.add(window);
    if (row.is_active === false) continue;
    if (row.is_active !== undefined && row.is_active !== true) { familyEnumeration = false; continue; }
    if (toFiniteNumber(row.percent) === undefined) familyEnumeration = false;
    selected.set(window, { window, row, percentField: "percent" });
  }
  for (const window of Object.keys(legacyFields) as UsageWindow[]) {
    if (represented.has(window)) continue;
    const row = asRecord(body[legacyFields[window]]);
    if (row) selected.set(window, { window, row, percentField: "utilization" });
  }
  // Stable canonical order, independent of how upstream orders limits.
  return { buckets: (Object.keys(legacyFields) as UsageWindow[]).flatMap(window => {
    const bucket = selected.get(window);
    return bucket ? [bucket] : [];
  }), familyEnumeration };
}
