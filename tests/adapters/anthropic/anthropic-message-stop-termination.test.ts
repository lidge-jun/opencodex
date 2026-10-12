import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { createTranslatorBudget, type TranslatorBudget } from "../../../src/lib/translator-budget";
import { parseStreamWithProgress } from "../../../src/web-search/progress-stream";
import type { AdapterEvent, OcxProviderConfig } from "../../../src/types";

const provider: OcxProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://example.invalid/v1",
  authMode: "key",
  apiKey: "synthetic-not-used",
};

const frame = (type: string, data: Record<string, unknown> = {}): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const usage = { inputTokens: 2, outputTokens: 3 };

function turn(stopReason: string | undefined = "end_turn"): string {
  return frame("message_start", { message: { usage: { input_tokens: 2 } } })
    + frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    + frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } })
    + frame("content_block_stop", { index: 0 })
    + frame("message_delta", { delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } })
    + frame("message_stop");
}

function stream(response: Response, budget: TranslatorBudget, wrapped: boolean): AsyncGenerator<AdapterEvent> {
  const adapter = createAnthropicAdapter(provider);
  return wrapped
    ? parseStreamWithProgress(response, adapter.parseStream.bind(adapter), {
        inactivityTimeoutMs: 1_000,
        postTerminalDrainTimeoutMs: 200,
        translatorBudget: budget,
      })
    : adapter.parseStream(response, budget);
}

async function collect(events: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const output: AdapterEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

function expectReleased(budget: TranslatorBudget, overflows = 0): void {
  // Check before dispose(): disposal would conceal a missing parser release.
  expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0, overflows });
}

const tails = [
  ["no tail", ""],
  ["named ping", frame("ping")],
  ["data-only ping", 'data: {"type":"ping"}\n\n'],
  ["comment", ": keepalive\n\n"],
  ["late text", frame("content_block_delta", { delta: { type: "text_delta", text: "late" } })],
  ["late error", frame("error", { error: { message: "late failure" } })],
  ["duplicate message_stop", frame("message_stop")],
];

function openResponse(wire: string, rejectCancel = false) {
  const probe = { pulls: 0, cancels: 0 };
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      // An unfixed adapter eventually reaches EOF instead of hanging the test forever.
      timer = setTimeout(() => { try { controller.close(); } catch { /* already closed */ } }, 1_000);
    },
    pull(value) {
      probe.pulls++;
      if (probe.pulls === 1) value.enqueue(new TextEncoder().encode(wire));
      // Deliberately stay open without additional bytes.
    },
    cancel() {
      probe.cancels++;
      clearTimeout(timer);
      if (rejectCancel) return Promise.reject(new Error("synthetic cancel failure"));
    },
  }, { highWaterMark: 0 });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    body,
    probe,
    cleanup() {
      clearTimeout(timer);
      try { controller.close(); } catch { /* already closed */ }
    },
  };
}

describe("Anthropic message_stop termination (#6766)", () => {
  test.each(tails)("direct parser stops before %s", async (_name, tail) => {
    const budget = createTranslatorBudget();
    try {
      const events = await collect(stream(new Response(turn() + tail), budget, false));
      expect(events).toEqual([
        { type: "text_delta", text: "ok" },
        { type: "done", usage, stopReason: "end_turn" },
      ]);
      expectReleased(budget);
    } finally { budget.dispose(); }
  });

  test.each(tails)("progress collector completes before %s", async (_name, tail) => {
    const budget = createTranslatorBudget();
    try {
      const events = await collect(stream(new Response(turn() + tail), budget, true));
      // Raw-byte progress may add heartbeats before the validated terminal.
      expect(events.filter(event => event.type !== "heartbeat")).toEqual([
        { type: "text_delta", text: "ok" },
        { type: "done", usage, stopReason: "end_turn" },
      ]);
      expect(events.at(-1)?.type).toBe("done");
      expectReleased(budget);
    } finally { budget.dispose(); }
  });

  test("keeps named ping, data-only ping and comment heartbeats before message_stop", async () => {
    const budget = createTranslatorBudget();
    try {
      const wire = frame("ping") + 'data: {"type":"ping"}\n\n' + ": keepalive\n\n" + turn();
      const events = await collect(stream(new Response(wire), budget, false));
      expect(events).toEqual([
        { type: "heartbeat" }, { type: "heartbeat" }, { type: "heartbeat" },
        { type: "text_delta", text: "ok" },
        { type: "done", usage, stopReason: "end_turn" },
      ]);
      expectReleased(budget);
    } finally { budget.dispose(); }
  });

  test.each(["end_turn", "max_tokens", "tool_use", "error", "refusal", "content_filter"])(
    "preserves the terminal classification and usage for %s", async stopReason => {
      const budget = createTranslatorBudget();
      try {
        const events = await collect(stream(new Response(turn(stopReason) + frame("ping")), budget, false));
        const expected: AdapterEvent = stopReason === "error"
          ? { type: "error", message: 'upstream ended the turn with stop_reason "error"',
              status: 502, errorType: "upstream_error", usage }
          : stopReason === "refusal" || stopReason === "content_filter"
          ? { type: "incomplete", reason: "content_filter", retryable: false,
              message: `upstream ended the turn with stop_reason "${stopReason}"`, usage }
          : { type: "done", stopReason, usage };
        expect(events).toEqual([{ type: "text_delta", text: "ok" }, expected]);
        expectReleased(budget);
      } finally { budget.dispose(); }
    },
  );

  test.each(["refusal", "content_filter"])("collector keeps %s non-retryable", async stopReason => {
    const budget = createTranslatorBudget();
    try {
      const events = await collect(stream(new Response(turn(stopReason) + ": keepalive\n\n"), budget, true));
      expect(events.at(-1)).toEqual({ type: "incomplete", reason: "content_filter", retryable: false,
        message: `upstream ended the turn with stop_reason "${stopReason}"`, usage });
      expect(events.filter(event => ["done", "incomplete", "error"].includes(event.type))).toHaveLength(1);
      expectReleased(budget);
    } finally { budget.dispose(); }
  });

  test("collector rejects an error stop instead of completing successfully", async () => {
    const budget = createTranslatorBudget();
    try {
      await expect(collect(stream(new Response(turn("error") + frame("ping")), budget, true)))
        .rejects.toThrow('upstream ended the turn with stop_reason "error"');
    } finally { budget.dispose(); }
  });

  test.each([false, true])("returns without upstream EOF and cancels its reader (wrapped=%s)", async wrapped => {
    const budget = createTranslatorBudget();
    const upstream = openResponse(turn());
    try {
      const events = await collect(stream(upstream.response, budget, wrapped));
      expect(events.at(-1)).toEqual({ type: "done", usage, stopReason: "end_turn" });
      expect(upstream.probe).toEqual({ pulls: 1, cancels: 1 });
      expect(upstream.body.locked).toBe(false);
      expectReleased(budget);
    } finally { upstream.cleanup(); budget.dispose(); }
  });

  test("a rejected reader cancellation does not replace the terminal outcome", async () => {
    const budget = createTranslatorBudget();
    const upstream = openResponse(turn(), true);
    try {
      const events = await collect(stream(upstream.response, budget, false));
      expect(events.at(-1)).toEqual({ type: "done", usage, stopReason: "end_turn" });
      expect(upstream.probe.cancels).toBe(1);
      expect(upstream.body.locked).toBe(false);
      expectReleased(budget);
    } finally { upstream.cleanup(); budget.dispose(); }
  });

  test("message_stop releases a still-open tool argument reservation", async () => {
    const budget = createTranslatorBudget();
    const wire = frame("content_block_start", { index: 0,
      content_block: { type: "tool_use", id: "call_6766", name: "web_search" } })
      + frame("content_block_delta", { index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"test"}' } })
      + frame("message_delta", { delta: { stop_reason: "tool_use" } })
      + frame("message_stop") + frame("ping");
    try {
      const events = await collect(stream(new Response(wire), budget, false));
      expect(events.map(event => event.type)).toEqual(["tool_call_start", "tool_call_delta", "done"]);
      // Existing behavior does not invent tool_call_end for an unclosed block.
      expect(events.at(-1)).toEqual({ type: "done", usage: undefined, stopReason: "tool_use" });
      expectReleased(budget);
    } finally { budget.dispose(); }
  });

  test("consumer return releases the decoder reader and an open call", async () => {
    const budget = createTranslatorBudget();
    const upstream = openResponse(frame("content_block_start", { index: 0,
      content_block: { type: "tool_use", id: "call_cancel", name: "web_search" } }));
    const iterator = stream(upstream.response, budget, false);
    try {
      expect((await iterator.next()).value?.type).toBe("tool_call_start");
      expect(budget.snapshot().activeCalls).toBe(1);
      await iterator.return(undefined);
      expect(upstream.probe.cancels).toBe(1);
      expect(upstream.body.locked).toBe(false);
      expectReleased(budget);
    } finally { upstream.cleanup(); budget.dispose(); }
  });

  test("pre-terminal argument overflow stays one bounded error", async () => {
    const budget = createTranslatorBudget({ maxCallArgumentBytes: 4 });
    const wire = frame("content_block_start", { index: 0,
      content_block: { type: "tool_use", id: "call_overflow", name: "web_search" } })
      + frame("content_block_delta", { index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"test"}' } })
      + frame("message_stop") + frame("ping");
    try {
      const events = await collect(stream(new Response(wire), budget, false));
      expect(events.map(event => event.type)).toEqual(["tool_call_start", "error"]);
      expect(events.at(-1)).toMatchObject({ type: "error", status: 502,
        errorType: "upstream_error", code: "translation_buffer_limit" });
      expectReleased(budget, 1);
    } finally { budget.dispose(); }
  });
});
