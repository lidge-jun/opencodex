import { afterEach, describe, expect, test } from "bun:test";
import {
  inspectResponseLogJson,
  inspectResponseLogSsePayload,
  type RequestLogContext,
} from "../src/server/request-log";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";
import {
  clearGuardrailsTelemetryForTests,
  guardrailsActivity,
  guardrailsActivityRetainedStoreSnapshot,
  guardrailsTelemetryOverview,
  recordGuardrailsEvent,
  recordGuardrailsTurn,
  recordGuardrailsTurnDelta,
  sweepExpiredGuardrailsActivity,
} from "../src/guardrails/telemetry";
import { decideAndRecordGuardrailsLateFailure } from "../src/guardrails/late-failure";
import { extendGuardrailsTurnText, prepareGuardrailsTurn } from "../src/guardrails/turn";
import { GuardrailsScanCapacityError } from "../src/guardrails/scanner";
import type { OcxConfig } from "../src/types";

afterEach(() => {
  resetDebugSettingsForTests();
  clearGuardrailsTelemetryForTests();
});

function protectedContext(): RequestLogContext {
  return {
    model: "test-model",
    provider: "test-provider",
    sensitiveDataProtectionActive: true,
  };
}

async function guardrailsTurn(
  failurePolicy: "block" | "passthrough",
  mode: "detect" | "enforce" = "enforce",
) {
  const prepared = await prepareGuardrailsTurn(
    {
      guardrails: {
        enabled: true,
        mode,
        failurePolicy,
      },
    } as OcxConfig,
    "responses",
    { input: "synthetic input" },
  );
  if (!prepared.turn) throw new Error("Expected an active Guardrails turn");
  return prepared.turn;
}

describe("Guardrails privacy-safe response telemetry", () => {
  test("keeps JSON usage metadata without retaining a response body or error text", () => {
    setDebugSettings({ usage: true });
    const logCtx = protectedContext();

    inspectResponseLogJson(logCtx, JSON.stringify({
      response: { usage: { input_tokens: 8, output_tokens: 3 } },
      error: { message: "SENSITIVE_TEST_VALUE" },
    }));

    expect(logCtx.usage).toEqual({ inputTokens: 8, outputTokens: 3 });
    expect(logCtx.usageDebugBodySample).toBeUndefined();
    expect(logCtx.usageDebugBodyKind).toBeUndefined();
    expect(logCtx.upstreamError).toBeUndefined();
  });

  test("keeps SSE usage metadata without retaining a payload or error text", () => {
    setDebugSettings({ usage: true });
    const logCtx = protectedContext();

    inspectResponseLogSsePayload(logCtx, JSON.stringify({
      type: "response.completed",
      response: { usage: { input_tokens: 5, output_tokens: 2 } },
      error: { message: "SENSITIVE_TEST_VALUE" },
    }));

    expect(logCtx.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    expect(logCtx.usageDebugBodySample).toBeUndefined();
    expect(logCtx.usageDebugBodyKind).toBeUndefined();
    expect(logCtx.upstreamError).toBeUndefined();
  });

  test("Activity drops undeclared sensitive fields and remains count bounded", () => {
    const secret = "SENSITIVE_TEST_VALUE";
    for (let index = 0; index < 1_050; index += 1) {
      recordGuardrailsEvent({
        surface: "responses",
        mode: "enforce",
        result: "masked",
        registryGeneration: 3,
        count: 1,
        categoryIds: [6],
        ruleIds: ["api_keys.stripe-key"],
        latencyMs: 1,
        severity: "info",
        text: secret,
        original: secret,
        headers: { authorization: secret },
      } as Parameters<typeof recordGuardrailsEvent>[0]);
    }

    const activity = guardrailsActivity({ limit: 200 });
    const snapshot = guardrailsActivityRetainedStoreSnapshot();
    expect(snapshot.count).toBe(1_000);
    expect(snapshot.bytes).toBeGreaterThan(0);
    expect(activity.retention.evictedEvents).toBe(50);
    expect(activity.counters.masked).toBe(1_000);
    expect(activity.counters.scanned).toBe(1_000);
    expect(JSON.stringify(activity)).not.toContain(secret);
    expect(JSON.stringify(activity)).not.toContain("authorization");
  });

  test("top rules and categories count individual findings and unwind on eviction", () => {
    const timestamp = Date.now();
    recordGuardrailsEvent({
      surface: "responses",
      mode: "enforce",
      result: "masked",
      registryGeneration: 3,
      count: 3,
      categoryIds: [1, 1, 2],
      ruleIds: ["rule-a", "rule-a", "rule-b"],
      latencyMs: 1,
      severity: "info",
      timestamp,
    });

    expect(guardrailsTelemetryOverview().topRules).toEqual([
      { id: "rule-a", count: 2 },
      { id: "rule-b", count: 1 },
    ]);
    expect(guardrailsTelemetryOverview().topCategories).toEqual([
      { id: 1, count: 2 },
      { id: 2, count: 1 },
    ]);

    expect(sweepExpiredGuardrailsActivity(timestamp + 60 * 60 * 1_000 + 1)).toBe(1);
    expect(guardrailsTelemetryOverview().topRules).toEqual([]);
    expect(guardrailsTelemetryOverview().topCategories).toEqual([]);
    expect(guardrailsTelemetryOverview().counters).toEqual({
      scanned: 0,
      masked: 0,
      detected: 0,
      blocked: 0,
      passthrough: 0,
      demaskWarning: 0,
      toolArgumentRestoreSkipped: 0,
    });
  });

  test("late findings update detection totals without counting a second client request", async () => {
    const turn = await guardrailsTurn("block");
    recordGuardrailsTurn("responses", turn, 1);
    const extended = extendGuardrailsTurnText(
      "sk_live_abcdefghijklmnopqrstuvwx",
      turn,
    ).turn;

    recordGuardrailsTurnDelta("responses", extended, turn.findings.length, 0.5);

    const overview = guardrailsTelemetryOverview();
    expect(overview.counters.scanned).toBe(1);
    expect(overview.counters.masked).toBe(1);
    expect(overview.recentEvents).toHaveLength(2);
    expect(overview.recentEvents[0]).toMatchObject({
      result: "masked",
      count: 1,
      severity: "info",
    });
  });

  test("last passthrough remains visible beyond the ten-event overview window", () => {
    const passthroughAt = Date.now();
    recordGuardrailsEvent({
      surface: "responses",
      mode: "enforce",
      result: "passthrough",
      registryGeneration: 3,
      count: 1,
      categoryIds: [],
      ruleIds: [],
      latencyMs: 0,
      severity: "high",
      timestamp: passthroughAt,
    });
    for (let index = 1; index <= 11; index += 1) {
      recordGuardrailsEvent({
        surface: "responses",
        mode: "enforce",
        result: "scanned",
        registryGeneration: 3,
        count: 0,
        categoryIds: [],
        ruleIds: [],
        latencyMs: 0,
        severity: "info",
        timestamp: passthroughAt + index,
      });
    }

    const overview = guardrailsTelemetryOverview();
    expect(overview.recentEvents).toHaveLength(10);
    expect(overview.recentEvents.some(event => event.result === "passthrough")).toBe(false);
    expect(overview.lastPassthroughAt).toBe(passthroughAt);
  });

  test("late block failures use canonical scan status/code and record one Chat event", async () => {
    const secret = "SENSITIVE_LATE_FAILURE_VALUE";
    const turn = await guardrailsTurn("block");

    const decision = decideAndRecordGuardrailsLateFailure({
      error: new Error(secret),
      inboundProtocol: "chat",
      latencyMs: 2.5,
      turn,
    });

    expect(decision).toEqual({
      kind: "block",
      code: "guardrails_scan_failed",
      status: 400,
    });
    const activity = guardrailsActivity();
    expect(activity.totalMatching).toBe(1);
    expect(activity.events).toEqual([
      expect.objectContaining({
        surface: "chat",
        mode: "enforce",
        result: "blocked",
        registryGeneration: turn.snapshot.generation,
        count: 1,
        categoryIds: [],
        ruleIds: [],
        severity: "warning",
      }),
    ]);
    expect(JSON.stringify(activity)).not.toContain(secret);
  });

  test("late capacity blocks use canonical status/code and record one Anthropic event", async () => {
    const secret = "SENSITIVE_CAPACITY_FAILURE_VALUE";
    const turn = await guardrailsTurn("block");

    const decision = decideAndRecordGuardrailsLateFailure({
      error: new GuardrailsScanCapacityError(secret),
      inboundProtocol: "anthropic",
      latencyMs: 3,
      turn,
    });

    expect(decision).toEqual({
      kind: "block",
      code: "guardrails_capacity_exceeded",
      status: 413,
    });
    const activity = guardrailsActivity();
    expect(activity.totalMatching).toBe(1);
    expect(activity.events).toEqual([
      expect.objectContaining({
        surface: "messages",
        result: "blocked",
        severity: "warning",
      }),
    ]);
    expect(JSON.stringify(activity)).not.toContain(secret);
  });

  test("late passthrough records exactly one high-severity metadata-only event", async () => {
    const secret = "SENSITIVE_PASSTHROUGH_FAILURE_VALUE";
    const turn = await guardrailsTurn("passthrough", "detect");

    const decision = decideAndRecordGuardrailsLateFailure({
      error: new Error(secret),
      inboundProtocol: "responses",
      latencyMs: 4,
      turn,
    });

    expect(decision).toEqual({ kind: "passthrough" });
    const activity = guardrailsActivity();
    expect(activity.totalMatching).toBe(1);
    expect(activity.counters.passthrough).toBe(1);
    expect(activity.counters.blocked).toBe(0);
    expect(activity.events).toEqual([
      expect.objectContaining({
        surface: "responses",
        mode: "detect",
        result: "passthrough",
        severity: "high",
        categoryIds: [],
        ruleIds: [],
      }),
    ]);
    expect(JSON.stringify(activity)).not.toContain(secret);
  });

  test("an unavailable passthrough rollback forces one metadata-only block", async () => {
    const secret = "SENSITIVE_ROLLBACK_FAILURE_VALUE";
    const turn = await guardrailsTurn("passthrough");

    const decision = decideAndRecordGuardrailsLateFailure({
      allowPassthrough: false,
      error: new GuardrailsScanCapacityError(secret),
      inboundProtocol: "responses",
      latencyMs: 2,
      turn,
    });

    expect(decision).toEqual({
      kind: "block",
      code: "guardrails_capacity_exceeded",
      status: 413,
    });
    const activity = guardrailsActivity();
    expect(activity.totalMatching).toBe(1);
    expect(activity.counters.blocked).toBe(1);
    expect(activity.counters.passthrough).toBe(0);
    expect(activity.events).toEqual([
      expect.objectContaining({
        surface: "responses",
        result: "blocked",
        severity: "warning",
      }),
    ]);
    expect(JSON.stringify(activity)).not.toContain(secret);
  });
});
