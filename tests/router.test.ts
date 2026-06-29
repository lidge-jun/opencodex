import { describe, expect, test } from "bun:test";
import { mapReasoningEffort } from "../src/reasoning-effort";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

describe("routeModel registry effort defaults", () => {
  test("hydrates registry reasoning effort maps for stale persisted ollama-cloud configs", () => {
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

    expect(route.provider.reasoningEffortMap).toEqual({ xhigh: "max" });
    expect(mapReasoningEffort(route.provider, route.modelId, "xhigh")).toBe("max");
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

  test("hydrates nested modelReasoningEffortMap for stale persisted configs", () => {
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

    // The registry per-model map for glm-5.2 is layered in (xhigh -> max).
    expect(route.provider.modelReasoningEffortMap?.["glm-5.2"]?.xhigh).toBe("max");
    expect(mapReasoningEffort(route.provider, route.modelId, "xhigh")).toBe("max");
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
    expect(route.provider.modelReasoningEfforts?.["umans-kimi-k2.7"]).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("user per-model override wins while registry keys are preserved (nested merge)", () => {
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

    // User override wins for the key it sets...
    expect(mapReasoningEffort(route.provider, route.modelId, "xhigh")).toBe("high");
    // ...but registry keys the user did not set survive the nested merge.
    expect(mapReasoningEffort(route.provider, route.modelId, "minimal")).toBe("none");
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
