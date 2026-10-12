import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildCatalogEntries, filterCatalogVisibleModels, gatherRoutedModels, uniqueCatalogModelsForPublicList, uniqueCatalogModelsForRawPublicList } from "../../src/codex/catalog";
import { mergeCatalogEntriesFromObservedState } from "../../src/codex/catalog/build-entries";
import { clearModelCache } from "../../src/codex/model-cache";
import { resolveAntigravityEffortWireModel } from "../../src/providers/antigravity-models";
import { projectAntigravitySelectedModels } from "../../src/providers/antigravity-effort-families";
import { reconcileSuccessfulModelDiscoveries } from "../../src/providers/new-model-policy";
import { listManagementModelRows } from "../../src/server/management/model-rows";
import type { OcxConfig } from "../../src/types";

const originalHome = process.env.OPENCODEX_HOME;
let testHome: string;
beforeEach(() => { testHome = mkdtempSync(join(tmpdir(), "ocx-agy-family-")); process.env.OPENCODEX_HOME = testHome; });
afterEach(() => {
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(testHome);
});

const provider = "google-antigravity";
const base = "claude-opus-5-5";
const baseUrl = "https://daily-cloudcode-pa.googleapis.com";
const tiers = ["low", "medium", "high"];
const originalFetch = globalThis.fetch;
afterEach(() => { clearModelCache(provider); globalThis.fetch = originalFetch; });
function cca(family = base) {
  const ids = ["high", "low", "medium"].map(effort => `${family}-${effort}`);
  return { models: Object.fromEntries(ids.map(id => [id, { maxTokens: 350_000, supportsImages: true }])),
    agentModelSorts: [{ groups: [{ modelIds: ids }] }] };
}
function config(): OcxConfig {
  return { port: 0, defaultProvider: provider, providers: { [provider]: {
    adapter: "google", authMode: "key", apiKey: "fixture-token", baseUrl,
    googleMode: "cloud-code-assist", liveModels: true, project: "fixture-project",
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch,
  } } };
}

test("cold, cached and refreshed catalog retain discovered family efforts and wire routing", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json(cca()); }) as typeof fetch;
  const cfg = config();
  const first = await gatherRoutedModels(cfg);
  expect(first.map(row => row.id)).toEqual([base]);
  expect(first[0]).toMatchObject({ reasoningEfforts: tiers, defaultReasoningEffort: "medium", suppressSyntheticMax: true });
  const entries = buildCatalogEntries(null, [], first);
  // Ultra is OpenCodex's existing orchestration mode, not another upstream tier.
  const levels = entries[0]?.supported_reasoning_levels as Array<{ effort: string }>;
  expect(levels.map(level => level.effort).filter(effort => effort !== "ultra")).toEqual(tiers);
  expect(entries[0]?.default_reasoning_level).toBe("medium");
  expect(await gatherRoutedModels(cfg)).toEqual(first);
  expect(calls).toBe(1);
  expect(resolveAntigravityEffortWireModel(base, "low", baseUrl)).toEqual({ wireModelId: `${base}-low` });
  clearModelCache(provider);
  globalThis.fetch = (async () => { calls++; return Response.json(cca("claude-sonnet-6-1")); }) as typeof fetch;
  const refreshed = await gatherRoutedModels(cfg);
  expect(refreshed.map(row => row.id)).toEqual(["claude-sonnet-6-1"]);
  expect(refreshed[0]?.reasoningEfforts).toEqual(tiers);
  expect(resolveAntigravityEffortWireModel("claude-sonnet-6-1", "high", baseUrl))
    .toEqual({ wireModelId: "claude-sonnet-6-1-high" });
});

test("explicit empty reasoning override survives discovery and cached reads", async () => {
  globalThis.fetch = (async () => Response.json(cca())) as typeof fetch;
  const cfg = config();
  cfg.providers[provider]!.modelReasoningEfforts = { [base]: [] };
  expect((await gatherRoutedModels(cfg))[0]?.reasoningEfforts).toEqual([]);
  expect((await gatherRoutedModels(cfg))[0]?.reasoningEfforts).toEqual([]);
});

test("policy off, suffix selections and retained defaults stay grouped through management and final merge", async () => {
  globalThis.fetch = (async () => Response.json(cca())) as typeof fetch;
  const cfg = config();
  cfg.providers[provider]!.models = [`${base}-high`];
  cfg.providers[provider]!.retainModels = [`${base}-high`];
  cfg.providers[provider]!.defaultModel = `${base}-high`;
  cfg.providers[provider]!.selectedModels = [`${base}-high`];
  cfg.providers[provider]!.newModelPolicy = "off";
  cfg.disabledModels = [`${provider}/${base}-low`, `${provider}/${base}-medium`];
  cfg.modelDiscovery = { knownModels: { [provider]: { ids: tiers.map(tier => `${base}-${tier}`), removed: [], updatedAt: "2026-10-01T00:00:00Z" } } };
  const rows = await gatherRoutedModels(cfg);
  expect(rows.map(row => row.id)).toContain(`${base}-high`);
  reconcileSuccessfulModelDiscoveries({ config: cfg, models: rows, authoritativeProviders: [provider], now: "2026-10-03T00:00:00Z" });
  expect(cfg.disabledModels).not.toContain(`${provider}/${base}`);
  expect(cfg.providers[provider]!.defaultModel).toBe(`${base}-high`);
  const visible = filterCatalogVisibleModels(rows, cfg);
  expect(visible.map(row => row.id)).toEqual([base]);
  expect(uniqueCatalogModelsForPublicList(rows).map(row => row.id)).toEqual([base]);
  expect(uniqueCatalogModelsForRawPublicList(rows).map(row => row.id)).toEqual([base]);
  const management = (await listManagementModelRows(cfg, { models: rows })).filter(row => row.provider === provider);
  expect(management).toHaveLength(1);
  expect(management[0]).toMatchObject({ id: base, disabled: false, reasoningEfforts: tiers });
  const entries = buildCatalogEntries(null, [], visible);
  const merged = mergeCatalogEntriesFromObservedState({
    catalogModels: [], baselineCatalogModels: [], routedEntries: entries, baseline: new Map(), featured: [],
    wsEnabled: false, template: null, disabledModels: new Set(cfg.disabledModels),
    selectedModelsByProvider: new Map([[provider, new Set(projectAntigravitySelectedModels(provider, cfg.providers[provider]!.selectedModels!, rows))]]),
    gatheredProviderNames: new Set([provider]), degradedProviderNames: new Set(), legacyCustomModelSlugs: new Set(),
    multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(), hasPhysicalComboProvider: false,
    includeNativeOpenAi: false, accountBoundEntries: [],
    policy: { nativeBackfillSlugs: [], unsupportedNativeEntries: "drop", warningPolicy: "suppress" },
  });
  expect(merged.map(entry => entry.slug)).toEqual([`${provider}/${base}`]);
  expect(resolveAntigravityEffortWireModel(`${base}-high`, "low", baseUrl)).toEqual({ wireModelId: `${base}-high` });
});
