import { describe, expect, test } from "bun:test";
import { parseUsageTimeWindow } from "../../src/usage/time-range";

describe("usage time window parsing", () => {
  test("accepts epoch milliseconds and normalizes explicit ISO offsets", () => {
    expect(parseUsageTimeWindow(undefined, null)).toBeUndefined();
    expect(parseUsageTimeWindow("0", 0)).toEqual({ since: 0, until: 0 });
    expect(parseUsageTimeWindow("1970-01-01T00:00:00.1Z", "1970-01-01T00:00:00.12Z"))
      .toEqual({ since: 100, until: 120 });
    expect(parseUsageTimeWindow("2024-02-29T09:00:00.123+09:00", "2024-02-28T19:00:00.123-05:00"))
      .toEqual({ since: 1709164800123, until: 1709164800123 });
    expect(parseUsageTimeWindow("1970-01-01T00:00:00Z", "8640000000000000"))
      .toEqual({ since: 0, until: 8_640_000_000_000_000 });
    expect(parseUsageTimeWindow("+275760-09-13T00:00:00Z", 8_640_000_000_000_000)?.since)
      .toBe(8_640_000_000_000_000);
  });

  test("rejects absent peers, reversed bounds and non-integer or invalid dates", () => {
    for (const [since, until] of [[0, undefined], [null, 0], [2, 1]] as const) {
      expect(() => parseUsageTimeWindow(since, until)).toThrow();
    }
    for (const value of [
      "", " ", " 0", "1.5", "1e3", "0x10", "-1", -1, 0.5, NaN, Infinity,
      "9007199254740992", "8640000000000001", "2026-09-01", "2026-09-01T12:00:00",
      "2026-09-01T12:00Z", "2026-02-29T00:00:00Z", "2024-02-30T00:00:00Z",
      "2100-02-29T00:00:00Z", "2026-04-31T00:00:00+09:00", "2026-13-01T00:00:00Z",
      "2026-01-00T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z",
      "2026-01-01T00:00:60Z", "2026-01-01T00:00:00+24:00", "2026-01-01T00:00:00+01:60",
      "1970-01-01T00:00:00+00:01", "+275760-09-13T00:00:00.001Z",
      "2026-09-01T00:00:00.0001Z",
    ]) {
      expect(() => parseUsageTimeWindow(value, 8_640_000_000_000_000)).toThrow();
      expect(() => parseUsageTimeWindow(0, value)).toThrow();
    }
  });
});
