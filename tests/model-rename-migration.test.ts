import { describe, expect, test } from "bun:test";
import {
  MODEL_RENAMES,
  projectModelRenames,
  type ModelRename,
} from "../src/providers/model-rename-migration";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxConfig } from "../src/types";

const INTL_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

const RENAME: ModelRename = {
  provider: "alibaba-token-plan-intl",
  from: "qwen3.8-max-preview",
  to: "qwen3.8-max",
  reason: "test",
};

/** The exact shape a config saved before d40367c0c carries (issue #1610). */
function staleConfig(): OcxConfig {
  return {
    providers: {
      "alibaba-token-plan-intl": {
        adapter: "openai-chat",
        baseUrl: INTL_BASE_URL,
        authMode: "key",
        apiKey: "sk-test",
        defaultModel: "qwen3.7-max",
        models: ["qwen3.8-max-preview", "qwen3.7-max", "glm-5.2"],
        liveModels: false,
        modelContextWindows: { "qwen3.8-max-preview": 983_616, "qwen3.7-max": 1_000_000 },
        modelInputModalities: { "qwen3.8-max-preview": ["text", "image"] },
        modelReasoningEfforts: { "qwen3.8-max-preview": ["low", "high", "xhigh"] },
        modelDefaultReasoningEfforts: { "qwen3.8-max-preview": "xhigh" },
        preserveReasoningContentModels: ["glm-5.2", "qwen3.8-max-preview", "qwen3.7-max"],
        thinkingBudgetModels: ["qwen3.8-max-preview", "qwen3.7-max"],
      },
    },
    disabledModels: ["alibaba-token-plan-intl/qwen3.8-max-preview", "other/model"],
  } as unknown as OcxConfig;
}

describe("registry model rename migration (#1610)", () => {
  test("rewrites every model-keyed field, preserving list order", () => {
    const { config, changed, warnings } = projectModelRenames(staleConfig(), [RENAME]);
    const prov = config.providers["alibaba-token-plan-intl"]!;

    expect(changed).toBe(true);
    expect(JSON.stringify(config)).not.toContain("qwen3.8-max-preview");

    // Order matters: the renamed id keeps its slot rather than moving to the end.
    expect(prov.models).toEqual(["qwen3.8-max", "qwen3.7-max", "glm-5.2"]);
    expect(prov.modelContextWindows?.["qwen3.8-max"]).toBe(983_616);
    expect(prov.modelInputModalities?.["qwen3.8-max"]).toEqual(["text", "image"]);
    expect(prov.modelReasoningEfforts?.["qwen3.8-max"]).toEqual(["low", "high", "xhigh"]);
    expect(prov.modelDefaultReasoningEfforts?.["qwen3.8-max"]).toBe("xhigh");
    expect(prov.preserveReasoningContentModels).toEqual(["glm-5.2", "qwen3.8-max", "qwen3.7-max"]);
    expect(prov.thinkingBudgetModels).toEqual(["qwen3.8-max", "qwen3.7-max"]);
    expect(warnings.some(w => w.includes("qwen3.8-max"))).toBe(true);
  });

  test("drops the retired disabledModels row instead of disabling the supported id", () => {
    const { config } = projectModelRenames(staleConfig(), [RENAME]);
    // Carrying the toggle across would hide the model the rename exists to expose.
    expect(config.disabledModels).toEqual(["other/model"]);
  });

  test("promotes a defaultModel that names the retired id", () => {
    const stale = staleConfig();
    stale.providers["alibaba-token-plan-intl"]!.defaultModel = "qwen3.8-max-preview";
    const { config } = projectModelRenames(stale, [RENAME]);
    expect(config.providers["alibaba-token-plan-intl"]!.defaultModel).toBe("qwen3.8-max");
  });

  test("is a no-op for a config that already uses the supported id", () => {
    const clean = staleConfig();
    const prov = clean.providers["alibaba-token-plan-intl"]!;
    prov.models = ["qwen3.8-max", "qwen3.7-max"];
    prov.modelContextWindows = { "qwen3.8-max": 983_616 };
    prov.modelInputModalities = {};
    prov.modelReasoningEfforts = {};
    prov.modelDefaultReasoningEfforts = {};
    prov.preserveReasoningContentModels = ["qwen3.8-max"];
    prov.thinkingBudgetModels = ["qwen3.7-max"];
    clean.disabledModels = ["other/model"];

    const { changed, warnings } = projectModelRenames(clean, [RENAME]);
    expect(changed).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("leaves a row repointed at a different vendor alone", () => {
    const custom = staleConfig();
    // The user aimed this provider name at their own gateway; its ids are theirs.
    custom.providers["alibaba-token-plan-intl"]!.baseUrl = "https://my-proxy.internal/v1";
    const { config, changed } = projectModelRenames(custom, [RENAME]);
    expect(changed).toBe(false);
    expect(config.providers["alibaba-token-plan-intl"]!.models).toContain("qwen3.8-max-preview");
  });

  test("refuses to write an id the registry does not seed", () => {
    const bogus: ModelRename = { ...RENAME, to: "qwen-does-not-exist" };
    const { changed, warnings } = projectModelRenames(staleConfig(), [bogus]);
    expect(changed).toBe(false);
    expect(warnings.some(w => w.includes("no longer seeds"))).toBe(true);
  });

  test("collapses a duplicate when both ids are already present", () => {
    const both = staleConfig();
    both.providers["alibaba-token-plan-intl"]!.models = ["qwen3.8-max-preview", "qwen3.8-max", "qwen3.7-max"];
    const { config } = projectModelRenames(both, [RENAME]);
    expect(config.providers["alibaba-token-plan-intl"]!.models).toEqual(["qwen3.8-max", "qwen3.7-max"]);
  });

  test("does nothing when the provider is not configured", () => {
    const empty = { providers: {} } as unknown as OcxConfig;
    expect(projectModelRenames(empty, [RENAME]).changed).toBe(false);
  });

  test("every shipped rename targets an id the registry actually seeds", () => {
    for (const rename of MODEL_RENAMES) {
      const entry = PROVIDER_REGISTRY.find(row => row.id === rename.provider);
      expect(entry, `registry entry missing for ${rename.provider}`).toBeDefined();
      expect(entry?.models, `${rename.provider} seeds no models`).toBeDefined();
      expect(entry?.models).toContain(rename.to);
      // A rename whose source id is still seeded would fight the registry.
      expect(entry?.models).not.toContain(rename.from);
    }
  });
});
