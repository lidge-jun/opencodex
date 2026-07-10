import { describe, expect, test } from "bun:test";
import { mapReasoningEffort } from "../src/reasoning-effort";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

describe("routeModel registry effort defaults", () => {
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
});
