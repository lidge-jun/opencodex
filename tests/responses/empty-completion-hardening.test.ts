import { describe, expect, test } from "bun:test";
import {
  EMPTY_COMPLETION_MAX_BUFFERED_BYTES,
  EMPTY_COMPLETION_MAX_BUFFERED_EVENTS,
  guardEmptyCompletionEventStream,
} from "../../src/server/responses/empty-completion-guard";
import type { AdapterEvent } from "../../src/types";
import { guardOpenGatewayCompletion } from "../../src/server/responses/opengateway-completion-guard";

async function collect(source: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function eventsOf(...items: AdapterEvent[]): AsyncIterable<AdapterEvent> {
  return (async function* () { yield* items; })();
}

describe("OpenGateway native replay safety", () => {
  const empty = { id: "resp_1", object: "response", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1 } };
  const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  const terminal = { type: "response.completed", response: empty };
  const response = (...events: unknown[]) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const event of events) controller.enqueue(encode(event)); controller.close(); },
  }), { headers: { "content-type": "text/event-stream" } });
  async function run(source: Response, extra: Record<string, unknown> = {}, signal = new AbortController().signal, timeoutMs = 1000) {
    let retries = 0;
    const result = await guardOpenGatewayCompletion(source, {
      url: "https://apis.opengateway.ai/v1/responses", body: { stream: true, store: false, input: "question", ...extra },
      signal, holdTimeoutMs: timeoutMs, recordUsage() {}, retry: async () => { retries++; return response(terminal); },
    });
    return { result, retries: () => retries };
  }

  for (const output of [
    [{ type: "message", content: [{ type: "output_text", text: "answer" }] }],
    [{ type: "message", content: [{ type: "refusal", refusal: "declined" }] }],
    [{ type: "function_call", call_id: "call_1", name: "test", arguments: "{}" }],
    [{ type: "web_search_call", status: "completed" }],
    [{ type: "mcp_call", name: "external_action" }],
  ]) {
    test(`meaningful ${output[0]?.type} output remains byte-identical without retry`, async () => {
      const event = { type: "response.completed", response: { ...empty, output } };
      const source = response(event), expected = await source.clone().text();
      const f = await run(source);
      expect(await f.result.text()).toBe(expected);
      expect(f.retries()).toBe(0);
    });
  }

  for (const event of [
    { type: "response.future_action", value: "unknown" },
    { type: "response.heartbeat", replayUnsafe: true },
    { type: "response.output_item.added", output_index: 0, item: { type: "future_tool" } },
    { type: "response.created", response: { ...empty, output: [{ type: "future_tool" }] } },
  ]) {
    test(`unknown or unsafe ${event.type} cannot authorize replay`, async () => {
      const f = await run(response(event, terminal));
      const text = await f.result.text();
      expect(text).toContain(JSON.stringify(event));
      expect(text).toContain('"type":"response.completed"');
      expect(f.retries()).toBe(0);
    });
  }

  test("a tool already emitted remains meaningful even when the final output is empty", async () => {
    const event = { type: "response.output_item.done", output_index: 0, item: { type: "function_call", name: "test", call_id: "call_1", arguments: "{}" } };
    const source = response(event, terminal), expected = await source.clone().text();
    const f = await run(source);
    expect(await f.result.text()).toBe(expected);
    expect(f.retries()).toBe(0);
  });

  for (const extra of [{ tools: [{ type: "mcp" }] }, { tools: [{ type: "web_search" }] }, { store: true }, { store: undefined }, { previous_response_id: "resp_old" }, { background: true }]) {
    test(`request-side replay hazard ${Object.keys(extra)[0]} refuses an empty completion`, async () => {
      const f = await run(response(terminal), extra);
      expect(await f.result.text()).toContain('"type":"response.failed"');
      expect(f.retries()).toBe(0);
    });
  }

  test("reasoning alone is not a delivered answer", async () => {
    const f = await run(response({ type: "response.reasoning_summary_text.delta", delta: "reasoning" }, terminal));
    expect(await f.result.text()).toContain("empty_completion_retry_failed");
    expect(f.retries()).toBe(1);
  });

  test("the event bound releases the original stream and forbids replay", async () => {
    const f = await run(response(...Array.from({ length: EMPTY_COMPLETION_MAX_BUFFERED_EVENTS + 1 }, () => ({ type: "response.heartbeat" })), terminal));
    expect(await f.result.text()).toContain('"type":"response.completed"');
    expect(f.retries()).toBe(0);
  });

  test("the byte bound releases the prefix and forbids replay", async () => {
    const reasoning = { type: "response.reasoning_summary_text.delta", delta: "x".repeat(600_000) };
    const f = await run(response(reasoning, reasoning, terminal));
    const text = await f.result.text();
    expect(text).toContain(reasoning.delta);
    expect(text).toContain('"type":"response.completed"');
    expect(f.retries()).toBe(0);
  });

  test("the hold deadline flushes a quiet prefix without cancelling a healthy source", async () => {
    let cancelled = false;
    const sourceController = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const source = new Response(new ReadableStream<Uint8Array>({
      start(controller) { sourceController.resolve(controller); controller.enqueue(encode({ type: "response.created" })); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }), { headers: { "content-type": "text/event-stream" } });
    const f = await run(source, {}, undefined, 10);
    const reader = f.result.body?.getReader();
    if (!reader) throw new Error("fixture body missing");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("response.created");
    expect(cancelled).toBe(false);
    const controller = await sourceController.promise;
    controller.enqueue(encode(terminal));
    controller.close();
    const tail: Uint8Array[] = [];
    for (;;) { const next = await reader.read(); if (next.done) break; tail.push(next.value); }
    expect(new TextDecoder().decode(Buffer.concat(tail))).toContain('"type":"response.completed"');
    reader.releaseLock();
    expect(f.retries()).toBe(0);
  });

  test("abort during a pending read cancels upstream and never retries", async () => {
    let cancelled = false;
    const reading = Promise.withResolvers<void>();
    const source = new Response(new ReadableStream<Uint8Array>({
      pull() { reading.resolve(); }, cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    const abort = new AbortController();
    const guarded = run(source, {}, abort.signal);
    await reading.promise;
    abort.abort(new DOMException("cancel", "AbortError"));
    const f = await guarded;
    const caught = f.result.text().catch(error => error);
    expect(await caught).toBe(abort.signal.reason);
    expect(cancelled).toBe(true);
    expect(f.retries()).toBe(0);
  });

  test("cancellation before the first pull releases the untouched source", async () => {
    let cancelled = false;
    const source = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }),
      { headers: { "content-type": "text/event-stream" } });
    const f = await run(source);
    await f.result.body?.cancel();
    expect(cancelled).toBe(true);
    expect(f.retries()).toBe(0);
  });

  for (const output of [[], [{ id: "msg_1", type: "message", role: "assistant", content: [] }]]) {
    test(`an empty ${output.length ? "message" : "output array"} stays byte-identical after text`, async () => {
      const source = response(
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "원문" },
        { ...terminal, response: { ...empty, output } },
      );
      const expected = await source.clone().text();
      const f = await run(source);
      const text = await f.result.text();
      expect(text).toBe(expected);
      expect(f.retries()).toBe(0);
    });
  }

  test("contradictory item identity stays byte-identical after the first delta", async () => {
    const source = response(
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "원문" },
      { ...terminal, response: { ...empty, output: [{ id: "different", type: "message", content: [{ type: "output_text", text: "" }] }] } },
    );
    const expected = await source.clone().text();
    const f = await run(source);
    const text = await f.result.text();
    expect(text).toBe(expected);
    expect(f.retries()).toBe(0);
  });

  test("fragmented UTF-8 and CRLF framing preserves normal text", async () => {
    const wire = `data: ${JSON.stringify({ ...terminal, response: { ...empty, output: [{ type: "message", content: [{ type: "output_text", text: "한글" }] }] } })}\r\n\r\n`;
    const source = new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of new TextEncoder().encode(wire)) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    }), { headers: { "content-type": "text/event-stream" } });
    const f = await run(source);
    expect(await f.result.text()).toContain('"text":"한글"');
    expect(f.retries()).toBe(0);
  });

  for (const snapshot of [{}, { status: "completed" }, { ...empty, id: "" }, { ...empty, object: undefined }, { ...empty, output: undefined }]) {
    test(`malformed terminal ${JSON.stringify(snapshot)} never retries`, async () => {
      const f = await run(response({ type: "response.completed", response: snapshot }));
      expect(await f.result.text()).toContain('"type":"response.failed"');
      expect(f.retries()).toBe(0);
    });
  }

  test("an empty refusal is a replay barrier", async () => {
    const event = { ...terminal, response: { ...empty, output: [{ type: "message", content: [{ type: "refusal", refusal: "" }] }] } };
    const source = response(event), expected = await source.clone().text();
    const f = await run(source);
    expect(await f.result.text()).toBe(expected);
    expect(f.retries()).toBe(0);
  });

  test("partial terminal output is byte-identical after two text parts", async () => {
    const source = response(
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "first" },
      { type: "response.output_text.delta", output_index: 0, content_index: 1, item_id: "msg_1", delta: "second" },
      { ...terminal, response: { ...empty, output: [{ id: "msg_1", type: "message", content: [{ type: "output_text", text: "first" }] }] } },
    );
    const expected = await source.clone().text(), f = await run(source);
    expect(await f.result.text()).toBe(expected);
    expect(f.retries()).toBe(0);
  });

  for (const status of [401, 403, 429, 503]) {
    test(`retry HTTP ${status} keeps the original response and headers`, async () => {
      const refusal = Response.json({ error: { code: "original_failure", message: "fixture" } },
        { status, headers: { "retry-after": "9", "x-should-retry": "false" } });
      let retries = 0;
      const result = await guardOpenGatewayCompletion(response(terminal), {
        url: "https://apis.opengateway.ai/v1/responses", body: { stream: true, store: false, input: "question" },
        signal: new AbortController().signal, recordUsage() {}, retry: async () => { retries++; return refusal; },
      });
      expect(result).toBe(refusal);
      expect(result.status).toBe(status);
      expect(result.headers.get("retry-after")).toBe("9");
      expect((await result.json()).error.code).toBe("original_failure");
      expect(retries).toBe(1);
    });
  }

  test("post-content silence is not governed by the prefix hold deadline", async () => {
    const control = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    let cancelled = false;
    const delta = { type: "response.output_text.delta", delta: "answer" };
    const source = new Response(new ReadableStream<Uint8Array>({
      start(controller) { control.resolve(controller); controller.enqueue(encode(delta)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    const f = await run(source, {}, undefined, 10);
    const reader = f.result.body?.getReader();
    if (!reader) throw new Error("fixture body missing");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(new TextDecoder().decode(encode(delta)));
    const tail = reader.read();
    const controller = await control.promise;
    const timer = setTimeout(() => { controller.enqueue(encode(terminal)); controller.close(); }, 25);
    try {
      expect(new TextDecoder().decode((await tail).value)).toBe(new TextDecoder().decode(encode(terminal)));
      expect((await reader.read()).done).toBe(true);
      expect(cancelled).toBe(false);
      expect(f.retries()).toBe(0);
    } finally { clearTimeout(timer); reader.releaseLock(); }
  });

  test("configured stall timeout remains active and cancels a hanging source", async () => {
    let cancelled = false;
    const source = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }), { headers: { "content-type": "text/event-stream" } });
    const result = await guardOpenGatewayCompletion(source, {
      url: "https://apis.opengateway.ai/v1/responses", body: { stream: true, store: false, input: "question" },
      signal: new AbortController().signal, holdTimeoutMs: 1000, stallTimeoutMs: 10,
      recordUsage() {}, retry: async () => { throw new Error("unexpected retry"); },
    });
    await expect(result.text()).rejects.toHaveProperty("name", "TimeoutError");
    expect(cancelled).toBe(true);
  });

  test("a replay-unsafe terminal passes through without replay", async () => {
    const source = response({ ...terminal, replayUnsafe: true }), expected = await source.clone().text();
    const f = await run(source);
    expect(await f.result.text()).toBe(expected);
    expect(f.retries()).toBe(0);
  });

  test("JSON above the inspection byte cap is returned unchanged", async () => {
    const source = Response.json({ ...empty, output: [{ type: "message", content: [{ type: "output_text", text: "x".repeat(EMPTY_COMPLETION_MAX_BUFFERED_BYTES + 1) }] }] });
    const expected = await source.clone().text(), f = await run(source);
    expect(await f.result.text()).toBe(expected);
    expect(f.retries()).toBe(0);
  });
});

describe("empty-completion guard hardening", () => {
  // #6876: Vertex fails a turn with MALFORMED_FUNCTION_CALL after dropping the model's only call.
  const malformed = (usage?: { inputTokens: number; outputTokens: number }): AdapterEvent => ({
    type: "error",
    message: "Vertex AI response truncated upstream before the turn completed (MALFORMED_FUNCTION_CALL)",
    replaySafeBeforeOutput: true,
    ...(usage ? { usage } : {}),
  });

  test("a replay-safe error before any output retries the identical turn once", async () => {
    let continuations = 0;
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf({ type: "thinking_delta", thinking: "plan" }, malformed({ inputTokens: 10, outputTokens: 0 })),
      continuation: () => {
        continuations += 1;
        return eventsOf({ type: "text_delta", text: "answer" }, { type: "done", usage: { inputTokens: 10, outputTokens: 3 } });
      },
    }));
    expect(continuations).toBe(1);
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 20, outputTokens: 3 } });
  });

  test("a replay-safe error that repeats surfaces its own message after one retry", async () => {
    let continuations = 0;
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(malformed({ inputTokens: 10, outputTokens: 0 })),
      continuation: () => {
        continuations += 1;
        return eventsOf(malformed({ inputTokens: 10, outputTokens: 0 }));
      },
    }));
    expect(continuations).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("MALFORMED_FUNCTION_CALL"),
      usage: { inputTokens: 20, outputTokens: 0 },
    });
  });

  test("a replay-safe error after output passes through without a retry", async () => {
    let continuations = 0;
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf({ type: "text_delta", text: "partial" }, malformed()),
      continuation: () => {
        continuations += 1;
        return eventsOf({ type: "done" });
      },
    }));
    expect(continuations).toBe(0);
    expect(events.map(event => event.type)).toEqual(["text_delta", "error"]);
  });

  test("an ordinary pre-output error is still not retried", async () => {
    let continuations = 0;
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf({ type: "error", message: "upstream 500", status: 500 }),
      continuation: () => {
        continuations += 1;
        return eventsOf({ type: "done" });
      },
    }));
    expect(continuations).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "error", message: "upstream 500" });
  });

  test("usage keeps the retry's absolute context checkpoint without summing it", async () => {
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "done", usage: { inputTokens: 10, outputTokens: 0, contextTotalTokens: 1_000 } },
      ),
      continuation: () => eventsOf(
        { type: "text_delta", text: "answer" },
        { type: "done", usage: { inputTokens: 12, outputTokens: 2, contextTotalTokens: 1_014 } },
      ),
    }));

    expect(events.at(-1)).toMatchObject({
      type: "done",
      usage: { inputTokens: 22, outputTokens: 2, totalTokens: 24, contextTotalTokens: 1_014 },
    });
  });

  test("inherited Object prototype stop-reason names do not bypass retry", async () => {
    for (const stopReason of ["constructor", "toString"]) {
      let continuations = 0;
      await collect(guardEmptyCompletionEventStream({
        firstEvents: eventsOf({ type: "done", stopReason }),
        continuation: () => {
          continuations += 1;
          return eventsOf({ type: "text_delta", text: "ok" }, { type: "done" });
        },
      }));
      expect(continuations).toBe(1);
    }
  });

  test("buffered reasoning emits liveness heartbeats until content is released", async () => {
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "thinking_delta", thinking: "one" },
        { type: "reasoning_raw_delta", text: "two" },
        { type: "text_delta", text: "answer" },
        { type: "done" },
      ),
      continuation: () => eventsOf(),
    }));

    expect(events.map(event => event.type)).toEqual([
      "heartbeat",
      "heartbeat",
      "thinking_delta",
      "reasoning_raw_delta",
      "text_delta",
      "done",
    ]);
  });

  test("event-count overflow releases the prefix and disables retry for the turn", async () => {
    let continuations = 0;
    const reasoning = Array.from({ length: EMPTY_COMPLETION_MAX_BUFFERED_EVENTS + 1 }, (_, index) => ({
      type: "thinking_delta" as const,
      thinking: `r${index}`,
    }));
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(...reasoning, { type: "done" }),
      continuation: () => {
        continuations += 1;
        return eventsOf();
      },
    }));

    expect(continuations).toBe(0);
    expect(events.filter(event => event.type === "thinking_delta")).toHaveLength(reasoning.length);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("byte overflow remains bounded across the retry attempt", async () => {
    let continuations = 0;
    const firstBytes = "a".repeat(Math.floor(EMPTY_COMPLETION_MAX_BUFFERED_BYTES / 2));
    const retryBytes = "b".repeat(Math.floor(EMPTY_COMPLETION_MAX_BUFFERED_BYTES / 2) + 1_024);
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "thinking_delta", thinking: firstBytes },
        { type: "done", usage: { inputTokens: 3, outputTokens: 0 } },
      ),
      continuation: () => {
        continuations += 1;
        return eventsOf(
          { type: "reasoning_raw_delta", text: retryBytes },
          { type: "done", usage: { inputTokens: 4, outputTokens: 0 } },
        );
      },
    }));

    expect(continuations).toBe(1);
    expect(events.filter(event => event.type === "thinking_delta")).toHaveLength(1);
    expect(events.filter(event => event.type === "reasoning_raw_delta")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 },
    });
  });

  test("post-retry errors and incompletes after content keep usage from both attempts", async () => {
    const retryTerminal = async (terminal: AdapterEvent) => collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf({ type: "done", usage: { inputTokens: 5, outputTokens: 0 } }),
      continuation: () => eventsOf(
        { type: "text_delta", text: "partial" },
        terminal,
      ),
    }));

    const error = await retryTerminal({
      type: "error",
      status: 499,
      message: "client closed",
      usage: { inputTokens: 7, outputTokens: 2 },
    });
    expect(error.at(-1)).toMatchObject({
      type: "error",
      status: 499,
      usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
    });

    const incomplete = await retryTerminal({
      type: "incomplete",
      reason: "upstream_stall_timeout",
      usage: { inputTokens: 9, outputTokens: 3 },
    });
    expect(incomplete.at(-1)).toMatchObject({
      type: "incomplete",
      usage: { inputTokens: 14, outputTokens: 3, totalTokens: 17 },
    });
  });
});
