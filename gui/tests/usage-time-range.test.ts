import { expect, test } from "bun:test";
import { parseUsageTimeRange } from "../src/usage-time-range";

test("local minutes become inclusive epoch-ms bounds, including a single minute", () => {
  expect(parseUsageTimeRange("2024-02-29T12:34", "2024-02-29T12:34")).toEqual({
    ok: true,
    window: {
      since: new Date(2024, 1, 29, 12, 34, 0, 0).getTime(),
      until: new Date(2024, 1, 29, 12, 34, 59, 999).getTime(),
    },
  });
});

test("both local datetime bounds are required", () => {
  for (const [start, end] of [["", ""], ["2024-02-29T12:34", ""], ["", "2024-02-29T12:34"]]) {
    expect(parseUsageTimeRange(start, end)).toEqual({ ok: false, error: "required" });
  }
});

test("malformed, overflowing and negative dates are rejected rather than normalized", () => {
  for (const invalid of [
    "not-a-date", "2023-02-29T12:34", "2024-02-30T12:34", "2024-13-01T12:34",
    "2024-02-29T24:00", "2024-02-29T12:60", "1969-01-01T12:00",
    "2024-02-29", "2024-02-29T12:34Z", "2024-02-29T12:34:30", "2024-02-29T12:34+09:00",
  ]) {
    expect(parseUsageTimeRange(invalid, "2024-03-01T12:34")).toEqual({ ok: false, error: "invalid" });
    expect(parseUsageTimeRange("2024-02-01T12:34", invalid)).toEqual({ ok: false, error: "invalid" });
  }
});

test("reversed dates are rejected before extending the end minute", () => {
  expect(parseUsageTimeRange("2024-03-01T12:35", "2024-03-01T12:34"))
    .toEqual({ ok: false, error: "reversed" });
});
