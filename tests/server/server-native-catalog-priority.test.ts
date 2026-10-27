import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { SUBAGENT_MODELS_VERSION } from "../../src/config/subagent-models";
import { startServer } from "../../src/server";
import { invalidateCodexModelsCache, syncCatalogModels, upstreamNativeEntry } from "../../src/codex/catalog";
import { catalogBackupPathFor, type RawEntry } from "../../src/codex/catalog/parsing";
import { resetDiscoveredNativeModelsForTests } from "../../src/codex/catalog/discovered-natives";
import { resetCatalogRuntimeStateForTests } from "../../src/codex/catalog/build-entries";
import { resetConfiguredNativeOpenAiModelsForTests } from "../../src/codex/catalog/native-models";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import type { OcxConfig } from "../../src/types";

setDefaultTimeout(SERVER_BUDGET_MS);
const SOURCE = "opencodex_native_source_priority";
let home: TempHome;
let catalogPath: string;
beforeEach(() => {
  home = createTempHome("ocx-live-priority-");
  mkdirSync(home.codexHome);
  catalogPath = join(home.codexHome, "priority-catalog.json");
  writeFileSync(join(home.codexHome, "config.toml"), 'model_catalog_json = "priority-catalog.json"\n', "utf8");
  resetCatalogRuntimeStateForTests();
});
afterEach(async () => {
  resetDiscoveredNativeModelsForTests();
  resetConfiguredNativeOpenAiModelsForTests();
  resetCatalogRuntimeStateForTests();
  await removeTreeAfterBackgroundWork(home.root);
  home.remove();
});
const readRows = (path: string): RawEntry[] => JSON.parse(readFileSync(path, "utf8")).models;
const config = (slug: string, featured = ["fixture/featured"]): OcxConfig => ({
  port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", subagentModels: featured,
  subagentModelsVersion: SUBAGENT_MODELS_VERSION, catalogAutoRefresh: { enabled: false },
  providers: {
    openai: { adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward", models: [slug] },
    fixture: { adapter: "openai-chat", baseUrl: "https://priority-fixture.invalid/v1", liveModels: false, models: ["featured"] },
  },
});
async function checkSurfaces(next: OcxConfig, slug: string, priority: number, source: number) {
  saveConfig(next);
  const synced = await syncCatalogModels(next, { allowWhenDesiredDisabled: true });
  expect(synced.refreshOutcome).toBe("committed");
  invalidateCodexModelsCache({ allowWhenDesiredDisabled: true });
  const server = startServer(0);
  try {
    const before = readFileSync(catalogPath, "utf8");
    const cacheBefore = readFileSync(join(home.codexHome, "models_cache.json"), "utf8");
    const response = await fetch(new URL("/v1/models?client_version=0.160.0", server.url));
    expect(response.status).toBe(200);
    const live = (await response.json() as { models: RawEntry[] }).models;
    const published = readRows(catalogPath);
    const cached = readRows(join(home.codexHome, "models_cache.json"));
    expect([live, published, cached].map(rows => rows.find(row => row.slug === slug)?.priority)).toEqual([priority, priority, priority]);
    expect([live, published, cached].map(rows => rows.find(row => row.slug === slug)?.[SOURCE])).toEqual([source, source, source]);
    expect(readFileSync(catalogPath, "utf8")).toBe(before);
    expect(readFileSync(join(home.codexHome, "models_cache.json"), "utf8")).toBe(cacheBefore);
  } finally { await server.stop(true); }
}
test("live HTTP, published catalog and cache honor pristine 9 over static snapshot 4", async () => {
  const slug = "gpt-5.6-sol";
  const native = upstreamNativeEntry(slug)!;
  expect(native.priority).toBe(4);
  writeFileSync(catalogPath, JSON.stringify({ models: [native] }), "utf8");
  writeFileSync(catalogBackupPathFor(catalogPath), JSON.stringify({ models: [{ ...native, priority: 9 }] }), "utf8");
  await checkSurfaces(config(slug), slug, 110, 9);
});
test("without descriptor or baseline exact-slug source beats snapshot across live, repeated sync and feature/unfeature", async () => {
  const slug = "gpt-5.6-sol";
  const native = upstreamNativeEntry(slug)!;
  expect(native.priority).toBe(4);
  writeFileSync(catalogPath, JSON.stringify({ models: [
    { ...native, priority: 104, [SOURCE]: 3 },
    { slug: "fixture/featured", description: "Routed via fixture", priority: 0, visibility: "list" },
  ] }), "utf8");
  // An existing malformed backup is unavailable, never a reason for an HTTP writer to repair it.
  writeFileSync(catalogBackupPathFor(catalogPath), "{corrupt", "utf8");
  await checkSurfaces(config(slug), slug, 104, 3);
  await checkSurfaces(config(slug), slug, 104, 3);
  await checkSurfaces(config(slug, [slug]), slug, 0, 3);
  await checkSurfaces(config(slug), slug, 104, 3);
  expect(readFileSync(catalogBackupPathFor(catalogPath), "utf8")).toBe("{corrupt");
});
