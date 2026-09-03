import { describe, expect, test } from "bun:test";
import {
  isMuseSubscriptionUsagePayload,
  MUSE_SUBSCRIPTION_USAGE_TYPE,
  parseMuseSubscriptionUsage,
} from "../src/providers/muse-subscription-usage";

/** The payload measured against the live endpoint on 2026-09-03 (003 §E). */
function measuredPayload(): unknown {
  return {
    type: MUSE_SUBSCRIPTION_USAGE_TYPE,
    subscription: {
      tier: "27681393394859588",
      window: { used_percent: 12, resets_at: 1788431188, window_duration_mins: 300 },
      weekly: { used_percent: 34, resets_at: 1788739200 },
    },
  };
}

describe("Muse subscription usage parser", () => {
  test("maps the measured payload to both windows", () => {
    const quota = parseMuseSubscriptionUsage(measuredPayload());
    expect(quota).not.toBeNull();
    expect(quota!.fiveHourPercent).toBe(12);
    expect(quota!.weeklyPercent).toBe(34);
    // Meta sends unix SECONDS; epochMillis scales them.
    expect(quota!.fiveHourResetAt).toBe(1788431188 * 1000);
    expect(quota!.weeklyResetAt).toBe(1788739200 * 1000);
  });

  test("stamps updatedAt locally, never from the payload", () => {
    const before = Date.now();
    const quota = parseMuseSubscriptionUsage(measuredPayload())!;
    expect(quota.updatedAt).toBeGreaterThanOrEqual(before);
    expect(quota.updatedAt).toBeLessThanOrEqual(Date.now());
  });

  test("never surfaces the opaque tier id", () => {
    const quota = parseMuseSubscriptionUsage(measuredPayload())!;
    expect(JSON.stringify(quota)).not.toContain("27681393394859588");
    expect(Object.keys(quota)).not.toContain("tier");
  });

  /*
   * The window is identified by its DECLARED duration. Filing a ten-hour window in the
   * five-hour slot would understate usage by the ratio of the windows, and would do so
   * with full confidence.
   */
  test("routes a non-300-minute window to customWindows, not the five-hour slot", () => {
    const quota = parseMuseSubscriptionUsage({
      type: MUSE_SUBSCRIPTION_USAGE_TYPE,
      subscription: { window: { used_percent: 40, resets_at: 1788431188, window_duration_mins: 600 } },
    });
    expect(quota).not.toBeNull();
    expect(quota!.fiveHourPercent).toBeUndefined();
    expect(quota!.customWindows).toEqual([
      { label: "600m", percent: 40, resetAt: 1788431188 * 1000 },
    ]);
  });

  test("a window with no declared duration is custom, not assumed five-hour", () => {
    const quota = parseMuseSubscriptionUsage({
      type: MUSE_SUBSCRIPTION_USAGE_TYPE,
      subscription: { window: { used_percent: 7 } },
    })!;
    expect(quota.fiveHourPercent).toBeUndefined();
    expect(quota.customWindows).toEqual([{ label: "subscription", percent: 7 }]);
  });

  test("either window may be absent independently", () => {
    const weeklyOnly = parseMuseSubscriptionUsage({
      type: MUSE_SUBSCRIPTION_USAGE_TYPE,
      subscription: { weekly: { used_percent: 5, resets_at: 1788739200 } },
    })!;
    expect(weeklyOnly.weeklyPercent).toBe(5);
    expect(weeklyOnly.fiveHourPercent).toBeUndefined();

    const windowOnly = parseMuseSubscriptionUsage({
      type: MUSE_SUBSCRIPTION_USAGE_TYPE,
      subscription: { window: { used_percent: 9, window_duration_mins: 300 } },
    })!;
    expect(windowOnly.fiveHourPercent).toBe(9);
    expect(windowOnly.weeklyPercent).toBeUndefined();
    expect(windowOnly.fiveHourResetAt).toBeUndefined();
  });

  test("clamps an out-of-range percent rather than rejecting the row", () => {
    const quota = parseMuseSubscriptionUsage({
      type: MUSE_SUBSCRIPTION_USAGE_TYPE,
      subscription: { window: { used_percent: 150, window_duration_mins: 300 } },
    })!;
    expect(quota.fiveHourPercent).toBe(100);
  });

  test("accepts a numeric string percent", () => {
    const quota = parseMuseSubscriptionUsage({
      type: MUSE_SUBSCRIPTION_USAGE_TYPE,
      subscription: { window: { used_percent: "12", window_duration_mins: 300 } },
    })!;
    expect(quota.fiveHourPercent).toBe(12);
  });

  /*
   * This runs inside SSE inspection on a live request. The only acceptable failure is
   * silence: a parse error must never cost the user their turn.
   */
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "nope"],
    ["an array", [1, 2, 3]],
    ["no subscription", { type: MUSE_SUBSCRIPTION_USAGE_TYPE }],
    ["a non-object subscription", { type: MUSE_SUBSCRIPTION_USAGE_TYPE, subscription: "x" }],
    ["no usable window", { type: MUSE_SUBSCRIPTION_USAGE_TYPE, subscription: { tier: "1" } }],
    ["unparseable percents", {
      type: MUSE_SUBSCRIPTION_USAGE_TYPE,
      subscription: { window: { used_percent: "abc", window_duration_mins: 300 }, weekly: { used_percent: null } },
    }],
  ])("returns null without throwing for %s", (_label, payload) => {
    expect(() => parseMuseSubscriptionUsage(payload)).not.toThrow();
    expect(parseMuseSubscriptionUsage(payload)).toBeNull();
  });

  test("recognizes only the subscription-usage frame type", () => {
    expect(isMuseSubscriptionUsagePayload(measuredPayload())).toBe(true);
    expect(isMuseSubscriptionUsagePayload({ type: "response.completed" })).toBe(false);
    expect(isMuseSubscriptionUsagePayload(null)).toBe(false);
  });
});
