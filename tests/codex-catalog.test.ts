import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyNativeVisibility, augmentRoutedModelsWithMetadata, augmentRoutedModelsWithRegistryOpenAiApiRows, buildCatalogEntries, buildComboCatalogOmission, catalogModelSlug, clampCatalogModelsToCodexSupport, clampEntryToCodexSupportedEfforts, clampedDefaultEffort, CODEX_ACCOUNT_BOUND_CATALOG_KIND, CODEX_NATIVE_ALIAS_CATALOG_KIND, comboCatalogOmissionReason, deriveComboCatalogModel, exactComboCatalogSlugs, filterCatalogVisibleModels, filterSupportedNativeSlugs, gatherRoutedModels as gatherRoutedModelsDirect, isDatedVariantId, isMediaGenerationModelId, loadBundledCodexCatalog, materializeBundledCodexCatalog, mergeCatalogEntriesForSync, NATIVE_DAYBREAK_BLUE_MODEL, NATIVE_OPENAI_MODELS, nativeDefaultReasoningEffort, nativeInputModalities, nativeOpenAiCapabilitySourceSlug, nativeOpenAiContextWindow, nativeReasoningEfforts, normalizeRoutedCatalogEntry, resetCatalogRuntimeStateForTests, resetOpenAiApiCatalogWarningStateForTests, resolveComboCatalogMember, shouldExposeRoutedModel, upstreamNativeEntry } from "../src/codex/catalog";
import { applyProviderConfigHints } from "../src/codex/catalog/provider-fetch";
import {
  CODEX_CUSTOM_MODEL_CATALOG_KIND,
  CODEX_PROVIDER_MODEL_CATALOG_KIND,
  ensureStrictCatalogFields,
  findNativeTemplate,
  findSupportedNativeTemplate,
} from "../src/codex/catalog/parsing";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import {
  CURSOR_STATIC_MODELS,
  filterCursorConfiguredModelsByLiveDiscovery,
  cursorModelContextWindows,
  cursorModelIds,
  cursorModelInputModalities,
  cursorModelReasoningEfforts,
} from "../src/adapters/cursor/discovery";
import { getModelMetadata, resolveMetadataProvider } from "../src/generated/model-metadata";
import { resetCodexModelEntitlementCacheForTests, seedCodexModelEntitlementsForTests } from "../src/codex/model-entitlements";
import {
  clearModelCache,
  getProviderDiscoveryStatus,
  getStaleCached,
  markProviderDiscoveryFailed,
  setCached,
  type ProviderModelDiscoveryStatus,
} from "../src/codex/model-cache";
import type { OcxConfig } from "../src/types";
import { COMBO_NAMESPACE } from "../src/combos";
import type { NormalizedComboConfig } from "../src/combos/types";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { enrichProviderFromCatalog } from "../src/oauth/key-providers";
import { handleManagementAPI } from "../src/server/management-api";
import { OAUTH_PROVIDERS } from "../src/oauth";
import {
  clampCatalogModelsToObservedCodexSupport,
  supportedCodexReasoningEffortsFromObservedCatalog,
} from "../src/codex/catalog/effort";
import {
  CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
  mergeCatalogEntriesFromObservedState,
  type ObservedCatalogMergeInput,
} from "../src/codex/catalog/sync";

const originalFetch = globalThis.fetch;

/**
 * Discovery runs on the pinned outbound transport, which does not read
 * `globalThis.fetch`. These tests stub that global, so every config gets the
 * caller-owned executor that hands control back to the stub.
 */
const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  resetOpenAiApiCatalogWarningStateForTests();
  resetCodexModelEntitlementCacheForTests();
});

function normalizedCombo(
  overrides: Partial<NormalizedComboConfig> = {},
): NormalizedComboConfig {
  return {
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: "medium",
    imageInput: "auto",
    alias: null,
    nativeAlias: false,
    displayName: null,
    targets: [
      { provider: "a", model: "m1", weight: 1 },
      { provider: "b", model: "m2", weight: 1 },
    ],
    ...overrides,
  };
}

async function providerDiscoveryDto(provider: string): Promise<Record<string, unknown>> {
  const requestUrl = new URL("http://127.0.0.1/api/providers");
  const response = await handleManagementAPI(
    new Request(requestUrl),
    requestUrl,
    {
      port: 10100,
      defaultProvider: provider,
      providers: {
        [provider]: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          models: [],
        },
      },
    },
  );
  const providers = await response!.json() as Array<Record<string, unknown>>;
  return providers[0] ?? {};
}

/**
 * Drive the real discovery path (not `markProviderDiscoveryOk` directly) and read the
 * live-model provenance back out of `/api/selected-models`. Calling the marker by hand would
 * still pass if a production branch forgot to record the count.
 */
async function liveModelCountAfterDiscovery(provider: string, models: string[] | "fail"): Promise<number | undefined> {
  const config = {
    port: 10100,
    defaultProvider: provider,
    providers: {
      [provider]: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "k",
        liveModels: true,
        models: ["configured-fallback"],
        fetch: ((input: RequestInfo | URL) => globalThis.fetch(input)) as typeof fetch,
      },
    },
  } as unknown as Parameters<typeof handleManagementAPI>[2];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!String(input).includes("/models")) return new Response(null, { status: 404 });
    if (models === "fail") return new Response("nope", { status: 500 });
    return Response.json({ data: models.map(id => ({ id })) });
  }) as typeof fetch;

  await gatherRoutedModels(config);

  const url = new URL("http://127.0.0.1/api/selected-models");
  const response = await handleManagementAPI(new Request(url), url, config);
  const body = await response!.json() as { liveModelCounts?: Record<string, number> };
  return body.liveModelCounts?.[provider];
}

describe("live model provenance (#448 custom-model misclassification)", () => {
  afterEach(() => { globalThis.fetch = originalFetch; clearModelCache(); });

  test("a non-empty discovery records how many rows it actually returned", async () => {
    clearModelCache();
    expect(await liveModelCountAfterDiscovery("prov-live", ["a", "b", "c"])).toBe(3);
  });

  test("a successful but empty discovery records zero, not 'never discovered'", async () => {
    clearModelCache();
    expect(await liveModelCountAfterDiscovery("prov-empty", [])).toBe(0);
  });

  test("a failed refresh keeps the last successful count so a stale catalog stays live-origin", async () => {
    clearModelCache();
    expect(await liveModelCountAfterDiscovery("prov-stale", ["a", "b"])).toBe(2);
    expect(await liveModelCountAfterDiscovery("prov-stale", "fail")).toBe(2);
  });
});

describe("combo catalog capability intersection", () => {

  test("imageInput disabled strips image even when every member supports it", () => {
    const visionMembers = [
      { provider: "a", id: "m1", contextWindow: 128_000, maxInputTokens: 100_000, inputModalities: ["text", "image"], reasoningEfforts: ["low"] },
      { provider: "b", id: "m2", contextWindow: 128_000, maxInputTokens: 100_000, inputModalities: ["text", "image"], reasoningEfforts: ["low"] },
    ];
    expect(deriveComboCatalogModel("text-only", normalizedCombo({ imageInput: "disabled" }), visionMembers))
      .toEqual(expect.objectContaining({ inputModalities: ["text"] }));
    expect(deriveComboCatalogModel("vision", normalizedCombo({ imageInput: "auto" }), visionMembers))
      .toEqual(expect.objectContaining({ inputModalities: expect.arrayContaining(["text", "image"]) }));
  });

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
      autoCompactTokenLimit: 100_000,
      inputModalities: ["text"],
      reasoningEfforts: ["low", "medium"],
      defaultReasoningEffort: "medium",
    });
  });

  test("never advertises combo max-input or compaction above its smallest final window", () => {
    const derived = deriveComboCatalogModel("bounded", normalizedCombo(), [
      { provider: "a", id: "m1", contextWindow: 700_000, maxInputTokens: 922_000 },
      { provider: "b", id: "m2", contextWindow: 800_000, maxInputTokens: 900_000 },
    ]);
    expect(derived).toMatchObject({
      contextWindow: 700_000,
      maxInputTokens: 700_000,
      autoCompactTokenLimit: 630_000,
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

  test("treats undefined effort ladders as wildcards and empty ladders as restrictive", () => {
    // One recovered target with no ladder must not zero the advertised intersection.
    expect(deriveComboCatalogModel("wildcard", normalizedCombo({ defaultEffort: "medium" }), [
      memberA,
      { ...memberB, reasoningEfforts: undefined },
    ])).toEqual(expect.objectContaining({
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    }));
    // Explicit empty ladder still constrains to nothing.
    const empty = deriveComboCatalogModel("empty", normalizedCombo({ defaultEffort: "medium" }), [
      memberA,
      { ...memberB, reasoningEfforts: [] },
    ]);
    expect(empty?.reasoningEfforts).toEqual([]);
    expect(empty).not.toHaveProperty("defaultReasoningEffort");
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

  test("omission diagnostics distinguish incomplete metadata from disjoint modalities (#516)", () => {
    const incompleteMembers = [memberA];
    expect(comboCatalogOmissionReason(normalizedCombo(), incompleteMembers)).toBe("incomplete_metadata");
    const incomplete = buildComboCatalogOmission("missing-meta", normalizedCombo(), incompleteMembers);
    expect(incomplete).toMatchObject({
      id: "missing-meta",
      reason: "incomplete_metadata",
    });
    expect(incomplete.message).toContain("member capabilities are incomplete");
    expect(incomplete.message).not.toContain("no common input modalities");

    const disjointMembers = [
      { ...memberA, inputModalities: ["image"] },
      { ...memberB, inputModalities: ["text"] },
    ];
    expect(comboCatalogOmissionReason(normalizedCombo(), disjointMembers)).toBe("incompatible_modalities");
    expect(deriveComboCatalogModel("disjoint", normalizedCombo(), disjointMembers)).toBeNull();
    const incompatible = buildComboCatalogOmission("disjoint", normalizedCombo(), disjointMembers);
    expect(incompatible).toMatchObject({
      id: "disjoint",
      reason: "incompatible_modalities",
      targets: ["a/m1", "b/m2"],
    });
    expect(incompatible.message).toContain("no common input modalities");
    expect(incompatible.message).not.toContain("member capabilities are incomplete");
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
      expect(row.tool_mode).toBe("code_mode_only");
      expect(row.web_search_tool_type).toBe("text_and_image");
      expect(row.supports_search_tool).toBe(true);
    }
  });

  test("provider allowlists do not remove a current slashed combo alias", () => {
    const row = (slug: string, ownedBy: string, sourceProvider = ownedBy) => ({
      ...nativeTemplate(),
      slug,
      owned_by: ownedBy,
      description: `Routed via opencodex → ${sourceProvider} (${ownedBy}).`,
      input_modalities: ["text"],
    });
    const merged = mergeObservedForTest({
      catalogModels: [row("vendor/persisted", "combo")],
      routedEntries: [
        row("vendor/flash", "combo"),
        row("vendor/allowed", "vendor"),
        row("vendor/blocked", "vendor"),
        row("vendor/spoofed", "combo", "vendor"),
        row("vendor/stale", "combo"),
      ],
      selectedModelsByProvider: new Map([["vendor", new Set(["allowed"])]]),
      gatheredProviderNames: new Set(["vendor"]),
      degradedProviderNames: new Set(["vendor"]),
      exactComboSlugs: new Set([
        "vendor/flash",
        "vendor/persisted",
        "vendor/spoofed",
      ]),
      hasPhysicalComboProvider: true,
    });

    expect(merged.map(entry => entry.slug)).toContain("vendor/flash");
    expect(merged.map(entry => entry.slug)).toContain("vendor/allowed");
    expect(merged.map(entry => entry.slug)).not.toContain("vendor/blocked");
    expect(merged.map(entry => entry.slug)).not.toContain("vendor/spoofed");
    expect(merged.map(entry => entry.slug)).not.toContain("vendor/persisted");
    expect(merged.map(entry => entry.slug)).not.toContain("vendor/stale");
  });

  test("an empty routed gather preserves a configured native-alias row from disk", () => {
    const alias = "gpt-5.6-sol";
    const exact = new Set([alias]);
    const model = deriveComboCatalogModel(
      "nova-sol",
      normalizedCombo({
        alias,
        nativeAlias: true,
        displayName: "Nova1 - Sol",
      }),
      [memberA, memberB],
    )!;
    const existing = buildCatalogEntries(
      nativeTemplate(),
      [alias],
      [model],
      undefined,
      false,
      "default",
      exact,
    ).find(entry => entry.slug === alias)!;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const merged = mergeCatalogEntriesForSync(
        [existing],
        [],
        new Map(),
        [],
        false,
        new Set(),
        nativeTemplate(),
        new Set(),
        new Set(["a", "b"]),
        "default",
        exact,
        false,
        true,
        [],
        new Set(),
        new Set([alias]),
      );

      expect(merged.filter(entry => entry.slug === alias)).toHaveLength(1);
      expect(merged.find(entry => entry.slug === alias)).toMatchObject({
        display_name: "Nova1 - Sol",
        owned_by: "combo",
        opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
      });
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
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

  test("restores a non-OpenAI catalog row after its shadowing combo alias is renamed or deleted", () => {
    const alias = "deepseek/deepseek-chat";
    const provider = { provider: "deepseek", id: "deepseek-chat", owned_by: "deepseek" };
    const comboFor = (publicAlias: string) => deriveComboCatalogModel(
      "mixed",
      normalizedCombo({ alias: publicAlias }),
      [memberA, memberB],
    )!;
    const rowsFor = (comboAlias?: string) => buildCatalogEntries(
      nativeTemplate(),
      [],
      comboAlias ? [provider, comboFor(comboAlias)] : [provider],
      undefined,
      false,
      "default",
      comboAlias ? new Set([comboAlias]) : new Set(),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const collided = rowsFor(alias);
      expect(collided.filter(row => row.slug === alias)).toHaveLength(1);
      expect(collided.find(row => row.slug === alias)?.owned_by).toBe("combo");
      expect(warn).toHaveBeenCalledTimes(1);

      const renamed = rowsFor("fast-chat");
      expect(renamed.find(row => row.slug === alias)).toMatchObject({
        slug: alias,
        description: expect.stringContaining("deepseek"),
      });
      expect(renamed.find(row => row.slug === alias)?.owned_by).not.toBe("combo");
      expect(renamed.find(row => row.slug === "fast-chat")?.owned_by).toBe("combo");

      const deleted = rowsFor();
      expect(deleted.filter(row => row.slug === alias)).toHaveLength(1);
      expect(deleted.find(row => row.slug === alias)).toMatchObject({
        slug: alias,
        description: expect.stringContaining("deepseek"),
      });
      expect(deleted.find(row => row.slug === alias)?.owned_by).not.toBe("combo");

      rowsFor(alias);
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

  test("an inadmissible combo alias cannot suppress an existing catalog row", () => {
    for (const [slug, owner] of [
      ["user-native", "user"],
      ["vendor/model", "user"],
      ["unowned/model", undefined],
    ] as const) {
      const existing = {
        ...nativeTemplate(),
        slug,
        display_name: "User catalog row",
        ...(owner === undefined ? {} : { owned_by: owner }),
      };
      const malformedCombo = {
        ...nativeTemplate(),
        slug,
        display_name: slug,
        owned_by: "combo",
        input_modalities: [],
      };
      const merged = mergeCatalogEntriesForSync(
        [existing], [malformedCombo], new Map(), [], false, new Set(), nativeTemplate(), new Set(),
        new Set(["combo"]), "default", new Set([slug]), false,
      );

      const surviving = merged.filter(entry => entry.slug === slug);
      expect(surviving).toEqual([expect.objectContaining({ display_name: "User catalog row" })]);
      if (slug.includes("/")) expect(surviving[0]?.input_modalities).toEqual(["text"]);
    }
  });

  test("a provider row sharing an omitted combo alias keeps ordinary routed normalization", () => {
    const entries = buildCatalogEntries(
      nativeTemplate(),
      [],
      [{ provider: "vendor", id: "model" }],
      undefined,
      false,
      "default",
      new Set(["vendor/model"]),
    );

    expect(entries.find(entry => entry.slug === "vendor/model")).toMatchObject({
      input_modalities: ["text"],
      supports_parallel_tool_calls: false,
    });
  });

  test("a removed bare combo alias restores the pristine row it shadowed", () => {
    const slug = "user-native";
    const pristine = {
      ...nativeTemplate(),
      slug,
      display_name: "User catalog row",
      owned_by: "user",
      user_marker: "pristine",
    };
    const combo = {
      ...nativeTemplate(),
      slug,
      display_name: slug,
      owned_by: "combo",
      input_modalities: ["text"],
    };
    const shadowed = mergeObservedForTest({
      catalogModels: [pristine],
      baselineCatalogModels: [pristine],
      routedEntries: [combo],
      gatheredProviderNames: new Set(["combo"]),
      exactComboSlugs: new Set([slug]),
    });
    expect(shadowed.filter(entry => entry.slug === slug)).toEqual([
      expect.objectContaining({ owned_by: "combo" }),
    ]);

    const restored = mergeObservedForTest({
      catalogModels: shadowed,
      baselineCatalogModels: [pristine],
      routedEntries: [],
    });
    expect(restored.filter(entry => entry.slug === slug)).toEqual([
      expect.objectContaining({
        display_name: "User catalog row",
        owned_by: "user",
        user_marker: "pristine",
      }),
    ]);
  });

  test("a removed slashed combo alias restores its pristine foreign row", () => {
    const slug = "vendor/model";
    const pristine = {
      ...nativeTemplate(),
      slug,
      display_name: "Foreign catalog row",
      foreign_marker: "pristine",
    };
    const combo = {
      ...nativeTemplate(),
      slug,
      owned_by: "combo",
      input_modalities: ["text"],
    };
    const shadowed = mergeObservedForTest({
      catalogModels: [pristine],
      baselineCatalogModels: [pristine],
      routedEntries: [combo],
      exactComboSlugs: new Set([slug]),
    });
    expect(shadowed.filter(entry => entry.slug === slug)).toEqual([
      expect.objectContaining({ owned_by: "combo" }),
    ]);

    const restored = mergeObservedForTest({
      catalogModels: shadowed,
      baselineCatalogModels: [pristine],
      routedEntries: [],
    });
    expect(restored.filter(entry => entry.slug === slug)).toEqual([
      expect.objectContaining({
        display_name: "Foreign catalog row",
        foreign_marker: "pristine",
      }),
    ]);
  });

  test("a combo cannot shadow an irreplaceable catalog row without a pristine restore point", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [slug, owner, gatheredProviders, degradedProviders] of [
        ["user-native-no-backup", "user", new Set(["target"]), new Set<string>()],
        ["vendor/model-no-backup", undefined, new Set(["target"]), new Set<string>()],
        ["offline/model-no-backup", undefined, new Set(["offline"]), new Set(["offline"])],
      ] as const) {
        const existing = {
          ...nativeTemplate(),
          slug,
          display_name: "Irreplaceable user catalog row",
          ...(owner === undefined ? {} : { owned_by: owner }),
        };
        const combo = {
          ...nativeTemplate(),
          slug,
          display_name: slug,
          owned_by: "combo",
          input_modalities: ["text"],
        };
        const merged = mergeObservedForTest({
          catalogModels: [existing],
          routedEntries: [combo],
          gatheredProviderNames: gatheredProviders,
          degradedProviderNames: degradedProviders,
          exactComboSlugs: new Set([slug]),
        });

        expect(merged.filter(entry => entry.slug === slug)).toEqual([
          expect.objectContaining({ display_name: "Irreplaceable user catalog row" }),
        ]);
      }
      expect(warn.mock.calls.filter(call => String(call[0]).includes("no pristine backup")))
        .toHaveLength(3);
    } finally {
      warn.mockRestore();
    }
  });

  test("the legacy merge wrapper does not infer provider authority from a slashed combo alias", () => {
    const slug = "vendor/model-without-backup";
    const existing = {
      ...nativeTemplate(),
      slug,
      display_name: "Foreign catalog row",
      user_marker: "keep",
    };
    const combo = {
      ...nativeTemplate(),
      slug,
      display_name: slug,
      owned_by: "combo",
      input_modalities: ["text"],
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const shadowAttempt = mergeCatalogEntriesForSync(
        [existing], [combo], new Map(), [], false, new Set(), nativeTemplate(), new Set(),
        undefined, "default", new Set([slug]), false,
      );
      expect(shadowAttempt.filter(entry => entry.slug === slug)).toEqual([
        expect.objectContaining({
          display_name: "Foreign catalog row",
          user_marker: "keep",
        }),
      ]);
      expect(shadowAttempt.find(entry => entry.slug === slug)?.owned_by).not.toBe("combo");

      const afterRemoval = mergeCatalogEntriesForSync(
        shadowAttempt, [], new Map(), [], false,
      );
      expect(afterRemoval.filter(entry => entry.slug === slug)).toEqual([
        expect.objectContaining({
          display_name: "Foreign catalog row",
          user_marker: "keep",
        }),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("an authoritative configured namespace remains replaceable by a combo alias", () => {
    const slug = "vendor/authoritative-model";
    const existing = {
      ...nativeTemplate(),
      slug,
      display_name: "Old foreign-shaped row",
    };
    const combo = {
      ...nativeTemplate(),
      slug,
      owned_by: "combo",
      input_modalities: ["text"],
    };
    const merged = mergeObservedForTest({
      catalogModels: [existing],
      routedEntries: [combo],
      gatheredProviderNames: new Set(["vendor"]),
      exactComboSlugs: new Set([slug]),
    });

    expect(merged.filter(entry => entry.slug === slug)).toEqual([
      expect.objectContaining({ owned_by: "combo" }),
    ]);
  });

  test("generated provider and custom rows do not masquerade as irreplaceable combo shadows", () => {
    const slug = "managed/model";
    const combo = {
      ...nativeTemplate(),
      slug,
      owned_by: "combo",
      input_modalities: ["text"],
    };
    for (const generated of [
      {
        ...nativeTemplate(),
        slug,
        description: "Routed via opencodex → managed/model (managed).",
      },
      {
        ...nativeTemplate(),
        slug,
        opencodex_catalog_kind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
      },
    ]) {
      const merged = mergeObservedForTest({
        catalogModels: [generated],
        routedEntries: [combo],
        gatheredProviderNames: new Set(["managed"]),
        exactComboSlugs: new Set([slug]),
      });

      expect(merged.filter(entry => entry.slug === slug)).toEqual([
        expect.objectContaining({ owned_by: "combo" }),
      ]);
    }
  });

  test("a fresh account row wins without a false unrestorable-shadow warning", () => {
    const slug = "team/gpt-5.5";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const account = {
        ...nativeTemplate(),
        slug,
        opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      };
      const combo = {
        ...nativeTemplate(),
        slug,
        owned_by: "combo",
        input_modalities: ["text"],
      };
      const merged = mergeObservedForTest({
        catalogModels: [{ ...nativeTemplate(), slug, display_name: "Old foreign row" }],
        routedEntries: [combo],
        exactComboSlugs: new Set([slug]),
        accountBoundEntries: [account],
      });

      expect(merged.filter(entry => entry.slug === slug)).toEqual([
        expect.objectContaining({ opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND }),
      ]);
      expect(warn.mock.calls.some(call => String(call[0]).includes("no pristine backup"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("unrestorable-shadow warnings dedupe equivalent slugs, reset, and stay caller-owned", () => {
    resetCatalogRuntimeStateForTests();
    const rawSlug = "foreign/org/model";
    const encodedSlug = "foreign/org-model";
    const existing = { ...nativeTemplate(), slug: rawSlug, display_name: "Foreign row" };
    const combo = {
      ...nativeTemplate(),
      slug: encodedSlug,
      owned_by: "combo",
      input_modalities: ["text"],
    };
    const input = {
      catalogModels: [existing],
      routedEntries: [combo],
      exactComboSlugs: new Set([encodedSlug]),
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      mergeObservedForTest({
        ...input,
        policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, warningPolicy: "suppress" },
      });
      expect(warn).not.toHaveBeenCalled();

      mergeObservedForTest(input);
      mergeObservedForTest({
        ...input,
        catalogModels: [{ ...existing, slug: encodedSlug }],
      });
      expect(warn.mock.calls.filter(call => String(call[0]).includes("no pristine backup")))
        .toHaveLength(1);

      resetCatalogRuntimeStateForTests();
      mergeObservedForTest(input);
      expect(warn.mock.calls.filter(call => String(call[0]).includes("no pristine backup")))
        .toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("uses config identity for physical preservation and stale virtual cleanup", () => {
    const physical = {
      slug: "combo/model",
      supported_reasoning_levels: [{ effort: "low" }],
      input_modalities: ["text"],
    };
    const preserved = mergeObservedForTest({
      catalogModels: [physical],
      routedEntries: [],
      template: null,
      gatheredProviderNames: new Set(["combo"]),
      degradedProviderNames: new Set(["combo"]),
      hasPhysicalComboProvider: true,
    }).find(entry => entry.slug === "combo/model");
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
        a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", liveModels: false, models: ["m1"], modelContextWindows: { m1: 200_000 }, modelAutoCompactTokenLimits: { m1: 150_000 } },
        b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", liveModels: false, models: ["m2"], modelContextWindows: { m2: 128_000 }, modelAutoCompactTokenLimits: { m2: 80_000 } },
      },
      combos: {
        mixed: { targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] },
        // Unknown provider (not just unlisted model) — synthesis cannot invent a member,
        // and the secret in the model id must still be redacted in the omission warning.
        hidden: { targets: [{ provider: warningSentinel, model: "m1" }] },
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
      expect(first.find(model => model.provider === "combo" && model.id === "mixed"))
        .toMatchObject({ contextWindow: 128_000, maxInputTokens: 128_000, autoCompactTokenLimit: 80_000 });
      expect(buildCatalogEntries(nativeTemplate(), [], first)
        .find(entry => entry.slug === "combo/mixed")).toMatchObject({
        context_window: 128_000,
        max_context_window: 128_000,
        auto_compact_token_limit: 80_000,
      });
      expect(filterCatalogVisibleModels(first, config).some(model => model.id === "mixed")).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("[REDACTED]");
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(warningSentinel);
      expect(second).toEqual(first);
      const { getLastComboCatalogOmissions } = await import("../src/codex/catalog");
      const hidden = getLastComboCatalogOmissions().find(item => item.id === "hidden");
      expect(hidden).toMatchObject({
        id: "hidden",
        reason: "incomplete_metadata",
      });
      expect(hidden?.message).toContain("member capabilities are incomplete");
      expect(hidden?.message).toContain("[REDACTED]");

      resetCatalogRuntimeStateForTests();
      await gatherRoutedModels(config);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  }, 15_000);

  test("gather warns about disjoint modalities without calling them incomplete (#516)", async () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "a",
      providers: {
        a: {
          adapter: "openai-chat",
          baseUrl: "https://a.example/v1",
          liveModels: false,
          models: ["m1"],
          modelContextWindows: { m1: 200_000 },
          modelInputModalities: { m1: ["image"] },
        },
        b: {
          adapter: "openai-chat",
          baseUrl: "https://b.example/v1",
          liveModels: false,
          models: ["m2"],
          modelContextWindows: { m2: 128_000 },
          modelInputModalities: { m2: ["text"] },
        },
      },
      combos: {
        disjoint: { targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] },
      },
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      resetCatalogRuntimeStateForTests();
      const models = await gatherRoutedModels(config);
      expect(models.some(model => model.provider === "combo" && model.id === "disjoint")).toBe(false);
      const { getLastComboCatalogOmissions } = await import("../src/codex/catalog");
      const omission = getLastComboCatalogOmissions().find(item => item.id === "disjoint");
      expect(omission).toMatchObject({
        id: "disjoint",
        reason: "incompatible_modalities",
      });
      expect(omission?.message).toContain("no common input modalities");
      expect(omission?.message).not.toContain("member capabilities are incomplete");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("no common input modalities");
      expect(String(warn.mock.calls[0]?.[0])).not.toContain("member capabilities are incomplete");
    } finally {
      warn.mockRestore();
    }
  }, 15_000);

  test("native aliases use native capability fallbacks when discovery returns only an id", async () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "Nova1",
      providers: {
        Nova1: {
          adapter: "openai-chat",
          baseUrl: "https://nova.example/v1",
          liveModels: false,
          models: ["codex/gpt-5.6-sol", "codex/gpt-5.4-mini"],
        },
      },
      combos: {
        "nova-sol": {
          alias: "gpt-5.6-sol",
          nativeAlias: true,
          displayName: "Nova1 - codex-gpt-5.6-sol",
          targets: [{ provider: "Nova1", model: "codex/gpt-5.6-sol" }],
        },
        "nova-mini": {
          alias: "gpt-5.4-mini",
          nativeAlias: true,
          displayName: "Nova1 - codex-gpt-5.4-mini",
          targets: [{ provider: "Nova1", model: "codex/gpt-5.4-mini" }],
        },
      },
    };

    const rows = await gatherRoutedModels(config);
    expect(rows.find(row => row.provider === "combo" && row.id === "nova-sol")).toMatchObject({
      alias: "gpt-5.6-sol",
      nativeAlias: true,
      contextWindow: 272_000,
      maxInputTokens: 272_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "low",
    });
    expect(rows.find(row => row.provider === "combo" && row.id === "nova-mini")).toMatchObject({
      alias: "gpt-5.4-mini",
      nativeAlias: true,
      contextWindow: 272_000,
      maxInputTokens: 272_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
    });
  });

  test("a bare native disable does not starve a combo targeting that native model", async () => {
    const alias = "gpt-5.6-sol";
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
          liveModels: false,
          models: [],
        },
      },
      disabledModels: [alias],
      combos: {
        native: {
          alias,
          nativeAlias: true,
          displayName: "Native fallback",
          targets: [{ provider: "openai", model: alias }],
        },
      },
    };
    const rows = await gatherRoutedModels(config);
    expect(rows.find(row => row.provider === "combo" && row.id === "native")).toMatchObject({
      alias,
      nativeAlias: true,
    });
  });

  test("native aliases preserve explicit target capability limits", async () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "Nova1",
      providerContextCaps: { Nova1: 350_000 },
      providers: {
        Nova1: {
          adapter: "openai-chat",
          baseUrl: "https://nova.example/v1",
          liveModels: false,
          models: ["codex/gpt-5.6-sol"],
          modelContextWindows: { "codex/gpt-5.6-sol": 128_000 },
          modelMaxInputTokens: { "codex/gpt-5.6-sol": 100_000 },
          modelInputModalities: { "codex/gpt-5.6-sol": ["text"] },
          modelReasoningEfforts: { "codex/gpt-5.6-sol": ["high"] },
        },
      },
      combos: {
        "nova-sol": {
          alias: "gpt-5.6-sol",
          nativeAlias: true,
          displayName: "Nova1 - codex-gpt-5.6-sol",
          targets: [{ provider: "Nova1", model: "codex/gpt-5.6-sol" }],
        },
      },
    };

    const rows = await gatherRoutedModels(config);
    expect(rows.find(row => row.provider === "combo" && row.id === "nova-sol")).toMatchObject({
      contextWindow: 128_000,
      contextCapped: false,
      maxInputTokens: 100_000,
      inputModalities: ["text"],
      reasoningEfforts: ["high"],
    });
    expect(rows.find(row => row.provider === "combo" && row.id === "nova-sol"))
      .not.toHaveProperty("defaultReasoningEffort");
  });

  test("native aliases apply provider caps to explicit target windows", async () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "Nova1",
      providerContextCaps: { Nova1: 350_000 },
      providers: {
        Nova1: {
          adapter: "openai-chat",
          baseUrl: "https://nova.example/v1",
          liveModels: false,
          models: ["codex/gpt-5.6-sol"],
          modelContextWindows: { "codex/gpt-5.6-sol": 400_000 },
        },
      },
      combos: {
        "nova-sol": {
          alias: "gpt-5.6-sol",
          nativeAlias: true,
          displayName: "Nova1 - codex-gpt-5.6-sol",
          targets: [{ provider: "Nova1", model: "codex/gpt-5.6-sol" }],
        },
      },
    };

    const rows = await gatherRoutedModels(config);
    expect(rows.find(row => row.provider === "combo" && row.id === "nova-sol")).toMatchObject({
      contextWindow: 350_000,
      maxInputTokens: 350_000,
      contextCapped: true,
    });
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

  test("issue #268: combos with a native OpenAI (Codex-login) target are catalogued", async () => {
    // The "openai" provider uses forward-auth (Codex login passthrough) — fetchProviderModels
    // returns [] for it, so native slugs only surface through nativeOpenAiSlugs(). Before the
    // fix, memberByKey never contained openai/<slug>, so combos with a native-openai target were
    // silently dropped from the catalog. Sol is account-gated now, so the combo's native member
    // needs a confirmed roster to be visible at all.
    seedCodexModelEntitlementsForTests("main", ["gpt-5.6-sol"]);
    globalThis.fetch = (() => { throw new Error("forward providers must not fetch /models"); }) as typeof fetch;
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
        openrouter: {
          adapter: "openai-chat",
          baseUrl: "https://openrouter.ai/v1",
          liveModels: false,
          models: ["openai/gpt-5.6-sol"],
          modelContextWindows: { "openai/gpt-5.6-sol": 372_000 },
          modelInputModalities: { "openai/gpt-5.6-sol": ["text", "image"] },
          modelReasoningEfforts: { "openai/gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"] },
        },
      },
      combos: {
        auto: {
          strategy: "failover",
          targets: [
            { provider: "openai", model: "gpt-5.6-sol" },
            { provider: "openrouter", model: "openai/gpt-5.6-sol" },
          ],
        },
      },
    };
    const rows = await gatherRoutedModels(config);
    const comboRow = rows.find(r => r.provider === "combo" && r.id === "auto");
    expect(comboRow).toBeDefined();
    expect(comboRow!.contextWindow).toBe(272_000);
    expect(comboRow!.inputModalities).toEqual(["text", "image"]);
    // Reasoning efforts should be the intersection of the two members.
    expect(comboRow!.reasoningEfforts).toContain("low");
    expect(comboRow!.reasoningEfforts).toContain("max");
  });

  test("issue #268: native OpenAI members do not appear as standalone routed rows", async () => {
    // The synthetic entries are injected into memberByKey for combo resolution only —
    // they must NOT leak into the returned all[] array (they are already emitted via the
    // native catalog / /v1/models path).
    globalThis.fetch = (() => { throw new Error("forward providers must not fetch /models"); }) as typeof fetch;
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      combos: {
        solo: {
          strategy: "failover",
          targets: [{ provider: "openai", model: "gpt-5.6-sol" }],
        },
      },
    };
    const rows = await gatherRoutedModels(config);
    // Only the combo row should exist — no openai/gpt-5.6-sol routed row.
    const openaiRows = rows.filter(r => r.provider === "openai");
    expect(openaiRows).toEqual([]);
    expect(rows.some(r => r.provider === "combo" && r.id === "solo")).toBe(true);
  });

  test("synthesizes missing combo targets from provider config metadata", async () => {
    // Target model is not in models[] (so never lands in memberByKey) but provider
    // config carries context/modalities/efforts — combo derivation must still catalog.
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "a",
      providers: {
        a: {
          adapter: "openai-chat",
          baseUrl: "https://a.example/v1",
          liveModels: false,
          models: ["listed"],
          modelContextWindows: { listed: 200_000, unlisted: 128_000 },
          modelInputModalities: { unlisted: ["text"] },
          modelReasoningEfforts: { unlisted: ["low", "medium", "high"] },
        },
        b: {
          adapter: "openai-chat",
          baseUrl: "https://b.example/v1",
          liveModels: false,
          models: ["m2"],
          modelContextWindows: { m2: 100_000 },
          modelReasoningEfforts: { m2: ["low", "medium"] },
        },
      },
      combos: {
        recovered: {
          targets: [
            { provider: "a", model: "unlisted" },
            { provider: "b", model: "m2" },
          ],
        },
      },
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      resetCatalogRuntimeStateForTests();
      const rows = await gatherRoutedModels(config);
      const combo = rows.find(r => r.provider === "combo" && r.id === "recovered");
      expect(combo).toBeDefined();
      expect(combo!.contextWindow).toBe(100_000);
      expect(combo!.inputModalities).toEqual(["text"]);
      expect(combo!.reasoningEfforts).toEqual(["low", "medium"]);
      // Synthesized member must not leak as a standalone routed row.
      expect(rows.some(r => r.provider === "a" && r.id === "unlisted")).toBe(false);
      const { getLastComboCatalogOmissions } = await import("../src/codex/catalog");
      expect(getLastComboCatalogOmissions().some(item => item.id === "recovered")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  }, 15_000);

  test("resolveComboCatalogMember fills incomplete members from provider config", () => {
    // Member is present but lacks contextWindow; provider.contextWindow + efforts complete it.
    const incomplete = {
      provider: "a",
      id: "m1",
      // no contextWindow — the incomplete_metadata trigger
    };
    const memberByKey = new Map([["a/m1", incomplete]]);
    const providers = new Map([
      ["a", {
        adapter: "openai-chat" as const,
        baseUrl: "https://a.example/v1",
        contextWindow: 200_000,
        modelReasoningEfforts: { m1: ["low", "medium", "high"] },
      }],
    ]);
    const resolved = resolveComboCatalogMember(
      { provider: "a", model: "m1" },
      memberByKey,
      providers,
    );
    expect(resolved).toMatchObject({
      provider: "a",
      id: "m1",
      contextWindow: 200_000,
      maxInputTokens: 200_000,
      inputModalities: ["text"],
      reasoningEfforts: ["low", "medium", "high"],
    });
    // Complete members are returned as-is without re-synthesis side effects.
    const complete = {
      provider: "a",
      id: "m1",
      contextWindow: 99_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["high"],
    };
    expect(resolveComboCatalogMember(
      { provider: "a", model: "m1" },
      new Map([["a/m1", complete]]),
      providers,
    )).toBe(complete);
    // Complete members still honor an operator-configured context cap.
    expect(resolveComboCatalogMember(
      { provider: "a", model: "m1" },
      new Map([["a/m1", complete]]),
      providers,
      50_000,
    )).toMatchObject({
      contextWindow: 50_000,
      maxInputTokens: 50_000,
      contextCap: 50_000,
      contextCapped: true,
    });
    // Disabled providers never contribute — even with a complete discovery row.
    expect(resolveComboCatalogMember(
      { provider: "a", model: "m1" },
      new Map([["a/m1", complete]]),
      new Map([["a", { adapter: "openai-chat", baseUrl: "https://a.example/v1", disabled: true }]]),
    )).toBeUndefined();
    // Thin live rows with max_input_tokens but no contextWindow prefer that limit
    // over inventing the 128k fallback.
    expect(resolveComboCatalogMember(
      { provider: "a", model: "thin" },
      new Map([["a/thin", { provider: "a", id: "thin", maxInputTokens: 8_192 }]]),
      new Map([["a", { adapter: "openai-chat", baseUrl: "https://a.example/v1" }]]),
    )).toMatchObject({
      contextWindow: 8_192,
      maxInputTokens: 8_192,
    });
    // Known provider without context metadata still gets the conservative fallback.
    expect(resolveComboCatalogMember(
      { provider: "a", model: "ghost" },
      new Map(),
      new Map([["a", { adapter: "openai-chat", baseUrl: "https://a.example/v1" }]]),
    )).toMatchObject({
      provider: "a",
      id: "ghost",
      contextWindow: 128_000,
      maxInputTokens: 128_000,
      inputModalities: ["text"],
    });
    // Provider contextCap below the 128k fallback fills the unknown window.
    expect(resolveComboCatalogMember(
      { provider: "a", model: "ghost" },
      new Map(),
      new Map([["a", { adapter: "openai-chat", baseUrl: "https://a.example/v1" }]]),
      64_000,
    )).toMatchObject({
      provider: "a",
      id: "ghost",
      contextWindow: 64_000,
      maxInputTokens: 64_000,
      contextCap: 64_000,
    });
    // Cap above the empty discovery window fills that window. This is not a clamp.
    const aboveCap = resolveComboCatalogMember(
      { provider: "a", model: "ghost" },
      new Map(),
      new Map([["a", { adapter: "openai-chat", baseUrl: "https://a.example/v1" }]]),
      200_000,
    );
    expect(aboveCap).toMatchObject({
      contextWindow: 200_000,
      maxInputTokens: 200_000,
      contextCap: 200_000,
    });
    expect(aboveCap?.contextCapped).toBeFalsy();
    // No provider entry and no discovery row — cannot invent a member.
    expect(resolveComboCatalogMember(
      { provider: "missing", model: "ghost" },
      new Map(),
      new Map(),
    )).toBeUndefined();
  });

  test("still omits combos when synthesis cannot recover hard failures", async () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "a",
      providers: {
        a: {
          adapter: "openai-chat",
          baseUrl: "https://a.example/v1",
          liveModels: false,
          models: ["m1"],
          modelContextWindows: { m1: 128_000 },
          // Disjoint modalities with b → empty intersection (incompatible_modalities).
          modelInputModalities: { m1: ["image"] },
        },
        b: {
          adapter: "openai-chat",
          baseUrl: "https://b.example/v1",
          liveModels: false,
          models: ["m2"],
          modelContextWindows: { m2: 128_000 },
          modelInputModalities: { m2: ["audio"] },
        },
      },
      combos: {
        disjoint: {
          targets: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
          ],
        },
        ghost: {
          // Provider does not exist — synthesis cannot invent a member.
          targets: [{ provider: "missing-provider", model: "never-configured" }],
        },
      },
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      resetCatalogRuntimeStateForTests();
      const rows = await gatherRoutedModels(config);
      expect(rows.some(r => r.provider === "combo" && r.id === "disjoint")).toBe(false);
      expect(rows.some(r => r.provider === "combo" && r.id === "ghost")).toBe(false);
      const { getLastComboCatalogOmissions } = await import("../src/codex/catalog");
      const omissions = getLastComboCatalogOmissions();
      expect(omissions.find(item => item.id === "disjoint")).toMatchObject({
        reason: "incompatible_modalities",
      });
      expect(omissions.find(item => item.id === "ghost")).toMatchObject({
        reason: "incomplete_metadata",
      });
    } finally {
      warn.mockRestore();
    }
  }, 15_000);

  test("retains configured combo targets when authoritative live discovery omits them (OCX-111)", async () => {
    // Repro from #1308 / OCX-111: live /models returns a different roster than the
    // configured combo targets. Ids listed in providers.*.models are retained when
    // they are combo targets. Combo-only ids (not in models[]) still catalog the
    // combo via synthesis without leaking a standalone provider row (#1305).
    // Use non-registry provider names so enrichProviderFromRegistry cannot seed models[].
    clearModelCache("or-test");
    clearModelCache("go-test");
    clearModelCache("cc-test");
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const id = url.includes("or-test")
        ? "openrouter/other-model"
        : url.includes("go-test")
          ? "other-flash"
          : "other-pro";
      return new Response(JSON.stringify({ data: [{ id, owned_by: "provider" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      resetCatalogRuntimeStateForTests();
      const rows = await gatherRoutedModels({
        port: 10100,
        defaultProvider: "or-test",
        providers: {
          "or-test": {
            adapter: "openai-chat",
            baseUrl: "https://or-test.example.test/v1",
            authMode: "key",
            apiKey: "sk-test",
            liveModels: true,
            models: ["openai/gpt-5.6-luna"],
            modelContextWindows: { "openai/gpt-5.6-luna": 200_000 },
          },
          "go-test": {
            adapter: "openai-chat",
            baseUrl: "https://go-test.example.test/v1",
            authMode: "key",
            apiKey: "sk-test",
            liveModels: true,
            // Combo-only target: not listed in providers.*.models — synthesis only.
            models: [],
            modelContextWindows: { "deepseek-v4-flash": 128_000 },
          },
          "cc-test": {
            adapter: "openai-chat",
            baseUrl: "https://cc-test.example.test/v1",
            authMode: "key",
            apiKey: "sk-test",
            liveModels: true,
            models: ["xiaomi/mimo-v2.5-pro"],
            modelContextWindows: { "xiaomi/mimo-v2.5-pro": 160_000 },
          },
        },
        combos: {
          failover: {
            strategy: "failover",
            targets: [
              { provider: "or-test", model: "openai/gpt-5.6-luna", weight: 1 },
              { provider: "go-test", model: "deepseek-v4-flash", weight: 1 },
              { provider: "cc-test", model: "xiaomi/mimo-v2.5-pro", weight: 1 },
            ],
          },
        },
      });

      const combo = rows.find(r => r.provider === "combo" && r.id === "failover");
      expect(combo).toBeDefined();
      expect(combo!.contextWindow).toBe(128_000);
      expect(rows.some(r => r.provider === "or-test" && r.id === "openai/gpt-5.6-luna")).toBe(true);
      expect(rows.some(r => r.provider === "cc-test" && r.id === "xiaomi/mimo-v2.5-pro")).toBe(true);
      // Combo-only member must not leak as a standalone routed row.
      expect(rows.some(r => r.provider === "go-test" && r.id === "deepseek-v4-flash")).toBe(false);
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).not.toContain("member capabilities are incomplete");
      expect(warningText).not.toContain("omitted configured model ids");
      const { getLastComboCatalogOmissions } = await import("../src/codex/catalog");
      expect(getLastComboCatalogOmissions().some(item => item.id === "failover")).toBe(false);
    } finally {
      warning.mockRestore();
      globalThis.fetch = originalFetch;
      clearModelCache("or-test");
      clearModelCache("go-test");
      clearModelCache("cc-test");
    }
  }, 15_000);

  test("warm cache still retains configured combo targets added inside the TTL (OCX-111)", async () => {
    // Owner / CodeRabbit blocker: retention must apply on fresh-cache reads, not only
    // after a live /models response. Warm the provider cache without a combo, then
    // gather again with a combo before TTL expiry — the configured target must return.
    clearModelCache("or-warm");
    clearModelCache("go-warm");
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let fetchCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCount += 1;
      const url = String(input);
      const id = url.includes("or-warm") ? "or-warm/other-model" : "go-warm/other";
      return new Response(JSON.stringify({ data: [{ id, owned_by: "provider" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const baseProviders = {
      "or-warm": {
        adapter: "openai-chat" as const,
        baseUrl: "https://or-warm.example.test/v1",
        authMode: "key" as const,
        apiKey: "sk-test",
        liveModels: true as const,
        models: ["openai/gpt-5.6-luna"],
        modelContextWindows: { "openai/gpt-5.6-luna": 200_000 },
      },
      "go-warm": {
        adapter: "openai-chat" as const,
        baseUrl: "https://go-warm.example.test/v1",
        authMode: "key" as const,
        apiKey: "sk-test",
        liveModels: false as const,
        models: ["deepseek-v4-flash"],
        modelContextWindows: { "deepseek-v4-flash": 128_000 },
      },
    };
    try {
      resetCatalogRuntimeStateForTests();
      const withoutCombo = await gatherRoutedModels({
        port: 10100,
        defaultProvider: "or-warm",
        modelCacheTtlMs: 60_000,
        providers: baseProviders,
      });
      expect(fetchCount).toBe(1);
      expect(withoutCombo.some(r => r.provider === "or-warm" && r.id === "openai/gpt-5.6-luna")).toBe(false);
      expect(withoutCombo.some(r => r.provider === "or-warm" && r.id === "or-warm/other-model")).toBe(true);

      const withCombo = await gatherRoutedModels({
        port: 10100,
        defaultProvider: "or-warm",
        modelCacheTtlMs: 60_000,
        providers: baseProviders,
        combos: {
          failover: {
            strategy: "failover",
            targets: [
              { provider: "or-warm", model: "openai/gpt-5.6-luna", weight: 1 },
              { provider: "go-warm", model: "deepseek-v4-flash", weight: 1 },
            ],
          },
        },
      });
      expect(fetchCount).toBe(1);
      expect(withCombo.some(r => r.provider === "or-warm" && r.id === "openai/gpt-5.6-luna")).toBe(true);
      expect(withCombo.some(r => r.provider === "combo" && r.id === "failover")).toBe(true);
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).not.toContain("member capabilities are incomplete");
    } finally {
      warning.mockRestore();
      globalThis.fetch = originalFetch;
      clearModelCache("or-warm");
      clearModelCache("go-warm");
    }
  }, 15_000);
});

describe("Google Gemini catalog metadata", () => {
  test("normalizes Gemini 3.6 Flash to the repository-standard Codex reasoning ladder", async () => {
    const google = {
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      authMode: "key" as const,
      liveModels: false,
    };
    enrichProviderFromRegistry("google", google);
    const models = await gatherRoutedModels({
      port: 0,
      defaultProvider: "google",
      providers: { google },
    });
    const entry = buildCatalogEntries(nativeTemplate(), [], models)
      .find(row => row.slug === "google/gemini-3.6-flash");

    // The registry ladder declares minimal for Gemini 3.6 Flash; it now flows through
    // (previously sanitize silently dropped it) plus the mock top rungs for subagent spawns.
    expect((entry?.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["minimal", "low", "medium", "high", "max", "ultra"]);
    expect(entry?.input_modalities).toEqual(["text", "image"]);
    expect(entry?.context_window).toBe(1_048_576);
  });
});

describe("Cursor Kimi K3 catalog default effort", () => {
  // Regression for the effort-tier ladder added with cursor/kimi-k3: the Cursor ladder is
  // low/high/max with NO medium rung, so applyReasoningLevels' medium -> high -> first
  // preference would settle default_reasoning_level on "high" unless the registry supplies a
  // default. Kimi documents `max` as K3's API default, and a "high" default makes the picker
  // send high explicitly so the request builder never falls back to kimi-k3-max.
  test("keeps max as the catalog default instead of falling back to high", async () => {
    const cursor = {
      adapter: "cursor",
      authMode: "oauth" as const,
      liveModels: false,
    };
    enrichProviderFromRegistry("cursor", cursor);
    const models = await gatherRoutedModels({
      port: 0,
      defaultProvider: "cursor",
      providers: { cursor },
    });
    const entry = buildCatalogEntries(nativeTemplate(), [], models)
      .find(row => row.slug === "cursor/kimi-k3");

    expect(entry).toBeDefined();
    expect((entry?.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["low", "high", "max", "ultra"]);
    expect(entry?.default_reasoning_level).toBe("max");
  });
});

describe("configured CatalogModel displayName -> catalog display_name", () => {
  test("a routed CatalogModel displayName becomes the catalog display_name", () => {
    const model = { provider: "deepseek", id: "deepseek-v4", displayName: "DeepSeek V4", owned_by: "deepseek" };
    const entries = buildCatalogEntries(nativeTemplate(), [], [model]);
    const row = entries.find(e => e.slug === "deepseek/deepseek-v4");

    expect(row?.display_name).toBe("DeepSeek V4");
    // Routing slug is untouched — displayName is display-only.
    expect(row?.slug).toBe("deepseek/deepseek-v4");
    expect(catalogModelSlug(model)).toBe("deepseek/deepseek-v4");
  });

  test("absent displayName leaves display_name as the slug (unchanged behavior)", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "anthropic", id: "claude-sonnet-4-6", owned_by: "anthropic" },
    ]);
    const row = entries.find(e => e.slug === "anthropic/claude-sonnet-4-6");

    expect(row?.display_name).toBe("anthropic/claude-sonnet-4-6");
    expect(row?.slug).toBe("anthropic/claude-sonnet-4-6");
  });

  test("Command Code routed models relabel the picker row with distinguishable slugs", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "command-code", id: "deepseek/deepseek-v4-flash", owned_by: "command-code" },
      { provider: "commandcode", id: "deepseek/deepseek-v4-pro", owned_by: "commandcode" },
    ]);
    const auth = entries.find(e => e.slug === "command-code/deepseek-deepseek-v4-flash");
    const api = entries.find(e => e.slug === "commandcode/deepseek-deepseek-v4-pro");

    // Display-only relabel + redundant vendor-prefix drop: routing slugs stay untouched.
    expect(auth?.display_name).toBe("commandcode-auth/deepseek-v4-flash");
    expect(auth?.slug).toBe("command-code/deepseek-deepseek-v4-flash");
    expect(api?.display_name).toBe("commandcode-api/deepseek-v4-pro");
    expect(api?.slug).toBe("commandcode/deepseek-deepseek-v4-pro");
  });

  test("empty/whitespace displayName is ignored and falls back to the slug", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "deepseek", id: "deepseek-v4", displayName: "   ", owned_by: "deepseek" },
    ]);
    const row = entries.find(e => e.slug === "deepseek/deepseek-v4");
    expect(row?.display_name).toBe("deepseek/deepseek-v4");
  });

  test("displayName never affects the routing slug, alias, or provider", () => {
    const withAlias = { provider: "combo", id: "x", alias: "fast-chat", displayName: "Fast Chat", owned_by: "combo" };
    const entries = buildCatalogEntries(nativeTemplate(), [], [withAlias], undefined, false, "default", new Set(["fast-chat"]));
    const row = entries.find(e => e.slug === "fast-chat")!;

    // The public alias is still the slug; only the label changed.
    expect(row.slug).toBe("fast-chat");
    expect(catalogModelSlug(withAlias)).toBe("fast-chat");
    expect(row.display_name).toBe("Fast Chat");
    expect(row.owned_by).toBe("combo");
  });

  test("displayName stays stable across repeated catalog sync (idempotent regeneration)", () => {
    const model = { provider: "deepseek", id: "deepseek-v4", displayName: "DeepSeek V4", owned_by: "deepseek" };
    const rebuild = () => buildCatalogEntries(nativeTemplate(), [], [model]);

    // First sync: freshly built entries merged into an empty on-disk catalog.
    const firstSync = mergeCatalogEntriesForSync([], rebuild(), new Map(), [], false);
    const firstRow = firstSync.find(e => e.slug === "deepseek/deepseek-v4")!;
    expect(firstRow.display_name).toBe("DeepSeek V4");

    // Second sync: re-derive from the SAME config and merge against the now-populated catalog.
    // Routed entries are rebuilt from gatherRoutedModels each sync, so display_name must be
    // re-derived deterministically and never drift back to the bare slug.
    const secondSync = mergeCatalogEntriesForSync(firstSync, rebuild(), new Map(), [], false);
    const secondRow = secondSync.find(e => e.slug === "deepseek/deepseek-v4")!;
    expect(secondRow.display_name).toBe("DeepSeek V4");
    expect(secondRow.slug).toBe("deepseek/deepseek-v4");
  });

  test("configured displayName does not override genuine native upstream marketing names", () => {
    // Native gpt-5.6-* entries come from the pinned upstream snapshot with their real display
    // names; they carry no CatalogModel (isRouted=false), so a configured displayName can never
    // reach them — and the fallback-quality discriminator (display_name === slug) still works.
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.6-sol"], []);
    const sol = entries.find(e => e.slug === "gpt-5.6-sol");
    expect(sol?.display_name).toBe("GPT-5.6-Sol");

    // A fallback-quality native (display_name stamped with the bare slug) is still upgraded to
    // the upstream entry by sync — displayName on routed models does not interfere with that path.
    const synthesizedLuna = {
      ...nativeTemplate(),
      slug: "gpt-5.6-luna",
      display_name: "gpt-5.6-luna",
      priority: 9,
    };
    const merged = mergeCatalogEntriesForSync([synthesizedLuna], [], new Map(), [], false);
    expect(merged.find(e => e.slug === "gpt-5.6-luna")?.display_name).toBe("GPT-5.6-Luna");
  });

  test("a configured customModel displayName propagates end-to-end through gatherRoutedModels", async () => {
    clearModelCache("custom-provider");
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("fetch should not be called");
    }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        port: 10100,
        defaultProvider: "custom-provider",
        providers: {
          "custom-provider": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["baseline-model"],
          },
        },
        customModels: [
          { id: "cm-1", provider: "custom-provider", modelId: "renamed-model", displayName: "Renamed Model", addedAt: "2026-01-01T00:00:00.000Z" },
        ],
      });

      expect(fetchCalls).toBe(0);
      // The configured custom row is added alongside the provider's baseline model; displayName
      // rides only on the custom row.
      const custom = models.find(m => m.provider === "custom-provider" && m.id === "renamed-model");
      expect(custom?.displayName).toBe("Renamed Model");
      expect(custom?.catalogKind).toBe(CODEX_CUSTOM_MODEL_CATALOG_KIND);

      const entries = buildCatalogEntries(nativeTemplate(), [], models);
      const row = entries.find(e => e.slug === "custom-provider/renamed-model");
      expect(row?.display_name).toBe("Renamed Model");
      expect(row?.slug).toBe("custom-provider/renamed-model");
      expect(row?.opencodex_catalog_kind).toBe(CODEX_CUSTOM_MODEL_CATALOG_KIND);
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("custom-provider");
    }
  });

  test("a custom row clamps its soft budget to the provider max-input ceiling", async () => {
    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "custom-budget",
      providers: {
        "custom-budget": {
          baseUrl: "https://custom-budget.example.test/v1",
          adapter: "openai-chat",
          liveModels: false,
          models: [],
          modelMaxInputTokens: { renamed: 60_000, contextless: 60_000 },
          modelAutoCompactTokenLimits: { renamed: 80_000, contextless: 10_000 },
        },
      },
      customModels: [{
        id: "custom-budget-row",
        provider: "custom-budget",
        modelId: "renamed",
        contextWindow: 321_000,
      }, {
        id: "custom-budget-contextless",
        provider: "custom-budget",
        modelId: "contextless",
      }],
    });
    const model = models.find(row => row.provider === "custom-budget" && row.id === "renamed");
    expect(model).toMatchObject({
      contextWindow: 321_000,
      maxInputTokens: 60_000,
      autoCompactTokenLimit: 60_000,
    });
    expect(buildCatalogEntries(nativeTemplate(), [], models)
      .find(entry => entry.slug === "custom-budget/renamed")).toMatchObject({
      context_window: 321_000,
      max_context_window: 321_000,
      auto_compact_token_limit: 60_000,
    });
    const contextless = models.find(row => row.provider === "custom-budget" && row.id === "contextless");
    expect(contextless).toMatchObject({ maxInputTokens: 60_000 });
    expect(contextless).not.toHaveProperty("autoCompactTokenLimit");
    expect(buildCatalogEntries(nativeTemplate(), [], models)
      .find(entry => entry.slug === "custom-budget/contextless")).toMatchObject({
      context_window: 128_000,
      max_context_window: 128_000,
      auto_compact_token_limit: 60_000,
    });
  });

  test("a customModel reasoning ladder overrides the inherited provider ladder end-to-end", async () => {
    clearModelCache("custom-provider");
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("fetch should not be called");
    }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        port: 10100,
        defaultProvider: "custom-provider",
        providers: {
          "custom-provider": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["baseline-model", "renamed-model"],
            // The provider row for the same slug advertises low/high; the custom row must win.
            modelReasoningEfforts: { "baseline-model": ["low", "high"], "renamed-model": ["low", "high"] },
          },
        },
        customModels: [
          {
            id: "cm-1",
            provider: "custom-provider",
            modelId: "renamed-model",
            displayName: "Renamed Model",
            reasoningEfforts: ["medium", "max"],
            defaultReasoningEffort: "max",
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      expect(fetchCalls).toBe(0);
      const custom = models.find(m => m.provider === "custom-provider" && m.id === "renamed-model");
      // The explicit ladder rides on the row itself, not on the replaced provider row.
      expect(custom?.reasoningEfforts).toEqual(["medium", "max"]);
      expect(custom?.defaultReasoningEffort).toBe("max");

      const entries = buildCatalogEntries(nativeTemplate(), [], models);
      const row = entries.find(e => e.slug === "custom-provider/renamed-model");
      const levels = (row?.supported_reasoning_levels ?? []).map((l: { effort: string }) => l.effort);
      // The sync appends the mock top rungs (max/ultra) for subagent spawn compatibility;
      // the declared medium/max survive verbatim, the inherited low/high does not.
      expect(levels).toEqual(["medium", "max", "ultra"]);
      expect(row?.default_reasoning_level).toBe("max");
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("custom-provider");
    }
  });

  test("an explicit empty customModel ladder hides the effort control despite an inherited one", async () => {
    clearModelCache("custom-provider");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("fetch should not be called");
    }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        port: 10100,
        defaultProvider: "custom-provider",
        providers: {
          "custom-provider": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["renamed-model"],
            modelReasoningEfforts: { "renamed-model": ["low", "high"] },
          },
        },
        customModels: [
          {
            id: "cm-1",
            provider: "custom-provider",
            modelId: "renamed-model",
            reasoningEfforts: [],
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const custom = models.find(m => m.provider === "custom-provider" && m.id === "renamed-model");
      expect(custom?.reasoningEfforts).toEqual([]);

      const entries = buildCatalogEntries(nativeTemplate(), [], models);
      const row = entries.find(e => e.slug === "custom-provider/renamed-model");
      expect(row?.supported_reasoning_levels).toEqual([]);
      expect(row).not.toHaveProperty("default_reasoning_level");
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("custom-provider");
    }
  });

  test("a none-only custom ladder advertises no synthetic top rungs", async () => {
    clearModelCache("custom-provider");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("fetch should not be called");
    }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        port: 10100,
        defaultProvider: "custom-provider",
        providers: {
          "custom-provider": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["renamed-model"],
          },
        },
        customModels: [
          {
            id: "cm-1",
            provider: "custom-provider",
            modelId: "renamed-model",
            reasoningEfforts: ["none"],
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const custom = models.find(m => m.provider === "custom-provider" && m.id === "renamed-model");
      expect(custom?.reasoningEfforts).toEqual(["none"]);

      const entries = buildCatalogEntries(nativeTemplate(), [], models);
      const row = entries.find(e => e.slug === "custom-provider/renamed-model");
      const levels = (row?.supported_reasoning_levels ?? []).map((l: { effort: string }) => l.effort);
      // No reasoning-capable rung -> the mock max/ultra repair must not fire.
      expect(levels).toEqual(["none"]);
      expect(row?.default_reasoning_level).toBe("none");
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("custom-provider");
    }
  });

  test("a mixed none+low custom ladder keeps none first and gets the mock top rungs", async () => {
    clearModelCache("custom-provider");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("fetch should not be called");
    }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        port: 10100,
        defaultProvider: "custom-provider",
        providers: {
          "custom-provider": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["renamed-model"],
          },
        },
        customModels: [
          {
            id: "cm-1",
            provider: "custom-provider",
            modelId: "renamed-model",
            reasoningEfforts: ["none", "low"],
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const entries = buildCatalogEntries(nativeTemplate(), [], models);
      const row = entries.find(e => e.slug === "custom-provider/renamed-model");
      const levels = (row?.supported_reasoning_levels ?? []).map((l: { effort: string }) => l.effort);
      expect(levels).toEqual(["none", "low", "max", "ultra"]);
      // `none` is declared but real rungs exist: the implicit default must be low, not none.
      expect(row?.default_reasoning_level).toBe("low");
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("custom-provider");
    }
  });

  test("an inherited provider default does not ride onto a custom ladder that excludes it", async () => {
    clearModelCache("custom-provider");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("fetch should not be called");
    }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        port: 10100,
        defaultProvider: "custom-provider",
        providers: {
          "custom-provider": {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["renamed-model"],
            // The provider row advertises low/high with a high default; the custom ladder
            // drops high, so the merged row must not keep advertising high as default.
            modelReasoningEfforts: { "renamed-model": ["low", "high"] },
            modelDefaultReasoningEfforts: { "renamed-model": "high" },
          },
        },
        customModels: [
          {
            id: "cm-1",
            provider: "custom-provider",
            modelId: "renamed-model",
            reasoningEfforts: ["low"],
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const custom = models.find(m => m.provider === "custom-provider" && m.id === "renamed-model");
      expect(custom?.reasoningEfforts).toEqual(["low"]);
      expect(custom?.defaultReasoningEffort).toBeUndefined();

      const entries = buildCatalogEntries(nativeTemplate(), [], models);
      const row = entries.find(e => e.slug === "custom-provider/renamed-model");
      const levels = (row?.supported_reasoning_levels ?? []).map((l: { effort: string }) => l.effort);
      expect(levels).toEqual(["low", "max", "ultra"]);
      // No high in the ladder, so the fallback default is medium? low is the first rung —
      // applyReasoningLevels picks medium when present, else high, else the first entry.
      expect(row?.default_reasoning_level).toBe("low");
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("custom-provider");
    }
  });
});

describe("legacy custom-model catalog ownership", () => {
  test("degraded provider preservation cannot resurrect a deleted custom model", () => {
    const staleCustom = buildCatalogEntries(nativeTemplate(), [], [{
      provider: "custom-provider",
      id: "removed-model",
      catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
    }]);
    const merged = mergeObservedForTest({
      catalogModels: staleCustom,
      routedEntries: [],
      gatheredProviderNames: new Set(["custom-provider"]),
      degradedProviderNames: new Set(["custom-provider"]),
    });

    expect(merged.some(entry => entry.slug === "custom-provider/removed-model")).toBe(false);
  });

  test("deletion evidence removes only an old unmarked OpenCodex custom row", () => {
    const staleUnmarked = buildCatalogEntries(nativeTemplate(), [], [{
      provider: "custom-provider",
      id: "removed-model",
    }]);
    const foreignSameSlug = {
      ...staleUnmarked[0],
      description: "Managed by another catalog tool.",
    };
    const input = {
      routedEntries: [],
      gatheredProviderNames: new Set(["custom-provider"]),
      degradedProviderNames: new Set(["custom-provider"]),
      legacyCustomModelSlugs: new Set(["custom-provider/removed-model"]),
    };

    const removed = mergeObservedForTest({ catalogModels: staleUnmarked, ...input });
    expect(removed.some(entry => entry.slug === "custom-provider/removed-model")).toBe(false);

    const preserved = mergeObservedForTest({ catalogModels: [foreignSameSlug], ...input });
    expect(preserved).toContainEqual(expect.objectContaining({
      slug: "custom-provider/removed-model",
      description: "Managed by another catalog tool.",
    }));
  });

  test("fresh provider rediscovery acknowledges a removed slug before a later outage", () => {
    const freshProvider = buildCatalogEntries(nativeTemplate(), [], [{
      provider: "custom-provider",
      id: "removed-model",
    }]);
    const evidence = new Set(["custom-provider/removed-model"]);
    const rediscovered = mergeObservedForTest({
      catalogModels: [],
      routedEntries: freshProvider,
      gatheredProviderNames: new Set(["custom-provider"]),
      legacyCustomModelSlugs: evidence,
    });
    const acknowledged = rediscovered.find(entry => (
      entry.slug === "custom-provider/removed-model"
    ));
    expect(acknowledged?.opencodex_catalog_kind).toBe(CODEX_PROVIDER_MODEL_CATALOG_KIND);

    const degraded = mergeObservedForTest({
      catalogModels: rediscovered,
      routedEntries: [],
      gatheredProviderNames: new Set(["custom-provider"]),
      degradedProviderNames: new Set(["custom-provider"]),
      legacyCustomModelSlugs: evidence,
    });
    expect(degraded).toContainEqual(expect.objectContaining({
      slug: "custom-provider/removed-model",
      opencodex_catalog_kind: CODEX_PROVIDER_MODEL_CATALOG_KIND,
    }));
  });

  test("fresh custom ownership wins historical evidence and stays deletion-authoritative", () => {
    const freshCustom = buildCatalogEntries(nativeTemplate(), [], [{
      provider: "custom-provider",
      id: "removed-model",
      catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
    }]);
    const evidence = new Set(["custom-provider/removed-model"]);
    const readded = mergeObservedForTest({
      catalogModels: [],
      routedEntries: freshCustom,
      gatheredProviderNames: new Set(["custom-provider"]),
      legacyCustomModelSlugs: evidence,
    });
    expect(readded).toContainEqual(expect.objectContaining({
      slug: "custom-provider/removed-model",
      opencodex_catalog_kind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
    }));

    const deletedAgain = mergeObservedForTest({
      catalogModels: readded,
      routedEntries: [],
      gatheredProviderNames: new Set(["custom-provider"]),
      degradedProviderNames: new Set(["custom-provider"]),
      legacyCustomModelSlugs: evidence,
    });
    expect(deletedAgain.some(entry => entry.slug === "custom-provider/removed-model")).toBe(false);
  });

  test("unknown catalog kinds fail closed under legacy deletion evidence", () => {
    const unknownKind = {
      ...buildCatalogEntries(nativeTemplate(), [], [{
        provider: "custom-provider",
        id: "removed-model",
      }])[0],
      opencodex_catalog_kind: "future-model-v2",
    };
    const merged = mergeObservedForTest({
      catalogModels: [unknownKind],
      routedEntries: [],
      gatheredProviderNames: new Set(["custom-provider"]),
      degradedProviderNames: new Set(["custom-provider"]),
      legacyCustomModelSlugs: new Set(["custom-provider/removed-model"]),
    });
    expect(merged).toContainEqual(expect.objectContaining({
      slug: "custom-provider/removed-model",
      opencodex_catalog_kind: "future-model-v2",
    }));
  });

  test("legacy evidence cannot claim account-selector or combo rows", () => {
    const account = {
      ...nativeTemplate(),
      slug: "team/gpt-5.5",
      display_name: "team / GPT-5.5",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    };
    const accountMerged = mergeObservedForTest({
      catalogModels: [account],
      routedEntries: [],
      accountBoundEntries: [account],
      legacyCustomModelSlugs: new Set(["team/gpt-5.5"]),
    });
    expect(accountMerged).toContainEqual(expect.objectContaining({
      slug: "team/gpt-5.5",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    }));

    const combo = {
      ...buildCatalogEntries(nativeTemplate(), [], [{
        provider: "custom-provider",
        id: "removed-model",
      }])[0],
      owned_by: COMBO_NAMESPACE,
      input_modalities: ["text"],
    };
    const comboMerged = mergeObservedForTest({
      catalogModels: [combo],
      routedEntries: [],
      gatheredProviderNames: new Set(["custom-provider"]),
      degradedProviderNames: new Set(["custom-provider"]),
      exactComboSlugs: new Set(["custom-provider/removed-model"]),
      hasPhysicalComboProvider: true,
      legacyCustomModelSlugs: new Set(["custom-provider/removed-model"]),
    });
    expect(comboMerged).toContainEqual(expect.objectContaining({
      slug: "custom-provider/removed-model",
      owned_by: COMBO_NAMESPACE,
    }));
  });
});

test("a custom row inherits provider reasoning metadata from the provider-derived row it replaces (#962)", async () => {
  clearModelCache("ollama");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("fetch should not be called"); }) as typeof fetch;
  try {
    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "ollama",
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          adapter: "openai-chat",
          authMode: "key",
          liveModels: false,
          models: ["qwen-coder-3b"],
          selectedModels: ["qwen-coder-3b"],
          noReasoningModels: ["qwen-coder-3b"],
          modelReasoningEfforts: { "qwen-coder-3b": [] },
        },
      },
      customModels: [
        {
          id: "cm-962",
          provider: "ollama",
          modelId: "qwen-coder-3b",
          displayName: "Qwen Coder 3B (local)",
          contextWindow: 32768,
          inputModalities: ["text"],
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    // Explicit custom fields stay verbatim; provider capability metadata is inherited from the
    // replaced provider-derived row (noReasoningModels -> empty reasoning ladder, openai-chat
    // adapter -> parallel tool calls).
    const custom = models.find(m => m.provider === "ollama" && m.id === "qwen-coder-3b");
    expect(custom?.displayName).toBe("Qwen Coder 3B (local)");
    expect(custom?.contextWindow).toBe(32768);
    expect(custom?.inputModalities).toEqual(["text"]);
    expect(custom?.reasoningEfforts).toEqual([]);
    expect(custom?.parallelToolCalls).toBe(true);

    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    const row = entries.find(e => e.slug === "ollama/qwen-coder-3b");
    expect(row?.display_name).toBe("Qwen Coder 3B (local)");
    // The catalog must expose no reasoning levels and no default reasoning level for this model;
    // the generic low..ultra ladder and the medium default must not be synthesized.
    expect(row?.supported_reasoning_levels).toEqual([]);
    expect(row?.default_reasoning_level).toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCache("ollama");
  }
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

function mergeObservedForTest(
  input: Pick<ObservedCatalogMergeInput, "catalogModels" | "routedEntries">
    & Partial<ObservedCatalogMergeInput>,
): Record<string, unknown>[] {
  return mergeCatalogEntriesFromObservedState({
    baselineCatalogModels: [],
    baseline: new Map(),
    featured: [],
    wsEnabled: false,
    template: nativeTemplate(),
    disabledModels: new Set(),
    selectedModelsByProvider: new Map(),
    gatheredProviderNames: new Set(),
    degradedProviderNames: new Set(),
    legacyCustomModelSlugs: new Set(),
    multiAgentMode: "default",
    multiAgentV2Enabled: false,
    exactComboSlugs: new Set(),
    hasPhysicalComboProvider: false,
    includeNativeOpenAi: true,
    accountBoundEntries: [],
    policy: {
      ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
      warningPolicy: "emit",
    },
    ...input,
  });
}

describe("Codex catalog routed normalization", () => {
  test("does not reuse a routed native alias as the native catalog template", () => {
    const routedAlias = {
      ...nativeTemplate(),
      slug: "gpt-5.6-sol",
      owned_by: "combo",
      description: "Routed via opencodex → Nova1 (openai).",
      opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
    };
    const native = { ...nativeTemplate(), slug: "gpt-5.5", owned_by: "openai" };

    expect(findNativeTemplate({ models: [routedAlias] })).toBeNull();
    expect(findNativeTemplate({ models: [routedAlias, native] })).toBe(native);
  });

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

  test("normalizeRoutedCatalogEntry strips native-only selectors and applies routed tool mode", () => {
    const entry = nativeTemplate();

    normalizeRoutedCatalogEntry(entry);

    expect(entry).not.toHaveProperty("model_messages");
    expect(entry.tool_mode).toBe("code_mode_only");
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
    expect(routed?.tool_mode).toBe("code_mode_only");
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
    expect(routed?.supports_reasoning_summaries).toBe(false);
    expect(routed?.base_instructions).not.toBe(nativeTemplate().base_instructions);
    expect(routed?.base_instructions).toContain("claude-sonnet-4-6");
    expect(routed?.default_reasoning_level).toBe("medium");
  });

  test("buildCatalogEntries restores Fast metadata only for an explicit routed capability", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "verified-relay", id: "gpt-5.6-sol", supportsServiceTier: true },
      { provider: "unverified-relay", id: "gpt-5.6-sol" },
      { provider: "blocked-relay", id: "gpt-5.6-sol", supportsServiceTier: false },
    ]);
    const verified = entries.find(e => e.slug === "verified-relay/gpt-5.6-sol");
    const unverified = entries.find(e => e.slug === "unverified-relay/gpt-5.6-sol");
    const blocked = entries.find(e => e.slug === "blocked-relay/gpt-5.6-sol");

    expect(verified?.service_tiers).toEqual([{
      id: "priority",
      name: "Fast",
      description: "1.5x speed, increased usage",
    }]);
    expect(verified?.additional_speed_tiers).toEqual(["fast"]);
    expect(unverified).not.toHaveProperty("service_tiers");
    expect(unverified).not.toHaveProperty("additional_speed_tiers");
    expect(blocked).not.toHaveProperty("service_tiers");
    expect(blocked).not.toHaveProperty("additional_speed_tiers");
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

  test("routed entries fall to the conservative triple instead of inheriting template context (#992)", () => {
    const template = {
      ...nativeTemplate(),
      context_window: 272_000,
      max_context_window: 272_000,
    };
    const entries = buildCatalogEntries(template, [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const routed = entries.find(e => e.slug === "local/qwen3-coder");

    // A routed model is not the native template: without known metadata the
    // entry falls back to the conservative 128k triple.
    expect(routed?.context_window).toBe(128_000);
    expect(routed?.max_context_window).toBe(128_000);
    expect(routed?.auto_compact_token_limit).toBe(115_200);
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
    expect(gpt56?.context_window).toBe(272_000);
    expect(gpt56?.max_context_window).toBe(272_000);
    expect(gpt56?.auto_compact_token_limit).toBe(244_800);
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

    const codex0151Contract = {
      shell_type: "unified_exec",
      node_repl_disabled: false,
      node_repl_auto_review_required: false,
      include_plugin_usage_instructions: true,
      include_apps_usage_instructions: true,
    };
    for (const slug of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(upstreamNativeEntry(slug)).toMatchObject(codex0151Contract);
    }
    for (const entry of [sol, terra, luna]) {
      expect(entry).toMatchObject(codex0151Contract);
    }

    // ocx adaptations: client-version gate stripped; ws preference gated off by default.
    for (const e of [sol, terra, luna]) {
      expect(e).not.toHaveProperty("minimal_client_version");
      expect(e).not.toHaveProperty("prefer_websockets");
      expect(e).not.toHaveProperty("supports_websockets");
      expect(e?.context_window).toBe(272_000);
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

  test("providerContextCaps.openai ceilings native GPT-5.6 catalog rows (#1430)", () => {
    const cap = 272_000;
    const entries = buildCatalogEntries(
      nativeTemplate(),
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      [],
      undefined,
      false,
      "default",
      new Set(),
      [],
      new Set(),
      new Set(),
      cap,
    );
    for (const slug of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const entry = entries.find(e => e.slug === slug);
      expect(entry?.context_window).toBe(cap);
      expect(entry?.max_context_window).toBe(cap);
      expect(entry?.auto_compact_token_limit).toBe(244_800);
    }
  });

  test("mergeCatalogEntriesForSync re-applies the openai cap to preserved and upgraded native rows (#1430)", () => {
    const cap = 272_000;
    const template = nativeTemplate();
    // A preserved genuine row and a fallback-quality row (display_name stamped with
    // the bare slug) both pass through the final native-override pass on merge.
    const genuineSol = {
      ...template,
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      context_window: 922_000,
      max_context_window: 922_000,
      auto_compact_token_limit: 829_800,
      supported_reasoning_levels: [
        { effort: "low", description: "l" }, { effort: "high", description: "h" },
        { effort: "max", description: "m" }, { effort: "ultra", description: "u" },
      ],
    };
    const merged = mergeCatalogEntriesForSync(
      [genuineSol],
      [],
      new Map(),
      [],
      false,
      new Set(),
      template,
      new Set(),
      new Set(),
      "default",
      new Set(),
      false,
      true,
      [],
      new Set(),
      new Set(),
      cap,
    );
    const sol = merged.find(e => e.slug === "gpt-5.6-sol");
    expect(sol?.context_window).toBe(cap);
    expect(sol?.max_context_window).toBe(cap);
    expect(sol?.auto_compact_token_limit).toBe(244_800);
    // The backfilled luna row (upstream snapshot) is capped the same way.
    const luna = merged.find(e => e.slug === "gpt-5.6-luna");
    expect(luna?.context_window).toBe(cap);
    expect(luna?.max_context_window).toBe(cap);
    expect(luna?.auto_compact_token_limit).toBe(244_800);
  });

  test("preserved gpt-5.4-mini rows get the openai cap without a hardcoded override (#1430)", () => {
    const cap = 200_000;
    const template = nativeTemplate();
    // gpt-5.4-mini has no NATIVE_OPENAI_CONTEXT_OVERRIDES entry; its windows come
    // from the preserved disk row and must still be capped on merge.
    const genuine54Mini = {
      ...template,
      slug: "gpt-5.4-mini",
      display_name: "GPT-5.4-Mini",
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: 244_800,
    };
    const merged = mergeCatalogEntriesForSync(
      [genuine54Mini],
      [],
      new Map(),
      [],
      false,
      new Set(),
      template,
      new Set(),
      new Set(),
      "default",
      new Set(),
      false,
      true,
      [],
      new Set(),
      new Set(),
      cap,
    );
    const mini = merged.find(e => e.slug === "gpt-5.4-mini");
    expect(mini?.context_window).toBe(cap);
    expect(mini?.max_context_window).toBe(cap);
    expect(mini?.auto_compact_token_limit).toBe(180_000);
  });

  test("nativeOpenAiContextWindow applies the openai cap as a ceiling only when provided", () => {
    expect(nativeOpenAiContextWindow("gpt-5.6-sol")).toBe(272_000);
    expect(nativeOpenAiContextWindow("gpt-5.6-sol", 272_000)).toBe(272_000);
    // A 500k cap raises the 272k default; a 2M cap clamps to the measured 922k ceiling.
    expect(nativeOpenAiContextWindow("gpt-5.6-sol", 500_000)).toBe(500_000);
    // A cap ABOVE the native value is a ceiling, not a floor.
    expect(nativeOpenAiContextWindow("gpt-5.6-sol", 2_000_000)).toBe(922_000);
    // Non-5.6 natives are capped the same way.
    expect(nativeOpenAiContextWindow("gpt-5.4", 272_000)).toBe(272_000);
  });

  // Owner decision (devlog 260816_.../011 §4-bis): Daybreak Blue is now a GLOBALLY
  // allowlisted native, so a bare row IS expected. It still inherits Sol's capability
  // shape, and the overlap between NATIVE_OPENAI_MODELS and
  // NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS must not duplicate any row.
  test("Daybreak Blue inherits Sol capabilities and ships one bare row plus one row per selector", () => {
    expect(NATIVE_DAYBREAK_BLUE_MODEL).toBe("gpt-daybreak-blue-latest");
    expect(nativeOpenAiCapabilitySourceSlug(NATIVE_DAYBREAK_BLUE_MODEL)).toBe("gpt-5.6-sol");
    expect(nativeOpenAiContextWindow(NATIVE_DAYBREAK_BLUE_MODEL)).toBe(272_000);
    expect(nativeInputModalities(NATIVE_DAYBREAK_BLUE_MODEL)).toEqual(["text", "image"]);
    expect(nativeReasoningEfforts(NATIVE_DAYBREAK_BLUE_MODEL))
      .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(nativeDefaultReasoningEffort(NATIVE_DAYBREAK_BLUE_MODEL)).toBe("low");

    const source = upstreamNativeEntry(NATIVE_DAYBREAK_BLUE_MODEL);
    expect(source).toMatchObject({
      slug: NATIVE_DAYBREAK_BLUE_MODEL,
      display_name: "Daybreak Blue",
      // The pinned snapshot stays a verbatim copy of what upstream shipped; the live
      // contract (1,050,000 / 922,000) is carried by NATIVE_OPENAI_CONTEXT_OVERRIDES and
      // applied on top by applyNativeOpenAiContextOverride, so the raw entry still reads 372k.
      context_window: 372_000,
      max_context_window: 372_000,
      comp_hash: "3000",
      tool_mode: "code_mode_only",
      use_responses_lite: true,
      supports_parallel_tool_calls: true,
      supports_search_tool: true,
      multi_agent_version: "v2",
    });
    expect(source).not.toHaveProperty("availability_nux");
    expect(source?.base_instructions).toContain("powered by the gpt-daybreak-blue-latest");
    expect(source?.base_instructions).not.toContain("based on GPT-5");
    expect((source?.model_messages as { instructions_template?: string })?.instructions_template)
      .toContain("powered by the gpt-daybreak-blue-latest");

    // NATIVE_OPENAI_MODELS already contains the slug; passing it again would double it.
    const projected = buildCatalogEntries(
      nativeTemplate(),
      NATIVE_OPENAI_MODELS,
      [],
      undefined,
      false,
      "default",
      new Set(),
      ["main"],
      new Set(),
      new Set(),
      undefined,
      [...NATIVE_OPENAI_MODELS],
      new Map([["main", [...NATIVE_OPENAI_MODELS]]]),
    );
    const daybreak = projected.find(entry => entry.slug === `main/${NATIVE_DAYBREAK_BLUE_MODEL}`);
    const sol = projected.find(entry => entry.slug === "gpt-5.6-sol");
    expect(daybreak).toBeDefined();
    expect(daybreak?.auto_compact_token_limit).toBe(244_800);
    expect(daybreak).toMatchObject({
      context_window: sol?.context_window,
      max_context_window: sol?.max_context_window,
      comp_hash: sol?.comp_hash,
      tool_mode: sol?.tool_mode,
      use_responses_lite: sol?.use_responses_lite,
      supports_parallel_tool_calls: sol?.supports_parallel_tool_calls,
      input_modalities: sol?.input_modalities,
    });
    // The bare row now exists (owner decision) and appears exactly once, proving the
    // two-list overlap does not duplicate it.
    expect(projected.filter(entry => entry.slug === NATIVE_DAYBREAK_BLUE_MODEL)).toHaveLength(1);
    expect(projected.filter(entry => entry.slug === `main/${NATIVE_DAYBREAK_BLUE_MODEL}`)).toHaveLength(1);
    // The separately billed API-key alias must still never appear on the Codex surface.
    expect(projected.some(entry => entry.slug === "daybreak-blue-latest")).toBe(false);
  });

  test("configured ChatGPT-forward Daybreak gets Sol native metadata without API-key crossover", async () => {
    globalThis.fetch = (() => { throw new Error("forward providers must not fetch /models"); }) as typeof fetch;
    const forwardConfig: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          // The built-in OpenAI provider defaults an omitted authMode to forward.
          codexAccountMode: "pool",
        },
      },
      codexAccountPickerEnabled: false,
      codexAccountNamespaces: { main: "@main" },
      customModels: [{
        id: "daybreak-codex-forward",
        provider: "openai",
        modelId: NATIVE_DAYBREAK_BLUE_MODEL,
        // An API-sized user value may lower neither the installed Codex native contract nor
        // accidentally collapse this row into the separately billed API-key surface.
        contextWindow: 922_000,
      }],
    };

    const models = await gatherRoutedModels(forwardConfig);
    const model = models.find(row => row.provider === "openai" && row.id === NATIVE_DAYBREAK_BLUE_MODEL);
    expect(model).toMatchObject({
      id: NATIVE_DAYBREAK_BLUE_MODEL,
      provider: "openai",
      displayName: "Daybreak Blue",
      catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
      codexForwardNativeCapabilityAlias: true,
      contextWindow: 922_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "low",
      parallelToolCalls: true,
    });

    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    const daybreak = entries.find(entry => entry.slug === `openai/${NATIVE_DAYBREAK_BLUE_MODEL}`);
    expect(daybreak).toMatchObject({
      slug: `openai/${NATIVE_DAYBREAK_BLUE_MODEL}`,
      display_name: "Daybreak Blue",
      context_window: 922_000,
      max_context_window: 922_000,
      auto_compact_token_limit: 829_800,
      comp_hash: "3000",
      tool_mode: "code_mode_only",
      use_responses_lite: true,
      supports_parallel_tool_calls: true,
      supports_search_tool: true,
      multi_agent_version: "v2",
      opencodex_catalog_kind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
    });
    expect(daybreak?.base_instructions).toContain("powered by the gpt-daybreak-blue-latest");
    expect(daybreak?.model_messages).toBeDefined();
    expect(entries.some(entry => entry.slug === NATIVE_DAYBREAK_BLUE_MODEL)).toBe(false);
    expect(entries.some(entry => entry.slug === `main/${NATIVE_DAYBREAK_BLUE_MODEL}`)).toBe(false);

    const apiRows = augmentRoutedModelsWithRegistryOpenAiApiRows([], openAiApiCatalogConfig());
    expect(apiRows.find(row => row.provider === "openai-apikey" && row.id === "daybreak-blue-latest"))
      .toMatchObject({ contextWindow: 1_050_000, maxInputTokens: 922_000 });
  });

  test("Daybreak metadata inheritance rejects noncanonical providers", async () => {
    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          authMode: "key",
          liveModels: false,
        },
      },
      customModels: [{
        id: "not-codex-forward",
        provider: "openai",
        modelId: NATIVE_DAYBREAK_BLUE_MODEL,
      }],
    });
    const model = models.find(row => row.provider === "openai" && row.id === NATIVE_DAYBREAK_BLUE_MODEL);
    expect(model?.codexForwardNativeCapabilityAlias).toBeUndefined();
    const row = buildCatalogEntries(nativeTemplate(), [], models)
      .find(entry => entry.slug === `openai/${NATIVE_DAYBREAK_BLUE_MODEL}`);
    expect(row?.context_window).toBe(128_000);
    expect(row?.use_responses_lite).toBeUndefined();
    // Not a Daybreak-inheritance signal: `supports_search_tool` is the ordinary routed default for
    // every non-Cursor row since fcbef381e restored deferred tool discovery. The inheritance
    // rejection is proven by the native-only fields above and below.
    expect(row?.supports_search_tool).toBe(true);
    expect(row?.multi_agent_version).toBeUndefined();
  });

  test("an explicit empty custom ladder beats the native-alias ladder on a forward row", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("forward providers must not fetch /models"); }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          codexAccountMode: "pool",
        },
      },
      codexAccountPickerEnabled: false,
      codexAccountNamespaces: { main: "@main" },
      customModels: [{
        id: "daybreak-no-reasoning",
        provider: "openai",
        modelId: NATIVE_DAYBREAK_BLUE_MODEL,
        // Explicit "no reasoning": the alias's native ladder (low..ultra, default low) must
        // not overwrite it — otherwise the catalog would advertise reasoning the user
        // explicitly disabled for this row.
        reasoningEfforts: [],
      }],
    });
    const model = models.find(row => row.provider === "openai" && row.id === NATIVE_DAYBREAK_BLUE_MODEL);
    expect(model).toMatchObject({
      codexForwardNativeCapabilityAlias: true,
      reasoningEfforts: [],
    });
    expect(model?.defaultReasoningEffort).toBeUndefined();

      const entries = buildCatalogEntries(nativeTemplate(), [], models);
      const daybreak = entries.find(entry => entry.slug === `openai/${NATIVE_DAYBREAK_BLUE_MODEL}`);
      expect(daybreak?.supported_reasoning_levels).toEqual([]);
      expect(daybreak).not.toHaveProperty("default_reasoning_level");
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  test("fallback-quality upgrades restore snapshot metadata without losing pristine priority", () => {
    const synthesizedSol = {
      ...nativeTemplate(),
      slug: "gpt-5.6-sol",
      display_name: "gpt-5.6-sol",
      priority: 2,
      stale_marker: true,
    };

    const merged = mergeCatalogEntriesForSync(
      [synthesizedSol], [], new Map([["gpt-5.6-sol", 41]]), [], false,
    );
    const sol = merged.find(entry => entry.slug === "gpt-5.6-sol");

    expect(sol?.display_name).toBe("GPT-5.6-Sol");
    expect(sol?.description).toBe("Latest frontier agentic coding model.");
    expect(sol?.priority).toBe(41);
    expect(sol).not.toHaveProperty("stale_marker");
  });

  test("backfilled natives and account clones use the pristine native baseline", () => {
    const accountRows = buildCatalogEntries(
      nativeTemplate(),
      NATIVE_OPENAI_MODELS,
      [],
      undefined,
      false,
      "default",
      new Set(),
      ["team"],
    ).filter(entry => entry.opencodex_catalog_kind === CODEX_ACCOUNT_BOUND_CATALOG_KIND);

    for (const priority of [41, 9]) {
      const merged = mergeCatalogEntriesForSync(
        [], [], new Map([["gpt-5.6-sol", priority]]), [], false, new Set(), nativeTemplate(),
        new Set(), new Set(), "default", new Set(), false, true, accountRows,
      );
      const bare = merged.find(entry => entry.slug === "gpt-5.6-sol");
      const account = merged.find(entry => entry.slug === "team/gpt-5.6-sol");

      expect(bare?.priority).toBe(priority);
      expect(account?.base_instructions).toBe(bare?.base_instructions);
      expect(account?.description).toBe(bare?.description);
      expect(account?.comp_hash).toBe(bare?.comp_hash);
      expect(account?.opencodex_catalog_kind).toBe(CODEX_ACCOUNT_BOUND_CATALOG_KIND);
    }
  });

  test("bare and account-qualified native rows inherit one lowering-only soft budget", () => {
    const entries = buildCatalogEntries(
      nativeTemplate(),
      NATIVE_OPENAI_MODELS,
      [],
      undefined,
      false,
      "default",
      new Set(),
      ["team"],
      new Set(),
      new Set(),
      { modelAutoCompactTokenLimits: { "gpt-5.6-sol": 120_000 } },
    );
    const bare = entries.find(entry => entry.slug === "gpt-5.6-sol");
    const account = entries.find(entry => entry.slug === "team/gpt-5.6-sol");

    expect(bare).toMatchObject({
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: 120_000,
    });
    expect(account).toMatchObject({
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: 120_000,
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    });
    expect(account?.context_window).toBe(bare?.context_window);
    expect(account?.max_context_window).toBe(bare?.max_context_window);
  });

  test("routed entries drop stale native max context with the template window (#992)", () => {
    const template = {
      ...nativeTemplate(),
      context_window: 272_000,
      max_context_window: 1_000_000,
    };
    const entries = buildCatalogEntries(template, [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const routed = entries.find(e => e.slug === "local/qwen3-coder");

    expect(routed?.context_window).toBe(128_000);
    expect(routed?.max_context_window).toBe(128_000);
    expect(routed?.auto_compact_token_limit).toBe(115_200);
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

  test("buildCatalogEntries assigns code-only tools to routed fallback rows", () => {
    const rows = buildCatalogEntries(null, [], [
      { provider: "deepseek", id: "deepseek-v4-flash", owned_by: "deepseek" },
    ]);

    const routed = rows.find(row => row.slug === "deepseek/deepseek-v4-flash");
    expect(routed).toMatchObject({
      tool_mode: "code_mode_only",
      shell_type: "unified_exec",
      node_repl_disabled: false,
      node_repl_auto_review_required: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: true,
    });
  });

  test("buildCatalogEntries preserves native tool mode on account-qualified rows", () => {
    const rows = buildCatalogEntries(
      nativeTemplate(),
      ["gpt-5.5"],
      [],
      undefined,
      false,
      "default",
      new Set(),
      ["team"],
    );

    expect(rows.find(row => row.slug === "gpt-5.5")?.tool_mode).toBe("code");
    expect(rows.find(row => row.slug === "team/gpt-5.5")?.tool_mode).toBe("code");
  });

  test("catalog sync keeps native OpenAI rows when adopted providers expose matching ids", () => {
    const native = {
      ...nativeTemplate(),
      base_instructions: "installed native instructions",
      genuine_marker: "installed-native",
    };
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
      new Set(["gpt-5.5", "gpt-5.4-mini"]),
    );
    const slugs = merged.map(entry => entry.slug);

    expect(slugs).toContain("gpt-5.5");
    expect(slugs).toContain("gpt-5.4-mini");
    expect(slugs).toContain("cursor/gpt-5.5");
    expect(slugs).toContain("cursor/gpt-5.4-mini");
    expect(slugs).not.toContain("cursor/old");
    expect(merged.find(entry => entry.slug === "gpt-5.5")?.priority).toBe(9);
    expect(merged.find(entry => entry.slug === "gpt-5.5")?.base_instructions)
      .toBe("installed native instructions");
    expect(merged.find(entry => entry.slug === "gpt-5.5")?.genuine_marker)
      .toBe("installed-native");
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

  test("fallback routed entries keep hosted search metadata and deferred discovery", () => {
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

  test("Google Antigravity honors an explicit static catalog and suppresses stale discovery", async () => {
    const providerName = "google-antigravity";
    const provider = structuredClone(OAUTH_PROVIDERS[providerName].providerConfig);
    provider.liveModels = false;
    const config = {
      port: 10100,
      defaultProvider: providerName,
      providers: { [providerName]: provider },
    } as OcxConfig;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("static Antigravity catalog must not call /models");
    }) as typeof fetch;
    markProviderDiscoveryFailed(providerName, { reason: "http", httpStatus: 404 });

    const models = await gatherRoutedModels(config);
    const ids = models.filter(model => model.provider === providerName).map(model => model.id).sort();

    expect(fetchCalls).toBe(0);
    expect(ids).toEqual([...(provider.models ?? [])].sort());
    expect(ids).toHaveLength(6);
    expect(getProviderDiscoveryStatus(providerName)).toBeUndefined();

    markProviderDiscoveryFailed(providerName, { reason: "http", httpStatus: 404 });
    const url = new URL("http://127.0.0.1/api/providers");
    const response = await handleManagementAPI(new Request(url), url, config);
    const rows = await response!.json() as Array<Record<string, unknown>>;
    const row = rows.find(item => item.name === providerName);
    expect(row).toMatchObject({
      name: providerName,
      liveModels: false,
      models: provider.models,
    });
    expect(row).not.toHaveProperty("discovery");
  });

  test("failed discovery falls back to defaultModel when no static models are configured (#308)", async () => {
    clearModelCache("anthropic-compatible-default");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          "anthropic-compatible-default": {
            baseUrl: "https://example.invalid",
            adapter: "anthropic",
            authMode: "key",
            apiKey: "k",
            defaultModel: "claude-sonnet-5",
          },
        },
      });

      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        "anthropic-compatible-default/claude-sonnet-5",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("anthropic-compatible-default");
    }
  });

  test("successful live discovery stays authoritative over the defaultModel fallback", async () => {
    clearModelCache("anthropic-compatible-live");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{ id: "live-claude-model" }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          "anthropic-compatible-live": {
            baseUrl: "https://example.invalid",
            adapter: "anthropic",
            authMode: "key",
            apiKey: "k",
            defaultModel: "stale-default",
          },
        },
      });

      expect(models.map(model => model.id)).toEqual(["live-claude-model"]);
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("anthropic-compatible-live");
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
      const cursorRouterIds = ["auto", "auto-cost", "auto-balance", "auto-intelligence"];
      const routedIds = models
        .filter(model => model.provider === "cursor" && cursorRouterIds.includes(model.id))
        .map(model => model.id);
      expect(routedIds).toHaveLength(cursorRouterIds.length);
      expect(routedIds).toEqual(expect.arrayContaining(cursorRouterIds));
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
      for (const id of cursorRouterIds.slice(1)) {
        const routedEntry = entries.find(item => item.slug === `cursor/${id}`);
        expect(routedEntry?.context_window).toBe(200_000);
        expect(routedEntry?.supported_reasoning_levels).toEqual([]);
      }
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("cursor");
    }
  });

  test("Cursor live discovery keeps all router levels when GetUsableModels omits them", () => {
    const configured = [
      { id: "auto" },
      { id: "auto-cost" },
      { id: "auto-balance" },
      { id: "auto-intelligence" },
      { id: "gpt-5.4" },
      { id: "claude-fable-5" },
    ];
    expect(filterCursorConfiguredModelsByLiveDiscovery(configured, ["gpt-5.4-high"]).map(model => model.id)).toEqual([
      "auto",
      "auto-cost",
      "auto-balance",
      "auto-intelligence",
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
        "xai/grok-4.20-multi-agent-0309",
        "xai/grok-4.3",
        "xai/grok-4.5",
        "xai/grok-build-0.1",
        "xai/grok-composer-2.5-fast",
      ]);
      expect(models.find(model => model.provider === "kimi" && model.id === "k3[1m]")?.contextWindow).toBe(1_048_576);
      expect(models.find(model => model.provider === "xai" && model.id === "grok-4.20-multi-agent-0309"))
        .toMatchObject({
          contextWindow: 1_000_000,
          inputModalities: ["text", "image"],
          reasoningEfforts: ["low", "medium", "high", "xhigh"],
        });
      const catalogEntries = buildCatalogEntries(null, [], models);
      const multiAgentCatalog = catalogEntries.find(entry => entry.slug === "xai/grok-4.20-multi-agent-0309");
      expect((multiAgentCatalog?.supported_reasoning_levels as { effort: string }[]).map(level => level.effort))
        .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
      expect(models.find(model => model.provider === "xai" && model.id === "grok-4.20-multi-agent-0309")?.supportsReasoningSummaries)
        .toBeUndefined();
      expect(getModelMetadata("xai", "grok-4.20-multi-agent-0309")).toMatchObject({
        contextWindow: 1_000_000,
        maxTokens: 30_000,
        input: ["text", "image"],
        reasoning: true,
        cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
      });
      expect(getModelMetadata("xai", "grok-4.20-multi-agent-0309")).not.toHaveProperty("supportsReasoningSummaries");
      expect(models.some(model => model.id === "configured-ghost")).toBe(false);
      expect(warning.mock.calls.flat().join(" ")).not.toContain("omitted configured model ids");
    } finally {
      warning.mockRestore();
      clearModelCache("kimi");
      clearModelCache("xai");
    }
  });

  test("destination-blocked discovery records blocked status", async () => {
    const provider = "discovery-private-blocked";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ data: [{ id: "must-not-fetch" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "http://198.18.0.1/v1",
            apiKey: "sk-test",
            models: ["static-fallback"],
            fetch: globalThis.fetch,
          },
        },
      });

      expect(fetchCalls).toBe(0);
      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        `${provider}/static-fallback`,
      ]);
      expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "failed", reason: "blocked" });
      expect(await providerDiscoveryDto(provider)).toMatchObject({
        discovery: { status: "failed", reason: "blocked" },
      });
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain("blocked by destination policy");
      expect(warningText).toContain("benchmark address");
      expect(warningText).toContain("fallback=configured");
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("model discovery allows a private destination with allowPrivateNetwork opt-in", async () => {
    const provider = "discovery-private-opt-in";
    let requestedUrl: string | undefined;
    globalThis.fetch = (async input => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ id: "live-private-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "http://198.18.0.1/v1",
            allowPrivateNetwork: true,
            apiKey: "sk-test",
            fetch: globalThis.fetch,
          },
        },
      });

      expect(requestedUrl).toBe("http://198.18.0.1/v1/models");
      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        `${provider}/live-private-model`,
      ]);
      expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "ok" });
    } finally {
      clearModelCache(provider);
    }
  });

  test("2xx non-JSON discovery emits safe diagnostics instead of SyntaxError", async () => {
    const provider = "discovery-non-json";
    const bodyMarker = "PRIVATE-UPSTREAM-BODY-MARKER";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () => new Response(`<html>${bodyMarker}</html>`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "https://93.184.216.34/v1",
            apiKey: "sk-test",
            models: ["static-fallback"],
          },
        },
      });

      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        `${provider}/static-fallback`,
      ]);
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain("returned a non-JSON 2xx response");
      expect(warningText).toContain("status=200");
      expect(warningText).toContain("contentType=text/html");
      expect(warningText).toContain("fallback=configured");
      expect(warningText).not.toContain("SyntaxError");
      expect(warningText).not.toContain(bodyMarker);
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("invalid 2xx JSON preserves and returns the stale discovery cache", async () => {
    const provider = "discovery-invalid-json-stale";
    const stale = [{ provider, id: "last-known-good" }];
    setCached(provider, stale);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () => new Response("{not-json", {
      status: 200,
      headers: { "content-type": "application/problem+json; charset=utf-8" },
    })) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        modelCacheTtlMs: 0,
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "https://93.184.216.34/v1",
            apiKey: "sk-test",
            models: ["static-fallback"],
          },
        },
      });

      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        `${provider}/last-known-good`,
      ]);
      expect(getStaleCached(provider)).toEqual(stale);
      expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "failed", reason: "invalid_response" });
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain("returned invalid JSON in a 2xx response");
      expect(warningText).toContain("contentType=application/problem+json");
      expect(warningText).toContain("fallback=stale");
      expect(warningText).not.toContain("SyntaxError");
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("HTTP non-OK discovery returns configured models with status diagnostics", async () => {
    const provider = "discovery-http-401";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(null, { status: 401 });
    }) as typeof fetch;
    const liveOutcomes: Array<{ provider: string; state: "authoritative" | "degraded" }> = [];
    const cooldownOutcomes: Array<{ provider: string; state: "authoritative" | "degraded" }> = [];
    const config = {
      providers: {
        [provider]: {
          adapter: "openai-chat" as const,
          baseUrl: "https://93.184.216.34/v1",
          apiKey: "sk-test",
          models: ["static-fallback"],
        },
      },
    };

    try {
      const models = await gatherRoutedModels(config, { providerModelOutcomes: liveOutcomes });
      const cooled = await gatherRoutedModels(config, { providerModelOutcomes: cooldownOutcomes });

      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        `${provider}/static-fallback`,
      ]);
      expect(cooled).toEqual(models);
      expect(fetchCalls).toBe(1);
      expect(liveOutcomes).toEqual([{ provider, state: "degraded" }]);
      expect(cooldownOutcomes).toEqual([{ provider, state: "degraded" }]);
      expect(getProviderDiscoveryStatus(provider)).toEqual({
        status: "failed",
        reason: "http",
        httpStatus: 401,
      });
      expect(await providerDiscoveryDto(provider)).toMatchObject({
        discovery: { status: "failed", reason: "http", httpStatus: 401 },
      });
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain("failed with HTTP 401");
      expect(warningText).toContain("fallback=configured");
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("network discovery failure records sanitized network status", async () => {
    const provider = "discovery-fetch-throw";
    const sentinel = "SENTINEL-PRIVATE-URL-https://secret.invalid/account";
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () => {
      throw new TypeError(sentinel);
    }) as typeof fetch;

    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "https://93.184.216.34/v1",
            apiKey: "sk-test",
            models: ["static-fallback"],
          },
        },
      });

      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
        `${provider}/static-fallback`,
      ]);
      expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "failed", reason: "network" });
      expect(JSON.stringify(getProviderDiscoveryStatus(provider))).not.toContain(sentinel);
      const dto = await providerDiscoveryDto(provider);
      expect(dto).toMatchObject({ discovery: { status: "failed", reason: "network" } });
      expect(JSON.stringify(dto)).not.toContain(sentinel);
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain("threw TypeError");
      expect(warningText).toContain("fallback=configured");
      expect(warningText).not.toContain("SyntaxError");
      expect(warningText).not.toContain(sentinel);
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
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
      expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "failed", reason: "invalid_response" });
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
      expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "failed", reason: "invalid_response" });
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("invalid JSON or malformed model data records invalid-response status", async () => {
    const cases = [
      { name: "invalid-json", body: "{not-json" },
      { name: "missing-data", body: JSON.stringify({ models: [] }) },
      { name: "malformed-data", body: JSON.stringify({ data: [{ id: 42 }] }) },
    ];
    const warning = spyOn(console, "warn").mockImplementation(() => {});

    try {
      for (const fixture of cases) {
        const provider = `discovery-${fixture.name}`;
        globalThis.fetch = (async () => new Response(fixture.body, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;

        const models = await gatherRoutedModels({
          providers: {
            [provider]: {
              adapter: "openai-chat",
              baseUrl: "https://93.184.216.34/v1",
              apiKey: "sk-test",
              models: ["static-fallback"],
            },
          },
        });

        expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([
          `${provider}/static-fallback`,
        ]);
        expect(getProviderDiscoveryStatus(provider)).toEqual({
          status: "failed",
          reason: "invalid_response",
        });
        expect(await providerDiscoveryDto(provider)).toMatchObject({
          discovery: { status: "failed", reason: "invalid_response" },
        });
        clearModelCache(provider);
      }
    } finally {
      warning.mockRestore();
      clearModelCache();
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
    const liveOutcomes: Array<{ provider: string; state: "authoritative" | "degraded" }> = [];
    const cacheOutcomes: Array<{ provider: string; state: "authoritative" | "degraded" }> = [];

    try {
      const first = await gatherRoutedModels(config, { providerModelOutcomes: liveOutcomes });
      const second = await gatherRoutedModels(config, { providerModelOutcomes: cacheOutcomes });

      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(fetchCalls).toBe(1);
      expect(liveOutcomes).toEqual([{ provider, state: "authoritative" }]);
      expect(cacheOutcomes).toEqual([{ provider, state: "authoritative" }]);
      expect(getStaleCached(provider)).toEqual([]);
      expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "ok" });
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain(provider);
      expect(warningText).toContain("configured-ghost");
      expect(warningText).toContain("authoritative empty catalog");
    } finally {
      warning.mockRestore();
      clearModelCache(provider);
    }
  });

  test("successful catalog discovery clears every prior failure reason", async () => {
    const provider = "discovery-status-reset";
    const failures: Array<Extract<ProviderModelDiscoveryStatus, { status: "failed" }>> = [
      { status: "failed", reason: "blocked" },
      { status: "failed", reason: "http", httpStatus: 401 },
      { status: "failed", reason: "invalid_response" },
      { status: "failed", reason: "network" },
      { status: "failed", reason: "provider" },
    ];
    globalThis.fetch = (async () => Response.json({ data: [] })) as typeof fetch;

    for (const { status: _status, ...failure } of failures) {
      markProviderDiscoveryFailed(provider, failure);
      expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "failed", ...failure });

      await gatherRoutedModels({
        modelCacheTtlMs: 0,
        providers: {
          [provider]: {
            adapter: "openai-chat",
            baseUrl: "https://93.184.216.34/v1",
            apiKey: "sk-test",
          },
        },
      });

      expect(getProviderDiscoveryStatus(provider)).toEqual({ status: "ok" });
      expect(await providerDiscoveryDto(provider)).toMatchObject({ discovery: { status: "ok" } });
    }

    clearModelCache(provider);
    expect(getProviderDiscoveryStatus(provider)).toBeUndefined();
    expect(await providerDiscoveryDto(provider)).not.toHaveProperty("discovery");
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

  test("DeepSeek routed entries restore the official context window from jawcode metadata", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "deepseek", id: "deepseek-v4-pro" },
    ]);
    const flash = entries.find(e => e.slug === "deepseek/deepseek-v4-flash");
    const pro = entries.find(e => e.slug === "deepseek/deepseek-v4-pro");

    for (const routed of [flash, pro]) {
      expect(routed?.context_window).toBe(1_048_576);
      expect(routed?.max_context_window).toBe(1_048_576);
      expect(routed?.auto_compact_token_limit).toBe(943_718); // floor(1048576 * 0.9)
      expect(routed?.input_modalities).toEqual(["text"]);
    }
    // The catalog rebuild falls back to the strict 128k default when metadata is missing,
    // so this assertion proves the jawcode bundle lookup actually ran.
    expect(resolveMetadataProvider("deepseek")).toBe("deepseek");
    expect(getModelMetadata("deepseek", "deepseek-v4-flash")?.contextWindow).toBe(1_048_576);
  });

  test("DeepSeek catalog sync appends V4 rows missing from /v1/models", () => {
    const models = augmentRoutedModelsWithMetadata([], ["deepseek"]);
    const slugs = new Set(models.map(m => `${m.provider}/${m.id}`));

    expect(slugs.has("deepseek/deepseek-v4-flash")).toBe(true);
    expect(slugs.has("deepseek/deepseek-v4-pro")).toBe(true);
    for (const model of models) {
      expect(model.contextWindow).toBe(1_048_576);
      expect(model.inputModalities).toEqual(["text"]);
    }

    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    for (const id of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      const routed = entries.find(e => e.slug === `deepseek/${id}`);
      expect(routed?.context_window).toBe(1_048_576);
      expect(routed?.max_context_window).toBe(1_048_576);
      expect(routed?.auto_compact_token_limit).toBe(943_718); // floor(1048576 * 0.9)
      expect(routed?.input_modalities).toEqual(["text"]);
    }
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
    expect(getModelMetadata("opencode-go", "deepseek-v4-pro")?.contextWindow).toBe(1_000_000);
  });

  test("opencode-go high-risk models use official jawcode metadata in the Codex catalog", () => {
    const cases = [
      { id: "glm-5.2", context: 1_000_000, auto: 900_000, input: ["text"] },
      // Upstream raised qwen3.5-plus to a 1M window and cut minimax-m3 to the 512K tier that
      // matches MiniMax's own <=512K pricing band; both are catalogue refreshes, not overrides.
      { id: "qwen3.5-plus", context: 1_000_000, auto: 900_000, input: ["text", "image"] },
      { id: "kimi-k2.7-code", context: 262_144, auto: 235_929, input: ["text", "image"] },
      { id: "minimax-m3", context: 512_000, auto: 460_800, input: ["text", "image"] },
      { id: "qwen3.7-max", context: 1_000_000, auto: 900_000, input: ["text"] },
    ] as const;
    const entries = buildCatalogEntries(nativeTemplate(), [], cases.map(({ id }) => ({ provider: "opencode-go", id })));

    for (const item of cases) {
      const routed = entries.find(e => e.slug === `opencode-go/${item.id}`);

      expect(routed?.context_window).toBe(item.context);
      expect(routed?.max_context_window).toBe(item.context);
      expect(routed?.auto_compact_token_limit).toBe(item.auto);
      expect(routed?.input_modalities).toEqual(item.input);
      expect(getModelMetadata("opencode-go", item.id)?.contextWindow).toBe(item.context);
    }
  });

  test("opencode-go catalog sync appends official rows missing from /v1/models", () => {
    const models = augmentRoutedModelsWithMetadata(
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

  test("opencode-go live rows inherit same-model reasoning ladders from registry metadata (#2410)", () => {
    const provider = providerConfigSeed(PROVIDER_REGISTRY.find(entry => entry.id === "opencode-go")!);

    const models = ["gpt-5.6-luna", "qwen3.8-max"].map(id => applyProviderConfigHints(
      "opencode-go",
      provider,
      { provider: "opencode-go", id },
    ));

    expect(models.find(model => model.id === "gpt-5.6-luna")?.reasoningEfforts)
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models.find(model => model.id === "qwen3.8-max")?.reasoningEfforts)
      .toEqual(["low", "medium", "xhigh"]);
  });

  test("opencode-go catalog sync appends jawcode rows with provider context-cap metadata", () => {
    const models = augmentRoutedModelsWithMetadata(
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
    const outcomes: Array<{ provider: string; state: "authoritative" | "degraded" }> = [];
    const models = await gatherRoutedModels({
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://opencode-go.test/v1",
          apiKey: "sk-test",
          liveModels: false,
        },
      },
    }, { providerModelOutcomes: outcomes });

    expect(models).toEqual([]);
    expect(outcomes).toEqual([{ provider: "opencode-go", state: "authoritative" }]);
  });

  test("anthropic sonnet 4.6 keeps the upstream 1M context window", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "anthropic", id: "claude-sonnet-4-6" },
    ]);
    const routed = entries.find(e => e.slug === "anthropic/claude-sonnet-4-6");

    expect(routed?.context_window).toBe(1_000_000);
    expect(routed?.max_context_window).toBe(1_000_000);
    expect(routed?.auto_compact_token_limit).toBe(900_000);
    expect(getModelMetadata("anthropic", "claude-sonnet-4-6")?.contextWindow).toBe(1_000_000);
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
    expect(routed?.supports_reasoning_summaries).toBe(false);
    expect(routed?.default_reasoning_summary).toBe("none");
  });

  test("xAI and Kiro routed rows disable verbosity without changing other providers", async () => {
    const models = await gatherRoutedModels({
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "oauth",
          liveModels: false,
          models: ["grok-4.6"],
        },
        kiro: {
          adapter: "kiro",
          baseUrl: "https://runtime.us-east-1.kiro.dev",
          authMode: "oauth",
          liveModels: false,
          models: ["gpt-5.6-sol"],
        },
        plain: {
          adapter: "openai-responses",
          baseUrl: "https://plain.example.test/v1",
          authMode: "key",
          liveModels: false,
          models: ["plain-model"],
        },
      },
    });
    const entries = buildCatalogEntries(null, [], models);

    expect(models.find(model => model.provider === "xai" && model.id === "grok-4.6")?.supportsVerbosity).toBe(false);
    expect(entries.find(entry => entry.slug === "xai/grok-4.6")?.support_verbosity).toBe(false);
    expect(models.find(model => model.provider === "kiro" && model.id === "gpt-5.6-sol")?.supportsVerbosity).toBe(false);
    expect(entries.find(entry => entry.slug === "kiro/gpt-5.6-sol")?.support_verbosity).toBe(false);
    expect(models.find(model => model.provider === "plain" && model.id === "plain-model")?.supportsVerbosity).toBeUndefined();
    expect(entries.find(entry => entry.slug === "plain/plain-model")?.support_verbosity).toBe(true);
  });

  test("a live-discovered xAI id inherits the provider-wide verbosity opt-out", async () => {
    // modelSupportsVerbosity only enumerates the ids present when the registry row was written.
    // A model that arrives later from live discovery used to fall through and re-advertise a
    // control xAI accepts and ignores.
    const models = await gatherRoutedModels({
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "oauth",
          liveModels: false,
          models: ["grok-9.9-not-in-the-registry"],
        },
      },
    });
    const entries = buildCatalogEntries(null, [], models);

    expect(models.find(model => model.provider === "xai")?.supportsVerbosity).toBe(false);
    expect(entries.find(entry => entry.slug === "xai/grok-9.9-not-in-the-registry")?.support_verbosity).toBe(false);
  });

  test("a routed model never inherits the native template's context window (#992)", () => {
    // /models returns only the id: the routed entry must fall to the
    // conservative 128k triple, never the native template's larger window.
    const entries = buildCatalogEntries({ context_window: 372_000 }, [], [
      { provider: "relay", id: "relay-model" },
    ]);
    const routed = entries.find(e => e.slug === "relay/relay-model");
    expect(routed?.context_window).toBe(128_000);
    expect(routed?.max_context_window).toBe(128_000);
    expect(routed?.auto_compact_token_limit).toBe(115_200);
  });

  test("a provider context cap fills an unknown routed window (#992)", () => {
    const entries = buildCatalogEntries({ context_window: 372_000 }, [], [
      { provider: "relay", id: "relay-model", contextCap: 350_000 },
    ]);
    const routed = entries.find(e => e.slug === "relay/relay-model");
    expect(routed?.context_window).toBe(350_000);
    expect(routed?.max_context_window).toBe(350_000);
    expect(routed?.auto_compact_token_limit).toBe(315_000);
  });

  test("known routed metadata still restores the exact context window (#992)", () => {
    const entries = buildCatalogEntries({ context_window: 372_000 }, [], [
      { provider: "relay", id: "relay-model", contextWindow: 256_000 },
    ]);
    const routed = entries.find(e => e.slug === "relay/relay-model");
    expect(routed?.context_window).toBe(256_000);
    expect(routed?.auto_compact_token_limit).toBe(Math.floor(256_000 * 0.9));
  });

  test("model-specific reasoning-summary opt-out reaches the routed catalog (#323)", async () => {
    const models = await gatherRoutedModels({
      providers: {
        compat: {
          adapter: "openai-responses",
          baseUrl: "https://compat.example.test/v1",
          authMode: "key",
          liveModels: false,
          models: ["strict-summary-model"],
          modelSupportsReasoningSummaries: { "strict-summary-model": false },
        },
      },
    });
    const entries = buildCatalogEntries(null, [], models);
    const routed = entries.find(e => e.slug === "compat/strict-summary-model");

    expect(models.find(model => model.id === "strict-summary-model")?.supportsReasoningSummaries).toBe(false);
    expect(routed?.supports_reasoning_summaries).toBe(false);
  });

  test("model-specific reasoning-summary delivery keeps summaries enabled in the routed catalog (#538)", async () => {
    const models = await gatherRoutedModels({
      providers: {
        compat: {
          adapter: "openai-responses",
          baseUrl: "https://compat.example.test/v1",
          authMode: "key",
          liveModels: false,
          models: ["summary-model"],
          modelReasoningSummaryDelivery: { "summary-model": "sequential" },
        },
      },
    });
    const entries = buildCatalogEntries(null, [], models);
    const routed = entries.find(e => e.slug === "compat/summary-model");

    expect(models.find(model => model.id === "summary-model")?.supportsReasoningSummaries).toBe(true);
    expect(routed?.supports_reasoning_summaries).toBe(true);
  });

  // #1100 (supersedes PR #1119): a routed row can advertise a full effort ladder
  // while `supports_reasoning_summaries` is false, and Codex gates construction
  // of the whole Responses `reasoning` object on that flag — so the Desktop
  // picker offers an effort the wire never carries. The landed built-in
  // coverage below ("built-in DeepSeek and GLM effort models opt into Codex
  // reasoning propagation") pins the registry rows. These three pin the CUSTOM
  // provider route, which the built-in tests cannot reach.
  test("routed strip does not defeat an explicit custom-provider summary opt-in (#1100)", async () => {
    const models = await gatherRoutedModels({
      providers: {
        ladder: {
          adapter: "openai-responses",
          baseUrl: "https://ladder.example.test/v1",
          authMode: "key",
          liveModels: false,
          models: ["effort-model"],
          modelReasoningEfforts: { "effort-model": ["low", "high", "max"] },
          modelSupportsReasoningSummaries: { "effort-model": true },
        },
      },
    });
    // A template is required. buildCatalogEntries(null, ...) takes the fallback
    // branch, which never runs the routed strip, so a null-template assertion
    // cannot detect a reordering regression.
    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    const routed = entries.find(e => e.slug === "ladder/effort-model");

    expect((routed?.supported_reasoning_levels as { effort: string }[]).map(l => l.effort))
      .toEqual(expect.arrayContaining(["low", "high", "max"]));
    // The opt-in survives normalizeRoutedCatalogEntry's delete only because
    // applyCatalogModelMetadata runs after it in buildCatalogEntries' routed
    // branch (src/codex/catalog/sync.ts). Swap that order and every opted-in
    // routed provider silently stops receiving reasoning.effort from Codex,
    // while the picker keeps advertising the ladder.
    expect(routed?.supports_reasoning_summaries).toBe(true);
  });

  test("custom routed rows without an opt-in stay conservative about summaries (#1100)", async () => {
    const models = await gatherRoutedModels({
      providers: {
        plain: {
          adapter: "openai-responses",
          baseUrl: "https://plain.example.test/v1",
          authMode: "key",
          liveModels: false,
          models: ["effort-model"],
          modelReasoningEfforts: { "effort-model": ["low", "high", "max"] },
        },
      },
    });
    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    const routed = entries.find(e => e.slug === "plain/effort-model");

    // Deliberate: we do not claim OpenAI-only summary delivery for an arbitrary
    // endpoint just because it has an effort ladder. The supported remedy is the
    // per-model opt-in asserted above. Pinned so flipping this default is always
    // a deliberate decision rather than an accident.
    expect(routed?.supports_reasoning_summaries).toBe(false);
  });

  test("the no-template fallback never applies the routed summary strip (#1100)", async () => {
    const models = await gatherRoutedModels({
      providers: {
        ladder: {
          adapter: "openai-responses",
          baseUrl: "https://ladder.example.test/v1",
          authMode: "key",
          liveModels: false,
          models: ["effort-model"],
          modelReasoningEfforts: { "effort-model": ["low", "high", "max"] },
          modelSupportsReasoningSummaries: { "effort-model": true },
        },
      },
    });
    // Pins the asymmetry itself: the fallback path skips
    // normalizeRoutedCatalogEntry entirely, so this row is opt-in-true for a
    // different reason than the template row above. Kept explicit so a future
    // unification of the two construction paths is a visible change.
    const routed = buildCatalogEntries(null, [], models).find(e => e.slug === "ladder/effort-model");
    expect(routed?.supports_reasoning_summaries).toBe(true);
  });


  test("built-in DeepSeek and GLM effort models opt into Codex reasoning propagation (#1100)", async () => {
    const expected = [
      { slug: "deepseek/deepseek-v4-flash", efforts: ["low", "high", "max", "ultra"] },
      { slug: "deepseek/deepseek-v4-pro", efforts: ["low", "high", "max", "ultra"] },
      { slug: "opencode-go/deepseek-v4-flash", efforts: ["low", "high", "max", "ultra"] },
      { slug: "opencode-go/deepseek-v4-pro", efforts: ["low", "high", "max", "ultra"] },
      { slug: "opencode-go/glm-5.2", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "opencode-go/glm-5.1", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "opencode-go/glm-5", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "zai/glm-5.2", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "zai/glm-5.2[1m]", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "zhipu-bigmodel/glm-4.6", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "zhipu-bigmodel/glm-4.7", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "zhipu-bigmodel/glm-5", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "zhipu-bigmodel/glm-5.1", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    ];
    const models = await gatherRoutedModels({
      providers: {
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com",
          authMode: "key",
          apiKey: "sk-test",
          liveModels: false,
          models: ["deepseek-v4-flash", "deepseek-v4-pro"],
        },
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://opencode.ai/zen/go/v1",
          authMode: "key",
          apiKey: "sk-test",
          liveModels: false,
          models: ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.2", "glm-5.1", "glm-5"],
        },
        zai: {
          adapter: "openai-chat",
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
          authMode: "key",
          apiKey: "sk-test",
          liveModels: false,
          models: ["glm-5.2", "glm-5.2[1m]"],
        },
        "zhipu-bigmodel": {
          adapter: "openai-chat",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          authMode: "key",
          apiKey: "sk-test",
          liveModels: false,
          models: ["glm-4.6", "glm-4.7", "glm-5", "glm-5.1"],
        },
      },
    });
    const entries = buildCatalogEntries(nativeTemplate(), [], models);

    for (const item of expected) {
      const routed = entries.find(entry => entry.slug === item.slug);
      expect(
        (routed?.supported_reasoning_levels as Array<{ effort: string }> | undefined)?.map(level => level.effort),
      ).toEqual(item.efforts);
      expect(routed?.supports_reasoning_summaries).toBe(true);
    }
  });

  test("a custom-named provider on a known vendor endpoint still gets the opt-in (#1100)", () => {
    // The reporter's ACTUAL configuration, verbatim from #1100: a hand-added provider literally
    // named "GLM", model glm-5.2, on BigModel's Coding Plan endpoint. Routing worked, so the row
    // looked healthy, but no registry id is called "GLM" and every piece of registry metadata was
    // skipped — the ladder was advertised with summaries left false, which is the exact
    // inconsistency that makes Codex drop the inbound reasoning object.
    //
    // This case used to substitute Z.AI's coding endpoint while claiming to be the reporter's
    // shape. That passed while the reported configuration stayed broken: `/api/coding/paas/v4`
    // on open.bigmodel.cn had no registry row at all, so the destination lookup found nothing.
    const reported: OcxConfig["providers"][string] = {
      adapter: "openai-chat",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      authMode: "key",
    };
    enrichProviderFromRegistry("GLM", reported);
    expect(reported.modelSupportsReasoningSummaries?.["glm-5.2"]).toBe(true);

    // Z.AI's own Coding Plan endpoint is a different vendor route and keeps working.
    const custom: OcxConfig["providers"][string] = {
      adapter: "openai-chat",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      authMode: "key",
    };
    enrichProviderFromRegistry("GLM", custom);
    expect(custom.modelSupportsReasoningSummaries?.["glm-5.2"]).toBe(true);

    // Same for a renamed row pointing at the BigModel pay-as-you-go endpoint.
    const renamed: OcxConfig["providers"][string] = {
      adapter: "openai-chat",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      authMode: "key",
    };
    enrichProviderFromRegistry("my-glm", renamed);
    expect(renamed.modelSupportsReasoningSummaries?.["glm-4.6"]).toBe(true);
  });

  test("the destination fallback never claims an unrelated custom endpoint (#1100)", () => {
    // The fallback matches by vendor endpoint. A provider pointing somewhere we do not
    // recognize must stay untouched — silently opting a random backend into summary delivery
    // would produce upstream 400s the user never asked for.
    const unknown: OcxConfig["providers"][string] = {
      adapter: "openai-chat",
      baseUrl: "https://api.example.invalid/v1",
      authMode: "key",
    };
    enrichProviderFromRegistry("GLM", unknown);
    expect(unknown.modelSupportsReasoningSummaries).toBeUndefined();

    // An explicit user value wins PER KEY — it does not suppress the other registry defaults.
    // An earlier revision of this fallback bailed whenever any user map existed, which
    // recreated the whole-record bug the per-key merge was written to avoid: setting one
    // model's flag would silently disable the opt-in for every sibling model.
    const opinionated: OcxConfig["providers"][string] = {
      adapter: "openai-chat",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      authMode: "key",
      modelSupportsReasoningSummaries: { "glm-5.2": false },
    };
    enrichProviderFromRegistry("GLM", opinionated);
    expect(opinionated.modelSupportsReasoningSummaries).toEqual({
      "glm-5.2": false,
      "glm-5.2[1m]": true,
      "glm-5.3": true,
      "glm-5.3[1m]": true,
      // glm-5.3-flash joined ZAI_GLM_53_MODELS, which is what modelSupportsReasoningSummaries
      // is derived from. It belongs in the family for reasoning metadata even though it is
      // excluded from the vision-sidecar list - the two answer different questions.
      "glm-5.3-flash": true,
    });
  });

  test("registry summary defaults are never persisted into saved config (#1100)", () => {
    // enrichProviderFromCatalog feeds a config that is about to be written to disk. Persisting
    // today's registry defaults would freeze them as the user's own overrides, so a later
    // registry correction — e.g. learning a model's backend rejects summary delivery — would
    // never reach anyone who created their provider first.
    const created: OcxConfig["providers"][string] = {
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      authMode: "key",
    };
    enrichProviderFromCatalog("deepseek", created);
    expect(created.modelSupportsReasoningSummaries).toBeUndefined();
    // Other registry seeding still reaches the saved config.
    expect(created.models?.length).toBeGreaterThan(0);

    // A value the user actually submitted is preserved verbatim.
    const submitted: OcxConfig["providers"][string] = {
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      authMode: "key",
      modelSupportsReasoningSummaries: { "deepseek-v4-flash": false },
    };
    enrichProviderFromCatalog("deepseek", submitted);
    expect(submitted.modelSupportsReasoningSummaries).toEqual({ "deepseek-v4-flash": false });

    const xai: OcxConfig["providers"][string] = {
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      authMode: "key",
    };
    enrichProviderFromCatalog("xai", xai);
    expect(xai.modelSupportsVerbosity).toBeUndefined();

    const submittedVerbosity: OcxConfig["providers"][string] = {
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      authMode: "key",
      modelSupportsVerbosity: { "grok-4.6": true },
    };
    enrichProviderFromCatalog("xai", submittedVerbosity);
    expect(submittedVerbosity.modelSupportsVerbosity).toEqual({ "grok-4.6": true });
  });

  test("explicit per-model overrides survive registry backfill", () => {
    const provider: OcxConfig["providers"][string] = {
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      authMode: "key",
      modelSupportsReasoningSummaries: { "deepseek-v4-flash": false },
    };

    enrichProviderFromRegistry("deepseek", provider);

    expect(provider.modelSupportsReasoningSummaries).toEqual({
      "deepseek-v4-flash": false,
      "deepseek-v4-pro": true,
    });
  });

  test("routed effort ladders without an opt-in stay conservative about summaries (#1100)", async () => {
    const models = await gatherRoutedModels({
      providers: {
        plain: {
          adapter: "openai-chat",
          baseUrl: "https://plain.example.test/v1",
          authMode: "key",
          liveModels: false,
          models: ["effort-model"],
          modelReasoningEfforts: { "effort-model": ["low", "high"] },
        },
      },
    });
    const routed = buildCatalogEntries(nativeTemplate(), [], models)
      .find(entry => entry.slug === "plain/effort-model");

    expect(
      (routed?.supported_reasoning_levels as Array<{ effort: string }> | undefined)?.map(level => level.effort),
    ).toEqual(["low", "high", "max", "ultra"]);
    expect(routed?.supports_reasoning_summaries).toBe(false);
  });

  test("generated jawcode snapshot is restricted to mapped providers", () => {
    expect(resolveMetadataProvider("kimi")).toBe("moonshot");
    expect(resolveMetadataProvider("nanogpt")).toBeUndefined();
    expect(getModelMetadata("moonshot", "kimi-k2.5")?.contextWindow).toBe(262_144);
    expect(getModelMetadata("nanogpt", "some-model")).toBeUndefined();
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
          modelAutoCompactTokenLimits: { "static-model": 80_000 },
          modelInputModalities: { "static-model": ["text", "image"] },
        },
      },
    });
    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    const routed = entries.find(e => e.slug === "meta-static/static-model");

    expect(routed?.context_window).toBe(321_000);
    expect(routed?.max_context_window).toBe(321_000);
    expect(routed?.auto_compact_token_limit).toBe(80_000);
    expect(routed?.input_modalities).toEqual(["text", "image"]);
  });

  test("an unknown window ignores the configured soft budget instead of treating 128k as policy evidence", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "unknown-soft",
      providers: {
        "unknown-soft": {
          adapter: "openai-chat",
          baseUrl: "https://unknown-soft.test/v1",
          liveModels: false,
          models: ["model"],
          modelAutoCompactTokenLimits: { model: 10_000 },
        },
      },
    });
    const model = models.find(row => row.provider === "unknown-soft" && row.id === "model");
    expect(model).not.toHaveProperty("autoCompactTokenLimit");

    const emitted = buildCatalogEntries(nativeTemplate(), [], models)
      .find(entry => entry.slug === "unknown-soft/model");
    expect(emitted).toMatchObject({
      context_window: 128_000,
      max_context_window: 128_000,
      auto_compact_token_limit: 115_200,
    });
  });

  test("a max-input-only Combo member ignores the configured soft budget", async () => {
    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "max-only",
      providers: {
        "max-only": {
          adapter: "openai-chat",
          baseUrl: "https://max-only.test/v1",
          liveModels: false,
          models: [],
          modelMaxInputTokens: { model: 80_000 },
          modelAutoCompactTokenLimits: { model: 10_000 },
        },
      },
      combos: {
        "max-only-combo": {
          strategy: "failover",
          targets: [{ provider: "max-only", model: "model", weight: 1 }],
        },
      },
    });

    expect(models.find(row => row.provider === "max-only" && row.id === "model")).toBeUndefined();
    expect(models.find(row => row.provider === "combo" && row.id === "max-only-combo"))
      .toMatchObject({
        contextWindow: 80_000,
        maxInputTokens: 80_000,
        autoCompactTokenLimit: 72_000,
      });
  });

  // #1073's exact reproduction: a provider whose /models returns nothing but ids. Two cases,
  // deliberately not one — a single test that sets `modelContextWindows` would keep passing
  // with the provider-wide `?? prov.contextWindow` fallback deleted, because the per-model
  // value is chosen first. Each ablation needs its own oracle.
  //
  // No `modelMaxInputTokens` in either fixture: auto_compact_token_limit is
  // min(floor(contextWindow * 0.9), maxInputTokens), so setting one would move the expectation.
  test("an id-only /models honors the provider-wide contextWindow fallback (#1073)", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ data: [{ id: "gpt-5.6-luna" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "sub2api",
      providers: {
        sub2api: {
          adapter: "openai-chat",
          baseUrl: "https://sub2api.test/v1",
          apiKey: "sk-test",
          contextWindow: 350_000,
        },
      },
    });
    const routed = buildCatalogEntries(nativeTemplate(), [], models)
      .find(e => e.slug === "sub2api/gpt-5.6-luna");

    expect(routed?.context_window).toBe(350_000);
    expect(routed?.max_context_window).toBe(350_000);
    expect(routed?.auto_compact_token_limit).toBe(315_000);
  });

  test("a per-model contextWindow outranks the provider-wide one (#1073)", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ data: [{ id: "gpt-5.6-luna" }, { id: "other-model" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "sub2api",
      providers: {
        sub2api: {
          adapter: "openai-chat",
          baseUrl: "https://sub2api.test/v1",
          apiKey: "sk-test",
          contextWindow: 256_000,
          modelContextWindows: { "gpt-5.6-luna": 350_000 },
        },
      },
    });
    const entries = buildCatalogEntries(nativeTemplate(), [], models);

    expect(entries.find(e => e.slug === "sub2api/gpt-5.6-luna")?.context_window).toBe(350_000);
    // The model without an override still gets the provider default, which is what makes this
    // a comparison rather than a restatement of the previous test.
    expect(entries.find(e => e.slug === "sub2api/other-model")?.context_window).toBe(256_000);
  });

  test("an id-only model with no configured window keeps the conservative fallback (#1073)", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ data: [{ id: "gpt-5.6-luna" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "sub2api",
      providers: {
        sub2api: {
          adapter: "openai-chat",
          baseUrl: "https://sub2api.test/v1",
          apiKey: "sk-test",
        },
      },
    });
    const routed = buildCatalogEntries(nativeTemplate(), [], models)
      .find(e => e.slug === "sub2api/gpt-5.6-luna");

    expect(routed?.context_window).toBe(128_000);
    expect(routed?.max_context_window).toBe(128_000);
    expect(routed?.auto_compact_token_limit).toBe(115_200);
  });

  test("an id-only model with an enabled context cap uses that cap as the window", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ data: [{ id: "gpt-5.6-terra" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "sub2api",
      providerContextCaps: { sub2api: 350_000 },
      providers: {
        sub2api: {
          adapter: "openai-chat",
          baseUrl: "https://sub2api.test/v1",
          apiKey: "sk-test",
        },
      },
    });
    const routed = buildCatalogEntries(nativeTemplate(), [], models)
      .find(e => e.slug === "sub2api/gpt-5.6-terra");

    expect(models.find(m => m.id === "gpt-5.6-terra")).toMatchObject({
      contextWindow: 350_000,
      contextCap: 350_000,
      contextCapped: false,
    });
    expect(routed?.context_window).toBe(350_000);
    expect(routed?.max_context_window).toBe(350_000);
    expect(routed?.auto_compact_token_limit).toBe(315_000);
  });

  test("upstream metadata smaller than the configured window wins (#1073)", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ data: [{ id: "gpt-5.6-luna", context_length: 64_000 }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "sub2api",
      providers: {
        sub2api: {
          adapter: "openai-chat",
          baseUrl: "https://sub2api.test/v1",
          apiKey: "sk-test",
          contextWindow: 350_000,
        },
      },
    });
    const routed = buildCatalogEntries(nativeTemplate(), [], models)
      .find(e => e.slug === "sub2api/gpt-5.6-luna");

    // The configured value supplies capacity when upstream has none; it never inflates a
    // capacity upstream actually reported.
    expect(routed?.context_window).toBe(64_000);
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
          modelMaxInputTokens: { "wide-model": 200_000 },
          modelInputModalities: { "wide-model": ["text"] },
        },
      },
    });

    expect(models.find(m => m.id === "wide-model")).toMatchObject({
      contextWindow: 100_000,
      maxInputTokens: 100_000,
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

  test("provider context-cap toggle lowers known windows above 350k and fills unknown ones", async () => {
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
      contextWindow: 350_000,
      contextCap: 350_000,
      contextCapped: false,
    });
  });

  test("provider context-cap toggle fills static no-metadata models", async () => {
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
      contextWindow: 350_000,
      contextCap: 350_000,
      contextCapped: false,
    });
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
    "daybreak-red-latest", "daybreak-blue-latest",
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
      // This test exercises the catalog fetch/augmentation path, not DNS destination
      // classification. Keep it hermetic on NAT64 hosts whose resolver also returns
      // 64:ff9b::/96 answers for api.openai.com.
      const rows = await gatherRoutedModels(openAiApiCatalogConfig({ liveModels: true, allowPrivateNetwork: true }));
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
      // Daybreak aliases carry their own metadata and, deliberately, NO effort ladder.
      // They fall outside the gpt-5.6 loop above because the alias id is the registered
      // name — the snapshot id is never registered.
      expect(apiRows.find(row => row.id === "daybreak-red-latest")).toMatchObject({
        contextWindow: 400_000,
        maxInputTokens: 272_000,
        inputModalities: ["text", "image"],
        reasoningEfforts: [],
      });
      expect(apiRows.find(row => row.id === "daybreak-blue-latest")).toMatchObject({
        contextWindow: 1_050_000,
        maxInputTokens: 922_000,
        inputModalities: ["text", "image"],
        reasoningEfforts: [],
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("trusted OpenAI API reconstruction is authoritative after discovery failure", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = async () => new Response("{}", { status: 503 });
    const outcomes: Array<{ provider: string; state: "authoritative" | "degraded" }> = [];
    try {
      const rows = await gatherRoutedModels(
        openAiApiCatalogConfig({ liveModels: true, allowPrivateNetwork: true }),
        { providerModelOutcomes: outcomes },
      );
      expect(rows.filter(row => row.provider === "openai-apikey").map(row => row.id))
        .toEqual([...exactIds].sort());
      expect(outcomes).toEqual([{ provider: "openai-apikey", state: "authoritative" }]);

      const routed = buildCatalogEntries(nativeTemplate(), [], rows);
      const ghost = {
        ...nativeTemplate(),
        slug: "openai-apikey/removed-ghost",
        description: "Routed via opencodex → openai-apikey (openai-apikey).",
      };
      const degraded = new Set(outcomes
        .filter(outcome => outcome.state === "degraded")
        .map(outcome => outcome.provider));
      const merged = mergeObservedForTest({
        catalogModels: [nativeTemplate(), ghost],
        routedEntries: routed,
        gatheredProviderNames: new Set(["openai-apikey"]),
        degradedProviderNames: degraded,
      });
      expect(merged.some(entry => entry.slug === "openai-apikey/removed-ghost")).toBe(false);
    } finally {
      warning.mockRestore();
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
      modelContextWindows: { "gpt-5.6-sol": 350_000, "gpt-5.6-terra": 2_000_000, "gpt-5.6-luna": 350_000 },
      modelMaxInputTokens: { "gpt-5.6-sol": 300_000, "gpt-5.6-terra": 945_000, "gpt-5.6-luna": 900_000 },
    }));
    expect(lowered.find(row => row.id === "gpt-5.6-sol")).toMatchObject({ contextWindow: 350_000, maxInputTokens: 300_000 });
    expect(lowered.find(row => row.id === "gpt-5.6-terra")).toMatchObject({ contextWindow: 1_050_000, maxInputTokens: 922_000 });
    expect(lowered.find(row => row.id === "gpt-5.6-luna")).toMatchObject({ contextWindow: 350_000, maxInputTokens: 350_000 });
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

describe("shouldExposeRoutedModel — Gemini image-capable exemption", () => {
  test("exposes gemini-3.1-flash-image (image-capable chat model, not media-gen)", () => {
    expect(shouldExposeRoutedModel({ provider: "google-antigravity", id: "gemini-3.1-flash-image" })).toBe(true);
  });

  test("exposes cursor gemini-3-pro-image-preview", () => {
    expect(shouldExposeRoutedModel({ provider: "cursor", id: "gemini-3-pro-image-preview" })).toBe(true);
  });

  test("does not resurrect standalone media-gen gemini image ids", () => {
    expect(shouldExposeRoutedModel({ provider: "google-antigravity", id: "gemini-3-pro-image" })).toBe(false);
    expect(shouldExposeRoutedModel({ provider: "openrouter", id: "gemini-3-pro-image" })).toBe(false);
  });

  test("still filters true media-generation models", () => {
    for (const id of [
      "grok-2-image", "gpt-image-1", "dall-e-3", "imagen-4", "sora-2", "veo-3", "flux",
    ]) {
      expect(shouldExposeRoutedModel({ provider: "openrouter", id })).toBe(false);
    }
  });

  test("still filters compatibility-excluded slugs", () => {
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "hy3-preview" })).toBe(false);
    // Issue #2330: uncallable or stale OpenCode Go models
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "mimo-v2-omni" })).toBe(false);
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "mimo-v2-pro" })).toBe(false);
    // Control / live models are exposed
    expect(shouldExposeRoutedModel({ provider: "opencode-free", id: "deepseek-v4-flash-free" })).toBe(true);
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "grok-4.6" })).toBe(true);
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "glm-5.2" })).toBe(true);
  });
});

describe("Codex reasoning-effort capability clamp", () => {
  function bundledCatalogDeps(efforts: string[]) {
    return {
      commandCandidates: () => ["codex"],
      execFileSync: () => JSON.stringify({
        models: [{
          slug: "gpt-5.5",
          base_instructions: "test",
          supported_reasoning_levels: efforts.map(effort => ({ effort, description: effort })),
          default_reasoning_level: "medium",
        }],
      }),
    };
  }

  function routedEntry() {
    return {
      slug: "openrouter/example",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"]
        .map(effort => ({ effort, description: effort })),
      default_reasoning_level: "max",
    };
  }

  test("the observed-state clamp is pure with respect to frozen runtime evidence", () => {
    const observed = Object.freeze({
      models: Object.freeze([Object.freeze({
        slug: "gpt-5.5",
        supported_reasoning_levels: Object.freeze(
          ["low", "medium", "high", "xhigh"].map(effort => Object.freeze({ effort })),
        ),
      })]),
    });
    const before = JSON.stringify(observed);
    const models = [routedEntry()];
    models[0]!.default_reasoning_level = "ultra";

    const supported = supportedCodexReasoningEffortsFromObservedCatalog(observed);
    const clamp = clampCatalogModelsToObservedCodexSupport(models, supported);

    expect(clamp).toEqual({
      removedEfforts: ["max", "ultra"],
      affectedModels: ["openrouter/example"],
    });
    expect(models[0]!.supported_reasoning_levels.map(level => level.effort))
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(models[0]!.default_reasoning_level).toBe("xhigh");
    expect(JSON.stringify(observed)).toBe(before);
  });

  test("strips max and ultra when the installed Codex ladder stops at xhigh", () => {
    const models = [routedEntry()];

    clampCatalogModelsToCodexSupport(models, bundledCatalogDeps(["low", "medium", "high", "xhigh"]));

    expect(models[0]!.supported_reasoning_levels.map(level => level.effort))
      .toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("preserves max and ultra when the installed Codex ladder includes them", () => {
    const models = [routedEntry()];

    clampCatalogModelsToCodexSupport(models, bundledCatalogDeps(["low", "medium", "high", "xhigh", "max", "ultra"]));

    expect(models[0]!.supported_reasoning_levels.map(level => level.effort))
      .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  test("falls back to the conservative universal ladder when every advertised effort is unsupported", () => {
    const entry = {
      supported_reasoning_levels: [{ effort: "max" }, { effort: "ultra" }],
      default_reasoning_level: "ultra",
    };

    clampEntryToCodexSupportedEfforts(entry, new Set(["low", "medium", "high", "xhigh"]));

    expect(entry.supported_reasoning_levels.map(level => level.effort)).toEqual(["low", "medium", "high"]);
    expect(clampedDefaultEffort("max", [])).toBe("medium");
  });

  test("repairs an unsupported max default to the highest surviving xhigh rung", () => {
    const entry = routedEntry();

    clampEntryToCodexSupportedEfforts(entry, new Set(["low", "medium", "high", "xhigh"]));

    expect(entry.default_reasoning_level).toBe("xhigh");
  });

  test("is a no-op when the installed Codex binary cannot be probed", () => {
    const models = [routedEntry()];
    const before = structuredClone(models);

    clampCatalogModelsToCodexSupport(models, { commandCandidates: () => [] });

    expect(models).toEqual(before);
  });
});

describe("auto_review_model configuration (#1225)", () => {
  test("applyAutoReviewModelOverride sets auto_review_model_override across all entries", () => {
    const { applyAutoReviewModelOverride } = require("../src/codex/catalog/sync");
    const entries = [
      { slug: "gpt-5.5", auto_review_model_override: null },
      { slug: "opencode-go/deepseek-v4-flash", auto_review_model_override: null },
    ];

    applyAutoReviewModelOverride(entries, "  opencode-go/deepseek-v4-flash  ");
    expect(entries[0].auto_review_model_override).toBe("opencode-go/deepseek-v4-flash");
    expect(entries[1].auto_review_model_override).toBe("opencode-go/deepseek-v4-flash");
  });

  test("applyAutoReviewModelOverride clears routed state when autoReviewModel is null or empty", () => {
    const { applyAutoReviewModelOverride } = require("../src/codex/catalog/sync");
    const entries = [
      { slug: "gpt-5.5", auto_review_model_override: "existing-model" },
      { slug: "opencode-go/glm-5.2", auto_review_model_override: "old-model" },
    ];

    applyAutoReviewModelOverride(entries, null);
    expect(entries[0].auto_review_model_override).toBe("existing-model");
    expect(entries[1].auto_review_model_override).toBeNull();
    applyAutoReviewModelOverride(entries, "   ");
    expect(entries[0].auto_review_model_override).toBe("existing-model");
    expect(entries[1].auto_review_model_override).toBeNull();
  });

  test("applyAutoReviewModelOverride rejects invalid format with control chars or inner spaces", () => {
    const { applyAutoReviewModelOverride, isValidAutoReviewModel } = require("../src/codex/catalog/sync");
    const entries = [
      { slug: "gpt-5.5", auto_review_model_override: "native-preserved" },
    ];

    expect(isValidAutoReviewModel("valid/model-slug_1")).toBe(true);
    expect(isValidAutoReviewModel("invalid slug with spaces")).toBe(false);
    expect(isValidAutoReviewModel("invalid\x00slug")).toBe(false);
    applyAutoReviewModelOverride(entries, "invalid slug with spaces");
    expect(entries[0].auto_review_model_override).toBe("native-preserved");
  });

  test("readConfiguredAutoReviewModel reads auto_review_model from config.toml", () => {
    const { readConfiguredAutoReviewModel } = require("../src/codex/catalog/parsing");
    expect(typeof readConfiguredAutoReviewModel).toBe("function");
  });

  test("writeRetainedCatalogSync stamps auto_review_model_override into persisted catalog", () => {
    const { applyAutoReviewModelOverride } = require("../src/codex/catalog/sync");
    const { readConfiguredAutoReviewModel } = require("../src/codex/catalog/parsing");

    // Simulate a config-driven write path: entries are regenerated from a template,
    // then the override is stamped before serialization.
    const entries = [
      { slug: "gpt-5.5", auto_review_model_override: null },
      { slug: "opencode-go/deepseek-v4-flash", auto_review_model_override: "old-model" },
    ];
    const configuredValue = "  opencode-go/deepseek-v4-flash  ";
    const trimmedValue = configuredValue.trim();

    expect(typeof readConfiguredAutoReviewModel).toBe("function");

    // Absent value: no override is written.
    applyAutoReviewModelOverride(entries, null);
    expect(entries[0].auto_review_model_override).toBeNull();
    expect(entries[1].auto_review_model_override).toBeNull();

    // Present value: trimmed override replaces every entry (including native rows).
    applyAutoReviewModelOverride(entries, configuredValue);
    expect(entries[0].auto_review_model_override).toBe(trimmedValue);
    expect(entries[1].auto_review_model_override).toBe(trimmedValue);
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";

describe("#2465 model preset management routes", () => {
  const originalFetchForPresets = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetchForPresets; clearModelCache(); });

  function presetConfig(selected?: string[], marker?: Record<string, unknown>) {
    return {
      port: 10100,
      defaultProvider: "openrouter",
      providers: {
        openrouter: {
          adapter: "openai-chat",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "k",
          liveModels: false,
          models: [
            "anthropic/claude-opus-5",
            "openai/gpt-5.6-sol",
            "meta-llama/llama-2-7b",
            "some-vendor/ancient-v1",
          ],
          ...(selected ? { selectedModels: selected } : {}),
          ...(marker ? { modelPreset: marker } : {}),
        },
      },
    } as unknown as Parameters<typeof handleManagementAPI>[2];
  }

  async function call(config: Parameters<typeof handleManagementAPI>[2], method: string, body?: unknown) {
    const url = new URL("http://127.0.0.1/api/model-presets");
    const init: RequestInit = body === undefined
      ? { method }
      : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } };
    const response = await handleManagementAPI(new Request(url, init), url, config);
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  }

  test("GET previews the preset against the current catalog without applying it", async () => {
    clearModelCache();
    const config = presetConfig();
    const { body } = await call(config, "GET");
    const view = (body.providers as Record<string, Record<string, unknown>>).openrouter;
    expect(view.mode).toBe("all");
    expect(view.presetIds).toEqual(["anthropic/claude-opus-5", "openai/gpt-5.6-sol"]);
    expect(view.totalCount).toBe(4);
    // Preview must not mutate: the provider is still unfiltered.
    expect(config.providers.openrouter.selectedModels).toBeUndefined();
  });

  test("PUT preset materializes concrete ids and records the version", async () => {
    clearModelCache();
    const config = presetConfig();
    const { body } = await call(config, "PUT", { provider: "openrouter", mode: "preset" });
    expect(body.mode).toBe("preset");
    expect(config.providers.openrouter.selectedModels).toEqual([
      "anthropic/claude-opus-5",
      "openai/gpt-5.6-sol",
    ]);
    // Concrete ids, not patterns: the visibility hot path and older binaries stay compatible.
    expect(config.providers.openrouter.modelPreset?.mode).toBe("preset");
    expect(config.providers.openrouter.modelPreset?.appliedVersion).toBeGreaterThan(0);
  });

  test("PUT all clears both the allowlist and the marker", async () => {
    clearModelCache();
    const config = presetConfig(["anthropic/claude-opus-5"], { mode: "preset", appliedVersion: 1 });
    await call(config, "PUT", { provider: "openrouter", mode: "all" });
    expect(config.providers.openrouter.selectedModels).toBeUndefined();
    expect(config.providers.openrouter.modelPreset).toBeUndefined();
  });

  test("a preset matching nothing never writes an empty allowlist", async () => {
    clearModelCache();
    // Empty means ALL, so a zero-match preset must keep the previous selection rather than
    // silently un-curating the provider.
    const config = presetConfig(["some-vendor/ancient-v1"]);
    config.providers.openrouter.models = ["some-vendor/ancient-v1"];
    const { body } = await call(config, "PUT", { provider: "openrouter", mode: "preset" });
    expect(body.fallback).toBe("preset-empty");
    expect(config.providers.openrouter.selectedModels).toEqual(["some-vendor/ancient-v1"]);
    expect(config.providers.openrouter.modelPreset?.mode).toBe("all");
    expect(config.providers.openrouter.modelPreset?.fallback).toBe("preset-empty");
  });

  test("an unknown provider and an invalid mode are rejected", async () => {
    clearModelCache();
    const config = presetConfig();
    expect((await call(config, "PUT", { provider: "nope", mode: "preset" })).status).toBe(404);
    expect((await call(config, "PUT", { provider: "openrouter", mode: "sideways" })).status).toBe(400);
  });

  test("a provider with no shipped preset cannot be switched into preset mode", async () => {
    clearModelCache();
    const config = presetConfig();
    (config.providers as Record<string, unknown>).groq = {
      adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", apiKey: "k", liveModels: false, models: ["x"],
    };
    const { status } = await call(config, "PUT", { provider: "groq", mode: "preset" });
    expect(status).toBe(400);
  });
});

/**
 * #2813: a Reserve-shaped row injected by the Codex client carries `base_instructions`,
 * so the permissive selector would let it become the template every routed model clones
 * from. Template selection has to be strict — but catalog VALIDITY must stay permissive,
 * or a catalog holding only a newly launched native model gets replaced by stale data.
 * Plan review rejected restricting the shared function for exactly that reason.
 */
describe("routed template selection is strict, catalog validity is not", () => {
  const unknownBareRow = (): Record<string, unknown> => ({
    slug: "gpt-reserve",
    display_name: "Luna Reserve",
    description: "Reserve fallback",
    visibility: "list",
    base_instructions: "You are Codex.",
    available_in_plans: ["reserve"],
    supported_in_api: false,
  });

  test("the strict selector skips an unknown row ordered before a known one", () => {
    // The unknown row is FIRST, so a first-match implementation would pick it.
    const catalog = { models: [unknownBareRow(), nativeTemplate()] } as never;

    expect(findSupportedNativeTemplate(catalog)?.slug).toBe("gpt-5.5");
  });

  test("the strict selector returns null rather than inheriting from an unknown row", () => {
    const catalog = { models: [unknownBareRow()] } as never;

    expect(findSupportedNativeTemplate(catalog)).toBeNull();
  });

  // The regression guard for the rejected fix: if this ever goes red, catalog validity
  // has been narrowed and a new upstream model can invalidate a healthy catalog.
  test("the permissive selector still accepts an unknown row, so validity stays forward-compatible", () => {
    const catalog = { models: [unknownBareRow()] } as never;

    expect(findNativeTemplate(catalog)?.slug).toBe("gpt-reserve");
  });
});

/**
 * Each eligibility field is asserted through `ensureStrictCatalogFields` DIRECTLY.
 * Review found the build path cannot prove them: `deriveEntry` already neutralizes
 * `upgrade` and `availability_nux` on its own, so a build-path assertion stays green
 * after the corresponding sanitizer line is deleted.
 */
describe("routed rows never carry native eligibility metadata", () => {
  const contaminated = (): Record<string, unknown> => ({
    slug: "anthropic/claude-sonnet-5",
    display_name: "claude-sonnet-5",
    supported_in_api: false,
    available_in_plans: ["reserve", "plus"],
    minimal_client_version: "999.0.0",
    availability_nux: { message: "reserve only" },
    upgrade: { message: "subscribe" },
  });

  test("supported_in_api is forced true", () => {
    const entry = ensureStrictCatalogFields(contaminated() as never, { isRouted: true });

    expect(entry.supported_in_api).toBe(true);
  });

  test("available_in_plans is stripped", () => {
    expect(ensureStrictCatalogFields(contaminated() as never, { isRouted: true }))
      .not.toHaveProperty("available_in_plans");
  });

  test("minimal_client_version is stripped", () => {
    expect(ensureStrictCatalogFields(contaminated() as never, { isRouted: true }))
      .not.toHaveProperty("minimal_client_version");
  });

  test("availability_nux is stripped", () => {
    expect(ensureStrictCatalogFields(contaminated() as never, { isRouted: true }))
      .not.toHaveProperty("availability_nux");
  });

  test("upgrade is stripped", () => {
    expect(ensureStrictCatalogFields(contaminated() as never, { isRouted: true }))
      .not.toHaveProperty("upgrade");
  });

  // Routed-only. Native rows legitimately carry availability_nux and plan eligibility;
  // sanitizing them here would corrupt the native picker.
  test("a native row keeps its own eligibility metadata", () => {
    const native = ensureStrictCatalogFields(contaminated() as never, {});

    expect(native.available_in_plans).toEqual(["reserve", "plus"]);
    expect(native.availability_nux).toEqual({ message: "reserve only" });
    expect(native.supported_in_api).toBe(false);
  });

  // Review blocker 3: preserved degraded/foreign rows never pass through
  // normalizeRoutedCatalogEntry, so sanitizing only there would leave rows already on
  // disk contaminated. Both paths end in ensureStrictCatalogFields, which is why it owns
  // the sanitation.
  test("the routed normalizer inherits the same guarantees", () => {
    const entry = normalizeRoutedCatalogEntry(contaminated() as never);

    expect(entry.supported_in_api).toBe(true);
    expect(entry).not.toHaveProperty("available_in_plans");
    expect(entry).not.toHaveProperty("minimal_client_version");
    expect(entry).not.toHaveProperty("availability_nux");
    expect(entry).not.toHaveProperty("upgrade");
  });
});

describe("Codex 0.151 catalog contract fields", () => {
  test("legacy shell types canonicalize while disabled remains disabled", () => {
    const normalizedLegacy = ["default", "local", "shell_command"].map(shell_type =>
      ensureStrictCatalogFields({ slug: "test", shell_type }).shell_type);

    expect(normalizedLegacy).toEqual(["unified_exec", "unified_exec", "unified_exec"]);
    expect(ensureStrictCatalogFields({ slug: "test", shell_type: "disabled" }).shell_type)
      .toBe("disabled");
  });

  test("missing booleans receive serde defaults", () => {
    expect(ensureStrictCatalogFields({ slug: "test" })).toMatchObject({
      node_repl_disabled: false,
      node_repl_auto_review_required: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: true,
    });
  });

  test("explicit per-model booleans are never overwritten by defaults", () => {
    expect(ensureStrictCatalogFields({
      slug: "test",
      node_repl_disabled: true,
      node_repl_auto_review_required: true,
      include_plugin_usage_instructions: true,
      include_apps_usage_instructions: false,
    })).toMatchObject({
      node_repl_disabled: true,
      node_repl_auto_review_required: true,
      include_plugin_usage_instructions: true,
      include_apps_usage_instructions: false,
    });
  });
});
