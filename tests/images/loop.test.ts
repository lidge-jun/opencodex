import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderAdapter, IncomingMeta } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import type { ImageBridgePlan, ImageCallResult } from "../../src/images/types";
import type { ImageBridgeDeps } from "../../src/images/loop";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const PREV_HOME = process.env.OPENCODEX_HOME;
let runWithImageBridgeProduction: typeof import("../../src/images/loop")["runWithImageBridge"];
let clampImageMaxRounds: typeof import("../../src/images/loop")["clampImageMaxRounds"];
let DEFAULT_MAX_ROUNDS: typeof import("../../src/images/loop")["DEFAULT_MAX_ROUNDS"];
let MAX_ROUNDS_HARD_LIMIT: typeof import("../../src/images/loop")["MAX_ROUNDS_HARD_LIMIT"];

let fulfillResult: ImageCallResult = {
  ok: true, model: "grok-imagine-image-quality", prompt: "a cat",
  files: ["/test/img.png"], count: 1, markdown: "![image](/test/img.png)",
};

beforeAll(async () => {
  process.env.OPENCODEX_HOME = join(tmpdir(), "ocx-test-" + randomUUID());
  mock.restore();
  mock.module("../../src/web-search/progress-stream", () => ({
    parseStreamWithProgress: async function* (_resp: Response, parse: (r: Response) => AsyncGenerator<AdapterEvent>, _opts: unknown) {
      for await (const e of parse(_resp)) yield e;
    },
    RoutedModelInactivityError: class extends Error { readonly timeoutMs = 0; },
    WebSearchStreamProtocolError: class extends Error { /* */ },
  }));
  mock.module("../../src/images/fulfill", () => ({
    fulfillImageCall: async (): Promise<ImageCallResult> => fulfillResult,
  }));
  ({
    runWithImageBridge: runWithImageBridgeProduction,
    clampImageMaxRounds,
    DEFAULT_MAX_ROUNDS,
    MAX_ROUNDS_HARD_LIMIT,
  } = await import("../../src/images/loop"));
});

function runWithImageBridge(
  deps: Omit<ImageBridgeDeps, "incomingMeta"> & { incomingMeta?: ImageBridgeDeps["incomingMeta"] },
): Promise<Response> {
  return runWithImageBridgeProduction({
    ...deps,
    incomingMeta: deps.incomingMeta ?? {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    },
  });
}
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; mock.restore(); });

// --- Mock adapter: yields canned events per iteration from a queue ---
let streamQueue: AdapterEvent[][] = [];
let buildRequestCalls = 0;

const defaultFulfillResult: ImageCallResult = {
  ok: true, model: "grok-imagine-image-quality", prompt: "a cat",
  files: ["/test/img.png"], count: 1, markdown: "![image](/test/img.png)",
};
beforeEach(() => {
  fulfillResult = { ...defaultFulfillResult, files: [...defaultFulfillResult.files] };
  buildRequestCalls = 0;
  streamQueue = [];
});

const mockAdapter: ProviderAdapter = {
  name: "test",
  buildRequest: async () => { buildRequestCalls++; return { url: "https://test/v1/chat", method: "POST", headers: {}, body: "{}" }; },
  fetchResponse: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  parseStream: async function* (): AsyncGenerator<AdapterEvent> {
    const events = streamQueue.shift();
    if (events) for (const e of events) yield e;
  },
};

const plan = {
  provider: {} as never,
  auth: { baseUrl: "https://api.x.ai", token: "test-token" },
  model: "grok-imagine-image-quality",
  toolNames: new Set(["image_gen"]),
} as ImageBridgePlan;

function makeParsed(): OcxParsedRequest {
  return { modelId: "test-model", context: { messages: [], tools: [] }, stream: true, options: {} } as OcxParsedRequest;
}

const imageCallEvents: AdapterEvent[] = [
  { type: "tool_call_start", id: "call_1", name: "image_gen" },
  { type: "tool_call_delta", arguments: '{"prompt":"a cat"}' },
  { type: "tool_call_end" },
  { type: "done" },
];

/** Run the image bridge with the given per-iteration event streams and return the client-facing SSE text. */
async function runAndGetSSE(streams: AdapterEvent[][], fulfill?: ImageCallResult): Promise<string> {
  streamQueue = streams.map(s => [...s]);
  if (fulfill) fulfillResult = fulfill;
  const response = await runWithImageBridge({ parsed: makeParsed(), adapter: mockAdapter, plan });
  return await response.text();
}

describe("runWithImageBridge", () => {
  test("translator overflow remains typed through the image loop and bridge", async () => {
    const sse = await runAndGetSSE([[
      {
        type: "error",
        status: 502,
        errorType: "upstream_error",
        code: "translation_buffer_limit",
        message: "upstream translation buffer exceeded the safe limit",
      },
    ]]);
    expect(sse).toContain("event: response.failed");
    expect(sse).toContain('"code":"translation_buffer_limit"');
    expect(sse).not.toContain("event: response.completed");
  });

  test("no image tool call → passthrough text + done", async () => {
    const sse = await runAndGetSSE([
      [{ type: "text_delta", text: "hello world" }, { type: "done" }],
    ]);
    expect(sse).toContain("hello world");
  });

  test("image-loop SSE snapshots preserve the client-facing model selector", async () => {
    const parsed = makeParsed();
    parsed.modelId = "claude-sonnet-5";
    parsed._responseModelId = "anthropic/claude-sonnet-5";
    let upstreamModel = "";
    streamQueue = [[{ type: "text_delta", text: "hello" }, { type: "done" }]];
    const response = await runWithImageBridge({
      parsed,
      adapter: {
        ...mockAdapter,
        buildRequest: async request => {
          upstreamModel = request.modelId;
          return { url: "https://test/v1/chat", method: "POST", headers: {}, body: "{}" };
        },
      },
      plan,
    });
    const models = (await response.text()).split("\n\n").flatMap(block => {
      const data = block.split("\n").find(line => line.startsWith("data: "))?.slice(6);
      if (!data || data === "[DONE]") return [];
      const payload = JSON.parse(data) as { response?: { model?: unknown } };
      return typeof payload.response?.model === "string" ? [payload.response.model] : [];
    });

    expect(upstreamModel).toBe("claude-sonnet-5");
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models)).toEqual(new Set(["anthropic/claude-sonnet-5"]));
  });

  test("single image call → fulfilled, second iteration yields text", async () => {
    const sse = await runAndGetSSE(
      [imageCallEvents, [{ type: "text_delta", text: "Here is your image" }, { type: "done" }]],
      { ok: true, model: "grok-imagine-image-quality", prompt: "a cat", files: ["/test/img.png"], count: 1, markdown: "![image](/test/img.png)" },
    );
    expect(sse).toContain("Here is your image");
  });

  test("fulfillImageCall error → model responds about failure", async () => {
    const sse = await runAndGetSSE(
      [imageCallEvents, [{ type: "text_delta", text: "Sorry, image generation failed" }, { type: "done" }]],
      { ok: false, model: "grok-imagine-image-quality", prompt: "a cat", files: [], count: 0, error: "xAI unreachable" },
    );
    expect(sse).toContain("Sorry, image generation failed");
  });

  test("image_gen tool call is intercepted — not visible in client SSE", async () => {
    const sse = await runAndGetSSE(
      [imageCallEvents, [{ type: "text_delta", text: "done" }, { type: "done" }]],
    );
    // The tool_call_start event for image_gen should NOT appear in client-facing SSE
    expect(sse).not.toContain("image_gen");
    expect(sse).not.toContain("tool_call_start");
  });

  test("maxRounds: 1 bounds upstream requests and forces final after limit", async () => {
    buildRequestCalls = 0;
    // Round 0: model calls image_gen (within limit → fulfill + loop)
    // Round 1: forced-final pass (forceFinal, image tools stripped from request)
    streamQueue = [
      [...imageCallEvents],
      [{ type: "text_delta" as const, text: "final answer" }, { type: "done" as const }],
    ];
    const response = await runWithImageBridge({ parsed: makeParsed(), adapter: mockAdapter, plan, maxRounds: 1 });
    const sse = await response.text();
    expect(sse).toContain("final answer");
    // Exactly 2 upstream requests: round 0 (image call) + round 1 (forced final)
    expect(buildRequestCalls).toBe(2);
  });

  test("maxRounds: 0 forces final immediately — no image tool offered", async () => {
    buildRequestCalls = 0;
    streamQueue = [
      [{ type: "text_delta" as const, text: "direct answer" }, { type: "done" as const }],
    ];
    const response = await runWithImageBridge({ parsed: makeParsed(), adapter: mockAdapter, plan, maxRounds: 0 });
    const sse = await response.text();
    expect(sse).toContain("direct answer");
    // Single upstream request — first iteration is already forced-final
    expect(buildRequestCalls).toBe(1);
  });

  test("retryOn429 replays on the same key before on429 rotation", async () => {
    let sends = 0;
    let pacingReservations = 0;
    let rotations = 0;
    let retrySends = 0;
    const retryingAdapter: ProviderAdapter = {
      ...mockAdapter,
      fetchResponse: async () => {
        sends += 1;
        if (sends === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    streamQueue = [[{ type: "text_delta" as const, text: "recovered" }, { type: "done" as const }]];
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: retryingAdapter,
      plan,
      retryOn429Policy: { enabled: true, attempts: 2, intervalMs: 120, maxIntervalMs: 60_000, respectRetryAfter: false },
      waitForRequestSlot: async () => { pacingReservations += 1; },
      on429: () => {
        rotations += 1;
        return null;
      },
      onAttemptSend: recovery => {
        if (recovery === "rate-limit-429") retrySends += 1;
      },
    });
    const sse = await response.text();
    expect(sse).toContain("recovered");
    expect(sends).toBe(2);
    expect(pacingReservations).toBe(2);
    expect(rotations).toBe(0);
    expect(retrySends).toBe(1);
    // Same-target replay reuses the ONE built request (builder runs once per target sequence).
    expect(buildRequestCalls).toBe(1);
  });

  test("retry wait longer than the stall budget still succeeds (heartbeats feed the watchdog)", async () => {
    let sends = 0;
    const retryingAdapter: ProviderAdapter = {
      ...mockAdapter,
      fetchResponse: async () => {
        sends += 1;
        if (sends === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    streamQueue = [[{ type: "text_delta" as const, text: "recovered" }, { type: "done" as const }]];
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: retryingAdapter,
      plan,
      stallTimeoutSec: 1,
      retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 1_500, maxIntervalMs: 60_000, respectRetryAfter: false },
    });
    const sse = await response.text();
    // A 1.5s backoff under a 1s stall budget must not trip upstream_stall_timeout: the wait
    // yields heartbeat events, the replay lands, and the turn completes.
    expect(sends).toBe(2);
    expect(sse).toContain("recovered");
    expect(sse).not.toContain("upstream_stall_timeout");
  }, 5_000);

  test("retry wait longer than connectTimeoutMs restarts the header deadline (no 504)", async () => {
    let sends = 0;
    const attemptSignals: (AbortSignal | undefined)[] = [];
    const abortedAtFetch: boolean[] = [];
    const retryingAdapter: ProviderAdapter = {
      ...mockAdapter,
      fetchResponse: async (_request, ctx) => {
        sends += 1;
        // Captured AT FETCH TIME. Checking `aborted` later would observe the
        // deadline expiring naturally after the body was consumed, which says
        // nothing about whether the replay started with a live budget.
        attemptSignals.push(ctx?.abortSignal);
        abortedAtFetch.push(ctx?.abortSignal?.aborted ?? true);
        /*
         * Honor the deadline the bridge handed us.
         *
         * Without this the mock answers 200 no matter what, so the deadline
         * could be left armed across the backoff and the test would still pass.
         * That is not hypothetical: removing BOTH the pre-wait `clear()` and the
         * post-wait re-arm in src/images/loop.ts left this test green, which
         * means the regression it is named after was never actually guarded.
         */
        ctx?.abortSignal?.throwIfAborted();
        if (sends === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    streamQueue = [[{ type: "text_delta" as const, text: "recovered" }, { type: "done" as const }]];
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: retryingAdapter,
      plan,
      connectTimeoutMs: 100,
      retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 150, maxIntervalMs: 60_000, respectRetryAfter: false },
    });
    /*
     * Status first, and before the body is consumed. A header deadline that
     * expires on the FIRST iteration is answered eagerly with an HTTP 504 and a
     * JSON body — there is no SSE stream yet — so a stream-only assertion cannot
     * see it.
     */
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const sse = await response.text();
    // The deliberate backoff must not consume the response-header deadline: a fresh deadline is
    // armed after the wait, so the replay gets a new connect budget instead of a 504.
    expect(sends).toBe(2);
    expect(sse).toContain("recovered");
    /*
     * Terminal events, not a substring search for "504".
     *
     * The old assertion was `expect(sse).not.toContain("504")`, which searched
     * the whole stream — including the random 32-hex response id. Roughly one id
     * in 137 contains "504", so with two ids in a stream this reddened about 1
     * run in 69 for no reason at all (measured: 1 failure in 37 local runs).
     * It was also unable to detect a REAL 504, whose JSON body carries a timeout
     * message rather than the number.
     */
    expect(sse).toContain("event: response.completed");
    expect(sse).not.toContain("event: response.failed");
    /*
     * And the mechanism itself: the replay must get a NEW deadline, not the
     * disarmed remains of the first one. Identity is the only way to see the
     * difference, since a cleared deadline and a fresh deadline both fail to
     * expire.
     */
    expect(attemptSignals).toHaveLength(2);
    expect(attemptSignals[1]).not.toBe(attemptSignals[0]);
    expect(abortedAtFetch).toEqual([false, false]);
  }, 5_000);

  test("retryOn429 budget is shared across iterations (per request, not per round)", async () => {
    let sends = 0;
    let retrySends = 0;
    let rotations = 0;
    const retryingAdapter: ProviderAdapter = {
      ...mockAdapter,
      fetchResponse: async () => {
        sends += 1;
        if (sends === 1 || sends === 3) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    // Round 0: 429 -> one same-key replay (attempts=1) -> 200 carrying an image call.
    // Round 1 (forced final): 429 with the request budget already spent -> no replay -> rotation.
    streamQueue = [
      [...imageCallEvents],
      [{ type: "text_delta" as const, text: "unused" }, { type: "done" as const }],
    ];
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: retryingAdapter,
      plan,
      maxRounds: 1,
      retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 50, maxIntervalMs: 60_000, respectRetryAfter: false },
      on429: () => {
        rotations += 1;
        return null;
      },
      onAttemptSend: recovery => {
        if (recovery === "rate-limit-429") retrySends += 1;
      },
    });
    const sse = await response.text();
    expect(sends).toBe(3);
    expect(retrySends).toBe(1);
    expect(rotations).toBe(1);
    // The exhausted final 429 surfaces as the provider error, not a silent success.
    expect(sse).toContain("Provider error 429");
  });

  test("retryOn429 budget is not re-armed after on429 rotation returns a new adapter", async () => {
    let sends = 0;
    let retrySends = 0;
    let rotations = 0;
    const retryingAdapter: ProviderAdapter = {
      ...mockAdapter,
      fetchResponse: async () => {
        sends += 1;
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      },
    };
    streamQueue = [[{ type: "text_delta" as const, text: "unused" }, { type: "done" as const }]];
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: retryingAdapter,
      plan,
      retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 50, maxIntervalMs: 60_000, respectRetryAfter: false },
      on429: () => {
        rotations += 1;
        // First rotation returns a new adapter that also 429s; the exhausted budget must not
        // re-arm for it. Second call returns null to terminate the pool.
        return rotations === 1
          ? ({
              ...mockAdapter,
              fetchResponse: async () => {
                sends += 1;
                return new Response("{}", { status: 429 });
              },
            } as ProviderAdapter)
          : null;
      },
      onAttemptSend: recovery => {
        if (recovery === "rate-limit-429") retrySends += 1;
      },
    });
    const sse = await response.text();
    // initial 429 + 1 same-key replay + 1 rotated send (no replay on the rotated adapter) = 3.
    expect(sends).toBe(3);
    expect(retrySends).toBe(1);
    expect(rotations).toBe(2);
    expect(sse).toContain("Provider error 429");
  });

  test("forced-final clears named image tool_choice", async () => {
    streamQueue = [
      [{ type: "text_delta" as const, text: "done" }, { type: "done" as const }],
    ];
    const seenChoices: unknown[] = [];
    const capturingAdapter: ProviderAdapter = {
      ...mockAdapter,
      buildRequest: async (parsed) => {
        buildRequestCalls++;
        seenChoices.push(parsed.options.toolChoice);
        return { url: "https://test/v1/chat", method: "POST", headers: {}, body: "{}" };
      },
    };
    const parsed = makeParsed();
    parsed.options.toolChoice = { name: "image_gen" };
    parsed.context.tools = [
      { name: "image_gen", parameters: {}, description: "img", imageGeneration: true },
      { name: "Bash", parameters: {}, description: "shell" },
    ];
    const response = await runWithImageBridge({ parsed, adapter: capturingAdapter, plan, maxRounds: 0 });
    await response.text();
    expect(seenChoices[0]).toBe("auto");
  });

  test("clampImageMaxRounds bounds hand-edited / fractional values", () => {
    expect(clampImageMaxRounds(10000)).toBe(MAX_ROUNDS_HARD_LIMIT);
    expect(clampImageMaxRounds(2.9)).toBe(2);
    expect(clampImageMaxRounds(-1)).toBe(0);
    expect(clampImageMaxRounds(Number.NaN)).toBe(DEFAULT_MAX_ROUNDS);
    expect(clampImageMaxRounds(undefined)).toBe(DEFAULT_MAX_ROUNDS);
  });

  test("maxRounds: 10000 is clamped — hits hard limit when every round calls image_gen", async () => {
    buildRequestCalls = 0;
    streamQueue = [];
    for (let i = 0; i < MAX_ROUNDS_HARD_LIMIT; i++) {
      streamQueue.push([...imageCallEvents]);
    }
    // Forced-final pass after the hard cap.
    streamQueue.push([{ type: "text_delta" as const, text: "clamped final" }, { type: "done" as const }]);
    const response = await runWithImageBridge({
      parsed: makeParsed(), adapter: mockAdapter, plan, maxRounds: 10000,
    });
    const sse = await response.text();
    expect(sse).toContain("clamped final");
    // Clamped to 10 → HARD_CAP = 11 upstream requests (10 image rounds + 1 forced final).
    expect(buildRequestCalls).toBe(MAX_ROUNDS_HARD_LIMIT + 1);
  });

  test("forced-final strips image aliases from plan.toolNames, not only imageGeneration flag", async () => {
    const seenTools: Array<unknown[] | undefined> = [];
    const capturingAdapter: ProviderAdapter = {
      ...mockAdapter,
      buildRequest: async (parsed) => {
        buildRequestCalls++;
        seenTools.push(parsed.context.tools?.map(t => t.name));
        return { url: "https://test/v1/chat", method: "POST", headers: {}, body: "{}" };
      },
    };
    streamQueue = [
      [
        { type: "tool_call_start", id: "call_1", name: "image_generation" },
        { type: "tool_call_delta", arguments: '{"prompt":"a cat"}' },
        { type: "tool_call_end" },
        { type: "done" },
      ],
      [{ type: "text_delta", text: "done after strip" }, { type: "done" }],
    ];
    const aliasPlan = {
      ...plan,
      toolNames: new Set(["image_generation", "image_gen"]),
    } as ImageBridgePlan;
    const parsed = makeParsed();
    parsed.context.tools = [
      { name: "image_generation", parameters: {}, description: "hosted" },
      { name: "Bash", parameters: {}, description: "shell" },
    ];
    const response = await runWithImageBridge({
      parsed, adapter: capturingAdapter, plan: aliasPlan, maxRounds: 1,
    });
    await response.text();
    // Second request is forceFinal — image_generation must be gone, Bash remains.
    expect(seenTools[1]).toEqual(["Bash"]);
  });

  test("parallel image calls share one assistant turn with thinking attached once", async () => {
    const seenMessages: unknown[] = [];
    const capturingAdapter: ProviderAdapter = {
      ...mockAdapter,
      buildRequest: async (parsed) => {
        buildRequestCalls++;
        seenMessages.push(parsed.context.messages.map(m => ({
          role: m.role,
          contentTypes: Array.isArray(m.content)
            ? m.content.map((c: { type?: string }) => c.type)
            : typeof m.content,
        })));
        return { url: "https://test/v1/chat", method: "POST", headers: {}, body: "{}" };
      },
    };
    streamQueue = [
      [
        { type: "thinking_delta", thinking: "planning" },
        { type: "thinking_signature", signature: "sig" },
        { type: "tool_call_start", id: "call_a", name: "image_gen" },
        { type: "tool_call_delta", arguments: '{"prompt":"a"}' },
        { type: "tool_call_end" },
        { type: "tool_call_start", id: "call_b", name: "image_gen" },
        { type: "tool_call_delta", arguments: '{"prompt":"b"}' },
        { type: "tool_call_end" },
        { type: "done" },
      ],
      [{ type: "text_delta", text: "both images ready" }, { type: "done" }],
    ];
    const response = await runWithImageBridge({
      parsed: makeParsed(), adapter: capturingAdapter, plan, maxRounds: 1,
    });
    await response.text();
    // Second iteration messages should include exactly one assistant turn with thinking + 2 toolCalls.
    const second = seenMessages[1] as Array<{ role: string; contentTypes: string[] }>;
    const assistants = second.filter(m => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect(assistants[0]!.contentTypes).toEqual(["thinking", "toolCall", "toolCall"]);
  });

  test("multi-block thinking and redacted blocks preserve order and signatures", async () => {
    const seenContent: Array<{ type?: string; thinking?: string; signature?: string; redacted?: string[] }>[] = [];
    const capturingAdapter: ProviderAdapter = {
      ...mockAdapter,
      buildRequest: async (parsed) => {
        buildRequestCalls++;
        const assistant = parsed.context.messages.find(m => m.role === "assistant");
        if (assistant && Array.isArray(assistant.content)) {
          seenContent.push(assistant.content as Array<{ type?: string; thinking?: string; signature?: string; redacted?: string[] }>);
        }
        return { url: "https://test/v1/chat", method: "POST", headers: {}, body: "{}" };
      },
    };
    streamQueue = [
      [
        { type: "redacted_thinking", data: "redacted-a" },
        { type: "thinking_delta", thinking: "first" },
        { type: "thinking_signature", signature: "sig-1" },
        { type: "thinking_delta", thinking: "second" },
        { type: "thinking_signature", signature: "sig-2" },
        { type: "tool_call_start", id: "call_1", name: "image_gen" },
        { type: "tool_call_delta", arguments: '{"prompt":"a cat"}' },
        { type: "tool_call_end" },
        { type: "done" },
      ],
      [{ type: "text_delta", text: "ready" }, { type: "done" }],
    ];
    const response = await runWithImageBridge({
      parsed: makeParsed(), adapter: capturingAdapter, plan, maxRounds: 1,
    });
    await response.text();
    expect(seenContent.length).toBeGreaterThan(0);
    const thinkingParts = seenContent[0]!.filter(p => p.type === "thinking");
    expect(thinkingParts).toEqual([
      { type: "thinking", thinking: "", redacted: ["redacted-a"] },
      { type: "thinking", thinking: "first", signature: "sig-1" },
      { type: "thinking", thinking: "second", signature: "sig-2" },
    ]);
  });

  test("onUsage is forwarded from bridge terminal events", async () => {
    let seen: unknown = "unset";
    streamQueue = [
      [{ type: "text_delta", text: "hi" }, { type: "done", usage: { inputTokens: 1, outputTokens: 2 } }],
    ];
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: mockAdapter,
      plan,
      onUsage: usage => { seen = usage; },
    });
    await response.text();
    expect(seen).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  test("onUsage does not double-count hiddenUsage across image iterations", async () => {
    let seen: unknown = "unset";
    streamQueue = [
      [
        { type: "tool_call_start", id: "call_1", name: "image_gen" },
        { type: "tool_call_delta", arguments: '{"prompt":"a cat"}' },
        { type: "tool_call_end" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 4 } },
      ],
      [{ type: "text_delta", text: "ready" }, { type: "done", usage: { inputTokens: 3, outputTokens: 2 } }],
    ];
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: mockAdapter,
      plan,
      maxRounds: 1,
      onUsage: usage => { seen = usage; },
    });
    await response.text();
    // Hidden iter (10/4) + final (3/2) once — not 2*hidden + final.
    expect(seen).toEqual({ inputTokens: 13, outputTokens: 6 });
  });

  test("429 OAuth rotation awaits a refreshed adapter and retries the iteration", async () => {
    let fetchCalls = 0;
    let rotations = 0;
    let activeAdapter: ProviderAdapter | undefined;
    const makeRotatingAdapter = (label: string): ProviderAdapter => ({
      name: label,
      buildRequest: async () => ({ url: "https://test/v1/chat", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => {
        fetchCalls++;
        if (fetchCalls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
        streamQueue = [[{ type: "text_delta", text: "after rotate" }, { type: "done" }]];
        return new Response("{}", { status: 200 });
      },
      parseStream: async function* (): AsyncGenerator<AdapterEvent> {
        const events = streamQueue.shift();
        if (events) for (const e of events) yield e;
      },
    });
    const firstAdapter = makeRotatingAdapter("before-rotate");
    const secondAdapter = makeRotatingAdapter("after-rotate");
    activeAdapter = firstAdapter;
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: firstAdapter,
      plan,
      on429: async () => {
        rotations++;
        await Promise.resolve();
        activeAdapter = secondAdapter;
        return secondAdapter;
      },
    });
    const sse = await response.text();
    expect(rotations).toBe(1);
    expect(fetchCalls).toBe(2);
    expect(activeAdapter).toBe(secondAdapter);
    expect(sse).toContain("after rotate");
  });
});

// ---------------------------------------------------------------------------
// runTurn adapter path (Cursor) — events arrive via an emit callback, not
// buildRequest/fetchResponse/parseStream.
// ---------------------------------------------------------------------------

describe("runWithImageBridge — runTurn adapter", () => {
  let runTurnEventQueue: AdapterEvent[][] = [];
  const runTurnAdapter: ProviderAdapter = {
    ...mockAdapter,
    runTurn: async (_parsed: OcxParsedRequest, _incoming: IncomingMeta, emit: (e: AdapterEvent) => void) => {
      const events = runTurnEventQueue.shift();
      if (events) for (const e of events) emit(e);
    },
  };

  test("runTurn adapter → image call intercepted and fulfilled", async () => {
    runTurnEventQueue = [
      [...imageCallEvents],
      [{ type: "text_delta", text: "Here is your image" }, { type: "done" }],
    ];
    fulfillResult = {
      ok: true, model: "grok-imagine-image-quality", prompt: "a cat",
      files: ["/test/img.png"], count: 1, markdown: "![image](/test/img.png)",
    };
    const response = await runWithImageBridge({
      parsed: makeParsed(), adapter: runTurnAdapter, plan, maxRounds: 1,
    });
    const sse = await response.text();
    expect(sse).toContain("Here is your image");
    // The synthetic image_gen tool call must NOT leak to the client
    expect(sse).not.toContain("image_gen");
    expect(sse).not.toContain("tool_call_start");
  });

  test("runTurn adapter → text passthrough (no image call)", async () => {
    runTurnEventQueue = [
      [{ type: "text_delta", text: "hello from runTurn" }, { type: "done" }],
    ];
    const response = await runWithImageBridge({ parsed: makeParsed(), adapter: runTurnAdapter, plan });
    const sse = await response.text();
    expect(sse).toContain("hello from runTurn");
  });

  test("runTurn adapter → error event surfaces as upstream failure", async () => {
    runTurnEventQueue = [
      [{ type: "error", message: "cursor blew up" }],
    ];
    const response = await runWithImageBridge({ parsed: makeParsed(), adapter: runTurnAdapter, plan });
    const sse = await response.text();
    expect(sse).toContain("cursor blew up");
  });

  test("runTurn adapter → SSE headers return before slow collect completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slowAdapter: ProviderAdapter = {
      ...mockAdapter,
      runTurn: async (_parsed, _incoming, emit) => {
        await gate;
        emit({ type: "text_delta", text: "slow ok" });
        emit({ type: "done" });
      },
    };
    const responsePromise = runWithImageBridge({ parsed: makeParsed(), adapter: slowAdapter, plan });
    // Headers must resolve without waiting for runTurn to finish.
    const response = await responsePromise;
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    release();
    const sse = await response.text();
    expect(sse).toContain("slow ok");
  });

  test("runTurn adapter → stall deadline aborts the in-flight runTurn signal", async () => {
    let seenSignal: AbortSignal | undefined;
    let aborted = false;
    const hangingAdapter: ProviderAdapter = {
      ...mockAdapter,
      runTurn: async (_parsed, incoming) => {
        seenSignal = incoming.abortSignal;
        await new Promise<void>((resolve, reject) => {
          if (!incoming.abortSignal) {
            reject(new Error("missing abortSignal"));
            return;
          }
          if (incoming.abortSignal.aborted) {
            aborted = true;
            resolve();
            return;
          }
          incoming.abortSignal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
      },
    };
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: hangingAdapter,
      plan,
      // Short stall so the collect deadline wins without waiting on real upstream silence.
      stallTimeoutSec: 0.05,
    });
    const sse = await response.text();
    expect(seenSignal).toBeDefined();
    expect(aborted).toBe(true);
    expect(sse).toContain("runTurn inactivity timeout");
  });

  test("runTurn adapter → idle timeout completes when runTurn ignores abort and never settles", async () => {
    // Regression: aborting internalAbort alone is not enough — if runTurn never observes
    // cancellation and never closes the queue, queue.stream() would hang forever. The idle
    // handler must close the queue to unblock the consumer independently.
    const neverSettlingAdapter: ProviderAdapter = {
      ...mockAdapter,
      runTurn: async () => {
        await new Promise(() => { /* never settles; ignores abort entirely */ });
      },
    };
    const started = Date.now();
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: neverSettlingAdapter,
      plan,
      stallTimeoutSec: 0.05,
    });
    const sse = await response.text();
    const elapsedMs = Date.now() - started;
    const timeoutFrames = sse.split("\n\n").filter(frame => frame.includes("runTurn inactivity timeout"));
    expect(timeoutFrames).toHaveLength(1);
    expect(timeoutFrames[0]).toContain("response.failed");
    // Must finish near the idle deadline, not hang on the never-settling runTurn.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  test("runTurn adapter → continuous progress resets the idle stall deadline", async () => {
    // Wall-clock for the whole turn exceeds stallTimeoutSec, but each idle gap is shorter.
    const progressingAdapter: ProviderAdapter = {
      ...mockAdapter,
      runTurn: async (_parsed, incoming, emit) => {
        for (let i = 0; i < 6; i++) {
          if (incoming.abortSignal?.aborted) return;
          emit({ type: "text_delta", text: `chunk${i}` });
          await new Promise(r => setTimeout(r, 40));
        }
        if (!incoming.abortSignal?.aborted) emit({ type: "done" });
      },
    };
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: progressingAdapter,
      plan,
      stallTimeoutSec: 0.1, // 100ms idle; total emit span ~240ms
    });
    const sse = await response.text();
    expect(sse).toContain("chunk5");
    expect(sse).not.toContain("inactivity timeout");
  });

  test("runTurn adapter → preserves _cursorConversationId across iterations", async () => {
    const seenIds: Array<string | undefined> = [];
    const cursorAdapter: ProviderAdapter = {
      ...mockAdapter,
      runTurn: async (parsed, _incoming, emit) => {
        seenIds.push(parsed._cursorConversationId);
        if (!parsed._cursorConversationId) {
          parsed._cursorConversationId = "conv-from-first-turn";
        }
        const events = runTurnEventQueue.shift();
        if (events) for (const e of events) emit(e);
      },
    };
    runTurnEventQueue = [
      [...imageCallEvents],
      [{ type: "text_delta", text: "second turn" }, { type: "done" }],
    ];
    const parsed = makeParsed();
    const response = await runWithImageBridge({
      parsed, adapter: cursorAdapter, plan, maxRounds: 1,
    });
    await response.text();
    expect(seenIds[0]).toBeUndefined();
    expect(seenIds[1]).toBe("conv-from-first-turn");
    expect(parsed._cursorConversationId).toBe("conv-from-first-turn");
  });
});
