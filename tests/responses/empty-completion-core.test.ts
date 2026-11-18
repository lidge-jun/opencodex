import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import {
  providerRequestPacingStatus,
  resetProviderRequestPacingForTest,
  setProviderRequestPacingLimitsForTest,
  setProviderRequestPacingRuntimeForTest,
} from "../../src/providers/request-pacing";
import type { RequestLogContext } from "../../src/server/request-log";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const actualResolver = await import("../../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;

let attemptEvents: AdapterEvent[][] = [];
let runTurnCalls = 0;
let httpCalls = 0;
let parsedAttempts: OcxParsedRequest[] = [];
let builtBodies: string[] = [];
let customRunTurn: ProviderAdapter["runTurn"] | undefined;
let passthroughFetchCalls = 0;
let bodyObservationReleaseCalls = 0;
let releaseSpendHome: (() => void) | undefined;

// Direct dispatch needs the writer lease that startServer normally owns for this home.
const takeSpendHome = (): void => { releaseSpendHome ??= acquireOwnedSpendHome(); };

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
    async fetchResponse(request, context) {
      return context!.executor!(request.url, { method: request.method, headers: request.headers, body: request.body });
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
        await (_incoming as { providerFetch: typeof fetch }).providerFetch(provider.baseUrl, { method: "POST" });
        const index = runTurnCalls;
        runTurnCalls += 1;
        parsedAttempts.push(parsed);
        for (const event of attemptAt(index)) emit(event);
      },
    } : {}),
  };
}

mock.module("../../src/server/adapter-resolve", () => ({
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

const { handleResponses } = await import("../../src/server/responses");

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
  (result.providers.fixture as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch = async () => {
    const index = httpCalls;
    if (adapter === "test-http") httpCalls += 1;
    return new Response("", { headers: { "x-fixture-attempt": String(index) } });
  };
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
  // Release the preload-home lease before later teardown can replace or remove that home.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
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
    takeSpendHome();
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
    takeSpendHome();
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
    takeSpendHome();
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

    takeSpendHome();
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

      takeSpendHome();
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

      takeSpendHome();
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

    takeSpendHome();
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

    takeSpendHome();
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

    takeSpendHome();
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

    takeSpendHome();
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
    takeSpendHome();
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

    takeSpendHome();
    const response = await handleResponses(req, guarded, { model: "", provider: "" });
    const body = await response.text();

    expect(httpCalls).toBe(3);
    expect(builtBodies).toHaveLength(2);
    expect(builtBodies[1]).not.toBe(builtBodies[0]);
    expect(body).toContain("exec_command");
    expect(body.match(/event: response\.completed/g)).toHaveLength(1);
  });
});

describe("OpenGateway native empty completion", () => {
  const endpoint = "https://apis.opengateway.ai/v1/responses";
  const empty = (tokens = 1) => ({
    id: "resp_empty", object: "response", status: "completed",
    output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "", annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: tokens, output_tokens_details: { reasoning_tokens: tokens } },
  });
  const answer = () => ({ ...empty(2), id: "resp_answer", output: [
    { id: "msg_1", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "정상 답변", annotations: [] }] },
  ] });
  const sse = (snapshot: unknown, prefix: unknown[] = []) => new Response(
    [...prefix, { type: "response.completed", response: snapshot }]
      .map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
  function fixture(replies: (() => Response)[], url = endpoint, providerExtra: Partial<OcxProviderConfig> = {}) {
    const sends: { url: string; body: unknown }[] = [];
    const provider: OcxProviderConfig & { fetch?: typeof globalThis.fetch } = {
      adapter: "openai-responses", baseUrl: url.replace(/\/responses$/, ""),
      apiKey: "fixture-key", authMode: "key", models: ["model"], ...providerExtra,
      fetch: async (input, init) => {
        sends.push({ url: String(input), body: init?.body });
        return replies[Math.min(sends.length - 1, replies.length - 1)]?.() ?? Response.error();
      },
    };
    const cfg = { port: 0, defaultProvider: "fixture", providers: { fixture: provider } } satisfies OcxConfig;
    return { cfg, sends };
  }

  test("direct non-gateway reset selection bounds upstream silence (replayable=true)", async () => {
    takeSpendHome();
    jest.useFakeTimers();
    const firstRead = Promise.withResolvers<void>();
    let cancelled = 0;
    const f = fixture([() => new Response(new ReadableStream<Uint8Array>({
      pull() { firstRead.resolve(); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })],
    "https://fixture.test/v1/responses", { retryOnReset: { enabled: true, replacements: 1 } });
    const client = new AbortController();
    const pending = handleResponses(new Request(request(true, "question", { store: false }),
      { signal: client.signal }), { ...f.cfg, stallTimeoutSec: 20 }, { model: "", provider: "" });
    let returned = false;
    void pending.then(() => { returned = true; });
    try {
      await firstRead.promise;
      for (let i = 0; i < 50; i++) await Promise.resolve();
      jest.advanceTimersByTime(199);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(returned).toBe(false);
      // The quiet original's inspection window ends; its head is returned with a comment to carry it.
      jest.advanceTimersByTime(1);
      const response = await pending;
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(": keepalive");
      jest.advanceTimersByTime(19_799);
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(cancelled).toBe(0);
      jest.advanceTimersByTime(1);
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(cancelled).toBe(1);
      expect(f.sends).toHaveLength(1);
      await reader.cancel();
    } finally {
      client.abort();
      await pending.catch(() => undefined);
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("a direct request that cannot be replaced is relayed without reset selection", async () => {
    takeSpendHome();
    jest.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const f = fixture([() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })],
    "https://fixture.test/v1/responses", { retryOnReset: { enabled: true, replacements: 1 } });
    const client = new AbortController();
    // store defaults to true, so the resend gate could never fund a replacement for this turn.
    const pending = handleResponses(new Request(request(true, "question"), { signal: client.signal }),
      { ...f.cfg, stallTimeoutSec: 20 }, { model: "", provider: "" });
    try {
      // No timer has run: nothing held the head.
      const response = await pending;
      const reader = response.body!.getReader();
      source.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_open","status":"in_progress","output":[]}}\n\n'));
      // Nor the prelude, which a reset preflight would retain until output.
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("resp_open");
      // From here it is an ordinary native SSE relay; its silence belongs to the client's own clock.
      source.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"open"}\n\n'));
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"delta":"open"');
      expect(f.sends).toHaveLength(1);
      await reader.cancel();
    } finally {
      client.abort();
      await pending.catch(() => undefined);
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("direct reset selection resets its deadline on real upstream bytes", async () => {
    takeSpendHome();
    jest.useFakeTimers();
    const firstRead = Promise.withResolvers<void>();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = 0;
    const f = fixture([() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
      pull() { firstRead.resolve(); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })],
    "https://fixture.test/v1/responses", { retryOnReset: { enabled: true, replacements: 1 } });
    const client = new AbortController();
    const pending = handleResponses(new Request(request(true, "question", { store: false }), { signal: client.signal }),
      { ...f.cfg, stallTimeoutSec: 20 }, { model: "", provider: "" });
    try {
      await firstRead.promise;
      for (let i = 0; i < 50; i++) await Promise.resolve();
      jest.advanceTimersByTime(10_000);
      source.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"status":"in_progress","output":[]}}\n\n'));
      for (let i = 0; i < 50; i++) await Promise.resolve();
      jest.advanceTimersByTime(5_000);
      const response = await pending;
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(": keepalive");
      jest.advanceTimersByTime(14_999);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(cancelled).toBe(0);
      jest.advanceTimersByTime(1);
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(cancelled).toBe(1);
      expect(f.sends).toHaveLength(1);
      await reader.cancel();
    } finally {
      client.abort();
      await pending.catch(() => undefined);
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("direct reset replacement has its own silence deadline", async () => {
    takeSpendHome();
    jest.useFakeTimers();
    const replacementRead = Promise.withResolvers<void>();
    let cancelled = 0;
    const f = fixture([
      () => new Response('data: {"type":"response.created","response":{"status":"in_progress","output":[]}}\n\n',
        { headers: { "content-type": "text/event-stream" } }),
      () => new Response(new ReadableStream<Uint8Array>({
        pull() { replacementRead.resolve(); },
        cancel() { cancelled++; },
      }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }),
    ], "https://fixture.test/v1/responses", { retryOnReset: { enabled: true, replacements: 1 } });
    const client = new AbortController();
    const pending = handleResponses(new Request(request(true, "question", { store: false }), { signal: client.signal }),
      { ...f.cfg, stallTimeoutSec: 20 }, { model: "", provider: "" });
    try {
      const response = await pending;
      const reader = response.body!.getReader();
      const read = reader.read();
      await replacementRead.promise;
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(f.sends).toHaveLength(2);
      jest.advanceTimersByTime(15_000);
      jest.advanceTimersByTime(5_000);
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(cancelled).toBe(1);
      expect(f.sends).toHaveLength(2);
      await read.catch(() => undefined);
      await reader.cancel();
    } finally {
      client.abort();
      await pending.catch(() => undefined);
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("direct committed output remains visible when its source later stalls", async () => {
    takeSpendHome();
    jest.useFakeTimers();
    let cancelled = 0;
    let sent = false;
    const nextRead = Promise.withResolvers<void>();
    const f = fixture([() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"visible"}\n\n'));
        } else nextRead.resolve();
      },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })],
    "https://fixture.test/v1/responses", { retryOnReset: { enabled: true, replacements: 1 } });
    const client = new AbortController();
    const pending = handleResponses(new Request(request(true, "question", { store: false }), { signal: client.signal }),
      { ...f.cfg, stallTimeoutSec: 20 }, { model: "", provider: "" });
    try {
      const response = await pending;
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("visible");
      const read = reader.read();
      await nextRead.promise;
      for (let i = 0; i < 50; i++) await Promise.resolve();
      jest.advanceTimersByTime(20_000);
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(cancelled).toBe(1);
      expect(f.sends).toHaveLength(1);
      await read.catch(() => undefined);
      await reader.cancel();
    } finally {
      client.abort();
      await pending.catch(() => undefined);
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  for (const policy of ["explicit-off", "local-default"] as const) {
    test(`direct reset selection honors ${policy} and cancels on downstream abort`, async () => {
      takeSpendHome();
      jest.useFakeTimers();
      const firstRead = Promise.withResolvers<void>();
      let cancelled = 0;
      const f = fixture([() => new Response(new ReadableStream<Uint8Array>({
        pull() { firstRead.resolve(); },
        cancel() { cancelled++; return new Promise<void>(() => {}); },
      }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })],
      policy === "local-default" ? "http://127.0.0.1:7777/v1/responses" : "https://fixture.test/v1/responses",
      { retryOnReset: { enabled: true, replacements: 1 }, ...(policy === "local-default" ? { allowPrivateNetwork: true } : {}) });
      const client = new AbortController();
      const pending = handleResponses(new Request(request(true, "question", { store: false }), { signal: client.signal }),
        { ...f.cfg, ...(policy === "explicit-off" ? { stallTimeoutSec: 0 } : {}) }, { model: "", provider: "" });
      try {
        await firstRead.promise;
        for (let i = 0; i < 50; i++) await Promise.resolve();
        jest.advanceTimersByTime(15_000);
        const response = await pending;
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(": keepalive");
        jest.advanceTimersByTime(300_000);
        for (let i = 0; i < 50; i++) await Promise.resolve();
        expect(cancelled).toBe(0);
        client.abort();
        for (let i = 0; i < 100; i++) await Promise.resolve();
        expect(cancelled).toBe(1);
        expect(f.sends).toHaveLength(1);
        await reader.cancel().catch(() => {});
      } finally {
        client.abort();
        await pending.catch(() => undefined);
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });
  }

  test("reset preflight heartbeats cannot hide a silent OpenGateway upstream", async () => {
    takeSpendHome();
    jest.useFakeTimers();
    const firstRead = Promise.withResolvers<void>();
    let cancelled = 0;
    const f = fixture([() => new Response(new ReadableStream<Uint8Array>({
      pull() { firstRead.resolve(); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })],
    endpoint, { retryOnReset: { enabled: true, replacements: 1 } });
    const client = new AbortController();
    const req = request(true, "question", { store: false });
    const pending = handleResponses(new Request(req, { signal: client.signal }),
      { ...f.cfg, stallTimeoutSec: 20 }, { model: "", provider: "" });
    try {
      await firstRead.promise;
      for (let i = 0; i < 50; i++) await Promise.resolve();
      jest.advanceTimersByTime(15_000);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(cancelled).toBe(0);
      jest.advanceTimersByTime(5_000);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(cancelled).toBe(1);
      expect(f.sends).toHaveLength(1);
    } finally {
      client.abort();
      const response = await pending;
      await response.body?.cancel().catch(() => {});
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("combo preflight respects real OpenGateway activity before failover", async () => {
    takeSpendHome();
    jest.useFakeTimers();
    const firstRead = Promise.withResolvers<void>();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = 0;
    const f = fixture([() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
      pull() { firstRead.resolve(); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })],
    endpoint, { retryOnReset: { enabled: true, replacements: 1 } });
    let backupSends = 0;
    const backup = { ...f.cfg.providers.fixture!, baseUrl: "https://backup.example/v1", fetch: async () => {
      backupSends++;
      return sse(answer());
    } };
    const combo: OcxConfig = { ...f.cfg, stallTimeoutSec: 20,
      providers: { ...f.cfg.providers, backup },
      combos: { clock: { strategy: "failover", targets: [
        { provider: "fixture", model: "model" }, { provider: "backup", model: "model" },
      ] } },
    };
    const client = new AbortController();
    const req = request(true, "question", { model: "combo/clock", store: false });
    const pending = handleResponses(new Request(req, { signal: client.signal }), combo, { model: "", provider: "" });
    try {
      await firstRead.promise;
      for (let i = 0; i < 50; i++) await Promise.resolve();
      jest.advanceTimersByTime(10_000);
      source.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"status":"in_progress","output":[]}}\n\n'));
      for (let i = 0; i < 50; i++) await Promise.resolve();
      jest.advanceTimersByTime(10_000);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(cancelled).toBe(0);
      expect(backupSends).toBe(0);
      jest.advanceTimersByTime(5_000);
      source.enqueue(new TextEncoder().encode('data: {"type":"response.failed","response":{"status":"failed","error":{"type":"server_error","message":"busy"}}}\n\n'));
      source.close();
      const response = await pending;
      expect(await response.text()).toContain("resp_answer");
      expect(f.sends).toHaveLength(1);
      expect(backupSends).toBe(1);
    } finally {
      client.abort();
      await pending.catch(() => undefined);
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("direct OpenGateway streaming retains keepalives before its upstream stall deadline", async () => {
    takeSpendHome();
    jest.useFakeTimers();
    const firstRead = Promise.withResolvers<void>();
    let cancelled = 0;
    const f = fixture([() => new Response(new ReadableStream<Uint8Array>({
      pull() { firstRead.resolve(); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })],
    endpoint, { retryOnReset: { enabled: true, replacements: 1 } });
    const client = new AbortController();
    const req = request(true, "question", { store: false });
    const pending = handleResponses(new Request(req, { signal: client.signal }),
      { ...f.cfg, stallTimeoutSec: 40 }, { model: "", provider: "" });
    try {
      await firstRead.promise;
      for (let i = 0; i < 50; i++) await Promise.resolve();
      jest.advanceTimersByTime(15_000);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      jest.advanceTimersByTime(15_000);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      const response = await pending;
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain(": keepalive");
      expect(cancelled).toBe(0);
      expect(f.sends).toHaveLength(1);
      await reader.cancel();
    } finally {
      client.abort();
      await pending.catch(() => undefined);
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  for (const recovery of ["reset", "empty-completion"] as const) {
    test(`OpenGateway ${recovery} replacement keeps its own inactivity deadline`, async () => {
      takeSpendHome();
      jest.useFakeTimers();
      const replacementRead = Promise.withResolvers<void>();
      let cancelled = 0;
      const first = recovery === "reset"
        ? () => new Response('data: {"type":"response.created","response":{"status":"in_progress","output":[]}}\n\n',
          { headers: { "content-type": "text/event-stream" } })
        : () => sse(empty());
      const f = fixture([first, () => new Response(new ReadableStream<Uint8Array>({
        pull() { replacementRead.resolve(); },
        cancel() { cancelled++; },
      }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })],
      endpoint, { retryOnReset: { enabled: true, replacements: 1 } });
      const client = new AbortController();
      const req = request(true, "question", { store: false });
      const pending = handleResponses(new Request(req, { signal: client.signal }),
        { ...f.cfg, stallTimeoutSec: 20 }, { model: "", provider: "" });
      try {
        await replacementRead.promise;
        for (let i = 0; i < 50; i++) await Promise.resolve();
        expect(f.sends).toHaveLength(2);
        jest.advanceTimersByTime(20_000);
        for (let i = 0; i < 50; i++) await Promise.resolve();
        expect(cancelled).toBe(1);
        expect(f.sends).toHaveLength(2);
      } finally {
        client.abort();
        const response = await pending;
        await response.body?.cancel().catch(() => {});
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });
  }

  test("OpenGateway reset replacement can complete with its original output", async () => {
    takeSpendHome();
    const f = fixture([
      () => new Response('data: {"type":"response.created","response":{"status":"in_progress","output":[]}}\n\n',
        { headers: { "content-type": "text/event-stream" } }),
      () => sse(answer()),
    ], endpoint, { retryOnReset: { enabled: true, replacements: 1 } });
    const response = await handleResponses(request(true, "question", { store: false }), f.cfg, { model: "", provider: "" });
    expect(await response.text()).toContain("resp_answer");
    expect(f.sends).toHaveLength(2);
  });

  for (const streaming of [false, true]) {
    test(`native ${streaming ? "SSE" : "JSON"} exhausted reasoning becomes incomplete without replay`, async () => {
      const f = fixture([() => streaming ? sse(empty(16)) : Response.json(empty(16))]);
      takeSpendHome();
      const response = await handleResponses(request(streaming, "질문", { store: false, max_output_tokens: 16 }), f.cfg, { model: "", provider: "" });
      const text = await response.text();
      expect(text).toContain('"status":"incomplete"');
      expect(text).toContain('"reason":"max_output_tokens"');
      expect(text).not.toContain('"type":"response.completed"');
      expect(f.sends).toHaveLength(1);
    });

    test(`native ${streaming ? "SSE" : "JSON"} safe empty retries once and preserves first usage`, async () => {
      const f = fixture([
        () => streaming ? sse(empty(), [
          { type: "response.created", response: { id: "resp_empty", status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
          { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_1", part: { type: "output_text", text: "", annotations: [] } },
          { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_1", text: "" },
          { type: "response.content_part.done", output_index: 0, content_index: 0, item_id: "msg_1", part: { type: "output_text", text: "", annotations: [] } },
          { type: "response.output_item.done", output_index: 0, item: empty().output[0] },
        ]) : Response.json(empty()),
        () => streaming ? sse(answer()) : Response.json(answer()),
      ]);
      const logCtx: RequestLogContext = { model: "", provider: "" };
      takeSpendHome();
      const response = await handleResponses(request(streaming, "질문", { store: false, max_output_tokens: 1024 }), f.cfg, logCtx);
      expect(await response.text()).toContain("정상 답변");
      expect(f.sends).toHaveLength(2);
      expect(f.sends[1]).toEqual(f.sends[0]);
      expect(logCtx.activeAttempt).toMatchObject({ sendCount: 2, recoveryKinds: ["empty-completion"],
        usage: { inputTokens: 6, outputTokens: 3 } });
    });

    test(`native ${streaming ? "SSE" : "JSON"} second empty is an explicit failure`, async () => {
      const f = fixture([() => streaming ? sse(empty()) : Response.json(empty())]);
      takeSpendHome();
      const response = await handleResponses(request(streaming, "질문", { store: false }), f.cfg, { model: "", provider: "" });
      const text = await response.text();
      expect(text).toContain("empty_completion_retry_failed");
      if (streaming) expect(text).not.toContain('"type":"response.completed"');
      else expect(JSON.parse(text).status).toBe("failed");
      expect(f.sends).toHaveLength(2);
    });
  }

  test("native SSE leaves empty terminal snapshots untouched after the first text", async () => {
    const f = fixture([() => sse(empty(), [
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "남아야 할 답변" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_1", text: "" },
      { type: "response.output_item.done", output_index: 0, item: empty().output[0] },
    ])]);
    takeSpendHome();
    const response = await handleResponses(request(true, "질문", { store: false }), f.cfg, { model: "", provider: "" });
    const text = await response.text();
    const events = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(events.find(event => event.type === "response.output_text.delta")?.delta).toBe("남아야 할 답변");
    expect(events.find(event => event.type === "response.output_text.done")?.text).toBe("");
    expect(events.find(event => event.type === "response.completed")?.response.output[0].content[0].text).toBe("");
    expect(f.sends).toHaveLength(1);
  });

  test("native retry failure consumes only one replacement even on HTTP 503", async () => {
    const f = fixture([() => sse(empty()), () => new Response("unavailable", { status: 503 })]);
    takeSpendHome();
    const response = await handleResponses(request(true, "질문", { store: false }), f.cfg, { model: "", provider: "" });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("empty_completion_retry_failed");
    expect(f.sends).toHaveLength(2);
  });

  test("an empty recovery reset cannot claim another physical send", async () => {
    const f = fixture([
      () => sse(empty()),
      () => { throw Object.assign(new Error("fixture reset"), { code: "ECONNRESET" }); },
    ], endpoint, { retryOnReset: { enabled: true, replacements: 3 } });
    takeSpendHome();
    const response = await handleResponses(request(true, "question", { store: false }), f.cfg, { model: "", provider: "" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    await response.text();
    expect(f.sends).toHaveLength(2);
  });

  test("unsupported tool-result parts return 400 without an upstream send", async () => {
    const f = fixture([() => Response.json(answer())]);
    takeSpendHome();
    const response = await handleResponses(request(false, [
      { type: "function_call", call_id: "a", name: "echo", arguments: "{}" },
      { type: "function_call_output", call_id: "a", output: [
        { type: "input_text", text: "keep" }, { type: "input_file", file_id: "file_fixture" },
      ] },
    ], { store: false }), f.cfg, { model: "", provider: "" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: {
      type: "invalid_request_error", message: expect.stringContaining("OpenGateway cannot preserve this tool result"),
    } });
    expect(f.sends).toHaveLength(0);
  });

  test("native recovery cannot exceed a provider's explicit one-send budget", async () => {
    const f = fixture([() => sse(empty())], endpoint, { transientRetryOn5xx: { enabled: true, attempts: 1 } });
    takeSpendHome();
    const response = await handleResponses(request(true, "질문", { store: false }), f.cfg, { model: "", provider: "" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain("empty_completion_retry_failed");
    expect(f.sends).toHaveLength(1);
  });

  test("native JSON retry HTTP failure retains first usage exactly once", async () => {
    const f = fixture([() => Response.json(empty()), () => new Response("unavailable", { status: 503 })]);
    const logCtx: RequestLogContext = { model: "", provider: "" };
    takeSpendHome();
    const response = await handleResponses(request(false, "질문", { store: false }), f.cfg, logCtx);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("empty_completion_retry_failed");
    expect(f.sends).toHaveLength(2);
    expect(logCtx.activeAttempt?.usage).toMatchObject({ inputTokens: 3, outputTokens: 1 });
  });

  test("native recovery preserves upstream SSE even when the caller requested JSON", async () => {
    const f = fixture([() => sse(empty()), () => sse(answer())]);
    takeSpendHome();
    const response = await handleResponses(request(false, "질문", { store: false }), f.cfg, { model: "", provider: "" });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("정상 답변");
    expect(f.sends).toHaveLength(2);
  });

  for (const optOut of ["config", "environment"]) {
    test(`native ${optOut} opt-out prevents replay but still rejects empty success`, async () => {
      const f = fixture([() => sse(empty())]);
      if (optOut === "environment") process.env.OCX_EMPTY_COMPLETION_RETRY = "0";
      takeSpendHome();
      const response = await handleResponses(request(true, "질문", { store: false }),
        { ...f.cfg, ...(optOut === "config" ? { emptyCompletionRetry: false } : {}) }, { model: "", provider: "" });
      expect(await response.text()).toContain('"type":"response.failed"');
      expect(f.sends).toHaveLength(1);
    });
  }

  for (const url of ["https://other.test/v1/responses", "http://apis.opengateway.ai/v1/responses", "https://apis.opengateway.ai/other/responses"]) {
    test(`native empty guard does not expand to ${url}`, async () => {
      const f = fixture([() => Response.json(empty())], url);
      takeSpendHome();
      const response = await handleResponses(request(false, "질문", { store: false }), f.cfg, { model: "", provider: "" });
      expect(await response.text()).toContain('"status":"completed"');
      expect(f.sends).toHaveLength(1);
    });
  }
});
