import { describe, expect, test } from "bun:test";
import {
  addFinalRequestLog,
  beginRequestAttempt,
  noteAttemptSend,
  type RequestLogContext,
  type RequestLogEntry,
} from "../../src/server/request-log";
import { createNativeFinalLog, NATIVE_FINAL_LOG_CUTOFF_CODE } from "../../src/server/native-final-log";

function context(): RequestLogContext {
  const attempt = beginRequestAttempt(1, "fixture", "model", "openai-chat");
  noteAttemptSend(attempt, undefined);
  return {
    model: "model", provider: "fixture", providerAdapter: "openai-chat",
    attempts: [attempt], activeAttempt: attempt, usage: { inputTokens: 12, outputTokens: 3 },
  };
}

describe("native final request log", () => {
  test("a conversion failure after an upstream 200 keeps the attempt's success", async () => {
    const logCtx = context();
    const rows: RequestLogEntry[] = [];
    const owner = createNativeFinalLog("conversion", 1, logCtx, { addLog: row => rows.push(row) });
    addFinalRequestLog("conversion", 1, logCtx, 200, { closeReason: "non_stream" });
    expect(rows).toHaveLength(0);
    expect(await owner.waitForInner()).toBe(true);
    expect(owner.commit({ status: 502, terminalStatus: "failed", closeReason: "non_stream" })).toBe(true);
    addFinalRequestLog("conversion", 1, logCtx, 499, { closeReason: "client_cancel" });
    expect(owner.commit({ status: 200, closeReason: "non_stream" })).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 502, terminalStatus: "failed", usageStatus: "reported" });
    expect(rows[0]!.failureStage).toBeDefined();
    const attempt = rows[0]!.attempts![0]!;
    expect(attempt.status).toBe(200);
    expect(attempt.errorCode).toBeUndefined();
    expect(attempt.failureStage).toBeUndefined();
    expect(attempt.failureCause).toBeUndefined();
  });

  test("a client cancel after inner success is a 499 row over a 200 attempt", async () => {
    const logCtx = context();
    const rows: RequestLogEntry[] = [];
    const owner = createNativeFinalLog("cancel", 1, logCtx, { addLog: row => rows.push(row) });
    addFinalRequestLog("cancel", 1, logCtx, 200, { terminalStatus: "completed", closeReason: "terminal" });
    await owner.waitForInner();
    owner.commit({ status: 499, closeReason: "client_cancel" });
    expect(rows[0]).toMatchObject({ status: 499, closeReason: "client_cancel" });
    expect(rows[0]!.attempts![0]!.status).toBe(200);
  });

  test("the outer status is authoritative over client-close-like inner text", async () => {
    const logCtx = { ...context(), upstreamError: "client closed request" };
    const rows: RequestLogEntry[] = [];
    const owner = createNativeFinalLog("outer", 1, logCtx, { addLog: row => rows.push(row) });
    addFinalRequestLog("outer", 1, logCtx, 502, { terminalStatus: "failed", closeReason: "terminal" });
    await owner.waitForInner();
    owner.commit({ status: 502, terminalStatus: "failed", closeReason: "terminal" });
    expect(rows[0]).toMatchObject({ status: 502, closeReason: "terminal" });
  });

  test("a missing inner settlement cuts off: no partial usage, unresolved spend, never success", async () => {
    const logCtx = { ...context(), usage: { inputTokens: 12, outputTokens: 0 }, usageLogInputTokens: 40 };
    const settled: unknown[] = [];
    logCtx.spendTracker = { settle: (usage: unknown) => settled.push(usage) } as unknown as RequestLogContext["spendTracker"];
    const rows: RequestLogEntry[] = [];
    const owner = createNativeFinalLog("cutoff", 1, logCtx, { fallbackMs: 5, addLog: row => rows.push(row) });
    const started = Date.now();
    expect(await owner.waitForInner()).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    owner.commit({ status: 200, terminalStatus: "completed", closeReason: "terminal" });
    expect(rows[0]).toMatchObject({ status: 502, terminalStatus: "failed", usageStatus: "unreported", errorCode: NATIVE_FINAL_LOG_CUTOFF_CODE });
    expect(rows[0]!.usage).toBeUndefined();
    expect(settled).toEqual([undefined]);
    addFinalRequestLog("cutoff", 1, logCtx, 200, { closeReason: "terminal" });
    expect(rows).toHaveLength(1);
  });

  test("an inner settlement inside the fallback window wakes the wait", async () => {
    const logCtx = context();
    const owner = createNativeFinalLog("late", 1, logCtx, { fallbackMs: 10_000, addLog: () => {} });
    const waiting = owner.waitForInner();
    setTimeout(() => addFinalRequestLog("late", 1, logCtx, 200, { closeReason: "terminal" }), 1);
    expect(await waiting).toBe(true);
  });

  test("ordinary request logging is unchanged without an owner", () => {
    const rows: RequestLogEntry[] = [];
    const logCtx = { ...context(), upstreamError: "client closed request" };
    addFinalRequestLog("ordinary", 1, logCtx, 502, { closeReason: "terminal" }, row => rows.push(row));
    expect(rows[0]).toMatchObject({ status: 499, closeReason: "client_cancel" });
    expect(rows[0]!.attempts![0]!.status).toBe(499);
  });
});
