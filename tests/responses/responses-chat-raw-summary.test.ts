import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { decodeReasoningEnvelope, encodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { parseRequest } from "../../src/responses/parser";
import { routeModel } from "../../src/router";
import { applyFinalRouteRequestNormalization } from "../../src/server/responses/core-normalize";
import { handleResponses } from "../../src/server/responses/core";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// The first request initializes the isolated runtime on cold Windows workers.
setDefaultTimeout(30_000);

const RAW = "raw reasoning, not a provider-authored summary";
const provider = (extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig => ({
  adapter: "openai-chat", baseUrl: "https://reasoner.test/v1", apiKey: "sk-test",
  models: ["reasoner"], ...extra,
});
const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
afterEach(() => {
  globalThis.fetch = originalFetch;
  releaseSpendHome?.();
  releaseSpendHome = undefined;
});

function frames(text: string): Record<string, any>[] {
  return text.split("\n\n").flatMap(block => {
    const data = block.split("\n").find(line => line.startsWith("data: "))?.slice(6);
    return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
  });
}

async function dispatch(stream: boolean, extra: Partial<OcxProviderConfig>, reasoning?: unknown) {
  releaseSpendHome?.();
  releaseSpendHome = acquireOwnedSpendHome();
  const chunk = (delta: unknown, finish_reason: string | null = null) => "data: " + JSON.stringify({
    id: "cmpl_1", choices: [{ index: 0, delta, finish_reason }],
  }) + "\n\n";
  globalThis.fetch = (async () => new Response(stream
    ? chunk({ reasoning_content: RAW }) + chunk({ content: "OK" }) + chunk({}, "stop") + "data: [DONE]\n\n"
    : JSON.stringify({ choices: [{ index: 0, finish_reason: "stop",
      message: { role: "assistant", content: "OK", reasoning_content: RAW } }] }),
  { headers: { "content-type": stream ? "text/event-stream" : "application/json" } })) as typeof fetch;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "reasoner/reasoner", input: "ping", stream, reasoning }),
  }), { providers: { reasoner: provider(extra) } } as OcxConfig, { model: "", provider: "" },
  { abortSignal: AbortSignal.timeout(20_000) });
  expect(response.status).toBe(200);
  const text = await response.text();
  return { text, output: stream ? frames(text).find(f => f.type === "response.completed")?.response.output
    : JSON.parse(text).output };
}

describe("Chat rawReasoningAsSummary compatibility opt-in", () => {
  for (const stream of [true, false]) {
    test(`${stream ? "streamed" : "buffered"}: opt-in exposes raw text on the summary channel`, async () => {
      const { text, output } = await dispatch(stream, { rawReasoningAsSummary: true });
      const item = output.find((o: any) => o.type === "reasoning");
      expect(item.summary).toEqual([{ type: "summary_text", text: RAW }]);
      expect(item.content).toBeUndefined();
      expect(decodeReasoningEnvelope(item.encrypted_content)).toEqual({ txt: RAW, rawSummary: true });
      expect(output.find((o: any) => o.type === "message").content[0].text).toBe("OK");
      if (stream) {
        const events = frames(text);
        expect(events.filter(f => f.type === "response.reasoning_summary_text.delta").map(f => f.delta)).toEqual([RAW]);
        expect(events.some(f => f.type === "response.reasoning_summary_part.added")).toBe(true);
        expect(events.some(f => f.type === "response.reasoning_summary_part.done")).toBe(true);
        expect(events.find(f => f.type === "response.reasoning_summary_text.done")).toMatchObject({
          summary_index: 0, text: RAW,
        });
        expect(events.some(f => f.type === "response.reasoning_text.delta")).toBe(false);
      }
    });

    test(`${stream}: default and explicit false preserve the content channel`, async () => {
      for (const extra of [{}, { rawReasoningAsSummary: false }]) {
        const { output } = await dispatch(stream, extra, { summary: "auto" });
        expect(output[0].summary).toEqual([]);
        expect(output[0].content).toEqual([{ type: "reasoning_text", text: RAW }]);
      }
    });

    test(`${stream}: echoed raw summaries obey the native destination's plaintext replay policy`, async () => {
      const upstreamSummary = { type: "reasoning", summary: [{ type: "summary_text", text: "provider summary" }] };
      for (const preserve of [false, true]) {
        const native = createResponsesPassthroughAdapter(provider({
          adapter: "openai-responses", preserveResponsesReasoningContent: preserve,
        }));
        for (const enabled of [false, true]) {
          const { output } = await dispatch(stream, { rawReasoningAsSummary: enabled }, { summary: "auto" });
          const parsed = parseRequest({ model: "reasoner", input: [output[0], upstreamSummary, {
            role: "user", content: "continue",
          }] });
          parsed._stripReasoningEncryptedContent = true;
          parsed._dropForeignReasoningItemIds = true;
          const translatorBudget = createTranslatorBudget();
          let items;
          try {
            items = JSON.parse(native.buildRequest(parsed, { headers: new Headers(), translatorBudget }).body).input;
          } finally {
            translatorBudget.dispose();
          }
          expect(items[0]).toEqual({
            type: "reasoning", summary: [], content: preserve ? [{ type: "reasoning_text", text: RAW }] : [],
          });
          expect(items[1]).toEqual(upstreamSummary);
        }
      }
    });

    test(`${stream}: summary none and hideRawReasoning override opt-in`, async () => {
      for (const hidden of [false, true]) {
        const { text, output } = await dispatch(stream, { rawReasoningAsSummary: true, hideRawReasoning: hidden },
          { summary: hidden ? "auto" : "none", effort: "high" });
        expect(output[0].summary).toEqual([]);
        expect(output[0].content).toBeUndefined();
        expect(decodeReasoningEnvelope(output[0].encrypted_content)?.txt).toBe(RAW);
        if (stream) expect(frames(text).some(f => f.type === "response.reasoning_summary_text.delta")).toBe(false);
      }
    });
  }

  test("native replay recognizes an older display copy and preserves signed provider summaries", () => {
    const makeItem = (encrypted_content: string) => ({
      type: "reasoning", summary: [{ type: "summary_text", text: RAW }], encrypted_content,
    });
    const parsed = parseRequest({ model: "reasoner", input: [
      makeItem(encodeReasoningEnvelope({ txt: RAW })),
      makeItem(encodeReasoningEnvelope({ sig: "fixture-signature", txt: RAW })),
    ] });
    const native = createResponsesPassthroughAdapter(provider({ adapter: "openai-responses" }));
    const translatorBudget = createTranslatorBudget();
    try {
      const { input } = JSON.parse(native.buildRequest(parsed, { headers: new Headers(), translatorBudget }).body);
      expect(input.map((item: any) => item.summary)).toEqual([[], [{ type: "summary_text", text: RAW }]]);
    } finally {
      translatorBudget.dispose();
    }
  });

  test("renormalizing one request resets opt-in on fallback, other adapters and inbound wires", async () => {
    const config = { providers: { on: provider({ rawReasoningAsSummary: true }), off: provider(),
      native: provider({ adapter: "openai-responses", rawReasoningAsSummary: true }) } } as OcxConfig;
    const parsed = parseRequest({ model: "on/reasoner", input: [] });
    for (const [name, inboundWire, enabled] of [["on", "responses", true], ["off", "responses", false],
      ["on", "responses", true], ["native", "responses", false], ["on", "chat", false]] as const) {
      const route = routeModel(config, `${name}/reasoner`);
      await applyFinalRouteRequestNormalization({ parsed, route, config, inboundWire,
        req: new Request("http://localhost/v1/responses"), logCtx: { model: parsed.modelId, provider: name } });
      expect(parsed.options.rawReasoningAsSummary).toBe(enabled);
      if (inboundWire === "responses") expect(parsed.options.hideThinkingSummary).toBe(!enabled);
    }
    const hidden = parseRequest({ model: "on/reasoner", input: [], reasoning: { summary: "none" } });
    await applyFinalRouteRequestNormalization({ parsed: hidden, route: routeModel(config, "on/reasoner"),
      config, inboundWire: "responses", req: new Request("http://localhost/v1/responses"),
      logCtx: { model: hidden.modelId, provider: "on" } });
    expect(hidden.options.rawReasoningAsSummary).toBe(false);
    expect(hidden.options.hideThinkingSummary).toBe(true);
  });

  test("streamed and buffered raw summaries replay byte-exactly into tool continuation", async () => {
    const events: AdapterEvent[] = [{ type: "reasoning_raw_delta", text: RAW },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{}" }, { type: "tool_call_end" }, { type: "done" }];
    async function* source() { yield* events; }
    const sse = await new Response(bridgeToResponsesSSE(source(), "reasoner", undefined, undefined, undefined,
      undefined, undefined, { rawReasoningAsSummary: true })).text();
    for (const output of [buildResponseJSON(events, "reasoner", { rawReasoningAsSummary: true }).output,
      frames(sse).find(f => f.type === "response.completed")?.response.output] as any[][]) {
      const parsed = parseRequest({ model: "reasoner", input: [
        { role: "user", content: "read" }, ...output,
        { type: "function_call_output", call_id: "call_1", output: "done" },
      ] });
      const adapter = createOpenAIChatAdapter(provider({ preserveReasoningContentModels: ["reasoner"] }));
      const body = JSON.parse(adapter.buildRequest(parsed).body);
      expect(body.messages.find((m: any) => m.role === "assistant" && m.tool_calls)?.reasoning_content).toBe(RAW);
    }
  });

  test("raw and provider-authored summary blocks retain their own text and ordering", async () => {
    async function* source(): AsyncGenerator<AdapterEvent> {
      yield { type: "reasoning_raw_delta", text: RAW };
      yield { type: "thinking_delta", thinking: "provider summary" };
      yield { type: "reasoning_raw_delta", text: "next raw" };
      yield { type: "done" };
    }
    const text = await new Response(bridgeToResponsesSSE(source(), "reasoner", undefined, undefined, undefined,
      undefined, undefined, { rawReasoningAsSummary: true })).text();
    const output = frames(text).find(f => f.type === "response.completed")?.response.output;
    expect(output.map((o: any) => o.summary[0].text)).toEqual([RAW, "provider summary", "next raw"]);
    expect(decodeReasoningEnvelope(output[0].encrypted_content)?.txt).toBe(RAW);
    expect(output[1].encrypted_content).toBeUndefined();
  });
});
