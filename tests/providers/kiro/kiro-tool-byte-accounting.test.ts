import { expect, spyOn, test } from "bun:test";
import { parseKiroStream } from "../../../src/adapters/kiro/stream";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import type { AdapterEvent } from "../../../src/types";

/** Exercise the real Smithy decoder and Kiro parser without a provider request. */
function responseFor(calls: string[][]): Response {
  const encoder = new TextEncoder();
  const frames = calls.flatMap((chunks, index) => [
    { name: "write_file", toolUseId: `call-${index}` },
    ...chunks.map(input => ({ input })),
    { stop: true },
  ]).map(event => encodeMessage(
    { ":message-type": "event", ":event-type": "toolUseEvent" },
    encoder.encode(JSON.stringify(event)),
  ));
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) controller.enqueue(frames[index++]);
      else controller.close();
    },
  }));
}

test("fragmented Kiro tool arguments require linear UTF-8 measurement work", async () => {
  const fragment = "x".repeat(256);
  const count = 256;
  const chunks = ['{"value":"', ...Array<string>(count).fill(fragment), '"}'];
  const response = responseFor([chunks]);
  const byteLength = Buffer.byteLength;
  let measurements = 0;
  let measuredChars = 0;
  const measuring = spyOn(Buffer, "byteLength").mockImplementation((...args: Parameters<typeof byteLength>) => {
    if (args[0] === fragment) measurements++;
    if (typeof args[0] === "string") measuredChars += args[0].length;
    return Reflect.apply(byteLength, Buffer, args);
  });
  const budget = createTranslatorBudget();
  const events: AdapterEvent[] = [];
  try {
    for await (const event of parseKiroStream(response, budget)) events.push(event);
    expect(events.filter(event => event.type === "tool_call_delta").map(event => event.arguments).join("")).toBe(chunks.join(""));
    expect(events.at(-1)?.type).toBe("done");
    expect(budget.snapshot().currentBytes).toBe(0);
    expect(budget.snapshot().activeCalls).toBe(0);
    // One measurement for call retention and one for output accounting; leave bounded headroom.
    expect(measurements).toBeLessThanOrEqual(3 * count);
    // Include growing-prefix measurements, with headroom for serialized adapter events.
    expect(measuredChars).toBeLessThanOrEqual(16 * chunks.join("").length);
  } finally {
    measuring.mockRestore();
    budget.dispose();
  }
});

test("Kiro argument byte totals reset per call and retain exact UTF-8 limits", async () => {
  const chunks = ['{"value":"', "한글😀", '"}'];
  const bytes = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
  for (const limit of [bytes - 1, bytes, bytes + 1]) {
    const budget = createTranslatorBudget({ maxCallArgumentBytes: limit });
    const events: AdapterEvent[] = [];
    try {
      for await (const event of parseKiroStream(responseFor([chunks, chunks]), budget)) events.push(event);
      if (limit < bytes) {
        expect(events.some(event => event.type === "error")).toBe(true);
        expect(events.some(event => event.type === "tool_call_start")).toBe(false);
      } else {
        expect(events.filter(event => event.type === "tool_call_start").map(event => event.id)).toEqual(["call-0", "call-1"]);
        expect(events.filter(event => event.type === "tool_call_delta").map(event => event.arguments).join("")).toBe(chunks.join("").repeat(2));
        expect(events.at(-1)?.type).toBe("done");
      }
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(budget.snapshot().activeCalls).toBe(0);
    } finally {
      budget.dispose();
    }
  }
});
