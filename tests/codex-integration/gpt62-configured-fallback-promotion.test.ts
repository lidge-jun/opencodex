import { describe, expect, test } from "bun:test";
import { buildCatalogEntries, upstreamNativeEntry } from "../../src/codex/catalog";
import { mergeCatalogEntriesFromObservedState } from "../../src/codex/catalog/build-entries";
import { configuredNativeOpenAiDisplayName, setConfiguredNativeOpenAiModels } from "../../src/codex/catalog/native-models";
import { neutralizeIdentity } from "../../src/adapters/identity";
import type { RawEntry } from "../../src/codex/catalog/parsing";

// Carried from #8891 (nickdavis): before #8893 pinned GPT-6.2, a providers.openai.models entry for
// it borrowed GPT-6.1 Sol's row. Sync must promote that unchanged fallback to the model's own pin.
const HISTORICAL_DESCRIPTION = "OpenAI native model added through providers.openai.models; uses GPT-6-Sol capabilities.";

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

/**
 * The row an earlier release wrote for a configured gpt-6.2-* slug: every GPT-6.1 Sol field,
 * identity-neutralized, plus the fields the catalog build derives (checked against rows generated
 * at c320932c19^, the commit before GPT-6.2 was pinned).
 */
function historicalConfiguredRow(slug: string): RawEntry {
  const temporary = "gpt-6.2-before-registration";
  setConfiguredNativeOpenAiModels([temporary]);
  let built: RawEntry;
  try { built = structuredClone(buildCatalogEntries(null, [temporary], [])[0]!); } finally { setConfiguredNativeOpenAiModels([]); }
  const sol61 = structuredClone(upstreamNativeEntry("gpt-6.1-sol")!);
  delete sol61.prefer_websockets;
  delete sol61.availability_nux;
  const messages = sol61.model_messages as Record<string, unknown>;
  return {
    ...sol61,
    auto_compact_token_limit: built.auto_compact_token_limit,
    shell_type: built.shell_type,
    effective_context_window_percent: built.effective_context_window_percent,
    opencodex_native_source_priority: built.opencodex_native_source_priority,
    slug,
    display_name: configuredNativeOpenAiDisplayName(slug),
    description: HISTORICAL_DESCRIPTION,
    base_instructions: neutralizeIdentity(sol61.base_instructions as string),
    model_messages: { ...messages, instructions_template: neutralizeIdentity(messages.instructions_template as string) },
  };
}

for (const slug of ["gpt-6.2-sol", "gpt-6.2-astra"]) {
  describe(`${slug} historical configured fallback`, () => {
    test("sync promotes an unchanged fallback to the model's own pinned metadata", () => {
      const prior = historicalConfiguredRow(slug);
      const own = upstreamNativeEntry(slug)!;
      expect(prior.experimental_supported_tools).not.toEqual(own.experimental_supported_tools);
      const result = mergeRetained(prior);
      expect(result.experimental_supported_tools).toEqual(own.experimental_supported_tools);
      expect(result.model_messages).toEqual(own.model_messages);
      expect(result.display_name).toBe(own.display_name);
    });

    test("sync keeps a fallback with any user edit, including fields outside the instructions and tools", () => {
      for (const edit of [
        { base_instructions: "User's instructions" },
        { model_messages: { instructions_template: "User's template" } },
        { experimental_supported_tools: ["clock"] },
        { service_tiers: [{ id: "ultrafast", name: "Ultra Fast", description: "operator supplied" }] },
        { additional_speed_tiers: ["fast", "ultrafast"] },
        { default_service_tier: "ultrafast" },
        { description: "User's description" },
        { input_modalities: ["text"] },
        { tool_mode: "user-custom" },
        { operator_note: "kept" },
        { constructor: "operator" },
        { toString: "operator" },
        { shell_type: "none" },
        { effective_context_window_percent: 12 },
      ]) {
        const result = mergeRetained({ ...historicalConfiguredRow(slug), ...edit });
        for (const [key, value] of Object.entries(edit)) expect(result[key]).toEqual(value);
      }
    });
  });
}
