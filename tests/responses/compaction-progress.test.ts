import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const encoder = new TextEncoder();
const provider = { adapter: "openai-responses", baseUrl: "https://gateway.example/v1", authMode: "key" as const };
const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const completed = {
  type: "response.completed",
  response: {
    id: "resp_compaction",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Final summary" }] }],
  },
};

function upstream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let nextRead = Promise.withResolvers<void>();
  let ended = false;
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() { pulls++; nextRead.resolve(); },
    cancel() { ended = true; cancelled = true; },
  }, { highWaterMark: 0 });
  return {
    body,
    get pulls() { return pulls; },
    get cancelled() { return cancelled; },
    waitingForRead: () => nextRead.promise,
    send(text: string) {
      nextRead = Promise.withResolvers<void>();
      controller.enqueue(encoder.encode(text));
    },
    close() { if (!ended) { ended = true; controller.close(); } },
  };
}

function bridged() {
  const source = upstream();
  const budget = createTestTranslatorBudget();
  let beat = () => {};
  let cleanupCalls = 0;
  const stream = bridgeToResponsesSSE(
    createResponsesPassthroughAdapter(provider).parseStream(new Response(source.body), budget),
    "example-model", undefined, undefined, undefined,
    () => { cleanupCalls++; source.close(); }, 500,
    {
      translatorBudget: budget, compaction: true, stallTimeoutSec: 1,
      timers: {
        setInterval(callback) { beat = callback; return 1; },
        clearInterval() { beat = () => {}; },
      },
    },
  );
  const text = new Response(stream).text();
  return {
    source, text,
    get cleanupCalls() { return cleanupCalls; },
    tick: () => beat(),
    async send(text: string) {
      await source.waitingForRead();
      source.send(text);
      // The next upstream read occurs after the bridge consumes any adapter heartbeat.
      await source.waitingForRead();
    },
  };
}

describe("buffered Responses compaction progress", () => {
  // Codex oracle: openai/codex d2d5b702, codex-api/src/sse/responses.rs:367-408.
  // Indices make these canonical reasoning fixtures; progress itself carries no content.
  for (const delta of [
    { type: "response.output_text.delta", delta: "Buffered progress" },
    { type: "response.reasoning_summary_text.delta", delta: "Buffered progress", summary_index: 0 },
    { type: "response.reasoning_text.delta", delta: "Buffered progress", content_index: 0 },
  ]) {
    test(`${delta.type} prevents stall before terminal without exposing partial content`, async () => {
      const h = bridged();
      try {
        for (let i = 0; i < 6; i++) {
          await h.send(frame(delta));
          h.tick();
          expect(h.cleanupCalls).toBe(0);
        }
        await h.send(frame(completed));
        h.source.close();
        const wire = await h.text;
        expect(wire.match(/event: response.completed\n/g)).toHaveLength(1);
        expect(wire.match(/event: response.output_item.done\n/g)).toHaveLength(1);
        expect(wire).toContain('"type":"compaction"');
        expect(wire).not.toContain("Buffered progress");
        expect(wire).not.toContain("event: response.output_text.delta");
        expect(wire).not.toContain("upstream_stall_timeout");
        // The bridge invokes its upstream cleanup callback on normal terminal events too.
        expect(h.cleanupCalls).toBe(1);
      } finally { h.source.close(); await h.text; }
    });
  }

  test("comments, typed keepalives and empty or malformed deltas do not reset stall", async () => {
    const h = bridged();
    try {
      const noise = ": keep-alive\n\ndata: invalid-json\n\n"
        + frame({ type: "response.heartbeat" })
        + frame({ type: "response.output_text.delta", delta: "" })
        + frame({ type: "response.reasoning_summary_text.delta", delta: null })
        + frame({ type: "response.reasoning_text.delta", delta: 42 })
        + frame({ type: "response.unknown.delta", delta: "not recognized progress" });
      await h.send(noise);
      h.tick();
      await h.send(noise);
      h.tick();
      const wire = await h.text;
      expect(wire).toContain("upstream_stall_timeout");
      expect(wire).not.toContain("event: response.completed");
      expect(wire).not.toContain('"type":"compaction"');
      expect(h.cleanupCalls).toBe(1);
    } finally { h.source.close(); await h.text; }
  });

  test("progress preserves snapshot precedence, usage and native ciphertext", async () => {
    const budget = createTestTranslatorBudget();
    const ciphertext = "gAAAAABm-native-compaction-ciphertext";
    const usage = { input_tokens: 12, output_tokens: 4, total_tokens: 16, gateway_metadata: { cached: true } };
    const terminal = {
      ...completed,
      response: { ...completed.response, usage, output: [
        ...completed.response.output, { type: "compaction", encrypted_content: ciphertext },
      ] },
    };
    const input = frame({ type: "response.output_text.delta", delta: "Partial text" })
      + frame({ type: "response.output_text.done", text: "Done text" })
      + frame(terminal)
      + frame({ type: "response.output_text.delta", delta: "Late text" });
    const events: AdapterEvent[] = [];
    for await (const event of createResponsesPassthroughAdapter(provider).parseStream(new Response(input), budget)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "heartbeat" },
      { type: "text_delta", text: "Final summary" },
      { type: "done", usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, rawUsage: usage }, compactionEncryptedContent: ciphertext },
    ]);
    const result = buildResponseJSON(events, "example-model", { compaction: true, translatorBudget: budget });
    expect(result.output).toEqual([expect.objectContaining({ type: "compaction", encrypted_content: ciphertext })]);
  });

  test("reasoning progress with ciphertext-only completion does not manufacture summary text", async () => {
    const budget = createTestTranslatorBudget();
    const ciphertext = "gAAAAABm-ciphertext-only";
    const input = frame({ type: "response.reasoning_text.delta", content_index: 0, delta: "Hidden reasoning" })
      + frame({ ...completed, response: {
        ...completed.response, output: [{ type: "compaction", encrypted_content: ciphertext }],
      } });
    const events: AdapterEvent[] = [];
    for await (const event of createResponsesPassthroughAdapter(provider).parseStream(new Response(input), budget)) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "heartbeat" }, { type: "done", compactionEncryptedContent: ciphertext }]);
    expect(budget.snapshot().currentBytes).toBe(encoder.encode(ciphertext).byteLength);
    const result = buildResponseJSON(events, "example-model", { compaction: true, translatorBudget: budget });
    expect(result.output).toEqual([expect.objectContaining({ type: "compaction", encrypted_content: ciphertext })]);
  });

  test("a suspended heartbeat does not read ahead and return cancels the reader", async () => {
    const source = upstream();
    const budget = createTestTranslatorBudget();
    const iterator = createResponsesPassthroughAdapter(provider).parseStream(new Response(source.body), budget);
    try {
      source.send(frame({ type: "response.reasoning_text.delta", content_index: 0, delta: "Hidden reasoning" }).repeat(64));
      expect(await iterator.next()).toEqual({ done: false, value: { type: "heartbeat" } });
      expect(source.pulls).toBe(0); // Only the already-enqueued chunk was consumed (HWM 0).
      for (let i = 1; i < 64; i++) {
        expect(await iterator.next()).toEqual({ done: false, value: { type: "heartbeat" } });
        expect(source.pulls).toBe(0);
      }
      await iterator.return(undefined);
      expect(source.cancelled).toBe(true);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { source.close(); await iterator.return(undefined); }
  });

  for (const type of ["response.failed", "response.incomplete"]) {
    test(`${type} after progress never flushes a successful summary`, async () => {
      const budget = createTestTranslatorBudget();
      const events: AdapterEvent[] = [];
      const input = frame({ type: "response.output_text.delta", delta: "Unfinished summary" })
        + frame({ type, response: type === "response.failed"
          ? { error: { message: "stopped" } }
          : { incomplete_details: { reason: "stopped" } } });
      for await (const event of createResponsesPassthroughAdapter(provider).parseStream(new Response(input), budget)) {
        events.push(event);
      }
      expect(events).toEqual([
        { type: "heartbeat" },
        type === "response.failed" ? { type: "error", message: "stopped" } : { type: "incomplete", reason: "stopped" },
      ]);
    });
  }
});
