import { describe, expect, test } from "bun:test";
import {
  decodeRequestLogCursor,
  encodeRequestLogCursor,
  sliceRequestLogsAfterCursor,
} from "../src/server/request-log-cursor";
import type { RequestLogEntry } from "../src/server/request-log";

function makeEntry(requestId: string, timestamp: number): RequestLogEntry {
  return {
    requestId,
    timestamp,
    model: "test-model",
    provider: "test-provider",
    status: 200,
    durationMs: 100,
    usageStatus: "reported",
  };
}

describe("request-log cursor", () => {
  test("round-trips timestamp and request id", () => {
    const encoded = encodeRequestLogCursor({ timestamp: 1700000000000, requestId: "req-2" });
    expect(decodeRequestLogCursor(encoded)).toEqual({ timestamp: 1700000000000, requestId: "req-2" });
  });

  test("rejects malformed, empty, and type-confused payloads", () => {
    expect(decodeRequestLogCursor("")).toBeNull();
    expect(decodeRequestLogCursor("not-base64-json")).toBeNull();
    expect(decodeRequestLogCursor("!!!")).toBeNull();
    expect(decodeRequestLogCursor(Buffer.from(JSON.stringify({ t: "1", id: 2 })).toString("base64url"))).toBeNull();
    expect(decodeRequestLogCursor(Buffer.from(JSON.stringify({ v: 2, t: 1, id: "req" })).toString("base64url"))).toBeNull();
    expect(decodeRequestLogCursor(Buffer.from(JSON.stringify({ v: 1, t: -1, id: "req" })).toString("base64url"))).toBeNull();
    expect(decodeRequestLogCursor(Buffer.from(JSON.stringify({ v: 1, t: Number.NaN, id: "req" })).toString("base64url"))).toBeNull();
    expect(decodeRequestLogCursor(Buffer.from(JSON.stringify({ v: 1, t: 1, id: "" })).toString("base64url"))).toBeNull();
    expect(decodeRequestLogCursor(Buffer.from(JSON.stringify({ v: 1, t: 1, id: "a".repeat(300) })).toString("base64url"))).toBeNull();
    expect(decodeRequestLogCursor(Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url"))).toBeNull();
    expect(decodeRequestLogCursor(Buffer.from(JSON.stringify(null)).toString("base64url"))).toBeNull();
  });

  test("ring slice returns only rows after a live cursor", () => {
    const rows = [makeEntry("req-1", 1), makeEntry("req-2", 2), makeEntry("req-3", 3)];
    expect(sliceRequestLogsAfterCursor(rows, { timestamp: 2, requestId: "req-2" })).toEqual({
      entries: [rows[2]],
      reset: false,
    });
  });

  test("ring slice returns empty entries when cursor matches the newest item", () => {
    const rows = [makeEntry("req-1", 1), makeEntry("req-2", 2), makeEntry("req-3", 3)];
    expect(sliceRequestLogsAfterCursor(rows, { timestamp: 3, requestId: "req-3" })).toEqual({
      entries: [],
      reset: false,
    });
  });

  test("ring slice requests a reset when the cursor was evicted or not found", () => {
    const rows = [makeEntry("req-3", 3), makeEntry("req-4", 4)];
    expect(sliceRequestLogsAfterCursor(rows, { timestamp: 2, requestId: "req-2" })).toEqual({
      entries: rows,
      reset: true,
    });
  });

  test("ring slice handles empty logs array with reset", () => {
    expect(sliceRequestLogsAfterCursor([], { timestamp: 1, requestId: "req-1" })).toEqual({
      entries: [],
      reset: true,
    });
  });
});
