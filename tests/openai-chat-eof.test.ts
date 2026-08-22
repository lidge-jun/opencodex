import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "./helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  // Heartbeats are invisible downstream: the bridge consumes them to re-arm its stall
  // watchdog and emits nothing. Dropping them here keeps these assertions about the wire
  // the client actually sees (#2156).
  for await (const e of gen) if (e.type !== "heartbeat") out.push(e);
  return out;
}

describe("openai-chat stream EOF fail-closed", () => {
  test("truncated stream (no [DONE], no finish_reason) yields done when content was emitted", async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const last = events[events.length - 1];
    expect(last.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("empty EOF without content still errors", async () => {
    const response = new Response("");
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("clean [DONE] yields done", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const last = events[events.length - 1];
    expect(last.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("[DONE] carries finish_reason length as max_tokens", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));

    expect(events.at(-1)).toEqual({ type: "done", usage: undefined, stopReason: "max_tokens" });
  });

  test("EOF after a finish_reason (provider omits [DONE]) is accepted as done", async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const last = events[events.length - 1];
    expect(last.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("EOF carries content_filter through the bridge as incomplete", async () => {
    const response = new Response(
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"content_filter"}]}\n\n',
    );
    const adapter = createOpenAIChatAdapter(provider);
    const events = await collect(adapter.parseStream(response.clone()));
    expect(events.at(-1)).toEqual({ type: "done", usage: undefined, stopReason: "content_filter" });

    const text = await new Response(bridgeToResponsesSSE(
      adapter.parseStream(response),
      "openai-chat/test-model",
    )).text();
    expect(text).toContain("event: response.incomplete");
    expect(text).toContain('"incomplete_details":{"reason":"content_filter"}');
    expect(text).not.toContain("event: response.completed");
  });

  test("inline error envelope still yields a terminal error (no regression)", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
      'data: {"error":{"message":"Rate limit reached for model","code":"rate_limit_exceeded"}}\n\n',
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.find(e => e.type === "error")).toMatchObject({ message: "Rate limit reached for model" });
  });

  test("choice-scoped finish_reason error yields a terminal error", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"error","error":{"code":"rate_limit","message":"ClinePass limit reached"}}]}\n\n',
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "rate_limit",
      message: "ClinePass limit reached",
    });
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("terminal errors discard a pending tool call instead of completing it", async () => {
    for (const terminal of [
      'data: {"choices":[{"finish_reason":"error","error":{"code":"server_error","message":"upstream failed"}}]}\n\n',
      'data: {"error":{"code":"server_error","message":"upstream failed"}}\n\n',
    ]) {
      const body = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"cmd\\":\\"l"}}]}}]}\n\n',
        terminal,
      ].join("");
      const adapter = createOpenAIChatAdapter(provider);
      const events = await collect(adapter.parseStream(new Response(body)));

      expect(events).toEqual([{ type: "error", code: "server_error", message: "upstream failed" }]);

      const bridged = await new Response(bridgeToResponsesSSE(
        adapter.parseStream(new Response(body)),
        "openai-chat/test-model",
      )).text();
      expect(bridged).toContain("event: response.failed");
      expect(bridged).not.toContain("response.function_call_arguments.done");
      expect(bridged).not.toContain('"status":"completed"');
    }
  });

  test("Cline-compatible delta.reasoning is preserved as reasoning output", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"reasoning":"considering"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n',
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));

    expect(events).toContainEqual({ type: "reasoning_raw_delta", text: "considering" });
    expect(events.at(-1)?.type).toBe("done");
  });

  test("finish-only chunk with no delta (provider omits [DONE]) is accepted as done", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("empty deltas followed by a finish-only chunk complete without phantom output", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"","reasoning_content":""}}]}\n\n',
      'data: {"choices":[{"delta":{}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));

    expect(events).toEqual([{ type: "done", usage: undefined }]);
  });

  test("final frame WITHOUT a trailing newline still emits its content and is accepted as done", async () => {
    // No trailing "\n" — the terminal frame stays in the buffer and is only seen at EOF. Its
    // content must NOT be dropped (regression guard: the EOF flush must run the full delta path).
    const response = new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.find(e => e.type === "text_delta")).toMatchObject({ type: "text_delta", text: "hi" });
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("final tool-call frame WITHOUT a trailing newline emits the tool call and closes it", async () => {
    const response = new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"q\\":1}"}}]},"finish_reason":"tool_calls"}]}',
    );
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.find(e => e.type === "tool_call_start")).toMatchObject({ type: "tool_call_start", id: "call_1", name: "get_weather" });
    expect(events.find(e => e.type === "tool_call_delta")).toMatchObject({ type: "tool_call_delta", arguments: '{"q":1}' });
    expect(events.some(e => e.type === "tool_call_end")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("final usage-only frame without a trailing newline is accepted as done", async () => {
    const response = new Response(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
    );
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("genuinely truncated stream WITHOUT a trailing newline completes when content was emitted", async () => {
    // Mid-content frame, no terminator, no newline — content was yielded, so accept done.
    const response = new Response('data: {"choices":[{"delta":{"content":"par"}}]}');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("EOF with pending tool calls and no finish_reason fails closed", async () => {
    const response = new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"a\\":"}}]}}]}\n\n',
    );
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
    expect(events.some(e => e.type === "tool_call_end")).toBe(false);
  });

  test("reasoning-only EOF without finish_reason fails closed", async () => {
    const response = new Response(
      'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
    );
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("usage-only EOF with pending tool calls fails closed", async () => {
    const response = new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{}"}}]}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
    );
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
    expect(events.some(e => e.type === "tool_call_end")).toBe(false);
  });

  test("usage-only EOF without answer text fails closed", async () => {
    const response = new Response(
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
    );
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });
});

describe("openai-chat EOF mid tool call (#735)", () => {
  test("a half-assembled tool call at EOF errors instead of being flushed as complete", async () => {
    // The provider opened a tool call and sent part of its argument JSON, then the socket closed
    // with no finish_reason and no [DONE]. flushToolCalls() emits tool_call_end, so running it
    // first would hand the client `{"cmd":"l` as a COMPLETED call -- a truncation reported as a
    // successful tool invocation. The check therefore runs before the flush.
    const response = new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"cmd\\":\\"l"}}]}}]}\n\n',
    );
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "tool_call_end")).toBe(false);
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("a usage frame does not launder a truncated tool call into success", async () => {
    // Usage alone counts as a terminal signal for text streams, and before this guard it also
    // let a mid-flight tool call through: the tool branch is checked on finish_reason only, so
    // usage must not be able to substitute for it.
    const response = new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"cmd\\":\\"l"}}]}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "tool_call_end")).toBe(false);
  });

  test("a tool call closed by [DONE] alone still completes normally", async () => {
    // [DONE] flushes and returns BEFORE the EOF block, so this exercises a different early-return
    // path than the finish_reason control below. It passes with the guard reverted -- that is the
    // point: it pins the path the guard must never start intercepting.
    const response = new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.some(e => e.type === "error")).toBe(false);
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("a tool call closed by finish_reason still completes normally", async () => {
    // The control: the guard must fire on MISSING terminal signals only, never on a well-formed
    // tool turn, or every tool call in the product breaks.
    const response = new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.some(e => e.type === "error")).toBe(false);
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("openai-chat unnamed tool calls fail closed (#1514)", () => {
  // The reported OpenCode Zen / DeepSeek shape: argument deltas arrive, the function name
  // never does, and the stream reaches a normal terminal boundary. Emitting that call hands
  // the Codex tool-call contract something it cannot dispatch and the turn breaks downstream.
  const unnamedDelta =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"arguments":"{\\"a\\":1}"}}]}}]}\n\n';

  function errorMessage(events: AdapterEvent[]): string {
    const last = events.at(-1);
    return last && last.type === "error" ? last.message : "";
  }

  test("terminated by [DONE]: error, no tool_call_start, no done", async () => {
    const response = new Response([unnamedDelta, "data: [DONE]\n\n"].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.some(e => e.type === "done")).toBe(false);
    expect(errorMessage(events)).toContain("without a function name");
  });

  test("terminated by finish_reason: error, no tool_call_start, no done", async () => {
    const response = new Response([
      unnamedDelta,
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.some(e => e.type === "done")).toBe(false);
    expect(errorMessage(events)).toContain("without a function name");
  });

  test("a whitespace-only name is rejected like a missing one", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"   ","arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(errorMessage(events)).toContain("without a function name");
  });

  test("a name arriving in a later chunk is still accepted", async () => {
    // The guard must not reject a call whose name is simply late: that is the ordinary
    // OpenAI streaming shape, where the first chunk may carry only id and arguments.
    const response = new Response([
      unnamedDelta,
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"shell"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.some(e => e.type === "error")).toBe(false);
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("an unnamed call without any terminal signal still reports truncation", async () => {
    // Raw EOF keeps its own fail-closed error: the truncation branch runs before the
    // post-loop flush, so the new guard must not steal that diagnosis.
    const response = new Response(unnamedDelta);
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.some(e => e.type === "done")).toBe(false);
    expect(errorMessage(events)).toContain("mid tool call");
  });

  test("a non-array tool_calls payload still reports the #1325 error", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"tool_calls":"nope"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(errorMessage(events)).toContain("invalid tool calls");
  });

  // The streamed tool-call shape is upstream JSON behind a TypeScript cast, so a truthy
  // non-string name reaches the accumulator unvalidated. Before ingest validation it was
  // stored and then thrown on at flush time as `call.name.trim is not a function` — an
  // uncatchable-looking TypeError instead of the #1325 terminal error.
  test("a non-string function name terminates instead of throwing", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":123,"arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(errorMessage(events)).toContain("invalid tool calls");
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("non-string arguments and a non-record function both terminate", async () => {
    const badArgs = new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"shell","arguments":42}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    expect(errorMessage(await collect(createOpenAIChatAdapter(provider).parseStream(badArgs))))
      .toContain("invalid tool calls");

    const badFunction = new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":"shell"}]}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    expect(errorMessage(await collect(createOpenAIChatAdapter(provider).parseStream(badFunction))))
      .toContain("invalid tool calls");
  });

  // Terminating mid-flush must not strand the reservations of the calls that were never
  // emitted. `closeToolCalls()` snapshots and closes every pending key before iteration,
  // so the call AFTER the offender is released too — assert that against the budget
  // itself rather than inferring it from the emitted events.
  test("terminating mid-flush releases every pending call's budget", async () => {
    const budget = createTestTranslatorBudget();
    const named = (index: number, id: string, name: string) =>
      `data: {"choices":[{"delta":{"tool_calls":[{"index":${index},"id":"${id}","function":{"name":"${name}","arguments":"{\\"padding\\":\\"aaaaaaaaaaaaaaaaaaaa\\"}"}}]}}]}\n\n`;
    const unnamed = (index: number, id: string) =>
      `data: {"choices":[{"delta":{"tool_calls":[{"index":${index},"id":"${id}","function":{"arguments":"{\\"padding\\":\\"bbbbbbbbbbbbbbbbbbbb\\"}"}}]}}]}\n\n`;

    const response = new Response([
      named(0, "call_ok", "shell"),
      unnamed(1, "call_bad"),
      named(2, "call_after", "read"),
      "data: [DONE]\n\n",
    ].join(""));

    const events = await collect(
      createOpenAIChatAdapterProduction(provider).parseStream(response, budget),
    );

    const snapshot = budget.snapshot();
    expect(snapshot.activeCalls).toBe(0);
    expect(snapshot.currentBytes).toBe(0);
    expect(snapshot.highWaterBytes).toBeGreaterThan(0);

    // The call after the offender is never emitted, and the turn ends on the error.
    const started = events.filter(e => e.type === "tool_call_start");
    expect(started.some(e => e.type === "tool_call_start" && e.id === "call_after")).toBe(false);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("buffered response with a blank function name fails closed", async () => {
    const response = new Response(
      JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "call_x", type: "function", function: { name: "", arguments: "{}" } }] } }],
      }),
      { headers: { "content-type": "application/json" } },
    );
    const events = await createOpenAIChatAdapter(provider).parseResponse!(response);
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.some(e => e.type === "error")).toBe(true);
  });

  test("buffered response with a valid function name is unchanged", async () => {
    const response = new Response(
      JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "call_x", type: "function", function: { name: "shell", arguments: "{}" } }] } }],
      }),
      { headers: { "content-type": "application/json" } },
    );
    const events = await createOpenAIChatAdapter(provider).parseResponse!(response);
    expect(events.some(e => e.type === "error")).toBe(false);
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(1);
  });
});
