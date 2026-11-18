import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AdapterFetchContext, ProviderAdapter } from "../../src/adapters/base";
import { KIRO_COMPLETION_TOOL_NAME } from "../../src/adapters/kiro-constants";
import { createRegisteredAdapter } from "../../src/adapters/registry";
import { encodeMessage } from "../../src/lib/eventstream-decoder";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../../src/types";
import { RequestPacingQueueOverloadError } from "../../src/providers/request-pacing";
import { createAnthropicThinkingRecovery } from "../../src/server/responses/anthropic-thinking-recovery";
import { createAdvisorSidecarStep } from "../../src/server/responses/advisor-slot";
import { providerFetch, type ProviderFetch } from "../../src/server/responses/fetch-helpers";
import { runWithWebSearch } from "../../src/web-search/loop";
import { buildWebSearchTool } from "../../src/web-search/synthetic-tool";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// Every routed-model iteration re-sends the full context, so the usage ledger (onUsage) must get the
// sum of all of them. The client-facing terminal keeps the last iteration's usage: Codex and Claude
// Code size the context window from it, and a sum would trigger early auto-compaction.
const usage = (input: number, output: number, extra: Partial<OcxUsage> = {}): OcxUsage =>
  ({ inputTokens: input, outputTokens: output, totalTokens: input + output, ...extra });
const search = (id: string, u?: OcxUsage): AdapterEvent[] => [
  { type: "tool_call_start", id, name: "web_search" },
  { type: "tool_call_delta", arguments: JSON.stringify({ query: id }) },
  { type: "tool_call_end" }, { type: "done", usage: u },
];
const answer = (u?: OcxUsage): AdapterEvent[] => [{ type: "text_delta", text: "answer" }, { type: "done", usage: u }];

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const workers = {
  chat: { adapter: "openai-chat", modelId: "worker" },
  messages: { adapter: "anthropic", modelId: "claude-sonnet-4-6" },
  cca: { adapter: "google", googleMode: "cloud-code-assist", project: "fixture", modelId: "gemini-3-pro" },
  kiro: { adapter: "kiro", modelId: "gpt-5.6-sol" },
} as const;

function workerResponse(wire: keyof typeof workers, first: boolean): Response {
  const args = { question: "Review the answer" };
  if (wire === "kiro") {
    const tool = { name: first ? "advisor" : KIRO_COMPLETION_TOOL_NAME, toolUseId: first ? "call_advisor" : "call_final" };
    const encoder = new TextEncoder();
    const frame = (type: string, event: Record<string, unknown>) => encodeMessage(
      { ":message-type": "event", ":event-type": type }, encoder.encode(JSON.stringify(event)),
    );
    return new Response(new Blob([
      frame("toolUseEvent", tool),
      frame("toolUseEvent", { ...tool, input: JSON.stringify(first ? args : { answer: "Final answer" }) }),
      frame("toolUseEvent", { ...tool, stop: true }),
      frame("meteringEvent", { unit: "credit", usage: first ? 2 : 3 }),
    ].map(frame => Uint8Array.from(frame))), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
  }
  const input = first ? 20 : 30;
  const output = first ? 2 : 3;
  if (wire === "messages") {
    const frames = [
      { type: "message_start", message: { id: "msg_worker", usage: { input_tokens: input } } },
      { type: "content_block_start", index: 0, content_block: first
        ? { type: "tool_use", id: "toolu_advisor", name: "advisor", input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: first
        ? { type: "input_json_delta", partial_json: JSON.stringify(args) } : { type: "text_delta", text: "Final answer" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: output } },
      { type: "message_stop" },
    ];
    return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  }
  const chatDelta = first
    ? { tool_calls: [{ index: 0, id: "call_advisor", type: "function", function: { name: "advisor", arguments: JSON.stringify(args) } }] }
    : { content: "Final answer" };
  const frames = wire === "chat" ? [
    { choices: [{ index: 0, delta: chatDelta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } },
  ] : [{ response: {
    candidates: [{ index: 0, content: { role: "model", parts: [first
      ? { functionCall: { name: "advisor", args } } : { text: "Final answer" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, totalTokenCount: input + output },
  } }];
  const events = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return new Response(events + (wire === "chat" ? "data: [DONE]\n\n" : ""), {
    headers: { "content-type": "text/event-stream" },
  });
}

describe.each(["chat", "messages", "cca", "kiro"] as const)("real %s worker dispatch", wire => {
  test.each([false, true])("settles worker usage once (final dispatch refused=%s)", async refuse => {
    const requests: unknown[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      requests.push(await req.json());
      return workerResponse(wire, requests.length === 1);
    } });
    try {
      const { modelId, ...transport } = workers[wire];
      const provider: OcxProviderConfig = { ...transport,
        baseUrl: server.url.origin, authMode: "key", apiKey: "fixture", allowPrivateNetwork: true };
      let dispatchCandidates = 0;
      const receipts: number[] = [];
      const reported: (OcxUsage | undefined)[] = [];
      const response = await runWithWebSearch({
        parsed: { modelId, stream: true, options: {}, context: {
          messages: [{ role: "user", content: "Answer the question", timestamp: 0 }],
          tools: [buildWebSearchTool(), { name: "advisor", advisor: true, description: "Consult Advisor",
            parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } }],
        } },
        adapter: createRegisteredAdapter(provider),
        advisor: createAdvisorSidecarStep({
          consult: async () => ({ ok: true, isError: false, content: "Advice" }),
          formatUnavailable: () => "Advisor unavailable",
        }),
        incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget(),
          onPhysicalSend: ({ ordinal }) => receipts.push(ordinal) },
        fetchForRequest: (_request, _parsed, _adapter, _recovery, onPhysicalDispatch) =>
          Object.assign(providerFetch(provider, undefined, {
            providerName: "worker", modelId,
            onPhysicalDispatch: () => {
              if (++dispatchCandidates === 2 && refuse) throw new SendBudgetExhaustedError();
              onPhysicalDispatch?.();
            },
          }), { reportsPhysicalDispatch: true as const }),
        backend: "exa", hostedTool: { type: "web_search" }, selectedForwardHeaders: new Headers(),
        settings: { model: "search", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
        onUsage: value => reported.push(value),
      });
      const body = await response.text();
      expect(body).toContain(refuse ? "response.failed" : "Final answer");
      expect(dispatchCandidates).toBe(2);
      expect(requests).toHaveLength(refuse ? 1 : 2);
      expect(receipts).toEqual(refuse ? [1] : [1, 1]);
      const expected = wire === "kiro" ? { providerCredits: refuse ? 2 : 5 }
        : refuse ? { inputTokens: 20, outputTokens: 2 } : { inputTokens: 50, outputTokens: 5, totalTokens: 55 };
      expect(reported).toEqual([expect.objectContaining(expected)]);
    } finally {
      server.stop(true);
    }
  });
});

async function drive(passes: AdapterEvent[][], refuseFrom = Infinity, mode?: "replay" | "paced" | "preserve-error" | "stream-retry") {
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
  const reported: (OcxUsage | undefined)[] = [];
  let events: AdapterEvent[] = [];
  let iteration = 0;
  let physicalSends = 0;
  let onPhysicalSend: AdapterFetchContext["onPhysicalSend"];
  const adapter: ProviderAdapter = {
    name: "fixture",
    buildRequest() {
      events = passes[iteration++]!;
      return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
    },
    ...(mode === "paced" ? {} : {
      fetchResponse: async (_request, ctx) => {
        onPhysicalSend = ctx?.onPhysicalSend;
        const count = mode === "replay" && iteration === 2 ? 2 : 1;
        for (let ordinal = 1; ordinal <= count; ordinal++) {
          physicalSends++;
          ctx?.onPhysicalSend?.({ ordinal, ...(ordinal === 2 ? { recovery: "connection-reset" as const } : {}) });
        }
        return iteration > refuseFrom ? new Response("refused", { status: 500 }) : new Response("wire");
      },
    }),
    async *parseStream() {
      if (mode === "stream-retry" && iteration === 2) {
        physicalSends++;
        onPhysicalSend?.({ ordinal: 2, recovery: "empty-completion" });
      }
      yield* events;
    },
  };
  const parsed: OcxParsedRequest = {
    modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [buildWebSearchTool()] },
  };
  const pacedFetch = Object.assign(async () => {
    physicalSends++;
    return new Response("wire");
  }, {
    waitForPacing: async () => {
      if (iteration > 1) throw new RequestPacingQueueOverloadError("fixture", "queue_full", 1);
    },
  }) as ProviderFetch;
  const response = await runWithWebSearch({
    parsed, adapter, backend: "exa", exaApiKey: "fixture", hostedTool: { type: "web_search" },
    settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    onUsage: u => reported.push(u),
    ...(mode === "paced" ? { fetchForRequest: () => pacedFetch } : {}),
    ...(mode === "preserve-error" ? {
      thinkingRecovery: createAnthropicThinkingRecovery(parsed, new AbortController().signal, { attempted: false }, () => false),
    } : {}),
  });
  const text = await response.text();
  const terminal = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
    .find(frame => frame.type === "response.completed" || frame.type === "response.failed");
  return { reported, text, physicalSends, clientUsage: terminal?.response?.usage };
}

describe("web-search loop iteration usage", () => {
  test.each([[2, 3, 5], [undefined, 3, -1], [2, undefined, -1]])(
    "search continuation credits account for both dispatched legs (%s, %s)", async (first, second, total) => {
      const metered = (credits: number | undefined) => credits === undefined ? undefined : usage(10, 2, { providerCredits: credits });
      const { reported, text } = await drive([search("first", metered(first)), answer(metered(second))]);
      expect(text).toContain("response.completed");
      expect(reported).toEqual([expect.objectContaining({ providerCredits: total })]);
    },
  );

  test("a refused dispatched continuation leaves credit evidence incomplete", async () => {
    const { reported, text } = await drive([search("first", usage(10, 2, { providerCredits: 2 })), answer()], 1);
    expect(text).toContain("response.failed");
    expect(reported).toEqual([expect.objectContaining({ providerCredits: -1 })]);
  });

  test("search passes are added to the final answer's usage", async () => {
    const { reported, text, clientUsage } = await drive([
      search("first", usage(1000, 50, { cachedInputTokens: 0, cacheCreationInputTokens: 900, contextTotalTokens: 1050 })),
      answer(usage(1400, 80, { cachedInputTokens: 900, cacheReadInputTokens: 900, contextTotalTokens: 1480 })),
    ]);
    expect(text).toContain("response.completed");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      inputTokens: 2400, outputTokens: 130, totalTokens: 2530,
      cachedInputTokens: 900, cacheReadInputTokens: 900, cacheCreationInputTokens: 900,
      // An absolute context checkpoint is the last iteration's, never a sum.
      contextTotalTokens: 1480,
    });
    // Client wire derives input from the last checkpoint: 1480 - 80.
    expect(clientUsage).toMatchObject({ input_tokens: 1400, output_tokens: 80, total_tokens: 1480 });
  });

  test("the empty forced answer that was retried is counted too", async () => {
    const { reported, text, clientUsage } = await drive([
      search("first", usage(1000, 50)),
      [{ type: "done", usage: usage(1400, 5) }],
      answer(usage(1500, 80)),
    ]);
    expect(text).toContain("response.completed");
    expect(reported).toEqual([expect.objectContaining({ inputTokens: 3900, outputTokens: 135, totalTokens: 4035 })]);
    expect(clientUsage).toMatchObject({ input_tokens: 1500, output_tokens: 80, total_tokens: 1580 });
  });

  test("an in-stream failure after a search still reports the iterations already sent", async () => {
    const { reported, text, clientUsage } = await drive([search("first", usage(1000, 50)), answer(usage(1, 1))], 1);
    expect(text).toContain("response.failed");
    expect(clientUsage).toBeFalsy();
    expect(reported).toEqual([expect.objectContaining({ inputTokens: 1000, outputTokens: 50 })]);
  });

  test("a translator-budget failure after a search still reports the iterations already sent", async () => {
    const { reported, text } = await drive([
      search("first", usage(1000, 50)),
      [{ type: "error", status: 502, code: "translation_buffer_limit", message: "over budget" }],
    ]);
    expect(text).toContain("translation_buffer_limit");
    expect(reported).toEqual([expect.objectContaining({ inputTokens: 1000, outputTokens: 50 })]);
  });

  test("an earlier iteration's checkpoint and raw usage never stand in for the final terminal's", async () => {
    const { reported } = await drive([
      search("first", usage(1000, 50, { contextTotalTokens: 1050, rawUsage: { iteration: 1 } })),
      answer(usage(1400, 80)),
    ]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ inputTokens: 2400, outputTokens: 130 });
    expect(reported[0]?.contextTotalTokens).toBeUndefined();
    expect(reported[0]?.rawUsage).toBeUndefined();
  });
});

test("an adapter reset replay without a reading makes later credit evidence incomplete", async () => {
  const { reported, text, physicalSends } = await drive([
    search("first", usage(10, 2, { providerCredits: 2 })), answer(usage(12, 1, { providerCredits: 3 })),
  ], Infinity, "replay");
  expect(text).toContain("response.completed");
  expect(physicalSends).toBe(3);
  expect(reported).toEqual([expect.objectContaining({ providerCredits: -1 })]);
});

test("a pacing refusal leaves the earlier metered search intact", async () => {
  const { reported, physicalSends } = await drive([
    search("first", usage(10, 2, { providerCredits: 1.95 })), answer(),
  ], Infinity, "paced");
  expect(physicalSends).toBe(1);
  expect(reported).toEqual([expect.objectContaining({ providerCredits: 1.95 })]);
});

test("a terminal error keeps its checkpoint and raw usage with counters summed once", async () => {
  const { reported } = await drive([
    search("first", usage(100, 2, { contextTotalTokens: 9000, rawUsage: { iteration: 1 } })),
    [{
      type: "error", status: 502, code: "fixture_failure", message: "terminal failure",
      usage: usage(200, 3, { contextTotalTokens: 4096, rawUsage: { iteration: 2 } }),
    }],
  ], Infinity, "preserve-error");
  expect(reported).toEqual([expect.objectContaining({
    inputTokens: 300, outputTokens: 5, contextTotalTokens: 4096, rawUsage: { iteration: 2 },
  })]);
});

test("a stream-owned retry whose reading is already combined contributes only once", async () => {
  const { reported, text, physicalSends } = await drive([
    search("first", usage(10, 2, { providerCredits: 2 })), answer(usage(24, 1, { providerCredits: 7 })),
  ], Infinity, "stream-retry");
  expect(text).toContain("response.completed");
  expect(physicalSends).toBe(3);
  expect(reported).toEqual([expect.objectContaining({ providerCredits: 9 })]);
});
