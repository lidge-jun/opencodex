import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { SerializedToolCallContentBuffer, stripDuplicatedSerializedToolCalls } from "../../../src/adapters/openai-chat/serialized-tool-call-content";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";
import type { AdapterEvent } from "../../../src/types";

const nonce = "36a8b94076c558de0938f7e4f3cd4f18c5490ca0";
const input = "text(42);";
const block = `<tool_call_${nonce}><function=exec>${input}\n</parameter></function></tool_call_${nonce}>`;
const reference = { names: new Set(["exec"]), argumentsText: JSON.stringify({ input }), freeformTool: { name: "exec" } };

for (const prefix of ["", "Working now. "]) {
  test(`every stream split reconciles an identified echo after ${JSON.stringify(prefix)}`, () => {
    const text = prefix + block;
    for (let split = 0; split <= text.length; split++) {
      const budget = createTestTranslatorBudget();
      const buffer = new SerializedToolCallContentBuffer(budget);
      const visible = buffer.ingest(text.slice(0, split)) + buffer.ingest(text.slice(split)) + buffer.flush([reference]);
      expect(visible).toBe(prefix);
      expect(budget.snapshot().currentBytes).toBe(0);
      buffer.dispose();
    }
  });
}

test.each(["`", "```\n", "> ", "    ", "  > "])("literal Markdown prefix %j is preserved", prefix => {
  const text = prefix + block + (prefix === "`" ? "`" : prefix === "```\n" ? "\n```" : "");
  for (let split = 0; split <= text.length; split++) {
    const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
    expect(buffer.ingest(text.slice(0, split)) + buffer.ingest(text.slice(split)) + buffer.flush([reference])).toBe(text);
    buffer.dispose();
  }
});

test("wrong nonce, wrong function, wrong input and incomplete blocks stay visible", () => {
  for (const text of [block.replace(`</tool_call_${nonce}>`, "</tool_call_deadbeef>"),
    block.replace("function=exec", "function=other"), block.replace(input, "text(43);"),
    block.replace(`</tool_call_${nonce}>`, ""), block.replaceAll(nonce, "z".repeat(40)),
    block.replaceAll(nonce, "a".repeat(65))]) {
    expect(stripDuplicatedSerializedToolCalls(text, [reference])).toBe(text);
  }
});

test("invalid identified wrappers stay visible in streaming responses", async () => {
  const adapter = withTestTranslatorBudget(createOpenAIChatAdapter({
    adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "test",
  }));
  adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: true, options: {}, context: {
    messages: [{ role: "user", content: "Run the tool", timestamp: 0 }],
    tools: [{ name: "exec", description: "JavaScript", freeform: true, parameters: {
      type: "object", properties: { input: { type: "string" } },
    } }],
  } });
  for (const text of [
    block.replace(`</tool_call_${nonce}>`, "</tool_call_deadbeef>"),
    block.replaceAll(nonce, "a".repeat(65)),
  ]) {
    const wire = [...text]
      .map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      .join("") + "data: [DONE]\n\n";
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(wire))) events.push(event);
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe(text);
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
  }
});

test("failed dispatch preserves held content and releases its budget", () => {
  const budget = createTestTranslatorBudget();
  const buffer = new SerializedToolCallContentBuffer(budget);
  expect(buffer.ingest(block)).toBe("");
  expect(buffer.flush([])).toBe(block);
  expect(budget.snapshot().currentBytes).toBe(0);
  buffer.dispose();
});

test("identified closing tags retain the streaming prose bound at every split", () => {
  const end = `</tool_call_${nonce}>`;
  for (let split = 0; split <= end.length; split++) {
    const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
    const start = block.slice(0, -end.length);
    expect(buffer.ingestStreaming(start + end.slice(0, split))).toEqual([]);
    expect(buffer.ingestStreaming(end.slice(split))).toEqual([]);
    expect(buffer.ingestStreaming("x".repeat(8192))).toEqual([]);
    const released = buffer.ingestStreaming("y");
    expect(released.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe(block + "x".repeat(8192) + "y");
    buffer.dispose();
  }
});

for (const stream of [false, true]) for (const empty of [false, true]) {
  test(`MiMo adapter dispatches exactly once and hides only the echo (stream=${stream}, empty=${empty})`, async () => {
    const adapter = withTestTranslatorBudget(createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "test" }));
    adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream, options: {}, context: {
      messages: [{ role: "user", content: "Run the tool", timestamp: 0 }],
      tools: [{ name: "exec", description: "JavaScript", freeform: true, parameters: { type: "object", properties: { input: { type: "string" } } } }],
    } });
    const call = { id: "call_one", function: { name: "exec", arguments: empty ? "{}" : JSON.stringify({ input }) } };
    const prefix = empty ? "" : "Working. ";
    const content = prefix + (empty ? block : block + block);
    const events: AdapterEvent[] = [];
    if (!stream) events.push(...await adapter.parseResponse!(Response.json({ choices: [{ message: { content, tool_calls: [call] }, finish_reason: "tool_calls" }] }), createTestTranslatorBudget()));
    else {
      const frames = [...content].map(frameContent => ({ choices: [{ delta: { content: frameContent } }] }));
      const wire = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")
        + `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] } }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
      for await (const event of adapter.parseStream(new Response(wire))) events.push(event);
    }
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe(prefix);
    expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(1);
    expect(events.filter(event => event.type === "tool_call_delta").map(event => event.arguments).join("")).toBe(JSON.stringify({ input }));
  });
}
