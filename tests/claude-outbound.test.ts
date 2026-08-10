import { describe, expect, test } from "bun:test";
import {
  anthropicErrorBody,
  anthropicErrorType,
  anthropicUsage,
  collectAnthropicMessage as collectAnthropicMessageProduction,
  responsesJsonToAnthropicMessage,
  responsesSseToAnthropicSse as responsesSseToAnthropicSseProduction,
  sanitizeWebSearchInput,
} from "../src/claude/outbound";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import {
  TRANSLATOR_MAX_CALL_ARGUMENT_BYTES,
  type TranslatorBudget,
} from "../src/lib/translator-budget";

const streamBudgets = new WeakMap<ReadableStream<Uint8Array>, TranslatorBudget>();

function responsesSseToAnthropicSse(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  opts: { pingIntervalMs?: number; translatorBudget?: TranslatorBudget } = {},
): ReadableStream<Uint8Array> {
  const translatorBudget = opts.translatorBudget ?? createTestTranslatorBudget();
  const stream = responsesSseToAnthropicSseProduction(upstream, model, {
    ...opts,
    translatorBudget,
  });
  streamBudgets.set(stream, translatorBudget);
  return stream;
}

function collectAnthropicMessage(
  stream: ReadableStream<Uint8Array>,
  model: string,
  translatorBudget = streamBudgets.get(stream) ?? createTestTranslatorBudget(),
) {
  return collectAnthropicMessageProduction(stream, model, translatorBudget);
}

function sse(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function dataOnlySse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Unspaced counterparts of `sse` / `dataOnlySse` — `data:{...}` is as valid as `data: {...}` (#1170). */
function unspacedSse(name: string, data: Record<string, unknown>): string {
  return `event:${name}\ndata:${JSON.stringify(data)}\n\n`;
}

const DONE_SSE = "data: [DONE]\n\n";

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

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
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
  test("translator overflow emits one typed error and cancels the upstream reader", async () => {
    const frame = sse("response.failed", {
      type: "response.failed",
      response: {
        status: "failed",
        error: {
          message: "upstream translation buffer exceeded the safe limit",
          type: "upstream_error",
          code: "translation_buffer_limit",
        },
      },
    });
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
      },
      cancel() {
        cancelled = true;
      },
    });

    const events = await collectEvents(responsesSseToAnthropicSse(upstream, "m"));
    expect(events).toEqual([{
      name: "error",
      data: {
        type: "error",
        error: {
          type: "request_too_large",
          message: "upstream translation buffer exceeded the safe limit",
          code: "translation_buffer_limit",
        },
      },
    }]);
    expect(cancelled).toBe(true);
  });

  test("multiline Responses data assembly is charged as an old/new replacement", async () => {
    const half = 512 * 1024;
    const multiline = `data: {"type":"unknown","payload":"${"x".repeat(half)}\n`
      + `data: ${"y".repeat(half)}"}\n\n`;
    // Source + raw frame peaks below 3.5 MiB; admitting old data + fragment + replacement does not.
    const budget = createTestTranslatorBudget({ maxTurnBytes: Math.floor(3.5 * 1024 * 1024) });
    const events = await collectEvents(responsesSseToAnthropicSse(
      streamFromChunks([multiline]),
      "m",
      { translatorBudget: budget },
    ));

    expect(events).toEqual([{
      name: "error",
      data: {
        type: "error",
        error: {
          type: "request_too_large",
          message: "upstream translation buffer exceeded the safe limit",
          code: "translation_buffer_limit",
        },
      },
    }]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("#1170: the budgeted raw-frame parser accepts unspaced event/data fields and still balances the budget", async () => {
    // This drives the offset-based parser inside responsesSseToAnthropicSse, which reserves and
    // releases translator budget by offset rather than by slicing each line. A spaced-only prefix
    // check dropped every frame here, producing an empty translation.
    const frames = [
      { name: "response.created", data: { response: { id: "resp_1" } } },
      { name: "response.output_item.added", data: { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant" } } },
      { name: "response.content_part.added", data: { item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text" } } },
      { name: "response.output_text.delta", data: { item_id: "msg_1", output_index: 0, content_index: 0, delta: "unspaced" } },
      { name: "response.output_item.done", data: { output_index: 0, item: { type: "message", id: "msg_1" } } },
      { name: "response.completed", data: { response: { status: "completed", usage: { input_tokens: 5, output_tokens: 2 } } } },
    ];

    const spacedBudget = createTestTranslatorBudget();
    const spaced = await collectEvents(responsesSseToAnthropicSse(
      streamFrom(frames.map(f => sse(f.name, f.data)).join("")),
      "claude-ocx-test",
      { translatorBudget: spacedBudget },
    ));

    const unspacedBudget = createTestTranslatorBudget();
    const unspaced = await collectEvents(responsesSseToAnthropicSse(
      streamFrom(frames.map(f => unspacedSse(f.name, f.data)).join("")),
      "claude-ocx-test",
      { translatorBudget: unspacedBudget },
    ));

    const textOf = (events: { name: string; data: Record<string, any> }[]) => events
      .filter(e => e.name === "content_block_delta")
      .map(e => e.data?.delta?.text ?? "")
      .join("");

    expect(textOf(spaced)).toBe("unspaced");
    expect(unspaced.map(e => e.name)).toEqual(spaced.map(e => e.name));
    expect(textOf(unspaced)).toBe(textOf(spaced));
    // The offset arithmetic must not change accounting: the unspaced path retains exactly what
    // the spaced path retains. (Both leave a small non-zero residue at stream end; that is
    // pre-existing behavior of this translator, not something this fix introduces — asserting
    // equality is the contract that matters here.)
    expect(unspacedBudget.snapshot().currentBytes).toBe(spacedBudget.snapshot().currentBytes);
  });

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

  test("multi-part reasoning summaries keep the JSON path's part separator", async () => {
    const upstream = [
      sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
      sse("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
      sse("response.reasoning_summary_part.added", { item_id: "rs_1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 0, delta: "**A**\n\nOne." }),
      sse("response.reasoning_summary_part.added", { item_id: "rs_1", output_index: 0, summary_index: 1, part: { type: "summary_text", text: "" } }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 1, delta: "**B**\n\nTwo." }),
      sse("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
      sse("response.output_item.added", { output_index: 1, item: { type: "reasoning", id: "rs_2" } }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs_2", output_index: 1, summary_index: 0, delta: "Three." }),
      sse("response.completed", { response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } }),
    ].join("");
    const msg = await collectAnthropicMessage(responsesSseToAnthropicSse(streamFrom(upstream), "m"), "m") as Record<string, any>;
    // Parts within an item are separated; a new reasoning item opens its own block.
    const thinkingBlocks = msg.content.filter((b: Record<string, unknown>) => b.type === "thinking");
    expect(thinkingBlocks.map((b: Record<string, unknown>) => b.thinking)).toEqual([
      "**A**\n\nOne.\n\n**B**\n\nTwo.",
      "Three.",
    ]);

    // Parity: the non-streaming translator joins the same summary parts identically.
    const json = responsesJsonToAnthropicMessage({
      id: "resp_1",
      status: "completed",
      output: [{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "**A**\n\nOne." }, { type: "summary_text", text: "**B**\n\nTwo." }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }, "m") as Record<string, any>;
    const jsonThinking = json.content.find((b: Record<string, unknown>) => b.type === "thinking");
    expect(jsonThinking.thinking).toBe("**A**\n\nOne.\n\n**B**\n\nTwo.");
  });

  test("same-part deltas and index-free reasoning frames never get a separator", async () => {
    const samePart = [
      sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 0, delta: "Hel" }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 0, delta: "lo" }),
      sse("response.completed", { response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } }),
    ].join("");
    const msg1 = await collectAnthropicMessage(responsesSseToAnthropicSse(streamFrom(samePart), "m"), "m") as Record<string, any>;
    expect(msg1.content.find((b: Record<string, unknown>) => b.type === "thinking").thinking).toBe("Hello");

    const indexFree = [
      sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
      sse("response.reasoning_text.delta", { delta: "A" }),
      sse("response.reasoning_text.delta", { delta: "B" }),
      sse("response.completed", { response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } }),
    ].join("");
    const msg2 = await collectAnthropicMessage(responsesSseToAnthropicSse(streamFrom(indexFree), "m"), "m") as Record<string, any>;
    expect(msg2.content.find((b: Record<string, unknown>) => b.type === "thinking").thinking).toBe("AB");
  });

  test("huge reasoning identities stay bounded without collapsing item or part boundaries", async () => {
    const hugeItemA = "a".repeat(1024 * 1024);
    const hugeItemB = `${"a".repeat(1024 * 1024 - 1)}b`;
    const hugePartA = "p".repeat(1024 * 1024);
    const hugePartB = `${"p".repeat(1024 * 1024 - 1)}q`;
    const upstream = [
      sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
      sse("response.reasoning_summary_text.delta", {
        item_id: hugeItemA, summary_index: hugePartA, delta: "A",
      }),
      sse("response.reasoning_summary_text.delta", {
        item_id: hugeItemA, summary_index: hugePartA, delta: "B",
      }),
      sse("response.reasoning_summary_text.delta", {
        item_id: hugeItemB, summary_index: hugePartA, delta: "C",
      }),
      sse("response.reasoning_summary_text.delta", {
        item_id: hugeItemB, summary_index: hugePartB, delta: "D",
      }),
      sse("response.completed", {
        response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ].join("");

    const msg = await collectAnthropicMessage(
      responsesSseToAnthropicSse(streamFromChunks([upstream]), "m"),
      "m",
    ) as Record<string, any>;
    expect(msg.content.find((b: Record<string, unknown>) => b.type === "thinking").thinking)
      .toBe("AB\n\nC\n\nD");
  });

  test("malformed array reasoning identities retain distinct boundaries", async () => {
    const upstream = [
      sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
      sse("response.reasoning_summary_text.delta", {
        item_id: [1], summary_index: [0], delta: "A",
      }),
      sse("response.reasoning_summary_text.delta", {
        item_id: [2], summary_index: [0], delta: "B",
      }),
      sse("response.completed", {
        response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ].join("");

    const msg = await collectAnthropicMessage(
      responsesSseToAnthropicSse(streamFromChunks([upstream]), "m"),
      "m",
    ) as Record<string, any>;
    expect(msg.content.find((b: Record<string, unknown>) => b.type === "thinking").thinking)
      .toBe("A\n\nB");
  });

  test("data-only Responses frames infer event names from payload types", async () => {
    const upstream = [
      dataOnlySse({ type: "response.created", response: { id: "resp_data_only", status: "in_progress" } }),
      dataOnlySse({ type: "response.output_text.delta", delta: "data-only stream" }),
      dataOnlySse({
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 8, output_tokens: 2 } },
      }),
      DONE_SSE,
    ].join("");

    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    expect(events.map(e => e.name)).toEqual([
      "message_start", "ping",
      "content_block_start", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    expect(events.find(e => e.name === "content_block_delta")!.data.delta).toEqual({
      type: "text_delta",
      text: "data-only stream",
    });
    expect(events.find(e => e.name === "message_delta")!.data).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 8, output_tokens: 2 },
    });
  });

  test("explicit and data-only Responses frames can interleave", async () => {
    const upstream = [
      sse("response.created", { response: { id: "resp_mixed", status: "in_progress" } }),
      dataOnlySse({ type: "response.output_text.delta", delta: "mixed stream" }),
      sse("response.completed", { response: { status: "completed" } }),
      DONE_SSE,
    ].join("");

    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    expect(events.find(e => e.name === "content_block_delta")!.data.delta).toEqual({
      type: "text_delta",
      text: "mixed stream",
    });
    expect(events.at(-1)!.name).toBe("message_stop");
  });

  test("data-only Responses frames survive non-streaming aggregation", async () => {
    const upstream = [
      dataOnlySse({ type: "response.output_text.delta", delta: "data-only message" }),
      dataOnlySse({
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3 } },
      }),
      DONE_SSE,
    ].join("");

    const anthropicSse = responsesSseToAnthropicSse(streamFrom(upstream), "m");
    const message = await collectAnthropicMessage(anthropicSse, "m");
    expect(message).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "data-only message" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    });
  });

  test("explicit event names override payload types and untyped data-only frames stay ignored", async () => {
    const upstream = [
      dataOnlySse({ delta: "must stay ignored" }),
      sse("response.output_text.delta", { type: "response.ignored", delta: "visible" }),
      sse("response.completed", {
        type: "response.output_text.delta",
        delta: "must not override the explicit terminal event",
        response: { status: "completed" },
      }),
    ].join("");

    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    const textDeltas = events
      .filter(e => e.name === "content_block_delta" && e.data.delta?.type === "text_delta")
      .map(e => e.data.delta.text);
    expect(textDeltas).toEqual(["visible"]);
    expect(events.at(-1)!.name).toBe("message_stop");
  });

  test("data-only [DONE] without a Responses terminal frame still fails closed", async () => {
    const upstream = [
      dataOnlySse({ type: "response.output_text.delta", delta: "partial" }),
      DONE_SSE,
    ].join("");

    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    expect(events.some(e => e.name === "message_stop")).toBe(false);
    expect(events.find(e => e.name === "content_block_delta")!.data.delta).toEqual({
      type: "text_delta",
      text: "partial",
    });
    expect(events.at(-1)).toMatchObject({
      name: "error",
      data: {
        type: "error",
        error: {
          type: "overloaded_error",
          message: "upstream stream ended before a terminal frame (truncated response)",
        },
      },
    });
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

  test("retryable or unknown incomplete becomes overloaded_error, never end_turn", async () => {
    const upstream = [
      sse("response.created", { response: {} }),
      sse("response.output_text.delta", { delta: "partial" }),
      sse("response.incomplete", {
        response: {
          status: "incomplete",
          incomplete_details: {
            reason: "empty_kiro_fallback",
            message: "Kiro produced no final answer on its bounded completion retry",
            retryable: true,
          },
        },
      }),
    ].join("");
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    expect(events.some(event => event.name === "message_delta" || event.name === "message_stop")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      name: "error",
      data: {
        type: "error",
        error: {
          type: "overloaded_error",
          message: "Kiro produced no final answer on its bounded completion retry",
        },
      },
    });

    const json = responsesJsonToAnthropicMessage({
      status: "incomplete",
      incomplete_details: { reason: "reasoning_only_kiro_fallback", retryable: true },
      output: [],
    }, "m");
    expect(json).toEqual({
      type: "error",
      error: {
        type: "overloaded_error",
        message: "upstream response was incomplete (reasoning_only_kiro_fallback)",
      },
    });
  });

  test("completed end_turn:false without a client tool becomes overloaded_error", async () => {
    const upstream = sse("response.created", { response: {} })
      + sse("response.completed", { response: { status: "completed", end_turn: false } });
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    expect(events.at(-1)).toMatchObject({ name: "error", data: { error: { type: "overloaded_error" } } });
  });

  test("idle keepalive pings flow after semantic output during upstream silence", async () => {
    // response.created is transport-only and must not start Anthropic framing because the
    // next semantic frame could still be an initial error. Once real output starts the
    // Anthropic message, periodic pings keep an otherwise idle connection alive.
    const PING_INTERVAL_MS = 25;
    const SILENCE_MS = 300;
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(sse("response.created", { response: {} })));
        controller.enqueue(encoder.encode(sse("response.output_text.delta", { delta: "x" })));
        await new Promise(r => setTimeout(r, SILENCE_MS));
        controller.enqueue(encoder.encode(sse("response.completed", { response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })));
        controller.close();
      },
    });
    const events = await collectEvents(responsesSseToAnthropicSse(upstream, "m", { pingIntervalMs: PING_INTERVAL_MS }));
    const pings = events.filter(e => e.name === "ping").length;
    expect(pings).toBeGreaterThanOrEqual(3); // startup ping + >=2 idle pings after semantic start
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

describe("sanitizeWebSearchInput (#381)", () => {
  test("omits empty allowed_domains and blocked_domains arrays", () => {
    expect(sanitizeWebSearchInput({
      query: "CLAUDE.md practices",
      allowed_domains: ["code.claude.com"],
      blocked_domains: [],
    })).toEqual({
      query: "CLAUDE.md practices",
      allowed_domains: ["code.claude.com"],
    });
    expect(sanitizeWebSearchInput({
      query: "community",
      allowed_domains: [],
      blocked_domains: ["example.com"],
    })).toEqual({
      query: "community",
      blocked_domains: ["example.com"],
    });
    expect(sanitizeWebSearchInput({
      query: "open",
      allowed_domains: [],
      blocked_domains: [],
    })).toEqual({ query: "open" });
  });

  test("keeps allowed_domains and drops blocked_domains when both are non-empty", () => {
    expect(sanitizeWebSearchInput({
      query: "docs",
      allowed_domains: ["code.claude.com"],
      blocked_domains: ["example.com"],
    })).toEqual({
      query: "docs",
      allowed_domains: ["code.claude.com"],
    });
  });

  test("JSON path sanitizes WebSearch function_call arguments", () => {
    const msg = responsesJsonToAnthropicMessage({
      status: "completed",
      output: [{
        type: "function_call",
        call_id: "toolu_ws",
        name: "WebSearch",
        arguments: JSON.stringify({
          query: "site:code.claude.com memory",
          allowed_domains: ["code.claude.com"],
          blocked_domains: [],
        }),
      }],
      usage: { input_tokens: 3, output_tokens: 1 },
    }, "claude-ocx-native--gpt-5.6-sol") as Record<string, any>;
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content[0]).toEqual({
      type: "tool_use",
      id: "toolu_ws",
      name: "WebSearch",
      input: {
        query: "site:code.claude.com memory",
        allowed_domains: ["code.claude.com"],
      },
    });
  });

  test("SSE path buffers WebSearch args and emits one sanitized input_json_delta", async () => {
    const args = JSON.stringify({
      query: "CLAUDE.md token cost",
      allowed_domains: [],
      blocked_domains: ["example.com"],
    });
    const upstream = [
      sse("response.created", { response: {} }),
      sse("response.output_item.added", {
        output_index: 0,
        item: { type: "function_call", id: "fc_ws", call_id: "toolu_ws", name: "WebSearch", arguments: "", status: "in_progress" },
      }),
      sse("response.function_call_arguments.delta", { item_id: "fc_ws", output_index: 0, delta: args.slice(0, 20) }),
      sse("response.function_call_arguments.delta", { item_id: "fc_ws", output_index: 0, delta: args.slice(20) }),
      sse("response.output_item.done", {
        output_index: 0,
        item: { type: "function_call", id: "fc_ws", call_id: "toolu_ws", name: "WebSearch", arguments: args },
      }),
      sse("response.completed", { response: { status: "completed", usage: { input_tokens: 2, output_tokens: 1 } } }),
    ].join("");
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), "m"));
    const deltas = events.filter(e => e.name === "content_block_delta" && e.data.delta?.type === "input_json_delta");
    expect(deltas).toHaveLength(1);
    expect(JSON.parse(deltas[0].data.delta.partial_json)).toEqual({
      query: "CLAUDE.md token cost",
      blocked_domains: ["example.com"],
    });
  });

  test("fragmented WebSearch args admit exact 2 MiB and reject one byte over", async () => {
    const prefix = "{\"query\":\"";
    const suffix = "\"}";
    const exactArgs = prefix
      + "x".repeat(TRANSLATOR_MAX_CALL_ARGUMENT_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))
      + suffix;
    const exactSplit = Math.floor(exactArgs.length / 2);
    const exactBudget = createTestTranslatorBudget();
    const exactEvents = await collectEvents(responsesSseToAnthropicSse(streamFromChunks([
      sse("response.output_item.added", {
        item: { type: "function_call", id: "fc_exact", call_id: "toolu_exact", name: "WebSearch" },
      }),
      sse("response.function_call_arguments.delta", { item_id: "fc_exact", delta: exactArgs.slice(0, exactSplit) }),
      sse("response.function_call_arguments.delta", { item_id: "fc_exact", delta: exactArgs.slice(exactSplit) }),
      sse("response.output_item.done", {
        item: { type: "function_call", id: "fc_exact", call_id: "toolu_exact", name: "WebSearch" },
      }),
      sse("response.completed", { response: { status: "completed" } }),
    ]), "m", { translatorBudget: exactBudget }));
    const exactDelta = exactEvents.find(event => event.data.delta?.type === "input_json_delta");
    expect(JSON.parse(exactDelta!.data.delta.partial_json).query.length)
      .toBe(exactArgs.length - prefix.length - suffix.length);
    expect(exactEvents.at(-1)?.name).toBe("message_stop");
    expect(exactBudget.snapshot().activeCalls).toBe(0);

    const overArgs = exactArgs.slice(0, -suffix.length) + "z" + suffix;
    const overSplit = Math.floor(overArgs.length / 2);
    const overEvents = await collectEvents(responsesSseToAnthropicSse(streamFromChunks([
      sse("response.output_item.added", {
        item: { type: "function_call", id: "fc_over", call_id: "toolu_over", name: "WebSearch" },
      }),
      sse("response.function_call_arguments.delta", { item_id: "fc_over", delta: overArgs.slice(0, overSplit) }),
      sse("response.function_call_arguments.delta", { item_id: "fc_over", delta: overArgs.slice(overSplit) }),
    ]), "m"));
    expect(overEvents.at(-1)).toMatchObject({
      name: "error",
      data: { error: { type: "request_too_large", code: "translation_buffer_limit" } },
    });
  }, 60_000);
});
