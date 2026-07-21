import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { augmentRoutedModelsWithJawcodeMetadata, augmentRoutedModelsWithRegistryOpenAiApiRows, buildCatalogEntries, deriveComboCatalogModel, exactComboCatalogSlugs, filterCatalogVisibleModels, filterSupportedNativeSlugs, gatherRoutedModels, isDatedVariantId, isMediaGenerationModelId, loadBundledCodexCatalog, materializeBundledCodexCatalog, mergeCatalogEntriesForSync, NATIVE_OPENAI_MODELS, normalizeRoutedCatalogEntry, resetCatalogRuntimeStateForTests, resetOpenAiApiCatalogWarningStateForTests } from "../src/codex/catalog";
import {
  CURSOR_STATIC_MODELS,
  filterCursorConfiguredModelsByLiveDiscovery,
  cursorModelContextWindows,
  cursorModelIds,
  cursorModelInputModalities,
  cursorModelReasoningEfforts,
} from "../src/adapters/cursor/discovery";
import { getJawcodeModelMetadata, resolveJawcodeProvider } from "../src/generated/jawcode-model-metadata";
import { clearModelCache, getStaleCached, setCached } from "../src/codex/model-cache";
import type { OcxConfig } from "../src/types";
import type { NormalizedComboConfig } from "../src/combos/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  resetOpenAiApiCatalogWarningStateForTests();
});

function normalizedCombo(
  overrides: Partial<NormalizedComboConfig> = {},
): NormalizedComboConfig {
  return {
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: "medium",
    alias: null,
    targets: [
      { provider: "a", model: "m1", weight: 1 },
      { provider: "b", model: "m2", weight: 1 },
    ],
    ...overrides,
  };
}

describe("combo catalog capability intersection", () => {
  const memberA = {
    provider: "a",
    id: "m1",
    contextWindow: 200_000,
    maxInputTokens: 180_000,
    inputModalities: ["text", "image"],
    reasoningEfforts: ["low", "medium", "high"],
    parallelToolCalls: true,
  };
  const memberB = {
    provider: "b",
    id: "m2",
    contextWindow: 128_000,
    maxInputTokens: 100_000,
    inputModalities: ["text"],
    reasoningEfforts: ["low", "medium"],
    parallelToolCalls: false,
  };

  test("derives only capabilities common to every member", () => {
    const derived = deriveComboCatalogModel(
      "mixed",
      normalizedCombo({ defaultEffort: "high" }),
      [memberA, memberB],
    );

    expect(derived).toEqual({
      provider: "combo",
      id: "mixed",
      owned_by: "combo",
      contextWindow: 128_000,
      maxInputTokens: 100_000,
      inputModalities: ["text"],
      reasoningEfforts: ["low", "medium"],
      defaultReasoningEffort: "medium",
    });
  });

  test("handles vision, missing modalities, reasoning defaults, and parallel tools conservatively", () => {
    expect(deriveComboCatalogModel("vision", normalizedCombo({ defaultEffort: "low" }), [
      memberA,
      { ...memberB, inputModalities: ["image", "text"], reasoningEfforts: ["xhigh"], parallelToolCalls: true },
    ])).toEqual(expect.objectContaining({
      inputModalities: ["text", "image"],
      reasoningEfforts: [],
      parallelToolCalls: true,
    }));
    expect(deriveComboCatalogModel("unknown", normalizedCombo(), [
      memberA,
      { ...memberB, inputModalities: undefined },
    ])?.inputModalities).toEqual(["text"]);
    expect(deriveComboCatalogModel("high", normalizedCombo({ defaultEffort: "low" }), [
      { ...memberA, reasoningEfforts: ["high"] },
      { ...memberB, reasoningEfforts: ["high"] },
    ])?.defaultReasoningEffort).toBe("high");
    expect(deriveComboCatalogModel("common", normalizedCombo({ defaultEffort: "medium" }), [
      memberA,
      { ...memberB, reasoningEfforts: ["medium", "high"] },
    ])?.defaultReasoningEffort).toBe("medium");
  });

  test("fails closed for missing members, unknown context, duplicate targets, and empty modalities", () => {
    expect(deriveComboCatalogModel("missing", normalizedCombo(), [memberA])).toBeNull();
    expect(deriveComboCatalogModel("context", normalizedCombo(), [
      memberA,
      { ...memberB, contextWindow: undefined },
    ])).toBeNull();
    expect(deriveComboCatalogModel("modalities", normalizedCombo(), [
      { ...memberA, inputModalities: ["image"] },
      { ...memberB, inputModalities: ["text"] },
    ])).toBeNull();
    expect(deriveComboCatalogModel("duplicate", normalizedCombo({
      targets: [
        { provider: "a", model: "m1", weight: 1 },
        { provider: "a", model: "m1", weight: 1 },
      ],
    }), [memberA, memberA])).toBeNull();
  });

  test("requires member identity to follow target order", () => {
    const reversed = normalizedCombo({ targets: [...normalizedCombo().targets].reverse() });
    expect(deriveComboCatalogModel("ordered", reversed, [memberB, memberA]))
      .toEqual(expect.objectContaining({ contextWindow: 128_000 }));
    expect(deriveComboCatalogModel("mismatch", reversed, [memberA, memberB])).toBeNull();
  });

  test("preserves exact combo ladders and modalities through template, fallback, and sync", () => {
    const model = deriveComboCatalogModel("mixed", normalizedCombo(), [memberA, memberB])!;
    const exact = new Set(["combo/mixed"]);
    for (const template of [nativeTemplate(), null]) {
      const row = buildCatalogEntries(template, [], [model], undefined, false, "default", exact)
        .find(entry => entry.slug === "combo/mixed");
      expect((row?.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
        .toEqual(["low", "medium"]);
      expect(row?.default_reasoning_level).toBe("medium");
      expect(row?.input_modalities).toEqual(["text"]);
    }

    const built = buildCatalogEntries(nativeTemplate(), [], [model], undefined, false, "default", exact);
    const merged = mergeCatalogEntriesForSync(
      [], built, new Map(), [], false, new Set(), nativeTemplate(), new Set(),
      new Set(["combo"]), "default", exact, false,
    );
    const row = merged.find(entry => entry.slug === "combo/mixed");
    expect((row?.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["low", "medium"]);
    expect(row?.input_modalities).toEqual(["text"]);
    expect(row?.owned_by).toBe("combo");
  });

  test("treats bare and slashed combo aliases as routed catalog rows", () => {
    for (const alias of ["deepseek-v4-flash", "vendor/deepseek-v4-flash"]) {
      const model = deriveComboCatalogModel(
        "mixed",
        normalizedCombo({ alias }),
        [memberA, memberB],
      )!;
      const row = buildCatalogEntries(nativeTemplate(), [], [model], undefined, false, "default", new Set([alias]))[0]!;

      expect(row.slug).toBe(alias);
      expect(row.display_name).toBe(alias);
      expect(row.owned_by).toBe("combo");
      expect(row.base_instructions).toContain("mixed");
      expect(row).not.toHaveProperty("model_messages");
      expect(row).not.toHaveProperty("tool_mode");
      expect(row.web_search_tool_type).toBe("text_and_image");
      expect(row.supports_search_tool).toBe(true);
    }
  });

  test("preserves exact combo capabilities under an alias", () => {
    const alias = "deepseek-v4-flash";
    const model = deriveComboCatalogModel(
      "mixed",
      normalizedCombo({ alias }),
      [memberA, memberB],
    )!;
    const row = buildCatalogEntries(null, [], [model], undefined, false, "default", new Set([alias]))[0]!;

    expect((row.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["low", "medium"]);
    expect(row.input_modalities).toEqual(["text"]);
  });

  test("lets a combo alias shadow a provider catalog slug", () => {
    const alias = "vendor/deepseek-v4-flash";
    const combo = deriveComboCatalogModel(
      "mixed",
      normalizedCombo({ alias }),
      [memberA, memberB],
    )!;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rows = buildCatalogEntries(nativeTemplate(), [], [
        { provider: "vendor", id: "deepseek-v4-flash", owned_by: "vendor" },
        combo,
      ], undefined, false, "default", new Set([alias]));

      expect(rows.filter(row => row.slug === alias)).toHaveLength(1);
      expect(rows.find(row => row.slug === alias)?.owned_by).toBe("combo");
      expect(warn).toHaveBeenCalledTimes(1);
      buildCatalogEntries(nativeTemplate(), [], [
        { provider: "vendor", id: "deepseek-v4-flash", owned_by: "vendor" },
        combo,
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("removes stale combo alias rows after removal or rename", () => {
    for (const slug of ["deepseek-v4-flash", "vendor/deepseek-v4-flash"]) {
      const stale = {
        slug,
        owned_by: "combo",
        input_modalities: ["text"],
        supported_reasoning_levels: [{ effort: "low" }],
      };
      const merged = mergeCatalogEntriesForSync(
        [stale], [], new Map(), [], false, new Set(), null, new Set(), new Set(),
        "default", new Set(), false,
      );
      expect(merged.some(entry => entry.slug === slug)).toBe(false);
    }
  });

  test("filters aliased combos by public or canonical disabled model ids", () => {
    const combo = deriveComboCatalogModel(
      "mixed",
      normalizedCombo({ alias: "deepseek-v4-flash" }),
      [memberA, memberB],
    )!;
    const provider = { provider: "vendor", id: "deepseek-v4-flash" };
    const config = (disabledModels: string[]) => ({
      disabledModels,
      providers: { vendor: {}, combo: {} },
    });

    expect(filterCatalogVisibleModels([combo, provider], config(["deepseek-v4-flash"])))
      .toEqual([provider]);
    expect(filterCatalogVisibleModels([combo, provider], config(["combo/mixed"])))
      .toEqual([provider]);
    expect(filterCatalogVisibleModels([provider], config(["deepseek-v4-flash"])))
      .toEqual([provider]);
    expect(filterCatalogVisibleModels([provider], config(["vendor/deepseek-v4-flash"])))
      .toEqual([]);
  });

  test("repairs a provider row after its shadowing combo alias is disabled", () => {
    const alias = "vendor/deepseek-v4-flash";
    const combo = deriveComboCatalogModel(
      "mixed",
      normalizedCombo({ alias }),
      [memberA, memberB],
    )!;
    const provider = {
      provider: "vendor",
      id: "deepseek-v4-flash",
      reasoningEfforts: ["low", "medium"],
    };
    const config = {
      combos: {
        mixed: { alias, targets: [{ provider: "a", model: "m1" }] },
      },
      disabledModels: ["combo/mixed"],
      providers: { vendor: {}, combo: {} },
    };

    const visible = filterCatalogVisibleModels([provider, combo], config);
    const rows = buildCatalogEntries(
      nativeTemplate(),
      [],
      visible,
      undefined,
      false,
      "default",
      exactComboCatalogSlugs(config),
    );
    const levels = (rows.find(row => row.slug === alias)?.supported_reasoning_levels ?? []) as Array<{ effort: string }>;
    const efforts = levels.map(level => level.effort);

    expect(visible).toEqual([provider]);
    expect(exactComboCatalogSlugs(config)).toEqual(new Set());
    expect(efforts).toEqual(["low", "medium", "max", "ultra"]);
  });

  test("never repairs an exact combo with an empty modality intersection", () => {
    const exact = new Set(["combo/hidden"]);
    const derived = deriveComboCatalogModel("hidden", normalizedCombo(), [
      { ...memberA, inputModalities: ["image"] },
      { ...memberB, inputModalities: ["text"] },
    ]);
    expect(derived).toBeNull();
    const productionBuild = buildCatalogEntries(
      nativeTemplate(),
      [],
      derived ? [derived] : [],
      undefined,
      false,
      "default",
      exact,
    );
    expect(productionBuild.some(entry => entry.slug === "combo/hidden")).toBe(false);

    const malformed = {
      provider: "combo",
      id: "hidden",
      contextWindow: 128_000,
      inputModalities: [],
      reasoningEfforts: ["low"],
    };
    const built = buildCatalogEntries(null, [], [malformed], undefined, false, "default", exact);
    const merged = mergeCatalogEntriesForSync(
      [], built, new Map(), [], false, new Set(), null, new Set(), new Set(["combo"]),
      "default", exact, false,
    );
    expect(merged.some(entry => entry.slug === "combo/hidden")).toBe(false);
  });

  test("uses config identity for physical preservation and stale virtual cleanup", () => {
    const physical = {
      slug: "combo/model",
      supported_reasoning_levels: [{ effort: "low" }],
      input_modalities: ["text"],
    };
    const preserved = mergeCatalogEntriesForSync(
      [physical], [], new Map(), [], false, new Set(), null, new Set(), new Set(["combo"]),
      "default", new Set(), true,
    ).find(entry => entry.slug === "combo/model");
    expect(preserved).toBeDefined();
    expect((preserved?.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["low", "max"]);

    const stale = { ...physical, slug: "combo/deleted" };
    expect(mergeCatalogEntriesForSync(
      [stale], [], new Map(), [], false, new Set(), null, new Set(), new Set(),
      "default", new Set(), false,
    ).some(entry => entry.slug === "combo/deleted")).toBe(false);
    expect(mergeCatalogEntriesForSync(
      [stale], [], new Map(), [], false, new Set(), null, new Set(), new Set(),
      "default", new Set(["combo/deleted"]), false,
    ).some(entry => entry.slug === "combo/deleted")).toBe(false);
  });

  test("gathers sorted rows, filters disabled combos, and deduplicates redacted warnings until reset", async () => {
    const warningSentinel = ["sk", "warning-secret-123456"].join("-");
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "a",
      providers: {
        a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", liveModels: false, models: ["m1"], modelContextWindows: { m1: 200_000 } },
        b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", liveModels: false, models: ["m2"], modelContextWindows: { m2: 128_000 } },
      },
      combos: {
        mixed: { targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] },
        hidden: { targets: [{ provider: "a", model: warningSentinel }] },
      },
      disabledModels: ["combo/mixed"],
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await gatherRoutedModels(config);
      const second = await gatherRoutedModels(config);
      expect(first.map(model => `${model.provider}/${model.id}`)).toEqual([
        "a/m1", "b/m2", "combo/mixed",
      ]);
      expect(filterCatalogVisibleModels(first, config).some(model => model.id === "mixed")).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("[REDACTED]");
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(warningSentinel);
      expect(second).toEqual(first);

      resetCatalogRuntimeStateForTests();
      await gatherRoutedModels(config);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("exact combo slugs come only from current config", () => {
    expect(exactComboCatalogSlugs({ combos: {
      free: { targets: [{ provider: "a", model: "m1" }] },
      bare: { alias: "  deepseek-v4-flash  ", targets: [{ provider: "a", model: "m1" }] },
      slashed: { alias: "vendor/flash", targets: [{ provider: "a", model: "m1" }] },
      empty: { alias: "   ", targets: [{ provider: "a", model: "m1" }] },
    } }))
      .toEqual(new Set(["combo/free", "deepseek-v4-flash", "vendor/flash", "combo/empty"]));
    expect(exactComboCatalogSlugs({
      disabledModels: ["combo/free", "deepseek-v4-flash"],
      combos: {
        free: { targets: [{ provider: "a", model: "m1" }] },
        bare: { alias: "deepseek-v4-flash", targets: [{ provider: "a", model: "m1" }] },
        slashed: { alias: "vendor/flash", targets: [{ provider: "a", model: "m1" }] },
      },
    })).toEqual(new Set(["vendor/flash"]));
    expect(exactComboCatalogSlugs({})).toEqual(new Set());
  });
});

function openAiApiCatalogConfig(overrides: Record<string, unknown> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai-apikey",
    providers: {
      "openai-apikey": {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        ...overrides,
      },
    },
  };
}

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.\nUse tools carefully.",
    model_messages: {
      instructions_template: "You are Codex, a coding agent based on GPT-5.",
    },
    tool_mode: "code",
    multi_agent_version: "v2",
    use_responses_lite: true,
    supports_websockets: true,
    web_search_tool_type: "text_and_image",
    supports_search_tool: true,
    additional_speed_tiers: [{ id: "priority" }],
    service_tier: "fast",
    service_tiers: [{ id: "fast" }],
    default_service_tier: "priority",
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "medium", description: "native medium" },
      { effort: "high", description: "native high" },
      { effort: "xhigh", description: "native xhigh" },
    ],
  };
}

describe("Codex catalog routed normalization", () => {
  test("canonical OpenAI forward mode stays native-only with no routed duplicate", async () => {
    globalThis.fetch = (() => { throw new Error("forward providers must not fetch /models"); }) as typeof fetch;
    const rows = await gatherRoutedModels({
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
    });
    expect(rows).toEqual([]);
    expect(rows.some(row => row.provider === "openai-multi")).toBe(false);
  });

  test("loads bundled Codex catalog from debug models output", () => {
    const catalog = loadBundledCodexCatalog({
      commandCandidates: () => ["codex"],
      execFileSync: () => JSON.stringify({ models: [nativeTemplate()] }),
    });

    expect(catalog?.models?.[0]?.slug).toBe("gpt-5.5");
  });

  test("materializes bundled Codex catalog when no on-disk source exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-catalog-"));
    const path = join(dir, "nested", "opencodex-catalog.json");
    try {
      const catalog = materializeBundledCodexCatalog(path, {
        commandCandidates: () => ["codex"],
        execFileSync: () => JSON.stringify({ models: [nativeTemplate()] }),
      });

      expect(catalog?.models?.[0]?.slug).toBe("gpt-5.5");
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).models[0].slug).toBe("gpt-5.5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("normalizeRoutedCatalogEntry strips native-only routed selectors", () => {
    const entry = nativeTemplate();

    normalizeRoutedCatalogEntry(entry);

    expect(entry).not.toHaveProperty("model_messages");
    expect(entry).not.toHaveProperty("tool_mode");
    expect(entry).not.toHaveProperty("multi_agent_version");
    expect(entry).not.toHaveProperty("use_responses_lite");
    expect(entry).not.toHaveProperty("supports_websockets");
    expect(entry).not.toHaveProperty("additional_speed_tiers");
    expect(entry).not.toHaveProperty("service_tier");
    expect(entry).not.toHaveProperty("service_tiers");
    expect(entry).not.toHaveProperty("default_service_tier");
    expect(entry.web_search_tool_type).toBe("text_and_image");
    expect(entry.supports_search_tool).toBe(true);
  });

  test("buildCatalogEntries strips routed entries cloned from native templates", () => {
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], [
      { provider: "anthropic", id: "claude-sonnet-4-6", owned_by: "anthropic" },
    ]);
    const routed = entries.find(e => e.slug === "anthropic/claude-sonnet-4-6");

    expect(routed).toBeDefined();
    expect(routed).not.toHaveProperty("model_messages");
    expect(routed).not.toHaveProperty("tool_mode");
    // Routed entries do not inherit a native template's surface pin; the global
    // Codex v2 flag can choose the surface freely unless upstream pins the model.
    expect(routed).not.toHaveProperty("multi_agent_version");
    expect(routed).not.toHaveProperty("use_responses_lite");
    expect(routed).not.toHaveProperty("supports_websockets");
    expect(routed).not.toHaveProperty("additional_speed_tiers");
    expect(routed).not.toHaveProperty("service_tier");
    expect(routed).not.toHaveProperty("service_tiers");
    expect(routed).not.toHaveProperty("default_service_tier");
    expect(routed?.web_search_tool_type).toBe("text_and_image");
    expect(routed?.supports_search_tool).toBe(true);
    expect(routed?.base_instructions).not.toBe(nativeTemplate().base_instructions);
    expect(routed?.base_instructions).toContain("claude-sonnet-4-6");
    expect(routed?.default_reasoning_level).toBe("medium");
  });
  test("buildCatalogEntries advertises parallel tool calls only for Cursor routed models", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "cursor", id: "composer-2.5", owned_by: "cursor" },
      { provider: "anthropic", id: "claude-sonnet-4-6", owned_by: "anthropic" },
    ]);

    const cursor = entries.find(e => e.slug === "cursor/composer-2.5");
    const anthropic = entries.find(e => e.slug === "anthropic/claude-sonnet-4-6");

    expect(cursor?.supports_parallel_tool_calls).toBe(true);
    expect(anthropic?.supports_parallel_tool_calls).toBe(false);
  });

  test("routed entries fill auto compact when context already exists on the template", () => {
    const template = {
      ...nativeTemplate(),
      context_window: 272_000,
      max_context_window: 272_000,
    };
    const entries = buildCatalogEntries(template, [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const routed = entries.find(e => e.slug === "local/qwen3-coder");

    expect(routed?.context_window).toBe(272_000);
    expect(routed?.max_context_window).toBe(272_000);
    expect(routed?.auto_compact_token_limit).toBe(244_800);
  });

  test("native gpt-5.4 uses its 1M context window override", () => {
    const template = {
      ...nativeTemplate(),
      context_window: 272_000,
      max_context_window: 1_000_000,
    };
    const entries = buildCatalogEntries(template, ["gpt-5.4"], []);
    const native = entries.find(e => e.slug === "gpt-5.4");

    expect(native?.context_window).toBe(1_000_000);
    expect(native?.max_context_window).toBe(1_000_000);
    expect(native?.auto_compact_token_limit).toBe(900_000);
  });

  test("native gpt-5.3-codex-spark uses its 100k context window instead of inherited codex max", () => {
    const template = {
      ...nativeTemplate(),
      context_window: 272_000,
      max_context_window: 272_000,
    };
    const entries = buildCatalogEntries(template, ["gpt-5.3-codex-spark"], []);
    const native = entries.find(e => e.slug === "gpt-5.3-codex-spark");

    expect(native?.context_window).toBe(100_000);
    expect(native?.max_context_window).toBe(100_000);
    expect(native?.auto_compact_token_limit).toBe(90_000);
  });

  test("native GPT-5.6 entries add max and ultra reasoning even when cloned from an older template", () => {
    const entries = buildCatalogEntries({
      ...nativeTemplate(),
      context_window: 272_000,
      max_context_window: 1_000_000,
    }, ["gpt-5.6-sol", "gpt-5.5"], []);
    const gpt56 = entries.find(e => e.slug === "gpt-5.6-sol");
    const gpt55 = entries.find(e => e.slug === "gpt-5.5");

    expect((gpt56?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort)).toEqual([
      "low", "medium", "high", "xhigh", "max", "ultra",
    ]);
    expect(gpt56?.context_window).toBe(372_000);
    expect(gpt56?.max_context_window).toBe(372_000);
    expect(gpt56?.auto_compact_token_limit).toBe(334_800);
    expect((gpt55?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort)).toEqual([
      "low", "medium", "high", "xhigh", "max", "ultra",
    ]);
  });

  test("gpt-5.6 natives come from the pinned upstream snapshot (PR #31684) with exact per-slug specs", () => {
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], []);
    const sol = entries.find(e => e.slug === "gpt-5.6-sol");
    const terra = entries.find(e => e.slug === "gpt-5.6-terra");
    const luna = entries.find(e => e.slug === "gpt-5.6-luna");

    // Exact ladders: sol/terra advertise ultra, luna does NOT (upstream models.json).
    expect((sol?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort))
      .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect((terra?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort))
      .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect((luna?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);

    // Default efforts: sol=low, terra/luna=medium.
    expect(sol?.default_reasoning_level).toBe("low");
    expect(terra?.default_reasoning_level).toBe("medium");
    expect(luna?.default_reasoning_level).toBe("medium");

    // Real identity, not slug-stamped synthesis.
    expect(sol?.display_name).toBe("GPT-5.6-Sol");
    expect(terra?.display_name).toBe("GPT-5.6-Terra");
    expect(luna?.display_name).toBe("GPT-5.6-Luna");
    expect(sol?.description).toBe("Latest frontier agentic coding model.");
    expect(sol?.availability_nux).toBeDefined();

    // Per-slug multi-agent generation: sol/terra v2, luna v1.
    expect(sol?.multi_agent_version).toBe("v2");
    expect(terra?.multi_agent_version).toBe("v2");
    expect(luna?.multi_agent_version).toBe("v1");

    // ocx adaptations: client-version gate stripped; ws preference gated off by default.
    for (const e of [sol, terra, luna]) {
      expect(e).not.toHaveProperty("minimal_client_version");
      expect(e).not.toHaveProperty("prefer_websockets");
      expect(e).not.toHaveProperty("supports_websockets");
      expect(e?.context_window).toBe(372_000);
      expect(e?.tool_mode).toBe("code_mode_only");
      expect(e?.use_responses_lite).toBe(true);
    }
  });

  test("gpt-5.6 snapshot entries keep prefer_websockets when websockets are enabled", () => {
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.6-sol"], [], undefined, true);
    const sol = entries.find(e => e.slug === "gpt-5.6-sol");
    expect(sol?.prefer_websockets).toBe(true);
    expect(sol?.supports_websockets).toBe(true);
  });

  test("catalog sync upgrades fallback-quality gpt-5.6 entries but preserves genuine ones", () => {
    // Fallback-quality: display_name stamped with the bare slug (ocx synthesis signature),
    // wrong ladder (ultra on luna) left by an older ocx version.
    const synthesizedLuna = {
      ...nativeTemplate(),
      slug: "gpt-5.6-luna",
      display_name: "gpt-5.6-luna",
      priority: 9,
      supported_reasoning_levels: [
        { effort: "low", description: "l" }, { effort: "max", description: "m" }, { effort: "ultra", description: "u" },
      ],
    };
    // Genuine: real display name — must be preserved untouched (installed codex is SoT once
    // it catches up), marker field proves no replacement happened.
    const genuineSol = {
      ...nativeTemplate(),
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      priority: 1,
      genuine_marker: "from-installed-catalog",
    };

    const merged = mergeCatalogEntriesForSync([synthesizedLuna, genuineSol], [], new Map(), [], false);
    const luna = merged.find(e => e.slug === "gpt-5.6-luna");
    const sol = merged.find(e => e.slug === "gpt-5.6-sol");

    expect(luna?.display_name).toBe("GPT-5.6-Luna");
    expect((luna?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(luna?.priority).toBe(3); // upstream priority restored for the upgraded entry
    expect(sol?.genuine_marker).toBe("from-installed-catalog");
    expect(sol?.priority).toBe(1);
  });

  test("routed entries still cap stale native max context to their active context window", () => {
    const template = {
      ...nativeTemplate(),
      context_window: 272_000,
      max_context_window: 1_000_000,
    };
    const entries = buildCatalogEntries(template, [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const routed = entries.find(e => e.slug === "local/qwen3-coder");

    expect(routed?.context_window).toBe(272_000);
    expect(routed?.max_context_window).toBe(272_000);
    expect(routed?.auto_compact_token_limit).toBe(244_800);
  });

  test("buildCatalogEntries preserves native bare GPT template fields", () => {
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], []);
    const native = entries.find(e => e.slug === "gpt-5.5");

    expect(native).toBeDefined();
    expect(native).toHaveProperty("model_messages");
    expect(native?.tool_mode).toBe("code");
    // Default mode clears multi_agent_version on non-pinned natives (gpt-5.5
    // has no upstream pin — codex feature flag decides the surface).
    expect(native?.multi_agent_version).toBeUndefined();
    // Non-5.6 natives do not support responses-lite: the template may carry it from a
    // 5.6 entry, but deriveEntry strips it so codex-rs does not inject
    // reasoning.context: "all_turns" for models that reject it.
    expect(native?.use_responses_lite).toBeUndefined();
    // WebSocket + lite flags are stripped for non-5.6 natives.
    expect(native?.supports_websockets).toBeUndefined();
    expect(native?.web_search_tool_type).toBe("text_and_image");
    expect(native?.supports_search_tool).toBe(true);
    expect(native?.service_tier).toBe("priority");
    expect(native?.service_tiers).toEqual([{ id: "priority" }]);
  });

  test("catalog sync keeps native OpenAI rows when adopted providers expose matching ids", () => {
    const native = nativeTemplate();
    const nativeMini = {
      ...nativeTemplate(),
      slug: "gpt-5.4-mini",
      display_name: "gpt-5.4-mini",
      priority: 6,
    };
    const routedCursorRows = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "cursor", id: "gpt-5.5", owned_by: "cursor" },
      { provider: "cursor", id: "gpt-5.4-mini", owned_by: "cursor" },
    ]);

    const merged = mergeCatalogEntriesForSync(
      [native, nativeMini, { slug: "cursor/old", visibility: "list" }],
      routedCursorRows,
      new Map([
        ["gpt-5.5", 9],
        ["gpt-5.4-mini", 10],
      ]),
      [],
      false,
    );
    const slugs = merged.map(entry => entry.slug);

    expect(slugs).toContain("gpt-5.5");
    expect(slugs).toContain("gpt-5.4-mini");
    expect(slugs).toContain("cursor/gpt-5.5");
    expect(slugs).toContain("cursor/gpt-5.4-mini");
    expect(slugs).not.toContain("cursor/old");
    expect(merged.find(entry => entry.slug === "gpt-5.5")?.priority).toBe(9);
    expect(merged.find(entry => entry.slug === "gpt-5.4-mini")?.priority).toBe(10);
  });

  test("buildCatalogEntries advertises supports_websockets only on explicit opt-in", () => {
    const goModels = [{ provider: "anthropic", id: "claude-sonnet-4-6", owned_by: "anthropic" }];

    const defaultOff = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], goModels);
    expect(defaultOff.find(e => e.slug === "gpt-5.5")).not.toHaveProperty("supports_websockets");
    expect(defaultOff.find(e => e.slug === "anthropic/claude-sonnet-4-6")).not.toHaveProperty("supports_websockets");

    const on = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], goModels, undefined, true);
    expect(on.find(e => e.slug === "gpt-5.5")?.supports_websockets).toBe(true);
    expect(on.find(e => e.slug === "anthropic/claude-sonnet-4-6")?.supports_websockets).toBe(true);

    const off = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], goModels, undefined, false);
    expect(off.find(e => e.slug === "gpt-5.5")).not.toHaveProperty("supports_websockets");
    expect(off.find(e => e.slug === "anthropic/claude-sonnet-4-6")).not.toHaveProperty("supports_websockets");
  });

  test("fallback routed entries still receive explicit search metadata", () => {
    const entries = buildCatalogEntries(null, [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const routed = entries.find(e => e.slug === "local/qwen3-coder");

    expect(routed?.web_search_tool_type).toBe("text_and_image");
    expect(routed?.supports_search_tool).toBe(true);
  });

  test("liveModels false uses configured provider models without fetching", async () => {
    clearModelCache("static-provider");
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("fetch should not be called");
    }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          "static-provider": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["alpha", "beta"],
          },
        },
      });

      expect(fetchCalls).toBe(0);
      expect(models.map(m => `${m.provider}/${m.id}`)).toEqual([
        "static-provider/alpha",
        "static-provider/beta",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("static-provider");
    }
  });

  test("configured alias with a dated live variant is retained (Anthropic haiku pattern)", async () => {
    clearModelCache("dated-provider");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: "claude-sonnet-5" },
        { id: "claude-haiku-4-5-20251001" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          "dated-provider": {
            baseUrl: "https://example.invalid",
            adapter: "openai-chat",
            authMode: "key",
            apiKey: "k",
            models: ["claude-sonnet-5", "claude-haiku-4-5", "claude-gone-3"],
          },
        },
      });
      const ids = models.map(m => m.id);
      expect(ids).toContain("claude-haiku-4-5"); // alias kept: dated variant proves it is live
      expect(ids).toContain("claude-haiku-4-5-20251001"); // dated id stays too (authoritative)
      expect(ids).not.toContain("claude-gone-3"); // genuinely missing ids still drop
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("dated-provider");
    }
  });

  test("isDatedVariantId matches only <alias>-YYYYMMDD", () => {
    expect(isDatedVariantId("claude-haiku-4-5-20251001", "claude-haiku-4-5")).toBe(true);
    expect(isDatedVariantId("claude-haiku-4-5-2025", "claude-haiku-4-5")).toBe(false);
    expect(isDatedVariantId("claude-haiku-4-5-latest", "claude-haiku-4-5")).toBe(false);
    expect(isDatedVariantId("claude-haiku-4-5", "claude-haiku-4-5")).toBe(false);
    expect(isDatedVariantId("claude-haiku-4-5-20251001", "claude-haiku-4")).toBe(false);
  });

  test("disabled providers are excluded from routed model gathering", async () => {
    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "active",
      providers: {
        active: {
          adapter: "openai-chat",
          baseUrl: "https://active.example.test/v1",
          liveModels: false,
          models: ["active-model"],
        },
        disabled: {
          adapter: "openai-chat",
          baseUrl: "https://disabled.example.test/v1",
          liveModels: false,
          models: ["disabled-model"],
          disabled: true,
        },
      },
    });

    expect(models.map(m => `${m.provider}/${m.id}`)).toEqual(["active/active-model"]);
  });

  test("Cursor static metadata routes into catalog entries without live fetch", async () => {
    clearModelCache("cursor");
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("fetch should not be called");
    }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          cursor: {
            baseUrl: "https://api2.cursor.sh",
            adapter: "cursor",
            authMode: "oauth",
            liveModels: false,
            models: cursorModelIds(CURSOR_STATIC_MODELS),
            defaultModel: "auto",
            modelContextWindows: cursorModelContextWindows(CURSOR_STATIC_MODELS),
            modelInputModalities: cursorModelInputModalities(CURSOR_STATIC_MODELS),
            modelReasoningEfforts: cursorModelReasoningEfforts(CURSOR_STATIC_MODELS),
          },
        },
      });

      expect(fetchCalls).toBe(0);
      const auto = models.find(model => model.provider === "cursor" && model.id === "auto");
      expect(auto).toMatchObject({
        provider: "cursor",
        id: "auto",
        contextWindow: 200_000,
        inputModalities: ["text", "image"],
        reasoningEfforts: [],
      });

      const entries = buildCatalogEntries(nativeTemplate(), [], models);
      const entry = entries.find(item => item.slug === "cursor/auto");
      expect(entry?.context_window).toBe(200_000);
      expect(entry?.input_modalities).toEqual(["text", "image"]);
      expect(entry?.supported_reasoning_levels).toEqual([]);
      expect(entry).not.toHaveProperty("default_reasoning_level");
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("cursor");
    }
  });

  test("Cursor live discovery keeps auto even when GetUsableModels omits it", () => {
    const configured = [{ id: "auto" }, { id: "gpt-5.4" }, { id: "claude-fable-5" }];
    expect(filterCursorConfiguredModelsByLiveDiscovery(configured, ["gpt-5.4-high"]).map(model => model.id)).toEqual([
      "auto",
      "gpt-5.4",
    ]);
  });

  test("liveModels false ignores a fresh live-model cache", async () => {
    setCached("static-cache", [
      { provider: "static-cache", id: "cached-live-model" },
    ]);
    try {
      const models = await gatherRoutedModels({
        providers: {
          "static-cache": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["configured-only"],
          },
        },
      });

      expect(models.map(m => `${m.provider}/${m.id}`)).toEqual([
        "static-cache/configured-only",
      ]);
    } finally {
      clearModelCache("static-cache");
    }
  });

  test("successful live discovery after a static toggle drops configured ghosts with a warning", async () => {
    clearModelCache("static-toggle");
    const originalFetch = globalThis.fetch;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        data: [{ id: "live-after-toggle", owned_by: "provider" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const staticModels = await gatherRoutedModels({
        providers: {
          "static-toggle": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["configured-only"],
          },
        },
      });

      expect(staticModels.map(m => `${m.provider}/${m.id}`)).toEqual([
        "static-toggle/configured-only",
      ]);
      expect(fetchCalls).toBe(0);

      const liveModels = await gatherRoutedModels({
        providers: {
          "static-toggle": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: true,
            models: ["configured-only"],
          },
        },
      });

      expect(fetchCalls).toBe(1);
      expect(liveModels.map(m => `${m.provider}/${m.id}`)).toEqual([
        "static-toggle/live-after-toggle",
      ]);
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain("static-toggle");
      expect(warningText).toContain("configured-only");
    } finally {
      warning.mockRestore();
      globalThis.fetch = originalFetch;
      clearModelCache("static-toggle");
    }
  });

  test("managed Kimi and xAI catalogs preserve callable compatibility ids without omission warnings", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async input => new Response(JSON.stringify({
      data: String(input).includes("kimi.example.test")
        ? [{ id: "k3" }, { id: "kimi-for-coding" }, { id: "kimi-for-coding-highspeed" }]
        : [{ id: "grok-4.5" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        providers: {
          kimi: {
            adapter: "openai-chat",
            baseUrl: "https://kimi.example.test/v1",
            authMode: "key",
            apiKey: "sk-test",
            liveModels: true,
            models: [
              "k3",
              "k3[1m]",
              "kimi-k2.7-code",
              "kimi-k2.7-code-highspeed",
              "kimi-k2.6",
              "kimi-k2.5",
              "configured-ghost",
            ],
            modelSuffixBracketStrip: true,
            modelContextWindows: { "k3[1m]": 1_048_576 },
          },
          xai: {
            adapter: "openai-chat",
            baseUrl: "https://xai.example.test/v1",
            authMode: "key",
            apiKey: "sk-test",
            liveModels: true,
            models: [
              "grok-4.5",
              "grok-4.3",
              "grok-4.20-0309-reasoning",
              "grok-4.20-0309-non-reasoning",
              "grok-build-0.1",
              "grok-composer-2.5-fast",
              "grok-4.20-multi-agent-0309",
              "configured-ghost",
            ],
          },
        },
      });

      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        "kimi/k3",
        "kimi/k3[1m]",
        "kimi/kimi-for-coding",
        "kimi/kimi-for-coding-highspeed",
        "kimi/kimi-k2.5",
        "kimi/kimi-k2.6",
        "kimi/kimi-k2.7-code",
        "kimi/kimi-k2.7-code-highspeed",
        "xai/grok-4.20-0309-non-reasoning",
        "xai/grok-4.20-0309-reasoning",
        "xai/grok-4.3",
        "xai/grok-4.5",
        "xai/grok-build-0.1",
        "xai/grok-composer-2.5-fast",
      ]);
      expect(models.find(model => model.provider === "kimi" && model.id === "k3[1m]")?.contextWindow).toBe(1_048_576);
      expect(models.some(model => model.id === "grok-4.20-multi-agent-0309")).toBe(false);
      expect(models.some(model => model.id === "configured-ghost")).toBe(false);
      expect(warning.mock.calls.flat().join(" ")).not.toContain("omitted configured model ids");
    } finally {
      warning.mockRestore();
      clearModelCache("kimi");
      clearModelCache("xai");
    }
  });

  test("malformed 2xx discovery keeps the stale catalog and does not cache the response", async () => {
    const provider = "malformed-stale";
    setCached(provider, [{ provider, id: "last-known-good" }]);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ data: [{ id: 42 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        modelCacheTtlMs: 0,
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "https://malformed-stale.test/v1",
            apiKey: "sk-test",
            models: ["static-fallback"],
          },
        },
      });

      expect(fetchCalls).toBe(1);
      expect(models.map(m => `${m.provider}/${m.id}`)).toEqual([
        `${provider}/last-known-good`,
      ]);
      expect(getStaleCached(provider)).toEqual([{ provider, id: "last-known-good" }]);
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("malformed Google-style 2xx discovery keeps the static catalog", async () => {
    const provider = "malformed-static";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () => new Response(JSON.stringify({
      models: [{ name: "models/not-openai-shaped" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "https://malformed-static.test/v1",
            apiKey: "sk-test",
            models: ["static-fallback"],
          },
        },
      });

      expect(models.map(m => `${m.provider}/${m.id}`)).toEqual([
        `${provider}/static-fallback`,
      ]);
      expect(getStaleCached(provider)).toBeNull();
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("schema-valid empty discovery is authoritative, warned, and cached", async () => {
    const provider = "authoritative-empty";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const config = {
      providers: {
        [provider]: {
          adapter: "openai-chat",
          baseUrl: "https://authoritative-empty.test/v1",
          apiKey: "sk-test",
          models: ["configured-ghost"],
        },
      },
    };

    try {
      const first = await gatherRoutedModels(config);
      const second = await gatherRoutedModels(config);

      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(fetchCalls).toBe(1);
      expect(getStaleCached(provider)).toEqual([]);
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain(provider);
      expect(warningText).toContain("configured-ghost");
      expect(warningText).toContain("authoritative empty catalog");
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("routed entries receive exact jawcode context metadata", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "opencode-go", id: "deepseek-v4-pro" },
    ]);
    const routed = entries.find(e => e.slug === "opencode-go/deepseek-v4-pro");

    expect(routed?.context_window).toBe(1_000_000);
    expect(routed?.max_context_window).toBe(1_000_000);
    expect(routed?.auto_compact_token_limit).toBe(900_000);
    expect(routed?.input_modalities).toEqual(["text"]);
  });

  test("provider context-cap applies before jawcode catalog metadata reaches Codex", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "opencode-go", id: "deepseek-v4-pro", contextCap: 350_000, contextCapped: false },
    ]);
    const routed = entries.find(e => e.slug === "opencode-go/deepseek-v4-pro");

    expect(routed?.context_window).toBe(350_000);
    expect(routed?.max_context_window).toBe(350_000);
    expect(routed?.auto_compact_token_limit).toBe(315_000);
    expect(routed?.input_modalities).toEqual(["text"]);
    expect(getJawcodeModelMetadata("opencode-go", "deepseek-v4-pro")?.contextWindow).toBe(1_000_000);
  });

  test("opencode-go high-risk models use official jawcode metadata in the Codex catalog", () => {
    const cases = [
      { id: "glm-5.2", context: 1_000_000, auto: 900_000, input: ["text"] },
      { id: "qwen3.5-plus", context: 262_144, auto: 235_929, input: ["text", "image"] },
      { id: "kimi-k2.7-code", context: 262_144, auto: 235_929, input: ["text", "image"] },
      { id: "minimax-m3", context: 1_000_000, auto: 900_000, input: ["text", "image"] },
      { id: "qwen3.7-max", context: 1_000_000, auto: 900_000, input: ["text"] },
    ] as const;
    const entries = buildCatalogEntries(nativeTemplate(), [], cases.map(({ id }) => ({ provider: "opencode-go", id })));

    for (const item of cases) {
      const routed = entries.find(e => e.slug === `opencode-go/${item.id}`);

      expect(routed?.context_window).toBe(item.context);
      expect(routed?.max_context_window).toBe(item.context);
      expect(routed?.auto_compact_token_limit).toBe(item.auto);
      expect(routed?.input_modalities).toEqual(item.input);
      expect(getJawcodeModelMetadata("opencode-go", item.id)?.contextWindow).toBe(item.context);
    }
  });

  test("opencode-go catalog sync appends official rows missing from /v1/models", () => {
    const models = augmentRoutedModelsWithJawcodeMetadata(
      [{ provider: "opencode-go", id: "glm-5.2" }],
      ["opencode-go"],
    );
    const slugs = new Set(models.map(m => `${m.provider}/${m.id}`));

    expect(slugs.has("opencode-go/glm-5.2")).toBe(true);
    expect(slugs.has("opencode-go/qwen3.5-plus")).toBe(true);
    expect(slugs.has("opencode-go/qwen3.6-plus")).toBe(true);
    // Issue #82: hy3-preview was dropped from the Zen Go lite list upstream; the
    // generated bundle must not resurrect it as a selectable model.
    expect(slugs.has("opencode-go/hy3-preview")).toBe(false);
    expect(models.filter(m => `${m.provider}/${m.id}` === "opencode-go/glm-5.2")).toHaveLength(1);
  });

  test("opencode-go catalog sync appends jawcode rows with provider context-cap metadata", () => {
    const models = augmentRoutedModelsWithJawcodeMetadata(
      [],
      ["opencode-go"],
      {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://opencode-go.test/v1",
          apiKey: "sk-test",
        },
      },
      { providerContextCaps: { "opencode-go": 350_000 } },
    );
    const model = models.find(m => `${m.provider}/${m.id}` === "opencode-go/qwen3.6-plus");

    expect(model).toMatchObject({
      contextWindow: 350_000,
      contextCap: 350_000,
      contextCapped: true,
      inputModalities: ["text", "image"],
    });

    const entries = buildCatalogEntries(nativeTemplate(), [], [model!]);
    const routed = entries.find(e => e.slug === "opencode-go/qwen3.6-plus");

    expect(routed?.context_window).toBe(350_000);
    expect(routed?.max_context_window).toBe(350_000);
    expect(routed?.auto_compact_token_limit).toBe(315_000);
    expect(routed?.input_modalities).toEqual(["text", "image"]);
  });

  test("liveModels false disables jawcode metadata augmentation for exact allowlists", async () => {
    const models = await gatherRoutedModels({
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://opencode-go.test/v1",
          apiKey: "sk-test",
          liveModels: false,
          models: ["glm-5.2"],
        },
      },
    });
    const slugs = models.map(m => `${m.provider}/${m.id}`);

    expect(slugs).toEqual(["opencode-go/glm-5.2"]);
  });

  test("liveModels false with no models exposes no augmented provider rows", async () => {
    const models = await gatherRoutedModels({
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://opencode-go.test/v1",
          apiKey: "sk-test",
          liveModels: false,
        },
      },
    });

    expect(models).toEqual([]);
  });

  test("anthropic sonnet 4.6 uses the 200k opencodex catalog cap", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "anthropic", id: "claude-sonnet-4-6" },
    ]);
    const routed = entries.find(e => e.slug === "anthropic/claude-sonnet-4-6");

    expect(routed?.context_window).toBe(200_000);
    expect(routed?.max_context_window).toBe(200_000);
    expect(routed?.auto_compact_token_limit).toBe(180_000);
    expect(getJawcodeModelMetadata("anthropic", "claude-sonnet-4-6")?.contextWindow).toBe(200_000);
  });

  test("routed entries resolve jawcode provider aliases", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "kimi", id: "kimi-k2.5" },
    ]);
    const routed = entries.find(e => e.slug === "kimi/kimi-k2.5");

    expect(routed?.context_window).toBe(262_144);
    expect(routed?.max_context_window).toBe(262_144);
    expect(routed?.auto_compact_token_limit).toBe(235_929);
    expect(routed?.input_modalities).toEqual(["text", "image"]);
  });

  test("unknown routed entries receive conservative strict catalog defaults", () => {
    const entries = buildCatalogEntries(null, [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const routed = entries.find(e => e.slug === "local/qwen3-coder");

    expect(routed?.context_window).toBe(128_000);
    expect(routed?.max_context_window).toBe(128_000);
    expect(routed?.auto_compact_token_limit).toBe(115_200);
    expect(routed?.input_modalities).toEqual(["text"]);
    expect(routed?.supports_reasoning_summaries).toBe(true);
    expect(routed?.default_reasoning_summary).toBe("none");
  });

  test("generated jawcode snapshot is restricted to mapped providers", () => {
    expect(resolveJawcodeProvider("kimi")).toBe("moonshot");
    expect(resolveJawcodeProvider("nanogpt")).toBeUndefined();
    expect(getJawcodeModelMetadata("moonshot", "kimi-k2.5")?.contextWindow).toBe(262_144);
    expect(getJawcodeModelMetadata("nanogpt", "some-model")).toBeUndefined();
  });

  test("provider config model metadata reaches Codex catalog for static models", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-static",
      providers: {
        "meta-static": {
          adapter: "openai-chat",
          baseUrl: "https://meta-static.test/v1",
          apiKey: "sk-test",
          models: ["static-model"],
          modelContextWindows: { "static-model": 321_000 },
          modelInputModalities: { "static-model": ["text", "image"] },
        },
      },
    });
    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    const routed = entries.find(e => e.slug === "meta-static/static-model");

    expect(routed?.context_window).toBe(321_000);
    expect(routed?.max_context_window).toBe(321_000);
    expect(routed?.auto_compact_token_limit).toBe(288_900);
    expect(routed?.input_modalities).toEqual(["text", "image"]);
  });

  test("liveModels false preserves configured catalog metadata without live fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("fetch should not be called");
    }) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-static-allowlist",
      providers: {
        "meta-static-allowlist": {
          adapter: "openai-chat",
          baseUrl: "https://meta-static.test/v1",
          apiKey: "sk-test",
          liveModels: false,
          models: ["static-model"],
          modelContextWindows: { "static-model": 321_000 },
          modelInputModalities: { "static-model": ["text", "image"] },
        },
      },
    });
    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    const routed = entries.find(e => e.slug === "meta-static-allowlist/static-model");

    expect(fetchCalls).toBe(0);
    expect(routed?.context_window).toBe(321_000);
    expect(routed?.max_context_window).toBe(321_000);
    expect(routed?.auto_compact_token_limit).toBe(288_900);
    expect(routed?.input_modalities).toEqual(["text", "image"]);
  });

  test("provider context-window caps lower live metadata without raising smaller live windows", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        {
          id: "wide-model",
          owned_by: "meta-live",
          metadata: {
            limits: { max_context_length: 500_000 },
            capabilities: { vision: true, reasoning_effort: true },
          },
        },
        {
          id: "small-model",
          owned_by: "meta-live",
          metadata: {
            limits: { max_context_length: 64_000 },
            capabilities: { vision: true },
          },
        },
      ],
    }))) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-live",
      providers: {
        "meta-live": {
          adapter: "openai-chat",
          baseUrl: "https://meta-live.test/v1",
          apiKey: "sk-test",
          contextWindow: 128_000,
          modelContextWindows: { "wide-model": 100_000 },
          modelInputModalities: { "wide-model": ["text"] },
        },
      },
    });

    expect(models.find(m => m.id === "wide-model")).toMatchObject({
      contextWindow: 100_000,
      inputModalities: ["text"],
    });
    expect(models.find(m => m.id === "small-model")?.contextWindow).toBe(64_000);
  });

  test("OpenRouter-style context_length live metadata is preserved", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: "anthropic/claude-sonnet-5", owned_by: "openrouter", context_length: 1_000_000 },
      ],
    }))) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "openrouter",
      providers: {
        openrouter: {
          adapter: "openai-chat",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: ["anthropic/claude-sonnet-5"],
          modelContextWindows: { "anthropic/claude-sonnet-5": 1_000_000 },
        },
      },
    });

    expect(models.find(m => m.id === "anthropic/claude-sonnet-5")).toMatchObject({
      contextWindow: 1_000_000,
    });
  });

  test("provider context-cap toggle lowers only known windows above 350k", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: "wide-model", metadata: { limits: { max_context_length: 500_000 } } },
        { id: "small-model", metadata: { limits: { max_context_length: 64_000 } } },
        { id: "unknown-model", metadata: { capabilities: { vision: true } } },
      ],
    }))) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-cap",
      providerContextCaps: { "meta-cap": 350_000 },
      providers: {
        "meta-cap": {
          adapter: "openai-chat",
          baseUrl: "https://meta-cap.test/v1",
          apiKey: "sk-test",
        },
      },
    });

    expect(models.find(m => m.id === "wide-model")).toMatchObject({
      contextWindow: 350_000,
      contextCap: 350_000,
      contextCapped: true,
    });
    expect(models.find(m => m.id === "small-model")).toMatchObject({
      contextWindow: 64_000,
      contextCap: 350_000,
      contextCapped: false,
    });
    expect(models.find(m => m.id === "unknown-model")).toMatchObject({
      contextCap: 350_000,
      contextCapped: false,
    });
    expect(models.find(m => m.id === "unknown-model")?.contextWindow).toBeUndefined();
  });

  test("provider context-cap toggle does not invent context for static no-metadata models", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("fetch should not be called");
    }) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-static-cap",
      providerContextCaps: { "meta-static-cap": 350_000 },
      providers: {
        "meta-static-cap": {
          adapter: "openai-chat",
          baseUrl: "https://meta-static-cap.test/v1",
          apiKey: "sk-test",
          liveModels: false,
          models: ["static-no-context"],
        },
      },
    });

    expect(fetchCalls).toBe(0);
    expect(models.find(m => m.id === "static-no-context")).toMatchObject({
      contextCap: 350_000,
      contextCapped: false,
    });
    expect(models.find(m => m.id === "static-no-context")?.contextWindow).toBeUndefined();
  });

  test("provider context-window caps apply to stale cached metadata", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{
        id: "cached-model",
        metadata: {
          limits: { max_context_length: 500_000 },
          capabilities: { vision: true },
        },
      }],
    }))) as typeof fetch;

    await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-cache",
      providers: {
        "meta-cache": {
          adapter: "openai-chat",
          baseUrl: "https://meta-cache.test/v1",
          apiKey: "sk-test",
          modelContextWindows: { "cached-model": 120_000 },
        },
      },
    });

    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-cache",
      modelCacheTtlMs: 0,
      providers: {
        "meta-cache": {
          adapter: "openai-chat",
          baseUrl: "https://meta-cache.test/v1",
          apiKey: "sk-test",
          modelContextWindows: { "cached-model": 80_000 },
        },
      },
    });

    expect(models.find(m => m.id === "cached-model")?.contextWindow).toBe(80_000);
  });

  test("provider context-cap toggle applies to stale cached metadata", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{
        id: "cached-wide-model",
        metadata: {
          limits: { max_context_length: 500_000 },
          capabilities: { vision: true },
        },
      }],
    }))) as typeof fetch;

    await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-cache-cap",
      providers: {
        "meta-cache-cap": {
          adapter: "openai-chat",
          baseUrl: "https://meta-cache-cap.test/v1",
          apiKey: "sk-test",
        },
      },
    });

    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "meta-cache-cap",
      modelCacheTtlMs: 0,
      providerContextCaps: { "meta-cache-cap": 350_000 },
      providers: {
        "meta-cache-cap": {
          adapter: "openai-chat",
          baseUrl: "https://meta-cache-cap.test/v1",
          apiKey: "sk-test",
        },
      },
    });

    expect(models.find(m => m.id === "cached-wide-model")).toMatchObject({
      contextWindow: 350_000,
      contextCap: 350_000,
      contextCapped: true,
    });
  });
});

describe("OpenAI API trusted catalog augmentation", () => {
  const exactIds = [
    "gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    "gpt-5.6-sol-pro", "gpt-5.6-terra-pro", "gpt-5.6-luna-pro",
  ];

  test("rebuilds the exact eight rows after partial/conflicting successful discovery", () => {
    const rows = augmentRoutedModelsWithRegistryOpenAiApiRows([
      { provider: "openai-apikey", id: "gpt-5.6-sol", contextWindow: 1, maxInputTokens: 1, inputModalities: ["text"], reasoningEfforts: ["low"], owned_by: "live" },
      { provider: "openai-apikey", id: "unrelated-live-model", contextWindow: 999 },
      { provider: "openai", id: "gpt-5.6-sol", contextWindow: 372_000 },
    ], openAiApiCatalogConfig());

    expect(rows.filter(row => row.provider === "openai-apikey").map(row => row.id)).toEqual(exactIds);
    expect(rows.find(row => row.provider === "openai-apikey" && row.id === "gpt-5.6-sol")).toMatchObject({
      contextWindow: 1_050_000,
      maxInputTokens: 922_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(rows.find(row => row.provider === "openai" && row.id === "gpt-5.6-sol")?.contextWindow).toBe(372_000);
  });

  test("actual live discovery path reconnects omitted rows and removes unrelated models", async () => {
    const calls: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = async input => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url !== "https://api.openai.com/v1/models") throw new Error(`unexpected URL: ${url}`);
      return Response.json({
        data: [
          { id: "gpt-5.6-sol", owned_by: "live-openai", context_length: 123 },
          { id: "unrelated-live-model", owned_by: "live-openai", context_length: 999 },
        ],
      });
    };
    try {
      const rows = await gatherRoutedModels(openAiApiCatalogConfig({ liveModels: true }));
      const apiRows = rows.filter(row => row.provider === "openai-apikey");
      expect(calls).toEqual(["https://api.openai.com/v1/models"]);
      expect(apiRows.map(row => row.id)).toEqual([...exactIds].sort());
      expect(apiRows.some(row => row.id === "unrelated-live-model")).toBe(false);
      for (const row of apiRows.filter(row => row.id.startsWith("gpt-5.6"))) {
        expect(row).toMatchObject({
          contextWindow: 1_050_000,
          maxInputTokens: 922_000,
          inputModalities: ["text", "image"],
          reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        });
      }
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("actual gathering exposes no API rows when the API tier is absent or disabled", async () => {
    globalThis.fetch = async input => { throw new Error(`unexpected fetch: ${String(input)}`); };
    const absent: OcxConfig = {
      port: 10100,
      defaultProvider: "custom",
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", liveModels: false, models: ["model"] } },
    };
    const disabled = openAiApiCatalogConfig({ disabled: true });
    expect((await gatherRoutedModels(absent)).some(row => row.provider === "openai-apikey")).toBe(false);
    expect((await gatherRoutedModels(disabled)).some(row => row.provider === "openai-apikey")).toBe(false);
  });

  test("user values only lower trusted context and max-input baselines", () => {
    const lowered = augmentRoutedModelsWithRegistryOpenAiApiRows([], openAiApiCatalogConfig({
      modelContextWindows: { "gpt-5.6-sol": 350_000, "gpt-5.6-terra": 2_000_000 },
      modelMaxInputTokens: { "gpt-5.6-sol": 300_000, "gpt-5.6-terra": 945_000 },
    }));
    expect(lowered.find(row => row.id === "gpt-5.6-sol")).toMatchObject({ contextWindow: 350_000, maxInputTokens: 300_000 });
    expect(lowered.find(row => row.id === "gpt-5.6-terra")).toMatchObject({ contextWindow: 1_050_000, maxInputTokens: 922_000 });
  });

  test("routed auto-compaction is bounded by max-input after effective context caps", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "openai-apikey", id: "gpt-5.6-sol", contextWindow: 1_050_000, maxInputTokens: 922_000 },
      { provider: "openai-apikey", id: "gpt-5.6-terra", contextWindow: 350_000, maxInputTokens: 922_000 },
    ]);
    expect(entries.find(row => row.slug === "openai-apikey/gpt-5.6-sol")?.auto_compact_token_limit).toBe(922_000);
    expect(entries.find(row => row.slug === "openai-apikey/gpt-5.6-terra")?.auto_compact_token_limit).toBe(315_000);
  });

  test("is a no-op when API tier is absent or disabled", () => {
    const source = [{ provider: "other", id: "model" }];
    const absent: OcxConfig = { port: 10100, defaultProvider: "other", providers: { other: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } } };
    expect(augmentRoutedModelsWithRegistryOpenAiApiRows(source, absent)).toBe(source);
    expect(augmentRoutedModelsWithRegistryOpenAiApiRows(source, openAiApiCatalogConfig({ disabled: true }))).toBe(source);
  });

  test("dedupes semantic collision warnings process-wide and warns again on changed mismatch", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const equalDifferentOrder = {
        provider: "openai-apikey", id: "gpt-5.6-sol", contextWindow: 1_050_000, maxInputTokens: 922_000,
        inputModalities: ["image", "text", "image"], reasoningEfforts: ["max", "low", "xhigh", "medium", "high", "low"], owned_by: "openai-apikey",
      };
      augmentRoutedModelsWithRegistryOpenAiApiRows([equalDifferentOrder], openAiApiCatalogConfig());
      expect(warn).not.toHaveBeenCalled();

      const mismatch = { ...equalDifferentOrder, contextWindow: 1 };
      augmentRoutedModelsWithRegistryOpenAiApiRows([mismatch], openAiApiCatalogConfig());
      augmentRoutedModelsWithRegistryOpenAiApiRows([{ ...mismatch, inputModalities: ["text", "image"] }], openAiApiCatalogConfig());
      expect(warn).toHaveBeenCalledTimes(1);
      augmentRoutedModelsWithRegistryOpenAiApiRows([{ ...mismatch, contextWindow: 2 }], openAiApiCatalogConfig());
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("native slug allowlist", () => {
  test("drops legacy/internal natives from a live Codex catalog", () => {
    const liveModels = [
      { slug: "gpt-5.5", visibility: "list" },
      { slug: "gpt-5.4", visibility: "list" },
      { slug: "gpt-5.4-mini", visibility: "list" },
      { slug: "gpt-5.3-codex", visibility: "list" },
      { slug: "gpt-5.2", visibility: "list" },
      { slug: "codex-auto-review", visibility: "list" },
      { slug: "gpt-5.3-codex-spark", visibility: "list" },
      { slug: "anthropic/claude-opus-4-8", visibility: "list" },
      { slug: "gpt-5.5", visibility: "hidden" },
    ];

    expect(filterSupportedNativeSlugs(liveModels)).toEqual([
      "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
    ]);
  });

  test("keeps GPT-5.6 native preview slugs from a live Codex catalog", () => {
    const liveModels = [
      { slug: "gpt-5.6-sol", visibility: "list" },
      { slug: "gpt-5.6-terra", visibility: "list" },
      { slug: "gpt-5.6-luna", visibility: "list" },
      { slug: "gpt-5.6-internal", visibility: "list" },
    ];

    expect(filterSupportedNativeSlugs(liveModels)).toEqual([
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    ]);
  });
});

describe("media-generation model filtering", () => {
  test("flags image/video generation model ids", () => {
    for (const id of [
      "grok-2-image", "grok-2-image-1212", "grok-2-image-latest", "grok-video",
      "gpt-5-image", "gpt-5-image-mini", "gpt-image-1", "gemini-3-pro-image",
      "dall-e-3", "imagen-4", "sora-2", "veo-3", "flux", "stable-diffusion-3.5", "sdxl", "kling-2",
    ]) {
      expect(isMediaGenerationModelId(id)).toBe(true);
    }
  });

  test("keeps text + vision-input chat model ids", () => {
    for (const id of [
      "grok-4.3", "grok-2-vision", "grok-2-vision-1212", "grok-composer-2.5-fast",
      "gpt-4o", "gpt-5.2", "claude-opus-4-8", "gemini-3-pro-preview",
      "qwen3-vl-30b-a3b-instruct", "openrouter/aurora-alpha", "deepseek-v4-pro", "minimax-m3",
    ]) {
      expect(isMediaGenerationModelId(id)).toBe(false);
    }
  });
});
