import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../../src/adapters/openai-chat";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../../src/adapters/google";
import { adapterFailureFromMessage, bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { adapterFailureFromEvent } from "../../src/bridge/internal";
import { preflightComboStreamResponse } from "../../src/server/responses/combo-stream-preflight";
import type { AdapterEvent } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));
const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

describe("typed rate-limit retry advice", () => {
  const refusal = (code = "resource_exhausted", message = "Devin cloud error resource_exhausted; retry after ~900s") => ({
    type: "error" as const, status: 429, errorType: "rate_limit_error", code, message, retryable: true,
  });

  test.each(["resource_exhausted", "rate_limit_exceeded", "slow_down"])("canonicalizes %s without changing the original event", code => {
    const event = refusal(code);
    const before = JSON.stringify(event);
    const result = adapterFailureFromEvent(event);
    expect(result).toMatchObject({ httpStatus: 429, error: {
      type: "rate_limit_error", code: "rate_limit_exceeded",
      message: `Please try again in 900s. ${event.message}`,
    } });
    expect(JSON.stringify(event)).toBe(before);
  });

  test("uses the longest lower bound before any shorter client-readable hint", () => {
    const event = refusal("resource_exhausted", "Please try again in 1s. Retry-After: 1h30m");
    expect(adapterFailureFromEvent(event).error.message).toStartWith("Please try again in 5400s.");
    expect(adapterFailureFromEvent(refusal("rate_limit_exceeded", "Please try again in 1800s.")).error.message)
      .toBe("Please try again in 1800s.");
  });

  test("does not invent a delay or rewrite unrelated explicit verdicts", () => {
    for (const message of ["busy", "retry after ~0s", "retry after 2 months"]) {
      expect(adapterFailureFromEvent(refusal("resource_exhausted", message)).error)
        .toMatchObject({ code: "resource_exhausted", message });
    }
    for (const code of ["insufficient_quota", "request_send_budget_exhausted", "invalid_argument", "vendor_custom"]) {
      const event = refusal(code);
      expect(adapterFailureFromEvent(event).error).toMatchObject({ code, message: event.message });
    }
    const not429 = { ...refusal(), status: 503, errorType: "server_error" };
    expect(adapterFailureFromEvent(not429).error).toMatchObject({ code: "resource_exhausted", message: not429.message });
  });

  test("typed and message-only errors share the same longest-first client advice", () => {
    const message = "rate limit exceeded: Please try again in 1s. retry after ~900s";
    const typed = adapterFailureFromEvent(refusal("resource_exhausted", message));
    const untyped = adapterFailureFromMessage(message);
    expect(typed).toEqual(untyped);
    expect(typed.error.message).toBe(`Please try again in 900s. Provider detail: ${message}`);
    expect(adapterFailureFromMessage(typed.error.message).error.message).toBe(typed.error.message);
  });

  test("redacts the retained provider detail before appending retry advice", () => {
    const secret = "sk-" + "a".repeat(32);
    const event = refusal("resource_exhausted", `retry after ~30s; api_key=${secret}`);
    const result = adapterFailureFromEvent(event);
    expect(result.error.message).toStartWith("Please try again in 30s.");
    expect(result.error.message).not.toContain(secret);
  });

  test("SSE and buffered failures agree and do not synthesize reasoning or success", async () => {
    const event = refusal();
    async function* source() { yield event; }
    const frames = await collectSse(bridgeToResponsesSSE(source(), "devin/swe-2"));
    const response = frames.find(frame => frame.event === "response.failed")!.data.response as Record<string, unknown>;
    const buffered = buildResponseJSON([event], "devin/swe-2");
    expect(response.error).toEqual(buffered.error);
    expect(response.error).toMatchObject({ code: "rate_limit_exceeded", message: `Please try again in 900s. ${event.message}` });
    expect(frames.some(frame => frame.event?.includes("reasoning") || frame.event === "response.completed")).toBe(false);
    expect(buffered.status).toBe("failed");
  });

  test("the canonical failure remains pre-output and available to combo failover", async () => {
    async function* source() { yield refusal(); }
    const response = new Response(bridgeToResponsesSSE(source(), "devin/swe-2"), {
      headers: { "content-type": "text/event-stream" },
    });
    const preflight = await preflightComboStreamResponse(response, { provider: "devin", model: "swe-2" });
    expect(preflight.kind).toBe("failed");
    expect(preflight.response.status).toBe(429);
    expect((await preflight.response.json()).error.code).toBe("rate_limit_exceeded");
  });
});

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
