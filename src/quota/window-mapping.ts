/**
 * Provider- and Codex-specific quota shapes mapped to the detector's neutral window list.
 *
 * Separate from the detector so the detector stays free of any dependency on either quota
 * subsystem's types, and separate from the observer so the seams can build observations
 * without loading the sink registry.
 */

import type { QuotaWindowObservation } from "./reset-detector";

type CodexLikeQuota = {
  shortPercent?: number;
  shortResetAt?: number;
  shortWindowSeconds?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  monthlyPercent?: number;
  monthlyResetAt?: number;
  customWindows?: ReadonlyArray<{ label: string; percent: number; resetAt?: number }>;
};

type ProviderLikeQuota = {
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  monthlyPercent?: number;
  monthlyResetAt?: number;
  customWindows?: ReadonlyArray<{ label: string; percent: number; resetAt?: number }>;
};

function window(
  label: string,
  percent: number | undefined,
  resetAt: number | undefined,
  windowSeconds?: number,
): QuotaWindowObservation | null {
  // A window with neither a percent nor a clock carries no information. Emitting it would
  // only create a baseline that can never produce a transition.
  if (percent === undefined && resetAt === undefined) return null;
  return {
    window: label,
    ...(percent !== undefined ? { percent } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(typeof windowSeconds === "number" && Number.isFinite(windowSeconds) && windowSeconds > 0
      ? { windowSeconds }
      : {}),
  };
}

/**
 * Nominal lengths for the fixed labels, in seconds.
 *
 * The detector uses a window length only to bound how much of a percent drop natural decay
 * can explain in a ROLLING window. Upstream states a length for the short window
 * (shortWindowSeconds) but not for the others, so these supply it. Weekly and monthly are
 * calendar-anchored rather than rolling on every provider observed so far, but stating a
 * length is still the conservative choice: it can only suppress a drop that is small relative
 * to the elapsed share of a WEEK, which no genuine reset is.
 */
const NOMINAL_WINDOW_SECONDS: Readonly<Record<string, number>> = {
  "5h": 5 * 3600,
  weekly: 7 * 24 * 3600,
  monthly: 30 * 24 * 3600,
};

function customWindows(
  entries: ReadonlyArray<{ label: string; percent: number; resetAt?: number }> | undefined,
): QuotaWindowObservation[] {
  if (!entries) return [];
  const out: QuotaWindowObservation[] = [];
  for (const entry of entries) {
    if (typeof entry?.label !== "string") continue;
    const mapped = window(`custom:${entry.label}`, entry.percent, entry.resetAt);
    if (mapped) out.push(mapped);
  }
  return out;
}

/** Windows absent from the snapshot are omitted, never zero-filled: absence is not 0%. */
export function codexWindowObservations(quota: CodexLikeQuota): QuotaWindowObservation[] {
  const out: QuotaWindowObservation[] = [];
  for (const mapped of [
    // Prefer the length upstream states for the short window; fall back to the nominal 5h.
    window("5h", quota.shortPercent, quota.shortResetAt, quota.shortWindowSeconds ?? NOMINAL_WINDOW_SECONDS["5h"]),
    window("weekly", quota.weeklyPercent, quota.weeklyResetAt, NOMINAL_WINDOW_SECONDS["weekly"]),
    window("monthly", quota.monthlyPercent, quota.monthlyResetAt, NOMINAL_WINDOW_SECONDS["monthly"]),
  ]) {
    if (mapped) out.push(mapped);
  }
  out.push(...customWindows(quota.customWindows));
  return out;
}

export function providerWindowObservations(quota: ProviderLikeQuota): QuotaWindowObservation[] {
  const out: QuotaWindowObservation[] = [];
  for (const mapped of [
    window("5h", quota.fiveHourPercent, quota.fiveHourResetAt, NOMINAL_WINDOW_SECONDS["5h"]),
    window("weekly", quota.weeklyPercent, quota.weeklyResetAt, NOMINAL_WINDOW_SECONDS["weekly"]),
    window("monthly", quota.monthlyPercent, quota.monthlyResetAt, NOMINAL_WINDOW_SECONDS["monthly"]),
  ]) {
    if (mapped) out.push(mapped);
  }
  out.push(...customWindows(quota.customWindows));
  return out;
}
