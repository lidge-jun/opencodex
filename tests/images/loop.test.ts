import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderAdapter, IncomingMeta } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import type { ImageBridgePlan, ImageCallResult } from "../../src/images/types";

const PREV_HOME = process.env.OPENCODEX_HOME;
beforeAll(() => { process.env.OPENCODEX_HOME = join(tmpdir(), "ocx-test-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; });

// --- Mock parseStreamWithProgress: simplify to direct delegation ---
mock.module("../../src/web-search/progress-stream", () => ({
  parseStreamWithProgress: async function* (_resp: Response, parse: (r: Response) => AsyncGenerator<AdapterEvent>, _opts: unknown) {
    for await (const e of parse(_resp)) yield e;
  },
  RoutedModelInactivityError: class extends Error { readonly timeoutMs = 0; },
  WebSearchStreamProtocolError: class extends Error { /* */ },
}));

// --- Mock fulfillImageCall ---
let fulfillResult: ImageCallResult = {
  ok: true, model: "grok-imagine-image-quality", prompt: "a cat",
  files: ["/test/img.png"], count: 1, markdown: "![image](/test/img.png)",
};
mock.module("../../src/images/fulfill", () => ({
  fulfillImageCall: async (): Promise<ImageCallResult> => fulfillResult,
}));

const { runWithImageBridge, clampImageMaxRounds, DEFAULT_MAX_ROUNDS, MAX_ROUNDS_HARD_LIMIT } = await import("../../src/images/loop");

// --- Mock adapter: yields canned events per iteration from a queue ---
let streamQueue: AdapterEvent[][] = [];
let buildRequestCalls = 0;
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

async function runAndGetSSE(streams: AdapterEvent[][], fulfill?: ImageCallResult): Promise<string> {
  streamQueue = streams.map(s => [...s]);
  if (fulfill) fulfillResult = fulfill;
  const response = await runWithImageBridge({ parsed: makeParsed(), adapter: mockAdapter, plan });
  return await response.text();
}

describe("runWithImageBridge", () => {
  test("no image tool call → passthrough text + done", async () => {
    const sse = await runAndGetSSE([
      [{ type: "text_delta", text: "hello world" }, { type: "done" }],
    ]);
    expect(sse).toContain("hello world");
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

  test("clampImageMaxRounds bounds hand-edited / fractional values", () => {
    expect(clampImageMaxRounds(10000)).toBe(MAX_ROUNDS_HARD_LIMIT);
    expect(clampImageMaxRounds(2.9)).toBe(2);
    expect(clampImageMaxRounds(-1)).toBe(0);
    expect(clampImageMaxRounds(Number.NaN)).toBe(DEFAULT_MAX_ROUNDS);
    expect(clampImageMaxRounds(undefined)).toBe(DEFAULT_MAX_ROUNDS);
  });

  test("maxRounds: 10000 is clamped — does not run unbounded iterations", async () => {
    buildRequestCalls = 0;
    // Provide only two streams; an unclamped 10000 would hang waiting for more.
    streamQueue = [
      [...imageCallEvents],
      [{ type: "text_delta" as const, text: "clamped final" }, { type: "done" as const }],
    ];
    // Fill remaining slots so force-final after hard limit still has events if clamp failed.
    for (let i = 0; i < 20; i++) {
      streamQueue.push([{ type: "text_delta" as const, text: `extra ${i}` }, { type: "done" as const }]);
    }
    const response = await runWithImageBridge({
      parsed: makeParsed(), adapter: mockAdapter, plan, maxRounds: 10000,
    });
    const sse = await response.text();
    expect(sse).toContain("clamped final");
    // Clamped to 10 → at most 11 upstream requests (maxRounds+1), plus the first image round
    // that triggers a loop: image call + up to 10 more. With only one image call then text,
    // we stop early at 2.
    expect(buildRequestCalls).toBe(2);
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

  test("429 key rotation rebuilds the adapter and retries the iteration", async () => {
    let fetchCalls = 0;
    let rotations = 0;
    const rotatingAdapter: ProviderAdapter = {
      name: "test",
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
    };
    const response = await runWithImageBridge({
      parsed: makeParsed(),
      adapter: rotatingAdapter,
      plan,
      on429: () => {
        rotations++;
        return rotatingAdapter;
      },
    });
    const sse = await response.text();
    expect(rotations).toBe(1);
    expect(fetchCalls).toBe(2);
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
