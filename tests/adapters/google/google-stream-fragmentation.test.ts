import { describe, expect, spyOn, test } from "bun:test";
import { createGoogleAdapter } from "../../../src/adapters/google";
import type { AdapterEvent } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const encoder = new TextEncoder();
const provider = { adapter: "google" as const, baseUrl: "https://example.test", apiKey: "fixture", authMode: "key" as const };
const dataLine = (text: string, ending = "\n\n") => `data: ${JSON.stringify({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
})}${ending}`;

function fragmentedResponse(wire: Uint8Array, chunkBytes: number, cancel?: () => void): Response {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === wire.byteLength) { controller.close(); return; }
      const end = Math.min(offset + chunkBytes, wire.byteLength);
      controller.enqueue(wire.subarray(offset, end));
      offset = end;
    },
    cancel,
  }, { highWaterMark: 0 }));
}

async function collect(response: Response, budget = createTestTranslatorBudget()): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of createGoogleAdapter(provider).parseStream(response, budget)) events.push(event);
  return events;
}

describe("Google streaming frame fragmentation", () => {
  test.each([128 * 1024, 256 * 1024])("counts and scans a %i-byte fragmented record in linear work", async size => {
    const text = "x".repeat(size);
    const wire = encoder.encode(dataLine(text));
    const response = fragmentedResponse(wire, 512);
    const budget = createTestTranslatorBudget();
    const encode = TextEncoder.prototype.encode;
    const byteLength = Buffer.byteLength;
    const split = String.prototype.split;
    let measuredCharacters = 0;
    let scannedCharacters = 0;
    const encodeSpy = spyOn(TextEncoder.prototype, "encode").mockImplementation(function(this: TextEncoder, input = "") {
      measuredCharacters += input.length;
      return encode.call(this, input);
    });
    const bytesSpy = spyOn(Buffer, "byteLength").mockImplementation((input, encoding) => {
      if (typeof input === "string") measuredCharacters += input.length;
      return byteLength(input, encoding);
    });
    const splitSpy = spyOn(String.prototype, "split").mockImplementation(function(this: string, ...args: unknown[]): string[] {
      if (args[0] === "\n") scannedCharacters += this.length;
      return Reflect.apply(split, this, args);
    });
    let events: AdapterEvent[];
    try {
      events = await collect(response, budget);
    } finally {
      encodeSpy.mockRestore();
      bytesSpy.mockRestore();
      splitSpy.mockRestore();
    }
    expect(events).toContainEqual({ type: "text_delta", text });
    expect(events.at(-1)?.type).toBe("done");
    // Count input inspected by the production measuring/scanning primitives, not elapsed time.
    // Re-measuring or splitting the growing carry on every fragment exceeds these bounds.
    expect(measuredCharacters).toBeLessThanOrEqual(wire.byteLength * 4);
    expect(scannedCharacters).toBeLessThanOrEqual(wire.byteLength * 2);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test.each(["", "\n\n", "\r\n\r\n"])("preserves split UTF-8 and terminal parsing with ending %j", async ending => {
    const text = "한글🙂é".repeat(16);
    const budget = createTestTranslatorBudget();
    const events = await collect(fragmentedResponse(encoder.encode(dataLine(text, ending)), 1), budget);
    expect(events).toContainEqual({ type: "text_delta", text });
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("keeps a partial next record after consuming complete lines", async () => {
    const first = dataLine("first");
    const second = dataLine("한글🙂second", "");
    const wire = encoder.encode(first + second);
    const budget = createTestTranslatorBudget();
    const events = await collect(fragmentedResponse(wire, encoder.encode(first).length + 10), budget);
    expect(events.filter(event => event.type === "text_delta").map(event => event.text)).toEqual(["first", "한글🙂second"]);
    expect(events.at(-1)?.type).toBe("done");
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test.each([6, 7])("accounts for decoder EOF replacement bytes with a %i-byte budget", async maxTurnBytes => {
    const budget = createTestTranslatorBudget({ maxTurnBytes });
    // The decoder holds the unfinished UTF-8 character until EOF: two retained ASCII
    // bytes overlap with the five-byte replacement string when U+FFFD is appended.
    const wire = new Uint8Array([0x3a, 0x20, 0xe2, 0x82]);
    const events = await collect(fragmentedResponse(wire, wire.length), budget);
    if (maxTurnBytes === 6) {
      expect(events).toEqual([expect.objectContaining({ type: "error", code: "translation_buffer_limit" })]);
      expect(budget.snapshot().overflows).toBe(1);
    } else {
      expect(events).toContainEqual({ type: "heartbeat" });
      expect(budget.snapshot()).toMatchObject({ highWaterBytes: 7, overflows: 0 });
    }
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("keeps byte-budget refusal and releases the retained prefix", async () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 128 });
    let cancellations = 0;
    const response = fragmentedResponse(encoder.encode(dataLine("🙂".repeat(128))), 32, () => { cancellations++; });
    const events = await collect(response, budget);
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "translation_buffer_limit" })]);
    expect(cancellations).toBe(1);
    expect(response.body!.locked).toBe(false);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, overflows: 1 });
  });

  test("releases residual accounting and the reader when a consumer stops", async () => {
    const budget = createTestTranslatorBudget();
    const wire = encoder.encode(dataLine("first") + "data: {\"candidates\":[");
    const response = fragmentedResponse(wire, wire.length);
    const events = createGoogleAdapter(provider).parseStream(response, budget);
    expect((await events.next()).value).toEqual({ type: "text_delta", text: "first" });
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    await events.return(undefined);
    expect(budget.snapshot().currentBytes).toBe(0);
    expect(response.body!.locked).toBe(false);
    await response.body!.cancel();
  });
});
