import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../src/codex/catalog";
import { CURSOR_NO_VISION_MODELS } from "../src/adapters/cursor/discovery";
import { getModelMetadata, resolveMetadataProvider } from "../src/generated/model-metadata";
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
import { FREE_PROVIDER_DIRECTORY } from "../src/providers/free-directory";
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
  "anthropic-apikey", "openai-apikey", "umans", "opencode-go", "neuralwatt", "openrouter", "cline-pass", "cline", "orcarouter", "bizrouter", "groq", "google", "google-vertex", "azure-openai",
  "deepseek", "cerebras", "chutes", "deepinfra", "hyperbolic", "nscale", "vultr", "baseten", "commandcode", "sambanova", "nebius", "digitalocean", "scaleway", "featherless", "novita", "together", "fireworks", "firepass", "moonshot",
  "huggingface", "nvidia", "venice", "zai", "zhipu-bigmodel", "zhipu-bigmodel-coding", "nanogpt", "synthetic", "siliconflow", "qwen-cloud", "tencent-coding-plan",
  "volcengine", "volcengine-coding-plan", "volcengine-agent-plan", "qianfan", "alibaba", "alibaba-token-plan", "alibaba-token-plan-intl", "parallel", "zenmux", "litellm", "ollama-cloud", "mistral",
  "minimax", "minimax-cn", "kimi-code", "opencode-zen", "vercel-ai-gateway",
  "opencode-free", "xiaomi", "xiaomi-mimo", "kilo", "mimo-free", "mimo", "cloudflare-ai-gateway", "cloudflare-workers-ai", "gitlab-duo",
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
      "glm-5.3",
      "glm-5.2", "glm-5", "glm-5.1",
      "deepseek-v4-flash", "deepseek-v4-pro",
      "mimo-v2-pro", "mimo-v2.5-pro",
      "minimax-m2.5", "minimax-m2.7",
      "qwen3.7-max",
    ]);
    expect(KEY_LOGIN_PROVIDERS["opencode-go"].noVisionModels).not.toContain("kimi-k2.7-code");
    expect(KEY_LOGIN_PROVIDERS.mimo.noVisionModels).toEqual(["mimo-v2.5-pro"]);
    expect(KEY_LOGIN_PROVIDERS.mimo.noVisionModels).not.toContain("mimo-v2.5");
    expect(KEY_LOGIN_PROVIDERS["opencode-go"]).toMatchObject({
      modelContextWindows: { "kimi-k3": 262_144 },
      modelInputModalities: { "kimi-k3": ["text", "image"] },
      modelReasoningEfforts: { "kimi-k3": ["low", "high", "max"] },
      modelDefaultReasoningEfforts: { "kimi-k3": "max" },
      modelReasoningEffortMap: {
        "kimi-k3": { none: "none", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
      },
    });
    expect(KEY_LOGIN_PROVIDERS["opencode-go"].modelReasoningEfforts?.["gpt-5.6-luna"])
      .toEqual(KEY_LOGIN_PROVIDERS["openai-apikey"].modelReasoningEfforts?.["gpt-5.6-luna"]);
    expect(KEY_LOGIN_PROVIDERS["opencode-go"].modelReasoningEfforts?.["qwen3.8-max"])
      .toEqual(KEY_LOGIN_PROVIDERS["alibaba-token-plan"].modelReasoningEfforts?.["qwen3.8-max"]);
    expect(KEY_LOGIN_PROVIDERS["opencode-go"].noTemperatureModels).toContain("kimi-k3");
    expect(KEY_LOGIN_PROVIDERS["opencode-go"].noTopPModels).toContain("kimi-k3");
    expect(KEY_LOGIN_PROVIDERS["opencode-go"].noPenaltyModels).toContain("kimi-k3");
    expect(KEY_LOGIN_PROVIDERS["opencode-go"].preserveReasoningContentModels).toContain("kimi-k3");
    expect(KEY_LOGIN_PROVIDERS["opencode-go"].openaiChatEofTolerance).toBe(true);
    expect(KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-coder"]).toBe(262_144);
    expect(KEY_LOGIN_PROVIDERS.umans.modelContextWindows?.["umans-glm-5.2"]).toBe(405_504);
    expect(KEY_LOGIN_PROVIDERS.umans.modelInputModalities?.["umans-coder"]).toEqual(["text", "image"]);
    expect(KEY_LOGIN_PROVIDERS.umans.modelInputModalities?.["umans-glm-5.2"]).toEqual(["text"]);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].models).toEqual(["gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol-pro", "gpt-5.6-terra-pro", "gpt-5.6-luna-pro", "daybreak-red-latest", "daybreak-blue-latest"]);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelContextWindows?.["gpt-5.6-sol"]).toBe(1_050_000);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelContextWindows?.["gpt-5.6-terra"]).toBe(1_050_000);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelContextWindows?.["gpt-5.6-luna"]).toBe(1_050_000);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelContextWindows?.["gpt-5.6-sol-pro"]).toBe(1_050_000);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelMaxInputTokens?.["gpt-5.6-sol"]).toBe(922_000);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelInputModalities?.["gpt-5.5"]).toEqual(["text", "image"]);
    expect((KEY_LOGIN_PROVIDERS["openai-apikey"] as unknown as { virtualModels?: unknown }).virtualModels).toBeUndefined();
    const apiRegistry = PROVIDER_REGISTRY.find(entry => entry.id === "openai-apikey")!;
    expect(apiRegistry.models).toHaveLength(10);
    expect(Object.keys(apiRegistry.virtualModels ?? {}).sort()).toEqual([
      "gpt-5.6-luna-pro", "gpt-5.6-sol-pro", "gpt-5.6-terra-pro",
    ]);
    expect(apiRegistry.models).not.toContain("gpt-5.6-pro");
    // Daybreak aliases: the `-latest` alias is the stable id OpenAI repoints, so the
    // snapshot ids must NOT appear. Red tracks gpt-5.6-cyber (400k/272k), Blue tracks
    // gpt-5.6-sol (1.05M/922k). Verified 2026-08-11 against the official model pages.
    expect(apiRegistry.models).not.toContain("gpt-5.6-cyber");
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelContextWindows?.["daybreak-red-latest"]).toBe(400_000);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelMaxInputTokens?.["daybreak-red-latest"]).toBe(272_000);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelContextWindows?.["daybreak-blue-latest"]).toBe(1_050_000);
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelMaxInputTokens?.["daybreak-blue-latest"]).toBe(922_000);
    for (const alias of ["daybreak-red-latest", "daybreak-blue-latest"]) {
      expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelInputModalities?.[alias]).toEqual(["text", "image"]);
      // Explicit [] means "expose no effort control". An UNDEFINED entry would instead fall
      // back to the full routed ladder, advertising efforts neither page documents.
      expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelReasoningEfforts?.[alias]).toEqual([]);
    }
    expect(KEY_LOGIN_PROVIDERS["openai-apikey"].modelReasoningEfforts?.["gpt-5.6-sol"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const derived = deriveKeyLoginMap()["openai-apikey"];
    expect(derived.modelMaxInputTokens).not.toBe(apiRegistry.modelMaxInputTokens);
    expect(KEY_LOGIN_PROVIDERS.openrouter.models).toContain("anthropic/claude-sonnet-5");
    expect(KEY_LOGIN_PROVIDERS.openrouter.models).toContain("openai/gpt-5.6-sol");
    expect(KEY_LOGIN_PROVIDERS.openrouter.models).toContain("openai/gpt-5.6-terra");
    expect(KEY_LOGIN_PROVIDERS.openrouter.models).toContain("openai/gpt-5.6-luna");
    expect(KEY_LOGIN_PROVIDERS.openrouter.modelContextWindows?.["anthropic/claude-sonnet-5"]).toBe(1_000_000);
    expect(KEY_LOGIN_PROVIDERS.openrouter.modelContextWindows?.["openai/gpt-5.6-sol"]).toBe(1_050_000);
    expect(KEY_LOGIN_PROVIDERS.openrouter.modelContextWindows?.["openai/gpt-5.6-terra"]).toBe(1_050_000);
    expect(KEY_LOGIN_PROVIDERS.openrouter.modelContextWindows?.["openai/gpt-5.6-luna"]).toBe(1_050_000);
    expect(KEY_LOGIN_PROVIDERS.deepseek.models).toContain("deepseek-v4-pro");
    // #1057: DeepSeek's ladder is low/high/max and the two V4 models resolve it
    // differently (api-docs.deepseek.com/guides/thinking_mode, verified 2026-08-06).
    // `xhigh` is an alias, so it stays in the wire map but is not advertised. Pro
    // does not honor `low` (the vendor maps it to `high`), so Pro must not offer it.
    expect(KEY_LOGIN_PROVIDERS.deepseek.modelReasoningEfforts?.["deepseek-v4-pro"]).toEqual(["low", "high", "max"]);
    expect(KEY_LOGIN_PROVIDERS.deepseek.modelReasoningEfforts?.["deepseek-v4-flash"]).toEqual(["low", "high", "max"]);
    expect(KEY_LOGIN_PROVIDERS.deepseek.modelReasoningEffortMap?.["deepseek-v4-pro"]?.low).toBe("low");
    expect(KEY_LOGIN_PROVIDERS.deepseek.modelReasoningEffortMap?.["deepseek-v4-pro"]?.xhigh).toBe("high");
    expect(KEY_LOGIN_PROVIDERS.deepseek.modelReasoningEffortMap?.["deepseek-v4-pro"]?.max).toBe("max");
    expect(KEY_LOGIN_PROVIDERS.deepseek.modelReasoningEffortMap?.["deepseek-v4-flash"]?.low).toBe("low");
    expect(KEY_LOGIN_PROVIDERS.deepseek.modelReasoningEffortMap?.["deepseek-v4-flash"]?.xhigh).toBe("high");
    expect(KEY_LOGIN_PROVIDERS.deepseek.modelReasoningEffortMap?.["deepseek-v4-flash"]?.max).toBe("max");
    expect(KEY_LOGIN_PROVIDERS.deepseek.preserveReasoningContentModels).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    // Issue #88: every DeepSeek API model is text-only input — the vision sidecar covers them.
    expect(KEY_LOGIN_PROVIDERS.deepseek.noVisionModels).toEqual([
      "deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro", "deepseek-v4-flash",
    ]);
  });

  test("OpenAI API route max-input metadata is trusted and user values only lower it", () => {
    const makeConfig = (value: number, context = 2_000_000): OcxConfig => ({
      port: 10100,
      defaultProvider: "openai-apikey",
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          modelMaxInputTokens: { "gpt-5.6-sol": value },
          modelContextWindows: { "gpt-5.6-sol": context },
        },
      },
    });
    expect(routeModel(makeConfig(1_000_000), "openai-apikey/gpt-5.6-sol").provider.modelMaxInputTokens?.["gpt-5.6-sol"]).toBe(922_000);
    expect(routeModel(makeConfig(300_000), "openai-apikey/gpt-5.6-sol").provider.modelMaxInputTokens?.["gpt-5.6-sol"]).toBe(300_000);
    expect(routeModel(makeConfig(922_000), "openai-apikey/gpt-5.6-sol").provider.modelContextWindows?.["gpt-5.6-sol"]).toBe(1_050_000);
    expect(routeModel(makeConfig(922_000, 350_000), "openai-apikey/gpt-5.6-sol").provider.modelContextWindows?.["gpt-5.6-sol"]).toBe(350_000);
    expect((routeModel(makeConfig(300_000), "openai-apikey/gpt-5.6-sol").provider as unknown as { virtualModels?: unknown }).virtualModels).toBeUndefined();
  });

  test("non-API route max-input metadata keeps user overrides and fills registry defaults", () => {
    const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === "zai")!;
    const originalMaxInputTokens = registryEntry.modelMaxInputTokens;
    try {
      registryEntry.modelMaxInputTokens = {
        "glm-5.2": 100_000,
        "glm-5.2[1m]": 800_000,
      };
      const config: OcxConfig = {
        port: 10100,
        defaultProvider: "zai",
        providers: {
          zai: {
            adapter: "openai-chat",
            baseUrl: "https://api.z.ai/api/coding/paas/v4",
            modelMaxInputTokens: { "glm-5.2": 200_000 },
          },
        },
      };

      expect(routeModel(config, "zai/glm-5.2").provider.modelMaxInputTokens).toEqual({
        "glm-5.2": 200_000,
        "glm-5.2[1m]": 800_000,
      });
    } finally {
      if (originalMaxInputTokens === undefined) delete registryEntry.modelMaxInputTokens;
      else registryEntry.modelMaxInputTokens = originalMaxInputTokens;
    }
  });

  test("registry output-token defaults hydrate stale provider configs and keep user overrides", () => {
    const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === "zai")!;
    const originalDefaultMaxOutputTokens = registryEntry.defaultMaxOutputTokens;
    const originalModelMaxOutputTokens = registryEntry.modelMaxOutputTokens;
    try {
      registryEntry.defaultMaxOutputTokens = 32_000;
      registryEntry.modelMaxOutputTokens = {
        "glm-5.2": 128_000,
        "glm-5.2[1m]": 128_000,
      };
      const config: OcxConfig = {
        port: 10100,
        defaultProvider: "zai",
        providers: {
          zai: {
            adapter: "openai-chat",
            baseUrl: "https://api.z.ai/api/coding/paas/v4",
            defaultMaxOutputTokens: 16_000,
            modelMaxOutputTokens: { "glm-5.2": 64_000 },
          },
        },
      };

      const routed = routeModel(config, "zai/glm-5.2");

      expect(routed.provider.defaultMaxOutputTokens).toBe(16_000);
      expect(routed.provider.modelMaxOutputTokens).toEqual({
        "glm-5.2": 64_000,
        "glm-5.2[1m]": 128_000,
      });
      expect(providerConfigSeed(registryEntry).modelMaxOutputTokens?.["glm-5.2"]).toBe(128_000);
      expect(deriveKeyLoginMap().zai.modelMaxOutputTokens?.["glm-5.2"]).toBe(128_000);
    } finally {
      if (originalDefaultMaxOutputTokens === undefined) delete registryEntry.defaultMaxOutputTokens;
      else registryEntry.defaultMaxOutputTokens = originalDefaultMaxOutputTokens;
      if (originalModelMaxOutputTokens === undefined) delete registryEntry.modelMaxOutputTokens;
      else registryEntry.modelMaxOutputTokens = originalModelMaxOutputTokens;
    }
  });

  test("providerConfigSeed preserves the registry auth kind, including local", () => {
    const local = PROVIDER_REGISTRY.find(entry => entry.authKind === "local");
    expect(local).toBeDefined();
    expect(providerConfigSeed(local!).authMode).toBe("local");
    const key = PROVIDER_REGISTRY.find(entry => entry.id === "deepseek");
    expect(key).toBeDefined();
    expect(providerConfigSeed(key!).authMode).toBe("key");
  });

  test("CN provider defaults and context windows match the audited registry refresh", () => {
    const deepseek = PROVIDER_REGISTRY.find(entry => entry.id === "deepseek");
    expect(deepseek).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-flash",
      modelContextWindows: {
        "deepseek-v4-flash": 1_048_576,
        "deepseek-v4-pro": 1_048_576,
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
      expect(entry?.modelReasoningEfforts?.["MiniMax-M3"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(entry?.modelDefaultReasoningEfforts?.["MiniMax-M3"]).toBe("medium");
      expect(entry?.modelReasoningEffortMap?.["MiniMax-M3"]).toMatchObject({ low: "disabled", medium: "adaptive", high: "adaptive" });
      expect(entry?.preserveReasoningContentModels).toEqual(minimaxModels);
      expect(entry?.reasoningSplitModels).toEqual(minimaxModels);
      expect(entry?.thinkingToggleModels).toEqual(["MiniMax-M3"]);
      for (const modelId of minimaxModels.slice(1)) {
        expect(entry?.modelContextWindows?.[modelId]).toBe(204_800);
      }
    }
  });

  test("Alibaba Token Plan exposes the official Beijing model contract separately from Coding Plan", () => {
    expect(KEY_LOGIN_PROVIDERS.alibaba).toMatchObject({
      label: "Alibaba Coding Plan",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    });
    expect(PROVIDER_REGISTRY.find(entry => entry.id === "alibaba")?.baseUrlChoices).toEqual([
      { id: "intl", label: "International", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1" },
      { id: "china", label: "China", baseUrl: "https://coding.dashscope.aliyuncs.com/v1" },
      { id: "custom", label: "Custom" },
    ]);
    expect(KEY_LOGIN_PROVIDERS["alibaba-token-plan"]).toMatchObject({
      label: "Alibaba Token Plan (Beijing)",
      adapter: "openai-chat",
      baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      defaultModel: "qwen3.8-max",
      liveModels: false,
      models: [
        "qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash",
        "glm-5.3", "glm-5.3-flash", "glm-5.2", "deepseek-v4-pro",
      ],
      modelInputModalities: {
        "qwen3.8-max": ["text", "image"],
        "qwen3.7-max": ["text", "image"],
      },
      modelReasoningEfforts: {
        "qwen3.8-max": ["low", "medium", "xhigh"],
      },
      modelDefaultReasoningEfforts: { "qwen3.8-max": "xhigh" },
      modelContextWindows: {
        "qwen3.8-max": 983_616,
        "qwen3.7-max": 1_000_000,
        "deepseek-v4-pro": 1_000_000,
      },
      noVisionModels: ["glm-5.3", "glm-5.2", "deepseek-v4-pro"],
      preserveReasoningContentModels: expect.arrayContaining(["qwen3.8-max", "qwen3.7-max", "qwen3.7-plus"]),
    });
    expect(PROVIDER_REGISTRY.find(entry => entry.id === "alibaba-token-plan")?.directReasoningEffortModels)
      .toEqual(["qwen3.8-max"]);
    expect(KEY_LOGIN_PROVIDERS["alibaba-token-plan"].thinkingBudgetModels)
      .not.toContain("qwen3.8-max");
    expect(KEY_LOGIN_PROVIDERS["alibaba-token-plan"].thinkingBudgetModels)
      .toContain("qwen3.7-max");
  });

  test("aggregator defaults and Neuralwatt seeds match the audited live catalogs", () => {
    const cerebras = PROVIDER_REGISTRY.find(entry => entry.id === "cerebras");
    expect(cerebras?.defaultModel).toBe("gpt-oss-120b");

    const neuralwatt = PROVIDER_REGISTRY.find(entry => entry.id === "neuralwatt");
    expect(neuralwatt?.models).toEqual([
      "glm-5.3", "glm-5.3-fast", "glm-5.3-short", "glm-5.3-short-fast",
      "glm-5.3-flash",
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
      "glm-5.3", "glm-5.3-fast", "glm-5.3-short", "glm-5.3-short-fast",
      "glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast",
      "qwen3.5-397b", "qwen3.5-397b-fast",
    ]);
    expect(neuralwatt?.preserveReasoningContentModels).toContain("glm-5.2-short");
    expect(neuralwatt?.preserveReasoningContentModels).not.toContain("moonshotai/Kimi-K2.5");
  });

  test("Z.AI and Kimi context aliases route with bracket-suffix stripping", () => {
    const zai = PROVIDER_REGISTRY.find(entry => entry.id === "zai");
    const optedInProviders = PROVIDER_REGISTRY
      .filter(entry => entry.modelSuffixBracketStrip)
      .map(entry => entry.id);
    expect(zai?.modelContextWindows).toEqual({ "glm-5.3": 1_000_000, "glm-5.3[1m]": 1_000_000, "glm-5.3-flash": 1_000_000, "glm-5.2": 1_000_000, "glm-5.2[1m]": 1_000_000 });
    // BUG-R5: glm-5.3-flash is a native VLM (docs.z.ai/guides/vlm/glm-5.3-flash), so it
    // must never sit in noVisionModels - that list routes a model's images through the
    // proxy's vision sidecar, which hands the model a text description of a picture it
    // can read itself. The seeding pass classified it from the family name; the
    // correction pass fixed the Alibaba entries and missed eight other providers.
    //
    // Asserted across the WHOLE registry rather than per provider, because the defect
    // was not one entry being wrong - it was a set of entries drifting apart, and only
    // a global assertion catches the next provider to seed it.
    for (const entry of PROVIDER_REGISTRY) {
      const flashIds = (entry.models ?? []).filter(id => String(id).includes("glm-5.3-flash"));
      for (const id of flashIds) {
        expect(entry.noVisionModels ?? []).not.toContain(id);
        // An explicit modality declaration must include image. Absent is allowed: an
        // unclassified model falls through to native passthrough, which is correct here.
        const declared = entry.modelInputModalities?.[id];
        if (declared) expect(declared).toContain("image");
      }
    }
    // The sibling it is most often confused with stays text-only, so the assertion above
    // cannot pass by making every GLM row a VLM.
    expect(zai?.noVisionModels ?? []).toContain("glm-5.3");
    // `glm-5.3-flash` belongs in all three maps. It was seeded into the model list
    // and the context map alone, so it advertised a 1M window with no effort ladder,
    // no default effort and no output cap - and this assertion pinned that gap in
    // place rather than catching it, because it was written from the incomplete
    // state instead of from the family definition.
    expect(zai?.modelDefaultReasoningEfforts).toEqual({ "glm-5.3": "max", "glm-5.3[1m]": "max", "glm-5.3-flash": "max" });
    expect(zai?.modelMaxOutputTokens).toEqual({ "glm-5.3": 131_072, "glm-5.3[1m]": 131_072, "glm-5.3-flash": 131_072 });
    // Every 5.3 row carries the same three-tier ladder. Asserted per member rather
    // than as one object literal so adding a member cannot quietly skip it.
    for (const id of ["glm-5.3", "glm-5.3[1m]", "glm-5.3-flash"]) {
      expect(zai?.modelReasoningEfforts?.[id]).toEqual(["low", "high", "max"]);
      expect(zai?.modelDefaultReasoningEfforts?.[id]).toBe("max");
      expect(zai?.modelMaxOutputTokens?.[id]).toBe(131_072);
    }
    expect(providerConfigSeed(zai!).modelSuffixBracketStrip).toBe(true);
    expect(providerConfigSeed(zai!).modelDefaultReasoningEfforts?.["glm-5.3"]).toBe("max");
    expect(deriveKeyLoginMap().zai.modelMaxOutputTokens?.["glm-5.3[1m]"]).toBe(131_072);
    // `zhipu-bigmodel-coding` opts in for the same reason `zai` does: it serves the same
    // bracketed GLM ids, and that vendor's OpenAI path returns 400 code 1211 for them.
    expect(optedInProviders).toEqual(["kimi", "zai", "zhipu-bigmodel-coding", "kimi-code"]);

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
    const routed53 = routeModel(config, "zai/glm-5.3");
    expect(routed53.provider.modelDefaultReasoningEfforts?.["glm-5.3"]).toBe("max");
    expect(routed53.provider.modelMaxOutputTokens?.["glm-5.3"]).toBe(131_072);
    expect(routeModel(config, "zai/glm-5.2[1m]").provider.modelSuffixBracketStrip).toBe(true);

    const glm53Model = applyProviderConfigHints("zai", providerConfigSeed(zai!), {
      provider: "zai",
      id: "glm-5.3",
    });
    const glm53Entry = buildCatalogEntries(nativeTemplate(), [], [glm53Model])
      .find(entry => entry.slug === "zai/glm-5.3");
    expect(glm53Entry?.default_reasoning_level).toBe("max");
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
      "k3",
      "k3[1m]",
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
        expect(entry?.modelContextWindows?.[modelId]).toBe(modelId === "k3[1m]" ? 1_048_576 : 262_144);
      }
      for (const field of parityLists) {
        expect(entry?.[field]).toContain("kimi-k2.7-code");
        expect(entry?.[field]).toContain("kimi-for-coding");
      }
      expect(entry?.modelSuffixBracketStrip).toBe(true);
      expect(entry?.promptCacheKey).toBe(true);
      // Key-pool 429 rotation rebuilds the provider from the persisted config (not the routed
      // one), so the flag must survive seeding/enrichment, not just the router's registry backfill.
      expect(providerConfigSeed(entry!).promptCacheKey).toBe(true);
      const enriched: OcxProviderConfig = { adapter: "openai-chat", baseUrl: entry!.baseUrl };
      enrichProviderFromCatalog(providerId, enriched);
      expect(enriched.promptCacheKey).toBe(true);
      expect(entry?.noReasoningModels).not.toContain("k3");
      expect(entry?.noReasoningModels).not.toContain("k3[1m]");
      expect(entry?.modelReasoningEfforts?.k3).toEqual(["low", "high", "max"]);
      expect(entry?.modelReasoningEfforts?.["k3[1m]"]).toEqual(["low", "high", "max"]);
      for (const modelId of ["k3", "k3[1m]"]) {
        expect(entry?.modelDefaultReasoningEfforts?.[modelId]).toBe("max");
        expect(entry?.modelReasoningEffortMap?.[modelId]).toEqual({
          none: "none",
          low: "low",
          medium: "high",
          high: "high",
          xhigh: "max",
          max: "max",
        });
      }
      expect(entry?.modelInputModalities?.k3).toEqual(["text", "image"]);
      expect(entry?.modelInputModalities?.["k3[1m]"]).toEqual(["text", "image"]);
      expect(entry?.noTemperatureModels).toContain("k3");
      expect(entry?.noTemperatureModels).toContain("k3[1m]");
      expect(entry?.noTopPModels).toContain("k3");
      expect(entry?.noPenaltyModels).toContain("k3");
      expect(entry?.preserveReasoningContentModels).toContain("k3");
      expect(entry?.preserveReasoningContentModels).toContain("k3[1m]");
      expect(entry?.modelReasoningEfforts?.["kimi-for-coding"]).toEqual([]);
    }

    const kimi = PROVIDER_REGISTRY.find(provider => provider.id === "kimi")!;
    const kimiModel = applyProviderConfigHints("kimi", providerConfigSeed(kimi), { provider: "kimi", id: "k3" });
    const kimiEntry = buildCatalogEntries(nativeTemplate(), [], [kimiModel]).find(entry => entry.slug === "kimi/k3");
    expect(kimiEntry?.default_reasoning_level).toBe("max");

    const moonshot = PROVIDER_REGISTRY.find(provider => provider.id === "moonshot");
    expect(moonshot?.baseUrl).toBe("https://api.moonshot.ai/v1");
    expect(moonshot?.allowBaseUrlOverride).toBe(true);
    expect(moonshot?.baseUrlChoices?.map(c => c.id)).toEqual(["international", "china", "custom"]);
    expect(moonshot?.baseUrlChoices?.find(c => c.id === "china")?.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(moonshot?.models).toContain("kimi-k3");
    expect(moonshot?.models).not.toContain("k3");
    expect(moonshot?.models).not.toContain("kimi-for-coding");
    expect(moonshot?.modelContextWindows).toEqual({
      "kimi-k3": 1_048_576,
      "kimi-k2.7-code": 262_144,
      "kimi-k2.7-code-highspeed": 262_144,
      "kimi-k2.6": 262_144,
      "kimi-k2.5": 262_144,
    });
    expect(moonshot?.modelInputModalities?.["kimi-k3"]).toEqual(["text", "image"]);
    expect(moonshot?.noReasoningModels).not.toContain("kimi-k3");
    expect(moonshot?.modelReasoningEfforts?.["kimi-k3"]).toEqual(["max"]);
    expect(moonshot?.modelReasoningEffortMap).toBeUndefined();
    expect(moonshot?.preserveReasoningContentModels).toContain("kimi-k3");
  });

  test("LiteLLM is the only registry seed with optional key authentication", () => {
    const litellm = PROVIDER_REGISTRY.find(entry => entry.id === "litellm");
    const optionalKeyProviders = PROVIDER_REGISTRY.filter(entry => entry.keyOptional).map(entry => entry.id);

    expect(litellm?.authKind).toBe("key");
    expect(providerConfigSeed(litellm!).keyOptional).toBe(true);
    expect(optionalKeyProviders).toEqual(["litellm", "opencode-free", "mimo-free"]);
  });

  test("NVIDIA NIM is free-tier priced but still requires an API key", () => {
    const nvidia = PROVIDER_REGISTRY.find(entry => entry.id === "nvidia");
    const freeTierProviders = PROVIDER_REGISTRY.filter(entry => entry.freeTier).map(entry => entry.id);

    expect(nvidia?.freeTier).toBe(true);
    expect(nvidia?.authKind).toBe("key");
    expect(nvidia?.keyOptional).toBeUndefined();
    // nous is a MIXED free/paid provider: the free tier is per-model (the
    // `:free` slugs), not a property of the whole provider, so it is not in
    // the provider-level freeTier list (see review feedback on PR #1397).
    expect(freeTierProviders).toEqual(["scaleway", "nvidia", "cloudflare-workers-ai"]);
  });

  test("nous exposes free models at model level, not provider level", () => {
    const nous = PROVIDER_REGISTRY.find(entry => entry.id === "nous");
    expect(nous?.freeTier).toBe(false);
    const freeSlugs = (nous?.models ?? []).filter(m => m.endsWith(":free"));
    expect(freeSlugs).toEqual([
      "tencent/hy3:free",
      "poolside/laguna-s-2.1:free",
      "stepfun/step-3.7-flash:free",
      "poolside/laguna-xs-2.1:free",
    ]);
  });

  test("freeTier propagates through config seed, enrich backfill, and presets without overwriting user config", async () => {
    const { enrichProviderFromRegistry } = await import("../src/providers/derive");
    const nvidia = PROVIDER_REGISTRY.find(entry => entry.id === "nvidia")!;

    // Seed propagation.
    expect(providerConfigSeed(nvidia).freeTier).toBe(true);

    // Enrich backfills only when the user config leaves freeTier unset.
    const unset: OcxProviderConfig = { adapter: nvidia.adapter, baseUrl: nvidia.baseUrl };
    enrichProviderFromRegistry("nvidia", unset);
    expect(unset.freeTier).toBe(true);

    // A user-set explicit false is preserved.
    const optedOut: OcxProviderConfig = { adapter: nvidia.adapter, baseUrl: nvidia.baseUrl, freeTier: false };
    enrichProviderFromRegistry("nvidia", optedOut);
    expect(optedOut.freeTier).toBe(false);

    // Preset propagation.
    const preset = deriveProviderPresets().find(p => p.id === "nvidia");
    expect(preset?.freeTier).toBe(true);

    // Providers without the registry flag stay unset.
    const venice = PROVIDER_REGISTRY.find(entry => entry.id === "venice")!;
    expect(providerConfigSeed(venice)).not.toHaveProperty("freeTier");
    expect(deriveProviderPresets().find(p => p.id === "venice")).not.toHaveProperty("freeTier");
  });

  test("base URL override permission is registry-only and limited to opted-in providers", () => {
    const optedIn = PROVIDER_REGISTRY.filter(entry => entry.allowBaseUrlOverride);

    // Registry order. Both OAuth entries (anthropic, google-antigravity) are gated by
    // providerSecureTransportConfigError; the rest are key/local providers that never send a
    // subscription bearer to the override.
    expect(optedIn.map(entry => entry.id)).toEqual(["anthropic", "google-antigravity", "ollama", "vllm", "lm-studio", "moonshot", "qwen-cloud", "alibaba", "alibaba-token-plan-intl", "litellm"]);
    for (const entry of optedIn) {
      expect(providerConfigSeed(entry)).not.toHaveProperty("allowBaseUrlOverride");
    }
  });

  test("Ollama Cloud uses the three live tagged IDs without retaining bare aliases", () => {
    const ollamaCloud = PROVIDER_REGISTRY.find(entry => entry.id === "ollama-cloud");

    expect(ollamaCloud?.models).toEqual([
      "glm-5.3", "glm-5.3-flash", "glm-5.2", "deepseek-v4-pro", "qwen3-coder:480b", "gpt-oss:120b",
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
    expect(cursor?.noVisionModels).toEqual([...CURSOR_NO_VISION_MODELS]);
    expect(seed.noVisionModels).toEqual([...CURSOR_NO_VISION_MODELS]);
    expect(seed.noVisionModels).toContain("composer-2.5");
    expect(seed.noVisionModels).toContain("glm-5.3");
    expect(seed.noVisionModels).not.toContain("grok-4.5");
    expect(seed.modelInputModalities?.auto).toEqual(["text", "image"]);
    expect(seed.modelInputModalities?.["composer-2.5"]).toEqual(["text", "image"]);

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
    expect(OAUTH_PROVIDERS.anthropic.providerConfig.modelContextWindows?.["claude-opus-4-7"]).toBe(1_000_000);
    expect(OAUTH_PROVIDERS.anthropic.providerConfig.modelContextWindows?.["claude-opus-4-6"]).toBe(1_000_000);
    expect(OAUTH_PROVIDERS.anthropic.providerConfig.modelContextWindows?.["claude-sonnet-4-6"]).toBe(1_000_000);
    for (const model of OAUTH_PROVIDERS.anthropic.providerConfig.models ?? []) {
      expect(OAUTH_PROVIDERS.anthropic.providerConfig.modelContextWindows?.[model]).toBeGreaterThan(0);
    }
    expect(OAUTH_PROVIDERS.xai.providerConfig.defaultModel).toBe("grok-4.5");
    expect(OAUTH_PROVIDERS.xai.providerConfig.liveModels).toBe(true);
    expect(OAUTH_PROVIDERS.xai.providerConfig.models).toContain("grok-4.6");
    expect(OAUTH_PROVIDERS.xai.providerConfig.models).toContain("grok-4.5");
    expect(OAUTH_PROVIDERS.xai.providerConfig.modelContextWindows?.["grok-4.6"]).toBe(500_000);
    expect(OAUTH_PROVIDERS.xai.providerConfig.modelContextWindows?.["grok-4.5"]).toBe(500_000);
    expect(OAUTH_PROVIDERS.xai.providerConfig.modelReasoningEfforts?.["grok-4.6"]).toEqual(["low", "medium", "high", "xhigh"]);
    expect(OAUTH_PROVIDERS.xai.providerConfig.modelReasoningEfforts?.["grok-4.5"]).toEqual(["low", "medium", "high"]);
    expect(OAUTH_PROVIDERS.xai.providerConfig.modelDefaultReasoningEfforts).toEqual({ "grok-4.6": "high" });
    expect(OAUTH_PROVIDERS.xai.providerConfig.modelReasoningEffortMap).toBeUndefined();
    expect(OAUTH_PROVIDERS.xai.providerConfig.noVisionModels).toContain("grok-build-0.1");
    const antigravityRegistry = PROVIDER_REGISTRY.find(entry => entry.id === "google-antigravity");
    expect(antigravityRegistry?.liveModels).toBe(true);
    expect(providerConfigSeed(antigravityRegistry!).liveModels).toBe(true);
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.liveModels).toBe(true);
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.defaultModel).toBe("gemini-3.7-flash");
    // Collapsed picker: base models only, no effort-suffix variants.
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.models).toContain("gemini-3.7-flash");
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.models).toContain("gemini-3.1-pro");
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.models).toContain("claude-sonnet-4-6");
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.models).toContain("claude-opus-4-6-thinking");
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.models).toContain("gpt-oss-120b-medium");
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.models).toContain("gemini-3.1-flash-image");
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.models).toHaveLength(6);
    // Effort ladders on collapsed base models.
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.modelReasoningEfforts?.["gemini-3.7-flash"]).toEqual(["low", "medium", "high"]);
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.modelReasoningEfforts?.["gemini-3.1-pro"]).toEqual(["low", "high"]);
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.modelReasoningEfforts?.["claude-opus-4-6-thinking"]).toEqual(["low", "medium", "high", "max"]);
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.modelReasoningEfforts?.["claude-sonnet-4-6"]).toEqual(["low", "medium", "high", "max"]);
    // Context windows on collapsed base models.
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.modelContextWindows?.["gemini-3.7-flash"]).toBe(1_048_576);
    expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.modelContextWindows?.["gemini-3.1-pro"]).toBe(1_048_576);
    // Suffix and compat IDs are NOT in the picker list.
    for (const hidden of [
      "gemini-3.6-flash",
      "gemini-3.6-flash-low",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-high",
      "gemini-3.1-pro-low",
      "gemini-pro-agent",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash-extra-low",
      "gemini-3.5-flash-low",
      "gemini-3.5-flash-mid",
      "gemini-3.5-flash-high",
      "gemini-3-flash-agent",
    ]) {
      expect(OAUTH_PROVIDERS["google-antigravity"].providerConfig.models).not.toContain(hidden);
    }
  });

  test("GUI preset projection preserves current featured set plus key catalog and custom", () => {
    const featured = deriveFeaturedProviderIds();
    expect(featured).toEqual([
      "openai", "xai", "command-code", "anthropic", "anthropic-apikey", "kimi", "nous", "openai-apikey", "umans", "opencode-go", "openrouter",
      "groq", "google", "azure-openai", "ollama", "vllm", "lm-studio", "opencode-free",
      "mimo-free",
    ]);

    const presets = deriveProviderPresets();
    expect(presets.filter(p => p.id === "chatgpt" || p.id === "openai" || p.id.startsWith("openai-")).map(p => p.id))
      .toEqual(["openai", "openai-apikey"]);
    expect(presets.find(p => p.id === "openai")).toMatchObject({ label: "OpenAI (Codex login)", codexAccountMode: "pool" });
    expect(presets.find(p => p.id === "openai-multi")).toBeUndefined();
    expect(presets.find(p => p.id === "openai-apikey")?.label).toBe("OpenAI API");
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

    const nextPresets = deriveProviderPresets();
    const directSeed = presets.find(p => p.id === "openai")!.provider!;
    directSeed.baseUrl = "https://mutated.example.test";
    expect(nextPresets.find(p => p.id === "openai")!.provider).toEqual(
      providerConfigSeed(PROVIDER_REGISTRY.find(entry => entry.id === "openai")!),
    );
    expect(presets.find(p => p.id === "openai-apikey")?.provider).toBeUndefined();
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
      deepseek: "deepseek",
      moonshot: "moonshot",
      minimax: "minimax",
      "minimax-cn": "minimax",
      "zhipu-bigmodel": "zai",
      "zhipu-bigmodel-coding": "zai",
    });
    expect(resolveMetadataProvider("gemini")).toBe("google");
    expect(resolveMetadataProvider("minimax-cn")).toBe("minimax");
    expect(resolveMetadataProvider("deepseek")).toBe("deepseek");
    // User-saved provider keys can be title-cased ("DeepSeek"); alias lookup folds case.
    expect(resolveMetadataProvider("DeepSeek")).toBe("deepseek");
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
    expect(getModelMetadata("minimax", "MiniMax-M2.5")?.contextWindow).toBe(204_800);
    expect(getModelMetadata("minimax", "minimax-m2.5")).toBeUndefined();

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

  test("grok-4.6 advertises the documented xhigh rung from the xai registry seed", () => {
    const xai = PROVIDER_REGISTRY.find(entry => entry.id === "xai");
    const seed = providerConfigSeed(xai!);
    const model = applyProviderConfigHints("xai", seed, { id: "grok-4.6", provider: "xai" });
    expect(model.contextWindow).toBe(500_000);
    expect(model.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);

    const entries = buildCatalogEntries(nativeTemplate() as never, [], [model]);
    const entry = entries.find(e => e.slug === "xai/grok-4.6");
    expect(entry).toBeTruthy();
    expect(entry?.context_window).toBe(500_000);
    expect((entry?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort))
      .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(entry?.default_reasoning_level).toBe("high");
  });

  // The id-list assertion above only proves the preset exists. Pin the contract a user actually
  // depends on: which endpoint the key is sent to, which adapter parses the stream, and that the
  // vendor-namespaced seed models survive into a real catalog entry.
  test("the BizRouter preset seeds a usable OpenAI-compatible provider", () => {
    const bizrouter = PROVIDER_REGISTRY.find(entry => entry.id === "bizrouter");
    expect(bizrouter).toBeTruthy();
    expect(bizrouter?.adapter).toBe("openai-chat");
    expect(bizrouter?.authKind).toBe("key");
    expect(bizrouter?.baseUrl).toBe("https://api.bizrouter.ai/v1");
    // A default the picker can actually route to, and it must be one of the seeded ids.
    expect(bizrouter?.models).toContain(bizrouter?.defaultModel);

    const seed = providerConfigSeed(bizrouter!);
    expect(seed.baseUrl).toBe("https://api.bizrouter.ai/v1");
    expect(seed.adapter).toBe("openai-chat");

    // Vendor-namespaced ids pass through unchanged: rewriting them would break upstream routing.
    const model = applyProviderConfigHints("bizrouter", seed, {
      id: "openai/gpt-5.6-sol",
      provider: "bizrouter",
    });
    expect(model.id).toBe("openai/gpt-5.6-sol");

    const entries = buildCatalogEntries(nativeTemplate() as never, [], [model]);
    // The catalog slug flattens the vendor separator, but the routed model id itself is untouched,
    // so the request still reaches BizRouter as `openai/gpt-5.6-sol`.
    expect(entries.find(e => e.slug === "bizrouter/openai-gpt-5.6-sol")).toBeTruthy();
  });

  test("the Command Code preset seeds a usable live-discovery provider", () => {
    const commandcode = PROVIDER_REGISTRY.find(entry => entry.id === "commandcode");
    expect(commandcode).toBeTruthy();
    expect(commandcode?.adapter).toBe("openai-chat");
    expect(commandcode?.authKind).toBe("key");
    expect(commandcode?.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
    expect(commandcode?.liveModels).toBe(true);
    // The default must be a real id in the public catalog that live discovery can return.
    expect(commandcode?.defaultModel).toBe("deepseek/deepseek-v4-flash");
    // The public /models endpoint is unauthenticated, so key validation must stay honest.
    expect(commandcode?.apiKeyValidation).toBe("unknown");

    const seed = providerConfigSeed(commandcode!);
    expect(seed.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
    expect(seed.adapter).toBe("openai-chat");
    expect(seed.defaultModel).toBe("deepseek/deepseek-v4-flash");
    expect(seed).not.toHaveProperty("apiKeyValidation");

    // Vendor-namespaced ids pass through unchanged: rewriting them would break upstream routing.
    const model = applyProviderConfigHints("commandcode", seed, {
      id: "deepseek/deepseek-v4-flash",
      provider: "commandcode",
    });
    expect(model.id).toBe("deepseek/deepseek-v4-flash");

    const entries = buildCatalogEntries(nativeTemplate() as never, [], [model]);
    // The catalog slug flattens the vendor separator, but the routed model id itself is untouched,
    // so the request still reaches Command Code as `deepseek/deepseek-v4-flash`.
    expect(entries.find(e => e.slug === "commandcode/deepseek-deepseek-v4-flash")).toBeTruthy();
  });

  /*
   * #2883, at the surface the reporter actually saw. A live-discovered model with no
   * row in the effort table falls through `configuredReasoningEfforts` to the
   * provider-level `reasoningEfforts: []`, which `applyProviderConfigHints` then
   * writes onto the model — so the Codex App picker renders empty and the request
   * carries `requestedEffort: "none"`. Asserting the catalog entry rather than just
   * the table is what makes this a regression test for the symptom.
   */
  test("the Command Code GLM-5.3-Flash route reaches the catalog with a selectable ladder", () => {
    const commandcode = PROVIDER_REGISTRY.find(entry => entry.id === "commandcode");
    const seed = providerConfigSeed(commandcode!);
    const model = applyProviderConfigHints("commandcode", seed, {
      id: "z-ai/glm-5.3-flash",
      provider: "commandcode",
    });
    expect(model.id).toBe("z-ai/glm-5.3-flash");
    expect(model.reasoningEfforts).toEqual(["low", "high", "max"]);

    const entries = buildCatalogEntries(nativeTemplate() as never, [], [model]);
    const entry = entries.find(e => e.slug === "commandcode/z-ai-glm-5.3-flash");
    expect(entry).toBeTruthy();
    // The empty ladder is exactly the reported symptom: an empty picker in the app.
    expect(entry?.supported_reasoning_levels).not.toEqual([]);
    // Routed catalogs append the synthetic top rung, as every other routed row above does.
    expect((entry?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort))
      .toEqual(["low", "high", "max", "ultra"]);
  });
  /*
   * #1043. Zen publishes no modality metadata, so the classification below is an
   * empirical list measured against the live endpoint on 2026-08-05, not something
   * derived from provider data.
   *
   * The negative half is the part that matters. `mimo-v2.5-free` and
   * `longcat-2.0-free` accept images; listing them would silently swap a working
   * image for a caption, which is a worse failure than the loud 400 this fixes
   * because nothing surfaces it. This test exists so a future "classify all the
   * free models" patch fails here instead of shipping.
   */
  test("Zen text-only classification covers the measured models and excludes the vision ones", () => {
    const measuredTextOnly = [
      "big-pickle",
      "nemotron-3-ultra-free",
      "ling-3.0-flash-free",
      "north-mini-code-free",
      "laguna-s-2.1-free",
      "deepseek-v4-flash-free",
    ];
    // Measured as ACCEPTING images. Never add these to a noVisionModels list.
    const measuredVisionCapable = ["mimo-v2.5-free", "longcat-2.0-free"];

    for (const providerId of ["opencode-zen", "opencode-free"]) {
      const entry = PROVIDER_REGISTRY.find(p => p.id === providerId);
      expect(entry, `registry entry ${providerId} is missing`).toBeTruthy();
      expect(entry?.baseUrl, `${providerId} should serve the Zen roster`)
        .toBe("https://opencode.ai/zen/v1");

      const listed = entry?.noVisionModels ?? [];
      for (const model of measuredTextOnly) {
        expect(listed, `${providerId} must strip images for text-only ${model}`)
          .toContain(model);
      }
      for (const model of measuredVisionCapable) {
        expect(listed, `${providerId} must NOT strip images for vision-capable ${model}`)
          .not.toContain(model);
      }
    }
  });

});

describe("free-provider directory isolation", () => {
  test("directory metadata never becomes a canonical runtime provider", () => {
    // The directory is a catalog of endpoints we have not adopted. If its ids reached
    // PROVIDER_REGISTRY, routedProviderConfig() would canonicalize a user's same-named provider
    // onto the directory's adapter and baseUrl — for `qoder` that baseUrl is the empty string,
    // so the request would lose its destination entirely.
    const directoryOnlyIds = FREE_PROVIDER_DIRECTORY
      .filter(entry => entry.supportLevel === "reference")
      .map(entry => entry.id);
    expect(directoryOnlyIds.length).toBeGreaterThan(0);
    expect(directoryOnlyIds).toContain("qoder");

    const registryIds = new Set(PROVIDER_REGISTRY.map(entry => entry.id));
    for (const id of directoryOnlyIds) {
      expect(registryIds.has(id)).toBe(false);
    }
  });

  test("an id shared by both lists must resolve to the same endpoint", () => {
    // The rule above only covers `reference` rows, so a CONNECTABLE directory id could be
    // re-registered against a different host and stay green — that is exactly what #536 proposed
    // for `glm` (directory: api.z.ai, proposed registry: open.bigmodel.cn). routedProviderConfig()
    // canonicalizes a saved provider onto the registry baseUrl, so the user's key would have gone
    // to the other vendor on the next request. Sharing an id is fine; disagreeing on where it
    // points is not.
    const registryById = new Map(PROVIDER_REGISTRY.map(entry => [entry.id, entry]));
    const shared = FREE_PROVIDER_DIRECTORY.filter(row => registryById.has(row.id));
    expect(shared.length).toBeGreaterThan(0);

    for (const row of shared) {
      const registryEntry = registryById.get(row.id)!;
      expect(`${row.id} -> ${registryEntry.baseUrl}`).toBe(`${row.id} -> ${row.baseUrl}`);
    }
  });

  test("a custom provider named after a directory entry keeps its own destination", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "qoder",
      providers: {
        qoder: {
          adapter: "openai-chat",
          baseUrl: "https://custom.example.test/v1",
          apiKey: "test-key",
          liveModels: true,
        },
      },
    };

    const routed = routeModel(config, "qoder/custom-model");
    expect(routed.provider).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://custom.example.test/v1",
      liveModels: true,
    });
    expect(routed.modelId).toBe("custom-model");
  });

  test("only rows with checked provenance claim a verification date", () => {
    for (const entry of FREE_PROVIDER_DIRECTORY) {
      if (entry.verification === "unverified") {
        expect(entry.lastVerified).toBeUndefined();
      } else {
        expect(entry.lastVerified).toBeTruthy();
        expect(entry.documentationUrl ?? entry.modelsUrl ?? entry.dashboardUrl).toBeTruthy();
      }
    }
  });

  /*
   * #1057. The registry classifies DeepSeek V4 ids Flash-versus-Pro with a substring
   * test, which is correct for every id shipped today but is exactly the kind of
   * thing that misfires on a future name. This enumerates every provider/model pair
   * that actually receives the shared metadata, so a misclassification cannot land
   * silently — it fails here with the offending id named.
   *
   * Ladders: since the V4 Pro GA (DeepSeek-V4-Pro-0813) both models get low/high/max —
   * the vendor's updated thinking-mode table is now identical for Flash and Pro.
   * Neither advertises `xhigh` — it is an alias, kept in the wire map only
   * (api-docs.deepseek.com/guides/thinking_mode, verified 2026-08-13).
   */
  test("every DeepSeek V4 entry advertises its own ladder and alias mapping", () => {
    const flashLadder = ["low", "high", "max"];
    const proLadder = ["low", "high", "max"];
    const cases: Array<{ provider: string; model: string; flash: boolean }> = [
      { provider: "deepseek", model: "deepseek-v4-pro", flash: false },
      { provider: "deepseek", model: "deepseek-v4-flash", flash: true },
      { provider: "opencode-go", model: "deepseek-v4-pro", flash: false },
      { provider: "opencode-go", model: "deepseek-v4-flash", flash: true },
      { provider: "orcarouter", model: "deepseek/deepseek-v4-pro", flash: false },
      { provider: "volcengine-coding-plan", model: "deepseek-v4-pro", flash: false },
      { provider: "volcengine-coding-plan", model: "deepseek-v4-flash", flash: true },
      { provider: "alibaba-token-plan", model: "deepseek-v4-pro", flash: false },
      { provider: "alibaba-token-plan-intl", model: "deepseek-v4-pro", flash: false },
      { provider: "alibaba-token-plan-intl", model: "deepseek-v4-flash", flash: true },
      { provider: "opencode-free", model: "deepseek-v4-flash-free", flash: true },
    ];

    for (const { provider, model, flash } of cases) {
      const entry = PROVIDER_REGISTRY.find(p => p.id === provider);
      expect(entry, `registry entry ${provider} is missing`).toBeTruthy();

      const ladder = entry?.modelReasoningEfforts?.[model];
      expect(ladder, `${provider}/${model} advertises no ladder`).toBeTruthy();
      expect(ladder, `${provider}/${model} ladder`).toEqual(flash ? flashLadder : proLadder);
      expect(ladder, `${provider}/${model} must not advertise the xhigh alias`)
        .not.toContain("xhigh");

      const map = entry?.modelReasoningEffortMap?.[model];
      expect(map, `${provider}/${model} has no effort map`).toBeTruthy();
      expect(map?.xhigh, `${provider}/${model} xhigh alias`).toBe("high");
      expect(map?.low, `${provider}/${model} low resolution`).toBe("low");
      expect(map?.max, `${provider}/${model} max`).toBe("max");
    }
  });
});
