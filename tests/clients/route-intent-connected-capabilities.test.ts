import { expect, test } from "bun:test";
import { loadConnectedRouteModels } from "../../src/integrations/route-intent-connected";
import { buildClientConfig } from "../../src/clients/config-export";
import { buildGrokManagedBlock } from "../../src/grok/inject";
import { generateDesktop3pModels } from "../../src/claude/desktop-3p";
import { LINK_ROUTE_CATALOG_PATH } from "../../src/link/management-routes";
import type { OcxConfig } from "../../src/types";

const connection = { transport: "link", apiKeyId: "fixture-key", link: { linkId: "lnk_0123456789abcdef", tunnelPort: 22001 } } as const;

function served(rows: unknown[], calls: string[] = [], combos: Array<{ publicId: string; comboId: string }> = []) {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/v1/models")) return Response.json({ object: "list", data: rows });
    if (url.endsWith(LINK_ROUTE_CATALOG_PATH)) return Response.json({ version: 1, combos });
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

test("a served Grok ladder reaches the Grok config and a routed 1M window reaches Claude Desktop", async () => {
  const models = await served([
    { id: "xai/grok-4.3", owned_by: "xai", supports_reasoning_effort: true, reasoning_effort: "high", context_window: 2_000_000,
      reasoning_efforts: ["minimal", "low", "medium", "high", "xhigh"].map(value => ({ value, label: value, ...(value === "high" ? { default: true } : {}) })),
      capabilities: { context_length: 2_000_000, supports_reasoning: true, supports_reasoning_effort: true, reasoning_effort: ["minimal", "low", "medium", "high", "xhigh"] } },
    { id: "gemini/gemini-3-pro", owned_by: "gemini", context_window: 1_048_576, capabilities: { context_length: 1_048_576 } },
  ]);
  // The Child's Grok adapter (src/client/route-intent-apply.ts) passes exactly these fields.
  const block = buildGrokManagedBlock(18274, models.map(model => ({ id: model.namespaced, name: model.displayName,
    contextWindow: model.contextWindow, reasoningEfforts: model.reasoningEfforts, defaultReasoningEffort: model.defaultReasoningEffort })));
  expect(block).toContain("supports_reasoning_effort = true");
  expect(block).toContain('reasoning_effort = "high"');
  for (const effort of ["minimal", "low", "medium", "high", "xhigh"]) expect(block).toContain(`value = "${effort}"`);
  expect(block).toContain("context_window = 2000000");
  // And its Desktop adapter passes the routed models' windows, which decide supports1m.
  const desktop = generateDesktop3pModels([], models.filter(model => !model.native)
    .map(model => ({ provider: model.provider, id: model.id, contextWindow: model.contextWindow })));
  const gemini = desktop.find(entry => entry.labelOverride.includes("(gemini)"));
  expect(gemini?.supports1m).toBe(true);
});

test("expanded combo selectors take their verified base identity, and an unverified one is left out alone", async () => {
  const calls: string[] = [];
  const models = await served([
    { id: "combo/fixture", owned_by: "openai", is_combo: true },
    { id: "combo/fixture--fast", owned_by: "openai", is_combo: true },
    { id: "combo/fixture--high", owned_by: "openai", is_combo: true },
    // Its base is not in the route catalog, so the Child cannot verify what it routes to.
    { id: "combo/unlisted--fast", owned_by: "openai", is_combo: true },
    { id: "gemini/plain", owned_by: "gemini" },
  ], calls, [{ publicId: "combo/fixture", comboId: "fixture" }]);
  expect(models.map(model => [model.namespaced, model.provider, model.id])).toEqual([
    ["combo/fixture", "combo", "fixture"],
    ["combo/fixture--fast", "combo", "fixture"],
    ["combo/fixture--high", "combo", "fixture"],
    ["gemini/plain", "gemini", "plain"],
  ]);
  expect(calls.some(url => url.endsWith(LINK_ROUTE_CATALOG_PATH))).toBe(true);
});

test("an unlisted combo that is not an expanded selector still rejects the roster", async () => {
  await expect(served([
    { id: "combo/fixture", owned_by: "openai", is_combo: true },
    { id: "combo/other", owned_by: "openai", is_combo: true },
  ], [], [{ publicId: "combo/fixture", comboId: "fixture" }])).rejects.toThrow("no verified route identity");
  // A suffix outside the selector grammar is not an expansion either.
  await expect(served([{ id: "combo/fixture--turbo", owned_by: "openai", is_combo: true }], [],
    [{ publicId: "combo/fixture", comboId: "fixture" }])).rejects.toThrow("no verified route identity");
});
