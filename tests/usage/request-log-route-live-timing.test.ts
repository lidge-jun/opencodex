import { afterEach, describe, expect, test } from "bun:test";
import { addFinalRequestLog, clearRequestLogsForTests, type RequestLogEntry } from "../../src/server/request-log";

afterEach(() => clearRequestLogsForTests());

function finalRow(start: number, extra: Record<string, unknown>): RequestLogEntry {
  const rows: RequestLogEntry[] = [];
  addFinalRequestLog("timing-row", start, { model: "gpt-5", provider: "openai", ...extra }, 200, undefined, row => rows.push(row));
  return rows[0]!;
}

describe("live routing timing on the final request row", () => {
  test("upstreamSendMs is the offset of the final attempt's start from the request start", () => {
    const start = Date.now() - 500;
    const row = finalRow(start, { activeAttemptStartedAt: start + 120 });
    expect(row.upstreamSendMs).toBe(120);
  });

  test("nothing is invented when the attempt start is unknown or before the request", () => {
    const start = Date.now();
    expect(finalRow(start, {}).upstreamSendMs).toBeUndefined();
    expect(finalRow(start, { activeAttemptStartedAt: start - 5 }).upstreamSendMs).toBeUndefined();
  });
});
