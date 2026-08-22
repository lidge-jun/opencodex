import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { decodeReasoningEnvelope } from "../src/responses/reasoning-envelope";
import {
  clearReasoningReplayCacheForTests,
  peekReasoningForCall,
} from "../src/responses/reasoning-replay-cache";
import { parseRequest } from "../src/responses/parser";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { AdapterEvent, OcxReasoningReplayScopeRef } from "../src/types";

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

const REPLAY_SCOPE: OcxReasoningReplayScopeRef = {
  clientThreadId: "hidden-replay-thread",
  current: {
    providerName: "routed",
    providerDestinationIdentity: "destination:provider",
    adapterName: "openai-chat",
    modelId: "model",
    credentialIdentity: "key:test",
  },
};
const GLOBAL_SCOPE: OcxReasoningReplayScopeRef = { ...REPLAY_SCOPE, clientThreadId: "global" };
const sseOpts = (hide: boolean) => ({ hideThinkingSummary: hide, replayCacheScope: REPLAY_SCOPE });

describe("hidden raw reasoning (hideThinkingSummary parity for reasoning_raw_delta)", () => {
  beforeEach(() => {
    clearReasoningReplayCacheForTests();
  });
  afterEach(() => {
    clearReasoningReplayCacheForTests();
  });

  test("streamed hidden: no reasoning_text deltas, envelope-only item, tool calls untouched", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "chain " },
      { type: "reasoning_raw_delta", text: "of thought" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, undefined, sseOpts(true)));

    expect(frames.some(f => f.event === "response.reasoning_text.delta")).toBe(false);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    const reasoning = output.filter(o => o.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].content).toBeUndefined();
    expect(reasoning[0].summary).toEqual([]);
    const envelope = decodeReasoningEnvelope(reasoning[0].encrypted_content as string);
    expect(envelope?.txt).toBe("chain of thought");
    const fc = output.find(o => o.type === "function_call") as Record<string, unknown>;
    expect(fc).toMatchObject({ call_id: "call_1", name: "read_file" });
  });

  test("streamed visible (flag off): raw reasoning rides the expandable summary channel (#2007)", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "visible raw" },
      { type: "done" },
    ]), "routed/model"));
    expect(frames.some(f => f.event === "response.reasoning_summary_text.delta")).toBe(true);
    expect(frames.some(f => f.event === "response.reasoning_text.delta")).toBe(false);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output[0]).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "visible raw" }],
    });
  });

  test("streamed hidden: thrown upstream still flushes the envelope before response.failed", async () => {
    async function* throwing(): AsyncGenerator<AdapterEvent> {
      yield { type: "reasoning_raw_delta", text: "doomed thought" };
      throw new Error("upstream exploded");
    }
    const frames = await collectSse(bridgeToResponsesSSE(throwing(), "routed/model", undefined, undefined, undefined, undefined, undefined, sseOpts(true)));
    const failed = frames.find(f => f.event === "response.failed");
    expect(failed).toBeDefined();
    const added = frames.filter(f => f.event === "response.output_item.added")
      .map(f => f.data.item as Record<string, unknown>)
      .filter(i => i.type === "reasoning");
    expect(added).toHaveLength(1);
    expect(decodeReasoningEnvelope(added[0].encrypted_content as string)?.txt).toBe("doomed thought");
  });

  test("non-streaming hidden: envelope-only item instead of raw content", () => {
    const json = buildResponseJSON([
      { type: "reasoning_raw_delta", text: "quiet" },
      { type: "done" },
    ], "routed/model", { hideThinkingSummary: true });
    const output = (json as { output: Record<string, unknown>[] }).output;
    const reasoning = output.find(o => o.type === "reasoning") as Record<string, unknown>;
    expect(reasoning.content).toBeUndefined();
    expect(decodeReasoningEnvelope(reasoning.encrypted_content as string)?.txt).toBe("quiet");
  });

  test("non-streaming visible: raw reasoning lands in the summary channel (#2007)", () => {
    const json = buildResponseJSON([
      { type: "reasoning_raw_delta", text: "loud" },
      { type: "done" },
    ], "routed/model", {});
    const output = (json as { output: Record<string, unknown>[] }).output;
    expect(output.find(o => o.type === "reasoning")).toMatchObject({
      summary: [{ type: "summary_text", text: "loud" }],
    });
  });

  test("replay: envelope-only item round-trips into reasoning_content for preserve-listed models", () => {
    const json = buildResponseJSON([
      { type: "reasoning_raw_delta", text: "replay me" },
      { type: "done" },
    ], "routed/model", { hideThinkingSummary: true });
    const reasoningItem = (json as { output: Record<string, unknown>[] }).output.find(o => o.type === "reasoning");
    const parsed = parseRequest({
      model: "glm-5.2",
      stream: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        reasoningItem,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    const adapter = createOpenAIChatAdapter({
      adapter: "openai-chat", baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKey: "k",
      preserveReasoningContentModels: ["glm-5.2"],
    });
    const body = JSON.parse(adapter.buildRequest(parsed).body) as { messages: Record<string, unknown>[] };
    const assistant = body.messages.find(m => m.role === "assistant" && m.reasoning_content !== undefined);
    expect(assistant?.reasoning_content).toBe("replay me");
  });

  test("streamed hidden: raw reasoning is recorded in the replay cache for the following tool call", async () => {
    await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "chain " },
      { type: "reasoning_raw_delta", text: "of thought" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, undefined, sseOpts(true)));
    expect(peekReasoningForCall("call_1", REPLAY_SCOPE)).toBe("chain of thought");
    expect(peekReasoningForCall("call_other", REPLAY_SCOPE)).toBeUndefined();
  });

  test("streamed hidden: an unscoped bridge never writes a global replay entry", async () => {
    await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "private reasoning" },
      { type: "tool_call_start", id: "call_unscoped_stream", name: "read_file" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, undefined, { hideThinkingSummary: true }));
    expect(peekReasoningForCall("call_unscoped_stream", GLOBAL_SCOPE)).toBeUndefined();
  });

  test("non-streaming hidden: raw reasoning is recorded for the following tool call", () => {
    buildResponseJSON([
      { type: "reasoning_raw_delta", text: "quiet" },
      { type: "tool_call_start", id: "call_2", name: "read_file" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done" },
    ], "routed/model", { hideThinkingSummary: true, replayCacheScope: REPLAY_SCOPE });
    expect(peekReasoningForCall("call_2", REPLAY_SCOPE)).toBe("quiet");
  });

  test("raw reasoning consumed by a text turn is NOT cached for a later tool call", async () => {
    await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "for the text" },
      { type: "text_delta", text: "answer" },
      { type: "tool_call_start", id: "call_later", name: "read_file" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, undefined, sseOpts(true)));
    expect(peekReasoningForCall("call_later", REPLAY_SCOPE)).toBeUndefined();
  });

  test("hidden thinking_delta clears raw reasoning pending for a later tool call", async () => {
    await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "stale raw" },
      { type: "thinking_delta", thinking: "signed thinking follows" },
      { type: "tool_call_start", id: "call_after_thinking", name: "read_file" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, undefined, sseOpts(true)));
    expect(peekReasoningForCall("call_after_thinking", REPLAY_SCOPE)).toBeUndefined();
  });
});
