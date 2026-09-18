import { describe, expect, test } from "bun:test";
import { nativeChatSse } from "../../src/server/chat-native-sse";
import { createTranslatorBudget } from "../../src/lib/translator-budget";

describe("nativeChatSse lenient EOF termination", () => {
  const encoder = new TextEncoder();

  function makeBudget() {
    return createTranslatorBudget({ maxResidentBytes: 1024 * 1024, maxLiveTransientBytes: 1024 * 1024 });
  }

  test("text-only stream without terminal event recovers gracefully with [DONE] and 200", async () => {
    const budget = makeBudget();
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { source = c; } });
    let terminalStatus = 0;

    const stream = nativeChatSse(body, {
      requestedModel: "mock/test-model",
      translatorBudget: budget,
      signal: abort.signal,
      stallTimeoutSec: 1,
      onUsage() {},
      onTerminal(status) { terminalStatus = status; },
    });

    const outputPromise = new Response(stream).text();
    const chunk = JSON.stringify({ choices: [{ delta: { content: "Partial text output" } }] });
    source.enqueue(encoder.encode(`data: ${chunk}\n\n`));
    source.close();

    const result = await outputPromise;
    budget.dispose();

    expect(result).toContain("Partial text output");
    expect(result).toContain("data: [DONE]");
    expect(result).not.toContain("upstream_sse_truncated");
    expect(terminalStatus).toBe(200);
  });

  test("reasoning-only stream without terminal event recovers gracefully with [DONE] and 200", async () => {
    const budget = makeBudget();
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { source = c; } });
    let terminalStatus = 0;

    const stream = nativeChatSse(body, {
      requestedModel: "mock/test-model",
      translatorBudget: budget,
      signal: abort.signal,
      stallTimeoutSec: 1,
      onUsage() {},
      onTerminal(status) { terminalStatus = status; },
    });

    const outputPromise = new Response(stream).text();
    const reasoningChunk = JSON.stringify({ choices: [{ delta: { reasoning_content: "Internal chain of thought" } }] });
    source.enqueue(encoder.encode(`data: ${reasoningChunk}\n\n`));
    source.close();

    const result = await outputPromise;
    budget.dispose();

    expect(result).toContain("Internal chain of thought");
    expect(result).toContain("data: [DONE]");
    expect(result).not.toContain("upstream_sse_truncated");
    expect(terminalStatus).toBe(200);
  });

  test("mixed text and tool-call stream fails closed prioritizing tool call safety", async () => {
    const budget = makeBudget();
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { source = c; } });
    let terminalStatus = 0;

    const stream = nativeChatSse(body, {
      requestedModel: "mock/test-model",
      translatorBudget: budget,
      signal: abort.signal,
      stallTimeoutSec: 1,
      onUsage() {},
      onTerminal(status) { terminalStatus = status; },
    });

    const outputPromise = new Response(stream).text();
    const textChunk = JSON.stringify({ choices: [{ delta: { content: "Thinking and calling a tool..." } }] });
    const toolChunk = JSON.stringify({
      choices: [{ delta: { tool_calls: [{ id: "call_abc", function: { name: "calculator", arguments: '{"expr":' } }] } }],
    });
    source.enqueue(encoder.encode(`data: ${textChunk}\n\n`));
    source.enqueue(encoder.encode(`data: ${toolChunk}\n\n`));
    source.close();

    const result = await outputPromise;
    budget.dispose();

    expect(result).toContain("upstream_sse_truncated");
    expect(terminalStatus).toBe(502);
  });

  test("tool-call stream without terminal event fails closed with upstream_sse_truncated", async () => {
    const budget = makeBudget();
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { source = c; } });
    let terminalStatus = 0;

    const stream = nativeChatSse(body, {
      requestedModel: "mock/test-model",
      translatorBudget: budget,
      signal: abort.signal,
      stallTimeoutSec: 1,
      onUsage() {},
      onTerminal(status) { terminalStatus = status; },
    });

    const outputPromise = new Response(stream).text();
    const toolPayload = JSON.stringify({
      choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "search", arguments: '{"q":' } }] } }],
    });
    source.enqueue(encoder.encode(`data: ${toolPayload}\n\n`));
    source.close();

    const result = await outputPromise;
    budget.dispose();

    expect(result).toContain("upstream_sse_truncated");
    expect(terminalStatus).toBe(502);
  });

  test("standard stream with finish_reason but no [DONE] continues to recover with [DONE] and 200", async () => {
    const budget = makeBudget();
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { source = c; } });
    let terminalStatus = 0;

    const stream = nativeChatSse(body, {
      requestedModel: "mock/test-model",
      translatorBudget: budget,
      signal: abort.signal,
      stallTimeoutSec: 1,
      onUsage() {},
      onTerminal(status) { terminalStatus = status; },
    });

    const outputPromise = new Response(stream).text();
    const finishedChunk = JSON.stringify({ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] });
    source.enqueue(encoder.encode(`data: ${finishedChunk}\n\n`));
    source.close();

    const result = await outputPromise;
    budget.dispose();

    expect(result).toContain("Done");
    expect(result).toContain("data: [DONE]");
    expect(terminalStatus).toBe(200);
  });

  test("zero-output stream without terminal event fails closed with upstream_sse_truncated", async () => {
    const budget = makeBudget();
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { source = c; } });
    let terminalStatus = 0;

    const stream = nativeChatSse(body, {
      requestedModel: "mock/test-model",
      translatorBudget: budget,
      signal: abort.signal,
      stallTimeoutSec: 1,
      onUsage() {},
      onTerminal(status) { terminalStatus = status; },
    });

    const outputPromise = new Response(stream).text();
    source.close();

    const result = await outputPromise;
    budget.dispose();

    expect(result).toContain("upstream_sse_truncated");
    expect(terminalStatus).toBe(502);
  });
});
