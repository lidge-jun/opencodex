/** Select one authoritative measurement per known Anthropic usage window. */
import { asRecord, toFiniteNumber } from "../quota-wire";

export type AnthropicUsageWindow = "5h" | "weekly" | "fable" | "opus" | "sonnet";
export interface AnthropicUsageMeasurement {
  window: AnthropicUsageWindow;
  percent: number;
  resetsAt: unknown;
}
const families = ["fable", "opus", "sonnet"] as const;

/** Publish only canonical labels; arbitrary upstream text never leaves this boundary. */
function familyOf(row: Record<string, unknown>): typeof families[number] | undefined {
  const display = asRecord(asRecord(row.scope)?.model)?.display_name;
  if (typeof display !== "string") return undefined;
  const label = display.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").toLowerCase();
  return families.find(family => label.includes(family));
}

/** Limits win over legacy duplicates. Explicitly inactive/unknown scoped flags never gate. */
export function selectAnthropicUsageWindows(body: Record<string, unknown>): {
  windows: AnthropicUsageMeasurement[];
  enumeratedFamilies: boolean;
} {
  const selected = new Map<AnthropicUsageWindow, AnthropicUsageMeasurement>();
  const scoped = new Set<AnthropicUsageWindow>();
  const limits = Array.isArray(body.limits) ? body.limits : [];
  let enumeratedFamilies = Array.isArray(body.limits);
  const add = (window: AnthropicUsageWindow, row: Record<string, unknown>, value: unknown) => {
    const percent = toFiniteNumber(value);
    if (percent !== undefined && !selected.has(window)) selected.set(window, { window, percent, resetsAt: row.resets_at });
    return percent !== undefined;
  };
  for (const raw of limits) {
    const row = asRecord(raw);
    if (!row) { enumeratedFamilies = false; continue; }
    if (row.kind === "weekly_all") add("weekly", row, row.percent);
    else if (row.kind === "session") {
      // A null session explicitly means this subscription has no five-hour limit.
      if (body.five_hour !== null && row.is_active !== false) add("5h", row, row.percent);
    } else if (row.kind === "weekly_scoped") {
      const family = familyOf(row);
      if (!family) { enumeratedFamilies = false; continue; }
      // Even an inactive modern row supersedes its legacy duplicate.
      scoped.add(family);
      if (row.is_active === true) {
        if (!add(family, row, row.percent)) enumeratedFamilies = false;
      } else if (row.is_active !== false) enumeratedFamilies = false;
    } else enumeratedFamilies = false;
  }
  for (const [window, field] of [["5h", "five_hour"], ["weekly", "seven_day"],
    ["fable", "seven_day_fable"], ["opus", "seven_day_opus"], ["sonnet", "seven_day_sonnet"]] as const) {
    if (scoped.has(window)) continue;
    const legacy = asRecord(body[field]);
    if (legacy) add(window, legacy, legacy.utilization);
  }
  // Stable shared-then-family order for display and decision consumers alike.
  return { windows: (["5h", "weekly", ...families] as const).flatMap(window => {
    const row = selected.get(window);
    return row ? [row] : [];
  }), enumeratedFamilies };
}

// A fresh explicit null is stronger than an unknown/missing counter. Keep this proof
// private and attached to the exact parsed object, never infer it from cached absence.
const noFiveHourLimit = new WeakSet<object>();
export function markAnthropicNoFiveHourLimit<T extends object>(quota: T, absent: boolean): T {
  if (absent) noFiveHourLimit.add(quota);
  return quota;
}
export function hasAnthropicNoFiveHourLimit(quota: object): boolean { return noFiveHourLimit.has(quota); }
