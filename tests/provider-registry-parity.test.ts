import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../src/codex/catalog";
import { getJawcodeModelMetadata, resolveJawcodeProvider } from "../src/generated/jawcode-model-metadata";
import { buildInitProviders } from "../src/cli/init";
import { OAUTH_PROVIDERS } from "../src/oauth";
import { enrichProviderFromCatalog, KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import {
  deriveFeaturedProviderIds,
  deriveInitProviders,
  deriveJawcodeAliases,
  deriveKeyLoginMap,
  deriveProviderPresets,
  providerConfigSeed,
} from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { applyProviderConfigHints } from "../src/codex/catalog";
import { routeModel } from "../src/router";
import { resolveAdapter } from "../src/server";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

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
  "anthropic-apikey", "openai-apikey", "umans", "opencode-go", "neuralwatt", "openrouter", "groq", "google", "google-vertex", "azure-openai",
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
    expect(KEY_LOGIN_PROVIDERS.minimax.defaultModel).toBe("MiniMax-M3");
    expect(KEY_LOGIN_PROVIDERS.umans).toMatchObject({
      label: "Umans AI Coding Plan",
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      defaultModel: "umans-coder",
      escapeBuiltinToolNames: true,
    });
    expect(KEY_LOGIN_PROVIDERS.umans.noVisionModels).toContain("umans-glm-5.2");
    // Zen Go text-only models are vision-sidecar covered; Kimi K2.7 Code is multimodal and must NOT be listed.
    expect(KEY_LOGIN_PROVIDERS["opencode-go"].noVisionModels).toEqual([
      "glm-5.2", "glm-5", "glm-5.1",
      "deepseek-v4-flash", "deepseek-v4-pro",
      "mimo-v2-pro", "mimo-v2.5-pro",
      "minimax-m2.5", "minimax-m2.7",
      "qwen3.7-max",
    ]);
    expect(KEY_LOGIN_PROVIDERS["opencode-go"].noVisionModels).not.toContain("kimi-k2.7-code");
    expect(KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-coder"]).toBe(262_144);
    expect(KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-glm-5.2"]).toBe(405_504);
    expect(KEY_LOGIN_PROVIDERS.umans.modelInputModalities?.["umans-coder"]).toEqual(["text", "image"]);
    expect(KEY_LOGIN_PROVIDERS.umans.modelInputModalities?.["umans-glm-5.2"]).toEqual(["text"]);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].models).toEqual(["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelContextWindows?.["gpt-5.6-sol"]).toBe(372_000);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelContextWindows?.["gpt-5.6-terra"]).toBe(372_000);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelContextWindows?.["gpt-5.6-luna"]).toBe(372_000);
    expect(KEY_LOGIN_PROVIDERS.openrouter.models).toContain("anthropic/claude-sonnet-5");
    expect(KEY_LOGIN_PROVIDERS.openrouter.models).toContain("openai/gpt-5.6-sol");
    expect(KEY_LOGIN_PROVIDERS.openrouter.models).toContain("openai/gpt-5.6-terra");
    expect(KEY_LOGIN_PROVIDERS.openrouter.models).toContain("openai/gpt-5.6-luna");
    expect(KEY_LOGIN_PROVIDERS.openrouter.modelContextWindows?.["anthropic/claude-sonnet-5"]).toBe(1_000_000);
    expect(KEY_LOGIN_PROVIDERS.openrouter.modelContextWindows?.["openai/gpt-5.6-sol"]).toBe(1_050_000);
    expect(KEY_LOGIN_PROVIDERS.openrouter.modelContextWindows?.["openai/gpt-5.6-terra"]).toBe(1_050_000);
    expect(KEY_LOGIN_PROVIDERS.openrouter.modelContextWindows?.["openai/gpt-5.6-luna"]).toBe(1_050_000);
    expect(KEY_LOGIN_PROVIDERS.deepseek.models).toContain("deepseek-v4-pro");
    expect(KEY_LOGIN_PROVIDERS.deepseek.modelReasoningEfforts?.["deepseek-v4-pro"]).toEqual(["high", "xhigh", "max"]);
    expect(KEY_LOGIN_PROVIDERS.deepseek.modelReasoningEffortMap?.["deepseek-v4-pro"]?.xhigh).toBe("max");
    expect(KEY_LOGIN_PROVIDERS.deepseek.modelReasoningEffortMap?.["deepseek-v4-pro"]?.max).toBe("max");
    expect(KEY_LOGIN_PROVIDERS.deepseek.preserveReasoningContentModels).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    // Issue #88: every DeepSeek API model is text-only input — the vision sidecar covers them.
    expect(KEY_LOGIN_PROVIDERS.deepseek.noVisionModels).toEqual([
      "deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro", "deepseek-v4-flash",
    ]);
  });

  test("CN provider defaults and context windows match the audited registry refresh", () => {
    const deepseek = PROVIDER_REGISTRY.find(entry => entry.id === "deepseek");
    expect(deepseek).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-flash",
      modelContextWindows: {
        "deepseek-v4-flash": 1_000_000,
        "deepseek-v4-pro": 1_000_000,
      },
    });

    const minimaxModels = [
      "MiniMax-M3",
      "MiniMax-M2.7", "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5", "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1", "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
    ];
    for (const providerId of ["minimax", "minimax-cn"]) {
      const entry = PROVIDER_REGISTRY.find(provider => provider.id === providerId);
      expect(entry?.adapter).toBe("openai-chat");
      expect(entry?.baseUrl).toBe(providerId === "minimax" ? "https://api.minimax.io/v1" : "https://api.minimaxi.com/v1");
      expect(entry?.defaultModel).toBe("MiniMax-M3");
      expect(entry?.models).toEqual(minimaxModels);
      expect(entry?.modelContextWindows?.["MiniMax-M3"]).toBe(1_000_000);
      for (const modelId of minimaxModels.slice(1)) {
        expect(entry?.modelContextWindows?.[modelId]).toBe(204_800);
      }
    }
  });

  test("aggregator defaults and Neuralwatt seeds match the audited live catalogs", () => {
    const cerebras = PROVIDER_REGISTRY.find(entry => entry.id === "cerebras");
    expect(cerebras?.defaultModel).toBe("gpt-oss-120b");

    const neuralwatt = PROVIDER_REGISTRY.find(entry => entry.id === "neuralwatt");
    expect(neuralwatt?.models).toEqual([
      "glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast",
      "kimi-k2.6", "kimi-k2.6-fast", "kimi-k2.7-code",
      "qwen3.5-397b", "qwen3.5-397b-fast", "qwen3.6-35b", "qwen3.6-35b-fast",
    ]);
    expect(neuralwatt?.models).not.toContain("moonshotai/Kimi-K2.5");
    expect(neuralwatt?.models).not.toContain("kimi-k2.5-fast");
    expect(neuralwatt?.modelReasoningEfforts?.["glm-5.2-short"])
      .toEqual(neuralwatt?.modelReasoningEfforts?.["glm-5.2"]);
    expect(neuralwatt?.modelReasoningEfforts?.["glm-5.2-short-fast"]).toEqual([]);
    expect(neuralwatt?.modelReasoningEfforts).not.toHaveProperty("moonshotai/Kimi-K2.5");
    expect(neuralwatt?.modelReasoningEfforts).not.toHaveProperty("kimi-k2.5-fast");
    expect(neuralwatt?.noReasoningModels).toContain("glm-5.2-short-fast");
    expect(neuralwatt?.noReasoningModels).not.toContain("kimi-k2.5-fast");
    expect(neuralwatt?.noVisionModels).toEqual([
      "glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast",
      "qwen3.5-397b", "qwen3.5-397b-fast",
    ]);
    expect(neuralwatt?.preserveReasoningContentModels).toContain("glm-5.2-short");
    expect(neuralwatt?.preserveReasoningContentModels).not.toContain("moonshotai/Kimi-K2.5");
  });

  test("Z.AI alone seeds and routes bracket-suffix stripping", () => {
    const zai = PROVIDER_REGISTRY.find(entry => entry.id === "zai");
    const optedInProviders = PROVIDER_REGISTRY
      .filter(entry => entry.modelSuffixBracketStrip)
      .map(entry => entry.id);
    expect(zai?.modelContextWindows).toEqual({ "glm-5.2": 1_000_000, "glm-5.2[1m]": 1_000_000 });
    expect(providerConfigSeed(zai!).modelSuffixBracketStrip).toBe(true);
    expect(optedInProviders).toEqual(["zai"]);

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "zai",
      providers: {
        zai: {
          adapter: "openai-chat",
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
        },
      },
    };
    expect(routeModel(config, "zai/glm-5.2[1m]").provider.modelSuffixBracketStrip).toBe(true);
  });

  test("Anthropic API-key provider mirrors the OAuth entry's models on the key flow", () => {
    const anthropicOauth = PROVIDER_REGISTRY.find(entry => entry.id === "anthropic");
    expect(KEY_LOGIN_PROVIDERS["anthropic-apikey"]).toMatchObject({
      label: "Anthropic (API key)",
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      dashboardUrl: "https://console.anthropic.com/settings/keys",
      defaultModel: "claude-sonnet-5",
      liveModels: true,
    });
    expect(KEY_LOGIN_PROVIDERS["anthropic-apikey"].models).toEqual(anthropicOauth?.models);
    expect(KEY_LOGIN_PROVIDERS["anthropic-apikey"].modelContextWindows).toEqual(anthropicOauth?.modelContextWindows);
  });

  test("Kimi coding aliases preserve model context and capability parity", () => {
    const codingModels = [
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "kimi-k2.6",
      "kimi-k2.5",
      "kimi-for-coding",
    ];
    const parityLists = [
      "noReasoningModels",
      "noTemperatureModels",
      "noTopPModels",
      "noPenaltyModels",
      "autoToolChoiceOnlyModels",
      "preserveReasoningContentModels",
    ] as const;

    for (const providerId of ["kimi", "kimi-code"]) {
      const entry = PROVIDER_REGISTRY.find(provider => provider.id === providerId);
      expect(entry?.models).toEqual(codingModels);
      for (const modelId of codingModels) {
        expect(entry?.modelContextWindows?.[modelId]).toBe(262_144);
      }
      for (const field of parityLists) {
        expect(entry?.[field]).toContain("kimi-k2.7-code");
        expect(entry?.[field]).toContain("kimi-for-coding");
      }
      expect(entry?.modelReasoningEfforts?.["kimi-for-coding"]).toEqual([]);
    }

    const moonshot = PROVIDER_REGISTRY.find(provider => provider.id === "moonshot");
    expect(moonshot?.models).not.toContain("kimi-for-coding");
    expect(moonshot?.modelContextWindows).toEqual({
      "kimi-k2.7-code": 262_144,
      "kimi-k2.7-code-highspeed": 262_144,
      "kimi-k2.6": 262_144,
      "kimi-k2.5": 262_144,
    });
  });

  test("LiteLLM is the only registry seed with optional key authentication", () => {
    const litellm = PROVIDER_REGISTRY.find(entry => entry.id === "litellm");
    const optionalKeyProviders = PROVIDER_REGISTRY.filter(entry => entry.keyOptional).map(entry => entry.id);

    expect(litellm?.authKind).toBe("key");
    expect(providerConfigSeed(litellm!).keyOptional).toBe(true);
    expect(optionalKeyProviders).toEqual(["litellm"]);
  });

  test("base URL override permission is registry-only and limited to local/self-hosted providers", () => {
    const optedIn = PROVIDER_REGISTRY.filter(entry => entry.allowBaseUrlOverride);

    expect(optedIn.map(entry => entry.id)).toEqual(["ollama", "vllm", "lm-studio", "litellm"]);
    for (const entry of optedIn) {
      expect(providerConfigSeed(entry)).not.toHaveProperty("allowBaseUrlOverride");
    }
  });

  test("Ollama Cloud uses the three live tagged IDs without retaining bare aliases", () => {
    const ollamaCloud = PROVIDER_REGISTRY.find(entry => entry.id === "ollama-cloud");

    expect(ollamaCloud?.models).toEqual([
      "glm-5.2", "deepseek-v4-pro", "qwen3-coder:480b", "gpt-oss:120b",
      "kimi-k2.6", "minimax-m3", "qwen3.5:397b", "gemma4:31b",
    ]);
    expect(ollamaCloud?.models).not.toContain("qwen3-coder");
    expect(ollamaCloud?.models).not.toContain("qwen3.5");
    expect(ollamaCloud?.models).not.toContain("gemma4");
    expect(ollamaCloud?.noVisionModels).toContain("qwen3-coder:480b");
    expect(ollamaCloud?.noVisionModels).not.toContain("qwen3-coder");
  });

  test("Fire Pass model data is explicitly frozen pending entitlement proof", () => {
    const firepass = PROVIDER_REGISTRY.find(entry => entry.id === "firepass");

    expect(firepass?.note).toContain("Tier-2 entitlement proof");
  });

  test("CLI init providers are derived from the registry", () => {
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(buildInitProviders().find(p => p.id === "azure-openai")?.adapter).toBe("azure-openai");
  });

  test("Cursor registry exposure is dashboard/oauth with live native exec and model discovery", () => {
    const cursor = PROVIDER_REGISTRY.find(entry => entry.id === "cursor");

    expect(cursor).toMatchObject({
      id: "cursor",
      adapter: "cursor",
      authKind: "oauth",
      featured: false,
      dashboardPreset: true,
      defaultModel: "auto",
      liveModels: true,
    });
    expect(cursor?.note).toContain("Live transport");
    expect(cursor?.note).toContain("live model discovery");
    expect(cursor?.note).toContain("unsafeAllowNativeLocalExec");
    expect(cursor?.note).toContain("~/.opencodex/config.json");
    expect(cursor?.note).toContain("Providers → Cursor → Edit JSON");
    expect(cursor?.models).toContain("auto");
    expect(cursor?.models?.length).toBeGreaterThanOrEqual(38);
    expect(cursor?.models).toContain("claude-sonnet-5");
    expect(cursor?.models).toContain("composer-2.5");
    expect(cursor?.models).toContain("gemini-3-pro-image-preview");
    expect(cursor?.models).toContain("gemini-3.5-flash");
    expect(cursor?.models).toContain("gpt-5-codex");
    expect(cursor?.models).toContain("gpt-5.6-sol");
    expect(cursor?.models).toContain("gpt-5.6-terra");
    expect(cursor?.models).toContain("gpt-5.6-luna");
    expect(cursor?.models).toContain("glm-5.2");
    expect(cursor?.models).toContain("kimi-k2.7-code");
    expect(cursor?.models).not.toContain("grok-4.3");
    expect(deriveFeaturedProviderIds()).not.toContain("cursor");
    expect(Object.keys(deriveKeyLoginMap())).not.toContain("cursor");
    expect(deriveProviderPresets().find(preset => preset.id === "cursor")).toMatchObject({
      id: "cursor",
      adapter: "cursor",
      auth: "oauth",
      defaultModel: "auto",
    });
    const seed = providerConfigSeed(cursor!);
    expect(seed).toMatchObject({
      adapter: "cursor",
      baseUrl: "https://api2.cursor.sh",
      liveModels: true,
      defaultModel: "auto",
    });
    expect(seed.models).toContain("auto");
    expect(seed.models).toContain("composer-2.5");
    expect(seed.models).toContain("gemini-3-pro-image-preview");
    expect(seed.models).toContain("gpt-5-codex");
    expect(seed.models).toContain("gpt-5.5");
    expect(seed.models).toContain("gpt-5.6-sol");
    expect(seed.models).toContain("gpt-5.6-terra");
    expect(seed.models).toContain("gpt-5.6-luna");
    expect(seed.models).toContain("kimi-k2.7-code");
    expect(seed.modelContextWindows?.auto).toBe(200_000);
    expect(seed.modelContextWindows?.["gemini-3.5-flash"]).toBe(200_000);
    expect(seed.modelContextWindows?.["gpt-5.6-sol"]).toBe(1_000_000);
    expect(seed.modelContextWindows?.["gpt-5.6-terra"]).toBe(1_000_000);
    expect(seed.modelContextWindows?.["gpt-5.6-luna"]).toBe(1_000_000);
    expect(seed.modelReasoningEfforts?.["gpt-5.5"]).toEqual(["low", "medium", "high"]);
    expect(seed.modelReasoningEfforts?.["gpt-5.6-sol"]).toEqual(["low", "medium", "high", "xhigh", "max"]);

    const savedCursor: OcxProviderConfig = { adapter: "cursor", baseUrl: "https://api2.cursor.sh" };
    enrichProviderFromCatalog("cursor", savedCursor);
    expect(savedCursor).toMatchObject({
      liveModels: true,
      defaultModel: "auto",
    });
    expect(savedCursor.models).toContain("auto");
    expect(savedCursor.models).toContain("composer-2.5");
    expect(savedCursor.models).toContain("kimi-k2.7-code");

    const initCursor = buildInitProviders().find(provider => provider.id === "cursor");
    expect(initCursor).toMatchObject({
      id: "cursor",
      adapter: "cursor",
      kind: "oauth",
      defaultModel: "auto",
    });
    expect(initCursor?.label.toLowerCase()).toContain("experimental");
    expect(resolveAdapter({
      adapter: "cursor",
      baseUrl: "https://api2.cursor.sh",
    }).name).toBe("cursor");
  });

  test("OAuth provider configs use canonical registry values", () => {
    expect(OAUTH_PROVIDERS.kimi.providerConfig.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(OAUTH_PROVIDERS.anthropic.providerConfig.defaultModel).toBe("claude-sonnet-5");
    expect(OAUTH_PROVIDERS.anthropic.providerConfig.models).toContain("claude-sonnet-5");
    expect(OAUTH_PROVIDERS.anthropic.providerConfig.models).toContain("claude-fable-5");
    expect(OAUTH_PROVIDERS.anthropic.providerConfig.modelContextWindows?.["claude-sonnet-5"]).toBe(1_000_000);
    expect(OAUTH_PROVIDERS.xai.providerConfig.defaultModel).toBe("grok-4.5");
    expect(OAUTH_PROVIDERS.xai.providerConfig.liveModels).toBe(true);
    expect(OAUTH_PROVIDERS.xai.providerConfig.models).toContain("grok-4.5");
    expect(OAUTH_PROVIDERS.xai.providerConfig.modelContextWindows?.["grok-4.5"]).toBe(500_000);
    expect(OAUTH_PROVIDERS.xai.providerConfig.modelReasoningEfforts?.["grok-4.5"]).toEqual(["low", "medium", "high"]);
    expect(OAUTH_PROVIDERS.xai.providerConfig.noVisionModels).toContain("grok-build-0.1");
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.models).toContain("gemini-3.5-flash-mid");
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.models).toContain("gemini-3.5-flash-high");
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.models).toContain("gemini-3.1-pro-high");
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.modelContextWindows?.["gemini-3.1-pro-high"]).toBe(1_048_576);
  });

  test("GUI preset projection preserves current featured set plus key catalog and custom", () => {
    const featured = deriveFeaturedProviderIds();
    expect(featured).toEqual([
      "openai", "xai", "anthropic", "anthropic-apikey", "kimi", "openai-apikey", "umans", "opencode-go", "openrouter",
      "groq", "google", "azure-openai", "ollama", "vllm", "lm-studio",
    ]);

    const presets = deriveProviderPresets();
    expect(presets.at(-1)?.id).toBe("custom");
    expect(presets.find(p => p.id === "cursor")).toMatchObject({
      adapter: "cursor",
      auth: "oauth",
      defaultModel: "auto",
    });
    expect(presets.find(p => p.id === "kimi")?.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(presets.find(p => p.id === "anthropic")?.defaultModel).toBe("claude-sonnet-5");
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
      "anthropic-apikey": "anthropic",
      "anthropic-key": "anthropic",
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

  test("grok-4.5 flows from the xai registry seed into a built catalog entry (260709 refresh)", () => {
    const xai = PROVIDER_REGISTRY.find(entry => entry.id === "xai");
    const seed = providerConfigSeed(xai!);
    const model = applyProviderConfigHints("xai", seed, { id: "grok-4.5", provider: "xai" });
    expect(model.contextWindow).toBe(500_000);
    expect(model.reasoningEfforts).toEqual(["low", "medium", "high"]);

    const entries = buildCatalogEntries(nativeTemplate() as never, [], [model]);
    const entry = entries.find(e => e.slug === "xai/grok-4.5");
    expect(entry).toBeTruthy();
    expect(entry?.context_window).toBe(500_000);
    expect((entry?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort))
      .toEqual(["low", "medium", "high", "max", "ultra"]);
  });
});
