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

  test("Cursor tool-catalog resource exhaustion maps to an actionable 400", async () => {
    const message = "Cursor resource limit exceeded: Cursor Connect error resource limit exceeded: tool catalog too large";
    async function* gen(): AsyncGenerator<AdapterEvent> {
      yield {
        type: "error",
        message,
      };
    }
    const frames = await collectSse(bridgeToResponsesSSE(gen(), "cursor/gpt-5"));
    const failed = frames.find(f => f.event === "response.failed");
    expect(failed).toBeDefined();
    expect((failed!.data.response as Record<string, unknown>).error).toMatchObject({
      type: "invalid_request_error",
      code: "tool_catalog_too_large",
    });
    expect(adapterFailureFromMessage(message)).toMatchObject({
      httpStatus: 400,
      error: { type: "invalid_request_error", code: "tool_catalog_too_large" },
    });
  });

  test("Cursor quota-style resource exhaustion maps to 429 rate limiting", async () => {
    // Adapter-side classification (classifyCursorError) now emits the rate-limit prefix
    // for generic resource_exhausted; the bridge must surface it as retry-with-backoff.
    const message = "Cursor rate limit exceeded: Cursor Connect error resource limit exceeded: Error";
    async function* gen(): AsyncGenerator<AdapterEvent> {
      yield {
        type: "error",
        message,
      };
    }
    const frames = await collectSse(bridgeToResponsesSSE(gen(), "cursor/gpt-5"));
    const failed = frames.find(f => f.event === "response.failed");
    expect(failed).toBeDefined();
    expect((failed!.data.response as Record<string, unknown>).error).toMatchObject({
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    });
    expect(adapterFailureFromMessage(message)).toMatchObject({
      httpStatus: 429,
      error: { type: "rate_limit_error", code: "rate_limit_exceeded" },
    });
  });

  test("Cursor rate-limit prefix beats quota wording in the detail", async () => {
    // The detail echoes "quota exhausted", which would otherwise classify as
    // insufficient_quota; the adapter's cursor-specific prefix must win.
    const message = "Cursor rate limit exceeded: resource limit exceeded while loading tool catalog: quota exhausted";
    expect(adapterFailureFromMessage(message)).toMatchObject({
      httpStatus: 429,
      error: { type: "rate_limit_error", code: "rate_limit_exceeded" },
    });
  });
});
