import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import type { ImageBridgePlan } from "../../src/images/types";
import type { ImageBridgeDeps } from "../../src/images/loop";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

/**
 * Issue #950 regression: the image bridge's synthetic tool round must preserve
 * raw reasoning (`reasoning_raw_delta`) ahead of the replayed image_gen call,
 * exactly like the web-search loop does (#688). Without it, DeepSeek thinking
 * mode receives a bare tool-call continuation and rejects it with HTTP 400.
 */

const REASONING = "I need to inspect files before answering.";

const PREV_HOME = process.env.OPENCODEX_HOME;
let runWithImageBridgeProduction: typeof import("../../src/images/loop")["runWithImageBridge"];
let fulfillResult: import("../../src/images/types").ImageCallResult = {
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
    fulfillImageCall: async (): Promise<import("../../src/images/types").ImageCallResult> => fulfillResult,
  }));
  ({ runWithImageBridge: runWithImageBridgeProduction } = await import("../../src/images/loop"));
});

afterAll(() => {
  if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = PREV_HOME;
  mock.restore();
});

let streamQueue: AdapterEvent[][] = [];

beforeEach(() => {
  fulfillResult = {
    ok: true, model: "grok-imagine-image-quality", prompt: "a cat",
    files: ["/test/img.png"], count: 1, markdown: "![image](/test/img.png)",
  };
  streamQueue = [];
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

const mockAdapter: ProviderAdapter = {
  name: "test",
  buildRequest: async () => ({ url: "https://test/v1/chat", method: "POST", headers: {}, body: "{}" }),
  fetchResponse: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  parseStream: async function* (): AsyncGenerator<AdapterEvent> {
    const events = streamQueue.shift();
    if (events) for (const e of events) yield e;
  },
};

const imagePlan = {
  provider: {} as never,
  auth: { baseUrl: "https://api.x.ai", token: "test-token" },
  model: "grok-imagine-image-quality",
  toolNames: new Set(["image_gen"]),
} as ImageBridgePlan;

function makeParsed(): OcxParsedRequest {
  return {
    modelId: "test-model",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
    _clientThreadId: "image-replay-test",
    _reasoningReplayScope: {
      clientThreadId: "image-replay-test",
      current: {
        providerName: "test",
        providerDestinationIdentity: "destination:test",
        adapterName: "test",
        modelId: "test-model",
        credentialIdentity: "key:test",
      },
    },
  } as OcxParsedRequest;
}

describe("issue #950 — image-bridge synthetic tool round (raw reasoning)", () => {
  test("GAP D: raw reasoning preceding an image_gen call survives into the replayed assistant turn", async () => {
    const seenAssistants: Array<Array<{ type?: string; thinking?: string }>> = [];
    const capturingAdapter: ProviderAdapter = {
      ...mockAdapter,
      buildRequest: async (parsed) => {
        const assistant = parsed.context.messages.find(m => m.role === "assistant");
        if (assistant && Array.isArray(assistant.content)) {
          seenAssistants.push(assistant.content as Array<{ type?: string; thinking?: string }>);
        }
        return { url: "https://test/v1/chat", method: "POST", headers: {}, body: "{}" };
      },
    };
    streamQueue = [
      [
        { type: "reasoning_raw_delta", text: REASONING },
        { type: "tool_call_start", id: "call_1", name: "image_gen" },
        { type: "tool_call_delta", arguments: '{"prompt":"a cat"}' },
        { type: "tool_call_end" },
        { type: "done" },
      ],
      [{ type: "text_delta", text: "ready" }, { type: "done" }],
    ];
    const response = await runWithImageBridge({
      parsed: makeParsed(), adapter: capturingAdapter, plan: imagePlan, maxRounds: 1,
    });
    await response.text();
    expect(seenAssistants.length).toBeGreaterThan(0);
    expect(seenAssistants[0]!.map(p => p.type)).toEqual(["thinking", "toolCall"]);
    expect(seenAssistants[0]!.find(p => p.type === "thinking")).toMatchObject({ thinking: REASONING });
  });
});
