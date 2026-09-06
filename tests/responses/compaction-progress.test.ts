import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { bridgeToResponsesSSE } from "../../src/bridge";
import { createTranslatorBudget } from "../../src/lib/translator-budget";

const encoder = new TextEncoder();
const provider = { adapter: "openai-responses", baseUrl: "https://gateway.example/v1", authMode: "key" as const };
const completed = {
  type: "response.completed",
  response: {
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Final summary" }] }],
  },
};
const frame = (payload: unknown) => "data: " + JSON.stringify(payload) + "\n\n";

function harness() {
  const budget = createTranslatorBudget();
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  let beat = () => {};
  const close = () => {
    if (!ended) { ended = true; upstream.close(); }
  };
  const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
  const adapter = createResponsesPassthroughAdapter(provider);
  const stream = bridgeToResponsesSSE(
    adapter.parseStream(new Response(body), budget), "example-model", undefined, undefined, undefined,
    close, 500,
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
    text, close,
    send(value: string) { if (!ended) upstream.enqueue(encoder.encode(value)); },
    async tick() {
      // Finish each pending adapter read before the manual watchdog beat.
      await Bun.sleep(0);
      beat();
      await Bun.sleep(0);
    },
  };
}

describe("buffered Responses compaction progress", () => {
  for (const type of ["response.output_text.delta", "response.reasoning_summary_text.delta", "response.reasoning_text.delta"]) {
    test(type + " keeps compaction alive without exposing buffered content", async () => {
      const h = harness();
      try {
        for (let i = 0; i < 6; i++) {
          h.send(frame({ type, delta: "Buffered progress" }));
          await h.tick();
        }
        h.send(frame(completed));
        h.close();
        const wire = await h.text;
        expect(wire).toContain("event: response.completed");
        expect(wire).toContain('"type":"compaction"');
        expect(wire).not.toContain("upstream_stall_timeout");
        expect(wire).not.toContain("Buffered progress");
        expect(wire).not.toContain("event: response.output_text.delta");
      } finally { h.close(); }
    });
  }

  test("comment keepalives and empty or malformed deltas cannot hide a stalled provider", async () => {
    const h = harness();
    try {
      for (let i = 0; i < 6; i++) {
        h.send(": keep-alive\n\n" + frame({ type: "response.output_text.delta", delta: "" })
          + frame({ type: "response.reasoning_text.delta", delta: 42 }));
        await h.tick();
      }
      h.close();
      const wire = await h.text;
      expect(wire).toContain("upstream_stall_timeout");
      expect(wire).not.toContain("event: response.completed");
    } finally { h.close(); }
  });

  test("progress does not duplicate buffered text or override the completed snapshot", async () => {
    const budget = createTranslatorBudget();
    try {
      const input = frame({ type: "response.output_text.delta", delta: "Partial text" })
        + frame({ type: "response.output_text.done", text: "Done text" }) + frame(completed);
      const events = [];
      for await (const event of createResponsesPassthroughAdapter(provider).parseStream(new Response(input), budget)) events.push(event);
      expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "Final summary" }]);
      expect(events.filter(event => event.type === "done")).toHaveLength(1);
    } finally { budget.dispose(); }
  });
});
