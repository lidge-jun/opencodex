import { describe, expect, test } from "bun:test";
import { anthropicToResponsesTranslation } from "../../src/claude/inbound";

const TASKCREATE_NUDGE = "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking, consider using TaskCreate to add them. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.";
const footer = (remaining: number) => `<total_tokens>${remaining} tokens left</total_tokens>`;
const userItem = { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] };

function translate(system: string, messages: unknown[] = [{ role: "user", content: "hi" }]) {
  return anthropicToResponsesTranslation({ model: "m", max_tokens: 32, system, messages }, {
    stabilizePromptCache: true,
  }).body;
}

describe("Claude token footer does not introduce a user turn", () => {
  test("footer-only notices are peeled without adding an input item", () => {
    for (const system of [`System.\n\n${footer(1000)}`, footer(1000)]) {
      const body = translate(system);
      expect(body.instructions).toBe(system.startsWith("System.") ? "System." : undefined);
      expect(body.input).toEqual([userItem]);
    }
  });

  test("repeated footers preserve the stabilized instructions and historical cache key", () => {
    const baseline = translate("System.");
    for (const count of [1, 3]) {
      const body = translate(["System.", ...Array.from({ length: count }, (_, i) => footer(i + 1))].join("\n\n"));
      expect(body.instructions).toBe(baseline.instructions);
      expect(body.prompt_cache_key).toBe(baseline.prompt_cache_key);
      expect(body.input).toEqual(baseline.input);
    }
  });

  test("mixed notices retain TaskCreate as the same trailing user message", () => {
    const baseline = translate(`System.\n\n${TASKCREATE_NUDGE}`);
    for (const notices of [
      [footer(1), TASKCREATE_NUDGE, footer(2)],
      [TASKCREATE_NUDGE, footer(1), footer(2)],
      [footer(1), footer(2), TASKCREATE_NUDGE],
    ]) {
      const body = translate(["System.", ...notices].join("\n\n"));
      expect(body.instructions).toBe(baseline.instructions);
      expect(body.prompt_cache_key).toBe(baseline.prompt_cache_key);
      expect(body.input).toEqual([
        userItem,
        { type: "message", role: "user", content: [{ type: "input_text", text: TASKCREATE_NUDGE }] },
      ]);
    }
  });

  test("a tool-result turn ends with its function output without a synthetic footer user item", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_read", name: "Read", input: { path: "example.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", content: "file contents" }] },
    ];
    const baseline = translate("System.", messages);
    const body = translate(`System.\n\n${footer(1000)}\n\n${footer(999)}`, messages);
    expect(body.instructions).toBe(baseline.instructions);
    expect(body.prompt_cache_key).toBe(baseline.prompt_cache_key);
    expect(body.input).toEqual(baseline.input);
    expect(body.input).toEqual([
      userItem,
      { type: "function_call", call_id: "call_read", name: "Read", arguments: '{"path":"example.txt"}' },
      { type: "function_call_output", call_id: "call_read", output: "file contents" },
    ]);
  });
});
