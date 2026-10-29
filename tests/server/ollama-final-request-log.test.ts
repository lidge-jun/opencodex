import { describe, expect, test } from "bun:test";
import {
  addFinalRequestLog,
  addOuterFinalRequestLog,
  suppressInnerFinalRequestLog,
  type RequestLogContext,
  type RequestLogEntry,
} from "../../src/server/request-log";

describe("Ollama outer request-log ownership", () => {
  test("inner writes stay suppressed after the one outer write", () => {
    const logCtx: RequestLogContext = { model: "model", provider: "openai" };
    const rows: RequestLogEntry[] = [];
    const addLog = (entry: RequestLogEntry) => { rows.push(entry); };
    suppressInnerFinalRequestLog(logCtx);
    addFinalRequestLog("request", 1, logCtx, 200, { closeReason: "non_stream" }, addLog);
    expect(rows).toHaveLength(0);
    expect(addOuterFinalRequestLog("request", 1, logCtx, 200, { closeReason: "non_stream" }, addLog)).toBe(true);
    expect(rows).toHaveLength(1);
    addFinalRequestLog("request", 1, logCtx, 499, { closeReason: "client_cancel" }, addLog);
    expect(addOuterFinalRequestLog("request", 1, logCtx, 502, { closeReason: "non_stream" }, addLog)).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: "request", status: 200 });
  });

  test("ordinary request logging is unchanged without suppression", () => {
    const logCtx: RequestLogContext = { model: "model", provider: "openai" };
    const rows: RequestLogEntry[] = [];
    addFinalRequestLog("ordinary", 1, logCtx, 200, { closeReason: "non_stream" }, entry => rows.push(entry));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: "ordinary", status: 200 });
  });
});
