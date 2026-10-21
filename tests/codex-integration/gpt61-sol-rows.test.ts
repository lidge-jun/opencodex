/**
 * GPT-6.1 Sol (OpenAI, 2026-09-29) across the native Codex row, the OpenAI API registry, the
 * gateways that list it, pricing, and the subagent default.
 *
 * Evidence: https://developers.openai.com/api/docs/models/gpt-6.1-sol (1,050,000 context,
 * 922,000 input, 128,000 output, efforts low..max), https://developers.openai.com/api/docs/pricing
 * ($2 / $0.10 cached / $2.50 write / $10), openai/codex models.json after #49318 (Codex row:
 * low..ultra, default low, 272,000 / 872,000). Plan: devlog/_fin/260930_gpt_6_1_sol_rollout/.
 * Only Sol moved to 6.1, so no GPT-6.1 Luna or Astra may appear anywhere.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildCatalogEntries,
  NATIVE_OPENAI_MODELS,
  nativeDefaultReasoningEffort,
  nativeOpenAiContextTier,
  nativeReasoningEfforts,
  upstreamNativeEntry,
} from "../../src/codex/catalog";
import {
  ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
  NATIVE_GPT6_SOL_MODEL,
  NATIVE_GPT61_SOL_MODEL,
  NATIVE_MAIN_DRAIN_SENTINEL_MODELS,
  SELF_DESCRIBED_NATIVE_OPENAI_MODELS,
} from "../../src/codex/catalog/native-models";
import { DOCUMENTED_NATIVE_OPENAI_ADDITIONS, type NativeContextLimitsInput } from "../../src/codex/catalog/metadata";
import { buildCatalogEntriesFromObservedState, mergeCatalogEntriesFromObservedState } from "../../src/codex/catalog/build-entries";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND } from "../../src/codex/catalog/account-models";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { DEFAULT_SUBAGENT_MODELS } from "../../src/config/subagent-models";
import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../../src/providers/registry";
import { CONTEXT_TIERS, EXPECTED_PRICE_OVERLAYS } from "../../src/usage/expected-prices";

afterEach(() => resetCodexModelEntitlementCacheForTests());

const SOL_LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"];
const API_LADDER = ["low", "medium", "high", "xhigh", "max"];

function builtSol(limits?: NativeContextLimitsInput): RawEntry | undefined {
  return buildCatalogEntriesFromObservedState({
    template: null, gptSlugs: [NATIVE_GPT61_SOL_MODEL], goModels: [], wsEnabled: false,
    multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(),
    accountSelectors: [], suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
    openaiContextCap: limits,
  }).find(entry => entry.slug === NATIVE_GPT61_SOL_MODEL);
}

function mergeRetainedSol(retained: RawEntry, limits?: NativeContextLimitsInput): RawEntry | undefined {
  const accountBound = retained.opencodex_catalog_kind === CODEX_ACCOUNT_BOUND_CATALOG_KIND;
  return mergeCatalogEntriesFromObservedState({
    catalogModels: accountBound ? [] : [retained], baselineCatalogModels: [], routedEntries: [],
    baseline: new Map(), featured: [], wsEnabled: false, template: null,
    disabledModels: new Set(), selectedModelsByProvider: new Map(), gatheredProviderNames: new Set(),
    degradedProviderNames: new Set(), legacyCustomModelSlugs: new Set(), multiAgentMode: "default",
    multiAgentV2Enabled: false, exactComboSlugs: new Set(), hasPhysicalComboProvider: false,
    includeNativeOpenAi: true, accountBoundEntries: accountBound ? [retained] : [],
    // No backfill: the test must repair the retained row rather than replace it with a fresh one.
    policy: { nativeBackfillSlugs: [], unsupportedNativeEntries: "drop", warningPolicy: "suppress" },
    openaiContextCap: limits,
  }).find(entry => entry.slug === retained.slug);
}

function efforts(entry: { supported_reasoning_levels?: unknown } | null | undefined): string[] {
  const levels = Array.isArray(entry?.supported_reasoning_levels)
    ? entry!.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  return levels.flatMap(level => typeof level.effort === "string" ? [level.effort] : []);
}

describe("GPT-6.1 Sol native Codex row", () => {
  test("is a self-described, ungated native with its own row", () => {
    expect(NATIVE_GPT61_SOL_MODEL).toBe("gpt-6.1-sol");
    expect(NATIVE_OPENAI_MODELS).toContain(NATIVE_GPT61_SOL_MODEL);
    expect(SELF_DESCRIBED_NATIVE_OPENAI_MODELS.has(NATIVE_GPT61_SOL_MODEL)).toBe(true);
    expect(ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(NATIVE_GPT61_SOL_MODEL)).toBe(false);
    expect(DOCUMENTED_NATIVE_OPENAI_ADDITIONS).toContain(NATIVE_GPT61_SOL_MODEL);
    expect(NATIVE_MAIN_DRAIN_SENTINEL_MODELS.has(NATIVE_GPT61_SOL_MODEL)).toBe(true);

    expect(upstreamNativeEntry(NATIVE_GPT61_SOL_MODEL)).toMatchObject({
      slug: NATIVE_GPT61_SOL_MODEL,
      display_name: "GPT-6.1-Sol",
      context_window: 272_000,
      max_context_window: 872_000,
    });
    expect(nativeOpenAiContextTier(NATIVE_GPT61_SOL_MODEL)).toEqual({ defaultWindow: 500_000, longWindow: 872_000 });
    expect(nativeReasoningEfforts(NATIVE_GPT61_SOL_MODEL)).toEqual(SOL_LADDER);
    // Upstream ships low as the default effort for 6.1 Sol (GPT-6 Sol ships medium).
    expect(nativeDefaultReasoningEffort(NATIVE_GPT61_SOL_MODEL)).toBe("low");
    expect(nativeDefaultReasoningEffort(NATIVE_GPT6_SOL_MODEL)).toBe("medium");
  });

  test("the built catalog lists it with ultra and keeps GPT-6 Sol beside it", () => {
    const entries = buildCatalogEntries(null, [NATIVE_GPT61_SOL_MODEL, NATIVE_GPT6_SOL_MODEL], []);
    const next = entries.find(entry => entry.slug === NATIVE_GPT61_SOL_MODEL);
    expect(next).toMatchObject({
      context_window: 500_000, max_context_window: 872_000, auto_compact_token_limit: 450_000,
    });
    expect(next?.visibility).toBe("list");
    expect(efforts(next)).toEqual(SOL_LADDER);
    expect(entries.some(entry => entry.slug === NATIVE_GPT6_SOL_MODEL)).toBe(true);
  });

  test("per-model context override wins over the provider window override", () => {
    expect(builtSol({ providerWindow: 300_000, modelWindows: { [NATIVE_GPT61_SOL_MODEL]: 400_000 } }))
      .toMatchObject({ context_window: 400_000, max_context_window: 400_000, auto_compact_token_limit: 360_000 });
    expect(builtSol({ providerWindow: 300_000 }))
      .toMatchObject({ context_window: 300_000, max_context_window: 300_000, auto_compact_token_limit: 270_000 });
  });

  test("the provider context cap narrows the default and a per-model opt-in", () => {
    for (const modelWindows of [undefined, { [NATIVE_GPT61_SOL_MODEL]: 872_000 }]) {
      expect(builtSol({ cap: 350_000, modelWindows }))
        .toMatchObject({ context_window: 350_000, max_context_window: 350_000, auto_compact_token_limit: 315_000 });
    }
  });

  test("a 1M context override clamps to the unchanged 872k ceiling", () => {
    expect(builtSol({ modelWindows: { [NATIVE_GPT61_SOL_MODEL]: 1_000_000 } }))
      .toMatchObject({ context_window: 872_000, max_context_window: 872_000, auto_compact_token_limit: 784_800 });
  });

  test("a configured compaction limit lowers the 500k row's soft budget", () => {
    expect(builtSol({ modelAutoCompactTokenLimits: { [NATIVE_GPT61_SOL_MODEL]: 320_000 } }))
      .toMatchObject({ context_window: 500_000, max_context_window: 872_000, auto_compact_token_limit: 320_000 });
  });

  test("long-window opt-in reaches 872k without changing the default tier", () => {
    const limits = { modelWindows: { [NATIVE_GPT61_SOL_MODEL]: 872_000 } };
    expect(builtSol(limits))
      .toMatchObject({ context_window: 872_000, max_context_window: 872_000, auto_compact_token_limit: 784_800 });
    expect(nativeOpenAiContextTier(NATIVE_GPT61_SOL_MODEL, limits))
      .toEqual({ defaultWindow: 500_000, longWindow: 872_000 });
  });

  test.each([NATIVE_GPT61_SOL_MODEL, `personal/${NATIVE_GPT61_SOL_MODEL}`])(
    "retained %s repairs the old 272k window and 244800 compaction limit", slug => {
      const retained = {
        ...upstreamNativeEntry(NATIVE_GPT61_SOL_MODEL)!, slug,
        context_window: 272_000, auto_compact_token_limit: 244_800,
        ...(slug.includes("/") ? { opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND } : {}),
      };
      expect(mergeRetainedSol(retained))
        .toMatchObject({ slug, context_window: 500_000, max_context_window: 872_000, auto_compact_token_limit: 450_000 });
      // The observed merge detaches its input; persistence evidence remains unchanged.
      expect(retained).toMatchObject({ context_window: 272_000, auto_compact_token_limit: 244_800 });
    },
  );

  test.each([NATIVE_GPT61_SOL_MODEL, `personal/${NATIVE_GPT61_SOL_MODEL}`])(
    "retained %s keeps 244800 compaction under an explicit 272k override", slug => {
      const retained = {
        ...upstreamNativeEntry(NATIVE_GPT61_SOL_MODEL)!, slug,
        context_window: 272_000, auto_compact_token_limit: 244_800,
        ...(slug.includes("/") ? { opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND } : {}),
      };
      expect(mergeRetainedSol(retained, { modelWindows: { [NATIVE_GPT61_SOL_MODEL]: 272_000 } }))
        .toMatchObject({ slug, context_window: 272_000, max_context_window: 272_000, auto_compact_token_limit: 244_800 });
    },
  );
});

describe("GPT-6.1 Sol on API and gateway providers", () => {
  test("OpenAI API rows carry the published limits and ladder", () => {
    const entry = getProviderRegistryEntry("openai-apikey")!;
    expect(entry.models).toContain("gpt-6.1-sol");
    expect(entry.modelContextWindows?.["gpt-6.1-sol"]).toBe(1_050_000);
    expect(entry.modelMaxInputTokens?.["gpt-6.1-sol"]).toBe(922_000);
    expect(entry.modelMaxOutputTokens?.["gpt-6.1-sol"]).toBe(128_000);
    expect(entry.modelReasoningEfforts?.["gpt-6.1-sol"]).toEqual(API_LADDER);
    expect(entry.modelInputModalities?.["gpt-6.1-sol"]).toEqual(["text", "image"]);
  });

  test("native defaults leave OpenAI API, Kiro and CodeBuddy context windows unchanged", () => {
    const cases = [
      { provider: "openai-apikey", contextWindow: 1_050_000 },
      { provider: "kiro", contextWindow: 272_000 },
      { provider: "codebuddy", contextWindow: 1_000_000 },
    ];
    const routed = cases.map(({ provider, contextWindow }) => {
      const registry = getProviderRegistryEntry(provider)!;
      expect(registry.models).toContain(NATIVE_GPT61_SOL_MODEL);
      expect(registry.modelContextWindows?.[NATIVE_GPT61_SOL_MODEL]).toBe(contextWindow);
      return { provider, id: NATIVE_GPT61_SOL_MODEL,
        contextWindow: registry.modelContextWindows![NATIVE_GPT61_SOL_MODEL],
        maxInputTokens: registry.modelMaxInputTokens?.[NATIVE_GPT61_SOL_MODEL] };
    });
    const entries = buildCatalogEntries(null, [NATIVE_GPT61_SOL_MODEL], routed);
    expect(entries.find(entry => entry.slug === NATIVE_GPT61_SOL_MODEL)?.context_window).toBe(500_000);
    for (const { provider, contextWindow } of cases) {
      expect(entries.find(entry => entry.slug === `${provider}/${NATIVE_GPT61_SOL_MODEL}`)?.context_window)
        .toBe(contextWindow);
    }
  });

  test("OpenRouter lists it as an OpenAI-backed route with the live window", () => {
    const entry = getProviderRegistryEntry("openrouter")!;
    expect(entry.models).toContain("openai/gpt-6.1-sol");
    expect(entry.modelContextWindows?.["openai/gpt-6.1-sol"]).toBe(1_050_000);
    expect(entry.modelSupportsServiceTier?.["openai/gpt-6.1-sol"]).toBe(true);
  });

  test("GitHub Copilot sends it over Responses", () => {
    const entry = getProviderRegistryEntry("github-copilot")!;
    expect(entry.models).toContain("gpt-6.1-sol");
    expect(entry.modelWireDefaults?.["gpt-6.1-sol"]).toBe("openai-responses");
  });

  test("no GPT-6.1 Luna or Astra exists anywhere in the registry or the native list", () => {
    const ids = [
      ...NATIVE_OPENAI_MODELS,
      ...PROVIDER_REGISTRY.flatMap(entry => entry.models ?? []),
    ];
    expect(ids.filter(id => /6[.-]1-(luna|astra)/.test(id))).toEqual([]);
  });
});

describe("GPT-6.1 Sol pricing and defaults", () => {
  test("API price overlays use the halved cached input and the long-context tier", () => {
    const price = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
    for (const provider of ["openai-apikey", "openai"]) {
      const row = EXPECTED_PRICE_OVERLAYS.find(overlay => overlay.provider === provider && overlay.modelId === "gpt-6.1-sol");
      expect(row?.cost4).toEqual(price);
      expect(CONTEXT_TIERS.some(tier => tier.provider === provider && tier.modelId === "gpt-6.1-sol"
        && tier.thresholdInputTokens === 272_000)).toBe(true);
    }
    const gpt6 = EXPECTED_PRICE_OVERLAYS.find(overlay => overlay.provider === "openai-apikey" && overlay.modelId === "gpt-6-sol");
    expect(gpt6?.cost4.cacheRead).toBe(0.2);
  });

  test("the subagent default takes GPT-6.1 Sol in Sol's slot; GPT-6 Sol stays supported", () => {
    expect(DEFAULT_SUBAGENT_MODELS).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]);
    expect(NATIVE_OPENAI_MODELS).toContain(NATIVE_GPT6_SOL_MODEL);
  });
});

