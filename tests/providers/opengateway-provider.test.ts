import { afterEach, describe, expect, test } from "bun:test";
import fixture from "../fixtures/opengateway-models.json";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { buildCatalogEntries, gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildModelsRequest } from "../../src/oauth";
import { deriveInitProviders, deriveProviderPresets, enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { extractProviderModelItems, resolveProviderModelDiscovery, providerModelDiscoverySpecError } from "../../src/providers/model-discovery";
import { PROVIDER_REGISTRY, providerModelWireDefault } from "../../src/providers/registry";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
const entry = PROVIDER_REGISTRY.find(row => row.id === "opengateway")!;
const provider = { ...providerConfigSeed(entry), apiKey: "test-key" };
const discovery = resolveProviderModelDiscovery("opengateway", provider);
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearModelCache("opengateway"); });
const expected = ["deepseek/deepseek-v4.1-flash-ultrafast", "z-ai/glm-5.3-flash-ultrafast", "openai/o4-mini", "openai/o3-pro"];
function ids(value: unknown, spec = discovery) {
  const result = extractProviderModelItems(value, spec);
  if (!result.ok) throw new Error(result.reason);
  return result.items.map(row => row.id);
}
describe("OpenGateway", () => {
  test("exposes registry preset and seeds Sionic models before other models", () => {
    expect(deriveInitProviders().find(row => row.id === "opengateway")).toMatchObject({ label: "OpenGateway", kind: "key" });
    expect(deriveProviderPresets().find(row => row.id === "opengateway")).toMatchObject({ dashboardUrl: "https://opengateway.ai/api-keys" });
    expect(entry.models?.slice(0, 2)).toEqual([expected[1], expected[0]]);
    expect(entry.defaultModel).toBe(expected[1]);
    expect(provider).not.toHaveProperty("modelDiscovery");
    expect(providerModelDiscoverySpecError(entry.modelDiscovery!)).toBeNull();
    expect(buildModelsRequest(provider, "test-key", "opengateway").url).toBe("https://apis.opengateway.ai/v1/models");
  });
  test("filters inactive/non-chat rows, then stably promotes Sionic original rows", () => {
    expect(ids(fixture)).toEqual(expected);
    expect(ids({ data: fixture.data.slice().reverse() })).toEqual([expected[1], expected[0], expected[3], expected[2]]);
  });
  test("absence of preference is a no-op, and nonmatches do not move", () => {
    const spec = { ...discovery.spec }; delete spec.preferFirst;
    expect(ids(fixture, { ...discovery, spec })).toEqual([expected[2], expected[3], expected[0], expected[1]]);
    expect(ids(fixture, { ...discovery, spec: { ...spec, preferFirst: [{ path: ["providers", "*", "id"], containsAny: ["not-present"] }] } })).toEqual([expected[2], expected[3], expected[0], expected[1]]);
  });
  test("enrichment cannot manufacture a preferred row and malformed provider arrays fail closed", () => {
    const data = [{ id: "a", status: "active", endpoints: ["chat_completions"], providers: [{ id: "other" }] }, { id: "b", status: "active", endpoints: ["chat_completions", "responses"], providers: [{ id: "sionic-ai" }] }];
    expect(ids({data, models: [{id:"a",providers:[{id:"sionic-ai"}]}]})).toEqual(["b", "a"]);
    expect(ids({data: data.map(row=>({...row,providers: {id:"sionic-ai"}}))})).toEqual(["a", "b"]);
  });
  test("hides Responses-only rows unless pinned to Responses, so the Chat default never 404s", () => {
    const data = [
      { id: "openai/o3-pro", status: "active", endpoints: ["responses"], providers: [{ id: "openai" }] },
      { id: "openai/future-responses-only", status: "active", endpoints: ["responses"], providers: [{ id: "openai" }] },
      { id: "openai/chat-row", status: "active", endpoints: ["chat_completions", "responses"], providers: [{ id: "openai" }] },
    ];
    expect(ids({ data })).toEqual(["openai/o3-pro", "openai/chat-row"]);
  });
  test("declares the public catalog as unable to validate keys", () => {
    expect(entry.apiKeyValidation).toBe("unknown");
  });
  test("uses Responses-only o3-pro on every inbound and verified Sionic Responses only for Codex", () => {
    expect(providerModelWireDefault("opengateway", provider, "openai/o3-pro", new Set(["openai-chat", "openai-responses"]), "chat")).toBe("openai-responses");
    expect(providerModelWireDefault("opengateway", provider, expected[0]!, new Set(["openai-chat", "openai-responses"]), "responses")).toBe("openai-responses");
    expect(providerModelWireDefault("opengateway", provider, expected[0]!, new Set(["openai-chat", "openai-responses"]), "chat")).toBeUndefined();
    expect(providerModelWireDefault("opengateway", provider, "openai/o4-mini", new Set(["openai-chat", "openai-responses"]), "responses")).toBeUndefined();
  });
  test("live ordering survives routed gather, cache and catalog picker projection", async () => {
    globalThis.fetch = (async () => Response.json(fixture)) as typeof fetch;
    const config = withStubbedProviderFetch({ port: 10100, defaultProvider: "opengateway", providers: { opengateway: provider } } as OcxConfig);
    for (let pass = 0; pass < 2; pass++) {
      const models = (await gatherRoutedModels(config)).filter(row => row.provider === "opengateway");
      expect(models.map(row => row.id)).toEqual(expected);
      const catalog = buildCatalogEntries(null, [], models);
      expect(catalog.map(row => row.slug)).toEqual(expected.map(id => `opengateway/${id.replaceAll("/", "-")}`));
      expect(catalog.slice().sort((a,b)=>Number(a.priority)-Number(b.priority)).map(row=>row.slug)).toEqual(catalog.map(row=>row.slug));
    }
  });
});

// #6877: on the Responses wire OpenGateway answers 400 to replayed native custom tool history.
describe("OpenGateway Responses custom tools", () => {
  // A row written by an older install carries no supportsResponsesCustomTools of its own.
  const saved = (): OcxProviderConfig => ({ adapter: "openai-chat", baseUrl: "https://apis.opengateway.ai/v1", apiKey: "test-key" } as OcxProviderConfig);
  test("the preset declares native custom tool shapes unsupported, without overriding an explicit value", () => {
    expect(entry.supportsResponsesCustomTools).toBe(false);
    const inherited = saved();
    enrichProviderFromRegistry("opengateway", inherited);
    expect(inherited.supportsResponsesCustomTools).toBe(false);
    const explicit = { ...saved(), supportsResponsesCustomTools: true };
    enrichProviderFromRegistry("opengateway", explicit);
    expect(explicit.supportsResponsesCustomTools).toBe(true);
  });
  test("replayed exec history whose tool is no longer declared reaches the upstream as function calls", () => {
    const routed = saved();
    enrichProviderFromRegistry("opengateway", routed);
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({ ...routed, adapter: "openai-responses" }));
    const built = adapter.buildRequest({
      modelId: expected[0]!,
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: expected[0],
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
          { type: "custom_tool_call", call_id: "call_exec", name: "exec", input: "text(1)" },
          { type: "custom_tool_call_output", call_id: "call_exec", output: "1" },
        ],
      },
    } as Parameters<typeof adapter.buildRequest>[0], { headers: new Headers() });
    const body = JSON.parse(String(built.body)) as { input: Array<Record<string, unknown>> };
    expect(body.input.map(item => item.type)).toEqual(["message", "function_call", "function_call_output"]);
    expect(body.input[1]).toMatchObject({ call_id: "call_exec" });
    expect(body.input[2]).toMatchObject({ call_id: "call_exec" });
  });
});
