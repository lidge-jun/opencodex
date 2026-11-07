import { expect, test } from "bun:test";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import type { AdapterEvent } from "../../src/types";

const adapter = () => createCommandCodeAdapter({ adapter: "command-code", baseUrl: "https://command.example" });
const content = "é한😀".repeat(32);
const line = JSON.stringify({ type: "text-delta", text: content });
const encoder = new TextEncoder();

function input(bytes: Uint8Array, chunkSize: number, beforeRead?: (offset: number) => void) {
  let offset = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      beforeRead?.(offset);
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(body), cancelled: () => cancelled };
}

for (const ending of ["\n", ""] as const) {
  for (const fragmented of [false, true]) {
    test(`Command Code admits an exact-limit ${fragmented ? "fragmented" : "whole"} record with ${JSON.stringify(ending)} termination`, async () => {
      const bytes = encoder.encode(line + ending);
      const budget = createTestTranslatorBudget({ maxTurnBytes: bytes.length });
      const source = input(bytes, fragmented ? 1 : bytes.length);
      const events: AdapterEvent[] = [];
      for await (const event of adapter().parseStream(source.response, budget)) events.push(event);
      expect(events).toEqual([
        { type: "text_delta", text: content },
        { type: "done", usage: undefined, stopReason: undefined },
      ]);
      expect(budget.snapshot()).toMatchObject({ currentBytes: 0, highWaterBytes: bytes.length, overflows: 0 });
    });
  }
}

for (const fragmented of [false, true]) {
  test(`Command Code refuses a ${fragmented ? "fragmented" : "whole"} record one byte over budget and cleans up`, async () => {
    const bytes = encoder.encode(line);
    const budget = createTestTranslatorBudget({ maxTurnBytes: bytes.length - 1 });
    const source = input(bytes, fragmented ? 1 : bytes.length);
    const events: AdapterEvent[] = [];
    const consume = async () => {
      for await (const event of adapter().parseStream(source.response, budget)) events.push(event);
    };
    await expect(consume()).rejects.toMatchObject({ code: "translation_buffer_limit", kind: "live_transient" });
    expect(events).toHaveLength(0);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, overflows: 1 });
    expect(source.cancelled()).toBe(true);
  });
}

for (const deficit of [0, 1]) {
  test(`Command Code preserves another live_transient owner's bytes on ${deficit ? "refused" : "successful"} growth`, async () => {
    const bytes = encoder.encode(line);
    const budget = createTestTranslatorBudget({ maxTurnBytes: bytes.length + 64 - deficit });
    budget.chargeRetained(64, { kind: "live_transient" });
    const source = input(bytes, 1);
    const events: AdapterEvent[] = [];
    const consume = async () => {
      for await (const event of adapter().parseStream(source.response, budget)) events.push(event);
    };
    if (deficit) {
      await expect(consume()).rejects.toMatchObject({ code: "translation_buffer_limit" });
      expect(events).toHaveLength(0);
      expect(source.cancelled()).toBe(true);
    } else {
      await consume();
      expect(events.at(-1)?.type).toBe("done");
    }
    expect(budget.snapshot()).toMatchObject({ currentBytes: 64, highWaterBytes: bytes.length + 64 - deficit, overflows: deficit });
    budget.releaseRetained(64, { kind: "live_transient" });
    expect(budget.snapshot().currentBytes).toBe(0);
  });
}

test("Command Code releases drained bytes before reading the next fragment", async () => {
  const carryBytes = 16; // The second record's ASCII JSON prefix, before any text content.
  const firstReadBytes = encoder.encode(line + "\n").length + carryBytes;
  const budget = createTestTranslatorBudget({ maxTurnBytes: firstReadBytes });
  const retainedBeforeSecondRead: number[] = [];
  const source = input(encoder.encode(line + "\n" + line), firstReadBytes, offset => {
    if (offset === firstReadBytes) retainedBeforeSecondRead.push(budget.snapshot().currentBytes);
  });
  const events: AdapterEvent[] = [];
  for await (const event of adapter().parseStream(source.response, budget)) events.push(event);
  expect(retainedBeforeSecondRead).toEqual([carryBytes]);
  expect(events.filter(event => event.type === "text_delta").map(event => event.text)).toEqual([content, content]);
  expect(events.at(-1)?.type).toBe("done");
  expect(budget.snapshot()).toMatchObject({ currentBytes: 0, highWaterBytes: firstReadBytes, overflows: 0 });
});

test("Command Code consumer return releases its retained record and cancels upstream", async () => {
  const bytes = encoder.encode(line + "\n");
  const budget = createTestTranslatorBudget({ maxTurnBytes: bytes.length });
  const source = input(bytes, bytes.length);
  const events = adapter().parseStream(source.response, budget);
  expect((await events.next()).value).toMatchObject({ type: "text_delta", text: content });
  expect(budget.snapshot().currentBytes).toBe(bytes.length);
  await events.return();
  expect(budget.snapshot().currentBytes).toBe(0);
  expect(source.cancelled()).toBe(true);
});
