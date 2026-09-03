/**
 * Meta's subscription-usage SSE frame.
 *
 * Meta publishes no quota endpoint — 17 plausible REST paths were probed and every one
 * 404s, and no `x-ratelimit-*` header appears on any of three measured request shapes
 * (devlog/_plan/260903_muse_spark_plan_oauth/003 §E). The only machine-readable usage
 * Meta emits arrives mid-stream, as one extra event alongside the ordinary
 * `response.*` sequence on a streaming `POST /v1/responses`.
 *
 * That inverts the usual seam: this module is fed by the request path, not by a probe,
 * and nothing can refresh its output on demand — obtaining a newer value would mean
 * spending a real inference turn.
 *
 * Measured payload (2026-09-03):
 *
 * ```json
 * { "type": "response.subscription_usage",
 *   "subscription": {
 *     "tier": "27681393394859588",
 *     "window": { "used_percent": 0, "resets_at": 1788431188, "window_duration_mins": 300 },
 *     "weekly": { "used_percent": 0, "resets_at": 1788739200 } } }
 * ```
 */
import { asRecord, normalizePercent, normalizeResetAt, toFiniteNumber } from "./quota-wire";
import type { ProviderQuota, ProviderQuotaWindow } from "./quota-types";

/** The SSE frame type Meta emits on streaming turns. */
export const MUSE_SUBSCRIPTION_USAGE_TYPE = "response.subscription_usage";

/** Meta's five-hour window, identified by its declared duration rather than assumed. */
const FIVE_HOUR_WINDOW_MINS = 300;

/** True when a parsed SSE payload is the subscription-usage frame. */
export function isMuseSubscriptionUsagePayload(payload: unknown): boolean {
  return asRecord(payload)?.type === MUSE_SUBSCRIPTION_USAGE_TYPE;
}

/**
 * Translate the frame into a `ProviderQuota`.
 *
 * Returns null — never throws — for anything unrecognizable. This runs inside SSE
 * inspection on a live request, where the only acceptable failure is silence: a parse
 * error must not cost the user their turn.
 *
 * `subscription.tier` is deliberately dropped. It is an opaque numeric id, not the plan
 * label the Muse CLI prints, so surfacing it would show a meaningless number.
 */
export function parseMuseSubscriptionUsage(payload: unknown): ProviderQuota | null {
  const subscription = asRecord(asRecord(payload)?.subscription);
  if (!subscription) return null;

  const quota: ProviderQuota = { updatedAt: Date.now() };
  let sawWindow = false;

  const window = asRecord(subscription.window);
  if (window) {
    const percent = normalizePercent(window.used_percent);
    const resetAt = normalizeResetAt(window.resets_at);
    const durationMins = toFiniteNumber(window.window_duration_mins);
    if (percent !== undefined) {
      if (durationMins === FIVE_HOUR_WINDOW_MINS) {
        quota.fiveHourPercent = percent;
        if (resetAt !== undefined) quota.fiveHourResetAt = resetAt;
        sawWindow = true;
      } else {
        // A window of some other length is NOT forced into the five-hour slot: filing a
        // ten-hour window there would understate usage by the ratio of the two windows,
        // and would do so with full confidence. Carry it with its real duration instead.
        const custom: ProviderQuotaWindow = {
          label: durationMins === undefined ? "subscription" : `${durationMins}m`,
          percent,
          ...(resetAt !== undefined ? { resetAt } : {}),
        };
        quota.customWindows = [...(quota.customWindows ?? []), custom];
        sawWindow = true;
      }
    }
  }

  const weekly = asRecord(subscription.weekly);
  if (weekly) {
    const percent = normalizePercent(weekly.used_percent);
    if (percent !== undefined) {
      quota.weeklyPercent = percent;
      const resetAt = normalizeResetAt(weekly.resets_at);
      if (resetAt !== undefined) quota.weeklyResetAt = resetAt;
      sawWindow = true;
    }
  }

  // Either window may be absent independently, but a payload carrying neither says
  // nothing — returning a bare `updatedAt` would publish an empty row that the GUI
  // would render as a quota with no bars.
  return sawWindow ? quota : null;
}
