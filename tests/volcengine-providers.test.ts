import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { applyProviderConfigHints, buildCatalogEntries } from "../src/codex/catalog";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { deriveProviderPresets, providerConfigSeed } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { safeConfigDTO } from "../src/server/auth-cors";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";
import { buildProviderPostBody } from "../gui/src/provider-payload";
import { en } from "../gui/src/i18n/en";
import { interpolate, type TFn } from "../gui/src/i18n/shared";
import { formatProviderDisplayName, isCatalogProviderId } from "../gui/src/provider-icons";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));
const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const englishT: TFn = (key, vars) => interpolate(en[key], vars);

describe("Volcengine Ark providers", () => {
  test("publishes separate pay-as-you-go, Coding Plan, and Agent Plan contracts", () => {
    expect(PROVIDER_REGISTRY.find(provider => provider.id === "volcengine")).toMatchObject({
      label: "Volcengine Ark",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      adapter: "openai-chat",
      authKind: "key",
      preserveCustomDestination: true,
      defaultModel: "doubao-seed-2-1-pro-260628",
      models: [
        "doubao-seed-2-1-pro-260628",
        "doubao-seed-2-1-turbo-260628",
        "doubao-seed-evolving",
        "deepseek-v4-pro-260425",
        "deepseek-v4-flash-260425",
        "deepseek-v3-2-251201",
        "glm-5-2-260617",
        "glm-4-7-251222",
      ],
      liveModels: false,
      thinkingToggleModels: [
        "doubao-seed-2-1-pro-260628",
        "doubao-seed-2-1-turbo-260628",
        "doubao-seed-evolving",
      ],
    });
    expect(PROVIDER_REGISTRY.find(provider => provider.id === "volcengine-coding-plan")).toMatchObject({
      label: "Volcengine Ark Coding Plan",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      adapter: "openai-chat",
      authKind: "key",
      preserveCustomDestination: true,
      defaultModel: "ark-code-latest",
      models: [
        "ark-code-latest",
        "doubao-seed-2.0-code",
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "glm-5.3",
        "glm-5.2",
        "kimi-k2.6",
        "minimax-m3",
      ],
      liveModels: false,
      modelInputModalities: {
        "kimi-k2.6": ["text", "image"],
        "minimax-m3": ["text", "image"],
      },
      // #1057: per-model ladders. Since the V4 Pro GA (DeepSeek-V4-Pro-0813) the
      // vendor table is identical for both models; `xhigh` stays an unadvertised alias.
      modelReasoningEfforts: {
        "deepseek-v4-pro": ["low", "high", "max"],
        "deepseek-v4-flash": ["low", "high", "max"],
      },
      modelReasoningEffortMap: {
        "deepseek-v4-pro": { low: "low", medium: "high", high: "high", xhigh: "high", max: "max" },
        "deepseek-v4-flash": { low: "low", medium: "high", high: "high", xhigh: "high", max: "max" },
      },
      preserveReasoningContentModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
    });
    expect(PROVIDER_REGISTRY.find(provider => provider.id === "volcengine-agent-plan")).toMatchObject({
      label: "Volcengine Ark Agent Plan",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      responsesPath: "/responses",
      adapter: "openai-responses",
      authKind: "key",
      preserveCustomDestination: true,
      defaultModel: "deepseek-v4-pro",
      models: [
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "glm-5.3",
        "glm-5.2",
        "kimi-k2.6",
        "minimax-m3",
        "doubao-seed-2.0-pro",
      ],
      liveModels: false,
      modelInputModalities: {
        "kimi-k2.6": ["text", "image"],
        "minimax-m3": ["text", "image"],
      },
    });
  });

  test("derives key login and dashboard presets from the canonical registry", () => {
    expect(KEY_LOGIN_PROVIDERS.volcengine).toMatchObject({
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      defaultModel: "doubao-seed-2-1-pro-260628",
      liveModels: false,
    });
    expect(KEY_LOGIN_PROVIDERS["volcengine-coding-plan"]).toMatchObject({
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      defaultModel: "ark-code-latest",
      liveModels: false,
      preserveReasoningContentModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
    });
    expect(KEY_LOGIN_PROVIDERS["volcengine-agent-plan"]).toMatchObject({
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      responsesPath: "/responses",
      adapter: "openai-responses",
      defaultModel: "deepseek-v4-pro",
      liveModels: false,
    });
    for (const id of ["volcengine", "volcengine-coding-plan", "volcengine-agent-plan"]) {
      expect(deriveProviderPresets().find(provider => provider.id === id)).toMatchObject({ auth: "key" });
    }
    expect(deriveProviderPresets().find(provider => provider.id === "volcengine-agent-plan"))
      .toMatchObject({ responsesPath: "/responses" });
  });

  test("routes a minimal Agent Plan config to its native Responses resource", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "volcengine-agent-plan",
      providers: {
        "volcengine-agent-plan": {
          adapter: "openai-responses",
          baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
          authMode: "key",
          apiKey: "test-key",
        },
      },
    };
    const route = routeModel(config, "volcengine-agent-plan/deepseek-v4-pro");
    expect(route.provider.responsesPath).toBe("/responses");

    const request = createResponsesPassthroughAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: route.modelId, input: "ping", stream: true },
    }, { headers: new Headers() });
    expect(request.url).toBe("https://ark.cn-beijing.volces.com/api/plan/v3/responses");
  });

  test.each([
    ["volcengine", "openai-chat", "https://custom.example.com/api/v3"],
    ["volcengine-coding-plan", "openai-chat", "https://custom.example.com/api/coding/v3"],
    ["volcengine-agent-plan", "openai-responses", "https://custom.example.com/api/plan/v3"],
  ] as const)(
    "preserves an existing same-name custom %s destination",
    (providerId, adapter, baseUrl) => {
      const config: OcxConfig = {
        port: 10100,
        defaultProvider: providerId,
        providers: {
          [providerId]: {
            adapter,
            baseUrl,
            authMode: "key",
            apiKey: "test-key",
          },
        },
      };

      const route = routeModel(config, `${providerId}/custom-model`);
      expect(route.provider.baseUrl).toBe(baseUrl);
      expect(route.provider.adapter).toBe(adapter);
    },
  );

  test("maps the documented Ark thinking toggle on the pay-as-you-go Chat wire", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "volcengine",
      providers: {
        volcengine: {
          adapter: "openai-chat",
          baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
          authMode: "key",
          apiKey: "test-key",
        },
      },
    };
    const route = routeModel(config, "volcengine/doubao-seed-2-1-pro-260628");
    const request = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: {
        messages: [{ role: "user", content: "ping", timestamp: 0 }],
      },
      stream: true,
      options: { reasoning: "high" },
    });
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(request.url).toBe("https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test.each(["deepseek-v4-pro", "deepseek-v4-flash"])(
    "preserves %s tool-call reasoning and maps Codex efforts on Coding Plan",
    modelId => {
      const config: OcxConfig = {
        port: 10100,
        defaultProvider: "volcengine-coding-plan",
        providers: {
          "volcengine-coding-plan": {
            adapter: "openai-chat",
            baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
            authMode: "key",
            apiKey: "test-key",
          },
        },
      };
      const buildBody = (reasoning: string) => {
        const route = routeModel(config, `volcengine-coding-plan/${modelId}`);
        const request = createOpenAIChatAdapter(route.provider).buildRequest({
          modelId: route.modelId,
          context: {
            messages: [
              { role: "user", content: "inspect the repo", timestamp: 0 },
              {
                role: "assistant",
                timestamp: 1,
                content: [
                  { type: "thinking", thinking: "I need to inspect files first." },
                  { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "README.md" } },
                ],
              },
              {
                role: "toolResult",
                toolCallId: "call_1",
                toolName: "read_file",
                content: "contents",
                isError: false,
                timestamp: 2,
              },
            ],
          },
          stream: true,
          options: { reasoning },
        });
        return JSON.parse(request.body) as {
          reasoning_effort?: string;
          messages: Array<Record<string, unknown>>;
        };
      };

      // #1057: `medium` is our own compatibility alias (no vendor row) and maps to
      // `high` on both. Since the V4 Pro GA (DeepSeek-V4-Pro-0813) the vendor table
      // is identical per model, so `xhigh` and `low` resolve the same on both.
      expect(buildBody("medium").reasoning_effort).toBe("high");
      const xhighBody = buildBody("xhigh");
      expect(xhighBody.reasoning_effort).toBe("high");
      expect(xhighBody.messages[1]?.reasoning_content).toBe("I need to inspect files first.");
      expect(xhighBody.messages[1]).toHaveProperty("tool_calls");
      // GA: both models honor native `low`.
      expect(buildBody("low").reasoning_effort).toBe("low");
    },
  );

  test("publishes image inputs for the multimodal Coding and Agent Plan models", () => {
    for (const providerId of ["volcengine-coding-plan", "volcengine-agent-plan"]) {
      const registry = PROVIDER_REGISTRY.find(provider => provider.id === providerId)!;
      for (const modelId of ["kimi-k2.6", "minimax-m3"]) {
        const hinted = applyProviderConfigHints(
          providerId,
          providerConfigSeed(registry),
          { provider: providerId, id: modelId },
        );
        expect(hinted.inputModalities).toEqual(["text", "image"]);

        const catalog = buildCatalogEntries(null, [], [hinted]);
        expect(catalog.find(entry => entry.slug === `${providerId}/${modelId}`)?.input_modalities)
          .toEqual(["text", "image"]);
      }
    }
  });

  test("keeps Agent Plan response routing when the GUI saves it under a custom name", () => {
    const preset = deriveProviderPresets().find(provider => provider.id === "volcengine-agent-plan")!;
    const postBody = buildProviderPostBody(preset, {
      name: "my-agent-plan",
      adapter: preset.adapter,
      baseUrl: preset.baseUrl,
      responsesPath: preset.responsesPath,
      authMode: preset.auth,
      apiKey: "test-key",
      defaultModel: preset.defaultModel ?? "",
    });

    expect(postBody).toMatchObject({
      name: "my-agent-plan",
      provider: {
        adapter: "openai-responses",
        baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
        responsesPath: "/responses",
      },
    });
    const request = createResponsesPassthroughAdapter(postBody.provider).buildRequest({
      modelId: "deepseek-v4-pro",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "deepseek-v4-pro", input: "ping", stream: true },
    }, { headers: new Headers() });
    expect(request.url).toBe("https://ark.cn-beijing.volces.com/api/plan/v3/responses");
  });

  test("keeps registry response paths in provider seeds and GUI display metadata", () => {
    const agentPlan = PROVIDER_REGISTRY.find(provider => provider.id === "volcengine-agent-plan")!;
    expect(providerConfigSeed(agentPlan).responsesPath).toBe("/responses");
    expect(formatProviderDisplayName("volcengine", englishT)).toBe("Volcengine Ark");
    expect(formatProviderDisplayName("volcengine-coding-plan", englishT)).toBe("Volcengine Ark Coding Plan");
    expect(formatProviderDisplayName("volcengine-agent-plan", englishT)).toBe("Volcengine Ark Agent Plan");
    expect(isCatalogProviderId("volcengine")).toBe(true);
    expect(isCatalogProviderId("volcengine-coding-plan")).toBe(true);
    expect(isCatalogProviderId("volcengine-agent-plan")).toBe(true);
  });

  // Volcengine documents Plan quota as valid only inside supported AI coding tools and warns
  // that other API use of the key may suspend the subscription or ban the account. The note is
  // the only surface that tells a user this, so both Plan presets must carry it and the
  // pay-as-you-go route — which has no such restriction — must not.
  test("both Plan presets disclose the coding-tools-only restriction", () => {
    const codingPlan = PROVIDER_REGISTRY.find(provider => provider.id === "volcengine-coding-plan")!;
    const agentPlan = PROVIDER_REGISTRY.find(provider => provider.id === "volcengine-agent-plan")!;
    const payg = PROVIDER_REGISTRY.find(provider => provider.id === "volcengine")!;

    expect(codingPlan.note).toContain("Coding tools only");
    expect(codingPlan.note).toMatch(/suspend the subscription or ban the account/);
    expect(agentPlan.note).toContain("Coding tools only");
    expect(payg.note).not.toContain("Coding tools only");
  });

  test("Plan presets declare their text-only models so the vision sidecar cannot over-advertise", () => {
    for (const id of ["volcengine-coding-plan", "volcengine-agent-plan"]) {
      const entry = PROVIDER_REGISTRY.find(provider => provider.id === id)!;
      const multimodal = Object.entries(entry.modelInputModalities ?? {})
        .filter(([, modalities]) => modalities.includes("image"))
        .map(([model]) => model);

      // Every advertised model is either declared multimodal or declared text-only —
      // nothing is left to the default.
      for (const model of entry.models ?? []) {
        const declared = multimodal.includes(model) || (entry.noVisionModels ?? []).includes(model);
        expect(declared).toBe(true);
      }
      // A text-only model is never also advertised as accepting images.
      for (const model of entry.noVisionModels ?? []) {
        expect(multimodal).not.toContain(model);
      }
    }
  });

  // The dashboard lets a preset be saved under any name. Resolving the note by name alone
  // silently dropped the usage restriction for a renamed row — the user kept the same
  // credential destination but lost the warning about it.
  test("the Plan restriction survives saving the preset under a custom name", () => {
    const codingPlan = PROVIDER_REGISTRY.find(provider => provider.id === "volcengine-coding-plan")!;
    const dto = safeConfigDTO({
      port: 10100,
      defaultProvider: "my-volc",
      providers: {
        "my-volc": {
          adapter: codingPlan.adapter,
          baseUrl: codingPlan.baseUrl,
          authMode: "key",
          apiKey: "sk-test-not-a-real-key",
        },
      },
    } as unknown as OcxConfig) as { providers: Record<string, { note?: string }> };

    expect(dto.providers["my-volc"].note).toContain("Coding tools only");
  });

  test("an unrelated destination does not inherit a Volcengine restriction", () => {
    const dto = safeConfigDTO({
      port: 10100,
      defaultProvider: "somewhere-else",
      providers: {
        "somewhere-else": {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          authMode: "key",
          apiKey: "sk-test-not-a-real-key",
        },
      },
    } as unknown as OcxConfig) as { providers: Record<string, { note?: string }> };

    expect(dto.providers["somewhere-else"].note).toBeUndefined();
  });
});
