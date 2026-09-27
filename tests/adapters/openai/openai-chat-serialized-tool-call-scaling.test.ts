import { describe, expect, spyOn, test } from "bun:test";
import { SerializedToolCallContentBuffer, splitAtPossibleSerializedToolCall } from "../../../src/adapters/openai-chat/serialized-tool-call-content";
import type { AdapterEvent } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const OPEN = "<tool_call><function=exec>";
const CLOSE = "</function></tool_call>";
const BLOCK = OPEN + "ok" + CLOSE;

function scanWork(count: number, closed: boolean): number {
  const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
  buffer.ingestStreaming(closed ? BLOCK : OPEN);
  let work = 0;
  const original = String.prototype.lastIndexOf;
  const scan = spyOn(String.prototype, "lastIndexOf").mockImplementation(function (this: string, ...args) {
    work += this.length;
    return original.apply(this, args);
  });
  try {
    // Whitespace after a close cannot trigger the prose limit; the entire prefix stays held.
    for (let i = 0; i < count; i++) buffer.ingestStreaming(closed ? " \t\n" : "xyz");
  } finally {
    scan.mockRestore();
    buffer.dispose();
  }
  return work;
}

describe("serialized tool content incremental delimiter work", () => {
  for (const closed of [false, true]) {
    test(`search work is linear for ${closed ? "closed" : "open"} blocks in tiny deltas`, () => {
      const small = scanWork(2048, closed);
      const large = scanWork(4096, closed);
      expect(small).toBeGreaterThan(0);
      // Count actual search input, not elapsed time or an implementation-maintained counter.
      expect(large).toBeLessThanOrEqual(2 * small + 24);
      expect(large).toBeLessThanOrEqual(2 * 4096 * (3 + 11));
    });
  }

  test("every closing delimiter split keeps the inclusive prose limit and event order", () => {
    for (let split = 0; split <= CLOSE.length; split++) {
      const budget = createTestTranslatorBudget();
      const buffer = new SerializedToolCallContentBuffer(budget);
      const reasoning: AdapterEvent = { type: "reasoning_raw_delta", text: "thinking" };
      expect(buffer.ingestStreaming(OPEN + "ok")).toEqual([]);
      expect(buffer.hold(reasoning)).toEqual([{ type: "heartbeat" }]);
      expect(buffer.ingestStreaming(CLOSE.slice(0, split))).toEqual([]);
      expect(buffer.ingestStreaming(CLOSE.slice(split))).toEqual([]);
      expect(buffer.ingestStreaming("x".repeat(8192) + " \t\n\u00a0")).toEqual([]);
      expect(buffer.ingestStreaming("😀")).toEqual([
        { type: "text_delta", text: OPEN + "ok" }, reasoning,
        { type: "text_delta", text: CLOSE + "x".repeat(8192) + " \t\n\u00a0😀" },
      ]);
      expect(budget.snapshot().currentBytes).toBe(0);
      buffer.dispose();
    }
  });

  test("split later openers suspend prose release and a later closer resets its count", () => {
    for (let split = 0; split <= "<tool_call>".length; split++) {
      const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
      expect(buffer.ingestStreaming(BLOCK + "a".repeat(8000))).toEqual([]);
      expect(buffer.ingestStreaming("<tool_call>".slice(0, split))).toEqual([]);
      expect(buffer.ingestStreaming("<tool_call>".slice(split) + "b".repeat(9000))).toEqual([]);
      expect(buffer.ingestStreaming(CLOSE + "x".repeat(8192))).toEqual([]);
      const held = buffer.current();
      expect(buffer.ingestStreaming("!")).toEqual([{ type: "text_delta", text: held + "!" }]);
      // The next held block has fresh delimiter state, including after a bounded release.
      buffer.ingestStreaming("\n");
      expect(buffer.ingestStreaming(OPEN + "y".repeat(9000))).toEqual([]);
      buffer.dispose();
    }
  });

  test("opening headers split at every position retain exact reconciliation and queued events", () => {
    for (let split = 0; split <= OPEN.length; split++) {
      const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
      expect(buffer.ingestStreaming(OPEN.slice(0, split))).toEqual([]);
      expect(buffer.ingestStreaming(OPEN.slice(split) + "ok")).toEqual([]);
      const reasoning: AdapterEvent = { type: "reasoning_raw_delta", text: "thinking" };
      buffer.hold(reasoning);
      expect(buffer.ingestStreaming(CLOSE)).toEqual([]);
      expect(buffer.drain([{ names: new Set(["exec"]), argumentsText: '{"input":"ok"}' }])).toEqual([reasoning]);
      expect(buffer.ingestStreaming("\n" + BLOCK)).toEqual([{ type: "text_delta", text: "\n" }]);
      expect(buffer.drain([])).toEqual([{ type: "text_delta", text: BLOCK }]);
      buffer.dispose();
    }
  });
});

describe("deferred header and Markdown phases", () => {
  const cases = [
    { prefix: "<tool_call>", delta: " \n", end: "<function=exec>ok" + CLOSE, held: true },
    { prefix: "<tool_call><function=", delta: "name", end: ">ok" + CLOSE, held: true },
    { prefix: "```", delta: "language", end: "\ncode\n```\n", held: false },
    { prefix: "```\ncode\n```", delta: " ", end: "\n", held: false },
    { prefix: "```\ncode\n```", delta: "`", end: "\n", held: false },
    { prefix: "text `", delta: "`", end: "done", held: false },
  ];
  for (const fixture of cases) {
    test(`new chunks alone are examined during the deferred phase ${JSON.stringify(fixture.prefix)}`, () => {
      const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
      const initial = buffer.ingest(fixture.prefix);
      let examined = 0;
      const original = RegExp.prototype.test;
      const scan = spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, value) {
        examined += value.length;
        return original.call(this, value);
      });
      try {
        for (let i = 0; i < 2048; i++) buffer.ingestStreaming(fixture.delta);
      } finally { scan.mockRestore(); }
      expect(examined).toBeLessThanOrEqual(2048 * fixture.delta.length + 16);
      const emitted = buffer.ingest(fixture.end);
      const drained = buffer.flush([]);
      expect(initial + emitted + drained).toBe(fixture.prefix + fixture.delta.repeat(2048) + fixture.end);
      expect(drained.length > 0).toBe(fixture.held);
      buffer.dispose();
    });
  }

  test("a non-whitespace closing fence suffix resolves immediately as literal text", () => {
    const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
    expect(buffer.ingest("```\ncode\n``` ")).toBe("```\ncode\n");
    expect(buffer.ingest(" \t")).toBe("");
    expect(buffer.ingest("language")).toBe("```  \tlanguage");
    // The failed closer leaves us inside the fence: tool markup stays literal.
    expect(buffer.ingest("\n" + BLOCK)).toBe("\n" + BLOCK);
    buffer.dispose();
  });
});

test("incremental deferred phases emit exactly the full splitter's per-delta output", () => {
  const fixtures = [
    "<tool_call> \n\t<function=some😀name>body" + CLOSE,
    "<tool_call> \n<function=unterminated\nordinary text",
    "```language\n" + BLOCK + "\n```` \t\n" + BLOCK,
    "~~~language\n" + BLOCK + "\n~~~~ \tbad\n" + BLOCK,
    "  ```lang\ncode\n  ``` \t\n" + BLOCK,
    "````\ncode\n```\n" + BLOCK + "\n`````\n",
    "before `" + "`".repeat(20) + "literal\n" + BLOCK,
    "<tool_call><function=>\n" + BLOCK,
  ];
  for (const text of fixtures) for (let width = 1; width <= text.length; width++) {
    const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
    let retained = "";
    let opened = false;
    let context: Parameters<typeof splitAtPossibleSerializedToolCall>[1];
    for (let at = 0; at < text.length; at += width) {
      const delta = text.slice(at, at + width);
      let expected = "";
      if (opened) retained += delta;
      else {
        const split = splitAtPossibleSerializedToolCall(retained + delta, context);
        retained = split.defer; context = split.context; opened = split.hasOpenTag;
        expected = split.emit;
      }
      expect(buffer.ingest(delta)).toBe(expected);
      expect(buffer.current()).toBe(retained);
    }
    buffer.dispose();
  }
});

test("deferred header byte accounting joins split surrogate pairs and releases its reservation", () => {
  const budget = createTestTranslatorBudget();
  const buffer = new SerializedToolCallContentBuffer(budget);
  const prefix = "<tool_call><function=";
  buffer.ingest(prefix + "\ud83d");
  buffer.ingest("\ude00");
  expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(prefix + "😀"));
  buffer.dispose();
  expect(budget.snapshot().currentBytes).toBe(0);
  expect(buffer.ingest("visible")).toBe("visible");
  buffer.dispose();
});
