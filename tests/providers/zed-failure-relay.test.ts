import { expect, test } from "bun:test";
import { translateZedOpenAiStream } from "../../src/adapters/zed-openai-stream";
import { zedEventStream } from "../../src/adapters/zed";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { scrubZedCredentials } from "../../src/providers/zed";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";

const credentials = { userId: "fixture-user-42", accessToken: "fixture-token-xyz" };

async function collect(frames: unknown[], normalize = true) {
  const source = new Response(normalize
    ? frames.map(event => JSON.stringify({ event }) + "\n").join("") + JSON.stringify({ status: "stream_ended" }) + "\n"
    : frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")).body!;
  const budget = createTranslatorBudget();
  try {
    return await Array.fromAsync(translateZedOpenAiStream(
      normalize ? zedEventStream(source, "open_ai", value => scrubZedCredentials(value, credentials)) : source, budget,
    ));
  } finally {
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
    budget.dispose();
  }
}

test("the translator independently filters failure counters and inherited opaque usage", async () => {
  const events = await collect([
    { type: "response.completed", response: { output: [], usage: {
      input_tokens: 4, output_tokens: 2, metadata: { token: credentials.accessToken },
    } } },
    { type: "response.failed", response: { error: { message: "failure" } } },
  ], false);
  expect(events.at(-1)).toEqual({ type: "error", message: "failure", usage: { inputTokens: 4, outputTokens: 2 } });
  const malformed = await collect([{ type: "error", error: { message: "failure" }, usage: {
    input_tokens: credentials.accessToken, output_tokens: 2, total_tokens: -1,
    input_tokens_details: { cached_tokens: { token: credentials.accessToken }, cache_write_tokens: 3, cache_write_1h_tokens: 1 },
    output_tokens_details: { reasoning_tokens: credentials.userId },
  } }], false);
  expect(malformed.at(-1)).toEqual({ type: "error", message: "failure", usage: {
    inputTokens: 0, outputTokens: 2, cacheCreationInputTokens: 3, cacheCreation1hInputTokens: 1,
  } });
  expect(await wire(malformed, true)).not.toContain(credentials.accessToken);
});

for (const kind of ["function_call", "custom_tool_call"] as const) {
  const field = kind === "function_call" ? "arguments" : "input";
  const event = kind === "function_call" ? "response.function_call_arguments" : "response.custom_tool_call_input";
  for (const intervening of ["added", "delta"]) {
    test(`${kind} cannot replace delivered completion bytes through a later ${intervening}`, async () => {
      const item = { type: kind, id: "a", call_id: "call", name: "shell", [field]: "" };
      const events = await collect([
        { type: "response.output_item.added", item },
        { type: `${event}.delta`, item_id: "a", delta: "{" },
        { type: `${event}.done`, item_id: "a", [field]: '{"x":1}' },
        intervening === "added"
          ? { type: "response.output_item.added", item: { ...item, [field]: '{"x":2}' } }
          : { type: `${event}.delta`, item_id: "a", delta: '"x":2}' },
        { type: "response.output_item.done", item: { ...item, [field]: '{"x":2}', status: "completed" } },
        { type: "response.completed", response: { output: [] } },
      ]);
      expect(events.some(value => value.type === "tool_call_end" && !value.incomplete)).toBe(false);
      expect(events).toContainEqual({ type: "tool_call_end", incomplete: true });
      expect(events.at(-1)?.type).toBe("error");
    });
  }
  test(`${kind} accepts matching/prefix completions and clears speculative input on empty completion`, async () => {
    for (const streamed of ['{"x":', '{"x":1}']) {
      const item = { type: kind, id: "a", call_id: "call", name: "shell", [field]: "speculative" };
      const events = await collect([
        { type: "response.output_item.added", item },
        { type: `${event}.delta`, item_id: "a", delta: streamed },
        { type: "response.output_item.done", item: { ...item, [field]: '{"x":1}', status: "completed" } },
        { type: "response.completed", response: { output: [] } },
      ]);
      expect(events.filter(value => value.type === "tool_call_delta").map(value => value.arguments).join("")).toBe('{"x":1}');
      expect(events).toContainEqual({ type: "tool_call_end" });
      expect(events.at(-1)?.type).toBe("done");
    }
    const item = { type: kind, id: "a", call_id: "call", name: "shell", [field]: "speculative" };
    const events = await collect([
      { type: "response.output_item.added", item },
      { type: "response.output_item.done", item: { ...item, [field]: "", status: "completed" } },
      { type: "response.completed", response: { output: [] } },
    ]);
    expect(events.some(value => value.type === "tool_call_delta")).toBe(false);
    expect(events).toContainEqual({ type: "tool_call_end" });
    expect(events.at(-1)?.type).toBe("done");
  });
}

test("upstream failure wins over an unnamed pending call and fences a completed buffered call", async () => {
  const events = await collect([
    { type: "response.function_call_arguments.delta", item_id: "unnamed", delta: "{" },
    { type: "response.output_item.added", item: { type: "function_call", id: "b", name: "shell", arguments: "" } },
    { type: "response.output_item.done", item: { type: "function_call", id: "b", name: "shell", arguments: "{}", status: "completed" } },
    { type: "response.failed", response: { error: { message: "original failure" }, usage: { input_tokens: 2, output_tokens: 1 } } },
  ]);
  expect(events.filter(value => value.type === "tool_call_end")).toEqual([{ type: "tool_call_end", incomplete: true }]);
  expect(events.at(-1)).toEqual({ type: "error", message: "original failure", usage: { inputTokens: 2, outputTokens: 1 } });
});

async function wire(events: AdapterEvent[], streaming: boolean) {
  return streaming
    ? await new Response(bridgeToResponsesSSE((async function* () { yield* events; })(), "fixture")).text()
    : JSON.stringify(buildResponseJSON(events, "fixture"));
}

for (const streaming of [false, true]) {
  for (const terminal of ["response.failed", "error", "response.incomplete"]) {
    test(`diagnostic usage retains only numeric counters (${terminal}, stream=${streaming})`, async () => {
      const events = await collect([{ type: terminal, response: {
        error: { message: "failure" }, incomplete_details: { reason: "max_output_tokens" }, usage: {
          input_tokens: 4, output_tokens: 2, total_tokens: 6,
          metadata: { account: credentials.userId, request_id: credentials.accessToken },
          input_tokens_details: { cached_tokens: 1, metadata: { token: credentials.accessToken } },
          output_tokens_details: { reasoning_tokens: 1, account: credentials.userId },
        },
      } }]);
      const output = await wire(events, streaming);
      expect(output).not.toContain(credentials.accessToken);
      expect(output).not.toContain(credentials.userId);
      expect(events.at(-1)).toMatchObject({ usage: {
        inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedInputTokens: 1, reasoningOutputTokens: 1,
      } });
      expect(events.at(-1)).not.toHaveProperty("usage.rawUsage");
      expect(output).toContain('"input_tokens":4');
    });
  }
}

for (const kind of ["function_call", "custom_tool_call"] as const) {
  const field = kind === "function_call" ? "arguments" : "input";
  const event = kind === "function_call" ? "response.function_call_arguments" : "response.custom_tool_call_input";
  for (const completion of ["arguments.done", "output_item.done", "response.completed"]) {
    for (const snapshot of ['{"x":2}', '{"x":', ""]) {
      test(`conflicting authoritative ${kind} ${completion} refuses ${JSON.stringify(snapshot)}`, async () => {
        const item = { type: kind, id: "a", call_id: "call", name: "shell", [field]: snapshot, status: "completed" };
        const authoritative = completion === "arguments.done" ? { type: `${event}.done`, item_id: "a", [field]: snapshot }
          : completion === "output_item.done" ? { type: "response.output_item.done", item }
            : { type: "response.completed", response: { output: [item] } };
        const events = await collect([
          { type: "response.output_item.added", item: { ...item, [field]: "", status: "in_progress" } },
          { type: `${event}.delta`, item_id: "a", delta: '{"x":1}' },
          authoritative,
          { type: "response.completed", response: { output: [] } },
        ]);
        expect(events.some(value => value.type === "tool_call_end" && !value.incomplete)).toBe(false);
        expect(events).toContainEqual({ type: "tool_call_end", incomplete: true });
        expect(events.at(-1)?.type).toBe("error");
        const result = buildResponseJSON(events, "fixture");
        expect(result.status).toBe("failed");
        expect(result.output).toContainEqual(expect.objectContaining({ type: "function_call", status: "incomplete" }));
        expect(await wire(events, true)).toContain('"status":"incomplete"');
      });
    }
  }
}

for (const terminal of ["response.failed", "error", "untyped"]) {
  test(`queued text and reasoning survive ${terminal} after incomplete calls`, async () => {
    const events = await collect([
      { type: "response.output_item.added", item: { type: "function_call", id: "a", call_id: "call", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "a", delta: '{"x":' },
      { type: "response.output_text.delta", item_id: "m", delta: "received explanation" },
      { type: "response.reasoning_summary_text.delta", item_id: "r", delta: "received summary" },
      { type: "response.reasoning_text.delta", item_id: "r", delta: "received reasoning" },
      { type: "response.output_item.added", item: { type: "custom_tool_call", id: "b", call_id: "call2", name: "other", input: "" } },
      { type: "response.custom_tool_call_input.delta", item_id: "b", delta: "partial" },
      { ...(terminal === "untyped" ? {} : { type: terminal }), error: { message: "upstream failed" },
        response: { usage: { input_tokens: 4, output_tokens: 2 } } },
    ]);
    expect(events.filter(value => value.type === "tool_call_end")).toEqual([
      { type: "tool_call_end", incomplete: true }, { type: "tool_call_end", incomplete: true },
    ]);
    expect(events.filter(value => ["text_delta", "thinking_delta", "reasoning_raw_delta"].includes(value.type))).toEqual([
      { type: "text_delta", text: "received explanation" },
      { type: "thinking_delta", thinking: "received summary" },
      { type: "reasoning_raw_delta", text: "received reasoning" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "error", message: "upstream failed", usage: { inputTokens: 4, outputTokens: 2 } });
    const result = buildResponseJSON(events, "fixture");
    expect(JSON.stringify(result.output)).toContain("received explanation");
    expect(result.status).toBe("failed");
    const output = await wire(events, true);
    expect(output).toContain("received explanation");
    expect(output).toContain("received summary");
    expect(output).toContain("received reasoning");
    expect(output).toContain("response.failed");
  });
}
