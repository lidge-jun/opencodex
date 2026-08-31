import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON, setOwnedBudgetAbandonedMsForTests } from "../src/bridge";
import {
  createTranslatorBudget,
  resetTranslatorAggregateForTests,
  retainTranslatedEventBatch,
  translatorAggregateCurrentBytesForTests,
  translatorLiveBudgetCountForTests,
} from "../src/lib/translator-budget";
import type { AdapterEvent } from "../src/types";

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

describe("Responses bridge reasoning and usage parity", () => {
  test("first-output callback fires once on first non-empty delta (heartbeat/empty skipped)", async () => {
    let firstOutputs = 0;
    await collectSse(bridgeToResponsesSSE(replay([
      { type: "heartbeat" },
      { type: "text_delta", text: "" },
      { type: "thinking_delta", thinking: "" },
      { type: "reasoning_raw_delta", text: "thinking..." },
      { type: "text_delta", text: "answer" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, undefined, {
      onFirstOutput: () => { firstOutputs += 1; },
    }));
    expect(firstOutputs).toBe(1);
  });

  test("first-output callback fires once for plain text streams", async () => {
    let firstOutputs = 0;
    await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "hello" },
      { type: "text_delta", text: " world" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, undefined, {
      onFirstOutput: () => { firstOutputs += 1; },
    }));
    expect(firstOutputs).toBe(1);
  });

  test("first-output callback ignores tool-only streams", async () => {
    let firstOutputs = 0;
    await collectSse(bridgeToResponsesSSE(replay([
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, undefined, {
      onFirstOutput: () => { firstOutputs += 1; },
    }));
    expect(firstOutputs).toBe(0);
  });

  test("first-output callback still fires for hidden reasoning", async () => {
    let firstOutputs = 0;
    await collectSse(bridgeToResponsesSSE(replay([
      { type: "thinking_delta", thinking: "hidden thought" },
      { type: "text_delta", text: "visible" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, undefined, {
      onFirstOutput: () => { firstOutputs += 1; },
      hideThinkingSummary: true,
    }));
    expect(firstOutputs).toBe(1);
  });

  test("streaming raw reasoning is routed through the expandable summary channel", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "raw detail" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, reasoningOutputTokens: 2 } },
    ]), "routed/model"));

    // Chat-completions providers (DeepSeek-style) deliver thinking as raw
    // reasoning_content. Codex renders the expandable reasoning trace from the
    // Responses summary channel only, so raw reasoning is routed through the
    // summary channel (issue #45) instead of the content channel.
    expect(frames.find(f => f.event === "response.reasoning_summary_text.delta")?.data)
      .toMatchObject({ summary_index: 0, delta: "raw detail" });
    expect(frames.some(f => f.event === "response.reasoning_text.delta")).toBe(false);

    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output[0]).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "raw detail" }],
    });
    expect((output[0] as { content?: unknown }).content).toBeUndefined();
    expect(completed.usage).toMatchObject({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 15,
    });
  });

  test("streaming summary thinking still emits reasoning summary events", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "thinking_delta", thinking: "summary" },
      { type: "done" },
    ]), "routed/model"));

    expect(frames.find(f => f.event === "response.reasoning_summary_text.delta")?.data)
      .toMatchObject({ summary_index: 0, delta: "summary" });
    expect(frames.some(f => f.event === "response.reasoning_text.delta")).toBe(false);
  });

  test("usage totalTokens overrides input plus output totals", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 50_000, estimated: true } },
    ]), "kiro/claude-sonnet-4.5"));

    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    expect(completed.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 50_000,
    });
  });

  test("absolute context total drives Responses compaction without double-counting output", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      {
        type: "done",
        usage: {
          inputTokens: 58,
          contextTotalTokens: 226_000,
          outputTokens: 12,
          estimated: true,
        },
      },
    ]), "kiro/claude-opus-5"));

    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    expect(completed.usage).toEqual({
      input_tokens: 225_988,
      output_tokens: 12,
      total_tokens: 226_000,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  test("consecutive context checkpoints remain absolute instead of accumulating in the bridge", async () => {
    const totals: number[] = [];
    for (const [contextTotalTokens, outputTokens] of [[10_000, 42], [10_300, 20]] as const) {
      const frames = await collectSse(bridgeToResponsesSSE(replay([{
        type: "done",
        usage: { inputTokens: 1, contextTotalTokens, outputTokens, estimated: true },
      }]), "kiro/claude-opus-5"));
      const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
      const usage = completed.usage as Record<string, number>;
      expect(usage.input_tokens).toBe(contextTotalTokens - outputTokens);
      expect(usage.total_tokens).toBe(contextTotalTokens);
      totals.push(usage.total_tokens);
    }
    expect(totals).toEqual([10_000, 10_300]);
  });

  test("usage details are always present with zero defaults (grok-build strict Responses client)", async () => {
    // grok-build's pinned async-openai deserializes input_tokens_details/output_tokens_details
    // as required fields; omitting them fails the turn after successful text (2026-07-23 live).
    const withoutDetails = await collectSse(bridgeToResponsesSSE(replay([
      { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
    ]), "routed/model"));
    const completed = withoutDetails.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    expect(completed.usage).toMatchObject({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    });

    const noUsage = await collectSse(bridgeToResponsesSSE(replay([
      { type: "done" },
    ]), "routed/model"));
    const bare = noUsage.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    expect(bare.usage).toMatchObject({
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    });

    const json = buildResponseJSON([
      { type: "done", usage: { inputTokens: 7, outputTokens: 3 } },
    ], "routed/model");
    expect(json.usage).toMatchObject({
      input_tokens: 7,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 10,
    });
  });

  test("onUsage reports raw adapter usage while the wire carries synthetic zero details", async () => {
    // Provenance guard: request-log consumers must see the adapter-reported usage (no
    // cache/reasoning numbers => cache_detail_missing), not the normalized wire zeros.
    let rawUsage: unknown = "unset";
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
    ]), "routed/model", undefined, undefined, undefined, undefined, 2_000, {
      onUsage: usage => { rawUsage = usage; },
    }));
    expect(rawUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    expect((completed.usage as Record<string, unknown>).input_tokens_details).toEqual({ cached_tokens: 0 });

    let jsonRawUsage: unknown = "unset";
    buildResponseJSON([
      { type: "done", usage: { inputTokens: 4, outputTokens: 2 } },
    ], "routed/model", { onUsage: usage => { jsonRawUsage = usage; } });
    expect(jsonRawUsage).toEqual({ inputTokens: 4, outputTokens: 2 });

    // Adapter EOF (no terminal event): onUsage must still fire with undefined so the
    // request log keeps provenance (usageFromBridge) instead of re-parsing wire zeros.
    let eofUsage: unknown = "unset";
    const eofFrames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "partial" },
    ]), "routed/model", undefined, undefined, undefined, undefined, 2_000, {
      onUsage: usage => { eofUsage = usage; },
    }));
    expect(eofUsage).toBeUndefined();
    const eofResponse = eofFrames.find(f => f.event === "response.incomplete")?.data.response as Record<string, unknown>;
    expect(eofResponse.incomplete_details).toMatchObject({ reason: "adapter_eof" });
    expect(eofResponse.usage).toMatchObject({
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  test("incomplete and failed terminal events also carry zero-default usage details", async () => {
    const incomplete = await collectSse(bridgeToResponsesSSE(replay([
      {
        type: "incomplete",
        reason: "upstream_truncated",
        retryable: true,
        endTurn: false,
        usage: { inputTokens: 8, outputTokens: 1 },
      },
    ]), "routed/model"));
    const incompleteResponse = incomplete.find(f => f.event === "response.incomplete")?.data.response as Record<string, unknown>;
    expect(incompleteResponse.usage).toMatchObject({
      input_tokens: 8,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });

    const failed = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "partial" },
      { type: "error", message: "boom", status: 502, usage: { inputTokens: 3, outputTokens: 1 } },
    ]), "routed/model"));
    const failedResponse = failed.find(f => f.event === "response.failed")?.data.response as Record<string, unknown>;
    expect(failedResponse.usage).toMatchObject({
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  test("Anthropic cache read and write tokens pass through Responses usage without re-adding", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      {
        type: "done",
        usage: {
          // canonical convention: inputTokens already includes cache read + write
          inputTokens: 78_600,
          outputTokens: 20,
          cachedInputTokens: 77_000,
          cacheReadInputTokens: 77_000,
          cacheCreationInputTokens: 1_000,
        },
      },
    ]), "anthropic/claude-opus-4-6"));

    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    expect(completed.usage).toMatchObject({
      input_tokens: 78_600,
      input_tokens_details: { cached_tokens: 77_000, cache_write_tokens: 1_000 },
      output_tokens: 20,
      total_tokens: 78_620,
    });
  });

  test("absolute context projection keeps cache details within derived input", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([{
      type: "done",
      usage: {
        inputTokens: 200,
        outputTokens: 10,
        contextTotalTokens: 100,
        cachedInputTokens: 150,
        cacheReadInputTokens: 150,
        cacheCreationInputTokens: 50,
      },
    }]), "kiro/claude-opus-5"));

    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    expect(completed.usage).toMatchObject({
      input_tokens: 90,
      output_tokens: 10,
      total_tokens: 100,
      input_tokens_details: { cached_tokens: 90, cache_write_tokens: 0 },
    });
  });

  test("adapter heartbeat is non-visual in streaming and non-streaming responses", async () => {
    const events: AdapterEvent[] = [
      { type: "heartbeat" },
      { type: "text_delta", text: "ok" },
      { type: "heartbeat" },
      { type: "done" },
    ];
    const frames = await collectSse(bridgeToResponsesSSE(replay(events), "routed/model"));
    expect(frames.some(f => f.event === "response.heartbeat")).toBe(false);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ type: "message" });

    const json = buildResponseJSON(events, "routed/model");
    expect((json.output as Record<string, unknown>[]).map(item => item.type)).toEqual(["message"]);
    expect(json.status).toBe("completed");
  });

  test("non-streaming bridge fails closed when upstream calls an undeclared tool", () => {
    const json = buildResponseJSON([
      { type: "tool_call_start", id: "call_bad", name: "other_tool" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done" },
    ], "deepseek/deepseek-v4-flash", { declaredToolNames: new Set(["exec"]) });

    expect(json.status).toBe("failed");
    expect(json.output).toEqual([]);
    expect((json.error as Record<string, unknown>).message).toContain("undeclared client tool");
  });

  test("raw reasoning closes before later text output and preserves ordering", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "raw" },
      { type: "text_delta", text: "answer" },
      { type: "done" },
    ]), "routed/model"));

    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output.map(item => item.type)).toEqual(["reasoning", "message"]);
    expect((output[1].content as Record<string, unknown>[])[0].text).toBe("answer");
  });

  test("raw reasoning closes before later tool calls", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "raw" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"README.md\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "routed/model"));

    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output.map(item => item.type)).toEqual(["reasoning", "function_call"]);
    expect(output[1].id).toStartWith("fc_");
    expect(output[1]).toMatchObject({ name: "read_file", arguments: "{\"path\":\"README.md\"}" });
  });

  test("streaming bridge exposes completed response to state callbacks", async () => {
    let completed: Record<string, unknown> | undefined;
    await collectSse(bridgeToResponsesSSE(replay([
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"README.md\"}" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, 2_000, {
      onCompletedResponse: response => {
        completed = response;
      },
    }));

    expect(completed).toMatchObject({
      status: "completed",
      output: [{ type: "function_call", name: "read_file", arguments: "{\"path\":\"README.md\"}" }],
    });
  });

  test("message phase and end_turn propagate through streaming added/done/completed events", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "Working…", phase: "commentary" },
      { type: "text_delta", text: "Finished.", phase: "final_answer" },
      { type: "done", endTurn: true },
    ]), "kiro/gpt-5.6-sol"));

    const added = frames
      .filter(frame => frame.event === "response.output_item.added")
      .map(frame => frame.data.item as Record<string, unknown>);
    const done = frames
      .filter(frame => frame.event === "response.output_item.done")
      .map(frame => frame.data.item as Record<string, unknown>);
    expect(added.map(item => item.phase)).toEqual(["commentary", "final_answer"]);
    expect(done.map(item => item.phase)).toEqual(["commentary", "final_answer"]);

    const completed = frames.find(frame => frame.event === "response.completed")?.data.response as Record<string, unknown>;
    expect(completed.end_turn).toBe(true);
    expect((completed.output as Record<string, unknown>[]).map(item => item.phase)).toEqual(["commentary", "final_answer"]);
  });

  test("unphased terminal text is finalized as one final_answer message (#542)", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "Only " },
      { type: "text_delta", text: "once." },
      { type: "done" },
    ]), "routed/chat-model"));

    const added = frames.find(frame => frame.event === "response.output_item.added")?.data.item as Record<string, unknown>;
    const done = frames.find(frame => frame.event === "response.output_item.done")?.data.item as Record<string, unknown>;
    const completed = frames.find(frame => frame.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];

    expect(added.phase).toBeUndefined();
    expect(done).toMatchObject({ id: added.id, phase: "final_answer" });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ id: added.id, phase: "final_answer" });
  });

  test("unphased text before a tool call is finalized as commentary (#542)", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "I will inspect that." },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ]), "routed/chat-model"));

    const completed = frames.find(frame => frame.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output[0]).toMatchObject({ type: "message", phase: "commentary" });
    expect(output[1]).toMatchObject({ type: "function_call", name: "read_file" });
  });

  test("explicit incomplete event stays incomplete with retry metadata", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "partial reasoning" },
      {
        type: "incomplete",
        reason: "empty_or_unfinished_kiro_response",
        message: "Kiro did not complete the turn",
        retryable: true,
        endTurn: false,
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    ]), "kiro/gpt-5.6-sol"));

    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
    const response = frames.find(frame => frame.event === "response.incomplete")?.data.response as Record<string, unknown>;
    expect(response).toMatchObject({
      status: "incomplete",
      end_turn: false,
      incomplete_details: {
        reason: "empty_or_unfinished_kiro_response",
        message: "Kiro did not complete the turn",
        retryable: true,
      },
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
  });

  test("non-streaming JSON includes raw reasoning item and usage details", () => {
    const json = buildResponseJSON([
      { type: "reasoning_raw_delta", text: "raw json" },
      { type: "text_delta", text: "answer" },
      // canonical convention: inputTokens already includes cache read (1) + write (2)
      { type: "done", usage: { inputTokens: 6, outputTokens: 6, cachedInputTokens: 1, cacheCreationInputTokens: 2, reasoningOutputTokens: 2 } },
    ], "routed/model");

    const output = json.output as Record<string, unknown>[];
    expect(output.map(item => item.type)).toEqual(["reasoning", "message"]);
    expect(output[0]).toMatchObject({
      summary: [{ type: "summary_text", text: "raw json" }],
    });
    expect((output[0] as { content?: unknown }).content).toBeUndefined();
    expect(json.usage).toMatchObject({
      input_tokens: 6,
      input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 12,
    });
  });

  test("non-streaming JSON preserves phase, end_turn, and incomplete semantics", () => {
    const completed = buildResponseJSON([
      { type: "text_delta", text: "progress", phase: "commentary" },
      { type: "text_delta", text: "answer", phase: "final_answer" },
      { type: "done", endTurn: true },
    ], "kiro/gpt-5.6-sol");
    expect(completed.end_turn).toBe(true);
    expect((completed.output as Record<string, unknown>[]).map(item => item.phase)).toEqual(["commentary", "final_answer"]);

    const incomplete = buildResponseJSON([
      { type: "incomplete", reason: "empty_kiro_stream", retryable: true, endTurn: false },
    ], "kiro/gpt-5.6-sol");
    expect(incomplete).toMatchObject({
      status: "incomplete",
      end_turn: false,
      incomplete_details: { reason: "empty_kiro_stream", retryable: true },
    });
  });

  test("non-streaming JSON infers terminal and pre-tool phases without overriding explicit phases (#542)", () => {
    const terminal = buildResponseJSON([
      { type: "text_delta", text: "Only once." },
      { type: "done" },
    ], "routed/chat-model");
    expect((terminal.output as Record<string, unknown>[])[0]).toMatchObject({ phase: "final_answer" });

    const preTool = buildResponseJSON([
      { type: "text_delta", text: "I will inspect that." },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ], "routed/chat-model");
    expect((preTool.output as Record<string, unknown>[])[0]).toMatchObject({ phase: "commentary" });

    const explicit = buildResponseJSON([
      { type: "text_delta", text: "Explicit.", phase: "commentary" },
      { type: "done" },
    ], "routed/chat-model");
    expect((explicit.output as Record<string, unknown>[])[0]).toMatchObject({ phase: "commentary" });
  });

  test("later text_delta omitting phase keeps the prior explicit phase", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "Hello ", phase: "final_answer" },
      { type: "text_delta", text: "world." },
      { type: "done" },
    ]), "routed/chat-model"));
    const completed = frames.find(frame => frame.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      type: "message",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Hello world." }],
    });

    const batch = buildResponseJSON([
      { type: "text_delta", text: "Hello ", phase: "final_answer" },
      { type: "text_delta", text: "world." },
      { type: "done" },
    ], "routed/chat-model");
    expect((batch.output as Record<string, unknown>[])).toHaveLength(1);
    expect((batch.output as Record<string, unknown>[])[0]).toMatchObject({
      type: "message",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Hello world." }],
    });
  });

  test("structured adapter errors override message heuristics", () => {
    const json = buildResponseJSON([
      {
        type: "error",
        message: "provider rejected this payload",
        status: 400,
        errorType: "invalid_request_error",
        code: "context_length_exceeded",
        retryable: false,
      },
    ], "kiro/gpt-5.6-sol");

    expect(json.status).toBe("failed");
    expect(json.error).toMatchObject({
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: "provider rejected this payload",
    });
  });

  test("non-streaming preserves text → tool → text output order", () => {
    const json = buildResponseJSON([
      { type: "text_delta", text: "before" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"x\"}" },
      { type: "tool_call_end" },
      { type: "text_delta", text: "after" },
      { type: "done" },
    ], "model");

    const output = json.output as Record<string, unknown>[];
    expect(output.map(item => item.type)).toEqual(["message", "function_call", "message"]);
    expect((output[0].content as Record<string, unknown>[])[0].text).toBe("before");
    expect(output[1]).toMatchObject({ name: "read_file", arguments: "{\"path\":\"x\"}" });
    expect((output[2].content as Record<string, unknown>[])[0].text).toBe("after");
  });

  test("non-streaming custom_tool_call and tool_search_call types", () => {
    const freeform = new Set(["apply_patch"]);
    const toolSearch = new Set(["tool_search"]);
    const json = buildResponseJSON([
      { type: "tool_call_start", id: "c1", name: "apply_patch" },
      { type: "tool_call_delta", arguments: "{\"input\":\"patch data\"}" },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "c2", name: "tool_search" },
      { type: "tool_call_delta", arguments: "{\"query\":\"find\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ], "model", { freeformToolNames: freeform, toolSearchToolNames: toolSearch });

    const output = json.output as Record<string, unknown>[];
    expect(output[0].type).toBe("custom_tool_call");
    expect(output[0].id).toStartWith("ctc_");
    expect(output[0].input).toBe("patch data");
    expect(output[1].type).toBe("tool_search_call");
    expect(output[1].id).toStartWith("tsc_");
  });

  test("streaming freeform tool call emits unwrapped custom_tool_call_input deltas", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "tool_call_start", id: "c1", name: "apply_patch" },
      // JSON wrapper split across chunks, incl. an escape split at a boundary.
      { type: "tool_call_delta", arguments: "{\"inp" },
      { type: "tool_call_delta", arguments: "ut\":\"line1\\" },
      { type: "tool_call_delta", arguments: "nline2\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "model", undefined, new Set(["apply_patch"])));

    const added = frames.find(f => f.event === "response.output_item.added")?.data.item as Record<string, unknown>;
    const deltaEvents = frames.filter(f => f.event === "response.custom_tool_call_input.delta");
    const deltas = deltaEvents.map(f => f.data.delta);
    expect(deltas.join("")).toBe("line1\nline2");
    // No raw JSON wrapper fragments leak into the preview stream.
    for (const d of deltas) expect(String(d)).not.toContain("{\"inp");

    const doneEvt = frames.find(f => f.event === "response.custom_tool_call_input.done")?.data;
    expect(doneEvt).toMatchObject({ input: "line1\nline2" });

    const item = frames.find(f => f.event === "response.output_item.done")?.data.item as Record<string, unknown>;
    expect(item).toMatchObject({ type: "custom_tool_call", input: "line1\nline2", status: "completed" });
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const completedItem = (completed.output as Record<string, unknown>[])[0];
    expect(added.id).toStartWith("ctc_");
    expect(deltaEvents.every(f => f.data.item_id === added.id)).toBe(true);
    expect(doneEvt?.item_id).toBe(added.id);
    expect(item.id).toBe(added.id);
    expect(completedItem.id).toBe(added.id);
    // Freeform calls must NOT emit function_call_arguments events.
    expect(frames.some(f => f.event === "response.function_call_arguments.delta")).toBe(false);
    expect(frames.some(f => f.event === "response.function_call_arguments.done")).toBe(false);
  });

  test("repairs a complete decorated top-level apply_patch payload", () => {
    const body = `*** Begin Patch ***
*** Update File: README.md
@@
-old
+new
*** End Patch ***`;
    const json = buildResponseJSON([
      { type: "tool_call_start", id: "c1", name: "apply_patch" },
      { type: "tool_call_delta", arguments: JSON.stringify({ input: body }) },
      { type: "tool_call_end" },
      { type: "done" },
    ], "model", { freeformToolNames: new Set(["apply_patch"]) });

    const output = json.output as Record<string, unknown>[];
    expect(output[0]).toMatchObject({ type: "custom_tool_call", name: "apply_patch" });
    expect(output[0].input).toContain("*** Begin Patch\n");
    expect(output[0].input).toContain("*** End Patch");
    expect(output[0].input).not.toContain("*** Begin Patch ***");
  });

  test("preserves namespaced apply_patch payloads across streaming and buffered bridges", async () => {
    const decorated = `*** Begin Patch ***
*** Update File: README.md
@@
-old
+new
*** End Patch ***`;
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "c1", name: "mcp__apply_patch" },
      { type: "tool_call_delta", arguments: JSON.stringify({ input: decorated }) },
      { type: "tool_call_end" },
      { type: "done" },
    ];
    const toolNsMap = new Map([
      ["mcp__apply_patch", { namespace: "mcp", name: "apply_patch", freeform: true as const }],
    ]);

    const json = buildResponseJSON(events, "model", { toolNsMap });
    const output = json.output as Record<string, unknown>[];
    expect(output[0]).toMatchObject({
      type: "custom_tool_call",
      namespace: "mcp",
      name: "apply_patch",
      input: decorated,
    });

    const frames = await collectSse(bridgeToResponsesSSE(replay(events), "model", toolNsMap));
    const itemAdded = frames.find(frame => frame.event === "response.output_item.added")?.data.item as Record<string, unknown>;
    expect(itemAdded).toMatchObject({ type: "custom_tool_call", namespace: "mcp", name: "apply_patch" });
    const inputDone = frames.find(frame => frame.event === "response.custom_tool_call_input.done")?.data;
    expect(inputDone).toMatchObject({ namespace: "mcp", input: decorated });
    const itemDone = frames.find(frame => frame.event === "response.output_item.done")?.data.item as Record<string, unknown>;
    expect(itemDone).toMatchObject({
      type: "custom_tool_call",
      namespace: "mcp",
      name: "apply_patch",
      input: decorated,
    });
    const completed = frames.find(frame => frame.event === "response.completed")?.data.response as Record<string, unknown>;
    expect((completed.output as Record<string, unknown>[])[0]).toMatchObject({
      type: "custom_tool_call",
      namespace: "mcp",
      name: "apply_patch",
      input: decorated,
    });

    const incompleteEvents: AdapterEvent[] = [
      { type: "tool_call_start", id: "c2", name: "mcp__apply_patch" },
      { type: "tool_call_delta", arguments: JSON.stringify({ input: decorated }) },
      { type: "incomplete", reason: "upstream_truncated", retryable: true },
    ];
    const incompleteJson = buildResponseJSON(incompleteEvents, "model", { toolNsMap });
    expect((incompleteJson.output as Record<string, unknown>[])[0]).toMatchObject({
      type: "custom_tool_call",
      namespace: "mcp",
      name: "apply_patch",
      status: "incomplete",
    });

    const incompleteFrames = await collectSse(bridgeToResponsesSSE(replay(incompleteEvents), "model", toolNsMap));
    const incompleteItem = incompleteFrames.find(frame => frame.event === "response.output_item.done")?.data.item;
    expect(incompleteItem).toMatchObject({
      type: "custom_tool_call",
      namespace: "mcp",
      name: "apply_patch",
      status: "incomplete",
    });
    const incompleteResponse = incompleteFrames.find(frame => frame.event === "response.incomplete")?.data.response as Record<string, unknown>;
    expect((incompleteResponse.output as Record<string, unknown>[])[0]).toMatchObject({
      type: "custom_tool_call",
      namespace: "mcp",
      name: "apply_patch",
      status: "incomplete",
    });
  });

  test("non-streaming error produces failed status", () => {
    const json = buildResponseJSON([
      {
        type: "error",
        message: "",
        status: 502,
        errorType: "upstream_error",
        code: "kiro_stream_error",
        retryable: true,
        usage: { inputTokens: 7, outputTokens: 3 },
      },
    ], "model");

    expect(json.status).toBe("failed");
    expect(json.retryable).toBe(true);
    expect(json.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 });
    expect(json.error).toMatchObject({ type: "upstream_error", code: "kiro_stream_error", message: "" });
    expect((json.output as unknown[]).length).toBe(0);
  });

  test("non-streaming MCP namespace restoration", () => {
    const toolNsMap = new Map([["mcp__ctx__lookup", { namespace: "mcp__ctx", name: "lookup" }]]);
    const json = buildResponseJSON([
      { type: "tool_call_start", id: "c1", name: "mcp__ctx__lookup" },
      { type: "tool_call_delta", arguments: "{\"q\":\"test\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ], "model", { toolNsMap });

    const output = json.output as Record<string, unknown>[];
    expect(output[0]).toMatchObject({ type: "function_call", name: "lookup", namespace: "mcp__ctx" });
  });

  test("streaming hideThinkingSummary suppresses thinking_delta", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "thinking_delta", thinking: "hidden thought" },
      { type: "text_delta", text: "visible" },
      { type: "done" },
    ]), "model", undefined, undefined, undefined, undefined, undefined, { hideThinkingSummary: true }));

    expect(frames.some(f => f.event === "response.reasoning_summary_text.delta")).toBe(false);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output.map(item => item.type)).toEqual(["message"]);
  });

  test("non-streaming hideThinkingSummary suppresses summary reasoning", () => {
    const json = buildResponseJSON([
      { type: "thinking_delta", thinking: "hidden" },
      { type: "text_delta", text: "visible" },
      { type: "done" },
    ], "model", { hideThinkingSummary: true });

    const output = json.output as Record<string, unknown>[];
    expect(output.map(item => item.type)).toEqual(["message"]);
  });

  test("streaming hideThinkingSummary suppresses raw reasoning", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "hidden raw thought" },
      { type: "text_delta", text: "visible" },
      { type: "done" },
    ]), "model", undefined, undefined, undefined, undefined, undefined, { hideThinkingSummary: true }));

    expect(frames.some(f => f.event === "response.reasoning_summary_text.delta")).toBe(false);
    expect(frames.some(f => f.event === "response.reasoning_text.delta")).toBe(false);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    // Raw reasoning stays hidden: the text round-trips only in an ocxr1 envelope,
    // never as visible summary or content.
    expect(output.map(item => item.type)).toEqual(["reasoning", "message"]);
    expect(output[0]).toMatchObject({
      type: "reasoning",
      summary: [],
    });
    expect((output[0] as { encrypted_content?: string }).encrypted_content).toStartWith("ocxr1:");
    expect((output[0] as { content?: unknown }).content).toBeUndefined();
  });

  test("non-streaming hideThinkingSummary suppresses raw reasoning", () => {
    const json = buildResponseJSON([
      { type: "reasoning_raw_delta", text: "hidden" },
      { type: "text_delta", text: "visible" },
      { type: "done" },
    ], "model", { hideThinkingSummary: true });

    const output = json.output as Record<string, unknown>[];
    expect(output.map(item => item.type)).toEqual(["reasoning", "message"]);
    expect(output[0]).toMatchObject({ type: "reasoning", summary: [] });
    expect((output[0] as { encrypted_content?: string }).encrypted_content).toStartWith("ocxr1:");
    expect((output[0] as { content?: unknown }).content).toBeUndefined();
  });

  test("heartbeat events reset the stall watchdog and emit no protocol frame", async () => {
    // Regression for the Cursor parallel-tool-call stall: while the upstream silently assembles tool
    // calls, the adapter emits `heartbeat` events. They must keep the stall watchdog alive (no
    // upstream_stall_timeout). Adapter heartbeats themselves are not translated into Responses
    // protocol items; wire keepalives use a separate SSE comment line (see next test).
    //
    // resolveStallTimeoutSec ceils to a minimum of 1s, so sub-second stallTimeoutSec values cannot
    // prove the reset. Drive the beat loop through a test clock seam and run adapter-only progress
    // past the effective deadline.
    const heartbeatMs = 50;
    const stallTimeoutSec = 1; // effective after resolveStallTimeoutSec
    const maxStallTicks = Math.ceil((stallTimeoutSec * 1000) / heartbeatMs);
    const cycles = maxStallTicks + 5; // wall-clock equivalent >> stall deadline

    let beatTick: (() => void) | undefined;
    const timers = {
      setInterval(handler: () => void, _ms: number) {
        beatTick = handler;
        return 1;
      },
      clearInterval(_id: unknown) {
        beatTick = undefined;
      },
    };

    let waitResolve: (() => void) | undefined;
    const waitDelay = () => new Promise<void>(resolve => { waitResolve = resolve; });
    const releaseDelay = () => {
      const resolve = waitResolve;
      waitResolve = undefined;
      resolve?.();
    };
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    async function* heartbeatsThenDone(): AsyncGenerator<AdapterEvent> {
      for (let i = 0; i < cycles; i++) {
        yield { type: "heartbeat" };
        await waitDelay();
      }
      yield { type: "text_delta", text: "ok" };
      yield { type: "done" };
    }

    const framesPromise = collectSse(bridgeToResponsesSSE(
      heartbeatsThenDone(),
      "model",
      undefined,
      undefined,
      undefined,
      undefined,
      heartbeatMs,
      { stallTimeoutSec, timers },
    ));

    // First heartbeat is pulled; step blocks on the delay gate with gated=false.
    await flush();
    for (let i = 0; i < cycles; i++) {
      // maxStallTicks silent ticks would trip the watchdog if the preceding heartbeat did not
      // count as upstream activity (first tick clears the flag; the rest must not reach the limit).
      // Heartbeats between cycles reset the counter, so the stream must survive the full run.
      for (let t = 0; t < maxStallTicks; t++) beatTick?.();
      releaseDelay();
      await flush();
    }

    const frames = await framesPromise;
    expect(frames.some(f => {
      const response = f.data.response as Record<string, unknown> | undefined;
      const details = response?.incomplete_details as Record<string, unknown> | undefined;
      return details?.reason === "upstream_stall_timeout";
    })).toBe(false);
    expect(frames.some(f => f.event === "response.completed")).toBe(true);
    // Adapter heartbeats must not be mis-translated into a protocol event of their own.
    expect(frames.some(f => f.data.type === "heartbeat")).toBe(false);
  });

  test("wire keepalive keeps firing while only adapter heartbeats flow", async () => {
    // Issue #521: web-search buffers semantic events and yields invisible adapter heartbeats from
    // raw-byte progress. Those must not suppress wire keepalives, or Codex Desktop idle-timeouts
    // (~5 min) while OCX still considers the upstream alive. The default keep-alive is the typed
    // response.heartbeat frame (codex-rs re-arms only on parsed EVENTS — 110 RCA); the grok
    // surface swaps to comment lines via heartbeatStyle.
    const heartbeatMs = 50;
    const stallTimeoutSec = 1;
    const cycles = 4;

    let beatTick: (() => void) | undefined;
    const timers = {
      setInterval(handler: () => void, _ms: number) {
        beatTick = handler;
        return 1;
      },
      clearInterval(_id: unknown) {
        beatTick = undefined;
      },
    };

    let waitResolve: (() => void) | undefined;
    const waitDelay = () => new Promise<void>(resolve => { waitResolve = resolve; });
    const releaseDelay = () => {
      const resolve = waitResolve;
      waitResolve = undefined;
      resolve?.();
    };
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    async function* adapterHeartbeatsOnly(): AsyncGenerator<AdapterEvent> {
      for (let i = 0; i < cycles; i++) {
        yield { type: "heartbeat" };
        await waitDelay();
      }
      yield { type: "text_delta", text: "ok" };
      yield { type: "done" };
    }

    const stream = bridgeToResponsesSSE(
      adapterHeartbeatsOnly(),
      "model",
      undefined,
      undefined,
      undefined,
      undefined,
      heartbeatMs,
      { stallTimeoutSec, timers },
    );
    const rawTextPromise = new Response(stream).text();

    await flush();
    for (let i = 0; i < cycles; i++) {
      // Several silent beat ticks per adapter-only gap → multiple wire keepalives.
      for (let t = 0; t < 3; t++) beatTick?.();
      releaseDelay();
      await flush();
    }
    const rawText = await rawTextPromise;
    const frames: { event?: string; data: Record<string, unknown> }[] = [];
    for (const frame of rawText.split("\n\n")) {
      const trimmed = frame.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      const lines = trimmed.split("\n");
      const event = lines.find(l => l.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(l => l.startsWith("data: "));
      // Skip data-less frames; a keep-alive frame carries its own data line now.
      if (!dataLine) continue;
      frames.push({ event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> });
    }

    // Wire keepalives are typed response.heartbeat frames — codex-rs ignores the unknown
    // variant but its eventsource layer still yields an event, re-arming the idle timer.
    const keepaliveCount = (rawText.match(/^event: response.heartbeat$/gm) ?? []).length;
    expect(keepaliveCount).toBeGreaterThan(1);
    expect(frames.some(f => f.event === "response.completed")).toBe(true);
    expect(frames.some(f => (f.data.response as Record<string, unknown> | undefined)?.incomplete_details)).toBe(false);
    // Reject every adapter-shaped heartbeat payload, regardless of event name or field count.
    expect(frames.some(f => f.data.type === "heartbeat")).toBe(false);
  });
});

describe("Responses bridge web_search_call native item", () => {
  test("streaming web_search_call emits an added/done pair with action.query and a completed turn", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "web_search_call_begin", id: "ws_1" },
      { type: "web_search_call_end", id: "ws_1", queries: ["current docs"] },
      { type: "text_delta", text: "answer" },
      { type: "done" },
    ]), "routed/model"));

    const added = frames.find(f => f.event === "response.output_item.added"
      && (f.data.item as Record<string, unknown>)?.type === "web_search_call");
    const done = frames.find(f => f.event === "response.output_item.done"
      && (f.data.item as Record<string, unknown>)?.type === "web_search_call");
    expect(added).toBeDefined();
    expect(done).toBeDefined();
    const addedItem = added!.data.item as Record<string, unknown>;
    const doneItem = done!.data.item as Record<string, unknown>;
    // Same id on both frames so codex-rs reconciles the started/completed cell.
    expect(typeof addedItem.id).toBe("string");
    expect((addedItem.id as string).startsWith("ws_")).toBe(true);
    expect(doneItem.id).toBe(addedItem.id);
    expect(doneItem.status).toBe("completed");
    // Both shapes: codex-rs reads `query`, and DeepSeek's native Responses parser
    // requires `queries` when the item is replayed in later turns (#930).
    expect(doneItem.action).toEqual({ type: "search", query: "current docs", queries: ["current docs"] });

    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    // Search item is finalized into the snapshot ahead of the assistant message.
    expect(output.map(item => item.type)).toEqual(["web_search_call", "message"]);
  });

  test("non-streaming web_search_call pushes a completed search item before the message", () => {
    const json = buildResponseJSON([
      { type: "web_search_call_begin", id: "ws_2" },
      { type: "web_search_call_end", id: "ws_2", queries: ["weather seattle"] },
      { type: "text_delta", text: "answer" },
      { type: "done" },
    ], "routed/model");

    const output = json.output as Record<string, unknown>[];
    expect(output.map(item => item.type)).toEqual(["web_search_call", "message"]);
    expect(output[0]).toMatchObject({
      type: "web_search_call", status: "completed", action: { type: "search", query: "weather seattle" },
    });
  });

  test("a batched (plural) search carries both query and queries for Console Go (#3071)", () => {
    const json = buildResponseJSON([
      { type: "web_search_call_begin", id: "ws_3" },
      { type: "web_search_call_end", id: "ws_3", queries: ["rust async", "tokio runtime"] },
      { type: "text_delta", text: "answer" },
      { type: "done" },
    ], "routed/model");

    const output = json.output as Record<string, unknown>[];
    const action = (output[0] as Record<string, unknown>).action as Record<string, unknown>;
    // Console Go's upstream validator requires singular `query` on the search action,
    // and DeepSeek native Responses requires `queries` — so a batch carries both now.
    expect(action).toEqual({ type: "search", query: "rust async", queries: ["rust async", "tokio runtime"] });
  });

  test("a single-query search also carries queries so strict parsers accept the replay (#930)", () => {
    // DeepSeek's native Responses parser requires `queries`. Without it, the replayed
    // web_search_call in every later turn of the conversation fails deserialization with
    // `missing field 'queries'` and 400s the whole thread.
    const json = buildResponseJSON([
      { type: "web_search_call_begin", id: "ws_930" },
      { type: "web_search_call_end", id: "ws_930", queries: ["deepseek responses"] },
      { type: "text_delta", text: "answer" },
      { type: "done" },
    ], "routed/model");

    const action = (json.output as Record<string, unknown>[])[0].action as Record<string, unknown>;
    expect(action.queries).toEqual(["deepseek responses"]);
    // `query` stays present: codex-rs reads it, and the single-query rendering depends
    // on it, so this is additive rather than a swap.
    expect(action.query).toBe("deepseek responses");
  });

  test("an empty-query search still carries a queries array (#930)", () => {
    const json = buildResponseJSON([
      { type: "web_search_call_begin", id: "ws_931" },
      { type: "web_search_call_end", id: "ws_931", queries: [] },
      { type: "done" },
    ], "routed/model");

    const action = (json.output as Record<string, unknown>[])[0].action as Record<string, unknown>;
    expect(action.queries).toEqual([""]);
    expect(action.query).toBe("");
  });

  test("streaming: web_search_call_end sources attach as url_citation annotations on the next message", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "web_search_call_begin", id: "ws_4" },
      { type: "web_search_call_end", id: "ws_4", queries: ["node lts"], sources: [{ url: "https://nodejs.org", title: "Node.js" }] },
      { type: "text_delta", text: "Node 24 LTS" },
      { type: "done" },
    ]), "routed/model"));
    const done = frames.find(f => f.event === "response.output_item.done"
      && (f.data.item as Record<string, unknown>)?.type === "message");
    const searchDone = frames.find(f => f.event === "response.output_item.done"
      && (f.data.item as Record<string, unknown>)?.type === "web_search_call");
    expect((searchDone!.data.item as Record<string, unknown>).sources).toEqual([
      { url: "https://nodejs.org", title: "Node.js" },
    ]);
    const item = done!.data.item as Record<string, unknown>;
    const part = (item.content as Record<string, unknown>[])[0];
    expect(part.annotations).toEqual([{
      type: "url_citation", url: "https://nodejs.org", title: "Node.js", start_index: 0, end_index: 0,
    }]);
  });

  test("non-streaming: web_search_call_end sources attach as url_citation annotations", () => {
    const json = buildResponseJSON([
      { type: "web_search_call_begin", id: "ws_5" },
      { type: "web_search_call_end", id: "ws_5", queries: ["node lts"], sources: [{ url: "https://nodejs.org", title: "Node.js" }] },
      { type: "text_delta", text: "Node 24 LTS" },
      { type: "done" },
    ], "routed/model");
    const output = json.output as Record<string, unknown>[];
    expect(output.find(item => item.type === "web_search_call")?.sources).toEqual([
      { url: "https://nodejs.org", title: "Node.js" },
    ]);
    const message = output.find(item => item.type === "message") as Record<string, unknown>;
    const part = (message.content as Record<string, unknown>[])[0];
    expect(part.annotations).toEqual([{
      type: "url_citation", url: "https://nodejs.org", title: "Node.js", start_index: 0, end_index: 0,
    }]);
  });

  test("unsafe and oversized search sources are absent from cells and annotations", async () => {
    const sources = [
      { url: "javascript:alert(1)", title: "unsafe" },
      { url: "https://user:pass@credential.test/private" },
      { url: "https://control.test/path\u0000" },
      { url: "https://safe.test/docs", title: "Safe docs" },
      { url: "https://title.test", title: "bad\u0001title" },
      { url: "https://safe.test/docs", title: "duplicate" },
      ...Array.from({ length: 25 }, (_, index) => ({ url: `https://safe.test/${index}` })),
    ];
    const events: AdapterEvent[] = [
      { type: "web_search_call_begin", id: "ws_safe" },
      { type: "web_search_call_end", id: "ws_safe", queries: ["docs"], sources },
      { type: "text_delta", text: "answer" },
      { type: "done" },
    ];

    const frames = await collectSse(bridgeToResponsesSSE(replay(events), "routed/model"));
    const streamingCell = frames.find(f => f.event === "response.output_item.done"
      && (f.data.item as Record<string, unknown>)?.type === "web_search_call")!.data.item as Record<string, unknown>;
    const streamingSources = streamingCell.sources as Record<string, unknown>[];
    expect(streamingSources).toHaveLength(20);
    expect(streamingSources.slice(0, 2)).toEqual([
      { url: "https://safe.test/docs", title: "Safe docs" },
      { url: "https://title.test" },
    ]);
    expect(streamingSources.some(source => String(source.url).includes("credential"))).toBe(false);

    const streamingMessage = frames.find(f => f.event === "response.output_item.done"
      && (f.data.item as Record<string, unknown>)?.type === "message")!.data.item as Record<string, unknown>;
    const streamingAnnotations = (streamingMessage.content as Record<string, unknown>[])[0].annotations as Record<string, unknown>[];
    expect(streamingAnnotations.map(({ url, title }) => ({ url, ...(title ? { title } : {}) })))
      .toEqual(streamingSources);

    const json = buildResponseJSON(events, "routed/model");
    const output = json.output as Record<string, unknown>[];
    const batchCell = output.find(item => item.type === "web_search_call")!;
    expect(batchCell.sources).toEqual(streamingSources);
    const batchMessage = output.find(item => item.type === "message")!;
    const batchAnnotations = (batchMessage.content as Record<string, unknown>[])[0].annotations as Record<string, unknown>[];
    expect(batchAnnotations).toEqual(streamingAnnotations);
  });

  test("non-streaming citation transfer releases its temporary source ownership", () => {
    const events: AdapterEvent[] = [
      { type: "web_search_call_begin", id: "ws_budget" },
      { type: "web_search_call_end", id: "ws_budget", queries: ["docs"], sources: [
        { url: "https://safe.test/docs", title: "Safe docs" },
      ] },
      { type: "text_delta", text: "answer" },
      { type: "done" },
    ];
    const budget = createTranslatorBudget();
    try {
      retainTranslatedEventBatch(events, budget);
      const json = buildResponseJSON(events, "routed/model", { translatorBudget: budget });
      const output = json.output as Record<string, unknown>[];
      const outputBytes = output.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
      expect(budget.snapshot().currentBytes).toBe(outputBytes);
    } finally {
      budget.dispose();
    }
  });

  test("streaming source-only completion releases unconsumed citation ownership", async () => {
    const events: AdapterEvent[] = [
      { type: "web_search_call_begin", id: "ws_source_only" },
      { type: "web_search_call_end", id: "ws_source_only", queries: ["docs"], sources: [
        { url: "https://safe.test/docs", title: "Safe docs" },
      ] },
      { type: "done" },
    ];
    const budget = createTranslatorBudget();
    try {
      const frames = await collectSse(bridgeToResponsesSSE(
        replay(events),
        "routed/model",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { translatorBudget: budget },
      ));
      const terminal = frames.find(frame => frame.event === "response.completed")!;
      const output = (terminal.data.response as Record<string, unknown>).output as Record<string, unknown>[];
      expect(output.map(item => item.type)).toEqual(["web_search_call"]);
      expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(JSON.stringify(output[0])));
    } finally {
      budget.dispose();
    }
  });
});

describe("Responses bridge stopReason threading (issue #246)", () => {
  test("done with stopReason max_tokens emits response.incomplete", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "partial" },
      { type: "done", stopReason: "max_tokens" },
    ]), "routed/model"));
    const terminal = frames.find(f => f.event === "response.incomplete");
    expect(terminal).toBeDefined();
    const response = terminal!.data.response as Record<string, unknown>;
    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details).toEqual({ reason: "max_output_tokens" });
    // Must NOT also emit response.completed
    expect(frames.find(f => f.event === "response.completed")).toBeUndefined();
  });

  test("done with stopReason content_filter emits response.incomplete", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "partial" },
      { type: "done", stopReason: "content_filter" },
    ]), "routed/model"));
    const terminal = frames.find(f => f.event === "response.incomplete");
    expect(terminal).toBeDefined();
    const response = terminal!.data.response as Record<string, unknown>;
    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details).toEqual({ reason: "content_filter" });
    expect(frames.find(f => f.event === "response.completed")).toBeUndefined();
  });

  test("done without stopReason emits response.completed as before", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "hello" },
      { type: "done" },
    ]), "routed/model"));
    expect(frames.find(f => f.event === "response.completed")).toBeDefined();
    expect(frames.find(f => f.event === "response.incomplete")).toBeUndefined();
  });

  test("done with stopReason end_turn emits response.completed", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "done" },
      { type: "done", stopReason: "end_turn" },
    ]), "routed/model"));
    expect(frames.find(f => f.event === "response.completed")).toBeDefined();
    expect(frames.find(f => f.event === "response.incomplete")).toBeUndefined();
  });

  test("batch buildResponseJSON with stopReason max_tokens returns incomplete status", () => {
    const json = buildResponseJSON([
      { type: "text_delta", text: "partial" },
      { type: "done", stopReason: "max_tokens" },
    ], "routed/model");
    expect(json.status).toBe("incomplete");
    expect(json.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  test("batch buildResponseJSON with stopReason content_filter returns incomplete status", () => {
    const json = buildResponseJSON([
      { type: "text_delta", text: "partial" },
      { type: "done", stopReason: "content_filter" },
    ], "routed/model", { compaction: true });
    expect(json.status).toBe("incomplete");
    expect(json.incomplete_details).toEqual({ reason: "content_filter" });
    // Truncated turns must not install a compaction replacement (#422).
    expect((json.output as Record<string, unknown>[]).some(item => item.type === "compaction")).toBe(false);
  });

  test("batch buildResponseJSON without stopReason returns completed status", () => {
    const json = buildResponseJSON([
      { type: "text_delta", text: "hello" },
      { type: "done" },
    ], "routed/model");
    expect(json.status).toBe("completed");
    expect(json.incomplete_details).toBeUndefined();
  });
});

describe("buildResponseJSON default budget safety net", () => {
  test("omitting the translator budget is bounded, never unbounded", () => {
    // A single tool call with arguments above the 2 MiB default per-call cap
    // must overflow even with NO budget option passed (previously unbounded).
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_huge", name: "f" },
      { type: "tool_call_delta", arguments: "x".repeat(3 * 1024 * 1024) },
      { type: "tool_call_end", id: "call_huge" },
      { type: "done" },
    ];
    expect(() => buildResponseJSON(events, "mock/test-model")).toThrow(/translation_buffer_limit|buffer exceeded/);
  });
});

describe("bridgeToResponsesSSE owned default budget lifecycle", () => {
  test("terminal completion disposes the owned default budget", async () => {
    const before = translatorLiveBudgetCountForTests();
    const stream = bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "hi" },
      { type: "done" },
    ]), "mock/test-model");
    await new Response(stream).text();
    expect(translatorLiveBudgetCountForTests()).toBe(before);
  });

  test("client cancel disposes the owned default budget", async () => {
    const before = translatorLiveBudgetCountForTests();
    const stream = bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "hi" },
      { type: "done" },
    ]), "mock/test-model");
    await stream.cancel(new Error("client gone"));
    expect(translatorLiveBudgetCountForTests()).toBe(before);
  });

  test("cancel during a pending upstream next never charges the disposed budget", async () => {
    resetTranslatorAggregateForTests();
    let release: ((event: AdapterEvent) => void) | null = null;
    async function* gated(): AsyncGenerator<AdapterEvent> {
      yield { type: "text_delta", text: "first" };
      yield await new Promise<AdapterEvent>((resolve) => { release = resolve; });
      yield { type: "done" };
    }
    const stream = bridgeToResponsesSSE(gated(), "mock/test-model");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    // Drain frames until the first text arrives; the next read leaves step()
    // parked inside `await it.next()`.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stream closed before the first text frame");
      if (decoder.decode(value).includes("first")) break;
    }
    const pending = reader.read();
    // Prove the second upstream next() has STARTED before cancelling — otherwise
    // the cancel happens before the race exists and the regression is vacuous.
    for (let attempt = 0; attempt < 200 && !release; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(release).not.toBeNull();
    await reader.cancel(new Error("client gone"));
    release?.({ type: "text_delta", text: "late event after cancel" });
    await pending;
    reader.releaseLock();
    expect(translatorLiveBudgetCountForTests()).toBe(0);
    expect(translatorAggregateCurrentBytesForTests()).toBe(0);
  });

  test("an abandoned stream's owned budget is disposed by the watchdog", async () => {
    resetTranslatorAggregateForTests();
    setOwnedBudgetAbandonedMsForTests(10);
    try {
      const before = translatorLiveBudgetCountForTests();
      bridgeToResponsesSSE(replay([{ type: "text_delta", text: "never read" }]), "mock/test-model");
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(translatorLiveBudgetCountForTests()).toBe(before);
    } finally {
      setOwnedBudgetAbandonedMsForTests(null);
    }
  });
});
