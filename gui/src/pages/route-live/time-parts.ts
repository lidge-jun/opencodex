/**
 * "Where the time went" for one request, from measured fields only.
 *
 * The stages and the idea of dropping sub-0.1 ms parts follow Magpie's `timeParts`
 * (internal/gui/assets/plugins/routing/client.js), MIT, Copyright (c) 2026 yetone.
 * Bun's fetch exposes no DNS/connect/TLS timing, so those stages do not exist here.
 *
 *   privacy      privacyRedactionMs
 *   internal     time before the final attempt started, minus privacy and earlier attempts
 *   earlier      sum of every attempt's duration except the final one
 *   upstreamWait final attempt's firstOutputMs (attempt-relative)
 *   streaming    the rest of the request
 *   reading      replaces upstreamWait + streaming when no first output was seen
 */
import type { RouteRow } from "./route-rows";

export type TimePartKind = "privacy" | "internal" | "earlier" | "upstreamWait" | "streaming" | "reading";

export interface TimePart {
  kind: TimePartKind;
  ms: number;
}

export type TimeRow = Pick<RouteRow, "durationMs" | "firstOutputMs" | "attempts" | "upstreamSendMs" | "privacyRedactionMs">;

export const MIN_PART_MS = 0.1;

/** A measured, non-negative duration, or undefined. */
function measured(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function timeParts(row: TimeRow): TimePart[] | null {
  const total = measured(row.durationMs);
  if (total === undefined) return null;
  const attempts = row.attempts ?? [];
  const final = attempts.at(-1);
  const finalDuration = measured(final?.durationMs);

  const sendMs = measured(row.upstreamSendMs) ?? (finalDuration !== undefined ? Math.max(0, total - finalDuration) : undefined);
  if (sendMs === undefined) return null;

  const privacy = measured(row.privacyRedactionMs) ?? 0;
  const earlier = attempts.slice(0, -1).reduce((sum, attempt) => sum + (measured(attempt.durationMs) ?? 0), 0);
  const internal = Math.max(0, sendMs - earlier - privacy);

  const attemptFirst = measured(final?.firstOutputMs);
  const requestFirst = measured(row.firstOutputMs);
  const wait = attemptFirst ?? (requestFirst !== undefined ? Math.max(0, requestFirst - sendMs) : undefined);

  const parts: TimePart[] = [
    { kind: "privacy", ms: privacy },
    { kind: "internal", ms: internal },
    { kind: "earlier", ms: earlier },
    ...(wait === undefined
      ? [{ kind: "reading", ms: Math.max(0, total - sendMs) } satisfies TimePart]
      : [
        { kind: "upstreamWait", ms: wait } satisfies TimePart,
        { kind: "streaming", ms: Math.max(0, total - sendMs - wait) } satisfies TimePart,
      ]),
  ];
  const shown = parts.filter(part => part.ms >= MIN_PART_MS);
  return shown.length > 0 ? shown : null;
}
