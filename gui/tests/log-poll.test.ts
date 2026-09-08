import { describe, expect, test } from "bun:test";
import { mergeLogDelta, parseLogPollResponse } from "../src/pages/log-poll";

describe("log polling protocol", () => {
  test("legacy arrays and envelopes replace snapshots without a cursor", () => {
    const rows = [{ requestId: "a" }];
    expect(parseLogPollResponse(rows)).toEqual({ rows, cursor: null, reset: false });
    expect(parseLogPollResponse({ logs: rows, generatedAt: 123, timeZone: "UTC", total: 5 }))
      .toEqual({ rows, cursor: null, reset: false, generatedAt: 123, timeZone: "UTC", total: 5 });
    expect(parseLogPollResponse({ logs: rows, generatedAt: "bad" }).generatedAt).toBe("bad");
  });

  test("empty deltas and resets retain clock and window metadata", () => {
    for (const reset of [false, true]) {
      expect(parseLogPollResponse({ logs: [], cursor: "opaque-cursor", reset, generatedAt: 456, total: 2, timeZone: "UTC" }))
        .toEqual({ rows: [], cursor: "opaque-cursor", reset, generatedAt: 456, total: 2, timeZone: "UTC" });
    }
  });

  test("invalid cursor envelopes fail instead of clearing accepted rows", () => {
    for (const body of [null, "bad", { logs: {} }, { logs: [], cursor: null, reset: false },
      { logs: [], cursor: "", reset: false }, { logs: [], cursor: "c", reset: "false" },
      { logs: [], cursor: "c" }, { logs: [], reset: false }, { cursor: "c", reset: false },
      { logs: [], cursor: "a".repeat(513), reset: false }, { logs: [], cursor: " c ", reset: false }]) {
      expect(() => parseLogPollResponse(body)).toThrow("Invalid log response");
    }
  });

  test("append preserves order and repeated IDs without mutating inputs; cap keeps newest rows", () => {
    const previous = [{ requestId: "same", value: 1 }, { requestId: "other", value: 2 }];
    const incoming = [{ requestId: "same", value: 3 }];
    expect(mergeLogDelta(previous, incoming)).toEqual([...previous, ...incoming]);
    expect(mergeLogDelta(previous, incoming, 2)).toEqual([previous[1], incoming[0]]);
    expect(mergeLogDelta(previous, [])).toBe(previous);
    expect(mergeLogDelta(previous, [], 1)).toEqual([previous[1]]);
    expect(previous).toEqual([{ requestId: "same", value: 1 }, { requestId: "other", value: 2 }]);
    expect(incoming).toEqual([{ requestId: "same", value: 3 }]);
  });
});
