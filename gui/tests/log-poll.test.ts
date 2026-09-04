import { describe, expect, test } from "bun:test";
import { mergeLogDelta, parseLogPollResponse } from "../src/pages/log-poll";

describe("log-poll helpers", () => {
  test("merge appends delta rows, replaces duplicate ids, and keeps newest cap", () => {
    expect(mergeLogDelta(
      [{ requestId: "a", value: 1 }, { requestId: "b", value: 1 }],
      [{ requestId: "b", value: 2 }, { requestId: "c", value: 1 }],
      2,
    )).toEqual([{ requestId: "b", value: 2 }, { requestId: "c", value: 1 }]);
  });

  test("merge preserves all rows when under cap and no duplicates", () => {
    expect(mergeLogDelta(
      [{ requestId: "a", value: 1 }],
      [{ requestId: "b", value: 2 }],
      10,
    )).toEqual([{ requestId: "a", value: 1 }, { requestId: "b", value: 2 }]);
  });

  test("merge returns previous capped rows when incoming is empty", () => {
    expect(mergeLogDelta(
      [{ requestId: "a", value: 1 }, { requestId: "b", value: 2 }],
      [],
      2,
    )).toEqual([{ requestId: "a", value: 1 }, { requestId: "b", value: 2 }]);
  });

  test("legacy array and object bodies are full snapshots", () => {
    expect(parseLogPollResponse([{ requestId: "a" }])).toEqual({
      rows: [{ requestId: "a" }],
      cursor: null,
      reset: false,
      cursorCapable: false,
    });
    expect(parseLogPollResponse({ logs: [{ requestId: "a" }] })).toEqual({
      rows: [{ requestId: "a" }],
      cursor: null,
      reset: false,
      cursorCapable: false,
    });
  });

  test("cursor response preserves reset metadata and cursorCapable flag", () => {
    expect(parseLogPollResponse({ logs: [], cursor: "opaque", reset: true })).toEqual({
      rows: [],
      cursor: "opaque",
      reset: true,
      cursorCapable: true,
    });
    expect(parseLogPollResponse({ logs: [{ requestId: "x" }], cursor: "c-1", reset: false })).toEqual({
      rows: [{ requestId: "x" }],
      cursor: "c-1",
      reset: false,
      cursorCapable: true,
    });
  });

  test("malformed response returns empty rows and cursorCapable false", () => {
    expect(parseLogPollResponse(null)).toEqual({
      rows: [],
      cursor: null,
      reset: false,
      cursorCapable: false,
    });
    expect(parseLogPollResponse("string")).toEqual({
      rows: [],
      cursor: null,
      reset: false,
      cursorCapable: false,
    });
  });
});
