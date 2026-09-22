import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../../../src/adapters/openai-chat";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import { buildResponseJSON } from "../../../src/bridge";
import { parseRequest } from "../../../src/responses/parser";
import { decodeReasoningEnvelope } from "../../../src/responses/reasoning-envelope";

const MODEL = "GLM-5.3-Flash";

function provider(optIn: boolean): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    apiKey: "key",
    ...(optIn ? { inlineThinkTagModels: [MODEL] } : {}),
  };
}

function parsed(): OcxParsedRequest {
  return {
    modelId: MODEL,
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
  };
}

/** parseStream gates on the routed model, which buildRequest records. */
function adapterFor(optIn: boolean) {
  const adapter = withTestTranslatorBudget(createOpenAIChatAdapterProduction(provider(optIn)));
  adapter.buildRequest(parsed());
  return adapter;
}

function sse(...contents: string[]): Response {
  const lines = contents.map(text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  lines.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n");
  return new Response(lines.join(""));
}

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const event of gen) if (event.type !== "heartbeat") out.push(event);
  return out;
}

function joined(events: AdapterEvent[], type: "text_delta" | "reasoning_raw_delta"): string {
  return events
    .filter((event): event is Extract<AdapterEvent, { type: typeof type; text: string }> => event.type === type)
    .map(event => event.text)
    .join("");
}

describe("openai-chat inline <think> recovery", () => {
  test.each(["none", undefined])("inline reasoning crosses display and next-turn replay with summary %s", async summary => {
    const request = parseRequest({ model: MODEL, input: [], reasoning: { effort: "high", summary } });
    const events = await collect(adapterFor(true).parseStream(sse("<think>replay me</think>answer")));
    const response = buildResponseJSON(events, MODEL, { hideThinkingSummary: request.options.hideThinkingSummary });
    const output = (response as { output: Record<string, unknown>[] }).output;
    const item = output.find(o => o.type === "reasoning")!;
    expect(item.summary).toEqual([]);
    if (summary === "none") {
      expect(item.content).toBeUndefined();
      expect(decodeReasoningEnvelope(item.encrypted_content as string)?.txt).toBe("replay me");
    } else {
      expect(item.content).toEqual([{ type: "reasoning_text", text: "replay me" }]);
    }
    const next = parseRequest({ model: MODEL, input: [...output, { type: "message", role: "user", content: "next" }] });
    const replayAdapter = withTestTranslatorBudget(createOpenAIChatAdapterProduction({
      ...provider(true), preserveReasoningContentModels: [MODEL],
    }));
    const wire = JSON.parse(replayAdapter.buildRequest(next).body);
    expect(wire.messages.find((m: { role: string }) => m.role === "assistant").reasoning_content).toBe("replay me");
  });
  test("a gateway without a reasoning parser has its thinking split out of the answer", async () => {
    const events = await collect(adapterFor(true).parseStream(
      sse("<think>weigh", "ing it up</think>", "OCX_THINK_OK"),
    ));

    expect(joined(events, "reasoning_raw_delta")).toBe("weighing it up");
    expect(joined(events, "text_delta")).toBe("OCX_THINK_OK");
    expect(events.at(-1)?.type).toBe("done");
  });

  test("a tag split across chunk boundaries is still recognized", async () => {
    const events = await collect(adapterFor(true).parseStream(
      sse("<thi", "nk>why</thi", "nk>answer"),
    ));

    expect(joined(events, "reasoning_raw_delta")).toBe("why");
    expect(joined(events, "text_delta")).toBe("answer");
  });

  test("interleaved blocks keep every later thought out of the answer", async () => {
    const events = await collect(adapterFor(true).parseStream(
      sse("<think>first</think>", "part one ", "<think>second</think>", "part two"),
    ));

    expect(joined(events, "reasoning_raw_delta")).toBe("firstsecond");
    expect(joined(events, "text_delta")).toBe("part one part two");
  });

  test("a response that opens with ordinary text is never rewritten", async () => {
    const answer = "A model may discuss a <think> tag without thinking in it.";
    const events = await collect(adapterFor(true).parseStream(sse(answer)));

    expect(joined(events, "text_delta")).toBe(answer);
    expect(events.some(event => event.type === "reasoning_raw_delta")).toBe(false);
  });

  test("the initial blank line and the answer's own indentation both survive", async () => {
    const events = await collect(adapterFor(true).parseStream(
      sse("<think>plan</think>\n\nUse this:\n", "<think>check</think>", "    indented line"),
    ));

    expect(joined(events, "reasoning_raw_delta")).toBe("plancheck");
    expect(joined(events, "text_delta")).toBe("\n\nUse this:\n    indented line");
  });

  test("an unterminated block is flushed as reasoning rather than lost", async () => {
    const events = await collect(adapterFor(true).parseStream(
      sse("<think>cut off mid thought"),
    ));

    expect(joined(events, "reasoning_raw_delta")).toBe("cut off mid thought");
    expect(joined(events, "text_delta")).toBe("");
  });

  test("without the opt-in the same stream stays byte-exact visible content", async () => {
    const events = await collect(adapterFor(false).parseStream(
      sse("<think>weighing it up</think>", "OCX_THINK_OK"),
    ));

    expect(joined(events, "text_delta")).toBe("<think>weighing it up</think>OCX_THINK_OK");
    expect(events.some(event => event.type === "reasoning_raw_delta")).toBe(false);
  });

  test("the non-streaming path splits the same way", async () => {
    const adapter = adapterFor(true);
    const response = new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "<think>quietly</think>OCX_THINK_OK" } }],
    }), { headers: { "content-type": "application/json" } });

    const events = await adapter.parseResponse(response);

    expect(joined(events, "reasoning_raw_delta")).toBe("quietly");
    expect(joined(events, "text_delta")).toBe("OCX_THINK_OK");
  });
});
