import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalogEntriesFromObservedState, mergeCatalogEntriesFromObservedState } from "../../src/codex/catalog/build-entries";
import { deriveEntry } from "../../src/codex/catalog/derive-entry";
import { setConfiguredNativeOpenAiModels, setDiscoveredNativeOpenAiModels, resetConfiguredNativeOpenAiModelsForTests } from "../../src/codex/catalog/native-models";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Literal wire key lets these behavioral regressions run against the pre-fix tree too.
const SOURCE = "opencodex_native_source_priority";
const ids = ["gpt-9-priority-a", "gpt-9-priority-b", "gpt-9-priority-c"];
const featured = ["fixture/f1", "fixture/f2", "fixture/f3", "fixture/f4"];
const routed = [...featured.map(slug => ({ provider: "fixture", id: slug.split("/")[1]! })), { provider: "fixture", id: "filler" }];
let home: string;
let previousHome: string | undefined;
const row = (slug: string, priority?: unknown): RawEntry => ({
  slug, priority, display_name: `Native ${slug}`, supported_in_api: true, visibility: "list",
  supported_reasoning_levels: [{ effort: "high", description: "High" }],
});
const get = (rows: RawEntry[], slug: string) => rows.find(row => row.slug === slug)!;
const priorities = (rows: RawEntry[]) => ids.map(id => get(rows, id).priority);
function build(picks = featured, selectors: string[] = [], template: RawEntry | null = null) {
  return buildCatalogEntriesFromObservedState({ template, gptSlugs: ids, goModels: routed,
    featured: picks, wsEnabled: false, multiAgentMode: "default", exactComboSlugs: new Set(),
    accountSelectors: selectors, suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
    multiAgentV2Enabled: false });
}
function merge(rows: RawEntry[], baseline = new Map<string, number>(), picks = featured) {
  return mergeCatalogEntriesFromObservedState({ catalogModels: rows, baselineCatalogModels: [],
    routedEntries: build(picks).filter(row => String(row.slug).includes("/")), baseline, featured: picks,
    wsEnabled: false, template: null, disabledModels: new Set(), selectedModelsByProvider: new Map(),
    gatheredProviderNames: new Set(["fixture"]), degradedProviderNames: new Set(), legacyCustomModelSlugs: new Set(),
    multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(),
    hasPhysicalComboProvider: false, includeNativeOpenAi: true, accountBoundEntries: [],
    policy: { nativeBackfillSlugs: ids, unsupportedNativeEntries: "preserve", warningPolicy: "suppress" } });
}
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-native-priority-"));
  process.env.OPENCODEX_HOME = home;
  setDiscoveredNativeOpenAiModels(ids.map((id, i) => row(id, [3, 8, undefined][i])));
});
afterEach(() => {
  setDiscoveredNativeOpenAiModels([]);
  resetConfiguredNativeOpenAiModelsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

test("four featured precede distinct discovered native source priorities including fallback", () => {
  const rows = merge(ids.map(id => row(id)));
  expect(priorities(rows)).toEqual([107, 112, 113]);
  expect(featured.map(id => get(rows, id).priority)).toEqual([0, 1, 2, 3]);
  expect(ids.map(id => get(rows, id)[SOURCE])).toEqual([3, 8, 9]);
  expect(priorities(build())).toEqual([107, 112, 113]);
});
test("current descriptor supersedes a stale pristine baseline", () => {
  expect(priorities(merge(ids.map(id => row(id)), new Map(ids.map(id => [id, 1]))))).toEqual([107, 112, 105]);
});
test("repeated publication never compounds the native band", () => {
  const first = merge(ids.map(id => row(id)));
  expect(priorities(merge(merge(first)))).toEqual([107, 112, 113]);
});
test("an upstream priority swap reorders the next publication", () => {
  const first = merge(ids.map(id => row(id)));
  setDiscoveredNativeOpenAiModels(ids.map((id, i) => row(id, [8, 3, undefined][i])));
  expect(priorities(merge(first))).toEqual([112, 107, 113]);
});
test("expired descriptors without baseline use only exact-slug retained provenance", () => {
  const first = merge(ids.map(id => row(id)));
  setDiscoveredNativeOpenAiModels([]);
  setConfiguredNativeOpenAiModels(ids);
  expect(priorities(merge(merge(first)))).toEqual([107, 112, 113]);
});
test("featuring then unfeaturing restores source order", () => {
  const first = merge(ids.map(id => row(id)), new Map(), [ids[0]!, ...featured]);
  expect(get(first, ids[0]!).priority).toBe(0);
  expect(get(first, ids[0]!)[SOURCE]).toBe(3);
  expect(priorities(merge(first))).toEqual([107, 112, 113]);
  expect(priorities(merge(first, new Map(), []))).toEqual([3, 8, 9]);
});
for (const invalid of [-200, 3.5, NaN, "3", 1e9]) {
  test(`invalid source priority ${String(invalid)} falls back without preceding featured`, () => {
    setDiscoveredNativeOpenAiModels(ids.map(id => row(id, invalid)));
    expect(priorities(merge(ids.map(id => row(id, invalid))))).toEqual([113, 113, 113]);
    expect(priorities(build())).toEqual([113, 113, 113]);
  });
}
test("invalid candidates skip to the next valid provenance and ignore legacy published rank", () => {
  setDiscoveredNativeOpenAiModels(ids.map(id => row(id, -200)));
  const rows = ids.map(id => ({ ...row(id, 0), [SOURCE]: 6, opencodex_spawn_priority: 0 }));
  expect(priorities(merge(rows, new Map(ids.map(id => [id, 3.5]))))).toEqual([110, 110, 110]);
  setDiscoveredNativeOpenAiModels([]);
  expect(priorities(merge(ids.map(id => row(id, 0))))).toEqual([113, 113, 113]);
});
test("unfeatured routed filler stays at five ahead of the native band", () => {
  const rows = merge(ids.map(id => row(id)));
  expect(get(rows, "fixture/filler").priority).toBe(5);
  expect(priorities(rows)).toEqual([107, 112, 113]);
});
for (const selectors of [[], ["account"], ["account", "second"]]) {
  test(`source ceiling 1000 preserves existing ${selectors.length}-selector stride policy`, () => {
    setDiscoveredNativeOpenAiModels(ids.map(id => row(id, 1000)));
    const rows = build(featured, selectors);
    expect(priorities(rows)).toEqual([1104, 1104, 1104]);
    expect(featured.map(id => get(rows, id).priority)).toEqual(selectors.length === 2 ? [0, 2, 4, 6] : [0, 1, 2, 3]);
    for (const [index, selector] of selectors.entries()) {
      expect(ids.map(id => get(rows, `${selector}/${id}`).priority)).toEqual(ids.map((_, n) => (4 + n) * selectors.length + index));
    }
    const nativeFeatured = build([ids[0]!, ...featured.slice(0, 3)], selectors);
    expect(get(nativeFeatured, ids[0]!).priority).toBe(0);
    expect(featured.slice(0, 3).map(id => get(nativeFeatured, id).priority)).toEqual(selectors.length === 2 ? [2, 4, 6] : [1, 2, 3]);
    for (const [index, selector] of selectors.entries()) {
      expect(get(nativeFeatured, `${selector}/${ids[0]}`).priority).toBe(index);
    }
  });
}
test("a template cloned into another native or routed identity loses source provenance", () => {
  const template = { ...row("gpt-9-template", 107), [SOURCE]: 3 };
  expect(deriveEntry(template, "fixture/routed", "Routed", 5, { provider: "fixture", id: "routed" })[SOURCE]).toBeUndefined();
  setDiscoveredNativeOpenAiModels([]);
  expect(deriveEntry(template, "gpt-9-unknown", "Native", 9)[SOURCE]).toBeUndefined();
});

test("unfeatured baseline nine is assigned after upstream derivation and overrides retained three", () => {
  const rows = buildCatalogEntriesFromObservedState({ template: null, gptSlugs: ["gpt-5.6-sol"], goModels: [],
    featured: [], wsEnabled: false, multiAgentMode: "default", exactComboSlugs: new Set(),
    accountSelectors: [], suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
    multiAgentV2Enabled: false, nativeSource: { baseline: new Map([["gpt-5.6-sol", 9]]), retainedBySlug: new Map([["gpt-5.6-sol", 3]]) } });
  expect(get(rows, "gpt-5.6-sol").priority).toBe(9);
  expect(get(rows, "gpt-5.6-sol")[SOURCE]).toBe(9);
});
