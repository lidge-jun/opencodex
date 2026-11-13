import type { QuotaHistorySample, ReadonlyQuotaHistorySample } from "./quota-history";

/**
 * Conflicting weekly quota windows for one Codex pool account (#8574).
 *
 * The same credential generation can report two different seven-day windows at once, from
 * `wham` and from response headers alike, and the stored reading simply follows whichever came
 * last. Nothing in the data says which window is right, so this never picks one and never feeds
 * admission, routing or credit consent: it only names the disagreement so a reader is not told
 * an earlier reset will restore the full allowance.
 *
 * Two reset times belong to one window when they are within RESET_TOLERANCE_MS of each other.
 * Windows A (earlier reset) and B (later reset) conflict while A's reset is still ahead and A was
 * observed again after B was first observed. A true rollover (A, A's reset passes, then B) and an
 * early reset (A, then only B) never repeat A after B, so neither is a conflict.
 *
 * One stray observation is enough: a single B between two A readings keeps the warning up until
 * A's reset passes. That is deliberate, since the stored reading may have followed that stray
 * one, and the warning only says the two disagree.
 */
export const RESET_TOLERANCE_MS = 60 * 60_000;

/** The largest epoch-ms JavaScript Date can hold; beyond it date formatting throws (8.64e15). */
const MAX_DATE_MS = 8.64e15;

export interface WeeklyWindowObservation {
  resetAtMs: number;
  usedPercent: number;
  source: QuotaHistorySample["source"];
  observedAt: number;
}

export interface WeeklyWindowConflict {
  family: "account" | "spark";
  /** The earlier-reset window first; each entry is that window's most recent observation. */
  windows: [WeeklyWindowObservation, WeeklyWindowObservation];
}

interface Cluster { resetAtMs: number; firstObservedAt: number; latest: WeeklyWindowObservation }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
/** A time a dashboard can format: a nanosecond-style epoch would make Intl.DateTimeFormat throw. */
const dateTime = (value: unknown): value is number => nonNegative(value) && value <= MAX_DATE_MS;

function parseObservation(value: unknown): WeeklyWindowObservation | undefined {
  if (!record(value) || !dateTime(value.resetAtMs) || !dateTime(value.observedAt)
    || !nonNegative(value.usedPercent) || value.usedPercent > 100
    || (value.source !== "wham" && value.source !== "response-header")) return undefined;
  return { resetAtMs: value.resetAtMs, usedPercent: value.usedPercent, source: value.source, observedAt: value.observedAt };
}

/** Conflicts read back from a management response; anything malformed is dropped, never fatal. */
export function parseWeeklyWindowConflicts(value: unknown): WeeklyWindowConflict[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.slice(0, 2).flatMap(item => {
    if (!record(item) || (item.family !== "account" && item.family !== "spark") || !Array.isArray(item.windows) || item.windows.length !== 2) return [];
    const first = parseObservation(item.windows[0]);
    const second = parseObservation(item.windows[1]);
    return first && second ? [{ family: item.family as WeeklyWindowConflict["family"], windows: [first, second] as [WeeklyWindowObservation, WeeklyWindowObservation] }] : [];
  });
  return parsed.length > 0 ? parsed : undefined;
}

export function detectWeeklyWindowConflicts(
  samples: readonly ReadonlyQuotaHistorySample[],
  credentialGeneration: number | undefined,
  now: number,
): WeeklyWindowConflict[] {
  if (credentialGeneration === undefined) return [];
  const conflicts: WeeklyWindowConflict[] = [];
  for (const family of ["account", "spark"] as const) {
    const observations = samples
      .filter(sample => sample.credentialGeneration === credentialGeneration && sample.observedAt <= now && dateTime(sample.observedAt))
      .flatMap(sample => sample.windows
        .filter(window => window.family === family && window.window === "weekly" && dateTime(window.resetAtMs))
        .map(window => ({ resetAtMs: window.resetAtMs!, usedPercent: window.usedPercent, source: sample.source, observedAt: sample.observedAt })))
      .sort((a, b) => a.observedAt - b.observedAt);
    // Cluster by reset time; a window's reported reset moves by seconds, two windows by days.
    const clusters: Cluster[] = [];
    for (const observation of [...observations].sort((a, b) => a.resetAtMs - b.resetAtMs)) {
      const last = clusters.at(-1);
      if (last && observation.resetAtMs - last.resetAtMs <= RESET_TOLERANCE_MS) {
        last.firstObservedAt = Math.min(last.firstObservedAt, observation.observedAt);
        if (observation.observedAt >= last.latest.observedAt) last.latest = observation;
      } else {
        clusters.push({ resetAtMs: observation.resetAtMs, firstObservedAt: observation.observedAt, latest: observation });
      }
    }
    const pending = clusters.filter(cluster => cluster.latest.resetAtMs > now);
    let found: WeeklyWindowConflict | undefined;
    for (let a = 0; a < pending.length && !found; a++) {
      for (let b = pending.length - 1; b > a && !found; b--) {
        // A reappeared after B had already been reported: the account flips between the two.
        if (pending[a]!.latest.observedAt > pending[b]!.firstObservedAt) {
          found = { family, windows: [{ ...pending[a]!.latest }, { ...pending[b]!.latest }] };
        }
      }
    }
    if (found) conflicts.push(found);
  }
  return conflicts;
}
