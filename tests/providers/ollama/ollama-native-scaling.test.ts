import { expect, spyOn, test } from "bun:test";
import { createOllamaNativeAdapter } from "../../../src/adapters/ollama-native";
import type { AdapterEvent } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const encoder = new TextEncoder();
const adapter = () => createOllamaNativeAdapter({ adapter: "ollama-native", baseUrl: "http://127.0.0.1:11434", models: ["fixture"] });
const record = (content: string, done = true) => JSON.stringify({ model: "fixture", message: { role: "assistant", content }, done, ...(done ? { done_reason: "stop", eval_count: 7 } : {}) });

function response(bytes: Uint8Array, chunkSize: number, emptyChunks = false, keepOpen = false) {
  let offset = 0;
  let empty = emptyChunks;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (empty) { empty = false; controller.enqueue(new Uint8Array(0)); return; }
      if (offset === bytes.length) { if (!keepOpen) controller.close(); return; }
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
      empty = emptyChunks;
    },
    cancel() { cancelled = true; },
  });
  return { response: new Response(body), cancelled: () => cancelled };
}

async function collect(input: Response) {
  const budget = createTestTranslatorBudget();
  const events: AdapterEvent[] = [];
  for await (const event of adapter().parseStream(input, budget)) events.push(event);
  expect(budget.snapshot().currentBytes).toBe(0);
  return events;
}

for (const metric of ["measurement", "splitting"] as const) {
  test(`fragmented Ollama records have linear ${metric} work`, async () => {
    const content = "x".repeat(256 * 1024);
    const bytes = encoder.encode(record(content) + "\n");
    const input = response(bytes, 256, false, true);
    const encode = TextEncoder.prototype.encode;
    const byteLength = Buffer.byteLength;
    const split = String.prototype.split;
    let measuredChars = 0;
    let splitChars = 0;
    const encoding = spyOn(TextEncoder.prototype, "encode").mockImplementation(function (value = "") {
      measuredChars += value.length;
      return Reflect.apply(encode, this, [value]);
    });
    const measuring = spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
      if (typeof value === "string") measuredChars += value.length;
      return byteLength(value, encoding);
    });
    const splitting = spyOn(String.prototype, "split").mockImplementation(function (...args: Parameters<typeof split>) {
      if (args[0] === "\n") splitChars += this.length;
      return Reflect.apply(split, this, args);
    });
    let events: AdapterEvent[];
    try { events = await collect(input.response); }
    finally { encoding.mockRestore(); measuring.mockRestore(); splitting.mockRestore(); }
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe(content);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { outputTokens: 7 } });
    expect(input.cancelled()).toBe(true);
    // Bound actual work, independent of CPU speed. Both UTF-8 counting APIs are observed.
    if (metric === "measurement") expect(measuredChars).toBeLessThanOrEqual(bytes.length * 8);
    else expect(splitChars).toBeLessThanOrEqual(bytes.length * 2);
  });
}

for (const ending of ["\n", "\r\n", ""] as const) {
  test(`Ollama fragmented UTF-8 preserves BOM, blank lines and ${JSON.stringify(ending)} termination`, async () => {
    const bytes = encoder.encode("\ufeff\n" + record("한글 😀", false) + "\r\n\n" + record("끝") + ending);
    const whole = await collect(response(bytes, bytes.length).response);
    const fragmented = await collect(response(bytes, 1, true).response);
    expect(fragmented).toEqual(whole);
    expect(fragmented.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe("한글 😀끝");
    expect(fragmented.at(-1)?.type).toBe("done");
  });
}

for (const deficit of [0, 1]) {
  test(`fragmented Unicode residual ${deficit ? "rejects one byte below" : "admits at"} its UTF-8 byte limit`, async () => {
    const content = "é한😀";
    const text = record(content);
    const bytes = encoder.encode(text);
    expect(bytes.length).toBeGreaterThan(text.length);
    const budget = createTestTranslatorBudget({ maxTurnBytes: bytes.length - deficit });
    let offset = 0;
    let cancelled = false;
    let beforeEof: ReturnType<typeof budget.snapshot> | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < bytes.length) {
          controller.enqueue(bytes.subarray(offset, ++offset));
          return;
        }
        // With no read-ahead, every fragment has been ingested; no delimiter or EOF yet.
        beforeEof = budget.snapshot();
        controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const events: AdapterEvent[] = [];
    for await (const event of adapter().parseStream(new Response(body), budget)) events.push(event);
    if (deficit === 0) {
      expect(beforeEof).toMatchObject({ currentBytes: bytes.length, highWaterBytes: bytes.length, overflows: 0 });
      expect(events.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe(content);
      expect(events.at(-1)?.type).toBe("done");
      expect(budget.snapshot().highWaterBytes).toBe(bytes.length);
    } else {
      expect(beforeEof).toBeUndefined(); // Refusal must happen while the record is still buffered.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", code: "translation_buffer_limit" });
      expect(budget.snapshot().overflows).toBe(1);
      expect(cancelled).toBe(true);
    }
    expect(budget.snapshot().currentBytes).toBe(0);
  });
}

test("invalid UTF-8 after a retained partial record releases its budget and cancels", async () => {
  const prefix = encoder.encode('{"message":{"content":"partial ');
  const bytes = new Uint8Array(prefix.length + 1);
  bytes.set(prefix);
  bytes[prefix.length] = 0xff;
  const input = response(bytes, prefix.length, false, true);
  const events = await collect(input.response);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "error" });
  expect(input.cancelled()).toBe(true);
});
