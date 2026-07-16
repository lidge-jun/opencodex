import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { parseRequest } from "../src/responses/parser";
import { encodeReasoningEnvelope, decodeReasoningEnvelope, OCX_REASONING_PREFIX } from "../src/responses/reasoning-envelope";
import type { AdapterEvent, OcxProviderConfig, OcxThinkingContent } from "../src/types";

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
    const reasoning = output.find(i => i.type === "reasoning");
    expect(reasoning).toBeDefined();
    const env = decodeReasoningEnvelope(reasoning!.encrypted_content as string);
    expect(env?.sig).toBe("RealSig1234567890==");
    expect(env?.red).toEqual(["RED1"]);
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
    const { createResponsesPassthroughAdapter } = await import("../src/adapters/openai-responses");
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", passthrough: true,
    } as OcxProviderConfig);
    expect(adapter.passthrough).toBe(true);
    const body = {
      model: "gpt-5.5",
      input: [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: OCX_REASONING_PREFIX + Buffer.from(JSON.stringify({ sig: "RealSig1234567890==" })).toString("base64") },
      ],
    };
    // Build the outgoing request the adapter would send; the ocxr1 envelope must be stripped.
    const req = await adapter.buildRequest({ _rawBody: body, model: "gpt-5.5", messages: [], options: {} } as never) as { body?: string };
    expect(req.body ?? "").not.toContain(OCX_REASONING_PREFIX);
    expect(req.body ?? "").toContain('"rs_1"'); // reasoning item itself survives
  });
});
