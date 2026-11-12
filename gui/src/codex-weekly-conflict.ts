import type { TFn } from "./i18n/shared";
import { parseWeeklyWindowConflicts, type WeeklyWindowObservation } from "../../src/codex/quota-window-conflict";

/**
 * Dashboard sentence for a Codex pool account whose weekly reading flips between two live
 * seven-day windows (#8574). Each window shows its usage, reset, source and when it was last seen,
 * so the reset in the bar above is not read as a guaranteed restoration of the full allowance.
 */
export function weeklyWindowConflictText(value: unknown, t: TFn, locale: string): string | undefined {
  const conflict = parseWeeklyWindowConflicts(value)?.[0];
  if (!conflict) return undefined;
  const at = (ms: number) => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  const window = (observation: WeeklyWindowObservation) =>
    `${Math.round(observation.usedPercent)}% → ${at(observation.resetAtMs)} (${observation.source}, ${at(observation.observedAt)})`;
  return t("codexAuth.weeklyConflict", { first: window(conflict.windows[0]), second: window(conflict.windows[1]) });
}
