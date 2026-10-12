import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { SerializedToolCallContentBuffer } from "../../../src/adapters/openai-chat/serialized-tool-call-content";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";

/**
 * Serialized tool-call reconciliation (#5548) composed with inline <think> splitting: the
 * reconciler only ever sees answer text, so reasoning is never held or stripped, and a block
 * whose input differs from the structured call stays visible byte for byte.
 */
const MODEL = "mimo-v2.6-flash";
const SCRIPT = "text('ok');";
const block = (body: string): string => `<tool_call><function=exec>${body}\n</parameter></function></tool_call>`;
const call = (input: string) => ({ index: 0, id: "call_exec", function: { name: "exec", arguments: JSON.stringify({ input }) } });

function adapterFor(inlineThink: boolean) {
  const provider: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://gateway.example.test/v1",
    apiKey: "key",
    ...(inlineThink ? { inlineThinkTagModels: [MODEL] } : {}),
  };
  const adapter = withTestTranslatorBudget(createOpenAIChatAdapter(provider));
  const parsed: OcxParsedRequest = {
    modelId: MODEL,
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
  };
  adapter.buildRequest(parsed);
  return adapter;
}

async function streamed(inlineThink: boolean, content: string[], input: string): Promise<AdapterEvent[]> {
  const frames = [
    ...content.map(text => ({ choices: [{ delta: { content: text } }] })),
    { choices: [{ delta: { tool_calls: [call(input)] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  const events: AdapterEvent[] = [];
  for await (const event of adapterFor(inlineThink).parseStream(new Response(body))) {
    if (event.type !== "heartbeat") events.push(event);
  }
  return events;
}

async function buffered(inlineThink: boolean, content: string, input: string): Promise<AdapterEvent[]> {
  return adapterFor(inlineThink).parseResponse!(Response.json({
    choices: [{ message: { content, tool_calls: [call(input)] }, finish_reason: "tool_calls" }],
  }));
}

const joined = (events: AdapterEvent[], type: "text_delta" | "reasoning_raw_delta"): string => events
  .filter((event): event is Extract<AdapterEvent, { type: typeof type; text: string }> => event.type === type)
  .map(event => event.text)
  .join("");
const argsOf = (events: AdapterEvent[]): string => events
  .filter((event): event is Extract<AdapterEvent, { type: "tool_call_delta" }> => event.type === "tool_call_delta")
  .map(event => event.arguments)
  .join("");
const toolStarts = (events: AdapterEvent[]): number => events.filter(event => event.type === "tool_call_start").length;

describe("serialized tool-call reconciliation behind inline <think> splitting", () => {
  test("a duplicated block after a think block is removed while reasoning is kept, streamed and buffered", async () => {
    const content = "<think>plan the call</think>Running it.\n" + block(SCRIPT);
    const runs = [
      await streamed(true, ["<think>plan the ", "call</think>Running it.\n", block(SCRIPT)], SCRIPT),
      await buffered(true, content, SCRIPT),
    ];
    for (const events of runs) {
      expect(joined(events, "reasoning_raw_delta")).toBe("plan the call");
      expect(joined(events, "text_delta")).toBe("Running it.\n");
      expect(argsOf(events)).toBe(JSON.stringify({ input: SCRIPT }));
      expect(toolStarts(events)).toBe(1);
      expect(events.some(event => event.type === "error")).toBe(false);
      const reasoningAt = events.findIndex(event => event.type === "reasoning_raw_delta");
      const textAt = events.findIndex(event => event.type === "text_delta");
      expect(reasoningAt).toBeGreaterThanOrEqual(0);
      expect(reasoningAt).toBeLessThan(textAt);
    }
  });

  test("a block whose input differs from the structured call stays visible byte for byte", async () => {
    const shown = "Example:\n" + block("text('example');");
    const runs = [
      await streamed(true, ["<think>x</think>", shown], SCRIPT),
      await buffered(true, "<think>x</think>" + shown, SCRIPT),
      await streamed(false, [shown], SCRIPT),
      await buffered(false, shown, SCRIPT),
    ];
    for (const events of runs) {
      expect(joined(events, "text_delta")).toBe(shown);
      expect(argsOf(events)).toBe(JSON.stringify({ input: SCRIPT }));
      expect(toolStarts(events)).toBe(1);
    }
  });

  test("without the inline-think opt-in a literal think tag stays answer text and the duplicate is still removed", async () => {
    const lead = "<think>not parsed here</think>Running it.\n";
    for (const events of [await streamed(false, [lead, block(SCRIPT)], SCRIPT), await buffered(false, lead + block(SCRIPT), SCRIPT)]) {
      expect(joined(events, "reasoning_raw_delta")).toBe("");
      expect(joined(events, "text_delta")).toBe(lead);
      expect(toolStarts(events)).toBe(1);
    }
  });
});


describe("review folds: order and line context across interleaved think sections", () => {
  test("a block that follows visible prose on the same line is kept even when a think section sits between them", async () => {
    const content = "<think>r1</think>prefix <think>r2</think>" + block(SCRIPT);
    const runs = [
      await buffered(true, content, SCRIPT),
      await streamed(true, ["<think>r1</think>prefix ", "<think>r2</think>", block(SCRIPT)], SCRIPT),
    ];
    for (const events of runs) {
      expect(joined(events, "reasoning_raw_delta")).toBe("r1r2");
      expect(joined(events, "text_delta")).toBe("prefix " + block(SCRIPT));
      expect(toolStarts(events)).toBe(1);
    }
  });

  test("held text is released before later reasoning, so events keep their original order", async () => {
    const shown = "\n" + block("text('example');");
    const runs = [
      await streamed(true, ["<think>first</think>", shown, "<think>second</think>", "answer"], SCRIPT),
      await buffered(true, "<think>first</think>" + shown + "<think>second</think>answer", SCRIPT),
    ];
    for (const events of runs) {
      const order = events
        .filter(event => event.type === "text_delta" || event.type === "reasoning_raw_delta")
        .map(event => (event.type === "text_delta" ? "T:" : "R:") + (event as { text: string }).text);
      const firstShown = order.findIndex(item => item.startsWith("T:") && item.includes("<tool_call>"));
      const secondReasoning = order.findIndex(item => item.startsWith("R:") && item.includes("second"));
      expect(order[0]).toBe("R:first");
      expect(firstShown).toBeGreaterThan(0);
      expect(firstShown).toBeLessThan(secondReasoning);
      expect(joined(events, "text_delta")).toBe(shown + "answer");
    }
  });
});


describe("review folds, round two", () => {
  test("a duplicate between two think sections stays suppressed when its structured call arrives later", async () => {
    const runs = [
      await streamed(true, ["<think>r1</think>", block(SCRIPT), "<think>r2</think>"], SCRIPT),
      await buffered(true, "<think>r1</think>" + block(SCRIPT) + "<think>r2</think>", SCRIPT),
    ];
    for (const events of runs) {
      expect(joined(events, "text_delta")).not.toContain("<tool_call>");
      const reasoning = events.filter(event => event.type === "reasoning_raw_delta").map(event => (event as { text: string }).text);
      expect(reasoning.join("")).toBe("r1r2");
      expect(toolStarts(events)).toBe(1);
      expect(argsOf(events)).toBe(JSON.stringify({ input: SCRIPT }));
    }
  });

  test("after a drain, a second block on the same visible line is not treated as line-start markup", () => {
    const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
    try {
      const first = block("text('a');");
      expect(buffer.ingest(first)).toBe("");
      expect(buffer.flush([])).toBe(first);
      const second = block(SCRIPT);
      // Mid-line after the first block, so it is ordinary text and cannot be held or removed.
      expect(buffer.ingest(second)).toBe(second);
      const names = new Set(["exec"]);
      expect(buffer.flush([{ names, argumentsText: JSON.stringify({ input: SCRIPT }) }])).toBe("");
    } finally {
      buffer.dispose();
    }
  });
});


describe("review folds, round three", () => {
  test("every reasoning frame that arrives behind a held block still yields adapter activity", async () => {
    const frames = [
      { choices: [{ delta: { content: "<tool_call><function=exec>" + SCRIPT } }] },
      { choices: [{ delta: { reasoning_content: "one" } }] },
      { choices: [{ delta: { reasoning_content: "two" } }] },
      { choices: [{ delta: { content: "\n</parameter></function></tool_call>" } }] },
      { choices: [{ delta: { tool_calls: [call(SCRIPT)] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const body = frames.map(frame => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n";
    const events: AdapterEvent[] = [];
    for await (const event of adapterFor(false).parseStream(new Response(body))) events.push(event);
    const heartbeats = events.filter(event => event.type === "heartbeat").length;
    // One for the held content frame, one per queued reasoning frame, one for the closing content frame.
    expect(heartbeats).toBeGreaterThanOrEqual(4);
    expect(joined(events, "reasoning_raw_delta")).toBe("onetwo");
    expect(joined(events, "text_delta")).toBe("");
    expect(toolStarts(events)).toBe(1);
  });
});
