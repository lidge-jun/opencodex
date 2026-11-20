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

/** The row an earlier release wrote for a configured gpt-6.2-* slug: GPT-6.1 Sol's payload, neutralized. */
function historicalConfiguredRow(slug: string): RawEntry {
  const temporary = "gpt-6.2-before-registration";
  setConfiguredNativeOpenAiModels([temporary]);
  let row: RawEntry;
  try { row = structuredClone(buildCatalogEntries(null, [temporary], [])[0]!); } finally { setConfiguredNativeOpenAiModels([]); }
  const sol61 = structuredClone(upstreamNativeEntry("gpt-6.1-sol")!);
  const messages = sol61.model_messages as Record<string, unknown>;
  return {
    ...row,
    slug,
    display_name: configuredNativeOpenAiDisplayName(slug),
    description: HISTORICAL_DESCRIPTION,
    base_instructions: neutralizeIdentity(sol61.base_instructions as string),
    model_messages: { ...messages, instructions_template: neutralizeIdentity(messages.instructions_template as string) },
    experimental_supported_tools: sol61.experimental_supported_tools,
    service_tiers: sol61.service_tiers,
    additional_speed_tiers: sol61.additional_speed_tiers,
    default_service_tier: sol61.default_service_tier,
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

    test("sync keeps a fallback whose instructions, tools or speed tiers the user edited", () => {
      for (const edit of [
        { base_instructions: "User's instructions" },
        { model_messages: { instructions_template: "User's template" } },
        { experimental_supported_tools: ["clock"] },
        { service_tiers: [{ id: "ultrafast", name: "Ultra Fast", description: "operator supplied" }] },
        { additional_speed_tiers: ["fast", "ultrafast"] },
        { default_service_tier: "ultrafast" },
        { description: "User's description" },
      ]) {
        const result = mergeRetained({ ...historicalConfiguredRow(slug), ...edit });
        for (const [key, value] of Object.entries(edit)) expect(result[key]).toEqual(value);
      }
    });
  });
}
