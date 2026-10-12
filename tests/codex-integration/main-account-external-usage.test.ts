import { beforeEach, expect, test } from "bun:test";
import { EXTERNAL_USAGE_QUIET_MS, EXTERNAL_USAGE_TTL_MS, getMainAccountExternalUsageWarning,
  noteMainAccountActivity, observeMainAccountUsage, resetMainAccountExternalUsageForTests } from "../../src/codex/main-account-external-usage";
const now = 2_000_000_000_000;
const resetAtMs = now + 10 * 60 * 60_000;
const reading = (percent: number, reset = resetAtMs) => [{ kind: "short" as const, percent, resetAtMs: reset }];
beforeEach(resetMainAccountExternalUsageForTests);
test("rise by one point with no activity warns; smaller rises do not", () => {
  observeMainAccountUsage("a", reading(10), now);
  observeMainAccountUsage("a", reading(10.5), now + 1000);
  expect(getMainAccountExternalUsageWarning("a", now + 1000)).toBeUndefined();
  observeMainAccountUsage("a", reading(11.5), now + 2000);
  expect(getMainAccountExternalUsageWarning("a", now + 2000)).toEqual({ window: "short",
    fromPercent: 10.5, toPercent: 11.5, observedAt: now + 2000 });
});
test("activity inside the quiet margin suppresses, including its boundary", () => {
  noteMainAccountActivity(now - EXTERNAL_USAGE_QUIET_MS);
  observeMainAccountUsage("a", reading(10), now);
  observeMainAccountUsage("a", reading(12), now + 1000);
  expect(getMainAccountExternalUsageWarning("a", now + 1000)).toBeUndefined();
});
test("old activity outside the margin permits a warning", () => {
  noteMainAccountActivity(now - EXTERNAL_USAGE_QUIET_MS - 1);
  observeMainAccountUsage("a", reading(10), now);
  observeMainAccountUsage("a", reading(12), now + 1000);
  expect(getMainAccountExternalUsageWarning("a", now + 1000)).toBeDefined();
});
test("changed reset clears warning and rebaselines the episode", () => {
  observeMainAccountUsage("a", reading(10), now);
  observeMainAccountUsage("a", reading(12), now + 1000);
  observeMainAccountUsage("a", reading(15, resetAtMs + 1000), now + 2000);
  expect(getMainAccountExternalUsageWarning("a", now + 2000)).toBeUndefined();
});
test("identity change clears; getters cannot leak another identity", () => {
  observeMainAccountUsage("a", reading(10), now);
  observeMainAccountUsage("a", reading(12), now + 1000);
  expect(getMainAccountExternalUsageWarning("b", now + 1000)).toBeUndefined();
  observeMainAccountUsage("b", reading(20), now + 2000);
  expect(getMainAccountExternalUsageWarning("b", now + 2000)).toBeUndefined();
  expect(getMainAccountExternalUsageWarning("a", now + 2000)).toBeUndefined();
});
test("warning expires at six hours even with unchanged observations", () => {
  observeMainAccountUsage("a", reading(10), now);
  observeMainAccountUsage("a", reading(12), now + 1000);
  observeMainAccountUsage("a", reading(12), now + EXTERNAL_USAGE_TTL_MS);
  expect(getMainAccountExternalUsageWarning("a", now + EXTERNAL_USAGE_TTL_MS)).toBeDefined();
  expect(getMainAccountExternalUsageWarning("a", now + 1000 + EXTERNAL_USAGE_TTL_MS)).toBeUndefined();
});
test("reset expires before TTL and missing or invalid resets cannot prove a rise", () => {
  observeMainAccountUsage("a", reading(10, now + 5000), now);
  observeMainAccountUsage("a", reading(12, now + 5000), now + 1000);
  expect(getMainAccountExternalUsageWarning("a", now + 4999)).toBeDefined();
  expect(getMainAccountExternalUsageWarning("a", now + 5000)).toBeUndefined();
  observeMainAccountUsage("a", reading(20, NaN), now + 6000);
  observeMainAccountUsage("a", reading(25, NaN), now + 7000);
  expect(getMainAccountExternalUsageWarning("a", now + 7000)).toBeUndefined();
});
test("long windows warn independently", () => {
  observeMainAccountUsage("a", [{ kind: "long", percent: 20, resetAtMs }], now);
  observeMainAccountUsage("a", [{ kind: "long", percent: 21, resetAtMs }], now + 1000);
  expect(getMainAccountExternalUsageWarning("a", now + 1000)?.window).toBe("long");
});
