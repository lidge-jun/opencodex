import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { buildResponseJSON } from "../../../src/bridge";
import { createTranslatorBudget, releaseTranslatedEvent, type TranslatorBudget } from "../../../src/lib/translator-budget";
import { parseRequest } from "../../../src/responses/parser";
import type { AdapterEvent } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const BASE_URL = "https://api.mistral.ai/v1";
const MODEL = "zai-glm-5-3";
const ANSWER = '{"outcome":"deny"}';
const USAGE = { prompt_tokens: 10, completion_tokens: 5 };
const thinking = (text: string) => ({ type: "thinking", thinking: [{ type: "text", text }], closed: true });
const text = (value: string) => ({ type: "text", text: value });
const terminal = { choices: [{ delta: {}, finish_reason: "stop" }], usage: USAGE };

function adapter(baseUrl = BASE_URL) {
  return createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl });
}

function streamResponse(chunks: unknown[]): Response {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
}

function responsePayload(content: unknown) {
  return { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: USAGE };
}

async function collect(chunks: unknown[], budget = createTestTranslatorBudget(), baseUrl = BASE_URL) {
  const events: AdapterEvent[] = [];
  for await (const event of adapter(baseUrl).parseStream(streamResponse(chunks), budget)) {
    if (event.type !== "heartbeat") events.push(event);
  }
  return events;
}

function joined(events: AdapterEvent[], type: "text_delta" | "reasoning_raw_delta") {
  return events.filter(event => event.type === type).map(event => ("text" in event ? event.text : "")).join("");
}

async function parse(mode: "stream" | "buffered", content: unknown, baseUrl = BASE_URL) {
  return mode === "stream"
    ? collect([{ choices: [{ delta: { content } }], usage: USAGE }, terminal], undefined, baseUrl)
    : adapter(baseUrl).parseResponse!(Response.json(responsePayload(content)), createTestTranslatorBudget());
}

describe("Mistral typed response content", () => {
  test("mixed array and string deltas preserve the JSON prefix", async () => {
    const events = await collect([
      { choices: [{ delta: { content: [thinking("Synthetic reasoning."), text('{"outcome')] } }] },
      { choices: [{ delta: { content: '":"deny"}' } }] },
      terminal,
    ]);
    expect(joined(events, "text_delta")).toBe(ANSWER);
    expect(JSON.parse(joined(events, "text_delta"))).toEqual({ outcome: "deny" });
    expect(joined(events, "reasoning_raw_delta")).toBe("Synthetic reasoning.");
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 10, outputTokens: 5 } });
    const response = buildResponseJSON(events, MODEL);
    expect(response.output).toContainEqual(expect.objectContaining({ type: "message", content: [{ type: "output_text", text: ANSWER, annotations: [] }] }));
  });

  for (const mode of ["stream", "buffered"] as const) {
    test(`${mode}: text and thinking remain in source order`, async () => {
      const events = await parse(mode, [text("A\n"), thinking("first"), text("B😀"), thinking("second"), text(" C")]);
      expect(events.filter(event => event.type !== "done")).toEqual([
        { type: "text_delta", text: "A\n" }, { type: "reasoning_raw_delta", text: "first" },
        { type: "text_delta", text: "B😀" }, { type: "reasoning_raw_delta", text: "second" },
        { type: "text_delta", text: " C" },
      ]);
    });

    test(`${mode}: complete typed JSON becomes complete Responses text`, async () => {
      const events = await parse(mode, [thinking("Synthetic reasoning."), text(ANSWER)]);
      expect(joined(events, "text_delta")).toBe(ANSWER);
      expect(joined(events, "reasoning_raw_delta")).toBe("Synthetic reasoning.");
      expect(events.at(-1)?.type).toBe("done");
    });

    test.each([BASE_URL, "https://api.openai.com/v1"])(`${mode}: ordinary strings remain unchanged at %s`, async baseUrl => {
      const events = await parse(mode, ANSWER, baseUrl);
      expect(joined(events, "text_delta")).toBe(ANSWER);
      expect(joined(events, "reasoning_raw_delta")).toBe("");
    });

    test.each(["https://api.openai.com/v1", "https://api.mistral.ai.example.test/v1", "https://example.test/api.mistral.ai/v1"])(`${mode}: array handling is limited to the Mistral host (%s)`, async baseUrl => {
      const events = await parse(mode, [thinking("Synthetic reasoning."), text(ANSWER)], baseUrl);
      expect(joined(events, "text_delta")).toBe("");
      expect(joined(events, "reasoning_raw_delta")).toBe("");
      expect(events.at(-1)?.type).toBe("done");
    });

    test.each([[null], [[]], [[thinking("")]]])(`${mode}: empty content remains valid (%j)`, async content => {
      const events = await parse(mode, content);
      expect(joined(events, "text_delta")).toBe("");
      expect(joined(events, "reasoning_raw_delta")).toBe("");
      expect(events.at(-1)?.type).toBe("done");
    });

    test.each([
      [null], [7], [{ type: "text", text: 7 }], [{ type: "image_url", image_url: "fixture" }],
      [{ type: "thinking", thinking: null }], [{ type: "thinking", thinking: [null] }],
      [{ type: "thinking", thinking: [{ type: "text", text: 7 }] }],
      [{ type: "thinking", thinking: [{ type: "image", text: "fixture" }] }],
    ])(`${mode}: malformed or unsupported blocks fail (%j)`, async block => {
      // A valid prefix must not escape from an invalid content array.
      const events = await parse(mode, [text("do not release this prefix"), block]);
      expect(events).toEqual([{ type: "error", status: 502, errorType: "upstream_error",
        message: "unsupported Mistral content block", usage: { inputTokens: 10, outputTokens: 5 } }]);
    });
  }

  test("empty stream padding does not count as output at a truncated EOF", async () => {
    const events: AdapterEvent[] = [];
    const response = new Response('data: {"choices":[{"delta":{"content":""}}]}\n\n');
    for await (const event of adapter().parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("empty buffered strings retain their existing empty text event", async () => {
    const events = await parse("buffered", "");
    expect(events[0]).toEqual({ type: "text_delta", text: "" });
  });

  test("thinking supports several typed text items", async () => {
    const events = await parse("stream", [{ type: "thinking", thinking: [text("one"), text("two")] }, text(ANSWER)]);
    expect(joined(events, "reasoning_raw_delta")).toBe("onetwo");
    expect(joined(events, "text_delta")).toBe(ANSWER);
  });

  test.each(["stream", "buffered"] as const)("%s: inline thinking tags can cross typed text blocks", async mode => {
    const provider = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: BASE_URL, inlineThinkTagModels: [MODEL] });
    await provider.buildRequest(parseRequest({ model: MODEL, input: "fixture" }));
    const content = [text("<thi"), text("nk>inner</thi"), text("nk>answer")];
    const budget = createTestTranslatorBudget();
    const events: AdapterEvent[] = mode === "buffered"
      ? await provider.parseResponse!(Response.json(responsePayload(content)), budget)
      : [];
    if (mode === "stream") {
      for await (const event of provider.parseStream(streamResponse([{ choices: [{ delta: { content } }] }, terminal]), budget)) events.push(event);
    }
    expect(joined(events, "reasoning_raw_delta")).toBe("inner");
    expect(joined(events, "text_delta")).toBe("answer");
  });

  for (const mode of ["stream", "buffered"] as const) {
    test.each([
      { name: "partial opening tag", content: [text("<thi"), thinking("typed"), text("nk>answer</think>")],
        answer: "<think>answer</think>", reasoning: "typed",
        leading: { type: "text_delta", text: "<thi" }, trailing: "nk>answer</think>" },
      { name: "open thinking block", content: [text("<think>before"), thinking("typed"), text("answer")],
        answer: "answer", reasoning: "beforetyped",
        leading: { type: "reasoning_raw_delta", text: "before" }, trailing: "answer" },
    ])(`${mode}: typed reasoning ends inline-tag parsing ($name)`, async ({ content, answer, reasoning, leading, trailing }) => {
      const provider = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: BASE_URL, inlineThinkTagModels: [MODEL] });
      await provider.buildRequest(parseRequest({ model: MODEL, input: "fixture" }));
      const budget = createTestTranslatorBudget();
      const events: AdapterEvent[] = mode === "buffered"
        ? await provider.parseResponse!(Response.json(responsePayload(content)), budget)
        : [];
      if (mode === "stream") {
        // Separate deltas also test carry ownership across SSE chunks.
        const chunks = content.map(block => ({ choices: [{ delta: { content: [block] } }] }));
        for await (const event of provider.parseStream(streamResponse([...chunks, terminal]), budget)) events.push(event);
      }
      expect(joined(events, "text_delta")).toBe(answer);
      expect(joined(events, "reasoning_raw_delta")).toBe(reasoning);
      expect(events.filter(event => event.type !== "done")).toEqual([
        leading,
        { type: "reasoning_raw_delta", text: "typed" },
        { type: "text_delta", text: trailing },
      ]);
      for (const event of events) releaseTranslatedEvent(event, budget);
      expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
    });
  }

  test("typed reasoning and a tool call cross Responses continuation", async () => {
    const events = await collect([
      { choices: [{ delta: { content: [thinking("Inspect the file."), text("Checking.")],
        tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read_file", arguments: '{"path":"fixture.txt"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: USAGE },
    ]);
    const response = buildResponseJSON(events, MODEL, { hideThinkingSummary: true });
    const next = parseRequest({ model: MODEL, input: [...response.output,
      { type: "function_call_output", call_id: "call_read", output: "fixture result" }] });
    expect(next.context.messages.some(message => message.role === "assistant" && message.content.some(
      part => part.type === "thinking" && part.thinking === "Inspect the file.",
    ))).toBe(true);
    const wire = JSON.parse((await adapter().buildRequest(next)).body);
    expect(wire.messages).toContainEqual(expect.objectContaining({ role: "assistant", tool_calls: [
      { id: "call_read", type: "function", function: { name: "read_file", arguments: '{"path":"fixture.txt"}' } },
    ] }));
    expect(wire.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "call_read", content: "fixture result" }));
    expect(joined(events, "text_delta")).toBe("Checking.");
  });

  test("invalid typed content discards an open tool call", async () => {
    const events = await collect([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read_file", arguments: "{}" } }] } }] },
      { choices: [{ delta: { content: [{ type: "text", text: 7 }] } }], usage: USAGE },
      terminal,
    ]);
    expect(events.some(event => event.type === "tool_call_start" || event.type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502 });
  });

  test("buffered typed output keeps event-byte accounting and releases its leases", async () => {
    const budget = createTestTranslatorBudget();
    const events = await adapter().parseResponse!(Response.json(responsePayload([thinking("why"), text(ANSWER)])), budget);
    expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(JSON.stringify(events)));
    for (const event of events) releaseTranslatedEvent(event, budget);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("buffered typed events cannot exceed the translator budget", async () => {
    const payload = responsePayload([thinking("why"), text(ANSWER)]);
    const budget = createTestTranslatorBudget({ maxTurnBytes: Buffer.byteLength(JSON.stringify(payload)) + 1 });
    await expect(adapter().parseResponse!(Response.json(payload), budget)).rejects.toThrow(/translator/);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, overflows: 1 });
  });

  test("stream overflow cancels the reader and releases tool and text buffers", async () => {
    const budget = createTranslatorBudget({ maxTurnBytes: 512 });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: {
          content: [thinking("x".repeat(1024)), text(ANSWER)],
        } }] })}\n\n`));
      },
      cancel() { cancelled = true; },
    });
    try {
      const events: AdapterEvent[] = [];
      for await (const event of adapter().parseStream(new Response(body), budget)) events.push(event);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "translation_buffer_limit" }));
      expect(cancelled).toBe(true);
      expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0, overflows: 1 });
    } finally {
      budget.dispose();
    }
  });
});
