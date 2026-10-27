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

for (const models of [[null, 3, { slug: 5 }], { slug: "gpt-5.6-sol", priority: 1 }]) {
  test(`live HTTP ignores structurally malformed optional backup ${JSON.stringify(models)}`, async () => {
    const slug = "gpt-5.6-sol";
    const next = config(slug);
    saveConfig(next);
    writeFileSync(catalogPath, JSON.stringify({ models: [upstreamNativeEntry(slug)] }), "utf8");
    const server = startServer(0);
    try {
      const url = new URL("/v1/models?client_version=0.160.0", server.url);
      const withoutBackup = await fetch(url);
      expect(withoutBackup.status).toBe(200);
      const expected = await withoutBackup.json();
      const activeBefore = readFileSync(catalogPath, "utf8");
      const backup = JSON.stringify({ models });
      writeFileSync(catalogBackupPathFor(catalogPath), backup, "utf8");
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
      expect(readFileSync(catalogPath, "utf8")).toBe(activeBefore);
      expect(readFileSync(catalogBackupPathFor(catalogPath), "utf8")).toBe(backup);
    } finally { await server.stop(true); }
  });
}

test("live HTTP skips malformed active native rows while retaining valid exact-slug provenance", async () => {
  const slug = "gpt-5.6-sol";
  saveConfig(config(slug));
  const native = { ...upstreamNativeEntry(slug)!, priority: 104, [SOURCE]: 3 };
  writeFileSync(catalogPath, JSON.stringify({ models: [native] }), "utf8");
  const server = startServer(0);
  try {
    const url = new URL("/v1/models?client_version=0.160.0", server.url);
    const clean = await fetch(url);
    expect(clean.status).toBe(200);
    const expected = await clean.json() as { models: RawEntry[] };
    expect(expected.models.find(row => row.slug === slug)?.[SOURCE]).toBe(3);
    const malformed = JSON.stringify({ models: [null, 3, [], { slug: 5 }, native] });
    writeFileSync(catalogPath, malformed, "utf8");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(readFileSync(catalogPath, "utf8")).toBe(malformed);
  } finally { await server.stop(true); }
});

test("retained sync ignores malformed backup rows and preserves the backup bytes", async () => {
  const slug = "gpt-5.6-sol";
  const native = upstreamNativeEntry(slug)!;
  const next = config(slug);
  saveConfig(next);
  writeFileSync(catalogPath, JSON.stringify({ models: [native] }), "utf8");
  const backup = JSON.stringify({ models: [3, [], { slug: 5 }, { ...native, priority: 9 }] });
  writeFileSync(catalogBackupPathFor(catalogPath), backup, "utf8");
  const result = await syncCatalogModels(next, { allowWhenDesiredDisabled: true });
  expect(result.refreshOutcome).toBe("committed");
  expect(readRows(catalogPath).find(row => row.slug === slug)?.priority).toBe(110);
  expect(readFileSync(catalogBackupPathFor(catalogPath), "utf8")).toBe(backup);
});

test("retained sync preserves pre-existing rejection of null recovery rows outside provenance", async () => {
  const next = config("gpt-5.6-sol");
  saveConfig(next);
  const active = JSON.stringify({ models: [upstreamNativeEntry("gpt-5.6-sol")] });
  const backup = JSON.stringify({ models: [null] });
  writeFileSync(catalogPath, active, "utf8");
  writeFileSync(catalogBackupPathFor(catalogPath), backup, "utf8");
  try {
    await syncCatalogModels(next, { allowWhenDesiredDisabled: true });
    throw new Error("Expected the existing native recovery rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).stack).toContain("mergeCatalogModelsWithNativeRecovery");
  }
  expect(readFileSync(catalogPath, "utf8")).toBe(active);
  expect(readFileSync(catalogBackupPathFor(catalogPath), "utf8")).toBe(backup);
});
