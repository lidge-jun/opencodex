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

const { runWithImageBridge } = await import("../../src/images/loop");

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
});
