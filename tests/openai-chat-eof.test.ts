import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { AdapterEvent } from "../src/types";

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("openai-chat stream EOF fail-closed", () => {
  test("truncated stream (no [DONE], no finish_reason) yields a terminal error, not a clean done", async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const last = events[events.length - 1];
    expect(last.type).toBe("error");
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

  test("EOF after a finish_reason (provider omits [DONE]) is accepted as done", async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const last = events[events.length - 1];
    expect(last.type).toBe("done");
    expect(events.some(e => e.type === "error")).toBe(false);
  });

  test("inline error envelope still yields a terminal error (no regression)", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
      'data: {"error":{"message":"Rate limit reached for model","code":"rate_limit_exceeded"}}\n\n',
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.find(e => e.type === "error")).toMatchObject({
      message: "Rate limit reached for model",
      status: 429,
      code: "rate_limit_exceeded",
    });
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

  test("genuinely truncated stream WITHOUT a trailing newline still fails closed", async () => {
    // Mid-content frame, no terminator, no newline — must remain a terminal error.
    const response = new Response('data: {"choices":[{"delta":{"content":"par"}}]}');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });
});
