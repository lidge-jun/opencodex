import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter as productionAdapter } from "../../../src/adapters/anthropic";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../../src/bridge";
import { responsesJsonToChatCompletion, responsesSseToChatCompletionsSse } from "../../../src/chat/outbound";
import type { AdapterEvent, OcxUsage } from "../../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";

const adapter = () => withTestTranslatorBudget(productionAdapter({
  adapter: "anthropic", baseUrl: "https://example.test", apiKey: "synthetic-key", authMode: "key",
}));
const counts = { input_tokens: 10, output_tokens: 292, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };
const details = { thinking_tokens: 156 };

function terminalUsage(events: AdapterEvent[]): OcxUsage | undefined {
  const terminal = events.find(e => e.type === "done" || e.type === "error" || e.type === "incomplete");
  expect(terminal).toBeDefined();
  return terminal && "usage" in terminal ? terminal.usage : undefined;
}

async function buffered(usage: unknown, stop = "end_turn"): Promise<AdapterEvent[]> {
  return await adapter().parseResponse!(Response.json({
    content: [{ type: "text", text: "ok" }], stop_reason: stop, usage,
  })) as AdapterEvent[];
}

function streamResponse(usage: Record<string, unknown>, stop = "end_turn", eof = false): Response {
  const frames = [
    { type: "message_start", message: { usage: { ...counts, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", usage: { output_tokens: 100, output_tokens_details: { thinking_tokens: 50 } } },
    { type: "message_delta", delta: { stop_reason: stop }, usage },
    ...(eof ? [] : [{ type: "message_stop" }]),
  ].map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join("");
  const bytes = new TextEncoder().encode(frames);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 23) controller.enqueue(bytes.slice(i, i + 23));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function streaming(usage: Record<string, unknown>, stop = "end_turn", eof = false): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of adapter().parseStream(streamResponse(usage, stop, eof))) events.push(event);
  return events;
}

describe("Anthropic reported thinking usage (#6719)", () => {
  test("buffered usage reaches Responses and Chat without double-counting output", async () => {
    const events = await buffered({ ...counts, output_tokens_details: details });
    expect(terminalUsage(events)).toEqual({
      inputTokens: 15, outputTokens: 292, reasoningOutputTokens: 156,
      cachedInputTokens: 3, cacheReadInputTokens: 3, cacheCreationInputTokens: 2,
    });
    const json = buildResponseJSON(events, "anthropic/claude-test");
    expect(json.usage).toMatchObject({ output_tokens: 292, total_tokens: 307, output_tokens_details: { reasoning_tokens: 156 } });
    expect(responsesJsonToChatCompletion(json, "anthropic/claude-test").usage).toMatchObject({
      completion_tokens: 292, total_tokens: 307, completion_tokens_details: { reasoning_tokens: 156 },
    });
  });

  test.each([false, true])("final cumulative usage replaces the interim breakdown; EOF=%s", async eof => {
    const events = await streaming({ output_tokens: 292, output_tokens_details: details }, "end_turn", eof);
    expect(terminalUsage(events)).toMatchObject({ inputTokens: 15, outputTokens: 292, reasoningOutputTokens: 156 });
    expect(events.filter(e => e.type === "done")).toHaveLength(1);
  });

  test("streamed Responses and Chat terminal usage retain the reported breakdown", async () => {
    const responseBudget = createTestTranslatorBudget();
    const responseStream = bridgeToResponsesSSE(adapter().parseStream(streamResponse({ output_tokens: 292, output_tokens_details: details })), "anthropic/claude-test", undefined, undefined, undefined, undefined, 2000, { translatorBudget: responseBudget });
    const responseText = await new Response(responseStream).text();
    const terminal = responseText.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(e => e.type === "response.completed");
    expect(terminal.response.usage).toMatchObject({ output_tokens: 292, output_tokens_details: { reasoning_tokens: 156 } });
    const chatStream = responsesSseToChatCompletionsSse(
      bridgeToResponsesSSE(adapter().parseStream(streamResponse({ output_tokens: 292, output_tokens_details: details })), "anthropic/claude-test", undefined, undefined, undefined, undefined, 2000, { translatorBudget: createTestTranslatorBudget() }),
      "anthropic/claude-test", { translatorBudget: createTestTranslatorBudget() },
    );
    const chatText = await new Response(chatStream).text();
    const usage = chatText.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(e => e.usage)?.usage;
    expect(usage).toMatchObject({ completion_tokens: 292, completion_tokens_details: { reasoning_tokens: 156 } });
    expect(chatText).toContain("[DONE]");
  });

  test.each(["max_tokens", "refusal", "error"])("preserves usage on %s in both parsers", async stop => {
    for (const events of [await buffered({ ...counts, output_tokens_details: details }, stop), await streaming({ output_tokens: 292, output_tokens_details: details }, stop)]) {
      expect(terminalUsage(events)).toMatchObject({ outputTokens: 292, reasoningOutputTokens: 156 });
      expect(events.filter(e => e.type === "done" || e.type === "error" || e.type === "incomplete")).toHaveLength(1);
    }
  });

  test("zero is reported while absent details remain unreported internally", async () => {
    expect(terminalUsage(await buffered({ ...counts, output_tokens_details: { thinking_tokens: 0 } }))?.reasoningOutputTokens).toBe(0);
    expect(terminalUsage(await buffered(counts))).not.toHaveProperty("reasoningOutputTokens");
    expect(terminalUsage(await buffered({}))).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test.each([null, [], "details", {}, { thinking_tokens: "156" }, { thinking_tokens: null }, { thinking_tokens: -1 }, { thinking_tokens: true }, { thinking_tokens: 293 }].map(outputDetails => ({ outputDetails })))(
    "ignores malformed optional breakdown %j without discarding valid totals", async ({ outputDetails }) => {
      for (const events of [await buffered({ ...counts, output_tokens_details: outputDetails }), await streaming({ output_tokens: 292, output_tokens_details: outputDetails })]) {
        expect(terminalUsage(events)).toEqual({
          inputTokens: 15, outputTokens: 292, cachedInputTokens: 3, cacheReadInputTokens: 3, cacheCreationInputTokens: 2,
        });
      }
    },
  );

  test("a thinking breakdown cannot resurrect invalid cumulative totals", async () => {
    expect(terminalUsage(await streaming({ output_tokens: "invalid", output_tokens_details: details }))).toBeUndefined();
  });
});
