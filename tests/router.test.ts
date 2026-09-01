import { describe, expect, test } from "bun:test";
import { mapReasoningEffort } from "../src/reasoning-effort";
import { NoEnabledOpenAiProviderError, routeCompactionModel, routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

describe("routeModel registry effort defaults", () => {
  test("allows only opted-in OAuth presets to use explicit API-key billing", () => {
    const xaiKey: OcxConfig = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test-key",
        },
      },
    };
    const xaiDefault: OcxConfig = {
      ...xaiKey,
      providers: { xai: { ...xaiKey.providers.xai, authMode: undefined } },
    };
    const cursorKeyAttempt: OcxConfig = {
      port: 10100,
      defaultProvider: "cursor",
      providers: {
        cursor: {
          adapter: "cursor",
          baseUrl: "https://api2.cursor.sh",
          authMode: "key",
          apiKey: "cursor-test-key",
        },
      },
    };

    expect(routeModel(xaiKey, "xai/grok-4.5").provider.authMode).toBe("key");
    expect(routeModel(xaiDefault, "xai/grok-4.5").provider.authMode).toBe("oauth");
    expect(routeModel(cursorKeyAttempt, "cursor/auto").provider.authMode).toBe("oauth");
  });

  test("falls back to OAuth routing for allowKeyAuthOverride providers when the active key is unresolved", () => {
    const envName = "OCX_TEST_XAI_ROUTER_ENV";
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: `\${${envName}}`,
        },
      },
    };
    const previous = process.env[envName];
    delete process.env[envName];
    try {
      const routed = routeModel(config, "xai/grok-4.5").provider;
      expect(routed.authMode).toBe("oauth");
      expect(routed.apiKey).toBeUndefined();
      expect(config.providers.xai!.authMode).toBe("key");
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  test("routes bare OpenAI/Codex model ids to OpenAI before adopted Cursor model lists", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
        cursor: {
          adapter: "cursor",
          baseUrl: "https://api2.cursor.sh",
          defaultModel: "auto",
          models: ["auto", "gpt-5.5", "claude-4.6-opus"],
        },
      },
    };

    expect(routeModel(config, "gpt-5.5")).toMatchObject({
      providerName: "openai",
      modelId: "gpt-5.5",
    });
    expect(routeModel(config, "cursor/gpt-5.5")).toMatchObject({
      providerName: "cursor",
      modelId: "gpt-5.5",
    });
  });

  test("routes account-qualified native models to one exact Codex account", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          codexAccountMode: "direct",
        },
      },
      codexAccountNamespaces: { desktop: "@main", side: "side-account-id" },
    };

    expect(routeModel(config, "desktop/gpt-5.6-sol")).toMatchObject({
      providerName: "openai",
      modelId: "gpt-5.6-sol",
      codexAccountMode: "pool",
      codexAccountId: "__main__",
      codexAccountNamespace: "desktop",
    });
    expect(routeModel(config, "side/gpt-5.5")).toMatchObject({
      providerName: "openai",
      modelId: "gpt-5.5",
      codexAccountMode: "pool",
      codexAccountId: "side-account-id",
      codexAccountNamespace: "side",
      provider: { authMode: "forward" },
    });
    expect(routeModel(config, "gpt-5.5")).toMatchObject({
      providerName: "openai",
      modelId: "gpt-5.5",
      codexAccountMode: "direct",
    });
    expect(() => routeModel(config, "side/claude-opus-4-6"))
      .toThrow("only supports native OpenAI model ids");

    config.codexAccountPickerEnabled = false;
    expect(routeModel(config, "side/gpt-5.5")).toMatchObject({
      providerName: "openai",
      modelId: "gpt-5.5",
      codexAccountMode: "pool",
      codexAccountId: "side-account-id",
      codexAccountNamespace: "side",
      provider: { authMode: "forward" },
    });
  });

  test("requires an enabled canonical OpenAI forward provider before exact credential injection", () => {
    const providers: OcxProviderConfig[] = [
      { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "key" },
      { adapter: "openai-chat", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
      { adapter: "openai-responses", baseUrl: "https://proxy.example.test/v1", authMode: "forward" },
      { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", disabled: true },
    ];

    for (const openai of providers) {
      const config: OcxConfig = {
        port: 10100,
        defaultProvider: "openai",
        providers: { openai },
        codexAccountNamespaces: { side: "side-account-id" },
      };
      expect(() => routeModel(config, "side/gpt-5.5")).toThrow(NoEnabledOpenAiProviderError);
    }

    const withoutOpenAi: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {},
      codexAccountNamespaces: { side: "side-account-id" },
    };
    expect(() => routeModel(withoutOpenAi, "side/gpt-5.5")).toThrow(NoEnabledOpenAiProviderError);
  });

  test("routes a self-namespaced native id whole instead of stripping to the remainder", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "orcarouter",
      providers: {
        orcarouter: {
          adapter: "openai-chat",
          baseUrl: "https://api.orcarouter.ai/v1",
          authMode: "key",
          apiKey: "sk-orca-test",
          models: ["orcarouter/auto", "openai/gpt-5.5"],
        },
      },
    };

    // The advertised native id must reach the upstream intact — a bare `auto` has no channel.
    expect(routeModel(config, "orcarouter/auto")).toMatchObject({
      providerName: "orcarouter",
      modelId: "orcarouter/auto",
    });
    // The Codex-facing encoded slug still decodes back to the same native id.
    expect(routeModel(config, "orcarouter/orcarouter-auto")).toMatchObject({
      providerName: "orcarouter",
      modelId: "orcarouter/auto",
    });
    // A normal vendor-namespaced model still strips the provider prefix as before.
    expect(routeModel(config, "orcarouter/openai-gpt-5.5")).toMatchObject({
      providerName: "orcarouter",
      modelId: "openai/gpt-5.5",
    });
  });

  test("routes bare OpenAI models only through canonical openai and stops terminally", () => {
    const forward = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const };
    const api = { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key" as const, apiKey: "sk-test", defaultModel: "gpt-5.5" };
    const base: OcxConfig = {
      port: 10100,
      defaultProvider: "openai-apikey",
      providers: {
        "openai-proxy": { adapter: "openai-chat", baseUrl: "https://proxy.example/v1", models: ["gpt-5.5"] },
        "openai-apikey": api,
        openai: forward,
      },
    };
    expect(routeModel(base, "gpt-5.5")).toMatchObject({ providerName: "openai", codexAccountMode: "pool" });
    expect(routeModel(base, "codex-auto-review")).toMatchObject({
      providerName: "openai",
      modelId: "codex-auto-review",
      codexAccountMode: "pool",
    });
    expect(routeModel(base, "codex-third-party-model")).toMatchObject({
      providerName: "openai-apikey",
      modelId: "codex-third-party-model",
    });
    const withDeepSeekDefault: OcxConfig = {
      ...base,
      defaultProvider: "deepseek",
      providers: {
        ...base.providers,
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com/v1",
          defaultModel: "deepseek-chat",
        },
      },
    };
    expect(routeModel(withDeepSeekDefault, "codex-auto-review")).toMatchObject({
      providerName: "openai",
      modelId: "codex-auto-review",
    });
    expect(routeModel(withDeepSeekDefault, "codex-third-party-model")).toMatchObject({
      providerName: "deepseek",
      modelId: "codex-third-party-model",
    });
    expect(routeModel({ ...base, providers: { ...base.providers, openai: { ...forward, codexAccountMode: "direct" } } }, "gpt-5.5"))
      .toMatchObject({ providerName: "openai", codexAccountMode: "direct" });
    expect(() => routeModel({ ...base, providers: { ...base.providers, openai: { ...forward, disabled: true } } }, "gpt-5.5"))
      .toThrow(/requires the canonical openai provider/);
    const unavailable = { ...base, providers: { "openai-proxy": base.providers["openai-proxy"] } };
    expect(() => routeModel(unavailable, "gpt-5.5")).toThrow(/ocx provider add openai/);
    expect(() => routeModel(unavailable, "codex-auto-review")).toThrow(NoEnabledOpenAiProviderError);
  });

  test("rejects legacy chatgpt namespaces even when configured", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "chatgpt",
      providers: { chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    };
    expect(() => routeModel(config, "chatgpt/gpt-5.5")).toThrow("No provider configured");
    expect(() => routeModel(config, "unknown-model")).toThrow("No provider configured");
    const legacyMulti = { ...config, providers: { "openai-multi": config.providers.chatgpt }, defaultProvider: "openai-multi" };
    expect(() => routeModel(legacyMulti, "openai-multi/gpt-5.5")).toThrow("No provider configured");
  });

  test("does not hydrate legacy xhigh to max maps for stale persisted ollama-cloud configs", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "ollama-cloud",
      providers: {
        "ollama-cloud": {
          adapter: "openai-chat",
          baseUrl: "https://ollama.com/v1",
          defaultModel: "glm-5.2",
          models: ["glm-5.2"],
        },
      },
    };

    const route = routeModel(config, "ollama-cloud/glm-5.2");

    expect(route.provider.reasoningEffortMap).toBeUndefined();
    expect(mapReasoningEffort(route.provider, route.modelId, "xhigh")).toBe("xhigh");
    expect(mapReasoningEffort(route.provider, route.modelId, "max")).toBe("max");
  });

  test("preserves user reasoning effort map overrides", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "ollama-cloud",
      providers: {
        "ollama-cloud": {
          adapter: "openai-chat",
          baseUrl: "https://ollama.com/v1",
          models: ["glm-5.2"],
          reasoningEffortMap: { xhigh: "high" },
        },
      },
    };

    const route = routeModel(config, "ollama-cloud/glm-5.2");

    expect(route.provider.reasoningEffortMap).toEqual({ xhigh: "high" });
    expect(mapReasoningEffort(route.provider, route.modelId, "xhigh")).toBe("high");
  });

  test("leaves custom providers without registry entries unchanged", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "custom-ollama",
      providers: {
        "custom-ollama": {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          models: ["glm-5.2"],
        },
      },
    };

    const route = routeModel(config, "custom-ollama/glm-5.2");

    expect(route.provider.reasoningEffortMap).toBeUndefined();
    expect(route.provider.modelReasoningEffortMap).toBeUndefined();
  });

  test("blocks custom private-network providers without explicit opt-in before routing", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "custom-local",
      providers: {
        "custom-local": {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:11434/v1",
          models: ["glm-5.2"],
          apiKey: "sk-test",
        },
      },
    };

    expect(() => routeModel(config, "custom-local/glm-5.2")).toThrow("allowPrivateNetwork");
  });

  test("allows trusted self-hosted presets and explicit private-network opt-in", () => {
    const trustedPreset: OcxConfig = {
      port: 10100,
      defaultProvider: "litellm",
      providers: {
        litellm: {
          adapter: "openai-chat",
          baseUrl: "http://192.168.1.9:4000/v1",
          models: ["gpt-4.1-mini"],
        },
      },
    };
    expect(routeModel(trustedPreset, "litellm/gpt-4.1-mini").provider.baseUrl).toBe("http://192.168.1.9:4000/v1");

    const optedIn: OcxConfig = {
      port: 10100,
      defaultProvider: "custom-private",
      providers: {
        "custom-private": {
          adapter: "openai-chat",
          baseUrl: "http://192.168.1.9:8080/v1",
          allowPrivateNetwork: true,
          models: ["glm-5.2"],
        },
      },
    };
    expect(routeModel(optedIn, "custom-private/glm-5.2").provider.baseUrl).toBe("http://192.168.1.9:8080/v1");
  });

  test("blocks metadata endpoints even when private-network access is opted in", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "custom-metadata",
      providers: {
        "custom-metadata": {
          adapter: "openai-chat",
          baseUrl: "http://169.254.169.254/latest/meta-data",
          allowPrivateNetwork: true,
          models: ["glm-5.2"],
        },
      },
    };

    expect(() => routeModel(config, "custom-metadata/glm-5.2")).toThrow("metadata");
  });

  test("does not hydrate legacy nested xhigh to max maps for stale persisted configs", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "opencode-go",
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://opencode.ai/zen/go/v1",
          models: ["glm-5.2"],
        },
      },
    };

    const route = routeModel(config, "opencode-go/glm-5.2");

    // glm-5.2 itself must have NO alias map (identity labels incl. native `max`); the provider
    // still carries thinking-toggle alias maps for mimo/glm-5.x models, which is unrelated.
    expect(route.provider.modelReasoningEffortMap?.["glm-5.2"]).toBeUndefined();
    expect(mapReasoningEffort(route.provider, route.modelId, "xhigh")).toBe("xhigh");
    expect(mapReasoningEffort(route.provider, route.modelId, "max")).toBe("max");
  });

  test("hydrates registry model capability metadata for stale persisted Umans configs", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "umans",
      providers: {
        umans: {
          adapter: "anthropic",
          baseUrl: "https://api.code.umans.ai",
          models: ["umans-kimi-k2.7", "umans-glm-5.2"],
        },
      },
    };

    const route = routeModel(config, "umans/umans-kimi-k2.7");

    expect(route.provider.escapeBuiltinToolNames).toBe(true);
    expect(route.provider.modelContextWindows?.["umans-kimi-k2.7"]).toBe(262_144);
    expect(route.provider.modelInputModalities?.["umans-kimi-k2.7"]).toEqual(["text", "image"]);
    expect(route.provider.noVisionModels).toContain("umans-glm-5.2");
    expect(route.provider.modelReasoningEfforts?.["umans-kimi-k2.7"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("minimal persisted DeepSeek config inherits the registry text-only classification (issue #88)", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-test",
        },
      },
    };

    const route = routeModel(config, "deepseek/deepseek-v4-flash");

    expect(route.provider.noVisionModels).toEqual([
      "deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro", "deepseek-v4-flash",
    ]);
  });

  test("user per-model effort-map override is preserved without registry aliases", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "opencode-go",
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://opencode.ai/zen/go/v1",
          models: ["glm-5.2"],
          modelReasoningEffortMap: { "glm-5.2": { xhigh: "high" } },
        },
      },
    };

    const route = routeModel(config, "opencode-go/glm-5.2");

    expect(mapReasoningEffort(route.provider, route.modelId, "xhigh")).toBe("high");
    expect(mapReasoningEffort(route.provider, route.modelId, "max")).toBe("max");
  });

  test("registry model limitation lists are preserved alongside user additions", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "opencode-go",
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://opencode.ai/zen/go/v1",
          models: ["kimi-k2.7-code"],
          noReasoningModels: ["custom-no-reasoning"],
        },
      },
    };

    const route = routeModel(config, "opencode-go/kimi-k2.7-code");

    expect(route.provider.noReasoningModels).toContain("custom-no-reasoning");
    expect(route.provider.noReasoningModels).toContain("kimi-k2.7-code");
    expect(route.provider.noTemperatureModels).toContain("kimi-k2.7-code");
  });

  test("does not route inherited object keys as provider namespaces or defaults", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "constructor",
      providers: {
        openai: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          defaultModel: "gpt-test",
        },
      },
    };

    expect(() => routeModel(config, "constructor/model")).toThrow("No provider configured");
  });

  test("skips disabled providers during routing", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "active",
      providers: {
        disabled: {
          adapter: "openai-chat",
          baseUrl: "https://disabled.example.test/v1",
          defaultModel: "shared-model",
          models: ["disabled-only"],
          disabled: true,
        },
        active: {
          adapter: "openai-chat",
          baseUrl: "https://active.example.test/v1",
          defaultModel: "shared-model",
          models: ["active-only"],
        },
      },
    };

    expect(routeModel(config, "shared-model").providerName).toBe("active");
    expect(routeModel(config, "active-only").providerName).toBe("active");
    expect(() => routeModel(config, "disabled/disabled-only")).toThrow("Provider is disabled");
  });
});

describe("routeModel backfills google wire mode from the registry", () => {
  test("a minimal google-antigravity config (no googleMode) is routed with googleMode cloud-code-assist", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          defaultModel: "gemini-3-pro",
        },
      },
    };
    const routed = routeModel(config, "gemini-3-pro");
    expect(routed.providerName).toBe("google-antigravity");
    expect(routed.provider.googleMode).toBe("cloud-code-assist");
  });

  test("a minimal google-vertex config is routed with googleMode vertex", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "google-vertex",
      providers: {
        "google-vertex": { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", defaultModel: "gemini-3-pro" },
      },
    };
    expect(routeModel(config, "gemini-3-pro").provider.googleMode).toBe("vertex");
  });

  test("a bare claude-* model is not silently rerouted to an unrelated Anthropic provider (#1697)", () => {
    // The draft fix picked the first enabled provider whose adapter is anthropic, by object
    // insertion order, checking neither `models`, `selectedModels`, `disabledModels` nor discovery.
    // That crosses a provider/privacy/billing boundary the operator never asked for, so it is gone.
    // Routing a classifier turn to a specific provider is an operator decision, expressed through
    // `claudeCode.classifierModel` / `classifierFallbacks`.
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com",
        },
        RelayA: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.relay.example/v1",
        },
      },
    };

    const routed = routeModel(config, "claude-opus-5");
    expect(routed.providerName).toBe("deepseek");
    expect(routed.routeKind).toBe("default-provider");
  });

  test("a disabled provider is not selected by the known-model pattern (#1697)", () => {
    // This half of the draft is kept: matching a pattern provider that is disabled and routing to
    // it anyway was a real defect.
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "fallbackProvider",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          disabled: true,
        },
        fallbackProvider: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
        },
      },
    };

    const routed = routeModel(config, "claude-opus-5");
    expect(routed.providerName).toBe("fallbackProvider");
  });
});

describe("routeModel blocked model redirect", () => {
  test("routes gpt-5.6-terra normally when blockedModelRedirects is unset", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
      },
    };

    const routed = routeModel(config, "gpt-5.6-terra");
    expect(routed).toMatchObject({
      providerName: "openai",
      modelId: "gpt-5.6-terra",
      routeKind: "native",
      routeReason: "native-family",
    });
  });

  test("opt-in intercepts gpt-5.6-terra and rewrites to gpt-5.6-luna with blocked-model-redirect reason", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      blockedModelRedirects: {
        "gpt-5.6-terra": "gpt-5.6-luna",
      },
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
      },
    };

    const routed = routeModel(config, "gpt-5.6-terra");
    expect(routed).toMatchObject({
      providerName: "openai",
      modelId: "gpt-5.6-luna",
      routeKind: "native",
      routeReason: "blocked-model-redirect",
    });
    expect(routed.routeDecision?.selected).toMatchObject({
      model: "gpt-5.6-luna",
      reason: "blocked-model-redirect",
    });
    expect(routed.routeDecision?.requestedModel).toBe("gpt-5.6-terra");
  });

  test("opt-in intercepts account-namespaced gpt-5.6-terra and rewrites to gpt-5.6-luna", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      blockedModelRedirects: {
        "gpt-5.6-terra": "gpt-5.6-luna",
      },
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          codexAccountMode: "direct",
        },
      },
      codexAccountNamespaces: { side: "side-account-id" },
    };

    const routed = routeModel(config, "side/gpt-5.6-terra");
    expect(routed).toMatchObject({
      providerName: "openai",
      modelId: "gpt-5.6-luna",
      routeKind: "explicit-account",
      routeReason: "blocked-model-redirect",
      codexAccountId: "side-account-id",
      codexAccountNamespace: "side",
    });
    expect(routed.routeDecision?.selected).toMatchObject({
      model: "gpt-5.6-luna",
      accountRef: "side",
      reason: "blocked-model-redirect",
    });
    expect(routed.routeDecision?.requestedModel).toBe("side/gpt-5.6-terra");
  });
});

describe("routeCompactionModel (#2901)", () => {
  const ghcpOnly: OcxConfig = {
    port: 10100,
    defaultProvider: "github-copilot",
    providers: {
      "github-copilot": {
        adapter: "openai-chat",
        baseUrl: "https://api.githubcopilot.com",
        authMode: "key",
        apiKey: "ghu_test",
        models: ["gpt-5.6-sol", "claude-opus-4-6"],
      },
    },
    codexAccountNamespaces: { side: "side-account-id" },
  };

  test("falls back to the configured default provider only on the compaction surface", () => {
    // Ordinary turns keep today's reservation: a bare native id without canonical openai is terminal.
    expect(() => routeModel(ghcpOnly, "gpt-5.6-sol")).toThrow(NoEnabledOpenAiProviderError);
    expect(routeCompactionModel(ghcpOnly, "gpt-5.6-sol")).toMatchObject({
      providerName: "github-copilot",
      modelId: "gpt-5.6-sol",
      routeKind: "default-provider",
      routeReason: "compaction-default-provider",
    });
    expect(routeCompactionModel(ghcpOnly, "gpt-5.6-sol").routeDecision?.selected).toMatchObject({
      provider: "github-copilot",
      model: "gpt-5.6-sol",
      reason: "compaction-default-provider",
    });
  });

  test("keeps exact account selectors and canonical-openai configs unchanged", () => {
    // An account-qualified native selector names a credential; it must stay fail-closed.
    expect(() => routeCompactionModel(ghcpOnly, "side/gpt-5.6-sol")).toThrow(NoEnabledOpenAiProviderError);
    // With canonical openai enabled the compaction route is identical to the ordinary one.
    const withOpenAi: OcxConfig = {
      ...ghcpOnly,
      providers: {
        ...ghcpOnly.providers,
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
      },
    };
    expect(routeCompactionModel(withOpenAi, "gpt-5.6-sol")).toMatchObject({
      providerName: "openai",
      routeReason: "native-family",
    });
    // Same destination as the ordinary router; the decision trace carries a fresh id/timestamp.
    const { routeDecision: _a, ...compactionRoute } = routeCompactionModel(withOpenAi, "gpt-5.6-sol");
    const { routeDecision: _b, ...ordinaryRoute } = routeModel(withOpenAi, "gpt-5.6-sol");
    expect(compactionRoute).toEqual(ordinaryRoute);
  });

  test("does not resurrect a disabled, missing, or legacy default provider", () => {
    const disabledDefault: OcxConfig = {
      ...ghcpOnly,
      providers: { "github-copilot": { ...ghcpOnly.providers["github-copilot"]!, disabled: true } },
    };
    expect(() => routeCompactionModel(disabledDefault, "gpt-5.6-sol")).toThrow(NoEnabledOpenAiProviderError);
    const missingDefault: OcxConfig = { ...ghcpOnly, defaultProvider: "nowhere" };
    expect(() => routeCompactionModel(missingDefault, "gpt-5.6-sol")).toThrow(NoEnabledOpenAiProviderError);
    const openAiDefaultDisabled: OcxConfig = {
      ...ghcpOnly,
      defaultProvider: "openai",
      providers: {
        ...ghcpOnly.providers,
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", disabled: true },
      },
    };
    expect(() => routeCompactionModel(openAiDefaultDisabled, "gpt-5.6-sol")).toThrow(NoEnabledOpenAiProviderError);
  });
});
