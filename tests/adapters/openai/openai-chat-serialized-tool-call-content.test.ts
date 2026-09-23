import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { SerializedToolCallContentBuffer } from "../../../src/adapters/openai-chat/serialized-tool-call-content";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const provider = { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", apiKey: "key" } as const;

test("buffered Chat responses reconcile matching serialized and structured tool calls", async () => {
  const script = "text('ok');";
  const content = `Running it.\n<tool_call><function=exec>${script}\n</parameter></function></tool_call>`;
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: {
        content,
        tool_calls: [{
          id: "call_exec",
          function: { name: "exec", arguments: script + JSON.stringify({ input: script }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([
    { type: "text_delta", text: "Running it.\n" },
  ]);
  expect(events.find(event => event.type === "tool_call_delta")).toEqual({
    type: "tool_call_delta",
    arguments: JSON.stringify({ input: script }),
  });
});

test("buffered Chat responses preserve serialized markup for a different function", async () => {
  const content = "<tool_call><function=other>literal example</function></tool_call>";
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: {
        content,
        tool_calls: [{ id: "call_exec", function: { name: "exec", arguments: "{}" } }],
      },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.find(event => event.type === "text_delta")).toEqual({ type: "text_delta", text: content });
});

test("an open serialized block charges only its appended bytes", () => {
  const open = "<tool_call><function=exec>";
  const body = "x".repeat(open.length);
  // Rebuilding the whole buffer would reserve the new total beside the retained
  // text, so this exact budget only admits the append when it charges the delta.
  const budget = createTestTranslatorBudget({ maxTurnBytes: open.length + body.length });
  const buffer = new SerializedToolCallContentBuffer(budget);

  expect(buffer.ingest(open)).toBe("");
  expect(buffer.ingest(body)).toBe("");
  expect(buffer.current()).toBe(open + body);
  expect(budget.snapshot()).toMatchObject({ currentBytes: open.length + body.length, overflows: 0 });

  expect(buffer.flush([])).toBe(open + body);
  expect(budget.snapshot()).toMatchObject({ currentBytes: 0, overflows: 0 });
});
