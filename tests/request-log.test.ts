import { describe, expect, spyOn, test } from "bun:test";
import {
  filterRequestLogs,
  addFinalRequestLog,
  httpStatusFromTerminalError,
  nextRequestLogId,
  responseWithDeferredRequestLog,
  requestLogErrorCode,
  requestLogSpeedLabel,
  type RequestLogEntry,
} from "../src/server";
import {
  aggregateAttemptUsage,
  addRequestLog,
  beginRequestAttempt,
  clearRequestLogsForTests,
  finishRequestAttempt,
  getRequestLogEntries,
  hydrateRequestLogsFromDisk,
  noteAttemptSend,
  recordAdapterReasoning,
  recordFirstOutput,
  requestLogEntryFromPersistedUsage,
  sealRequestAttemptIdentity,
  type RequestLogContext,
} from "../src/server/request-log";
import { handleResponses } from "../src/server/responses";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent, OcxConfig, OcxUsage } from "../src/types";
import {
  appendUsageEntry,
  readUsageEntries,
  resetUsageReadCacheForTests,
  type PersistedUsageEntry,
} from "../src/usage/log";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "./helpers/remove-tree";

async function* replayAdapterEvents(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

function log(overrides: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    requestId: "ocx-test",
    timestamp: 1,
    model: "gpt-test",
    provider: "openai",
    status: 200,
    durationMs: 10,
    usageStatus: "unreported",
    ...overrides,
  };
}

describe("request log metadata", () => {
  test("creates one ordinary attempt after the final adapter is resolved", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      id: "resp_attempt",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })) as typeof fetch;
    const logCtx: RequestLogContext = { model: "unknown", provider: "unknown" };
    const config = {
      defaultProvider: "gateway",
      providers: {
        gateway: {
          adapter: "openai-responses",
          authMode: "key",
          apiKey: "test-key",
          baseUrl: "https://gateway.example/v1",
        },
      },
    } as OcxConfig;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gateway/test-model", input: "hello", stream: false }),
      }), config, logCtx);

      expect(response.status).toBe(200);
      expect(logCtx.providerAdapter).toBe("openai-responses");
      expect(logCtx.attempts).toEqual([expect.objectContaining({
        ordinal: 1,
        provider: "gateway",
        model: "test-model",
        adapter: "openai-responses",
        sendCount: 1,
      })]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("projects explicitly empty attempts from persisted usage", () => {
    const projected = requestLogEntryFromPersistedUsage({
      requestId: "ocx-empty-attempts",
      timestamp: 1,
      provider: "openai",
      model: "gpt-test",
      status: 200,
      durationMs: 1,
      usageStatus: "unreported",
      attempts: [],
    });

    expect(projected.attempts).toEqual([]);
  });

  test("records the adapter's exact outbound reasoning parameter", () => {
    const attempt = beginRequestAttempt(1, "xai", "grok-4.5", "openai-chat");
    const logCtx: RequestLogContext = {
      model: "grok-4.5",
      provider: "xai",
      requestedEffort: "max",
      activeAttempt: attempt,
    };

    recordAdapterReasoning(logCtx, {
      url: "https://api.x.ai/v1/chat/completions",
      method: "POST",
      headers: {},
      body: "{}",
      reasoningLog: {
        effectiveEffort: "high",
        wireField: "reasoning_effort",
        wireValue: "high",
      },
    });

    expect(logCtx).toMatchObject({
      requestedEffort: "max",
      effectiveEffort: "high",
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: "high",
    });
    expect(attempt).toMatchObject({
      requestedEffort: "max",
      effectiveEffort: "high",
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: "high",
    });

    const sensitiveAlias = ["sk", "proj", "redaction-fixture"].join("-");
    recordAdapterReasoning(logCtx, {
      url: "https://provider.test/v1/chat/completions",
      method: "POST",
      headers: {},
      body: "{}",
      reasoningLog: {
        effectiveEffort: sensitiveAlias,
        wireField: "reasoning_effort",
        wireValue: sensitiveAlias,
      },
    });
    expect(logCtx.effectiveEffort).not.toContain("redaction-fixture");
    expect(logCtx.reasoningWireValue).not.toContain("redaction-fixture");
    expect(attempt.effectiveEffort).not.toContain("redaction-fixture");
    expect(attempt.reasoningWireValue).not.toContain("redaction-fixture");
  });

  test("malformed adapter reasoning metadata never interrupts request logging", () => {
    const malformed = [
      { effectiveEffort: 123, wireField: "reasoning_effort", wireValue: 123 },
      { effectiveEffort: null, wireField: "reasoning_effort", wireValue: "high" },
      { effectiveEffort: {}, wireField: "reasoning_effort", wireValue: "high" },
      { effectiveEffort: "high", wireField: "unknown", wireValue: "high" },
      { effectiveEffort: "high", wireField: "reasoning_effort", wireValue: "" },
      { effectiveEffort: "high", wireField: "thinking_budget", wireValue: null },
      { effectiveEffort: "high", wireField: "thinking_budget", wireValue: {} },
      { effectiveEffort: "high", wireField: "thinking_budget", wireValue: Number.NaN },
      { effectiveEffort: "high", wireField: "thinking_budget", wireValue: -1 },
    ];

    for (const reasoningLog of malformed) {
      const attempt = beginRequestAttempt(1, "xai", "grok-4.5", "openai-chat");
      const logCtx: RequestLogContext = {
        model: "grok-4.5",
        provider: "xai",
        requestedEffort: "max",
        effectiveEffort: "stale",
        reasoningWireField: "reasoning_effort",
        reasoningWireValue: "stale",
        activeAttempt: attempt,
      };
      Object.assign(attempt, {
        effectiveEffort: "stale",
        reasoningWireField: "reasoning_effort",
        reasoningWireValue: "stale",
      });

      expect(() => recordAdapterReasoning(logCtx, {
        url: "https://provider.test/v1/chat/completions",
        method: "POST",
        headers: {},
        body: "{}",
        reasoningLog: reasoningLog as never,
      })).not.toThrow();
      expect(logCtx.effectiveEffort).toBeUndefined();
      expect(logCtx.reasoningWireField).toBeUndefined();
      expect(logCtx.reasoningWireValue).toBeUndefined();
      expect(attempt.requestedEffort).toBe("max");
      expect(attempt.effectiveEffort).toBeUndefined();
      expect(attempt.reasoningWireField).toBeUndefined();
      expect(attempt.reasoningWireValue).toBeUndefined();
    }
  });

  test("records a gateway reasoning disable as a boolean", () => {
    const logCtx: RequestLogContext = { model: "m", provider: "cline-pass" };
    recordAdapterReasoning(logCtx, {
      url: "https://api.cline.bot/api/v1/chat/completions",
      method: "POST",
      headers: {},
      body: "{}",
      reasoningLog: {
        effectiveEffort: "none",
        wireField: "reasoning.enabled",
        wireValue: false,
      },
    });

    expect(logCtx.reasoningWireValue).toBe(false);
  });

  test("recordFirstOutput is one-shot for request and active attempt (WP4 TTFT)", () => {
    const attempt = beginRequestAttempt(1, "a", "m1", "openai-chat");
    const logCtx: RequestLogContext = {
      model: "m1",
      provider: "a",
      activeAttempt: attempt,
      activeAttemptStartedAt: 1_000,
    };
    recordFirstOutput(logCtx, 500, 1_250);
    expect(logCtx.firstOutputMs).toBe(750);   // request-relative
    expect(attempt.firstOutputMs).toBe(250);  // attempt-relative
    // second call is a no-op
    recordFirstOutput(logCtx, 500, 9_999);
    expect(logCtx.firstOutputMs).toBe(750);
    expect(attempt.firstOutputMs).toBe(250);
    // invalid clock inputs never record
    const fresh: RequestLogContext = { model: "m", provider: "p" };
    recordFirstOutput(fresh, Number.NaN, 100);
    expect(fresh.firstOutputMs).toBeUndefined();
  });

  test("addFinalRequestLog preserves firstOutputMs; unset stays absent", () => {
    const captured: RequestLogEntry[] = [];
    addFinalRequestLog("ocx-ttft", 0, { model: "m", provider: "p", firstOutputMs: 12 }, 200, undefined, entry => captured.push(entry));
    expect(captured[0]?.firstOutputMs).toBe(12);
    const captured2: RequestLogEntry[] = [];
    addFinalRequestLog("ocx-nostream", 0, { model: "m", provider: "p" }, 200, undefined, entry => captured2.push(entry));
    expect(captured2[0]).not.toHaveProperty("firstOutputMs");
  });

  test("persists the shadow helper source marker to usage.jsonl", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-shadow-usage-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      addFinalRequestLog("ocx-shadow-marker", 1, {
        model: "grok-4.5",
        provider: "xai",
        requestedModel: "gpt-5.6-luna",
        shadowCallRewrittenFrom: "gpt-5.6-luna",
      }, 200);

      const [persisted] = readUsageEntries();
      expect(persisted?.shadowCallRewrittenFrom).toBe("gpt-5.6-luna");
      expect(getRequestLogEntries()[0]?.shadowCallRewrittenFrom).toBe("gpt-5.6-luna");
    } finally {
      clearRequestLogsForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      resetUsageReadCacheForTests();
      removeTreeWithRetry(home);
    }
  });

  // The value is caller-controlled, so proving it lands is only half the contract: the
  // persistence path must also be the SANITIZED one. A test that only ever writes a safe
  // short slug passes identically whether `sanitizeLogMetadataString` is applied or not.
  test("the shadow marker reaches usage.jsonl through the sanitizer, not raw", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-shadow-unsafe-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      addFinalRequestLog("ocx-shadow-unsafe", 1, {
        model: "grok-4.5",
        provider: "xai",
        // A newline would let one field forge a record boundary in a line-oriented log
        // viewer, and the trailing run is long enough to be over the 64-character bound.
        shadowCallRewrittenFrom: `gpt-5.6-luna\nInjected: yes ${"x".repeat(80)}`,
      }, 200);

      const [persisted] = readUsageEntries();
      const marker = persisted?.shadowCallRewrittenFrom;
      expect(marker).toBeDefined();
      expect(marker).not.toContain("\n");
      expect(marker!.length).toBeLessThanOrEqual(64);
      expect(marker!.startsWith("gpt-5.6-luna")).toBe(true);
      expect(getRequestLogEntries()[0]?.shadowCallRewrittenFrom).not.toContain("\n");
    } finally {
      clearRequestLogsForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      resetUsageReadCacheForTests();
      removeTreeWithRetry(home);
    }
  });

  // `addFinalRequestLog` is not the only ingress: `addRequestLog` is exported and callable
  // directly. Sanitizing only on the disk projection left the in-memory ring — and therefore
  // /api/logs — serving the raw value, which is the worst shape for a sanitization bug
  // because the surface you would check is the clean one.
  test("the direct addRequestLog ingress sanitizes memory and disk identically", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-shadow-ingress-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      addRequestLog({
        requestId: "ocx-shadow-direct",
        timestamp: Date.now(),
        provider: "xai",
        model: "grok-4.5",
        status: 200,
        shadowCallRewrittenFrom: `gpt-5.6-luna\nInjected: yes ${"x".repeat(80)}`,
      } as RequestLogEntry);

      const inMemory = getRequestLogEntries()[0]?.shadowCallRewrittenFrom;
      const [persisted] = readUsageEntries();
      expect(inMemory).toBeDefined();
      expect(inMemory).not.toContain("\n");
      expect(inMemory!.length).toBeLessThanOrEqual(64);
      // The two surfaces must agree: a divergence here is exactly the bug.
      expect(inMemory).toBe(persisted?.shadowCallRewrittenFrom);
    } finally {
      clearRequestLogsForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      resetUsageReadCacheForTests();
      removeTreeWithRetry(home);
    }
  });

  test("records ordered attempts with sealed identity, fresh estimates, and deduplicated recoveries", () => {
    const a = beginRequestAttempt(1, "provisional-a", "model-a", "openai-chat");
    noteAttemptSend(a, 100);
    noteAttemptSend(a, 120, "transient-5xx");
    noteAttemptSend(a, 120, "transient-5xx");
    sealRequestAttemptIdentity(a, "chatgpt-pabcdef", "openai-responses", "pabcdef");
    finishRequestAttempt(a, 503, 12);

    const b = beginRequestAttempt(2, "prov-b", "model-b", "openai-chat");
    noteAttemptSend(b, undefined);
    finishRequestAttempt(b, 200, 8, {
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 4,
      cacheReadInputTokens: 4,
    });

    expect(a).toMatchObject({
      ordinal: 1,
      provider: "chatgpt-pabcdef",
      accountLogLabel: "pabcdef",
      adapter: "openai-responses",
      status: 503,
      sendCount: 3,
      inputTokenEstimate: 120,
      recoveryKinds: ["transient-5xx"],
      usageStatus: "estimated",
      usage: { inputTokens: 120, outputTokens: 0, estimated: true },
      totalTokens: 120,
      errorCode: "server_is_overloaded",
    });
    expect(b).toMatchObject({ status: 200, sendCount: 1, usageStatus: "reported", totalTokens: 12 });

    expect(aggregateAttemptUsage([a, b])).toEqual({
      status: "estimated",
      totalTokens: 132,
      usage: {
        inputTokens: 130,
        outputTokens: 2,
        totalTokens: 132,
        cachedInputTokens: 4,
        cacheReadInputTokens: 4,
        estimated: true,
      },
    });
  });

  test("folds partial and unsupported attempt measurement honestly", () => {
    const reported = finishRequestAttempt(
      beginRequestAttempt(1, "a", "m1", "openai-chat"),
      200,
      1,
      { inputTokens: 4, outputTokens: 1 },
    );
    const unreported = finishRequestAttempt(
      beginRequestAttempt(2, "b", "m2", "openai-chat"),
      503,
      1,
    );
    expect(aggregateAttemptUsage([reported, unreported])).toMatchObject({
      status: "unreported",
      usage: { inputTokens: 4, outputTokens: 1 },
      totalTokens: 5,
    });
    const unsupportedA = { ...unreported, usageStatus: "unsupported" as const };
    const unsupportedB = { ...unreported, ordinal: 3, usageStatus: "unsupported" as const };
    expect(aggregateAttemptUsage([unsupportedA, unsupportedB])).toEqual({ status: "unsupported" });
  });

  test("final combo logging keeps one logical row and finalizes its active attempt", () => {
    const entries: RequestLogEntry[] = [];
    const a = beginRequestAttempt(1, "a", "model-a", "openai-chat");
    recordAdapterReasoning({
      model: "model-a",
      provider: "a",
      requestedEffort: "minimal",
      activeAttempt: a,
    }, {
      url: "https://provider-a.test/v1/chat/completions",
      method: "POST",
      headers: {},
      body: "{}",
      reasoningLog: {
        effectiveEffort: "low",
        wireField: "thinking_budget",
        wireValue: 0,
      },
    });
    finishRequestAttempt(
      a,
      503,
      3,
      { inputTokens: 4, outputTokens: 1 },
    );
    const b = beginRequestAttempt(2, "b", "model-b", "openai-chat");
    noteAttemptSend(b, undefined);
    const start = Date.now();
    const logCtx: RequestLogContext = {
      model: "combo/free",
      provider: "combo",
      requestedModel: "combo/free",
      requestedEffort: "max",
      comboId: "free",
      resolvedModel: "model-b",
      providerAdapter: "openai-chat",
      usage: { inputTokens: 10, outputTokens: 2 },
      attempts: [a, b],
      activeAttempt: b,
      activeAttemptStartedAt: start,
    };
    recordAdapterReasoning(logCtx, {
      url: "https://provider.test/v1/chat/completions",
      method: "POST",
      headers: {},
      body: "{}",
      reasoningLog: {
        effectiveEffort: "high",
        wireField: "reasoning_effort",
        wireValue: "high",
      },
    });
    addFinalRequestLog("combo-parent", start, logCtx, 200, undefined, entry => entries.push(entry));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: "combo",
      model: "combo/free",
      requestedModel: "combo/free",
      resolvedModel: "model-b",
      usageStatus: "reported",
      usage: { inputTokens: 14, outputTokens: 3, totalTokens: 17 },
      totalTokens: 17,
      attempts: [
        {
          provider: "a",
          status: 503,
          requestedEffort: "minimal",
          effectiveEffort: "low",
          reasoningWireField: "thinking_budget",
          reasoningWireValue: 0,
        },
        {
          provider: "b",
          status: 200,
          usage: { inputTokens: 10, outputTokens: 2 },
          requestedEffort: "max",
          effectiveEffort: "high",
          reasoningWireField: "reasoning_effort",
          reasoningWireValue: "high",
        },
      ],
    });
  });

  test("streaming terminal usage updates only the committed final attempt", async () => {
    const entries: RequestLogEntry[] = [];
    const attempt = beginRequestAttempt(1, "b", "model-b", "openai-chat");
    noteAttemptSend(attempt, undefined);
    const payload = JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        model: "model-b",
        usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(`data: ${payload}\n\n`, { headers: { "content-type": "text/event-stream" } }),
      "combo-stream",
      Date.now(),
      {
        model: "combo/free",
        provider: "combo",
        requestedModel: "combo/free",
        attempts: [attempt],
        activeAttempt: attempt,
        activeAttemptStartedAt: Date.now(),
      },
      entry => entries.push(entry),
    );
    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.attempts).toEqual([
      expect.objectContaining({
        ordinal: 1,
        status: 200,
        usageStatus: "reported",
        usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
      }),
    ]);
  });

  test("provider filtering matches attempts while status filtering remains parent-only", () => {
    const combo = log({
      provider: "combo",
      model: "combo/free",
      status: 200,
      attempts: [{
        ordinal: 1,
        provider: "a",
        model: "m1",
        adapter: "openai-chat",
        status: 503,
        durationMs: 2,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "unreported",
      }],
    });
    expect(filterRequestLogs([combo], new URLSearchParams("provider=a"))).toEqual([combo]);
    expect(filterRequestLogs([combo], new URLSearchParams("provider=a&status=503"))).toEqual([]);
  });

  test("records the Claude surface on the final log entry", () => {
    const entries: RequestLogEntry[] = [];
    addFinalRequestLog(
      "ocx-test-claude",
      Date.now(),
      { model: "claude-sonnet-4-5", provider: "openai", surface: "claude" },
      200,
      { closeReason: "non_stream" },
      entry => entries.push(entry),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ surface: "claude" });
  });

  test("cursor rows: adapter drives estimated status and the input estimate fills in:0 (devlog 130 B2)", () => {
    const entries: RequestLogEntry[] = [];
    addFinalRequestLog(
      "ocx-test-cursor",
      Date.now(),
      {
        model: "gpt-5.6-luna",
        provider: "cursor-pb51d9b",
        providerAdapter: "cursor",
        surface: "claude",
        usage: { inputTokens: 0, outputTokens: 98 },
        usageLogInputTokens: 44000,
      },
      200,
      { closeReason: "terminal" },
      entry => entries.push(entry),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.usageStatus).toBe("estimated");
    expect(entries[0]!.usage).toMatchObject({ inputTokens: 44000, outputTokens: 98, estimated: true });
  });

  test("accurate providers stay untouched when no input estimate is stashed", () => {
    const entries: RequestLogEntry[] = [];
    addFinalRequestLog(
      "ocx-test-anthropic",
      Date.now(),
      {
        model: "claude-fable-5",
        provider: "anthropic-pb51d9b",
        providerAdapter: "anthropic",
        surface: "claude",
        usage: { inputTokens: 353000, outputTokens: 2033, cachedInputTokens: 350000, cacheReadInputTokens: 350000, cacheCreationInputTokens: 1200 },
      },
      200,
      { closeReason: "terminal" },
      entry => entries.push(entry),
    );
    expect(entries[0]!.usageStatus).toBe("reported");
    expect(entries[0]!.usage).toMatchObject({ inputTokens: 353000, cacheReadInputTokens: 350000 });
    expect(entries[0]!.usage!.estimated).toBeUndefined();
  });

  test("generates compact request ids", () => {
    expect(nextRequestLogId(1_700_000_000_000)).toMatch(/^ocx-[a-f0-9]{32}$/);
    expect(nextRequestLogId(1_700_000_000_000)).not.toBe(nextRequestLogId(1_700_000_000_000));
  });

  test("classifies status codes with optional upstream error context", () => {
    expect(requestLogErrorCode(200)).toBeUndefined();
    expect(requestLogErrorCode(400)).toBe("invalid_request_error");
    expect(requestLogErrorCode(401)).toBe("invalid_api_key");
    expect(requestLogErrorCode(403)).toBe("permission_denied");
    expect(requestLogErrorCode(403, "Provider error 403")).toBe("permission_denied");
    expect(requestLogErrorCode(
      403,
      "Provider error 403: this model requires a subscription, upgrade for access: https://ollama.com/upgrade",
    )).toBe("subscription_required");
    expect(requestLogErrorCode(
      401,
      "Provider error 401: this model requires a subscription, upgrade for access",
    )).toBe("invalid_api_key");
    expect(requestLogErrorCode(429)).toBe("rate_limit_exceeded");
    expect(requestLogErrorCode(499)).toBe("client_closed_request");
    expect(requestLogErrorCode(502, "client closed request during web-search")).toBe("client_closed_request");
    expect(requestLogErrorCode(400, "blocked", "cyber_policy")).toBe("cyber_policy");
    expect(requestLogErrorCode(
      502,
      "This content was flagged for possible cybersecurity risk. To get authorized for security work, join the Trusted Access for Cyber program.",
    )).toBe("cyber_policy");
    expect(requestLogErrorCode(503)).toBe("server_is_overloaded");
    expect(requestLogErrorCode(502)).toBe("upstream_server_error");
    expect(requestLogErrorCode(404)).toBe("http_404");
    expect(requestLogErrorCode(418)).toBe("http_418");
  });

  test("final 403 logs use permission/subscription codes instead of invalid_api_key", () => {
    const entries: RequestLogEntry[] = [];
    addFinalRequestLog(
      "ocx-test-403-perm",
      Date.now(),
      {
        model: "kimi-k2.7-code",
        provider: "ollama-cloud",
        upstreamError: "Provider error 403",
      },
      403,
      { closeReason: "non_stream" },
      entry => entries.push(entry),
    );
    expect(entries[0]).toMatchObject({
      status: 403,
      errorCode: "permission_denied",
      upstreamError: "Provider error 403",
    });

    const subEntries: RequestLogEntry[] = [];
    addFinalRequestLog(
      "ocx-test-403-sub",
      Date.now(),
      {
        model: "kimi-k2.7-code",
        provider: "ollama-cloud",
        upstreamError: "Provider error 403: this model requires a subscription, upgrade for access: https://ollama.com/upgrade",
      },
      403,
      { closeReason: "non_stream" },
      entry => subEntries.push(entry),
    );
    expect(subEntries[0]).toMatchObject({
      status: 403,
      errorCode: "subscription_required",
    });
  });

  test("maps Codex fast service tier spellings to a display speed label", () => {
    expect(requestLogSpeedLabel("priority")).toBe("fast");
    expect(requestLogSpeedLabel("fast")).toBe("fast");
    expect(requestLogSpeedLabel(" PRIORITY ")).toBe("fast");
    expect(requestLogSpeedLabel("auto")).toBeUndefined();
    expect(requestLogSpeedLabel(undefined)).toBeUndefined();
  });

  test("filters logs by provider, status, and tail", () => {
    const logs = [
      log({ requestId: "a", provider: "openai", status: 200 }),
      log({ requestId: "b", provider: "umans", status: 429 }),
      log({ requestId: "c", provider: "umans", status: 502, requestedServiceTier: "priority", requestedSpeedLabel: "fast" }),
      log({ requestId: "d", provider: "opencode-go", status: 500 }),
    ];

    expect(filterRequestLogs(logs, new URLSearchParams("provider=umans")).map(entry => entry.requestId)).toEqual(["b", "c"]);
    expect(filterRequestLogs(logs, new URLSearchParams("status=5xx")).map(entry => entry.requestId)).toEqual(["c", "d"]);
    expect(filterRequestLogs(logs, new URLSearchParams("status=429")).map(entry => entry.requestId)).toEqual(["b"]);
    expect(filterRequestLogs(logs, new URLSearchParams("tail=2")).map(entry => entry.requestId)).toEqual(["c", "d"]);

    const combined = filterRequestLogs(logs, new URLSearchParams("provider=umans&status=5xx&tail=1"));
    expect(combined.map(entry => entry.requestId)).toEqual(["c"]);
  });

  /**
   * #2704: there was no `model` clause at all, so `?model=x` was accepted and silently
   * ignored -- every row came back, and `ocx logs --model x` looked like it had filtered.
   * The non-matching assertion is the one that matters: an unfiltered implementation passes
   * the positive case for free.
   */
  test("filters logs by model, including the attempt that actually served a failover", () => {
    const logs = [
      log({ requestId: "a", model: "gpt-test", provider: "openai" }),
      log({ requestId: "b", model: "grok-4.6", provider: "xai" }),
      log({
        requestId: "c",
        model: "sonnet-4.6",
        provider: "anthropic",
        attempts: [
          { ordinal: 1, provider: "anthropic", model: "sonnet-4.6", adapter: "anthropic", status: 429, durationMs: 5, sendCount: 1, recoveryKinds: [], usageStatus: "unreported" },
          { ordinal: 2, provider: "xai", model: "grok-4.6", adapter: "openai", status: 200, durationMs: 7, sendCount: 1, recoveryKinds: [], usageStatus: "reported" },
        ],
      }),
    ];

    expect(filterRequestLogs(logs, new URLSearchParams("model=gpt-test")).map(entry => entry.requestId)).toEqual(["a"]);
    // "c" matches on its second ATTEMPT, mirroring how `provider` already behaves: the request
    // was ultimately served by grok-4.6, so a grok-4.6 search has to find it.
    expect(filterRequestLogs(logs, new URLSearchParams("model=grok-4.6")).map(entry => entry.requestId)).toEqual(["b", "c"]);
    // The assertion an unfiltered implementation cannot pass.
    expect(filterRequestLogs(logs, new URLSearchParams("model=absent-model"))).toEqual([]);
    expect(filterRequestLogs(logs, new URLSearchParams("model=grok-4.6&provider=xai")).map(entry => entry.requestId)).toEqual(["b", "c"]);
  });

  test("filters logs by offset and limit", () => {
    const logs = Array.from({ length: 5 }, (_, i) => log({ requestId: `r${i}`, provider: "openai", status: 200 }));
    expect(filterRequestLogs(logs, new URLSearchParams("limit=2")).map(entry => entry.requestId)).toEqual(["r3", "r4"]);
    expect(filterRequestLogs(logs, new URLSearchParams("offset=2&limit=2")).map(entry => entry.requestId)).toEqual(["r1", "r2"]);
  });

  test("limit returns newest rows when buffer exceeds limit", () => {
    const logs = Array.from({ length: 10 }, (_, i) => log({ requestId: `r${i}`, provider: "openai", status: 200 }));
    expect(filterRequestLogs(logs, new URLSearchParams("limit=3")).map(entry => entry.requestId)).toEqual(["r7", "r8", "r9"]);
  });

  test("deferred JSON logging preserves response service tier before final log", async () => {
    const entries: RequestLogEntry[] = [];
    const logCtx = {
      model: "gpt-5.5",
      provider: "chatgpt-p000001",
      requestedModel: "gpt-5.5",
      requestedEffort: "xhigh",
      effectiveEffort: "high",
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: "high",
      requestedServiceTier: "priority",
      requestedSpeedLabel: requestLogSpeedLabel("priority"),
      configuredServiceTier: "fast",
      configuredSpeedLabel: requestLogSpeedLabel("fast"),
      modelSupportsServiceTier: true,
    };
    const response = responseWithDeferredRequestLog(
      new Response(JSON.stringify({
        model: "gpt-5.5",
        service_tier: "auto",
        status: "completed",
      }), { status: 200, headers: { "content-type": "application/json" } }),
      "ocx-test-json",
      Date.now(),
      logCtx,
      entry => entries.push(entry),
    );

    expect(await response.json()).toMatchObject({ model: "gpt-5.5", service_tier: "auto" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      requestedModel: "gpt-5.5",
      requestedEffort: "xhigh",
      effectiveEffort: "high",
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: "high",
      requestedServiceTier: "priority",
      requestedSpeedLabel: "fast",
      configuredServiceTier: "fast",
      configuredSpeedLabel: "fast",
      modelSupportsServiceTier: true,
      responseServiceTier: "auto",
      resolvedModel: "gpt-5.5",
      usageStatus: "unreported",
    });
  });

  test("client-facing response selectors do not replace the physical routed model", async () => {
    const entries: RequestLogEntry[] = [];
    const logCtx: RequestLogContext = {
      model: "claude-sonnet-5",
      provider: "anthropic",
      resolvedModel: "claude-sonnet-5",
      preserveResolvedModelFromRoute: true,
    };
    const response = responseWithDeferredRequestLog(
      new Response(JSON.stringify({
        model: "anthropic/claude-sonnet-5",
        status: "completed",
      }), { status: 200, headers: { "content-type": "application/json" } }),
      "ocx-test-routed-model",
      Date.now(),
      logCtx,
      entry => entries.push(entry),
    );

    expect(await response.json()).toMatchObject({ model: "anthropic/claude-sonnet-5" });
    expect(entries[0]?.resolvedModel).toBe("claude-sonnet-5");
  });

  test("deferred JSON logging captures reported usage", async () => {
    const entries: RequestLogEntry[] = [];
    const response = responseWithDeferredRequestLog(
      new Response(JSON.stringify({
        model: "gpt-5.5",
        status: "completed",
        usage: {
          input_tokens: 100,
          output_tokens: 23,
          input_tokens_details: { cached_tokens: 7, cache_write_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      "ocx-test-json-usage",
      Date.now(),
      { model: "gpt-5.5", provider: "openai" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      usageStatus: "reported",
      // input_tokens is inclusive of cache detail; total is input+output, never re-added
      totalTokens: 123,
      usage: {
        inputTokens: 100,
        outputTokens: 23,
        cachedInputTokens: 7,
        cacheReadInputTokens: 7,
        cacheCreationInputTokens: 3,
        reasoningOutputTokens: 5,
      },
    });
  });

  test("deferred JSON logging accepts ChatCompletions-shape usage", async () => {
    const entries: RequestLogEntry[] = [];
    const response = responseWithDeferredRequestLog(
      new Response(JSON.stringify({
        model: "gpt-5.5",
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      "ocx-test-json-chat-completions",
      Date.now(),
      { model: "gpt-5.5", provider: "chatgpt" },
      entry => entries.push(entry),
    );
    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      usageStatus: "reported",
      totalTokens: 49,
      usage: { inputTokens: 42, outputTokens: 7 },
    });
  });

  test("deferred SSE logging captures terminal reported usage", async () => {
    const entries: RequestLogEntry[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.5\",\"usage\":{\"input_tokens\":9,\"output_tokens\":4}}}\n\n",
        ));
        controller.close();
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-sse-usage",
      Date.now(),
      { model: "gpt-5.5", provider: "openai" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "completed",
      usageStatus: "reported",
      totalTokens: 13,
      usage: { inputTokens: 9, outputTokens: 4 },
    });
  });

  test("deferred SSE logging marks Kiro usage as estimated without changing SSE payload", async () => {
    const entries: RequestLogEntry[] = [];
    const payload = "{\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"model\":\"kiro/claude-sonnet-4.5\",\"usage\":{\"input_tokens\":9,\"output_tokens\":4}}}";
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
        controller.close();
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-kiro-sse-usage",
      Date.now(),
      { model: "kiro/claude-sonnet-4.5", provider: "kiro-p9d8524" },
      entry => entries.push(entry),
    );

    const text = await response.text();
    expect(text).toContain("\"usage\":{\"input_tokens\":9,\"output_tokens\":4}");
    expect(text).not.toContain("estimated");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "completed",
      usageStatus: "estimated",
      totalTokens: 13,
      usage: { inputTokens: 9, outputTokens: 4, estimated: true },
    });
  });

  test("deferred SSE logging captures the granular upstream reason from response.failed", async () => {
    const entries: RequestLogEntry[] = [];
    const cursorMessage = "Cursor rate limit exceeded: Cursor Connect error resource_exhausted: too many requests";
    const failedPayload = JSON.stringify({
      type: "response.failed",
      response: {
        error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: cursorMessage },
        last_error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: cursorMessage },
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${failedPayload}\n\n`));
        controller.close();
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-cursor-rate-limit",
      Date.now(),
      { model: "cursor/gpt-5", provider: "cursor" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "failed",
      upstreamError: cursorMessage,
      status: 429,
      errorCode: "rate_limit_exceeded",
    });
  });

  test("deferred SSE logging preserves structured cyber_policy status and code", async () => {
    const entries: RequestLogEntry[] = [];
    const failedPayload = JSON.stringify({
      type: "response.failed",
      response: {
        status: "failed",
        error: { type: "invalid_request_error", code: "cyber_policy", message: "blocked" },
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${failedPayload}\n\n`));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-cyber-policy",
      Date.now(),
      { model: "gpt-5.6-sol", provider: "openai" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "failed",
      upstreamError: "blocked",
      status: 400,
      errorCode: "cyber_policy",
      closeReason: "terminal",
    });
  });

  test("deferred SSE logging maps policy response.incomplete to failed 400", async () => {
    const entries: RequestLogEntry[] = [];
    const payload = JSON.stringify({
      type: "response.incomplete",
      response: {
        id: "resp-policy-incomplete",
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        error: { type: "invalid_request_error", code: "cyber_policy", message: "blocked" },
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: response.incomplete\ndata: ${payload}\n\n`));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-cyber-policy-incomplete",
      Date.now(),
      { model: "gpt-5.6-sol", provider: "openai" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "failed",
      upstreamError: "blocked",
      status: 400,
      errorCode: "cyber_policy",
      closeReason: "terminal",
    });
  });

  test("deferred SSE logging recognizes policy text from incomplete_details.message", async () => {
    const entries: RequestLogEntry[] = [];
    const policyMessage = "This request was flagged for possible cybersecurity risk.";
    const payload = JSON.stringify({
      type: "response.incomplete",
      response: {
        id: "resp-policy-incomplete-message",
        status: "incomplete",
        incomplete_details: {
          reason: "content_filter",
          message: policyMessage,
        },
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: response.incomplete\ndata: ${payload}\n\n`));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-cyber-policy-incomplete-message",
      Date.now(),
      { model: "gpt-5.6-sol", provider: "openai" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "failed",
      upstreamError: policyMessage,
      status: 400,
      errorCode: "cyber_policy",
      closeReason: "terminal",
    });
  });

  test("deferred SSE logging maps a policy top-level error to failed 400", async () => {
    const entries: RequestLogEntry[] = [];
    const payload = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "This request was flagged for possible cybersecurity risk." },
    });
    const response = responseWithDeferredRequestLog(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: error\ndata: ${payload}\n\n`));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-cyber-policy-error",
      Date.now(),
      { model: "gpt-5.6-sol", provider: "openai" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "failed",
      status: 400,
      errorCode: "cyber_policy",
      closeReason: "terminal",
    });
  });

  test("deferred SSE logging checks all policy candidates, not only the first code", async () => {
    const entries: RequestLogEntry[] = [];
    const payload = JSON.stringify({
      type: "response.incomplete",
      error: { type: "upstream_error", code: "upstream_reset", message: "connection ended" },
      response: {
        status: "incomplete",
        error: { type: "invalid_request_error", code: "cyber_policy", message: "blocked" },
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-cyber-policy-candidates",
      Date.now(),
      { model: "gpt-5.6-sol", provider: "openai" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "failed",
      status: 400,
      errorCode: "cyber_policy",
    });
  });

  test("deferred SSE logging maps ordinary failed status from response.error only", async () => {
    const entries: RequestLogEntry[] = [];
    const payload = JSON.stringify({
      type: "response.failed",
      code: "context_length_exceeded",
      response: {
        status: "failed",
        error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "rate limited" },
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-ordinary-failed-authority",
      Date.now(),
      { model: "gpt-5.6-sol", provider: "openai" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "failed",
      status: 429,
      errorCode: "rate_limit_exceeded",
    });
  });

  test("deferred SSE logging maps web-search client closes to 499 client_cancel", async () => {
    const entries: RequestLogEntry[] = [];
    const message = "client closed request during web-search";
    const failedPayload = JSON.stringify({
      type: "response.failed",
      response: {
        error: { type: "invalid_request_error", code: "client_closed_request", message },
        last_error: { type: "invalid_request_error", code: "client_closed_request", message },
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${failedPayload}\n\n`));
        controller.close();
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-web-search-client-close",
      Date.now(),
      { model: "k3", provider: "kimi" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "failed",
      upstreamError: message,
      status: 499,
      errorCode: "client_closed_request",
      closeReason: "client_cancel",
    });
  });

  test("addFinalRequestLog remaps legacy 502 client-close messages to 499", () => {
    const entries: RequestLogEntry[] = [];
    addFinalRequestLog(
      "ocx-test-legacy-client-close",
      Date.now(),
      {
        model: "k3",
        provider: "kimi",
        upstreamError: "client closed request during web-search",
      },
      502,
      { terminalStatus: "failed", closeReason: "terminal" },
      entry => entries.push(entry),
    );
    expect(entries[0]).toMatchObject({
      status: 499,
      errorCode: "client_closed_request",
      closeReason: "client_cancel",
      upstreamError: "client closed request during web-search",
    });
  });

  test("httpStatusFromTerminalError maps Cursor tool catalog limits to 400", () => {
    expect(httpStatusFromTerminalError({
      type: "invalid_request_error",
      code: "tool_catalog_too_large",
      message: "Cursor resource limit exceeded: tool catalog too large",
    })).toBe(400);
  });

  test("httpStatusFromTerminalError maps Cursor quota-style resource exhaustion to 429", () => {
    expect(httpStatusFromTerminalError({
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: "Cursor rate limit exceeded: Cursor Connect error resource limit exceeded: Error",
    })).toBe(429);
  });

  test("httpStatusFromTerminalError maps client-closed web-search aborts to 499", () => {
    expect(httpStatusFromTerminalError({
      type: "invalid_request_error",
      code: "client_closed_request",
      message: "client closed request during web-search",
    })).toBe(499);
    expect(httpStatusFromTerminalError({
      message: "client closed request during web-search",
    })).toBe(499);
  });

  test("httpStatusFromTerminalError preserves auth precedence and permission status", () => {
    expect(httpStatusFromTerminalError({
      type: "authentication_error",
      code: "invalid_api_key",
      message: "upgrade your subscription",
    })).toBe(401);
    expect(httpStatusFromTerminalError({
      type: "permission_error",
      code: "permission_denied",
      message: "Access denied",
    })).toBe(403);
    expect(httpStatusFromTerminalError({
      type: "permission_error",
      code: "subscription_required",
      message: "this model requires a subscription",
    })).toBe(403);
  });

  test("upstream reason capture redacts secret-shaped error messages", async () => {
    const entries: RequestLogEntry[] = [];
    const failedPayload = JSON.stringify({
      type: "response.failed",
      error: { message: "unauthorized: Bearer secret-leak-abc123" },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${failedPayload}\n\n`));
        controller.close();
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-cursor-redact",
      Date.now(),
      { model: "cursor/gpt-5", provider: "cursor" },
      entry => entries.push(entry),
    );

    const text = await response.text();
    expect(text).toContain("\"message\":\"unauthorized: Bearer secret-leak-abc123\"");
    expect(entries).toHaveLength(1);
    expect(entries[0].upstreamError).not.toContain("secret-leak-abc123");
    expect(entries[0].upstreamError).toContain("[REDACTED]");
  });

  test("plain-text upstream errors are captured in deferred logging", async () => {
    const entries: RequestLogEntry[] = [];
    const response = responseWithDeferredRequestLog(
      new Response("provider says nope", { status: 400, headers: { "content-type": "text/plain" } }),
      "ocx-test-plain-upstream-error",
      Date.now(),
      { model: "opencode-free/deepseek-v4-flash-free", provider: "opencode-free" },
      entry => entries.push(entry),
    );

    const text = await response.text();
    expect(text).toBe("provider says nope");
    expect(entries).toHaveLength(1);
    expect(entries[0].upstreamError).toBe("provider says nope");
  });

  test("deferred SSE logging uses adapter-provided Kiro log input tokens", async () => {
    const entries: RequestLogEntry[] = [];
    const payload = "{\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"model\":\"kiro/claude-sonnet-4.5\",\"usage\":{\"input_tokens\":9,\"output_tokens\":4}}}";
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
        controller.close();
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-kiro-sse-log-usage",
      Date.now(),
      { model: "kiro/claude-sonnet-4.5", provider: "kiro-p9d8524", usageLogInputTokens: 240_000 },
      entry => entries.push(entry),
    );

    const text = await response.text();
    expect(text).toContain("\"input_tokens\":9");
    expect(entries).toHaveLength(1);
    // The 240k estimate exceeds claude-sonnet-4.5's 200k window; a request the provider
    // answered cannot have exceeded the window, so the estimate is capped (codex-router PR #140).
    expect(entries[0]).toMatchObject({
      usageStatus: "estimated",
      totalTokens: 200_004,
      usage: { inputTokens: 200_000, outputTokens: 4, estimated: true },
    });
  });

  test("deferred logging preserves a bridged Kiro absolute context checkpoint", async () => {
    const entries: RequestLogEntry[] = [];
    const body = bridgeToResponsesSSE(replayAdapterEvents([{
      type: "done",
      usage: {
        inputTokens: 58,
        outputTokens: 100,
        contextTotalTokens: 50_000,
        estimated: true,
      },
    }]), "kiro/claude-opus-5");
    const response = responseWithDeferredRequestLog(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-kiro-context-checkpoint",
      Date.now(),
      { model: "kiro/claude-opus-5", provider: "kiro-p9d8524", usageLogInputTokens: 200 },
      entry => entries.push(entry),
    );

    const text = await response.text();
    expect(text).toContain('"input_tokens":49900');
    expect(text).toContain('"total_tokens":50000');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      usageStatus: "estimated",
      totalTokens: 50_000,
      usage: { inputTokens: 49_900, outputTokens: 100, totalTokens: 50_000, estimated: true },
    });
  });

  test("deferred logging keeps the checkpoint when the bridge reports raw usage (production path)", async () => {
    // Regression guard for the composition that shipped the bug. The test above exercises the
    // OLD source of logged usage: re-parsing the bridged wire, where responsesUsage() folds
    // contextTotalTokens into input_tokens/total_tokens. Production no longer does that —
    // responses/core.ts wires bridgeToResponsesSSE's onUsage callback, stores the RAW adapter
    // usage and sets usageFromBridge, which suppresses wire re-parsing. In that shape the
    // cumulative figure exists ONLY as contextTotalTokens, so usage-log normalization has to
    // carry the field or Kiro context growth vanishes from every persisted row.
    const entries: RequestLogEntry[] = [];
    let reportedRaw: OcxUsage | undefined;
    const logCtx: Partial<RequestLogContext> = {
      model: "kiro/claude-opus-5",
      provider: "kiro-p9d8524",
      usageLogInputTokens: 200,
    };
    const body = bridgeToResponsesSSE(
      replayAdapterEvents([{
        type: "done",
        usage: {
          inputTokens: 58,
          outputTokens: 100,
          contextTotalTokens: 50_000,
          estimated: true,
        },
      }]),
      "kiro/claude-opus-5",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        onUsage: usage => {
          // Mirror responses/core.ts: store RAW adapter usage and mark provenance so the
          // deferred logger does not re-parse the wire.
          reportedRaw = usage;
          logCtx.usageFromBridge = true;
          if (usage) logCtx.usage = usage;
        },
      },
    );
    const response = responseWithDeferredRequestLog(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-kiro-raw-usage-checkpoint",
      Date.now(),
      logCtx,
      entry => entries.push(entry),
    );
    await response.text();

    // The bridge hands the logger the RAW adapter usage, not the projected wire shape.
    expect(reportedRaw).toMatchObject({ inputTokens: 58, contextTotalTokens: 50_000 });
    expect(entries).toHaveLength(1);
    const logged = entries[0]?.usage;
    expect(logged?.contextTotalTokens).toBe(50_000);
    // Cache detail stays absent so cost estimation still reports cache_detail_missing —
    // the provenance behavior that the raw-usage change was introduced to protect.
    expect(logged && "cacheReadInputTokens" in logged).toBe(false);
    expect(logged && "cacheCreationInputTokens" in logged).toBe(false);

    // End-to-end: the checkpoint must also survive serialization to usage.jsonl. Asserting
    // only the in-memory entry would pass even while persistence silently drops the field,
    // which is exactly how the original regression escaped review.
    const home = mkdtempSync(join(tmpdir(), "ocx-req-log-usage-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      resetUsageReadCacheForTests();
      appendUsageEntry({
        requestId: entries[0]!.requestId,
        timestamp: entries[0]!.timestamp,
        provider: entries[0]!.provider,
        model: entries[0]!.model,
        status: entries[0]!.status,
        durationMs: entries[0]!.durationMs,
        usageStatus: entries[0]!.usageStatus,
        ...(logged ? { usage: logged } : {}),
      });
      const [persisted] = readUsageEntries();
      expect(persisted?.usage?.contextTotalTokens).toBe(50_000);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      resetUsageReadCacheForTests();
      removeTreeWithRetry(home);
    }
  });

  test("final logging shows numeric Kiro estimates even when SSE usage is absent", async () => {
    const entries: RequestLogEntry[] = [];
    const response = responseWithDeferredRequestLog(
      new Response(null, { status: 200 }),
      "ocx-test-kiro-fallback-log-usage",
      Date.now(),
      { model: "kiro/claude-opus-4.8", provider: "kiro-p442fff", usageLogInputTokens: 133_900 },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      usageStatus: "estimated",
      totalTokens: 133_900,
      usage: { inputTokens: 133_900, outputTokens: 0, estimated: true },
    });
  });

  test("deferred SSE logging surfaces upstream_stall_timeout reason as upstreamError", async () => {
    const entries: RequestLogEntry[] = [];
    const incompletePayload = JSON.stringify({
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "upstream_stall_timeout" },
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${incompletePayload}\n\n`));
        controller.close();
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-stall-timeout",
      Date.now(),
      { model: "cursor/kimi-k2.7-code", provider: "cursor" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "incomplete",
      status: 502,
      errorCode: "upstream_server_error",
    });
    expect(entries[0].upstreamError).toContain("upstream_stall_timeout");
    expect(entries[0].upstreamError).toContain("Upstream stalled");
  });

  test("deferred SSE logging treats the requested output limit as a successful terminal", async () => {
    const entries: RequestLogEntry[] = [];
    const incompletePayload = JSON.stringify({
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 9, output_tokens: 64 },
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${incompletePayload}\n\n`));
        controller.close();
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-requested-output-limit",
      Date.now(),
      { model: "anthropic/claude-sonnet-5", provider: "anthropic" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "incomplete",
      status: 200,
      usageStatus: "reported",
      usage: { inputTokens: 9, outputTokens: 64 },
      upstreamError: "Output reached the requested token limit (max_output_tokens)",
    });
    expect(entries[0]).not.toHaveProperty("errorCode");
  });

  test("deferred SSE logging surfaces adapter_eof reason as upstreamError", async () => {
    const entries: RequestLogEntry[] = [];
    const incompletePayload = JSON.stringify({
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "adapter_eof" },
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${incompletePayload}\n\n`));
        controller.close();
      },
    });
    const response = responseWithDeferredRequestLog(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      "ocx-test-adapter-eof",
      Date.now(),
      { model: "cursor/kimi-k2.7-code", provider: "cursor" },
      entry => entries.push(entry),
    );

    await response.text();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      terminalStatus: "incomplete",
      status: 502,
      errorCode: "upstream_server_error",
    });
    expect(entries[0].upstreamError).toContain("adapter_eof");
    expect(entries[0].upstreamError).toContain("ended unexpectedly");
  });
});

describe("request log restart hydrate", () => {
  test("projects persisted usage rows into /api/logs entries", () => {
    const persisted: PersistedUsageEntry = {
      requestId: "ocx-revive",
      timestamp: 1_800_000_000_000,
      provider: "chatgpt-pabcdef",
      model: "gpt-5.6-sol",
      requestedModel: "gpt-5.6-sol",
      shadowCallRewrittenFrom: "gpt-5.6-luna",
      requestedEffort: "high",
      effectiveEffort: "high",
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: "high",
      requestedServiceTier: "priority",
      requestedSpeedLabel: "fast",
      configuredServiceTier: "auto",
      modelSupportsServiceTier: true,
      status: 502,
      durationMs: 42,
      usageStatus: "unreported",
      errorCode: "upstream_server_error",
      terminalStatus: "failed",
      closeReason: "terminal",
      upstreamError: "socket connection was closed unexpectedly",
    };
    expect(requestLogEntryFromPersistedUsage(persisted)).toEqual({
      requestId: "ocx-revive",
      timestamp: 1_800_000_000_000,
      provider: "chatgpt-pabcdef",
      model: "gpt-5.6-sol",
      requestedModel: "gpt-5.6-sol",
      shadowCallRewrittenFrom: "gpt-5.6-luna",
      requestedEffort: "high",
      effectiveEffort: "high",
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: "high",
      requestedServiceTier: "priority",
      requestedSpeedLabel: "fast",
      configuredServiceTier: "auto",
      modelSupportsServiceTier: true,
      status: 502,
      durationMs: 42,
      usageStatus: "unreported",
      errorCode: "upstream_server_error",
      terminalStatus: "failed",
      closeReason: "terminal",
      upstreamError: "socket connection was closed unexpectedly",
    });
  });

  test("hydrateRequestLogsFromDisk restores the last ring of usage.jsonl after a process wipe", () => {
    clearRequestLogsForTests();
    expect(getRequestLogEntries()).toHaveLength(0);

    const persisted: PersistedUsageEntry[] = [
      {
        requestId: "ocx-old",
        timestamp: 1,
        provider: "openai",
        model: "gpt-a",
        status: 200,
        durationMs: 1,
        usageStatus: "reported",
        usage: { inputTokens: 1, outputTokens: 1 },
        totalTokens: 2,
      },
      {
        requestId: "ocx-sticky-502",
        timestamp: 2,
        provider: "openai",
        model: "gpt-b",
        requestedEffort: "xhigh",
        status: 502,
        durationMs: 9,
        usageStatus: "unreported",
        errorCode: "upstream_server_error",
        terminalStatus: "failed",
        closeReason: "terminal",
        upstreamError: "Provider unreachable",
        shadowCallRewrittenFrom: "gpt-5.6-luna",
      },
    ];

    expect(hydrateRequestLogsFromDisk(() => persisted)).toBe(2);
    expect(getRequestLogEntries().map(e => e.requestId)).toEqual(["ocx-old", "ocx-sticky-502"]);
    expect(getRequestLogEntries()[1]).toMatchObject({
      requestId: "ocx-sticky-502",
      status: 502,
      errorCode: "upstream_server_error",
      upstreamError: "Provider unreachable",
      requestedEffort: "xhigh",
      shadowCallRewrittenFrom: "gpt-5.6-luna",
    });

    // Idempotent: a second start in the same process must not duplicate.
    expect(hydrateRequestLogsFromDisk(() => persisted)).toBe(0);
    expect(getRequestLogEntries()).toHaveLength(2);
  });

  test("hydrate keeps only the newest MAX_LOG_SIZE rows from a long usage.jsonl", () => {
    clearRequestLogsForTests();
    const persisted: PersistedUsageEntry[] = Array.from({ length: 2005 }, (_, i) => ({
      requestId: `ocx-${i}`,
      timestamp: i,
      provider: "openai",
      model: "gpt",
      status: 200,
      durationMs: 1,
      usageStatus: "unreported" as const,
    }));
    expect(hydrateRequestLogsFromDisk(() => persisted)).toBe(2000);
    const ids = getRequestLogEntries().map(e => e.requestId);
    expect(ids[0]).toBe("ocx-5");
    expect(ids.at(-1)).toBe("ocx-2004");
  });

  test("hydrate swallows usage.jsonl read failures instead of crashing startup", () => {
    clearRequestLogsForTests();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(hydrateRequestLogsFromDisk(() => {
        throw new Error("EISDIR: illegal operation on a directory");
      })).toBe(0);
      expect(getRequestLogEntries()).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
      // Still idempotent after the failed attempt.
      expect(hydrateRequestLogsFromDisk(() => {
        throw new Error("should not run");
      })).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
