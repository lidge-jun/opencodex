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
  beginRequestAttempt,
  clearRequestLogsForTests,
  finishRequestAttempt,
  getRequestLogEntries,
  hydrateRequestLogsFromDisk,
  noteAttemptSend,
  recordFirstOutput,
  requestLogEntryFromPersistedUsage,
  sealRequestAttemptIdentity,
  type RequestLogContext,
} from "../src/server/request-log";
import type { PersistedUsageEntry } from "../src/usage/log";

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

  test("records ordered attempts with sealed identity, fresh estimates, and deduplicated recoveries", () => {
    const a = beginRequestAttempt(1, "provisional-a", "model-a", "openai-chat");
    noteAttemptSend(a, 100);
    noteAttemptSend(a, 120, "transient-5xx");
    noteAttemptSend(a, 120, "transient-5xx");
    sealRequestAttemptIdentity(a, "chatgpt-pabcdef", "openai-responses");
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
    const a = finishRequestAttempt(
      beginRequestAttempt(1, "a", "model-a", "openai-chat"),
      503,
      3,
      { inputTokens: 4, outputTokens: 1 },
    );
    const b = beginRequestAttempt(2, "b", "model-b", "openai-chat");
    noteAttemptSend(b, undefined);
    const start = Date.now();
    addFinalRequestLog("combo-parent", start, {
      model: "combo/free",
      provider: "combo",
      requestedModel: "combo/free",
      resolvedModel: "model-b",
      providerAdapter: "openai-chat",
      usage: { inputTokens: 10, outputTokens: 2 },
      attempts: [a, b],
      activeAttempt: b,
      activeAttemptStartedAt: start,
    }, 200, undefined, entry => entries.push(entry));

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
        { provider: "a", status: 503 },
        { provider: "b", status: 200, usage: { inputTokens: 10, outputTokens: 2 } },
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
    expect(nextRequestLogId(1_700_000_000_000)).toMatch(/^ocx-[a-z0-9]+-[a-z0-9]+$/);
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

  test("deferred JSON logging preserves response service tier before final log", async () => {
    const entries: RequestLogEntry[] = [];
    const logCtx = {
      model: "gpt-5.5",
      provider: "chatgpt-p000001",
      requestedModel: "gpt-5.5",
      requestedEffort: "xhigh",
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
    expect(entries[0]).toMatchObject({
      usageStatus: "estimated",
      totalTokens: 240_004,
      usage: { inputTokens: 240_000, outputTokens: 4, estimated: true },
    });
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
      requestedEffort: "high",
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
      requestedEffort: "high",
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
    });

    // Idempotent: a second start in the same process must not duplicate.
    expect(hydrateRequestLogsFromDisk(() => persisted)).toBe(0);
    expect(getRequestLogEntries()).toHaveLength(2);
  });

  test("hydrate keeps only the newest MAX_LOG_SIZE rows from a long usage.jsonl", () => {
    clearRequestLogsForTests();
    const persisted: PersistedUsageEntry[] = Array.from({ length: 205 }, (_, i) => ({
      requestId: `ocx-${i}`,
      timestamp: i,
      provider: "openai",
      model: "gpt",
      status: 200,
      durationMs: 1,
      usageStatus: "unreported" as const,
    }));
    expect(hydrateRequestLogsFromDisk(() => persisted)).toBe(200);
    const ids = getRequestLogEntries().map(e => e.requestId);
    expect(ids[0]).toBe("ocx-5");
    expect(ids.at(-1)).toBe("ocx-204");
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
