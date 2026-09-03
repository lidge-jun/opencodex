import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { applyProviderConfigHints } from "../src/codex/catalog/provider-fetch";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));
const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const MODEL = "gpt-5.6-luna";

function parsed(modelId = MODEL): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    stream: false,
    options: {},
    _rawBody: { model: modelId, input: "hello" },
  };
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: "https://api.githubcopilot.com",
    authMode: "oauth",
    modelContextTiers: { [MODEL]: "long_context" },
    ...overrides,
  };
}

describe("GitHub Copilot context tiers", () => {
  test("adds the selected tier to Responses requests", () => {
    const request = createResponsesPassthroughAdapter(provider()).buildRequest(parsed(), { providerName: "github-copilot" });
    expect(JSON.parse(request.body)).toMatchObject({ contextTier: "long_context" });
  });

  test("adds the selected tier to Chat Completions requests too", () => {
    const request = createOpenAIChatAdapter(provider({ adapter: "openai-chat", apiKey: "test-key" }))
      .buildRequest(parsed(), { providerName: "github-copilot" });
    expect(JSON.parse(request.body)).toMatchObject({ contextTier: "long_context" });
  });

  test("supports the explicit default tier and leaves unconfigured models untouched", () => {
    const defaultRequest = createResponsesPassthroughAdapter(provider({ modelContextTiers: { [MODEL]: "default" } }))
      .buildRequest(parsed(), { providerName: "github-copilot" });
    expect(JSON.parse(defaultRequest.body)).toMatchObject({ contextTier: "default" });

    const otherRequest = createResponsesPassthroughAdapter(provider()).buildRequest(parsed("gpt-5.5"), { providerName: "github-copilot" });
    expect(JSON.parse(otherRequest.body)).not.toHaveProperty("contextTier");
  });

  test("does not inject the Copilot tier into another provider", () => {
    const request = createResponsesPassthroughAdapter(provider()).buildRequest(parsed(), { providerName: "openai" });
    expect(JSON.parse(request.body)).not.toHaveProperty("contextTier");
  });

  test("raises long-context catalog metadata before applying the provider cap", () => {
    const long = applyProviderConfigHints(
      "github-copilot",
      provider(),
      { provider: "github-copilot", id: MODEL, contextWindow: 200_000 },
      400_000,
    );
    expect(long.contextWindow).toBe(400_000);
    expect(long.contextCap).toBe(400_000);
    expect(long.contextCapped).toBe(true);

    const normal = applyProviderConfigHints(
      "github-copilot",
      provider({ modelContextTiers: { [MODEL]: "default" } }),
      { provider: "github-copilot", id: MODEL, contextWindow: 200_000 },
      400_000,
    );
    expect(normal.contextWindow).toBe(200_000);
    expect(normal.contextCapped).toBe(false);
  });
});
