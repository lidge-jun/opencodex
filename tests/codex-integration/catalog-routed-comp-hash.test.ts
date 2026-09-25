import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../../src/codex/catalog";
import {
  buildCatalogEntriesFromObservedState,
  CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
  mergeCatalogEntriesFromObservedState,
} from "../../src/codex/catalog/sync";
import type { RawEntry } from "../../src/codex/catalog/parsing";

/**
 * A routed row is cloned from whichever native row a rebuild picks as the template, and it
 * used to keep that row's `comp_hash` (#5796). Codex compacts a thread when consecutive turns
 * record different values, so a rebuild that picked another template compacted every active
 * routed thread.
 */
describe("catalog routed comp_hash (#5796)", () => {
  const routedHash = (compHash: string | undefined) => buildCatalogEntries(
    {
      slug: "gpt-5.5",
      display_name: "gpt-5.5",
      description: "Native GPT model",
      priority: 1,
      visibility: "list",
      base_instructions: "You are Codex, a coding agent based on GPT-5.",
      ...(compHash === undefined ? {} : { comp_hash: compHash }),
    },
    [],
    [{ provider: "local", id: "qwen3-coder" }],
  ).find(e => e.slug === "local/qwen3-coder")?.comp_hash;

  test("routed rows keep one value whichever native row is the template", () => {
    expect(routedHash("3000")).toBe("opencodex");
    expect(routedHash("2911")).toBe("opencodex");
    expect(routedHash(undefined)).toBe("opencodex");
  });

  test("a row kept from disk during a provider outage drops a copied value", () => {
    const merge = (catalogModels: readonly RawEntry[], routedEntries: readonly RawEntry[], degraded: boolean) =>
      mergeCatalogEntriesFromObservedState({
        catalogModels, routedEntries, baselineCatalogModels: [], baseline: new Map(), featured: [],
        wsEnabled: false, template: null, disabledModels: new Set(), selectedModelsByProvider: new Map(),
        gatheredProviderNames: new Set(["local"]),
        degradedProviderNames: new Set(degraded ? ["local"] : []),
        legacyCustomModelSlugs: new Set(), multiAgentMode: "default", multiAgentV2Enabled: false,
        exactComboSlugs: new Set(), hasPhysicalComboProvider: false, includeNativeOpenAi: true,
        accountBoundEntries: [],
        policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, warningPolicy: "suppress" },
      });
    const fresh = buildCatalogEntriesFromObservedState({
      template: null, gptSlugs: [], goModels: [{ provider: "local", id: "qwen3-coder" }],
      featured: [], modelPickerOrder: [], wsEnabled: false, multiAgentMode: "default",
      exactComboSlugs: new Set(), accountSelectors: [], suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(), multiAgentV2Enabled: false,
    });
    // A catalog written before the fix, where the routed row still carries a template's value,
    // plus a row another tool wrote under the same provider. That one is not ours to change.
    const saved = merge([], fresh, false).map(entry =>
      entry.slug === "local/qwen3-coder" ? { ...entry, comp_hash: "3000" } : entry);
    const foreign = {
      ...saved.find(entry => entry.slug === "local/qwen3-coder")!,
      slug: "local/imported",
      description: "Imported model",
    };
    const kept = merge([...saved, foreign], [], true);
    const hash = (slug: string) => kept.find(entry => entry.slug === slug)?.comp_hash;
    expect(hash("local/qwen3-coder")).toBe("opencodex");
    expect(hash("local/imported")).toBe("3000");
  });
});
