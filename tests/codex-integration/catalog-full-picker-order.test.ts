import { expect, test } from "bun:test";
import { buildCatalogEntriesFromObservedState, mergeCatalogEntriesFromObservedState, CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, applyFullModelPickerOrder, deriveEntry, mergeCatalogEntriesForSync, SPAWN_PRIORITY_FIELD } from "../../src/codex/catalog/sync";

test("native-first picker order preserves Go subagent ranks and is repeatable", () => {
  const rows: any[] = [
    { slug: "opencode-go/glm-5.3", priority: 0 },
    { slug: "gpt-5.6-sol", priority: 9 },
    { slug: "gpt-6-astra", priority: 9 },
  ];
  const order = ["gpt-6-astra", "gpt-5.6-sol", "opencode-go/glm-5.3"];
  applyFullModelPickerOrder(rows, order);
  expect([...rows].sort((a,b) => a.priority-b.priority).map(r => r.slug)).toEqual(order);
  expect(rows.map(r => r[SPAWN_PRIORITY_FIELD])).toEqual([0,9,9]);
  const once = structuredClone(rows);
  applyFullModelPickerOrder(rows, order);
  expect(rows).toEqual(once);
});

test("existing routed-only ordering retains its behavior", () => {
  const rows: any[] = [{ slug: "opencode-go/glm-5.3", priority: 1000 }];
  applyFullModelPickerOrder(rows, ["opencode-go/glm-5.3"]);
  expect(rows).toEqual([{ slug: "opencode-go/glm-5.3", priority: 1000 }]);
});


test("sync refreshes native spawn rank when featured models change", () => {
  const sol = deriveEntry(null, "gpt-5.6-sol", "Sol", 105);
  const order = ["gpt-5.6-sol"];
  applyFullModelPickerOrder([sol], order);
  expect(sol[SPAWN_PRIORITY_FIELD]).toBe(105);

  const baseline = new Map([["gpt-5.6-sol", 9]]);
  const promoted = mergeCatalogEntriesForSync([sol], [], baseline, ["gpt-5.6-sol"], false);
  applyFullModelPickerOrder(promoted, order);
  expect(promoted.find(entry => entry.slug === sol.slug)?.[SPAWN_PRIORITY_FIELD]).toBe(0);

  const demoted = mergeCatalogEntriesForSync(promoted, [], baseline, ["opencode-go/glm-5.3"], false);
  applyFullModelPickerOrder(demoted, order);
  expect(demoted.find(entry => entry.slug === sol.slug)?.[SPAWN_PRIORITY_FIELD]).toBe(101);
});


test("bare native ids and routed slugs match exactly, without suffix aliases", () => {
  const rows: any[] = [
    { slug: "openai/gpt-5.6-sol", priority: 2 },
    { slug: "gpt-5.6-sol", priority: 9 },
    { slug: "other/gpt-5.6-sol", priority: 3 },
  ];
  applyFullModelPickerOrder(rows, ["gpt-5.6-sol", "openai/gpt-5.6-sol"]);
  expect(rows.map(row => row.priority)).toEqual([1, 0, 5]);
  expect(rows.map(row => row[SPAWN_PRIORITY_FIELD])).toEqual([2, 9, 3]);
});

test.each([
  { order: [] as string[] },
  { order: ["opencode-go/glm-5.3"] },
  { order: ["other/model", "opencode-go/glm-5.3"] },
])("degraded discovery clears previous full ordering for %j", ({ order }) => {
  for (const accountSelectors of [[], ["account-a", "account-b"]]) {
    const slug = "opencode-go/glm-5.3";
    const fresh = (modelPickerOrder: string[]) => buildCatalogEntriesFromObservedState({
      template: null, gptSlugs: [],
      goModels: [{ id: "glm-5.3", provider: "opencode-go", name: "GLM 5.3", reasoningEfforts: ["high", "max"] }],
      featured: [], modelPickerOrder, wsEnabled: false, multiAgentMode: "default",
      exactComboSlugs: new Set(), accountSelectors, suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(), multiAgentV2Enabled: false,
    });
    const merge = (catalogModels: Record<string, unknown>[], routedEntries: Record<string, unknown>[], modelPickerOrder: string[], degraded: boolean) =>
      mergeCatalogEntriesFromObservedState({
        catalogModels, routedEntries, modelPickerOrder, accountSelectors,
        baselineCatalogModels: [], baseline: new Map(), featured: [], wsEnabled: false,
        template: null, disabledModels: new Set(), selectedModelsByProvider: new Map(),
        gatheredProviderNames: new Set(["opencode-go"]),
        degradedProviderNames: new Set(degraded ? ["opencode-go"] : []),
        legacyCustomModelSlugs: new Set(), multiAgentMode: "default", multiAgentV2Enabled: false,
        exactComboSlugs: new Set(), hasPhysicalComboProvider: false, includeNativeOpenAi: true,
        accountBoundEntries: [],
        policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, warningPolicy: "silent" },
      });
    const fullOrder = ["gpt-5.6-sol", slug];
    const previous = merge([], fresh(fullOrder), fullOrder, false);
    const saved = structuredClone(previous);
    const healthy = merge(previous, fresh(order), order, false);
    const degraded = merge(previous, [], order, true);
    const row = (entries: Record<string, unknown>[]) => entries.find(entry => entry.slug === slug)!;
    expect(row(degraded).priority).toBe(row(healthy).priority);
    expect(row(degraded)[SPAWN_PRIORITY_FIELD]).toBe(row(healthy)[SPAWN_PRIORITY_FIELD]);
    expect(merge(degraded, [], order, true)).toEqual(degraded);
    expect(previous).toEqual(saved);
  }
});
