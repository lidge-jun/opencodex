import { describe, expect, test } from "bun:test";
import { buildCatalogEntries, nativeOpenAiContextTier, nativeReasoningEfforts, upstreamNativeEntry } from "../../src/codex/catalog";
import { buildCatalogEntriesFromObservedState, mergeCatalogEntriesFromObservedState } from "../../src/codex/catalog/build-entries";
import { nativeEffortClamp } from "../../src/codex/catalog/effort";
import { NATIVE_OPENAI_MODELS, configuredNativeOpenAiDisplayName, setConfiguredNativeOpenAiModels } from "../../src/codex/catalog/native-models";
import { applyNativeUltraFastTier } from "../../src/codex/catalog/native-ultrafast";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND } from "../../src/codex/catalog/account-models";
import { routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";
import type { RawEntry } from "../../src/codex/catalog/parsing";

// openai/codex 2f5c413e19776bc684ac781b57dc069e4ab9fa21, models-manager/models.json.
const MODELS = [
  { slug: "gpt-6.2-sol", name: "GPT-6.2-Sol", window: 500_000 },
  { slug: "gpt-6.2-astra", name: "GPT-6.2-Astra", window: 272_000 },
];
const LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

function mergeRetained(row: RawEntry): RawEntry {
  return mergeCatalogEntriesFromObservedState({
    catalogModels: [row], baselineCatalogModels: [], routedEntries: [], baseline: new Map(), featured: [],
    wsEnabled: false, template: null, disabledModels: new Set(), selectedModelsByProvider: new Map(),
    gatheredProviderNames: new Set(), degradedProviderNames: new Set(), legacyCustomModelSlugs: new Set(),
    multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(), hasPhysicalComboProvider: false,
    includeNativeOpenAi: true, accountBoundEntries: [],
    policy: { nativeBackfillSlugs: [row.slug as string], unsupportedNativeEntries: "drop", warningPolicy: "suppress" },
  }).find(entry => entry.slug === row.slug)!;
}

function previouslyConfiguredRow(slug: string): RawEntry {
  const temporary = "gpt-6.2-before-registration";
  setConfiguredNativeOpenAiModels([temporary]);
  try {
    const row = buildCatalogEntries(null, [temporary], [])[0]!;
    return { ...row, slug, display_name: configuredNativeOpenAiDisplayName(slug) };
  } finally { setConfiguredNativeOpenAiModels([]); }
}

for (const { slug, name, window } of MODELS) {
  describe(`${slug} native Codex catalogue`, () => {
    test("appears without an observed roster and retains its own upstream capabilities", () => {
      const rows = buildCatalogEntries(null, NATIVE_OPENAI_MODELS, []);
      const row = rows.find(entry => entry.slug === slug);
      const keys = ["display_name", "visibility", "supported_in_api", "context_window", "max_context_window",
        "auto_compact_token_limit", "default_reasoning_level", "input_modalities", "multi_agent_version", "tool_mode", "service_tiers"];
      expect(Object.fromEntries(keys.map(key => [key, row?.[key]]))).toMatchObject({
        display_name: name, visibility: "list", supported_in_api: true,
        context_window: window, max_context_window: 872_000,
        auto_compact_token_limit: window * 0.9, default_reasoning_level: "low",
        input_modalities: ["text", "image"], multi_agent_version: "v2",
        tool_mode: "code_mode_only",
        service_tiers: [{ id: "priority", name: "Fast" }],
      });
      expect(nativeReasoningEfforts(slug)).toEqual(LADDER);
      expect(rows.find(entry => entry.slug === "gpt-6.1-sol")).toBeDefined();
      expect(rows.find(entry => entry.slug === "gpt-6-astra")).toBeDefined();
    });

    test("uses its native context ceiling when a user opts into a longer window", () => {
      const limits = { modelWindows: { [slug]: 1_050_000 } };
      const rows = buildCatalogEntriesFromObservedState({
        template: null, gptSlugs: [slug], goModels: [], wsEnabled: false,
        multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(),
        accountSelectors: [], suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
        openaiContextCap: limits,
      });
      expect(rows.find(entry => entry.slug === slug)).toMatchObject({
        context_window: 872_000, max_context_window: 872_000, auto_compact_token_limit: 784_800,
      });
      expect(nativeOpenAiContextTier(slug)).toEqual({ defaultWindow: window, longWindow: 872_000 });
    });

    test("account-qualified rows keep this model's own metadata", () => {
      const rows = buildCatalogEntries(null, [slug], [], undefined, false, "default", new Set(), ["personal"]);
      expect(rows.find(entry => entry.slug === `personal/${slug}`)).toMatchObject({
        context_window: window, max_context_window: 872_000,
        multi_agent_version: "v2", default_reasoning_level: "low", input_modalities: ["text", "image"],
      });
    });

    test("keeps max on the native wire and translates ultra to max", () => {
      expect(nativeEffortClamp(slug, "max")).toBeNull();
      expect(nativeEffortClamp(slug, "ultra")).toBe("max");
      expect(nativeEffortClamp(slug, "none")).toBe("low");
      expect(nativeEffortClamp(`gateway/${slug}`, "ultra")).toBeNull();
      const config = { defaultProvider: "openai", providers: { openai: {
        adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward", codexAccountMode: "direct",
      } } } as OcxConfig;
      expect(routeModel(config, slug)).toMatchObject({ providerName: "openai", modelId: slug });
    });

    test("sync promotes an unchanged, previously configured fallback to its own tool metadata", () => {
      const prior = previouslyConfiguredRow(slug);
      expect(prior.experimental_supported_tools).toEqual(["send_user_message_async", "clock"]);
      const result = mergeRetained(prior);
      expect(result.experimental_supported_tools).toEqual([
        "request_user_input_async", "send_message_to_user_async", "clock", "literature_search_query", "multi_agent_v2_in_code_mode",
      ]);
      expect(JSON.stringify(result.model_messages) === JSON.stringify(upstreamNativeEntry(slug)?.model_messages)).toBe(true);
      expect(prior.experimental_supported_tools).toEqual(["send_user_message_async", "clock"]);
    });

    test("sync preserves upstream rows and user-edited fallback instructions, tools or speed tiers", () => {
      const official = { ...upstreamNativeEntry(slug), description: "User's description" };
      expect(mergeRetained(official).description).toBe("User's description");
      for (const edit of [
        { base_instructions: "User's instructions" },
        { model_messages: { instructions_template: "User's template" } },
        { experimental_supported_tools: ["clock"] },
        { service_tiers: [{ id: "ultrafast", name: "Ultra Fast", description: "operator supplied" }] },
        { additional_speed_tiers: ["fast", "ultrafast"] },
        { default_service_tier: "ultrafast" },
      ]) {
        const row = { ...previouslyConfiguredRow(slug), ...edit };
        const result = mergeRetained(row);
        for (const [key, value] of Object.entries(edit)) expect(result[key]).toEqual(value);
      }
    });

    test.each([slug, `personal/${slug}`])("Ultrafast remains opt-in for %s", pickerSlug => {
      const original = buildCatalogEntries(null, [slug], []).find(entry => entry.slug === slug)!;
      const row = { ...structuredClone(original), slug: pickerSlug,
        ...(pickerSlug.includes("/") ? { opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND } : {}) };
      applyNativeUltraFastTier(row, false);
      expect(row.service_tiers).toEqual([{ id: "priority", name: "Fast", description: "2x speed, increased usage" }]);
      applyNativeUltraFastTier(row, true);
      expect(row.service_tiers).toEqual([
        { id: "priority", name: "Fast", description: "2x speed, increased usage" },
        { id: "ultrafast", name: "Ultrafast", description: "Lower latency, increased usage; requires an eligible plan" },
      ]);
      expect(row.default_service_tier).toBeNull();
      applyNativeUltraFastTier(row, false);
      expect(row.service_tiers).toEqual([{ id: "priority", name: "Fast", description: "2x speed, increased usage" }]);
    });
  });
}
