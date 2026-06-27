import { describe, expect, test } from "bun:test";
import {
  filterRequestLogs,
  nextRequestLogId,
  responseWithDeferredRequestLog,
  requestLogErrorCode,
  requestLogSpeedLabel,
  type RequestLogEntry,
} from "../src/server";

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
  test("generates compact request ids", () => {
    expect(nextRequestLogId(1_700_000_000_000)).toMatch(/^ocx-[a-z0-9]+-[a-z0-9]+$/);
    expect(nextRequestLogId(1_700_000_000_000)).not.toBe(nextRequestLogId(1_700_000_000_000));
  });

  test("classifies status codes without reading response bodies", () => {
    expect(requestLogErrorCode(200)).toBeUndefined();
    expect(requestLogErrorCode(400)).toBe("invalid_request_error");
    expect(requestLogErrorCode(401)).toBe("invalid_api_key");
    expect(requestLogErrorCode(429)).toBe("rate_limit_exceeded");
    expect(requestLogErrorCode(499)).toBe("client_closed_request");
    expect(requestLogErrorCode(503)).toBe("server_is_overloaded");
    expect(requestLogErrorCode(502)).toBe("upstream_server_error");
    expect(requestLogErrorCode(404)).toBe("http_404");
    expect(requestLogErrorCode(418)).toBe("http_418");
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
          input_tokens_details: { cached_tokens: 7 },
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
      totalTokens: 123,
      usage: {
        inputTokens: 100,
        outputTokens: 23,
        cachedInputTokens: 7,
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
});
