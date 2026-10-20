import { describe, expect, test } from "bun:test";
import { mergeConfiguredModelsIntoLiveCatalog } from "../../src/codex/catalog/provider-fetch";
import { projectStartupConfigRepairs } from "../../src/providers/model-rename-startup";
import { projectStaleModelRosters, STALE_MODEL_ROSTERS } from "../../src/providers/stale-model-roster-migration";
import { MINIMAX_MODELS, MINIMAX_MODELS_BEFORE_M31 } from "../../src/providers/registry/model-seeds";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const PREVIEW = "MiniMax-M3.1-Flash-Preview";

function minimaxConfig(provider: string, row: Partial<OcxProviderConfig>): OcxConfig {
  return {
    providers: {
      [provider]: { adapter: "openai-chat", baseUrl: "https://api.minimax.io/v1", ...row },
    },
  } as unknown as OcxConfig;
}

describe("stale model roster migration", () => {
  test("adds the preview to an untouched saved MiniMax seed on both presets", () => {
    // A config saved since 2026-07-10 carries exactly this eight-id copy, and enrichment
    // never rewrites a present list. MiniMax's /v1/models omits the preview, so without
    // this refresh an existing install could never see it.
    for (const provider of ["minimax", "minimax-cn"]) {
      const config = minimaxConfig(provider, {
        models: [...MINIMAX_MODELS_BEFORE_M31],
        modelContextWindows: { "MiniMax-M3": 1_000_000 },
        modelDefaultReasoningEfforts: { "MiniMax-M3": "medium" },
      });
      const projection = projectStaleModelRosters(config);
      const row = projection.config.providers![provider]!;
      expect(projection.changed).toBe(true);
      expect(row.models).toEqual(MINIMAX_MODELS);
      expect(row.models![0]).toBe(PREVIEW);
      expect(row.modelContextWindows).toEqual({ "MiniMax-M3": 1_000_000, [PREVIEW]: 1_000_000 });
      expect(row.modelDefaultReasoningEfforts).toEqual({ "MiniMax-M3": "medium", [PREVIEW]: "max" });
      expect(projection.warnings.join(" ")).toContain(`added ${PREVIEW} to the saved "${provider}" model list`);
    }
  });

  test("never creates a per-model container the row does not have", () => {
    // Enrichment fills these records all-or-nothing. Creating one here with a single key
    // would stop enrichment from seeding MiniMax-M3's own entry.
    const projection = projectStaleModelRosters(minimaxConfig("minimax", { models: [...MINIMAX_MODELS_BEFORE_M31] }));
    const row = projection.config.providers!.minimax!;
    expect(projection.changed).toBe(true);
    expect(row.modelContextWindows).toBeUndefined();
    expect(row.modelDefaultReasoningEfforts).toBeUndefined();
  });

  test("keeps a value the user already saved for the added id", () => {
    const projection = projectStaleModelRosters(minimaxConfig("minimax", {
      models: [...MINIMAX_MODELS_BEFORE_M31],
      modelDefaultReasoningEfforts: { [PREVIEW]: "low" },
    }));
    expect(projection.config.providers!.minimax!.modelDefaultReasoningEfforts).toEqual({ [PREVIEW]: "low" });
  });

  test("leaves a hand-edited roster alone", () => {
    const trimmed = MINIMAX_MODELS_BEFORE_M31.filter(id => id !== "MiniMax-M2");
    const reordered = [...MINIMAX_MODELS_BEFORE_M31].reverse();
    for (const models of [trimmed, reordered, ["MiniMax-M3"]]) {
      const projection = projectStaleModelRosters(minimaxConfig("minimax", { models: [...models] }));
      expect(projection.changed).toBe(false);
      expect(projection.config.providers!.minimax!.models).toEqual(models);
    }
  });

  test("skips a row that no longer carries the registry adapter", () => {
    const projection = projectStaleModelRosters(minimaxConfig("minimax", {
      adapter: "anthropic",
      models: [...MINIMAX_MODELS_BEFORE_M31],
    } as Partial<OcxProviderConfig>));
    expect(projection.changed).toBe(false);
  });

  test("is idempotent, including through the shared startup repair pass", () => {
    const first = projectStartupConfigRepairs(minimaxConfig("minimax", { models: [...MINIMAX_MODELS_BEFORE_M31] }));
    expect(first.changed).toBe(true);
    const second = projectStartupConfigRepairs(structuredClone(first.config));
    expect(second.changed).toBe(false);
    expect(second.config.providers!.minimax!.models).toEqual(MINIMAX_MODELS);
  });

  test("every entry targets the roster the registry seeds today", () => {
    for (const entry of STALE_MODEL_ROSTERS) {
      const registry = PROVIDER_REGISTRY.find(row => row.id === entry.provider);
      expect(registry?.models).toEqual([...entry.to]);
      expect(entry.to.some(id => !entry.from.includes(id))).toBe(true);
    }
  });
});

describe("MiniMax preview catalog retention", () => {
  test("a live /models roster that omits the preview does not drop the configured row", () => {
    // Probed 2026-09-30: GET /v1/models lists M3 and the M2.x family only, while chat
    // completions serve the preview to Token Plan keys.
    for (const name of ["minimax", "minimax-cn"]) {
      const provider = { adapter: "openai-chat", baseUrl: "https://api.minimax.io/v1" } as OcxProviderConfig;
      const live = MINIMAX_MODELS_BEFORE_M31.map(id => ({ id, provider: name }));
      const configured = MINIMAX_MODELS.map(id => ({ id, provider: name }));
      const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({ name, provider, models: live, configured });
      expect(models.map(model => model.id)).toContain(PREVIEW);
      expect(droppedConfiguredIds).toEqual([]);
    }
  });
});

describe.each([
  { provider: "alibaba-token-plan", before: [
  "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash",
  "deepseek-v4-pro", "deepseek-v4-flash-0731", "deepseek-v4.1-flash", "glm-5.2", "glm-5.3",
] },
  { provider: "alibaba-token-plan-intl", before: [
  "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash",
  "deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v4.1-flash", "deepseek-v3.2",
  "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
  "glm-5.2", "glm-5.3", "glm-5.1", "glm-5",
  "MiniMax-M2.5",
] },
])("Token Plan saved roster refresh: $provider", ({ provider, before }) => {
  const entry = STALE_MODEL_ROSTERS.find(row => row.provider === provider)!;
  const makeConfig = (models: string[]) => ({ providers: { [entry.provider]: {
    adapter: "openai-chat", baseUrl: "https://example.com/v1", models,
    defaultModel: "qwen3.8-max", liveModels: false,
    modelContextWindows: { "deepseek-v4.1-flash-1017": 123 },
    modelDefaultReasoningEfforts: { "deepseek-v4.1-flash-1017": "low" },
  } } } as unknown as OcxConfig);
  test("refreshes only the exact previous seed through startup and is idempotent", () => {
    const config = makeConfig([...before]);
    const first = projectStartupConfigRepairs(config);
    expect(first.changed).toBe(true);
    const row = first.config.providers![entry.provider]!;
    expect(row.models).toEqual([...entry.to]);
    expect(row.models).toContain("deepseek-v4.1-flash-1017");
    expect(row.modelContextWindows!["deepseek-v4.1-flash-1017"]).toBe(123);
    expect(row.modelDefaultReasoningEfforts!["deepseek-v4.1-flash-1017"]).toBe("low");
    expect(row.defaultModel).toBe("qwen3.8-max");
    expect(row.liveModels).toBe(false);
    expect(row.baseUrl).toBe("https://example.com/v1");
    expect(projectStartupConfigRepairs(structuredClone(first.config)).changed).toBe(false);
  });
  test("preserves trimmed, extended, reordered, duplicated and empty operator lists", () => {
    for (const models of [before.slice(1), [...before, "custom-model"], [...before].reverse(), [...before, before[0]!], []]) {
      const config = makeConfig(models);
      const original = structuredClone(config);
      expect(projectStaleModelRosters(config).changed).toBe(false);
      expect(config).toEqual(original);
    }
  });
  test("fills existing metadata containers but never creates absent containers", () => {
    const config = makeConfig([...before]);
    const row = config.providers![entry.provider]!;
    row.modelContextWindows = {};
    row.modelDefaultReasoningEfforts = {};
    expect(projectStaleModelRosters(config).changed).toBe(true);
    expect(row.modelContextWindows["deepseek-v4.1-flash-1017"]).toBe(1_000_000);
    expect(row.modelDefaultReasoningEfforts["deepseek-v4.1-flash-1017"]).toBe("high");
    const absent = makeConfig([...before]);
    delete absent.providers![entry.provider]!.modelContextWindows;
    delete absent.providers![entry.provider]!.modelDefaultReasoningEfforts;
    projectStaleModelRosters(absent);
    expect(absent.providers![entry.provider]!.modelContextWindows).toBeUndefined();
    expect(absent.providers![entry.provider]!.modelDefaultReasoningEfforts).toBeUndefined();
  });
  test("preserves a custom adapter", () => {
    const config = makeConfig([...before]);
    config.providers![entry.provider]!.adapter = "anthropic";
    expect(projectStaleModelRosters(config).changed).toBe(false);
    expect(config.providers![entry.provider]!.models).toEqual(before);
  });
});
