import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../../src/codex/catalog";
import {
  buildCatalogEntriesFromObservedState,
  CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
  deriveEntry,
  mergeCatalogEntriesFromObservedState,
  mergeCatalogEntriesForSync,
} from "../../src/codex/catalog/sync";
import { ensureStrictCatalogFields } from "../../src/codex/catalog/parsing";
import type { RawEntry } from "../../src/codex/catalog/parsing";

describe("catalog routed comp_hash (#5796)", () => {
  const template = (compHash: string | null | undefined): RawEntry => ({
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    ...(compHash === undefined ? {} : { comp_hash: compHash }),
  });

  const routedEntry = (entries: RawEntry[], slug = "local/qwen3-coder") =>
    entries.find(entry => entry.slug === slug)!;

  const mergeOutage = (catalogModels: readonly RawEntry[], routedEntries: readonly RawEntry[]) =>
    mergeCatalogEntriesFromObservedState({
      catalogModels,
      routedEntries,
      baselineCatalogModels: [],
      baseline: new Map(),
      featured: [],
      wsEnabled: false,
      template: null,
      disabledModels: new Set(),
      selectedModelsByProvider: new Map(),
      gatheredProviderNames: new Set(["local"]),
      degradedProviderNames: new Set(["local"]),
      legacyCustomModelSlugs: new Set(),
      multiAgentMode: "default",
      multiAgentV2Enabled: false,
      exactComboSlugs: new Set(),
      hasPhysicalComboProvider: false,
      includeNativeOpenAi: true,
      accountBoundEntries: [],
      policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, warningPolicy: "suppress" },
    });

  test("generic routed rows have unknown hashes for every native template shape", () => {
    for (const nativeHash of ["3000", "2911", null, undefined] as const) {
      const row = routedEntry(buildCatalogEntries(
        template(nativeHash), [], [{ provider: "local", id: "qwen3-coder" }],
      ));
      expect(row.comp_hash).toBeNull();
      expect(JSON.parse(JSON.stringify(row)).comp_hash).toBeNull();
    }
  });

  test("derivation strips native hashes while native and canonical Codex-forward rows keep theirs", () => {
    const nativeTemplate = template("native-template-hash");
    const generic = deriveEntry(nativeTemplate, "local/model", "Routed model", 5, {
      provider: "local", id: "model", contextWindow: 256_000,
      maxInputTokens: 180_000, autoCompactTokenLimit: 150_000,
    });
    expect(generic).toMatchObject({
      comp_hash: null,
      context_window: 256_000,
      max_context_window: 256_000,
      auto_compact_token_limit: 150_000,
    });

    expect(ensureStrictCatalogFields({ slug: "gpt-5.5", comp_hash: "native-authoritative" }).comp_hash)
      .toBe("native-authoritative");
    expect(deriveEntry(template("native-template-hash"), "openai/gpt-6-sol", "Forward", 5, {
      provider: "openai", id: "gpt-6-sol", codexForwardNativeCapabilityAlias: true,
    }).comp_hash).toBe("3000");
  });

  test("strict normalization makes absent or invalid hashes explicit null and preserves known values", () => {
    for (const [value, expected] of [
      [undefined, null], [null, null], [42, null], ["", ""], ["upstream-hash", "upstream-hash"],
    ] as const) {
      const row: RawEntry = { slug: "provider/model", ...(value === undefined ? {} : { comp_hash: value }) };
      expect(ensureStrictCatalogFields(row, { isRouted: true }).comp_hash).toBe(expected);
      expect(Object.hasOwn(row, "comp_hash")).toBe(true);
    }
  });

  test("rebuild and JSON roundtrip keep the normalized routed row stable", () => {
    const fresh = buildCatalogEntries(template("native-template-hash"), [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const first = mergeCatalogEntriesForSync([], fresh, new Map(), [], false);
    const persisted = JSON.parse(JSON.stringify(first)) as RawEntry[];
    const second = mergeCatalogEntriesForSync(persisted, fresh, new Map(), [], false);
    expect(routedEntry(first)).toEqual(routedEntry(second));
    expect(routedEntry(second).comp_hash).toBeNull();
  });

  test.each(["3000", "opencodex"] as const)(
    "outage migration clears the old %s routed hash without mutating input or foreign hashes",
    oldHash => {
    const fresh = buildCatalogEntriesFromObservedState({
      template: null, gptSlugs: [], goModels: [{ provider: "local", id: "qwen3-coder" }],
      featured: [], modelPickerOrder: [], wsEnabled: false, multiAgentMode: "default",
      exactComboSlugs: new Set(), accountSelectors: [], suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(), multiAgentV2Enabled: false,
    });
    const saved = fresh.map(entry => entry.slug === "local/qwen3-coder"
      ? { ...entry, comp_hash: oldHash } : entry);
    const foreign = {
      ...routedEntry(saved), slug: "local/imported", description: "Imported model", comp_hash: "foreign-valid-hash",
    };
    const input = structuredClone([...saved, foreign]);
    const kept = mergeOutage(input, []);
    expect(input).toEqual(structuredClone([...saved, foreign]));
    expect(routedEntry(kept).comp_hash).toBeNull();
    expect(routedEntry(kept, "local/imported").comp_hash).toBe("foreign-valid-hash");
  });

  test.each(["3000", "opencodex"] as const)(
    "fresh and retained public native aliases normalize old %s hashes to null", oldHash => {
    const alias = "gpt-5.6-sol";
    const built = buildCatalogEntriesFromObservedState({
      template: template("3000"), gptSlugs: [alias],
      goModels: [{ provider: "combo", id: "nova-sol", alias, nativeAlias: true, owned_by: "combo" }],
      featured: [], modelPickerOrder: [], wsEnabled: false, multiAgentMode: "default",
      exactComboSlugs: new Set([alias]), accountSelectors: [], suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(), multiAgentV2Enabled: false,
    });
    const freshAlias = built.find(entry => entry.slug === alias)!;
    expect(freshAlias.comp_hash).toBeNull();

    const staleAlias = { ...freshAlias, comp_hash: oldHash };
    const kept = mergeCatalogEntriesFromObservedState({
      catalogModels: [staleAlias], routedEntries: [], baselineCatalogModels: [], baseline: new Map(),
      featured: [], wsEnabled: false, template: null, disabledModels: new Set(),
      selectedModelsByProvider: new Map(), gatheredProviderNames: new Set(), degradedProviderNames: new Set(),
      legacyCustomModelSlugs: new Set(), multiAgentMode: "default", multiAgentV2Enabled: false,
      exactComboSlugs: new Set([alias]), hasPhysicalComboProvider: false, includeNativeOpenAi: true,
      suppressedBareNativeSlugs: new Set([alias]), accountBoundEntries: [],
      policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, warningPolicy: "suppress" },
    }).find(entry => entry.slug === alias)!;
    expect(kept.comp_hash).toBeNull();
  });
});
