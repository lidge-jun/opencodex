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
});
