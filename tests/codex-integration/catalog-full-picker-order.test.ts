import { routedSlug } from "../../src/providers/slug-codec";
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
  { order: ["gpt-5.6-sol", "opencode-go/glm-5.3"], after: ["opencode-go/glm-5.3"] },
  { order: ["gpt-5.6-sol", "opencode-go/glm-5.3"], before: ["opencode-go/glm-5.3"], after: [] },
  { order: ["gpt-5.6-sol", "opencode-go/team/model"], modelId: "team/model", before: ["other/model", "opencode-go/team/model"], after: ["opencode-go/team/model", "other/model"] },

  { order: ["", "opencode-go/glm-5.3"] },
  { order: [" ", "opencode-go/glm-5.3"] },
  { order: [""] },
  { order: ["opencode-go/team/model"], modelId: "team/model" },
  { order: ["opencode-go/glm-5.3"] },
  { order: ["other/model", "opencode-go/glm-5.3"] },
])("degraded discovery refreshes ranks and remains stable for %j", ({ order, modelId = "glm-5.3", before = [], after = [] }) => {
  for (const accountSelectors of [[], ["account-a", "account-b"]]) {
    const slug = routedSlug("opencode-go", modelId);
    const fresh = (modelPickerOrder: readonly string[], featured: readonly string[] = []) => buildCatalogEntriesFromObservedState({
      template: null, gptSlugs: [],
      goModels: [{ id: modelId, provider: "opencode-go", displayName: "GLM 5.3", reasoningEfforts: ["high", "max"] }],
      featured, modelPickerOrder, wsEnabled: false, multiAgentMode: "default",
      exactComboSlugs: new Set(), accountSelectors, suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(), multiAgentV2Enabled: false,
    });
    const merge = (catalogModels: Record<string, unknown>[], routedEntries: Record<string, unknown>[], modelPickerOrder: readonly string[], degraded: boolean, featured: readonly string[] = []) =>
      mergeCatalogEntriesFromObservedState({
        catalogModels, routedEntries, modelPickerOrder, accountSelectors,
        baselineCatalogModels: [], baseline: new Map(), featured, wsEnabled: false,
        template: null, disabledModels: new Set(), selectedModelsByProvider: new Map(),
        gatheredProviderNames: new Set(["opencode-go"]),
        degradedProviderNames: new Set(degraded ? ["opencode-go"] : []),
        legacyCustomModelSlugs: new Set(), multiAgentMode: "default", multiAgentV2Enabled: false,
        exactComboSlugs: new Set(), hasPhysicalComboProvider: false, includeNativeOpenAi: true,
        accountBoundEntries: [],
        policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, warningPolicy: "suppress" },
      });
    const fullOrder = ["gpt-5.6-sol", slug];
    const previous = merge([], fresh(fullOrder, before), fullOrder, false, before);
    const saved = structuredClone(previous);
    const healthy = merge(previous, fresh(order, after), order, false, after);
    const degraded = merge(previous, [], order, true, after);
    const row = (entries: Record<string, unknown>[]) => entries.find(entry => entry.slug === slug)!;
    expect(row(degraded).priority).toBe(row(healthy).priority);
    expect(row(degraded)[SPAWN_PRIORITY_FIELD]).toBe(row(healthy)[SPAWN_PRIORITY_FIELD]);
    expect(merge(degraded, [], order, true, after)).toEqual(degraded);
    expect(previous).toEqual(saved);
  }
});


test("full ordering ignores empty entries and accepts raw upstream ids with slashes", () => {
  const slug = routedSlug("vendor", "team/model");
  const rows = [{ slug, priority: 1000 }, { slug: "gpt-5.6-sol", priority: 9 }];
  applyFullModelPickerOrder(rows, ["", "gpt-5.6-sol", "vendor/team/model"]);
  expect(rows.map(row => row.priority)).toEqual([1, 0]);
  const exact = [{ slug, priority: 5 }];
  applyFullModelPickerOrder(exact, ["gpt-5.6-sol", slug, "vendor/team/model"]);
  expect(exact[0]!.priority).toBe(1);
});
