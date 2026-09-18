import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFinalRequestLog,
  addRequestLog,
  beginRequestAttempt,
  clearNoAccountAffinityReasonsForTests,
  clearRequestLogsForTests,
  finishRequestAttempt,
  noteAffinityMove,
  noteAttemptSend,
  noteNoAccountAffinityReason,
  recordNoAccountAffinityFailure,
  requestLogEntryFromPersistedUsage,
  requestSpendRecord,
  takeNoAccountAffinityReason,
  type RequestLogContext,
  type RequestLogEntry,
} from "../../src/server/request-log";
import { requestLogDto } from "../../src/server/management/shared";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { readUsageEntries, resetUsageReadCacheForTests } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function attempt(
  ordinal: number,
  sends: number,
  status: number | null,
  model = "gpt-5.6-sol",
) {
  const row = beginRequestAttempt(ordinal, "openai", model, "openai-responses");
  for (let i = 0; i < sends; i++) noteAttemptSend(row, undefined);
  if (status !== null) finishRequestAttempt(row, status, 5, { inputTokens: 100, outputTokens: 10 });
  return row;
}

describe("logical-request spend aggregation", () => {
  test("sends are summed across attempts and combo children, not reported per attempt", () => {
    const budget = createRequestExecutionBudget(undefined, "lr-combo-1");
    // Three combo children under one turn: 2 + 1 + 1 physical sends.
    const children = [attempt(1, 2, 502), attempt(2, 1, 200, "gpt-5.6-terra"), attempt(3, 1, 200, "claude-opus-5")];
    budget.used = 4;
    const rows: RequestLogEntry[] = [];
    addFinalRequestLog("ocx-combo", Date.now(), {
      provider: "openai",
      model: "gpt-5.6-sol",
      requestedModel: "combo/test",
      comboId: "test",
      providerAdapter: "openai-responses",
      attempts: children,
      activeAttempt: children[2],
      executionBudget: budget,
    }, 200, undefined, row => rows.push(row));

    const spend = rows[0]?.spend;
    expect(rows[0]?.logicalRequestId).toBe("lr-combo-1");
    // Four sends for one user turn, where the largest single attempt reports two.
    expect(spend?.sends).toBe(4);
    expect(spend?.settled).toBe(4);
    expect(spend?.unresolved).toBe(0);
    expect(spend?.reserved).toBe(4);
    expect(spend?.policyVersion).toBe("guarded-v1");
  });

  test("a send with no terminal outcome is unresolved and never settled", () => {
    const budget = createRequestExecutionBudget(undefined, "lr-unresolved");
    // Attempt 2 was dispatched and abandoned before any status came back.
    const rows = [attempt(1, 1, 502), attempt(2, 1, null)];
    budget.used = 3; // one further leg re-sent without opening an attempt row at all
    const spend = requestSpendRecord({ executionBudget: budget }, rows);
    expect(spend).toEqual({
      sends: 2,
      settled: 1,
      unresolved: 2,
      reserved: 3,
      policyVersion: "guarded-v1",
    });
  });

  test("move reasons ride the spend record and keep every cause, not only the last", () => {
    const logCtx: RequestLogContext = { provider: "openai", model: "gpt-5.6-sol" };
    noteAffinityMove(logCtx, "rebound", "quota_refusal");
    noteAffinityMove(logCtx, "rebound", "transient");
    const spend = requestSpendRecord(logCtx, [attempt(1, 1, 200)]);
    expect(spend?.moveReasons).toEqual(["quota_refusal", "transient"]);
    expect(logCtx.affinityReason).toBe("transient");
  });

  test("spend and the affinity move reach usage.jsonl and come back on hydration", () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-spend-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    try {
      addRequestLog({
        requestId: "ocx-spend",
        logicalRequestId: "lr-persist-1",
        timestamp: 1,
        model: "gpt-5.6-sol",
        provider: "openai",
        status: 200,
        durationMs: 10,
        usageStatus: "reported",
        usage: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 40 },
        cacheProvenance: "observed",
        spend: { sends: 4, settled: 3, unresolved: 1, reserved: 4, moveReasons: ["quota_refusal"] },
        affinity: "rebound",
        affinityReason: "quota_refusal",
      });
      const persisted = readUsageEntries()[0]!;
      expect(persisted.logicalRequestId).toBe("lr-persist-1");
      expect(persisted.spend).toEqual({ sends: 4, settled: 3, unresolved: 1, reserved: 4, moveReasons: ["quota_refusal"] });
      expect(persisted.cacheProvenance).toBe("observed");
      // #4592's trap one layer down: the row carried the move and the disk projection dropped it.
      expect(persisted.affinity).toBe("rebound");
      expect(persisted.affinityReason).toBe("quota_refusal");
      const hydrated = requestLogEntryFromPersistedUsage(persisted);
      expect(hydrated.spend?.unresolved).toBe(1);
      expect(hydrated.affinityReason).toBe("quota_refusal");
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

  test("/api/logs carries the spend record and qualifies a synthesized cache zero", () => {
    const row = (cacheProvenance: "observed" | "synthesized", cacheReadInputTokens: number): RequestLogEntry => ({
      requestId: "ocx-dto",
      logicalRequestId: "lr-dto-1",
      timestamp: 1,
      model: "claude-sonnet-5",
      provider: "anthropic",
      status: 200,
      durationMs: 10,
      usageStatus: "reported",
      usage: { inputTokens: 1000, outputTokens: 10, cachedInputTokens: cacheReadInputTokens, cacheReadInputTokens },
      cacheProvenance,
      spend: { sends: 4, settled: 4, unresolved: 0, reserved: 4 },
    });
    const reasonsFor = (entry: RequestLogEntry): string[] => {
      const cost = (requestLogDto(entry).displayMetrics as {
        cost: { kind: string; estimateReasons?: string[] };
      }).cost;
      expect(cost.kind).toBe("value");
      return cost.estimateReasons ?? [];
    };

    const dto = requestLogDto(row("synthesized", 0));
    expect(dto.logicalRequestId).toBe("lr-dto-1");
    expect(dto.spend).toEqual({ sends: 4, settled: 4, unresolved: 0, reserved: 4 });
    // A zero emitted for wire compatibility qualifies the estimate exactly as a missing detail
    // does, rather than pricing the turn as a measured full-price uncached send.
    expect(reasonsFor(row("synthesized", 0))).toContain("cache_detail_missing");
    expect(reasonsFor(row("observed", 400))).not.toContain("cache_detail_missing");
  });
});

describe("no-account failures explain themselves", () => {
  test("the failing request carries its own reason and model lanes do not mix", () => {
    clearNoAccountAffinityReasonsForTests();
    try {
      const thread = "conv-1";
      noteNoAccountAffinityReason({ conversationId: thread, model: "gpt-5.6-sol" }, "quota_refusal");
      noteNoAccountAffinityReason({ conversationId: thread, model: "gpt-5.6-luna" }, "cooldown");

      const logCtx: RequestLogContext = { provider: "openai", model: "gpt-5.6-sol", conversationId: thread };
      const reported = recordNoAccountAffinityFailure(logCtx, { conversationId: thread, model: "gpt-5.6-sol" });
      expect(reported).toBe("quota_refusal");
      expect(logCtx.affinity).toBe("cleared");
      expect(logCtx.affinityReason).toBe("quota_refusal");
      expect(logCtx.errorCode).toBe("codex_no_account");

      // The other lane on the same thread still holds its own cause.
      expect(takeNoAccountAffinityReason({ conversationId: thread, model: "gpt-5.6-luna" })).toBe("cooldown");
      // ...and a consumed lane is not reported twice.
      expect(takeNoAccountAffinityReason({ conversationId: thread, model: "gpt-5.6-sol" })).toBeUndefined();

      const rows: RequestLogEntry[] = [];
      addFinalRequestLog("ocx-no-account", Date.now(), logCtx, 503, undefined, row => rows.push(row));
      expect(rows[0]?.affinityReason).toBe("quota_refusal");
      expect(rows[0]?.errorCode).toBe("codex_no_account");
      expect(rows[0]?.spend?.moveReasons).toEqual(["quota_refusal"]);
    } finally {
      clearNoAccountAffinityReasonsForTests();
    }
  });

  test("a lane with no recorded release reports nothing rather than borrowing another lane's", () => {
    clearNoAccountAffinityReasonsForTests();
    noteNoAccountAffinityReason({ conversationId: "conv-2", model: "gpt-5.6-sol" }, "generation");
    const logCtx: RequestLogContext = { provider: "openai", model: "claude-opus-5", conversationId: "conv-2" };
    expect(recordNoAccountAffinityFailure(logCtx, { conversationId: "conv-2", model: "claude-opus-5" })).toBeUndefined();
    expect(logCtx.affinity).toBeUndefined();
    expect(logCtx.errorCode).toBeUndefined();
    clearNoAccountAffinityReasonsForTests();
  });
});
