import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import {
  providerRequestPacingStatus,
  resetProviderRequestPacingForTest,
  setProviderRequestPacingLimitsForTest,
  setProviderRequestPacingRuntimeForTest,
} from "../src/providers/request-pacing";
import type { RequestLogContext } from "../src/server/request-log";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

const actualResolver = await import("../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;

let attemptEvents: AdapterEvent[][] = [];
let runTurnCalls = 0;
let httpCalls = 0;
let parsedAttempts: OcxParsedRequest[] = [];
let builtBodies: string[] = [];
let customRunTurn: ProviderAdapter["runTurn"] | undefined;
let passthroughFetchCalls = 0;
let bodyObservationReleaseCalls = 0;

function attemptAt(index: number): AdapterEvent[] {
  return attemptEvents[index] ?? [{ type: "error", message: `missing fixture attempt ${index}` }];
}

function fixtureAdapter(provider: OcxProviderConfig): ProviderAdapter & { passthrough?: true } {
  const runTurn = provider.adapter === "test-run-turn";
  const passthrough = provider.adapter === "test-passthrough";
  return {
    name: runTurn ? "test-run-turn" : passthrough ? "test-passthrough" : "openai-chat",
    ...(passthrough ? { passthrough: true as const } : {}),
    buildRequest(parsed, incoming) {
      const rawBody = parsed._rawBody as { service_tier?: unknown } | undefined;
      const body = passthrough
        ? JSON.stringify(parsed._rawBody)
        : JSON.stringify({
            model: parsed.modelId,
            messages: parsed.context.messages,
            ...(rawBody?.service_tier !== undefined ? { service_tier: rawBody.service_tier } : {}),
          });
      builtBodies.push(body);
      const release = passthrough
        ? incoming.translatorBudget.observeExternallyCapped(
            "passthrough_serialization",
            Buffer.byteLength(body, "utf8"),
          )
        : undefined;
      return {
        url: provider.baseUrl,
        method: "POST",
        headers: {},
        body,
        ...(release ? {
          releaseBodyObservation: () => {
            bodyObservationReleaseCalls += 1;
            release();
          },
        } : {}),
      };
    },
    async fetchResponse() {
      const index = httpCalls;
      httpCalls += 1;
      return new Response("", { headers: { "x-fixture-attempt": String(index) } });
    },
    async *parseStream(response) {
      const index = Number(response.headers.get("x-fixture-attempt"));
      yield* attemptAt(index);
    },
    async parseResponse(response) {
      const index = Number(response.headers.get("x-fixture-attempt"));
      return attemptAt(index);
    },
    ...(runTurn ? {
      async runTurn(parsed: OcxParsedRequest, _incoming: unknown, emit: (event: AdapterEvent) => void) {
        if (customRunTurn) {
          await customRunTurn(parsed, _incoming as never, emit);
          return;
        }
        const index = runTurnCalls;
        runTurnCalls += 1;
        parsedAttempts.push(parsed);
        for (const event of attemptAt(index)) emit(event);
      },
    } : {}),
  };
}

mock.module("../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (
      provider.adapter === "test-run-turn"
      || provider.adapter === "test-http"
      || provider.adapter === "test-passthrough"
    ) {
      return fixtureAdapter(provider);
    }
    return actualResolveAdapter(provider, cacheRetention);
  },
}));

const { handleResponses } = await import("../src/server/responses");

function config(
  adapter: "test-run-turn" | "test-http" | "test-passthrough",
  extra: Partial<OcxConfig> = {},
): OcxConfig {
  const result = {
    port: 0,
    defaultProvider: "fixture",
    emptyCompletionRetry: true,
    providers: {
      fixture: {
        adapter,
        baseUrl: "https://fixture.test/v1",
        apiKey: "fixture-key",
        authMode: "key",
        models: ["model"],
      },
    },
    ...extra,
  } as OcxConfig;
  if (adapter === "test-passthrough") {
    (result.providers.fixture as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch = async () => {
      passthroughFetchCalls += 1;
      return Response.json({
        id: "resp_fixture",
        object: "response",
        status: "completed",
        output: [],
      });
    };
  }
  return result;
}

function request(
  stream: boolean,
  input: unknown = "please answer",
  extra: Record<string, unknown> = {},
): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/model", input, stream, ...extra }),
  });
}

beforeEach(() => {
  attemptEvents = [];
  runTurnCalls = 0;
  httpCalls = 0;
  parsedAttempts = [];
  builtBodies = [];
  customRunTurn = undefined;
  passthroughFetchCalls = 0;
  bodyObservationReleaseCalls = 0;
});

afterEach(() => {
  resetProviderRequestPacingForTest();
  delete process.env.OCX_EMPTY_COMPLETION_RETRY;
});

describe("empty-completion core integration", () => {
  test("an unconfigured limit sends an oversized passthrough body upstream", async () => {
    // The regression guard for this whole feature. A default ceiling here would refuse turns
    // that succeed today: the one measured limit in this codebase is the WS create-frame size,
    // and that transport already falls back to HTTP SSE for exactly these bodies (#2473), with
    // an 18.2 MB HTTP 200 observed in #2426. Unset must mean "send it", not "guess a ceiling".
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      request(false, "x".repeat(20 * 1024 * 1024)),
      config("test-passthrough"),
      logCtx,
    );

    expect(response.status).toBe(200);
    expect(passthroughFetchCalls).toBe(1);
    expect(logCtx.errorCode).toBeUndefined();
  });

  test("an oversized passthrough body is refused locally and releases its observation", async () => {
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      request(false, "x".repeat(512)),
      config("test-passthrough", { maxUpstreamBodyBytes: 128 }),
      logCtx,
    );
    const body = await response.json() as { error?: { code?: string } };

    expect(response.status).toBe(413);
    expect(body.error?.code).toBe("outbound_body_too_large");
    expect(logCtx.errorCode).toBe("outbound_body_too_large");
    expect(passthroughFetchCalls).toBe(0);
    expect(bodyObservationReleaseCalls).toBe(1);
  });

  test("a streaming refusal is terminal overflow, not a retryable 413", async () => {
    // Codex resends on an HTTP 413, so the shape that stops the loop is response.failed with
    // context_length_exceeded — the same contract the upstream-413 path already returns (#3177).
    const response = await handleResponses(
      request(true, "x".repeat(512)),
      config("test-passthrough", { maxUpstreamBodyBytes: 128 }),
      { model: "", provider: "" },
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("response.failed");
    expect(text).toContain("context_length_exceeded");
    expect(passthroughFetchCalls).toBe(0);
  });

  test("a normal-sized passthrough body still reaches upstream", async () => {
    const response = await handleResponses(
      request(false),
      config("test-passthrough", { maxUpstreamBodyBytes: 4_096 }),
      { model: "", provider: "" },
    );

    expect(response.status).toBe(200);
    expect(passthroughFetchCalls).toBe(1);
    expect(bodyObservationReleaseCalls).toBe(1);
  });

  test("an explicit zero limit lets an oversized turn reach upstream", async () => {
    const response = await handleResponses(
      request(false, "x".repeat(512)),
      config("test-passthrough", { maxUpstreamBodyBytes: 0 }),
      { model: "", provider: "" },
    );

    expect(response.status).toBe(200);
    expect(passthroughFetchCalls).toBe(1);
  });

  test("streaming runTurn returns the local 429 contract when initial pacing admission is rejected", async () => {
    setProviderRequestPacingLimitsForTest({ maxQueueDepth: 0 });
    const overloaded = config("test-run-turn");
    overloaded.providers.fixture!.requestPacing = { enabled: true, minIntervalMs: 100 };

    const response = await handleResponses(request(true), overloaded, { model: "", provider: "" });
    const body = await response.json() as { error?: { type?: string } };

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(body.error?.type).toBe("rate_limit_error");
    expect(runTurnCalls).toBe(0);
  });

  test("streaming runTurn closes with an in-band error when retry pacing admission is rejected", async () => {
    const paced = config("test-run-turn");
    paced.providers.fixture!.requestPacing = { enabled: true, minIntervalMs: 100 };
    customRunTurn = async (parsed, _incoming, emit) => {
      runTurnCalls += 1;
      parsedAttempts.push(parsed);
      setProviderRequestPacingLimitsForTest({ maxQueueDepth: 0 });
      emit({ type: "done" });
    };

    const response = await handleResponses(request(true), paced, { model: "", provider: "" });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    const completed = (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return "complete" as const;
        body += decoder.decode(chunk.value, { stream: true });
      }
    })();
    const outcome = await Promise.race([
      completed,
      Bun.sleep(100).then(() => "timeout" as const),
    ]);
    if (outcome === "timeout") await reader.cancel("test timeout");

    expect(outcome).toBe("complete");
    expect(body).toContain("empty_completion_retry_failed");
    expect(runTurnCalls).toBe(1);
  });

  for (const stream of [true, false]) {
    test(`runTurn ${stream ? "streaming" : "non-streaming"} retries on a fresh queue`, async () => {
      attemptEvents = [
        [{ type: "thinking_delta", thinking: "first" }, { type: "done", usage: { inputTokens: 3, outputTokens: 0 } }],
        [{ type: "text_delta", text: "answer" }, { type: "done", usage: { inputTokens: 4, outputTokens: 1 } }],
      ];
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const response = await handleResponses(request(stream), config("test-run-turn"), logCtx);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(runTurnCalls).toBe(2);
      expect(parsedAttempts[1]).toBe(parsedAttempts[0]);
      expect(body).toContain("answer");
      if (stream) expect(body.match(/event: response\.completed/g)).toHaveLength(1);
      expect(logCtx.activeAttempt).toMatchObject({
        sendCount: 2,
        recoveryKinds: ["empty-completion"],
        usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 },
      });
    });

    test(`HTTP ${stream ? "streaming" : "non-streaming"} replays the identical request once`, async () => {
      attemptEvents = [
        [{ type: "done", usage: { inputTokens: 2, outputTokens: 0 } }],
        [{ type: "text_delta", text: "http answer" }, { type: "done", usage: { inputTokens: 5, outputTokens: 2 } }],
      ];
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const response = await handleResponses(request(stream), config("test-http"), logCtx);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(httpCalls).toBe(2);
      expect(builtBodies).toHaveLength(1);
      expect(body).toContain("http answer");
      expect(logCtx.activeAttempt).toMatchObject({
        sendCount: 2,
        recoveryKinds: ["empty-completion"],
      });
    });
  }

  test("the identical HTTP retry consumes a second provider pacing slot", async () => {
    let now = 0;
    setProviderRequestPacingRuntimeForTest({
      now: () => now,
      setTimer: (callback, delayMs) => {
        now += delayMs;
        queueMicrotask(callback);
        return callback;
      },
      clearTimer() {},
      enqueueMicrotask: callback => callback(),
    });
    attemptEvents = [
      [{ type: "done" }],
      [{ type: "text_delta", text: "paced answer" }, { type: "done" }],
    ];
    const paced = config("test-http");
    paced.providers.fixture!.requestPacing = { enabled: true, minIntervalMs: 100 };

    const response = await handleResponses(request(false), paced, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(httpCalls).toBe(2);
    expect(providerRequestPacingStatus("fixture", paced.providers.fixture!)).toMatchObject({
      lastStartedAt: 100,
      lastModelId: "model",
    });
  });

  test("the identical retry replays bytes after the service-tier gate", async () => {
    attemptEvents = [
      [{ type: "done" }],
      [{ type: "text_delta", text: "tier-safe answer" }, { type: "done" }],
    ];
    const tierGated = config("test-http");
    tierGated.providers.fixture!.supportsServiceTier = false;

    const response = await handleResponses(
      request(false, "please answer", { service_tier: "priority" }),
      tierGated,
      { model: "", provider: "" },
    );
    expect(response.status).toBe(200);
    expect(httpCalls).toBe(2);
    expect(builtBodies).toHaveLength(1);
    expect(JSON.parse(builtBodies[0]!) as Record<string, unknown>).not.toHaveProperty("service_tier");
  });

  test("the top-level gate defaults off so unrelated empty replay paths keep one send", async () => {
    attemptEvents = [
      [{ type: "done" }],
      [{ type: "text_delta", text: "must not run" }, { type: "done" }],
    ];
    const disabled = config("test-run-turn");
    delete disabled.emptyCompletionRetry;

    const response = await handleResponses(request(false), disabled, { model: "", provider: "" });
    await response.text();

    expect(runTurnCalls).toBe(1);
  });

  test("buffered reasoning keeps the streaming stall watchdog alive", async () => {
    customRunTurn = async (_parsed, _incoming, emit) => {
      const index = runTurnCalls;
      runTurnCalls += 1;
      if (index === 0) {
        for (let i = 0; i < 5; i += 1) {
          emit({ type: "thinking_delta", thinking: `step-${i}` });
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        emit({ type: "done" });
        return;
      }
      emit({ type: "text_delta", text: "answer after reasoning" });
      emit({ type: "done" });
    };

    const response = await handleResponses(
      request(true),
      config("test-run-turn", { stallTimeoutSec: 0.05 }),
      { model: "", provider: "" },
    );
    const body = await response.text();

    expect(runTurnCalls).toBe(2);
    expect(body).toContain("answer after reasoning");
    expect(body).not.toContain("upstream_stall_timeout");
  });

  test("combo and routed-compaction turns are excluded from the retry", async () => {
    attemptEvents = [[{ type: "done" }], [{ type: "text_delta", text: "must not run" }, { type: "done" }]];
    const combo = await handleResponses(
      request(false),
      config("test-run-turn"),
      { model: "", provider: "" },
      { comboAttempt: true },
    );
    await combo.text();
    expect(runTurnCalls).toBe(1);

    runTurnCalls = 0;
    attemptEvents = [[{ type: "done" }], [{ type: "text_delta", text: "must not run" }, { type: "done" }]];
    const compactionInput = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "earlier" }] },
      { type: "compaction_trigger" },
    ];
    const compaction = await handleResponses(
      request(false, compactionInput),
      config("test-run-turn"),
      { model: "", provider: "" },
    );
    await compaction.text();
    expect(runTurnCalls).toBe(1);
  });

  test("an identical empty retry still receives terminal-guard repair", async () => {
    attemptEvents = [
      [{ type: "done" }],
      [{ type: "text_delta", text: "我接下来会修改相关文件。" }, { type: "done" }],
      [
        { type: "tool_call_start", id: "call_1", name: "exec_command" },
        { type: "tool_call_delta", arguments: "{}" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    ];
    const guarded = config("test-http");
    guarded.providers.fixture!.terminalContinuationGuard = true;
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture/model",
        input: "请检查这个问题并修复代码",
        stream: true,
        tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      }),
    });

    const response = await handleResponses(req, guarded, { model: "", provider: "" });
    const body = await response.text();

    expect(httpCalls).toBe(3);
    expect(builtBodies).toHaveLength(2);
    expect(builtBodies[1]).not.toBe(builtBodies[0]);
    expect(body).toContain("exec_command");
    expect(body.match(/event: response\.completed/g)).toHaveLength(1);
  });
});
