import { expect, test } from "bun:test";
import { buildCatalogEntriesFromObservedState } from "../../src/codex/catalog/build-entries";
import { DOCUMENTED_NATIVE_OPENAI_ADDITIONS, nativeOpenAiContextTier, upstreamNativeEntry } from "../../src/codex/catalog/metadata";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS, NATIVE_MAIN_DRAIN_SENTINEL_MODELS } from "../../src/codex/catalog/native-models";
import { pinnedNativeModelRows } from "../../src/codex/catalog/pinned-models";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { CONTEXT_TIERS, EXPECTED_PRICE_OVERLAYS, PRIORITY_PRICING_RULES } from "../../src/usage/expected-prices";

test.each([
  { slug: "gpt-6.2-sol", name: "GPT-6.2-Sol", window: 500_000, priority: 1, cost4: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
  { slug: "gpt-6.2-astra", name: "GPT-6.2-Astra", window: 272_000, priority: 2, cost4: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 } },
])("$slug retains its native windows and distinct public API limits", ({ slug, name, window, priority, cost4 }) => {
  const ladder = ["low", "medium", "high", "xhigh", "max"];
  expect(upstreamNativeEntry(slug)).toMatchObject({
    slug, display_name: name, priority, context_window: window, max_context_window: 872_000,
    default_reasoning_level: "low", multi_agent_version: "v2",
  });
  const pin = pinnedNativeModelRows().find(row => row.slug === slug);
  expect(pin?.minimal_client_version).toBe("0.166.0");
  expect((pin?.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort)).toEqual([...ladder, "ultra"]);
  expect(DOCUMENTED_NATIVE_OPENAI_ADDITIONS).toContain(slug);
  expect(ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug)).toBe(false);
  expect(NATIVE_MAIN_DRAIN_SENTINEL_MODELS.has(slug)).toBe(true);
  expect(nativeOpenAiContextTier(slug)).toEqual({ defaultWindow: window, longWindow: 872_000 });

  const entries = buildCatalogEntriesFromObservedState({
    template: null, gptSlugs: [slug], goModels: [], wsEnabled: false,
    multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(),
    accountSelectors: [], suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
    openaiContextCap: { modelWindows: { [slug]: 1_000_000 } },
  });
  expect(entries.find(entry => entry.slug === slug)).toMatchObject({ context_window: 872_000, max_context_window: 872_000 });

  const api = getProviderRegistryEntry("openai-apikey")!;
  expect(api.models).toContain(slug);
  expect(api.modelContextWindows?.[slug]).toBe(1_050_000);
  expect(api.modelMaxInputTokens?.[slug]).toBe(922_000);
  expect(api.modelMaxOutputTokens?.[slug]).toBe(128_000);
  expect(api.modelReasoningEfforts?.[slug]).toEqual(ladder);
  const openRouterSlug = `openai/${slug}`;
  const openRouter = getProviderRegistryEntry("openrouter")!;
  expect(openRouter.models).toContain(openRouterSlug);
  expect(openRouter.modelContextWindows?.[openRouterSlug]).toBe(1_050_000);

  for (const [provider, modelId, inclusive] of [
    ["openai", slug, false], ["openai-apikey", slug, false], ["openrouter", openRouterSlug, true],
  ] as const) {
    expect(EXPECTED_PRICE_OVERLAYS.find(row => row.provider === provider && row.modelId === modelId)?.cost4).toEqual(cost4);
    expect(CONTEXT_TIERS.find(row => row.provider === provider && row.modelId === modelId)).toMatchObject({
      thresholdInputTokens: 272_000, inclusive,
      multiplier: { input: 2, output: 1.5, cacheRead: 2, cacheWrite: 2 },
    });
  }
  expect(PRIORITY_PRICING_RULES.find(row => row.provider === "openai-apikey" && row.modelId === slug)?.multiplier).toBe(2);
});
