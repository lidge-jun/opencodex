import { describe, expect, test } from "bun:test";
import {
  anthropicErrorBody,
  anthropicErrorType,
  anthropicUsage,
  collectAnthropicMessage,
  responsesJsonToAnthropicMessage,
  responsesSseToAnthropicSse,
} from "../src/claude/outbound";

function sse(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // Split into odd chunks so frame-boundary buffering is exercised.
      for (let i = 0; i < text.length; i += 7) controller.enqueue(encoder.encode(text.slice(i, i + 7)));
      controller.close();
    },
  });
}

async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<{ name: string; data: Record<string, any> }[]> {
  const text = await new Response(stream).text();
  const events: { name: string; data: Record<string, any> }[] = [];
  for (const frame of text.split("\n\n")) {
    if (!frame.trim()) continue;
    let name = "";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    events.push({ name, data: JSON.parse(data) });
  }
  return events;
}

describe("claude outbound SSE", () => {
  test("text + thinking + tool call + completed w/ usage -> exact Anthropic sequence", async () => {
    const upstream = [
      sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
      sse("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 0, delta: "hmm" }),
      sse("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
      sse("response.output_item.added", { output_index: 1, item: { type: "message", id: "msg_1" } }),
      sse("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: "Hello " }),
      sse("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: "world" }),
      sse("response.output_item.done", { output_index: 1, item: { type: "message", id: "msg_1" } }),
      sse("response.output_item.added", { output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "toolu_9", name: "Read", arguments: "", status: "in_progress" } }),
      sse("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 2, delta: "{\"file_path\":" }),
      sse("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 2, delta: "\"/x\"}" }),
      sse("response.output_item.done", { output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "toolu_9", name: "Read" } }),
      sse("response.heartbeat", {}),
      sse("response.completed", { response: { status: "completed", usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 5 } } } }),
    ].join("");

    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "claude-ocx-test"));
    const names = events.map(e => e.name);
    expect(names).toEqual([
      "message_start", "ping",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", // thinking (+signature)
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", // text
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", // tool_use
      "ping",
      "message_delta", "message_stop",
    ]);

    const start = events[0].data;
    expect(start.type).toBe("message_start");
    expect(start.message).toMatchObject({ type: "message", role: "assistant", content: [], model: "claude-ocx-test", stop_reason: null });

    // thinking block: index 0, thinking_delta then synthetic signature_delta before stop
    expect(events[2].data.content_block).toEqual({ type: "thinking", thinking: "", signature: "" });
    expect(events[3].data.delta).toEqual({ type: "thinking_delta", thinking: "hmm" });
    expect(events[4].data.delta.type).toBe("signature_delta");
    expect(events[4].data.delta.signature.length).toBeGreaterThan(0);
    expect(events[5].data).toEqual({ type: "content_block_stop", index: 0 });

    // text block: index 1
    expect(events[6].data.content_block).toEqual({ type: "text", text: "" });
    expect(events[7].data.delta).toEqual({ type: "text_delta", text: "Hello " });

    // tool_use block: index 2, id = call_id
    expect(events[10].data.content_block).toMatchObject({ type: "tool_use", id: "toolu_9", name: "Read", input: {} });
    expect(events[11].data.delta).toEqual({ type: "input_json_delta", partial_json: "{\"file_path\":" });

    // message_delta: tool_use stop reason + mapped usage (input minus cache read+write)
    const md = events[names.indexOf("message_delta")].data;
    expect(md.delta).toEqual({ stop_reason: "tool_use", stop_sequence: null });
    expect(md.usage).toEqual({ input_tokens: 15, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 });

    // monotonic block indexes
    const startIndexes = events.filter(e => e.name === "content_block_start").map(e => e.data.index);
    expect(startIndexes).toEqual([0, 1, 2]);
  });

  test("failed -> error event with taxonomy type", async () => {
    const upstream = [
      sse("response.created", { response: {} }),
      sse("response.output_text.delta", { delta: "par" }),
      sse("response.failed", { response: { status: "failed", error: { status: 429, message: "rate limited" } } }),
    ].join("");
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    const names = events.map(e => e.name);
    // open text block is closed before the error event
    expect(names).toEqual(["message_start", "ping", "content_block_start", "content_block_delta", "content_block_stop", "error"]);
    expect(events.at(-1)!.data).toEqual({ type: "error", error: { type: "rate_limit_error", message: "rate limited" } });
  });

  test("incomplete(max_output_tokens) -> max_tokens; EOF w/o terminal fails closed", async () => {
    const incomplete = [
      sse("response.created", { response: {} }),
      sse("response.output_text.delta", { delta: "x" }),
      sse("response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 6 } } }),
    ].join("");
    const e1 = await collectEvents(responsesSseToAnthropicSse(streamFrom(incomplete), "m"));
    const md1 = e1.find(e => e.name === "message_delta")!.data;
    expect(md1.delta.stop_reason).toBe("max_tokens");
    expect(e1.at(-1)!.name).toBe("message_stop");

    // Truncation must surface as a retryable Anthropic error event, not a polite
    // end_turn close (devlog 100: silent-truncation gateway failure pattern).
    const eof = sse("response.created", { response: {} }) + sse("response.output_text.delta", { delta: "y" });
    const e2 = await collectEvents(responsesSseToAnthropicSse(streamFrom(eof), "m"));
    expect(e2.map(e => e.name)).toEqual(["message_start", "ping", "content_block_start", "content_block_delta", "content_block_stop", "error"]);
    // Truncation is upstream-derived transient (502) -> overloaded_error so Claude Code retries
    // (devlog/_plan/260716_claudecode_hardening/020).
    expect(e2.at(-1)!.data).toMatchObject({ type: "error", error: { type: "overloaded_error" } });
  });

  test("failed with transient upstream status 502 -> overloaded_error", async () => {
    const upstream = [
      sse("response.created", { response: {} }),
      sse("response.failed", { response: { status: "failed", error: { status: 502, message: "bad gateway" } } }),
    ].join("");
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    expect(events.at(-1)!.data).toEqual({ type: "error", error: { type: "overloaded_error", message: "bad gateway" } });
  });

  test("failed with NO status (relaySseWithFailedTail synthetic tail) -> default 500 -> overloaded_error", async () => {
    const upstream = [
      sse("response.created", { response: {} }),
      sse("response.failed", { response: { status: "failed", error: { type: "upstream_reset", code: "upstream_reset", message: "Upstream stream terminated unexpectedly" } } }),
    ].join("");
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    expect(events.at(-1)!.data).toEqual({
      type: "error",
      error: { type: "overloaded_error", message: "Upstream stream terminated unexpectedly" },
    });
  });

  test("internal reader exception stays api_error (not promoted to overloaded)", async () => {
    const boom = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse("response.created", { response: {} })));
      },
      pull() {
        throw new Error("proxy-internal read failure");
      },
    });
    const events = await collectEvents(responsesSseToAnthropicSse(boom, "m"));
    expect(events.at(-1)!.data).toMatchObject({ type: "error", error: { type: "api_error", message: "proxy-internal read failure" } });
  });

  test("incomplete(content_filter) -> refusal stop_reason", async () => {
    const upstream = [
      sse("response.created", { response: {} }),
      sse("response.output_text.delta", { delta: "I can" }),
      sse("response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "content_filter" }, usage: { input_tokens: 5, output_tokens: 2 } } }),
    ].join("");
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    expect(events.find(e => e.name === "message_delta")!.data.delta.stop_reason).toBe("refusal");
    expect(events.at(-1)!.name).toBe("message_stop");
  });

  test("idle keepalive pings flow during upstream silence", async () => {
    // Upstream: created frame, 90ms of silence, then a clean completion.
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(sse("response.created", { response: {} })));
        await new Promise(r => setTimeout(r, 90));
        controller.enqueue(encoder.encode(sse("response.completed", { response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })));
        controller.close();
      },
    });
    const events = await collectEvents(responsesSseToAnthropicSse(upstream, "m", { pingIntervalMs: 25 }));
    const pings = events.filter(e => e.name === "ping").length;
    expect(pings).toBeGreaterThanOrEqual(3); // startup ping + >=2 idle pings
    expect(events.at(-1)!.name).toBe("message_stop");
  });

  test("no-output completed still emits a valid empty message", async () => {
    const upstream = sse("response.created", { response: {} }) + sse("response.completed", { response: { status: "completed" } });
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    expect(events.map(e => e.name)).toEqual(["message_start", "ping", "message_delta", "message_stop"]);
    expect(events[2].data.delta.stop_reason).toBe("end_turn");
  });
});

describe("claude outbound non-stream + helpers", () => {
  test("responses JSON -> anthropic message", () => {
    const msg = responsesJsonToAnthropicMessage({
      status: "completed",
      output: [
        { type: "reasoning", id: "rs", summary: [{ type: "summary_text", text: "think" }] },
        { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
        { type: "function_call", id: "f", call_id: "toolu_1", name: "Read", arguments: "{\"a\":1}" },
      ],
      usage: { input_tokens: 10, output_tokens: 4 },
    }, "claude-ocx-x") as any;
    expect(msg.type).toBe("message");
    expect(msg.model).toBe("claude-ocx-x");
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content[0]).toMatchObject({ type: "thinking", thinking: "think" });
    expect(msg.content[1]).toEqual({ type: "text", text: "hi" });
    expect(msg.content[2]).toEqual({ type: "tool_use", id: "toolu_1", name: "Read", input: { a: 1 } });
    expect(msg.usage).toEqual({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });

  test("error taxonomy table", () => {
    expect(anthropicErrorType(400)).toBe("invalid_request_error");
    expect(anthropicErrorType(401)).toBe("authentication_error");
    expect(anthropicErrorType(402)).toBe("billing_error");
    expect(anthropicErrorType(403)).toBe("permission_error");
    expect(anthropicErrorType(404)).toBe("not_found_error");
    expect(anthropicErrorType(409)).toBe("conflict_error");
    expect(anthropicErrorType(413)).toBe("request_too_large");
    expect(anthropicErrorType(429)).toBe("rate_limit_error");
    expect(anthropicErrorType(504)).toBe("timeout_error");
    expect(anthropicErrorType(500)).toBe("api_error");
    expect(anthropicErrorType(502)).toBe("api_error");
    expect(anthropicErrorType(529)).toBe("overloaded_error");
    expect(anthropicErrorType(418)).toBe("invalid_request_error");
    expect(anthropicErrorBody(429, "slow down")).toEqual({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
  });

  test("usage mapping tolerates missing fields", () => {
    expect(anthropicUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    expect(anthropicUsage({ input_tokens: 7, output_tokens: 2 })).toEqual({ input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });
});

describe("claude outbound web_search translation", () => {
  const wsItem = (over: Record<string, unknown> = {}) => ({
    type: "web_search_call", id: "ws_1", status: "completed",
    action: { type: "search", query: "latest bun release" },
    sources: [
      { url: "https://bun.sh/blog", title: "Bun Blog" },
      { url: "https://github.com/oven-sh/bun/releases" },
    ],
    ...over,
  });

  test("T1 single search -> server_tool_use + web_search_tool_result pair with usage count", async () => {
    const upstream = [
      sse("response.created", { response: { id: "r", status: "in_progress" } }),
      sse("response.output_item.added", { output_index: 0, item: { type: "web_search_call", id: "ws_1", status: "in_progress" } }),
      sse("response.output_item.done", { output_index: 0, item: wsItem() }),
      sse("response.output_item.added", { output_index: 1, item: { type: "message", id: "m1" } }),
      sse("response.output_text.delta", { item_id: "m1", output_index: 1, content_index: 0, delta: "answer" }),
      sse("response.output_item.done", { output_index: 1, item: { type: "message", id: "m1" } }),
      sse("response.completed", { response: { status: "completed", usage: { input_tokens: 9, output_tokens: 3 } } }),
    ].join("");
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    expect(events.map(e => e.name)).toEqual([
      "message_start", "ping",
      "content_block_start", "content_block_delta", "content_block_stop", // server_tool_use
      "content_block_start", "content_block_stop", // web_search_tool_result
      "content_block_start", "content_block_delta", "content_block_stop", // text
      "message_delta", "message_stop",
    ]);
    // server_tool_use start has no inline input; query arrives via input_json_delta.
    expect(events[2].data.content_block).toEqual({ type: "server_tool_use", id: "ws_1", name: "web_search" });
    expect(events[3].data.delta).toEqual({ type: "input_json_delta", partial_json: JSON.stringify({ query: "latest bun release" }) });
    const result = events[5].data.content_block;
    expect(result.type).toBe("web_search_tool_result");
    expect(result.tool_use_id).toBe("ws_1");
    expect(result.content).toEqual([
      { type: "web_search_result", title: "Bun Blog", url: "https://bun.sh/blog" },
      { type: "web_search_result", title: "", url: "https://github.com/oven-sh/bun/releases" },
    ]);
    const usage = events[10].data.usage;
    expect(usage.server_tool_use).toEqual({ web_search_requests: 1 });
    // stop_reason stays end_turn: server_tool_use is not a client tool call.
    expect(events[10].data.delta.stop_reason).toBe("end_turn");
  });

  test("T2 multi-search -> two pairs, usage 2, monotonic indexes", async () => {
    const upstream = [
      sse("response.created", { response: {} }),
      sse("response.output_item.done", { output_index: 0, item: wsItem() }),
      sse("response.output_item.done", { output_index: 1, item: wsItem({ id: "ws_2", action: { type: "search", queries: ["a", "b"] }, sources: [] }) }),
      sse("response.completed", { response: { status: "completed", usage: {} } }),
    ].join("");
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    const starts = events.filter(e => e.name === "content_block_start");
    expect(starts.map(e => e.data.content_block.type)).toEqual([
      "server_tool_use", "web_search_tool_result", "server_tool_use", "web_search_tool_result",
    ]);
    const indexes = starts.map(e => e.data.index);
    expect(indexes).toEqual([0, 1, 2, 3]);
    // Batched queries keep the plural form in input.
    const secondDelta = events.filter(e => e.name === "content_block_delta")[1];
    expect(secondDelta.data.delta.partial_json).toBe(JSON.stringify({ queries: ["a", "b"] }));
    const msgDelta = events.find(e => e.name === "message_delta")!;
    expect(msgDelta.data.usage.server_tool_use).toEqual({ web_search_requests: 2 });
  });

  test("T3 failed search -> error-shaped content, NOT counted in usage", async () => {
    const upstream = [
      sse("response.created", { response: {} }),
      sse("response.output_item.done", { output_index: 0, item: wsItem({ status: "failed", sources: undefined }) }),
      sse("response.completed", { response: { status: "completed", usage: {} } }),
    ].join("");
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    const result = events.filter(e => e.name === "content_block_start")[1].data.content_block;
    expect(result.content).toEqual({ type: "web_search_tool_result_error", error_code: "unavailable" });
    const msgDelta = events.find(e => e.name === "message_delta")!;
    expect(msgDelta.data.usage.server_tool_use).toBeUndefined();
  });

  test("T4 no sources -> empty hits array still emits the pair (search count registers)", async () => {
    const upstream = [
      sse("response.created", { response: {} }),
      sse("response.output_item.done", { output_index: 0, item: wsItem({ sources: undefined }) }),
      sse("response.completed", { response: { status: "completed", usage: {} } }),
    ].join("");
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    const result = events.filter(e => e.name === "content_block_start")[1].data.content_block;
    expect(result.content).toEqual([]);
    expect(events.find(e => e.name === "message_delta")!.data.usage.server_tool_use).toEqual({ web_search_requests: 1 });
  });

  test("T5 JSON path: pair emitted, stop_reason preserved, failed not counted", () => {
    const msg = responsesJsonToAnthropicMessage({
      status: "completed",
      output: [
        wsItem(),
        wsItem({ id: "ws_9", status: "failed" }),
        { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      ],
      usage: { input_tokens: 5, output_tokens: 1 },
    }, "claude-ocx-x") as Record<string, any>;
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.content[0]).toEqual({ type: "server_tool_use", id: "ws_1", name: "web_search", input: { query: "latest bun release" } });
    expect(msg.content[1]).toMatchObject({ type: "web_search_tool_result", tool_use_id: "ws_1" });
    expect(msg.content[1].content).toHaveLength(2);
    expect(msg.content.map((c: Record<string, unknown>) => c.type)).toEqual([
      "server_tool_use", "web_search_tool_result", "server_tool_use", "web_search_tool_result", "text",
    ]);
    expect(msg.content[3]).toMatchObject({ type: "web_search_tool_result", tool_use_id: "ws_9" });
    expect(msg.content[3].content).toEqual({ type: "web_search_tool_result_error", error_code: "unavailable" });
    expect(msg.usage.server_tool_use).toEqual({ web_search_requests: 1 });
  });

  test("T6 regression: turn without web_search emits no server_tool_use and no usage field", async () => {
    const upstream = [
      sse("response.created", { response: {} }),
      sse("response.output_item.added", { output_index: 0, item: { type: "message", id: "m1" } }),
      sse("response.output_text.delta", { item_id: "m1", output_index: 0, content_index: 0, delta: "plain" }),
      sse("response.completed", { response: { status: "completed", usage: { input_tokens: 2, output_tokens: 1 } } }),
    ].join("");
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    expect(events.some(e => e.name === "content_block_start" && e.data.content_block.type === "server_tool_use")).toBe(false);
    expect(events.find(e => e.name === "message_delta")!.data.usage.server_tool_use).toBeUndefined();
  });

  test("T7 collect path: server_tool_use input survives aggregation, usage passthrough", async () => {
    const upstream = [
      sse("response.created", { response: {} }),
      sse("response.output_item.done", { output_index: 0, item: wsItem() }),
      sse("response.output_text.delta", { item_id: "m1", output_index: 1, content_index: 0, delta: "hi" }),
      sse("response.completed", { response: { status: "completed", usage: { input_tokens: 4, output_tokens: 2 } } }),
    ].join("");
    const anthropicSse = responsesSseToAnthropicSse(streamFrom(upstream), "m");
    const msg = await collectAnthropicMessage(anthropicSse, "m") as Record<string, any>;
    expect(msg.content.map((c: Record<string, unknown>) => c.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"]);
    expect(msg.content[0].input).toEqual({ query: "latest bun release" });
    expect(msg.content[1].tool_use_id).toBe("ws_1");
    expect(msg.usage.server_tool_use).toEqual({ web_search_requests: 1 });
  });
});
