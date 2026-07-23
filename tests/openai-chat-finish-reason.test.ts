import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { AdapterEvent } from "../src/types";

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function lastDone(events: AdapterEvent[]): { type: "done"; stopReason?: string } | undefined {
  return events.find(e => e.type === "done") as { type: "done"; stopReason?: string } | undefined;
}

describe("openai-chat streaming finish_reason -> stopReason propagation", () => {
  test("finish_reason=stop -> done with stopReason=stop", async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("stop");
  });

  test("finish_reason=length -> done with stopReason=length", async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"truncated"},"finish_reason":"length"}]}\n\n');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("length");
  });

  test("finish_reason=max_tokens -> done with stopReason=max_tokens", async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"max_tokens"}]}\n\n');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("max_tokens");
  });

  test("finish_reason=tool_calls -> done with stopReason=tool_calls", async () => {
    const response = new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("tool_calls");
  });

  test("finish_reason=content_filter -> done with stopReason=content_filter", async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"filtered"},"finish_reason":"content_filter"}]}\n\n');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("content_filter");
  });

  test("[DONE] after finish_reason=length preserves the captured stopReason", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("length");
  });

  test("[DONE] without any finish_reason -> done with stopReason=undefined", async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBeUndefined();
  });

  test("EOF without finish_reason and without [DONE] -> error (not done)", async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const done = events.find(e => e.type === "done");
    expect(done).toBeUndefined();
    expect(events.at(-1)?.type).toBe("error");
  });

  test("usage-only final frame without finish_reason -> done with stopReason=undefined", async () => {
    const response = new Response(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}'
    );
    const events = await collect(createOpenAIChatAdapter(provider).parseStream(response));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBeUndefined();
  });
});

describe("openai-chat non-streaming finish_reason -> stopReason propagation", () => {
  test("finish_reason=stop -> done with stopReason=stop", async () => {
    const json = JSON.stringify({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
    const events = await createOpenAIChatAdapter(provider).parseResponse(new Response(json));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("stop");
  });

  test("finish_reason=length -> done with stopReason=length", async () => {
    const json = JSON.stringify({
      choices: [{ message: { content: "truncated" }, finish_reason: "length" }],
      usage: { prompt_tokens: 5, completion_tokens: 4096, total_tokens: 4101 },
    });
    const events = await createOpenAIChatAdapter(provider).parseResponse(new Response(json));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("length");
  });

  test("finish_reason=max_tokens -> done with stopReason=max_tokens", async () => {
    const json = JSON.stringify({
      choices: [{ message: { content: "truncated" }, finish_reason: "max_tokens" }],
      usage: { prompt_tokens: 5, completion_tokens: 4096, total_tokens: 4101 },
    });
    const events = await createOpenAIChatAdapter(provider).parseResponse(new Response(json));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("max_tokens");
  });

  test("finish_reason=content_filter -> done with stopReason=content_filter", async () => {
    const json = JSON.stringify({
      choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
      usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
    });
    const events = await createOpenAIChatAdapter(provider).parseResponse(new Response(json));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("content_filter");
  });

  test("finish_reason=tool_calls -> done with stopReason=tool_calls", async () => {
    const json = JSON.stringify({
      choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    });
    const events = await createOpenAIChatAdapter(provider).parseResponse(new Response(json));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("tool_calls");
  });

  test("missing finish_reason -> done with stopReason=undefined", async () => {
    const json = JSON.stringify({
      choices: [{ message: { content: "no finish reason" } }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    const events = await createOpenAIChatAdapter(provider).parseResponse(new Response(json));
    const done = lastDone(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBeUndefined();
  });
});
