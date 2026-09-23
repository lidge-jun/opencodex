/**
 * Configured native GPT models: a bare `gpt-*` id listed under `providers.openai.models` on the
 * canonical Codex forward provider becomes a native row with GPT-6 Sol capabilities and the GPT-6
 * 272k/872k context pair, with no code change. Plan: devlog/_plan/260923_configured_native_gpt_models/.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  accountBoundNativeOpenAiSlugsBySelector,
  buildCatalogEntries,
  nativeInputModalities,
  nativeModelRows,
  nativeOpenAiContextTier,
  nativeOpenAiContextWindow,
  nativeOpenAiMaxInputTokens,
  nativeReasoningEfforts,
  upstreamNativeEntry,
} from "../../src/codex/catalog";
import {
  NATIVE_GPT6_CONTEXT,
  NATIVE_GPT6_SOL_MODEL,
  NATIVE_OPENAI_MODELS,
  SUPPORTED_NATIVE_OPENAI_SLUGS,
  configuredNativeOpenAiModels,
  hasNativeOpenAiCapabilityMetadata,
  resetConfiguredNativeOpenAiModelsForTests,
  setConfiguredNativeOpenAiModels,
} from "../../src/codex/catalog/native-models";
import { isGpt56NativeSlug, nativeLadderIncludesUltra } from "../../src/codex/catalog/effort";
import { isUnsupportedOpenAiNativeSlug, nativeOpenAiCapabilityDisplayName } from "../../src/codex/catalog/metadata";
import { CANONICAL_NATIVE_CATALOG_CONTENT_POLICY } from "../../src/codex/catalog/build-entries";
import { configuredNativeOpenAiModelIds, refreshConfigDerivedRegistries } from "../../src/config/derived-registries";
import { nativeVisionReasoningEfforts } from "../../src/vision/reasoning";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

afterEach(() => resetConfiguredNativeOpenAiModelsForTests());

const NOVA = "gpt-6-nova";
const SOL_LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"];
const BUILT_IN = [...NATIVE_OPENAI_MODELS];

function forward(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    authMode: "forward",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    ...overrides,
  } as OcxProviderConfig;
}

function config(openai: OcxProviderConfig | undefined, overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: openai ? { openai } : {},
    defaultProvider: "openai",
    ...overrides,
  } as OcxConfig;
}

function efforts(entry: { supported_reasoning_levels?: unknown } | null | undefined): string[] {
  const levels = Array.isArray(entry?.supported_reasoning_levels)
    ? entry!.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  return levels.flatMap(level => typeof level.effort === "string" ? [level.effort] : []);
}

describe("configured native GPT models", () => {
  test("only bare gpt-* ids on the canonical forward provider qualify", () => {
    const models = [NOVA, " gpt-7 ", "openai/gpt-6-x", "o5-mini", "claude-opus-5"];
    expect(configuredNativeOpenAiModelIds(config(forward({ models })))).toEqual([NOVA, "gpt-7", "openai/gpt-6-x", "o5-mini", "claude-opus-5"]);
    // Registration applies the shape filter on top of the config filter.
    setConfiguredNativeOpenAiModels(configuredNativeOpenAiModelIds(config(forward({ models }))));
    expect(configuredNativeOpenAiModels()).toEqual([NOVA, "gpt-7"]);
    // An omitted authMode is the registry's forward default.
    expect(configuredNativeOpenAiModelIds(config(forward({ authMode: undefined, models: [NOVA] })))).toEqual([NOVA]);
    for (const provider of [
      forward({ models: [NOVA], disabled: true }),
      forward({ models: [NOVA], authMode: "key" } as Partial<OcxProviderConfig>),
      forward({ models: [NOVA], baseUrl: "https://gateway.example/v1" }),
      forward({ models: [NOVA], adapter: "openai-chat" } as Partial<OcxProviderConfig>),
    ]) {
      expect(configuredNativeOpenAiModelIds(config(provider))).toEqual([]);
    }
    expect(configuredNativeOpenAiModelIds(config(undefined))).toEqual([]);
  });

  test("built-in, retired and reserve ids are never registered", () => {
    setConfiguredNativeOpenAiModels([NATIVE_GPT6_SOL_MODEL, "gpt-5.5", "gpt-5.4", "gpt-5.3-codex-spark", "gpt-reserve", NOVA, NOVA]);
    expect(configuredNativeOpenAiModels()).toEqual([NOVA]);
    expect(NATIVE_OPENAI_MODELS).toEqual([...BUILT_IN, NOVA]);
  });

  test("a configured id borrows GPT-6 Sol capabilities under its own name", () => {
    refreshConfigDerivedRegistries(config(forward({ models: [NOVA] })));
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(NOVA)).toBe(true);
    expect(isUnsupportedOpenAiNativeSlug(NOVA)).toBe(false);
    expect(hasNativeOpenAiCapabilityMetadata(NOVA)).toBe(true);
    expect(isGpt56NativeSlug(NOVA)).toBe(true);
    expect(nativeLadderIncludesUltra(NOVA)).toBe(true);
    expect(nativeReasoningEfforts(NOVA)).toEqual(SOL_LADDER);
    expect(nativeInputModalities(NOVA)).toEqual(nativeInputModalities(NATIVE_GPT6_SOL_MODEL));
    expect(nativeVisionReasoningEfforts(NOVA)).toEqual(nativeVisionReasoningEfforts(NATIVE_GPT6_SOL_MODEL));
    expect(nativeOpenAiCapabilityDisplayName(NOVA)).toBe("GPT-6-Nova");

    const row = upstreamNativeEntry(NOVA)!;
    expect(row.slug).toBe(NOVA);
    expect(row.display_name).toBe("GPT-6-Nova");
    expect(efforts(row)).toEqual(SOL_LADDER);
    expect(String(row.base_instructions)).toContain(NOVA);

    const entries = buildCatalogEntries(null, [NATIVE_GPT6_SOL_MODEL, NOVA], []);
    const nova = entries.find(entry => entry.slug === NOVA);
    expect(nova?.display_name).toBe("GPT-6-Nova");
    expect(nova?.visibility).toBe("list");
    expect(efforts(nova)).toEqual(SOL_LADDER);
    expect(nova?.context_window).toBe(272_000);
  });

  test("context inherits the GPT-6 272k default and 872k opt-in ceiling", () => {
    setConfiguredNativeOpenAiModels([NOVA]);
    expect(NATIVE_GPT6_CONTEXT).toEqual({ contextWindow: 272_000, maxContextWindow: 872_000, maxInputTokens: 872_000 });
    expect(nativeOpenAiContextWindow(NOVA)).toBe(272_000);
    expect(nativeOpenAiMaxInputTokens(NOVA)).toBe(272_000);
    expect(nativeOpenAiContextTier(NOVA)).toEqual({ defaultWindow: 272_000, longWindow: 872_000 });
    // The same per-model lever as the built-in GPT-6 rows opts it in, and stops at 872k.
    const optIn = { modelWindows: { [NOVA]: 1_000_000 } };
    expect(nativeOpenAiContextWindow(NOVA, optIn)).toBe(872_000);
    expect(nativeOpenAiMaxInputTokens(NOVA, optIn)).toBe(872_000);
    expect(nativeOpenAiContextWindow(NOVA, { modelWindows: { [NOVA]: 500_000 } })).toBe(500_000);
    // Built-in GPT-6 rows share the same pair.
    expect(nativeOpenAiContextWindow(NATIVE_GPT6_SOL_MODEL)).toBe(272_000);
    expect(nativeOpenAiContextWindow(NATIVE_GPT6_SOL_MODEL, { modelWindows: { [NATIVE_GPT6_SOL_MODEL]: 1_000_000 } })).toBe(872_000);
  });

  test("dashboard rows, the backfill policy and every pool selector list it", () => {
    const cfg = config(forward({ models: [NOVA] }), {
      codexAccountPickerEnabled: true,
      codexAccountNamespaces: { personal: "@main", second: "pool-account" },
      codexAccounts: [{ id: "pool-account", alias: "Second", addedAt: 0 }],
    } as Partial<OcxConfig>);
    refreshConfigDerivedRegistries(cfg);
    expect(nativeModelRows(cfg).find(row => row.slug === NOVA)).toMatchObject({ slug: NOVA, disabled: false, contextWindow: 272_000 });
    expect(CANONICAL_NATIVE_CATALOG_CONTENT_POLICY.nativeBackfillSlugs).toContain(NOVA);
    const bySelector = accountBoundNativeOpenAiSlugsBySelector(cfg, []);
    expect(bySelector.size).toBeGreaterThan(0);
    for (const slugs of bySelector.values()) expect(slugs).toContain(NOVA);
  });

  test("removing it from config unregisters it and leaves built-ins intact", () => {
    refreshConfigDerivedRegistries(config(forward({ models: [NOVA] })));
    refreshConfigDerivedRegistries(config(forward({ models: [] })));
    expect(configuredNativeOpenAiModels()).toEqual([]);
    expect(NATIVE_OPENAI_MODELS).toEqual(BUILT_IN);
    expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(NOVA)).toBe(false);
    expect(isUnsupportedOpenAiNativeSlug(NOVA)).toBe(true);
    expect(upstreamNativeEntry(NOVA)).toBeNull();
    expect(nativeOpenAiContextWindow(NOVA)).toBeUndefined();
    expect(CANONICAL_NATIVE_CATALOG_CONTENT_POLICY.nativeBackfillSlugs).not.toContain(NOVA);
    expect(nativeOpenAiContextWindow(NATIVE_GPT6_SOL_MODEL)).toBe(272_000);
    expect(upstreamNativeEntry(NATIVE_GPT6_SOL_MODEL)?.display_name).toBe("GPT-6-Sol");
  });
});
