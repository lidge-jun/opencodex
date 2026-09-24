import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { SerializedToolCallContentBuffer } from "../../../src/adapters/openai-chat/serialized-tool-call-content";
import type { AdapterEvent } from "../../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";

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
describe("MiMo echo variants (#5724)", () => {
  const script = 'const r = await tools.exec_command({cmd:"Get-Content a.txt"}); text(r.output);';
  const call = (input: string) => ({ index: 0, id: "call_exec", function: { name: "exec", arguments: JSON.stringify({ input }) } });

  async function streamed(content: string, input: string): Promise<AdapterEvent[]> {
    const adapter = withTestTranslatorBudget(createOpenAIChatAdapter(provider));
    adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: true, options: {}, context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] } });
    const frames = [
      { choices: [{ delta: { content: content.slice(0, 30) } }] },
      { choices: [{ delta: { content: content.slice(30) } }] },
      { choices: [{ delta: { tool_calls: [call(input)] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(body))) if (event.type !== "heartbeat") events.push(event);
    return events;
  }
  async function buffered(content: string, input: string): Promise<AdapterEvent[]> {
    return createOpenAIChatAdapter(provider).parseResponse!(Response.json({
      choices: [{ message: { content, tool_calls: [call(input)] }, finish_reason: "tool_calls" }],
    }), createTestTranslatorBudget());
  }
  const visible = (events: AdapterEvent[]): string => events
    .map(event => (event.type === "text_delta" ? event.text : ""))
    .join("");

  test.each([
    ["the header is followed by a template newline", `<tool_call><function=exec>\n${script}\n</parameter></function></tool_call>`],
    ["the echo omits </function>", `<tool_call><function=exec>${script}</parameter></tool_call>`],
  ])("a matching block is removed when %s", async (_label, block) => {
    for (const events of [await streamed(`Reading.\n${block}`, script), await buffered(`Reading.\n${block}`, script)]) {
      expect(visible(events)).toBe("Reading.\n");
      expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(1);
    }
  });

  test("an unclosed block with a different body stays visible", async () => {
    const block = "<tool_call><function=exec>text('other');</parameter></tool_call>";
    for (const events of [await streamed(block, script), await buffered(block, script)]) {
      expect(visible(events)).toBe(block);
    }
  });

  test("a closed block whose body carries literal tool-call tags is still matched whole", async () => {
    for (const input of ["text('</tool_call>');", "text('<tool_call>');", 'text("<tool_call><function=exec>");']) {
      const block = `<tool_call><function=exec>${input}</parameter></function></tool_call>`;
      for (const events of [await streamed(block, input), await buffered(block, input)]) {
        expect(visible(events)).toBe("");
      }
    }
  });

  test("an unclosed block followed by a closed block is read as two blocks", async () => {
    const first = "text('a');";
    const second = "text('b');";
    const content = `<tool_call><function=exec>${first}</parameter></tool_call>\n<tool_call><function=exec>${second}</parameter></function></tool_call>`;
    const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
      choices: [{
        message: { content, tool_calls: [call(first), { ...call(second), index: 1, id: "call_exec_2" }] },
        finish_reason: "tool_calls",
      }],
    }), createTestTranslatorBudget());
    expect(visible(events)).toBe("\n");
    expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(2);
  });
});
