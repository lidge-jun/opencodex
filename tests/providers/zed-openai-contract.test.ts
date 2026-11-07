import { describe, expect, test } from "bun:test";
import { translateZedOpenAiStream } from "../../src/adapters/zed-openai-stream";
import { createTranslatorBudget, type TranslatorBudgetOptions } from "../../src/lib/translator-budget";
import type { AdapterEvent } from "../../src/types";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { zedEventStream } from "../../src/adapters/zed";
import { scrubZedCredentials } from "../../src/providers/zed";
import { foldChatCompletion } from "../../src/protocols/encoders/chat";
import { scanEventsForWebSearch } from "../../src/web-search/loop";
import { anthropicSearchAssistantContent } from "../../src/web-search/anthropic-history";

// Each source chunk contains one frame, so the tests measure retained state separately.
function stream(frames: unknown[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index === frames.length) controller.close();
      else controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frames[index++])}\n\n`));
    },
  });
}

async function collect(frames: unknown[], options?: TranslatorBudgetOptions): Promise<AdapterEvent[]> {
  const budget = createTranslatorBudget(options);
  try {
    return await Array.fromAsync(translateZedOpenAiStream(stream(frames), budget));
  } finally {
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
    budget.dispose();
  }
}

describe("Zed OpenAI terminal contract", () => {
  test.each(["text", "summary", "raw"])("intervening %s cannot close a tool before its final delta", async channel => {
    const semantic = channel === "text"
      ? { type: "response.output_text.delta", item_id: "msg", delta: "later" }
      : { type: channel === "summary" ? "response.reasoning_summary_text.delta" : "response.reasoning_text.delta", item_id: "r", delta: "later" };
    const events = await collect([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "call", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc", delta: '{"x":' }, semantic,
      { type: "response.function_call_arguments.delta", item_id: "fc", delta: "1}" },
      { type: "response.function_call_arguments.done", item_id: "fc", arguments: '{"x":1}' },
      { type: "response.completed", response: { output: [] } },
    ]);
    const semanticIndex = events.findIndex(event => event.type === (channel === "text" ? "text_delta" : channel === "summary" ? "thinking_delta" : "reasoning_raw_delta"));
    expect(semanticIndex).toBeGreaterThan(events.findIndex(event => event.type === "tool_call_end"));
    const result = buildResponseJSON(events, "fixture");
    expect(result.output).toContainEqual(expect.objectContaining({ type: "function_call", arguments: '{"x":1}', status: "completed" }));
  });

  test("a different item id replaying the same call cannot execute twice", async () => {
    const call = { type: "function_call", call_id: "same", name: "shell", arguments: "{}" };
    const events = await collect([
      { type: "response.output_item.done", item: { ...call, id: "first" } },
      { type: "response.completed", response: { output: [{ ...call, id: "second" }] } },
    ]);
    expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(1);
  });

  test.each(["name", "type"])("conflicting call %s reuse fails closed", async field => {
    const call = { type: "function_call", call_id: "same", name: "shell", arguments: "{}" };
    const events = await collect([
      { type: "response.output_item.done", item: { ...call, id: "first" } },
      { type: "response.completed", response: { output: [{ ...call, id: "second", [field]: field === "name" ? "other" : "custom_tool_call" }] } },
    ]);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(1);
  });

  test("an unnamed completed call terminates before later items", async () => {
    const events = await collect([{ type: "response.completed", response: { output: [
      { type: "function_call", id: "bad", arguments: "{}" },
      { type: "function_call", id: "good", call_id: "call", name: "shell", arguments: "{}" },
    ] } }]);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  test("done-only text survives and is deduplicated on completion", async () => {
    const events = await collect([
      { type: "response.output_text.done", item_id: "m", content_index: 0, text: "answer" },
      { type: "response.completed", response: { output: [{ type: "message", id: "m", content: [{ type: "output_text", text: "answer" }] }] } },
    ]);
    expect(events).toEqual([{ type: "text_delta", text: "answer" }, { type: "done" }]);
  });

  test("done-only fallback keeps repeated text in distinct content parts", async () => {
    const events = await collect([
      { type: "response.output_text.delta", item_id: "m", content_index: 0, delta: "same" },
      { type: "response.output_text.done", item_id: "m", content_index: 0, text: "same" },
      { type: "response.output_text.done", item_id: "m", content_index: 1, text: "same" },
      { type: "response.completed", response: { output: [] } },
    ]);
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join(""))
      .toBe("samesame");
  });

  test.each(["error", "response.failed", "response.incomplete"])("native %s diagnostics scrub the captured credential", async type => {
    const credentials = { userId: "fixture-user-42", accessToken: "fixture-token-xyz" };
    const message = "account fixture-user-42 token fixture-token-xyz";
    const payload = type === "error" ? { type, message }
      : { type, response: { error: { message }, incomplete_details: { reason: message } } };
    const body = new Response(JSON.stringify({ event: payload }) + "\n" + JSON.stringify({ status: "stream_ended" }) + "\n").body!;
    const budget = createTranslatorBudget();
    try {
      const events = await Array.fromAsync(translateZedOpenAiStream(zedEventStream(body, "open_ai", text => scrubZedCredentials(text, credentials)), budget));
      expect(JSON.stringify(events)).not.toContain(credentials.accessToken);
      expect(JSON.stringify(events)).not.toContain(credentials.userId);
    } finally { budget.dispose(); }
  });

  test.each(["anthropic", "google", "x_ai", "open_ai"] as const)("%s untyped error envelopes scrub diagnostic strings", async family => {
    const credentials = { userId: "fixture-user-42", accessToken: "fixture-token-xyz" };
    const secret = credentials.userId + " " + credentials.accessToken;
    const body = new Response(JSON.stringify({ event: { error: { message: secret, code: secret, type: secret } } }) + "\n").body!;
    const text = await new Response(zedEventStream(body, family, text => scrubZedCredentials(text, credentials))).text();
    expect(text).not.toContain(credentials.accessToken);
    expect(text).not.toContain(credentials.userId);
  });

  test("nested diagnostic metadata cannot carry credential strings to a delegate", async () => {
    const credentials = { userId: "fixture-user-42", accessToken: "fixture-token-xyz" };
    const body = new Response(JSON.stringify({ event: { type: "error", error: {
      message: "failure", metadata: { request_id: credentials.accessToken, nested: [credentials.userId] },
    } } }) + "\n").body!;
    const text = await new Response(zedEventStream(body, "x_ai", text => scrubZedCredentials(text, credentials))).text();
    expect(text).not.toContain(credentials.accessToken);
    expect(text).not.toContain(credentials.userId);
  });

  test("an untyped upstream error cannot become a successful completion", async () => {
    expect(await collect([{ error: { message: "failure" } }, { type: "response.completed", response: { output: [] } }]))
      .toEqual([{ type: "error", message: "failure" }]);
  });

  test.each([false, true])("argument completion cannot override a later incomplete item (stream=%s)", async streaming => {
    const events = await collect([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "call", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.done", item_id: "fc", arguments: "{}" },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc", call_id: "call", name: "shell", arguments: "{}", status: "incomplete" } },
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
    ]);
    const result = streaming
      ? (await new Response(bridgeToResponsesSSE((async function* () { yield* events; })(), "fixture")).text()).split("\n")
        .filter(line => line.startsWith("data: {"))
        .map(line => JSON.parse(line.slice(6))).findLast(event => event.type === "response.incomplete")?.response
      : buildResponseJSON(events, "fixture");
    expect(result.output).toContainEqual(expect.objectContaining({ call_id: "call", status: "incomplete", arguments: "{}" }));
  });

  test("search scanning preserves an unfinished call without making it executable", () => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "search", name: "web_search" },
      { type: "tool_call_delta", arguments: '{"query":"fixture"}' },
      { type: "tool_call_end", incomplete: true },
      { type: "incomplete", reason: "max_output_tokens" },
    ];
    const split = scanEventsForWebSearch(events);
    expect(split.calls).toEqual([]);
    expect(split.passthrough).toEqual(events);
    expect(split.hasMalformedToolCall).toBe(true);
    expect(() => anthropicSearchAssistantContent(events)).toThrow("unfinished tool call");
  });

  test.each([false, true])("truncated tools preserve terminal reason and usage through the %s streaming bridge", async streaming => {
    const budget = createTranslatorBudget();
    const events = translateZedOpenAiStream(stream([
      { type: "response.output_item.added", item: { id: "fc", type: "function_call", call_id: "call", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc", delta: '{"x":' },
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 7, output_tokens: 3 } } },
    ]), budget);
    try {
      const result = streaming
        ? (await new Response(bridgeToResponsesSSE(events, "fixture")).text()).split("\n")
          .filter(line => line.startsWith("data: {"))
          .map(line => JSON.parse(line.slice(6))).findLast(event => event.type === "response.incomplete" || event.type === "response.failed")?.response
        : buildResponseJSON(await Array.fromAsync(events), "fixture");
      expect(result).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 7, output_tokens: 3 } });
      expect(result.output).toContainEqual(expect.objectContaining({ type: "function_call", arguments: '{"x":', status: "incomplete" }));
    } finally { budget.dispose(); }
  });

  test("unfinished parallel calls keep their statuses and received input through both bridges", async () => {
    const events = await collect([
      { type: "response.output_item.added", item: { id: "a", type: "function_call", call_id: "a", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "a", delta: "{}" },
      { type: "response.output_item.added", item: { id: "b", type: "function_call", call_id: "b", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "b", delta: '{"x":' },
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
    ]);
    for (const streaming of [false, true]) {
      const result = streaming
        ? (await new Response(bridgeToResponsesSSE((async function* () { yield* events; })(), "fixture")).text()).split("\n")
          .filter(line => line.startsWith("data: {"))
          .map(line => JSON.parse(line.slice(6))).findLast(event => event.type === "response.incomplete")?.response
        : buildResponseJSON(events, "fixture");
      expect(result.output.filter((item: Record<string, unknown>) => item.type === "function_call"))
        .toEqual([expect.objectContaining({ call_id: "a", status: "incomplete", arguments: "{}" }),
          expect.objectContaining({ call_id: "b", status: "incomplete", arguments: '{"x":' })]);
    }
  });

  test("direct Chat encoding retains truncation and usage for an unfinished function", async () => {
    const budget = createTranslatorBudget();
    try {
      const response = await foldChatCompletion(translateZedOpenAiStream(stream([
        { type: "response.output_item.added", item: { id: "fc", type: "function_call", call_id: "call", name: "shell", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc", delta: '{"x":' },
        { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 7, output_tokens: 3 } } },
      ]), budget), { model: "fixture", translatorBudget: budget });
      expect(await response.json()).toMatchObject({ choices: [{ finish_reason: "length" }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
    } finally { budget.dispose(); }
  });

  test("EOF with an unfinished call cannot claim a completed turn", async () => {
    const events = await collect([
      { type: "response.output_item.added", item: { id: "fc", type: "function_call", call_id: "call", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc", delta: "{}" },
    ]);
    expect(events.at(-1)).toEqual({ type: "incomplete", reason: "adapter_eof" });
    expect(buildResponseJSON(events, "fixture").output).toContainEqual(expect.objectContaining({ status: "incomplete" }));
  });

  test("an explicitly incomplete custom item keeps its confirmed input and incomplete status", async () => {
    const events = await collect([
      { type: "response.output_item.done", item: { type: "custom_tool_call", id: "fc", call_id: "call", name: "apply_patch", input: "partial", status: "incomplete" } },
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
    ]);
    const result = buildResponseJSON(events, "fixture", { freeformToolNames: new Set(["apply_patch"]) });
    expect(result.output).toContainEqual(expect.objectContaining({ type: "custom_tool_call", input: "partial", status: "incomplete" }));
  });

  test("buffered parallel progress emits an invisible heartbeat", async () => {
    const events = await collect([
      { type: "response.output_item.added", item: { id: "a", type: "function_call", call_id: "call_a", name: "shell", arguments: "" } },
      { type: "response.output_item.added", item: { id: "b", type: "function_call", call_id: "call_b", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "b", delta: "{}" },
      { type: "response.function_call_arguments.done", item_id: "a", arguments: "{}" },
      { type: "response.function_call_arguments.done", item_id: "b", arguments: "{}" },
      { type: "response.completed", response: { output: [] } },
    ]);
    expect(events[1]).toMatchObject({ type: "heartbeat" });
    expect(events.filter(event => event.type === "tool_call_start").map(event => event.id)).toEqual(["call_a", "call_b"]);
  });

  test.each([
    { input_tokens: 2, output_tokens: 1, input_tokens_details: { cache_write_tokens: 4, cache_write_1h_tokens: 3 }, vendor: { fixture: true } },
    { vendor: { fixture: true } },
  ])("usage retains cache writes and opaque metadata: %j", async usage => {
    const events = await collect([{ type: "response.completed", response: { output: [], usage } }]);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { rawUsage: usage } });
    if ("input_tokens" in usage) expect(events.at(-1)).toMatchObject({ usage: { cacheCreationInputTokens: 4, cacheCreation1hInputTokens: 3 } });
  });

  test("a failed response keeps usage without completing an open tool", async () => {
    expect(await collect([
      { type: "response.output_item.added", item: { id: "fc", type: "function_call", call_id: "call", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc", delta: "{" },
      { type: "response.failed", response: { error: { message: "failure" }, usage: { input_tokens: 7, output_tokens: 3 } } },
    ])).toEqual([
      { type: "tool_call_start", id: "call", name: "shell" },
      { type: "tool_call_delta", arguments: "{" },
      { type: "tool_call_end", incomplete: true },
      { type: "error", message: "failure", usage: { inputTokens: 7, outputTokens: 3 } },
    ]);
  });

  test("incomplete aliases use the shared max_output_tokens contract", async () => {
    expect(await collect([{ type: "response.incomplete", response: { incomplete_details: { reason: "length" } } }]))
      .toEqual([{ type: "incomplete", reason: "max_output_tokens" }]);
  });

  test("a tool with no name fails instead of disappearing into a successful turn", async () => {
    const events = await collect([
      { type: "response.function_call_arguments.delta", item_id: "fc", delta: "{}" },
      { type: "response.function_call_arguments.done", item_id: "fc", arguments: "{}" },
    ]);
    expect(events).toEqual([
      { type: "heartbeat" },
      expect.objectContaining({ type: "error", message: expect.stringContaining("without a function name") }),
    ]);
  });

  test("reasoning fallback is scoped to each output item", async () => {
    expect(await collect([
      { type: "response.reasoning_summary_text.delta", item_id: "r1", delta: "first" },
      { type: "response.reasoning_text.delta", item_id: "r1", delta: "raw first" },
      { type: "response.output_item.done", item: { type: "reasoning", id: "r1", summary: [{ text: "first" }], content: [{ type: "reasoning_text", text: "raw first" }] } },
      { type: "response.output_item.done", item: { type: "reasoning", id: "r2", summary: [{ text: "second" }], content: [{ type: "reasoning_text", text: "raw second" }] } },
      { type: "response.completed", response: { output: [
        { type: "reasoning", id: "r2", summary: [{ text: "second" }], content: [{ type: "reasoning_text", text: "raw second" }] },
      ] } },
    ])).toEqual([
      { type: "thinking_delta", thinking: "first" },
      { type: "reasoning_raw_delta", text: "raw first" },
      { type: "thinking_delta", thinking: "second" },
      { type: "reasoning_raw_delta", text: "raw second" },
      { type: "done" },
    ]);
  });
});

describe("Zed OpenAI retention bounds", () => {
  test("replacing a full snapshot with a shorter one restores per-call headroom", async () => {
    const events = await collect([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "call", name: "shell", arguments: "x".repeat(20) } },
      { type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "call", name: "shell", arguments: "x" } },
      { type: "response.function_call_arguments.delta", item_id: "fc", delta: "x".repeat(15) },
      { type: "response.function_call_arguments.done", item_id: "fc" },
      { type: "response.completed", response: { output: [] } },
    ], { maxCallArgumentBytes: 30 });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  test.each(["function_call", "message"])("empty %s identities cannot grow outside the turn budget", async type => {
    const frames = Array.from({ length: 30 }, (_, index) => ({
      type: "response.output_item.done",
      item: type === "function_call"
        ? { type, id: `fc_${index}_${"x".repeat(100)}`, call_id: `call_${index}`, name: "shell", arguments: "" }
        : { type, id: `msg_${index}_${"x".repeat(100)}`, phase: "commentary", content: [] },
    }));
    await expect(collect(frames, { maxTurnBytes: 2048 })).rejects.toMatchObject({ code: "translation_buffer_limit" });
  });

  test("a full snapshot beyond the per-call limit releases on overflow", async () => {
    await expect(collect([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "call", name: "shell", arguments: "x".repeat(31) } },
    ], { maxCallArgumentBytes: 30 })).rejects.toMatchObject({ code: "translation_buffer_limit" });
  });

  test("an identical done snapshot does not double the logical per-call size", async () => {
    expect((await collect([
      { type: "response.output_item.added", item: { type: "custom_tool_call", id: "fc", call_id: "call", name: "apply_patch", input: "" } },
      { type: "response.custom_tool_call_input.delta", item_id: "fc", delta: "x".repeat(30) },
      { type: "response.custom_tool_call_input.done", item_id: "fc", input: "x".repeat(30) },
      { type: "response.completed", response: { output: [] } },
    ], { maxCallArgumentBytes: 30 })).at(-1)).toEqual({ type: "done" });
  });

  test("a done snapshot equal to streamed input replaces an older speculative full value", async () => {
    const events = await collect([
      { type: "response.output_item.added", item: { type: "custom_tool_call", id: "fc", call_id: "call", name: "apply_patch", input: "prefix-stale" } },
      { type: "response.custom_tool_call_input.delta", item_id: "fc", delta: "prefix" },
      { type: "response.custom_tool_call_input.done", item_id: "fc", input: "prefix" },
      { type: "response.completed", response: { output: [] } },
    ]);
    expect(events.filter(event => event.type === "tool_call_delta").map(event => event.arguments).join(""))
      .toBe("prefix");
  });

  test("queued semantic events and open calls release on cancellation", async () => {
    const budget = createTranslatorBudget();
    const iterator = translateZedOpenAiStream(stream([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "call", name: "shell", arguments: "" } },
      { type: "response.output_text.delta", item_id: "m", delta: "held" },
    ]), budget);
    try {
      expect((await iterator.next()).value?.type).toBe("tool_call_start");
      expect((await iterator.next()).value?.type).toBe("heartbeat");
      expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
      await iterator.return(undefined);
      expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
    } finally { budget.dispose(); }
  });

  test("metadata-only usage remains charged until its terminal event is consumed", async () => {
    const usage = { vendor: { large: "x".repeat(500) } };
    const budget = createTranslatorBudget();
    const iterator = translateZedOpenAiStream(stream([
      { type: "response.completed", response: { output: [], usage } },
    ]), budget);
    try {
      expect((await iterator.next()).value).toMatchObject({ type: "done", usage: { rawUsage: usage } });
      expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(JSON.stringify(usage)));
      await iterator.return(undefined);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { budget.dispose(); }
  });

  test("split surrogate fragments retain their exact UTF-8 argument size", async () => {
    const events = await collect([
      { type: "response.output_item.added", item: { type: "custom_tool_call", id: "fc", call_id: "call", name: "apply_patch", input: "" } },
      { type: "response.custom_tool_call_input.delta", item_id: "fc", delta: "\ud83d" },
      { type: "response.custom_tool_call_input.delta", item_id: "fc", delta: "\ude00" },
      { type: "response.custom_tool_call_input.done", item_id: "fc" },
      { type: "response.completed", response: { output: [] } },
    ], { maxCallArgumentBytes: 4 });
    expect(events.filter(event => event.type === "tool_call_delta").map(event => event.arguments).join(""))
      .toBe("😀");
    expect(events.at(-1)).toEqual({ type: "done" });
  });
});
