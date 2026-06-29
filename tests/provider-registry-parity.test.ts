import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../src/codex-catalog";
import { getJawcodeModelMetadata, resolveJawcodeProvider } from "../src/generated/jawcode-model-metadata";
import { buildInitProviders } from "../src/init";
import { OAUTH_PROVIDERS } from "../src/oauth";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import {
  deriveFeaturedProviderIds,
  deriveInitProviders,
  deriveJawcodeAliases,
  deriveKeyLoginMap,
  deriveProviderPresets,
} from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { resolveAdapter } from "../src/server";

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    priority: 1,
    visibility: "list",
    supports_websockets: true,
  };
}

const EXPECTED_KEY_PROVIDER_IDS = [
  "openai-apikey", "umans", "opencode-go", "neuralwatt", "openrouter", "groq", "google", "google-vertex", "azure-openai",
  "deepseek", "cerebras", "together", "fireworks", "firepass", "moonshot",
  "huggingface", "nvidia", "venice", "zai", "nanogpt", "synthetic", "qwen-portal",
  "qianfan", "alibaba", "parallel", "zenmux", "litellm", "ollama-cloud", "mistral",
  "minimax", "minimax-cn", "kimi-code", "opencode-zen", "vercel-ai-gateway",
  "xiaomi", "kilo", "cloudflare-ai-gateway", "github-copilot", "gitlab-duo",
];

describe("provider registry parity", () => {
  test("registry ids are unique", () => {
    const ids = PROVIDER_REGISTRY.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("key-login export is derived from the registry", () => {
    expect(KEY_LOGIN_PROVIDERS).toEqual(deriveKeyLoginMap());
    expect(Object.keys(KEY_LOGIN_PROVIDERS)).toEqual(EXPECTED_KEY_PROVIDER_IDS);
    expect(Object.keys(deriveKeyLoginMap())).toEqual(EXPECTED_KEY_PROVIDER_IDS);
    expect(KEY_LOGIN_PROVIDERS.minimax.defaultModel).toBe("MiniMax-M2.5");
    expect(KEY_LOGIN_PROVIDERS.umans).toMatchObject({
      label: "Umans AI Coding Plan",
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      defaultModel: "umans-coder",
      escapeBuiltinToolNames: true,
    });
    expect(KEY_LOGIN_PROVIDERS.umans.noVisionModels).toContain("umans-glm-5.2");
    expect(KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-coder"]).toBe(262_144);
    expect(KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-glm-5.2"]).toBe(405_504);
    expect(KEY_LOGIN_PROVIDERS.umans.modelInputModalities?.["umans-coder"]).toEqual(["text", "image"]);
    expect(KEY_LOGIN_PROVIDERS.umans.modelInputModalities?.["umans-glm-5.2"]).toEqual(["text"]);
  });

  test("CLI init providers are derived from the registry", () => {
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(buildInitProviders().find(p => p.id === "azure-openai")?.adapter).toBe("azure-openai");
  });

  test("OAuth provider configs use canonical registry values", () => {
    expect(OAUTH_PROVIDERS.kimi.providerConfig.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(OAUTH_PROVIDERS.anthropic.providerConfig.defaultModel).toBe("claude-sonnet-4-6");
    expect(OAUTH_PROVIDERS.xai.providerConfig.defaultModel).toBe("grok-4.3");
    expect(OAUTH_PROVIDERS.xai.providerConfig.noVisionModels).toContain("grok-build-0.1");
  });

  test("GUI preset projection preserves current featured set plus key catalog and custom", () => {
    const featured = deriveFeaturedProviderIds();
    expect(featured).toEqual([
      "openai", "xai", "anthropic", "kimi", "openai-apikey", "umans", "opencode-go", "openrouter",
      "groq", "google", "azure-openai", "ollama", "vllm", "lm-studio",
    ]);

    const presets = deriveProviderPresets();
    expect(presets.at(-1)?.id).toBe("custom");
    expect(presets.find(p => p.id === "kimi")?.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(presets.find(p => p.id === "anthropic")?.defaultModel).toBe("claude-sonnet-4-6");
    expect(presets.find(p => p.id === "umans")).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      auth: "key",
      defaultModel: "umans-coder",
    });
    expect(presets.find(p => p.id === "azure-openai")?.adapter).toBe("azure-openai");
  });

  test("Umans registry metadata reaches routed Codex catalog entries", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      {
        provider: "umans",
        id: "umans-coder",
        contextWindow: KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-coder"],
        inputModalities: KEY_LOGIN_PROVIDERS.umans.modelInputModalities?.["umans-coder"],
        reasoningEfforts: KEY_LOGIN_PROVIDERS.umans.modelReasoningEfforts?.["umans-coder"],
      },
      {
        provider: "umans",
        id: "umans-glm-5.2",
        contextWindow: KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-glm-5.2"],
        inputModalities: KEY_LOGIN_PROVIDERS.umans.modelInputModalities?.["umans-glm-5.2"],
        reasoningEfforts: KEY_LOGIN_PROVIDERS.umans.modelReasoningEfforts?.["umans-glm-5.2"],
      },
    ]);
    const coder = entries.find(e => e.slug === "umans/umans-coder");
    const glm = entries.find(e => e.slug === "umans/umans-glm-5.2");

    expect(coder?.context_window).toBe(262_144);
    expect(coder?.input_modalities).toEqual(["text", "image"]);
    expect(glm?.context_window).toBe(405_504);
    expect(glm?.input_modalities).toEqual(["text"]);
    expect(glm?.default_reasoning_level).toBe("high");
  });

  test("jawcode metadata aliases are derived from the registry", () => {
    expect(deriveJawcodeAliases()).toEqual({
      xai: "xai",
      anthropic: "anthropic",
      kimi: "moonshot",
      "opencode-go": "opencode-go",
      openrouter: "openrouter",
      google: "google",
      gemini: "google",
      "google-vertex": "google",
      "gemini-vertex": "google",
      "google-antigravity": "google",
      "antigravity": "google",
      "gemini-antigravity": "google",
      moonshot: "moonshot",
      minimax: "minimax",
      "minimax-cn": "minimax",
    });
    expect(resolveJawcodeProvider("gemini")).toBe("google");
    expect(resolveJawcodeProvider("minimax-cn")).toBe("minimax");
  });

  test("legacy azure adapter spelling remains accepted", () => {
    const adapter = resolveAdapter({
      adapter: "azure",
      baseUrl: "https://example.openai.azure.com/openai/deployments/demo",
      apiKey: "key",
      defaultModel: "deployment",
    });
    expect("passthrough" in adapter && adapter.passthrough).toBe(true);
  });

  test("MiniMax metadata lookup tolerates routed lowercase ids", () => {
    expect(getJawcodeModelMetadata("minimax", "MiniMax-M2.5")?.contextWindow).toBe(204_800);
    expect(getJawcodeModelMetadata("minimax", "minimax-m2.5")).toBeUndefined();

    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "minimax", id: "minimax-m2.5" },
    ]);
    const routed = entries.find(e => e.slug === "minimax/minimax-m2.5");
    expect(routed?.context_window).toBe(204_800);
    expect(routed?.max_context_window).toBe(204_800);
  });
});
