import { afterEach, describe, expect, test } from "bun:test";
import { decodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { parseRequest } from "../../src/responses/parser";
import { routeModel } from "../../src/router";
import { applyFinalRouteRequestNormalization } from "../../src/server/responses/core-normalize";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// Provider policy hideRawReasoning: a routed provider's chain of thought stops reaching the
// client on the raw content channel, while provider-authored summaries keep streaming. Hidden
// text round-trips in the ocxr1 envelope, so reasoning replay is unaffected.

let releaseSpendHome: (() => void) | undefined;

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return "data: " + JSON.stringify({
    id: "cmpl_1", object: "chat.completion.chunk", created: 1, model: "reasoner",
    choices: [{ index: 0, delta, ...extra }],
  }) + "\n\n";
}

const CHAT_STREAM = [
  chatChunk({ reasoning_content: "chain " }),
  chatChunk({ reasoning_content: "of thought" }),
  chatChunk({ content: "OK" }),
  chatChunk({}, { finish_reason: "stop" }),
  "data: [DONE]\n\n",
].join("");

const CHAT_JSON = JSON.stringify({
  id: "cmpl_1", object: "chat.completion", created: 1, model: "reasoner",
  choices: [{
    index: 0, finish_reason: "stop",
    message: { role: "assistant", content: "OK", reasoning_content: "chain of thought" },
  }],
});

async function dispatch(
  body: Record<string, unknown>,
  provider: OcxProviderConfig,
): Promise<{ text: string; json: () => Promise<Record<string, unknown>> }> {
  releaseSpendHome = acquireOwnedSpendHome();
  const encoder = new TextEncoder();
  const streaming = body.stream === true;
  globalThis.fetch = (async () => new Response(
    streaming
      ? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(CHAT_STREAM));
          controller.close();
        },
      })
      : CHAT_JSON,
    { status: 200, headers: { "content-type": streaming ? "text/event-stream" : "application/json" } },
  )) as typeof fetch;
  const config = { providers: { reasoner: provider } } as unknown as OcxConfig;
  const response = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    config,
    { model: "", provider: "" },
    { abortSignal: AbortSignal.timeout(5_000) },
  );
  const text = await response.text();
  return { text, json: async () => JSON.parse(text) as Record<string, unknown> };
}

function provider(extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat", baseUrl: "https://reasoner.test/v1", apiKey: "sk-test",
    models: ["reasoner"], ...extra,
  } as OcxProviderConfig;
}

function completedOutput(text: string): Record<string, unknown>[] {
  const frame = text.split("\n\n")
    .map(block => block.trim())
    .filter(block => block.length > 0 && block !== "data: [DONE]")
    .map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? "{}") as Record<string, unknown>)
    .find(event => event.type === "response.completed");
  return ((frame?.response as Record<string, unknown>)?.output ?? []) as Record<string, unknown>[];
}

describe("hideRawReasoning provider option", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    releaseSpendHome?.();
    releaseSpendHome = undefined;
  });

  test("streamed: raw reasoning stays off the wire, summary channel is untouched", async () => {
    const { text } = await dispatch(
      { model: "reasoner/reasoner", input: "ping", stream: true, reasoning: { effort: "high" } },
      provider({ hideRawReasoning: true }),
    );
    expect(text).not.toContain("response.reasoning_text.delta");
    expect(text).not.toContain('"reasoning_text"');
    expect(text).toContain("response.output_text.delta");
    const reasoning = completedOutput(text).find(item => item.type === "reasoning");
    expect(reasoning?.content).toBeUndefined();
    expect(reasoning?.summary).toEqual([]);
    expect(decodeReasoningEnvelope(reasoning?.encrypted_content as string)?.txt).toBe("chain of thought");
  });

  test("without the option the same route streams raw reasoning on the content channel", async () => {
    const { text } = await dispatch(
      { model: "reasoner/reasoner", input: "ping", stream: true, reasoning: { effort: "high" } },
      provider(),
    );
    expect(text).toContain("response.reasoning_text.delta");
    const reasoning = completedOutput(text).find(item => item.type === "reasoning");
    expect(reasoning?.content).toEqual([{ type: "reasoning_text", text: "chain of thought" }]);
  });

  test("buffered: the hidden text survives only in the replay envelope", async () => {
    const { json } = await dispatch(
      { model: "reasoner/reasoner", input: "ping", reasoning: { effort: "high" } },
      provider({ hideRawReasoning: true }),
    );
    const output = (await json()).output as Record<string, unknown>[];
    const reasoning = output.find(item => item.type === "reasoning");
    expect(reasoning?.content).toBeUndefined();
    expect(decodeReasoningEnvelope(reasoning?.encrypted_content as string)?.txt).toBe("chain of thought");
    const message = output.find(item => item.type === "message") as { content?: { text?: string }[] };
    expect(message.content?.[0]?.text).toBe("OK");
  });

  test("final route reads the flag from the provider and resets it on a fallback", async () => {
    const config = {
      port: 0,
      defaultProvider: "quiet",
      providers: { quiet: provider({ hideRawReasoning: true }), loud: provider() },
    } as unknown as OcxConfig;
    for (const [providerName, hidden] of [["quiet", true], ["loud", false]] as const) {
      const parsed = parseRequest({ model: `${providerName}/reasoner`, input: [], reasoning: { effort: "high" } });
      const route = routeModel(config, parsed.modelId);
      await applyFinalRouteRequestNormalization({
        parsed,
        route,
        config,
        req: new Request("http://localhost/v1/responses"),
        logCtx: { model: parsed.modelId, provider: route.providerName },
        inboundWire: "responses",
      });
      expect(parsed.options.hideRawReasoning).toBe(hidden);
      // The provider policy never touches the summary decision.
      expect(parsed.options.hideThinkingSummary).not.toBe(true);
    }
  });

  test("a fallback renormalizing the same request clears a flag the first route set", async () => {
    const config = {
      port: 0,
      defaultProvider: "quiet",
      providers: { quiet: provider({ hideRawReasoning: true }), loud: provider() },
    } as unknown as OcxConfig;
    const parsed = parseRequest({ model: "quiet/reasoner", input: [], reasoning: { effort: "high" } });
    const normalize = async (providerName: string) => {
      const route = routeModel(config, `${providerName}/reasoner`);
      await applyFinalRouteRequestNormalization({
        parsed,
        route,
        config,
        req: new Request("http://localhost/v1/responses"),
        logCtx: { model: parsed.modelId, provider: route.providerName },
        inboundWire: "responses",
      });
    };
    await normalize("quiet");
    expect(parsed.options.hideRawReasoning).toBe(true);
    // One parsed request object carries across a fallback; the flag must follow the new route.
    await normalize("loud");
    expect(parsed.options.hideRawReasoning).toBe(false);
  });
});
