/** Advisory fresh-observation detector. No persistence, timers, or merged quota reads. */
export const EXTERNAL_USAGE_QUIET_MS = 30 * 60_000;
export const EXTERNAL_USAGE_TTL_MS = 6 * 60 * 60_000;
export type FreshWindow = { kind: "short" | "long"; percent: number; resetAtMs: number };
export type MainAccountExternalUsageWarning = {
  window: "short" | "long";
  fromPercent: number;
  toPercent: number;
  observedAt: number;
};
type Reading = { percent: number; resetAtMs: number; observedAt: number;
  warning?: MainAccountExternalUsageWarning };
let baseline: { identityKey: string; perWindow: Partial<Record<FreshWindow["kind"], Reading>> } | undefined;
let lastActivity = -Infinity;

export function noteMainAccountActivity(now = Date.now()): void {
  lastActivity = now;
}

/** Only validated usage with a known reset from this observation reaches the baseline. */
export function observeMainAccountUsage(identityKey: string, windows: FreshWindow[], now = Date.now()): void {
  if (baseline?.identityKey !== identityKey) baseline = { identityKey, perWindow: {} };
  for (const window of windows) {
    if (!Number.isFinite(window.percent) || window.percent < 0 || window.percent > 100
      || !Number.isFinite(window.resetAtMs) || window.resetAtMs <= 0) continue;
    const previous = baseline.perWindow[window.kind];
    const sameEpisode = previous?.resetAtMs === window.resetAtMs;
    let warning = sameEpisode ? previous?.warning : undefined;
    if (sameEpisode && previous && window.percent - previous.percent >= 1
      && lastActivity < previous.observedAt - EXTERNAL_USAGE_QUIET_MS) {
      warning = { window: window.kind, fromPercent: previous.percent,
        toPercent: window.percent, observedAt: now };
    }
    baseline.perWindow[window.kind] = { percent: window.percent, resetAtMs: window.resetAtMs,
      observedAt: now, ...(warning ? { warning } : {}) };
  }
}

export function forgetMainAccountUsage(): void {
  baseline = undefined;
}

export function getMainAccountExternalUsageWarning(
  identityKey: string | undefined, now = Date.now(),
): MainAccountExternalUsageWarning | undefined {
  if (!identityKey || baseline?.identityKey !== identityKey) return undefined;
  for (const kind of ["short", "long"] as const) {
    const reading = baseline.perWindow[kind];
    if (!reading?.warning) continue;
    if (now >= reading.resetAtMs || now - reading.warning.observedAt >= EXTERNAL_USAGE_TTL_MS) {
      delete reading.warning;
      continue;
    }
    return { ...reading.warning };
  }
  return undefined;
}

export function resetMainAccountExternalUsageForTests(): void {
  forgetMainAccountUsage();
  lastActivity = -Infinity;
}
