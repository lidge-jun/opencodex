import { describe, expect, test } from "bun:test";
import { responsesSseToChatCompletionsSse } from "../../src/chat/outbound";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

type Rec = Record<string, unknown>;
type Frame = { error?: { code: string; type: string }; choices?: Array<{ delta?: Rec; finish_reason?: string | null }> };
const encoder = new TextEncoder();
const model = "refusal-scope-fixture/model";
const event = (type: string, fields: Rec = {}): Rec => ({ type, ...fields });
const wireEvent = (value: Rec): string => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

function bytesSource(chunks: string[]): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream({
    pull(controller) {
      if (next < chunks.length) controller.enqueue(encoder.encode(chunks[next++]!));
      else controller.close();
    },
  }, { highWaterMark: 0 });
}

async function translate(events: Rec[]): Promise<string> {
  const stream = responsesSseToChatCompletionsSse(bytesSource(events.map(wireEvent)), model, {
    translatorBudget: createTestTranslatorBudget(),
  });
  return await new Response(stream).text();
}

function frames(wire: string): Frame[] {
  return wire.split("\n\n").filter(b => b.startsWith("data: ") && b !== "data: [DONE]")
    .map(b => JSON.parse(b.slice(6)) as Frame);
}
const errorCodes = (wire: string): string[] => frames(wire).flatMap(f => f.error ? [f.error.code] : []);

const textMessage = (id: string, text = "answer"): Rec => ({
  type: "message", role: "assistant", id, status: "completed",
  content: [{ type: "output_text", text }],
});
const refusalMessage = (id: string, refusal: string): Rec => ({
  type: "message", role: "assistant", id, status: "completed",
  content: [{ type: "refusal", refusal }],
});
const completed = (output: unknown[] = []): Rec =>
  event("response.completed", { response: { status: "completed", output } });

describe("refusal bookkeeping stays out of refusal-free streams", () => {
  // The reported failure. A bridge may flush a hidden reasoning envelope at the
  // output_index of a still-open message, so one index carries two item ids. That is
  // not a refusal contradiction, and it used to fail a healthy turn with
  // invalid_refusal after the model had already streamed its answer.
  test("one output_index carrying a message then a reasoning item is not a refusal contradiction", async () => {
    const wire = await translate([
      event("response.output_item.added", {
        output_index: 0,
        item: { type: "message", role: "assistant", id: "msg_1", status: "in_progress", content: [] },
      }),
      event("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } }),
      completed(),
    ]);
    expect(errorCodes(wire)).toEqual([]);
  });

  test("the same message id appearing at two indices carries no refusal meaning", async () => {
    const wire = await translate([
      event("response.output_item.done", { output_index: 0, item: textMessage("msg_dup") }),
      event("response.output_item.done", { output_index: 1, item: textMessage("msg_dup") }),
      completed(),
    ]);
    expect(errorCodes(wire)).toEqual([]);
  });

  test("two different plain messages on one index carry no refusal meaning", async () => {
    const wire = await translate([
      event("response.output_item.done", { output_index: 0, item: textMessage("msg_a") }),
      event("response.output_item.done", { output_index: 0, item: textMessage("msg_b") }),
      completed(),
    ]);
    expect(errorCodes(wire)).toEqual([]);
  });

  test("a terminal snapshot of ordinary text does not enrol the ledger", async () => {
    const wire = await translate([completed([textMessage("msg_1"), { type: "reasoning", id: "rs_1", summary: [] }])]);
    expect(errorCodes(wire)).toEqual([]);
  });
});

describe("real refusal contradictions still fail closed", () => {
  // These are the guarantee. Once actual refusal content exists, a contradictory
  // id or index must still stop the turn rather than emit a mangled refusal.
  test("a refusal id that moves to another index still fails", async () => {
    const wire = await translate([
      event("response.refusal.delta", { output_index: 0, content_index: 0, delta: "no", item_id: "msg_r" }),
      event("response.output_item.done", { output_index: 1, item: refusalMessage("msg_r", "no") }),
      completed(),
    ]);
    expect(errorCodes(wire)).toEqual(["invalid_refusal"]);
  });

  test("a second refusal id on one index still fails", async () => {
    const wire = await translate([
      event("response.refusal.delta", { output_index: 0, content_index: 0, delta: "no", item_id: "msg_r" }),
      event("response.output_item.done", { output_index: 0, item: refusalMessage("msg_other", "no") }),
      completed(),
    ]);
    expect(errorCodes(wire)).toEqual(["invalid_refusal"]);
  });

  test("a refusal snapshot that contradicts the accumulated delta still fails", async () => {
    const wire = await translate([
      event("response.refusal.delta", { output_index: 0, content_index: 0, delta: "sorry", item_id: "msg_r" }),
      event("response.refusal.done", { output_index: 0, content_index: 0, refusal: "different", item_id: "msg_r" }),
      completed(),
    ]);
    expect(errorCodes(wire)).toEqual(["invalid_refusal"]);
  });

  test("a non-refusal part replacing a retained refusal part still fails", async () => {
    const wire = await translate([
      event("response.refusal.delta", { output_index: 0, content_index: 0, delta: "no", item_id: "msg_r" }),
      event("response.output_item.done", {
        output_index: 0,
        item: { type: "message", role: "assistant", id: "msg_r", status: "completed", content: [{ type: "output_text", text: "answer" }] },
      }),
      completed(),
    ]);
    expect(errorCodes(wire)).toEqual(["invalid_refusal"]);
  });
});
