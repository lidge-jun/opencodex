import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of gen) out.push(e);
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
