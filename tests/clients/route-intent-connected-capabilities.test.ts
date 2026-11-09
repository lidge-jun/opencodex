import { expect, test } from "bun:test";
import { loadConnectedRouteModels } from "../../src/integrations/route-intent-connected";
import { buildClientConfig } from "../../src/clients/config-export";
import type { OcxConfig } from "../../src/types";

const connection = { transport: "link", apiKeyId: "fixture-key", link: { linkId: "lnk_0123456789abcdef", tunnelPort: 22001 } } as const;

function served(rows: unknown[], calls: string[] = []) {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/v1/models")) return Response.json({ object: "list", data: rows });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return loadConnectedRouteModels(connection, "ocx_data_" + "a".repeat(40), { fetchImpl });
}

const visionReasoningRow = {
  id: "gemini/gemini-3-pro",
  object: "model",
  owned_by: "gemini",
  supports_reasoning_effort: true,
  reasoning_effort: "high",
  reasoning_efforts: [
    { value: "low", label: "Low Effort" },
    { value: "high", label: "High Effort", default: true },
  ],
  context_window: 1_000_000,
  context_length: 1_000_000,
  max_output_tokens: 65_536,
  capabilities: {
    context_length: 1_000_000,
    max_output_tokens: 65_536,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    supports_reasoning: true,
    supports_reasoning_effort: true,
    supports_vision: true,
  },
};

test("a served vision/reasoning row keeps its capabilities through Pi and OpenCode exports", async () => {
  const models = await served([visionReasoningRow]);
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({
    namespaced: "gemini/gemini-3-pro",
    provider: "gemini",
    id: "gemini-3-pro",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    inputModalities: ["text", "image"],
    reasoningEfforts: ["low", "high"],
    supportsReasoningEffort: true,
    defaultReasoningEffort: "high",
  });
  const config = { providers: {} } as unknown as OcxConfig;
  const pi = buildClientConfig("pi", { config, models, baseUrl: "http://127.0.0.1:18274" }) as {
    providers: Record<string, { models: Array<Record<string, unknown>> }>;
  };
  const piModel = pi.providers.opencodex!.models.find(model => model.id === "gemini/gemini-3-pro");
  expect(piModel).toMatchObject({ input: ["text", "image"], reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536 });
  expect(piModel!.thinkingLevelMap).toMatchObject({ low: "low", high: "high", xhigh: null });
  const opencode = buildClientConfig("opencode", { config, models, baseUrl: "http://127.0.0.1:18274" }) as {
    provider: Record<string, { models: Record<string, Record<string, unknown>> }>;
  };
  const block = opencode.provider.opencodex!.models["gemini/gemini-3-pro"]!;
  expect(block).toMatchObject({ attachment: true, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 1_000_000, output: 65_536 } });
});

test("malformed served capability values are dropped rather than passed through", async () => {
  const models = await served([{
    id: "gemini/bad-values",
    owned_by: "gemini",
    context_window: "unbounded",
    max_output_tokens: -5,
    supports_reasoning_effort: "yes",
    reasoning_efforts: [{ value: "low" }, { value: 7 }, "high"],
    capabilities: {
      context_length: 1.5e300,
      max_output_tokens: Number.NaN,
      input_modalities: ["image", 42, "text\u0000", "x".repeat(64)],
      supports_reasoning: "true",
      supports_thinking_toggle: 1,
    },
  }]);
  expect(models).toHaveLength(1);
  const model = models[0]!;
  expect(model.contextWindow).toBeUndefined();
  expect(model.maxTokens).toBeUndefined();
  expect(model.supportsReasoningEffort).toBeUndefined();
  expect(model.supportsReasoning).toBeUndefined();
  expect(model.supportsThinkingToggle).toBeUndefined();
  // Well-formed entries survive; the numeric value and the bare string do not.
  expect(model.reasoningEfforts).toEqual(["low", "high"]);
  expect(model.inputModalities).toEqual(["image"]);
  const pi = buildClientConfig("pi", { config: { providers: {} } as unknown as OcxConfig, models, baseUrl: "http://127.0.0.1:18274" }) as {
    providers: Record<string, { models: Array<Record<string, unknown>> }>;
  };
  const piModel = pi.providers.opencodex!.models.find(entry => entry.id === "gemini/bad-values")!;
  expect(piModel.input).toEqual(["image"]);
  // The retained ladder is the row's own statement that reasoning is accepted.
  expect(piModel.reasoning).toBe(true);
  expect(piModel.thinkingLevelMap).toMatchObject({ low: "low", high: "high", medium: null });
  expect(piModel.contextWindow).toBeUndefined();
});

test("a served row without capability metadata gains none", async () => {
  const models = await served([{ id: "gemini/plain", owned_by: "gemini" }]);
  expect(models[0]).toEqual({ namespaced: "gemini/plain", provider: "gemini", id: "plain" });
});
