import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { createGoogleAdapter } from "../src/adapters/google";
import { adapterFailureFromMessage, bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
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
  return text.split("\n\n").map(f => f.trim()).filter(f => f && f !== "data: [DONE]").map(frame => {
    const lines = frame.split("\n");
    const event = lines.find(l => l.startsWith("event: "))?.slice(7);
    const dataLine = lines.find(l => l.startsWith("data: "));
    return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
  });
}

describe("inline error envelope in a 200 stream (F1)", () => {
  test("openai-chat yields a terminal error, not silent truncation", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
      'data: {"error":{"message":"Rate limit reached for model","code":"rate_limit_exceeded"}}\n\n',
    ].join(""));
    const events = await collect(adapter.parseStream(response));
    expect(events.find(e => e.type === "error")).toMatchObject({ message: "Rate limit reached for model" });
  });

  test("google yields a terminal error on an inline error frame", async () => {
    const adapter = createGoogleAdapter({ ...provider, adapter: "google" });
    const response = new Response('data: {"error":{"message":"RESOURCE_EXHAUSTED","code":429}}\n\n');
    const events = await collect(adapter.parseStream(response));
    expect(events.find(e => e.type === "error")).toMatchObject({ message: "RESOURCE_EXHAUSTED" });
  });

  test("bridge converts the adapter error into a classified response.failed (no completed)", async () => {
    async function* gen(): AsyncGenerator<AdapterEvent> {
      yield { type: "text_delta", text: "par" };
      yield { type: "error", message: "Rate limit reached for model" };
    }
    const frames = await collectSse(bridgeToResponsesSSE(gen(), "routed/model"));
    const failed = frames.find(f => f.event === "response.failed");
    expect(failed).toBeDefined();
    expect((failed!.data.response as Record<string, unknown>).error).toMatchObject({ code: "rate_limit_exceeded" });
    expect(frames.some(f => f.event === "response.completed")).toBe(false);
  });

  test("Cursor resource_exhausted maps to 429 rate_limit_error in response.failed", async () => {
    async function* gen(): AsyncGenerator<AdapterEvent> {
      yield {
        type: "error",
        message: "Cursor rate limit exceeded: Cursor Connect error resource_exhausted: too many requests",
      };
    }
    const frames = await collectSse(bridgeToResponsesSSE(gen(), "cursor/gpt-5"));
    const failed = frames.find(f => f.event === "response.failed");
    expect(failed).toBeDefined();
    expect((failed!.data.response as Record<string, unknown>).error).toMatchObject({
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    });
    expect(adapterFailureFromMessage("Cursor rate limit exceeded: Cursor Connect error resource_exhausted: too many requests")).toMatchObject({
      httpStatus: 429,
      error: { type: "rate_limit_error", code: "rate_limit_exceeded" },
    });
  });
});
