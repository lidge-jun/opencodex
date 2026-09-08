import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../../src/bridge";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../../../src/adapters/anthropic";
import { parseRequest } from "../../../src/responses/parser";
import { encodeReasoningEnvelope, decodeReasoningEnvelope, OCX_REASONING_PREFIX } from "../../../src/responses/reasoning-envelope";
import type { AdapterEvent, OcxProviderConfig, OcxThinkingContent } from "../../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";

import { anthropicToResponsesBody } from "../../../src/claude/inbound";
import { collectAnthropicMessage, responsesSseToAnthropicSse, responsesJsonToAnthropicMessage } from "../../../src/claude/outbound";
import { createGoogleAdapter } from "../../../src/adapters/google";
import { sanitizeReasoningInputContent } from "../../../src/adapters/openai-responses";

const createAnthropicAdapter = (...args: Parameters<typeof createAnthropicAdapterProduction>) =>
  withTestTranslatorBudget(createAnthropicAdapterProduction(...args));

const provider: OcxProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-test",
};

function sseResponse(frames: string[]): Response {
  const body = frames.join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function collect(events: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function frame(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

async function drainSse(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function sseItems(sse: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const json = JSON.parse(line.slice(6)) as { type?: string; item?: Record<string, unknown> };
      if (json.type === "response.output_item.done" && json.item) items.push(json.item);
    } catch { /* partial */ }
  }
  return items;
}

describe("anthropic thinking-signature capture", () => {
  test("signature_delta on a thinking block yields thinking_signature", async () => {
    const adapter = createAnthropicAdapter(provider);
    const events = await collect(adapter.parseStream!(sseResponse([
      frame("message_start", { message: { usage: { input_tokens: 1 } } }),
      frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "let me think" } }),
      frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "AbCdEf1234567890sig==" } }),
      frame("content_block_stop", { index: 0 }),
      frame("message_stop", {}),
    ])));
    expect(events).toContainEqual({ type: "thinking_delta", thinking: "let me think" });
    expect(events).toContainEqual({ type: "thinking_signature", signature: "AbCdEf1234567890sig==" });
  });

  test("signature_delta outside a thinking block is ignored (block-scoped)", async () => {
    const adapter = createAnthropicAdapter(provider);
    const events = await collect(adapter.parseStream!(sseResponse([
      frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "StraySignature123456" } }),
      frame("content_block_stop", { index: 0 }),
      frame("message_stop", {}),
    ])));
    expect(events.find(e => e.type === "thinking_signature")).toBeUndefined();
  });

  test("redacted_thinking blocks surface with their opaque data", async () => {
    const adapter = createAnthropicAdapter(provider);
    const events = await collect(adapter.parseStream!(sseResponse([
      frame("content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: "OPAQUE1" } }),
      frame("content_block_stop", { index: 0 }),
      frame("message_stop", {}),
    ])));
    expect(events).toContainEqual({ type: "redacted_thinking", data: "OPAQUE1" });
  });
});

describe("bridge ocxr1 envelope emission", () => {
  const baseEvents: AdapterEvent[] = [
    { type: "thinking_delta", thinking: "hidden chain" },
    { type: "thinking_signature", signature: "RealSig1234567890==" },
    { type: "text_delta", text: "answer" },
    { type: "done", usage: { inputTokens: 1, outputTokens: 2 } },
  ];

  test("SSE: reasoning item carries the envelope with the signature", async () => {
    async function* gen() { yield* baseEvents; }
    const sse = await drainSse(bridgeToResponsesSSE(gen(), "claude-x"));
    const reasoning = sseItems(sse).find(i => i.type === "reasoning");
    expect(reasoning).toBeDefined();
    const env = decodeReasoningEnvelope(reasoning!.encrypted_content as string);
    expect(env?.sig).toBe("RealSig1234567890==");
  });

  test("SSE hideThinkingSummary: envelope-only reasoning item, no text leak", async () => {
    async function* gen() { yield* baseEvents; }
    const sse = await drainSse(bridgeToResponsesSSE(gen(), "claude-x", undefined, undefined, undefined, undefined, 2000, { hideThinkingSummary: true }));
    const reasoning = sseItems(sse).find(i => i.type === "reasoning");
    expect(reasoning).toBeDefined();
    expect(reasoning!.summary).toEqual([]);
    expect(sse).not.toContain("hidden chain".replace(" ", "\\u0020")); // no raw leak in visible frames
    expect(sse.split("reasoning_summary_text.delta").length).toBe(1); // no summary deltas emitted
    const env = decodeReasoningEnvelope(reasoning!.encrypted_content as string);
    expect(env?.sig).toBe("RealSig1234567890==");
    expect(env?.txt).toBe("hidden chain"); // signed text survives inside the envelope only
  });

  test("JSON: reasoning item carries envelope; redacted blocks included", async () => {
    const response = buildResponseJSON([
      { type: "redacted_thinking", data: "RED1" },
      ...baseEvents,
    ], "claude-x");
    const output = response.output as Record<string, unknown>[];
    const reasoning = output.filter(i => i.type === "reasoning");
    expect(reasoning.map(item => decodeReasoningEnvelope(item.encrypted_content as string))).toEqual([
      { red: ["RED1"] },
      { sig: "RealSig1234567890==" },
    ]);
  });

  test("redacted-only turn still emits an envelope reasoning item (SSE)", async () => {
    async function* gen(): AsyncGenerator<AdapterEvent> {
      yield { type: "redacted_thinking", data: "ONLYRED" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    const sse = await drainSse(bridgeToResponsesSSE(gen(), "claude-x"));
    const reasoning = sseItems(sse).find(i => i.type === "reasoning" && typeof i.encrypted_content === "string");
    expect(reasoning).toBeDefined();
    const env = decodeReasoningEnvelope(reasoning!.encrypted_content as string);
    expect(env?.red).toEqual(["ONLYRED"]);
  });
});

describe("parser ocxr1 decode + anthropic replay", () => {
  test("reasoning input with ocxr1 envelope restores the real signature", async () => {
    const encrypted = encodeReasoningEnvelope({ sig: "RealSig1234567890==", red: ["RED1"] });
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "chain" }], encrypted_content: encrypted },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    const assistant = parsed.context.messages.find(m => m.role === "assistant");
    expect(assistant).toBeDefined();
    const thinking = (assistant as unknown as { content: OcxThinkingContent[] }).content.find(p => p.type === "thinking");
    expect(thinking?.signature).toBe("RealSig1234567890==");
    expect(thinking?.redacted).toEqual(["RED1"]);
  });

  // Kiro emits its reasoningContentEvent at the END of an assistant turn (after content AND tool
  // calls), so a krc-only envelope belongs to the turn BEFORE it. Folding it forward like ordinary
  // reasoning would attach turn N's blob to turn N+1 and hand Kiro a mismatched blob.
  test("krc-only reasoning attaches to the preceding assistant turn", async () => {
    const parsed = parseRequest({
      model: "kiro/gpt-5.6-sol",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "first" }] },
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encodeReasoningEnvelope({ krc: "BLOB1" }) },
        { type: "message", role: "user", content: [{ type: "input_text", text: "more" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "second" }] },
      ],
    });
    const assistants = parsed.context.messages.filter(m => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect((assistants[0] as { kiroRedactedReasoning?: string }).kiroRedactedReasoning).toBe("BLOB1");
    expect((assistants[1] as { kiroRedactedReasoning?: string }).kiroRedactedReasoning).toBeUndefined();
  });

  test("krc-only reasoning with no preceding assistant turn is dropped, not mis-paired", async () => {
    const parsed = parseRequest({
      model: "kiro/gpt-5.6-sol",
      input: [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encodeReasoningEnvelope({ krc: "ORPHAN" }) },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const assistant = parsed.context.messages.find(m => m.role === "assistant");
    expect((assistant as { kiroRedactedReasoning?: string }).kiroRedactedReasoning).toBeUndefined();
  });

  test("hidden signed text (txt) is restored as the thinking body", async () => {
    const encrypted = encodeReasoningEnvelope({ sig: "RealSig1234567890==", txt: "the hidden signed text" });
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encrypted },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    const assistant = parsed.context.messages.find(m => m.role === "assistant");
    const thinking = (assistant as unknown as { content: OcxThinkingContent[] }).content.find(p => p.type === "thinking");
    expect(thinking?.thinking).toBe("the hidden signed text");
  });

  test("native (non-ocxr1) encrypted_content keeps the placeholder signature", async () => {
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "chain" }], encrypted_content: "gAAAAABopaqueOpenAI" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    const assistant = parsed.context.messages.find(m => m.role === "assistant");
    const thinking = (assistant as unknown as { content: OcxThinkingContent[] }).content.find(p => p.type === "thinking");
    // placeholder JSON.stringify signature — adapter's validity gate rejects it on replay
    expect(thinking?.signature?.startsWith("{")).toBe(true);
  });

  test("anthropic buildRequest replays thinking + redacted blocks verbatim", async () => {
    const adapter = createAnthropicAdapter(provider);
    const encrypted = encodeReasoningEnvelope({ sig: "RealSig1234567890==", red: ["REDDATA"] });
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "chain" }], encrypted_content: encrypted },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "function_call_output", call_id: "call_1", output: "done" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    const req = await adapter.buildRequest(parsed) as { body: string };
    const body = JSON.parse(req.body) as { messages: { role: string; content: unknown }[] };
    const assistant = body.messages.find(m => m.role === "assistant" && Array.isArray(m.content)
      && (m.content as { type: string }[]).some(c => c.type === "thinking"));
    expect(assistant).toBeDefined();
    const content = assistant!.content as { type: string; thinking?: string; signature?: string; data?: string }[];
    const redIdx = content.findIndex(c => c.type === "redacted_thinking");
    const thinkIdx = content.findIndex(c => c.type === "thinking");
    expect(redIdx).toBeGreaterThanOrEqual(0);
    expect(content[redIdx].data).toBe("REDDATA");
    expect(thinkIdx).toBeGreaterThan(redIdx);
    expect(content[thinkIdx].signature).toBe("RealSig1234567890==");
    expect(content[thinkIdx].thinking).toBe("chain");
  });

  test("two signed reasoning siblings replay with each signature attached to its own text", async () => {
    const adapter = createAnthropicAdapter(provider);
    const firstEnvelope = encodeReasoningEnvelope({
      sig: "FirstRealSignature123456==",
      txt: "first signed chain",
    });
    const secondEnvelope = encodeReasoningEnvelope({
      sig: "SecondRealSignature123456==",
      txt: "second signed chain",
    });
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_first", summary: [], encrypted_content: firstEnvelope },
        { type: "reasoning", id: "rs_second", summary: [], encrypted_content: secondEnvelope },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    const parsedAssistant = parsed.context.messages.find(message => message.role === "assistant") as {
      content: OcxThinkingContent[];
    };
    const parsedThinking = parsedAssistant.content.filter(part => part.type === "thinking");

    expect(parsedThinking).toHaveLength(2);
    expect(parsedThinking.map(part => ({
      thinking: part.thinking,
      signature: part.signature,
    }))).toEqual([
      { thinking: "first signed chain", signature: "FirstRealSignature123456==" },
      { thinking: "second signed chain", signature: "SecondRealSignature123456==" },
    ]);

    const request = await adapter.buildRequest(parsed) as { body: string };
    const body = JSON.parse(request.body) as {
      messages: Array<{
        role: string;
        content: Array<{ type: string; thinking?: string; signature?: string; text?: string }>;
      }>;
    };
    const replayedAssistant = body.messages.find(message => message.role === "assistant");
    const replayedThinking = replayedAssistant?.content.filter(block => block.type === "thinking");

    expect(replayedThinking).toEqual([
      { type: "thinking", thinking: "first signed chain", signature: "FirstRealSignature123456==" },
      { type: "thinking", thinking: "second signed chain", signature: "SecondRealSignature123456==" },
    ]);
  });
});

describe("passthrough scrub of ocxr1 envelopes", () => {
  test("sanitize strips ocxr1 encrypted_content even with empty content", async () => {
    const { createResponsesPassthroughAdapter } = await import("../../../src/adapters/openai-responses");
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
      adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward",
    }));
    expect(adapter.passthrough).toBe(true);
    const body = {
      model: "gpt-5.5",
      input: [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: OCX_REASONING_PREFIX + Buffer.from(JSON.stringify({ sig: "RealSig1234567890==" })).toString("base64") },
      ],
    };
    // Build the outgoing request the adapter would send; the ocxr1 envelope must be stripped.
    const req = await adapter.buildRequest(parseRequest(body));
    expect(req.body ?? "").not.toContain(OCX_REASONING_PREFIX);
    expect(req.body ?? "").toContain('"rs_1"'); // reasoning item itself survives
  });
});


describe("Claude / Responses / intended Anthropic replay fidelity", () => {
  // Synthetic fixtures prove transport fidelity only, never upstream signature validity.
  const first = { type: "thinking", thinking: "first\nexact", signature: "FirstSyntheticSignature123456==" };
  const second = { type: "thinking", thinking: "second", signature: "SecondSyntheticSignature123456==" };
  const empty = { type: "thinking", thinking: "", signature: "EmptySyntheticSignature123456==" };
  const before = { type: "redacted_thinking", data: "opaque-before" };
  const middle = { type: "redacted_thinking", data: "opaque-middle" };
  const after = { type: "redacted_thinking", data: "opaque-after" };
  const tool = { type: "tool_use", id: "toolu_replay", name: "lookup", input: { q: "x" } };
  const cases = [
    { name: "consecutive signed blocks", blocks: [first, second, tool] },
    { name: "opaque blocks in source order", blocks: [before, first, middle, second, after, tool] },
    { name: "empty signed block", blocks: [empty, tool] },
    { name: "consecutive empty signed blocks", blocks: [empty, { ...empty, signature: "OtherEmptySyntheticSignature123456==" }, tool] },
    { name: "redacted-only tool turn", blocks: [before, after, tool] },
  ];

  for (const fixture of cases) {
    for (const streaming of [true, false]) {
      test(`${fixture.name}: ${streaming ? "SSE" : "JSON"} full chain preserves exact blocks`, async () => {
        const adapter = createAnthropicAdapter(provider, "none");
        let events: AdapterEvent[];
        if (streaming) {
          const frames = [frame("message_start", { message: { usage: { input_tokens: 1, output_tokens: 0 } } })];
          fixture.blocks.forEach((block, index) => {
            frames.push(frame("content_block_start", { index, content_block: block.type === "thinking"
              ? { type: "thinking", thinking: "", signature: "" }
              : block.type === "tool_use" ? { ...tool, input: {} } : block }));
            if ("thinking" in block) {
              // Omitted thinking has no thinking_delta on the actual wire.
              if (block.thinking) frames.push(frame("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } }));
              frames.push(frame("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } }));
            } else if (block.type === "tool_use") {
              frames.push(frame("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } }));
            }
            frames.push(frame("content_block_stop", { index }));
          });
          frames.push(frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }), frame("message_stop", {}));
          events = await collect(adapter.parseStream(sseResponse(frames)));
        } else {
          events = await adapter.parseResponse!(new Response(JSON.stringify({
            id: "msg_fixture", type: "message", role: "assistant", model: "claude-x",
            content: fixture.blocks, stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
          })));
        }
        let message: Record<string, unknown>;
        if (streaming) {
          async function* upstream() { yield* events; }
          const budget = createTestTranslatorBudget();
          message = await collectAnthropicMessage(responsesSseToAnthropicSse(
            bridgeToResponsesSSE(upstream(), "claude-x"), "claude-x", { translatorBudget: budget },
          ), "claude-x", budget);
        } else {
          message = responsesJsonToAnthropicMessage(buildResponseJSON(events, "claude-x"), "claude-x");
        }
        expect(message.content).toEqual(fixture.blocks);
        const parsed = parseRequest(anthropicToResponsesBody({
          model: "anthropic/claude-x", messages: [
            { role: "user", content: "question" },
            { role: "assistant", content: message.content },
            { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "result" }] },
          ],
        }));
        const request = await adapter.buildRequest(parsed);
        const replay = JSON.parse(request.body as string) as { messages: Array<{ role: string; content: unknown }> };
        expect(replay.messages).toEqual([
          { role: "user", content: "question" },
          { role: "assistant", content: fixture.blocks },
          { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "result" }] },
        ]);
      });
    }
  }

  test("signature updates replace rather than concatenate, across heartbeats", async () => {
    // Both official SDKs assign signature_delta.signature instead of appending it:
    // anthropic-sdk-typescript/src/lib/MessageStream.ts and
    // anthropic-sdk-python/src/anthropic/lib/streaming/_messages.py.
    const adapter = createAnthropicAdapter(provider);
    const events = await collect(adapter.parseStream(sseResponse([
      frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
      frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "first" } }),
      frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "old" } }),
      ": heartbeat\n\n",
      frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "FirstSyntheticSignature123456==" } }),
      frame("content_block_stop", { index: 0 }),
      frame("content_block_start", { index: 1, content_block: { type: "thinking", thinking: "", signature: "" } }),
      frame("content_block_delta", { index: 1, delta: { type: "thinking_delta", thinking: "second" } }),
      frame("content_block_delta", { index: 1, delta: { type: "signature_delta", signature: "SecondSyntheticSignature123456==" } }),
      frame("content_block_stop", { index: 1 }),
      frame("message_stop", {}),
    ])));
    async function* upstream() { yield* events; }
    const streamed = sseItems(await drainSse(bridgeToResponsesSSE(upstream(), "claude-x")));
    const buffered = buildResponseJSON(events, "claude-x").output as Record<string, unknown>[];
    for (const items of [streamed, buffered]) {
      expect(items.map(item => ({ summary: item.summary, envelope: decodeReasoningEnvelope(item.encrypted_content as string) }))).toEqual([
        { summary: [{ type: "summary_text", text: "first" }], envelope: { sig: "FirstSyntheticSignature123456==" } },
        { summary: [{ type: "summary_text", text: "second" }], envelope: { sig: "SecondSyntheticSignature123456==" } },
      ]);
    }
  });

  test("signed/opaque-only assistant turns survive a user boundary and end of input", () => {
    for (const continuation of [[], [{ role: "user", content: "next" }]]) {
      const parsed = parseRequest(anthropicToResponsesBody({ model: "anthropic/claude-x", messages: [
        { role: "assistant", content: [empty, before, after] }, ...continuation,
      ] }));
      const assistant = parsed.context.messages.find(message => message.role === "assistant");
      expect(assistant?.content).toEqual([
        expect.objectContaining({ type: "thinking", thinking: "", signature: empty.signature }),
        expect.objectContaining({ type: "thinking", thinking: "", redacted: [before.data] }),
        expect.objectContaining({ type: "thinking", thinking: "", redacted: [after.data] }),
      ]);
    }
  });

  test("locally hidden signed text remains exact on Responses replay without being exposed to Claude", async () => {
    const events: AdapterEvent[] = [
      { type: "thinking_delta", thinking: "hidden exact\ntext" },
      { type: "thinking_signature", signature: first.signature },
      { type: "text_delta", text: "answer" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    async function* upstream() { yield* events; }
    const items = sseItems(await drainSse(bridgeToResponsesSSE(upstream(), "claude-x", undefined, undefined, undefined, undefined, 2000, { hideThinkingSummary: true })));
    const response = buildResponseJSON(events, "claude-x", { hideThinkingSummary: true });
    for (const output of [items, response.output as Record<string, unknown>[]]) {
      const reasoning = output.find(item => item.type === "reasoning")!;
      expect(reasoning.summary).toEqual([]);
      expect(decodeReasoningEnvelope(reasoning.encrypted_content as string)).toEqual({ sig: first.signature, txt: "hidden exact\ntext" });
      const request = await createAnthropicAdapter(provider, "none").buildRequest(parseRequest({ model: "anthropic/claude-x", input: output }));
      const replay = JSON.parse(request.body as string) as { messages: Array<{ content: unknown }> };
      expect(replay.messages[0].content).toEqual([
        { type: "thinking", thinking: "hidden exact\ntext", signature: first.signature },
        { type: "text", text: "answer" },
      ]);
      // Deliberate existing limitation: no new signed carrier and no hidden-text disclosure.
      expect(JSON.stringify(responsesJsonToAnthropicMessage({ output }, "claude-x"))).not.toContain("hidden exact");
    }
    expect(() => anthropicToResponsesBody({ model: "m", messages: [{ role: "assistant", content: [
      { type: "thinking", thinking: "", signature: encodeReasoningEnvelope({ sig: first.signature, txt: "hidden exact" }) },
    ] }] })).toThrow(/continuity/);
  });

  test("explicitly empty signed envelope text does not fall back to a different summary", () => {
    const parsed = parseRequest({ model: "m", input: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "different summary" }], encrypted_content: encodeReasoningEnvelope({ sig: empty.signature, txt: "" }) },
    ] });
    expect(parsed.context.messages[0]?.content).toEqual([
      { type: "thinking", thinking: "", signature: empty.signature },
    ]);
  });

  test("opaque Anthropic payloads do not become Google signatures or native Responses encryption", async () => {
    const body = anthropicToResponsesBody({ model: "google/gemini-test", messages: [
      { role: "assistant", content: [empty, before, tool] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "result" }] },
    ] });
    const google = withTestTranslatorBudget(createGoogleAdapter({ adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "synthetic" }));
    const request = await google.buildRequest(parseRequest(body));
    for (const output of [request.body as string, JSON.stringify(sanitizeReasoningInputContent(body))]) {
      expect(output).not.toContain(empty.signature);
      expect(output).not.toContain(before.data);
      expect(output).not.toContain("ocxr1:");
    }
    expect(parseRequest({ model: "m", input: [{ type: "reasoning", summary: [], encrypted_content: "native-opaque" }] }).context.messages).toEqual([]);
  });
});
