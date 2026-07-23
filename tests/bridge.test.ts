import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
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

  test("streaming raw reasoning emits reasoning_text deltas and final raw content", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "raw detail" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, reasoningOutputTokens: 2 } },
    ]), "routed/model"));

    const delta = frames.find(f => f.event === "response.reasoning_text.delta")?.data;
    expect(delta).toMatchObject({ content_index: 0, delta: "raw detail" });

    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output[0]).toMatchObject({
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: "raw detail" }],
    });
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
      content: [{ type: "reasoning_text", text: "raw json" }],
    });
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

  test("heartbeat events reset the stall watchdog and emit no protocol frame", async () => {
    // Regression for the Cursor parallel-tool-call stall: while the upstream silently assembles tool
    // calls, the adapter emits `heartbeat` events. They must keep the stall watchdog alive (no
    // upstream_stall_timeout) without producing any Responses protocol event of their own.
    async function* heartbeatsThenDone(): AsyncGenerator<AdapterEvent> {
      // More heartbeats than maxStallTicks would allow if they did NOT reset the counter.
      for (let i = 0; i < 6; i++) {
        yield { type: "heartbeat" };
        await new Promise(r => setTimeout(r, 12));
      }
      yield { type: "text_delta", text: "ok" };
      yield { type: "done" };
    }
    // heartbeatMs=10ms, stallTimeoutSec=0.03s -> maxStallTicks=3. 6 spaced heartbeats only survive
    // if each one resets stallTicks.
    const frames = await collectSse(bridgeToResponsesSSE(
      heartbeatsThenDone(), "model", undefined, undefined, undefined, undefined, 10, { stallTimeoutSec: 0.03 },
    ));
    expect(frames.some(f => (f.data.response as Record<string, unknown> | undefined)?.incomplete_details)).toBe(false);
    expect(frames.some(f => f.event === "response.completed")).toBe(true);
    // No protocol frame is produced by a heartbeat itself (only created/text/completed appear).
    expect(frames.some(f => f.event === "response.heartbeat" && f.data.type === "heartbeat" && Object.keys(f.data).length > 2)).toBe(false);
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
    expect(doneItem.action).toEqual({ type: "search", query: "current docs" });

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

  test("a batched (plural) search emits action.search.queries without a singular query", () => {
    const json = buildResponseJSON([
      { type: "web_search_call_begin", id: "ws_3" },
      { type: "web_search_call_end", id: "ws_3", queries: ["rust async", "tokio runtime"] },
      { type: "text_delta", text: "answer" },
      { type: "done" },
    ], "routed/model");

    const output = json.output as Record<string, unknown>[];
    const action = (output[0] as Record<string, unknown>).action as Record<string, unknown>;
    // Native renders "<first> ..." only when `query` is absent and queries.len() > 1.
    expect(action).toEqual({ type: "search", queries: ["rust async", "tokio runtime"] });
    expect(action.query).toBeUndefined();
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
    const message = output.find(item => item.type === "message") as Record<string, unknown>;
    const part = (message.content as Record<string, unknown>[])[0];
    expect(part.annotations).toEqual([{
      type: "url_citation", url: "https://nodejs.org", title: "Node.js", start_index: 0, end_index: 0,
    }]);
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

  test("batch buildResponseJSON without stopReason returns completed status", () => {
    const json = buildResponseJSON([
      { type: "text_delta", text: "hello" },
      { type: "done" },
    ], "routed/model");
    expect(json.status).toBe("completed");
    expect(json.incomplete_details).toBeUndefined();
  });
});
