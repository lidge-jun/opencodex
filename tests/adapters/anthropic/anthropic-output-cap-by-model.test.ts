import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { routedProviderConfig } from "../../../src/providers/routed-config";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

// #8525: the omitted-output cap follows the Claude model id, not the provider row name.
function row(baseUrl: string, extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "anthropic", baseUrl, authMode: "key", apiKey: "sk-test", models: ["claude-opus-5-5"], ...extra } as OcxProviderConfig;
}

function request(modelId: string, reasoning?: string): OcxParsedRequest {
  return {
    modelId,
    stream: false,
    options: reasoning ? { reasoning } : {},
    context: { systemPrompt: ["sys"], messages: [{ role: "user", content: "hi" }] },
  } as unknown as OcxParsedRequest;
}

async function maxTokens(name: string, provider: OcxProviderConfig, modelId: string, reasoning?: string): Promise<number> {
  const routed = routedProviderConfig(name, provider);
  const { body } = await withTestTranslatorBudget(createAnthropicAdapter(routed)).buildRequest(request(modelId, reasoning));
  return (JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as { max_tokens: number }).max_tokens;
}

const DIRECT = "https://api.anthropic.com";
const GATEWAY = "https://gateway.example.com";

describe("Anthropic omitted-output cap by model id (#8525)", () => {
  test("a custom-named direct row gets the registry cap of its Claude model", async () => {
    expect(await maxTokens("MyClaude", row(DIRECT), "claude-opus-5-5")).toBe(128_000);
    expect(await maxTokens("MyClaude", row(DIRECT), "claude-haiku-4-5")).toBe(64_000);
  });

  test("a custom-named direct row gets the Anthropic default for an id the registry does not list", async () => {
    expect(await maxTokens("MyClaude", row(DIRECT), "claude-future-9")).toBe(64_000);
  });

  test("a gateway row serving a registry Claude id gets that id's cap", async () => {
    expect(await maxTokens("Gateway", row(GATEWAY), "claude-opus-5-5")).toBe(128_000);
    expect(await maxTokens("Gateway", row(GATEWAY), "CLAUDE-OPUS-5-5")).toBe(128_000);
    expect(await maxTokens("Gateway", row(GATEWAY), "claude-haiku-4-5")).toBe(64_000);
  });

  test("adaptive effort keeps the model cap instead of the 8192-based ceiling", async () => {
    expect(await maxTokens("Gateway", row(GATEWAY), "claude-opus-5-5", "high")).toBe(128_000);
  });

  test("a gateway model id the registry does not know keeps the 8192 fallback", async () => {
    expect(await maxTokens("Gateway", row(GATEWAY), "gateway-model-x")).toBe(8192);
    expect(await maxTokens("Gateway", row(GATEWAY), "anthropic/claude-opus-5-5")).toBe(8192);
  });

  test("an operator default beats the registry per-model cap", async () => {
    expect(await maxTokens("Gateway", row(GATEWAY, { defaultMaxOutputTokens: 20_000 }), "claude-opus-5-5")).toBe(20_000);
    expect(await maxTokens("MyClaude", row(DIRECT, { defaultMaxOutputTokens: 20_000 }), "claude-opus-5-5")).toBe(20_000);
  });

  test("an operator per-model cap beats everything for that model only", async () => {
    const provider = row(GATEWAY, { modelMaxOutputTokens: { "claude-opus-5-5": 32_000 } });
    expect(await maxTokens("Gateway", provider, "claude-opus-5-5")).toBe(32_000);
    expect(await maxTokens("Gateway", provider, "claude-sonnet-5-5")).toBe(128_000);
  });

  test("an explicit caller limit still wins", async () => {
    const routed = routedProviderConfig("Gateway", row(GATEWAY));
    const parsed = request("claude-opus-5-5");
    parsed.options.maxOutputTokens = 1_000;
    const { body } = await withTestTranslatorBudget(createAnthropicAdapter(routed)).buildRequest(parsed);
    expect((JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as { max_tokens: number }).max_tokens).toBe(1_000);
  });

  test("named registry rows with seeded caps resolve exactly as before", async () => {
    expect(await maxTokens("anthropic-apikey", row(DIRECT), "claude-opus-5-5")).toBe(128_000);
    expect(await maxTokens("anthropic-apikey", row(DIRECT), "claude-future-9")).toBe(64_000);
  });

  test("a named registry row without seeded caps follows the model id too", async () => {
    const cloudflare = row("https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic");
    expect(await maxTokens("cloudflare-ai-gateway", cloudflare, "claude-opus-5-5")).toBe(128_000);
    expect(await maxTokens("cloudflare-ai-gateway", cloudflare, "gateway-model-x")).toBe(8192);
  });

  test("the routed copy is filled without mutating the operator row", () => {
    const provider = row(GATEWAY);
    const routed = routedProviderConfig("Gateway", provider);
    expect(routed.modelMaxOutputTokens?.["claude-opus-5-5"]).toBe(128_000);
    expect(provider.modelMaxOutputTokens).toBeUndefined();
    expect(provider.defaultMaxOutputTokens).toBeUndefined();
  });

  test("rows on other adapters are untouched", () => {
    const routed = routedProviderConfig("Chat", { adapter: "openai-chat", baseUrl: GATEWAY, authMode: "key", apiKey: "sk", models: ["claude-opus-5-5"] } as OcxProviderConfig);
    expect(routed.modelMaxOutputTokens).toBeUndefined();
    expect(routed.defaultMaxOutputTokens).toBeUndefined();
  });
});
