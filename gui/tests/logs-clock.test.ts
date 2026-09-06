import { expect, test } from "bun:test";
import { logsClockAnchor, logsClockNow } from "../src/pages/logs-clock";

test.each([undefined, null, "1700000000000", -1, NaN, Infinity, -Infinity])(
  "invalid generatedAt %s leaves the browser fallback in effect", generatedAt => {
    const anchor = logsClockAnchor(generatedAt, 10);
    expect(anchor).toBeUndefined();
    expect(logsClockNow(anchor, 100, 42_000)).toBe(42_000);
  },
);

test("zero is a valid proxy epoch and elapsed time is monotonic", () => {
  const anchor = logsClockAnchor(0, 100);
  expect(anchor).toEqual({ generatedAt: 0, receivedAt: 100 });
  expect(logsClockNow(anchor, 150, 80_000)).toBe(50);
  expect(logsClockNow(anchor, 160, 1)).toBe(60);
});

test("proxy-relative time ignores browser wall-clock skew and subsequent jumps", () => {
  const anchor = logsClockAnchor(1_800_000_000_000, 500);
  expect(logsClockNow(anchor, 30_500, 1_800_021_600_000)).toBe(1_800_000_030_000);
  expect(logsClockNow(anchor, 30_500, 1_799_978_400_000)).toBe(1_800_000_030_000);
});
