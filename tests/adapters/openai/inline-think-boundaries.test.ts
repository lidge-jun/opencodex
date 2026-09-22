import { describe, expect, test } from "bun:test";
import { InlineThinkTagParser, splitInlineThinkContent } from "../../../src/adapters/inline-think-tags";
import type { AdapterEvent } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

function projection(events: AdapterEvent[]) {
  return {
    answer: events.filter(e => e.type === "text_delta").map(e => e.text).join(""),
    reasoning: events.filter(e => e.type === "reasoning_raw_delta").map(e => e.text).join(""),
  };
}
function split(chunks: string[], interleaved = true) {
  const parser = new InlineThinkTagParser(undefined, { interleaved });
  const events: AdapterEvent[] = [];
  try {
    for (const chunk of chunks) for (const event of parser.feed(chunk)) events.push(event);
    events.push(...parser.flush());
    return projection(events);
  } finally { parser.dispose(); }
}

describe("inline thinking format boundaries", () => {
  test("leading and first-answer whitespace survives every chunk boundary", () => {
    const input = " \n<think>why😀</think>\n    code();<reasoning>next</reasoning>  tail";
    const expected = { answer: " \n\n    code();  tail", reasoning: "why😀next" };
    for (let cut = 0; cut <= input.length; cut++) {
      expect(split([input.slice(0, cut), input.slice(cut)])).toEqual(expected);
    }
  });
  test("Kiro retains single-block normalization and subsequent literal tags", () => {
    expect(split([" \n<think>why</think>\n  answer<think>literal</think>"], false))
      .toEqual({ answer: "answer<think>literal</think>", reasoning: "why" });
  });
  test("ordinary code examples never activate parsing", () => {
    const input = "```xml\n<think>literal</think>\n```";
    expect(split([...input])).toEqual({ answer: input, reasoning: "" });
  });
  test("after activation tags remain format delimiters even inside a code fence", () => {
    const input = "<think>first</think>```xml\n<think>later</think>\n```";
    expect(split([...input])).toEqual({ answer: "```xml\n\n```", reasoning: "firstlater" });
  });
  test("many same-chunk blocks and split chunks have identical output without recursion", () => {
    const block = "<think>r</think>a";
    const count = 12000;
    const expected = { answer: "a".repeat(count), reasoning: "r".repeat(count) };
    expect(split([block.repeat(count)])).toEqual(expected);
    expect(split(Array(count).fill(block))).toEqual(expected);
  });
  test("partial tags and unterminated reasoning flush without loss", () => {
    expect(split(["<thi"])).toEqual({ answer: "<thi", reasoning: "" });
    expect(split(["<think>why😀</thi"])).toEqual({ answer: "", reasoning: "why😀</thi" });
    expect(split(["<think>x</think>answer<th"])).toEqual({ answer: "answer<th", reasoning: "x" });
  });
  test("unlisted models remain byte-exact", () => {
    const content = "<think>why</think>answer";
    expect(projection(splitInlineThinkContent(["other"], "model", undefined, content)))
      .toEqual({ answer: content, reasoning: "" });
  });
  test("dispose releases partial carry and an overflow does not relax the budget", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 128 });
    const parser = new InlineThinkTagParser(budget, { interleaved: true });
    parser.feed("<think>partial");
    expect(() => parser.feed("x".repeat(129))).toThrow();
    parser.dispose();
    expect(budget.snapshot().currentBytes).toBe(0);
  });
});
