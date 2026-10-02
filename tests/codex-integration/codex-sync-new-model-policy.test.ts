import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import { clearModelCache } from "../../src/codex/model-cache";
import { readCodexCatalogPath } from "../../src/codex/catalog/parsing";
import { refreshCodexModelCatalog } from "../../src/codex/refresh";
import { syncModelsToCodex } from "../../src/codex/sync";
import { syncCodexOnStartIfEnabled } from "../../src/codex/desired-state";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { createTestCaseLifecycle } from "../helpers/test-sandbox-cleanup";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

/**
 * Startup and explicit `syncModelsToCodex` reach the catalog writer through
 * `refreshCodexModelCatalog -> syncCatalogModels` rather than the `fetchAllModels` refresh.
 * These cases pin the contract for that path: a sync-discovered arrival obeys the persisted
 * `newModelPolicy`, is absorbed into the persisted `knownModels` / `recentArrivals` /
 * `disabledModels`, the provider roster is refetched on every sync, a manual re-enable
 * survives because the baseline absorbed the arrival, and a failed arrival-persistence
 * commit publishes no catalog change.
 *
 * The real startup wrapper, the real `syncModelsToCodex`, and the real gathering/catalog
 * writer run here; only the unrelated injection and admission seams are stubbed, as the
 * sibling `codex-sync-api` suite already does.
 */
const provider = "sync-fixture";
const existing = ["model-a", "model-b"];
const arrival = "model-c";
const now = "2026-01-01T00:00:00Z";

let home: TempHome;
let lifecycle: ReturnType<typeof createTestCaseLifecycle>;
let ids: string[] = [];
let discoveries: string[][] = [];
let upstream: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  home = createTempHome("ocx-sync-policy-");
  mkdirSync(home.codexHome, { recursive: true });
  lifecycle = createTestCaseLifecycle();
  clearModelCache(provider);
});

afterEach(async () => {
  try {
    await lifecycle.close();
  } finally {
    setPersistedConfigMutationBeforeCommitForTests(null);
    clearModelCache(provider);
    home.remove();
  }
});

function startUpstream(): void {
  ids = [...existing];
  discoveries = [];
  upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/v1/models") {
      return new Response("Unexpected upstream request", { status: 404 });
    }
    discoveries.push([...ids]);
    return Response.json({ data: ids.map(id => ({ id })) });
  } });
  lifecycle.ownStop(() => upstream.stop(true));
}

/**
 * Give the real writer a Codex catalog to merge into.
 *
 * Without a readable source `syncCatalogModels` refuses before it gathers, and the
 * case would fail for a fixture reason rather than the behavior under test. A `config.toml`
 * pointing at a non-default catalog mirrors the hardened sync suite and keeps the
 * seeded file authoritative.
 */
function seedCodexCatalog(): void {
  writeFileSync(join(home.codexHome, "config.toml"), 'model_catalog_json = "sync-catalog.json"\n', "utf8");
  writeFileSync(join(home.codexHome, "sync-catalog.json"), `${JSON.stringify({ models: [{
    slug: "gpt-5.5", display_name: "GPT-5.5", description: "native", priority: 0,
    visibility: "list", shell_type: "shell_command", comp_hash: "native-comp-hash",
    model_messages: { instructions_template: "You are Codex." },
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [{ effort: "medium", description: "m" }],
  }] }, null, 2)}\n`);
}

function persistedConfig(policy: { global: "on" | "off"; local?: "on" | "off" }): OcxConfig {
  return {
    port: 0, defaultProvider: provider,
    providers: { [provider]: {
      adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href,
      apiKey: "fixture-key", allowPrivateNetwork: true, liveModels: true, models: [...existing],
      ...(policy.local === undefined ? {} : { newModelPolicy: policy.local }),
    } },
    modelDiscovery: { newModelPolicy: policy.global, knownModels: {
      [provider]: { ids: [...existing], removed: [], updatedAt: now },
    } },
  };
}

const deps = {
  // `deps` REPLACES the module defaults (no partial merge), so the real catalog
  // refresh must be listed explicitly or the sync silently swallows an undefined
  // call and writes no catalog.
  refreshCodexModelCatalog,
  admitCodexWrite: () => ({ kind: "admitted" as const }),
  injectCodexConfig: async () => ({ success: true, message: "injected" }),
  currentExternalCodexModelProvider: () => null,
};

/** Real startup gate -> real `syncModelsToCodex` -> real catalog writer. */
async function syncOnStartup(config: OcxConfig): Promise<void> {
  const outcome = await syncCodexOnStartIfEnabled(
    10_100,
    config,
    port => syncModelsToCodex(port, config, null, deps),
  );
  expect(outcome.ran).toBe(true);
}

function catalogSlugs(): string[] {
  const catalog = JSON.parse(readFileSync(readCodexCatalogPath(), "utf8")) as {
    models?: Array<{ slug?: string }>;
  };
  return (catalog.models ?? []).flatMap(entry => typeof entry.slug === "string" ? [entry.slug] : []);
}

test("policy off: a sync-discovered arrival is hidden, disabled, and recorded", () => lifecycle.run(async () => {
    startUpstream();
    seedCodexCatalog();
    const config = persistedConfig({ global: "off" });
    saveConfig(config);
    await syncOnStartup(config);
    // Fixture sanity: the real writer published the two known rows before the arrival.
    expect(catalogSlugs()).toContain(`${provider}/model-a`);
    expect(catalogSlugs()).toContain(`${provider}/model-b`);
    expect(discoveries.at(-1)).toEqual(existing);

    ids = [...existing, arrival];
    clearModelCache(provider);
    const beforeRefetch = discoveries.length;
    await syncOnStartup(config);
    // The sync refetch proves the arrival came from a fresh roster read, not a stale cache.
    expect(discoveries.length).toBeGreaterThan(beforeRefetch);
    expect(discoveries.at(-1)).toEqual([...existing, arrival]);

    const after = catalogSlugs();
    expect(after).toContain(`${provider}/model-a`);
    expect(after).not.toContain(`${provider}/model-c`);

    const persisted = loadConfig();
    expect(persisted.disabledModels ?? []).toContain(`${provider}/model-c`);
    expect(persisted.modelDiscovery?.knownModels?.[provider]?.ids).toEqual([...existing, arrival]);
    expect(persisted.modelDiscovery?.recentArrivals?.[provider] ?? [])
      .toContainEqual(expect.objectContaining({ id: arrival }));
}), SERVER_BUDGET_MS);

test("policy on: the same sync-discovered arrival stays visible", () => lifecycle.run(async () => {
    startUpstream();
    seedCodexCatalog();
    const config = persistedConfig({ global: "on" });
    saveConfig(config);

    ids = [...existing, arrival];
    clearModelCache(provider);
    await syncOnStartup(config);

    expect(discoveries.at(-1)).toEqual([...existing, arrival]);
    expect(catalogSlugs()).toContain(`${provider}/model-c`);
    const persisted = loadConfig();
    expect(persisted.disabledModels ?? []).not.toContain(`${provider}/model-c`);
    expect(persisted.modelDiscovery?.recentArrivals?.[provider] ?? [])
      .toContainEqual(expect.objectContaining({ id: arrival }));
}), SERVER_BUDGET_MS);

test("a manual re-enable holds because the sync absorbed the arrival into the baseline", () => lifecycle.run(async () => {
    startUpstream();
    seedCodexCatalog();
    const config = persistedConfig({ global: "off" });
    saveConfig(config);
    await syncOnStartup(config);

    ids = [...existing, arrival];
    clearModelCache(provider);
    const beforeRefetch = discoveries.length;
    await syncOnStartup(config);
    expect(discoveries.length).toBeGreaterThan(beforeRefetch);
    expect(discoveries.at(-1)).toEqual([...existing, arrival]);
    expect(catalogSlugs()).not.toContain(`${provider}/model-c`);

    // Manual re-enable: drop the auto-added disable and sync again. The baseline already
    // absorbed model-c, so it is no longer a new arrival and must stay visible.
    const reenabled = loadConfig();
    reenabled.disabledModels = (reenabled.disabledModels ?? []).filter(slug => slug !== `${provider}/model-c`);
    saveConfig(reenabled);
    clearModelCache(provider);
    const beforeReenableRefetch = discoveries.length;
    await syncOnStartup(reenabled);

    expect(discoveries.length).toBeGreaterThan(beforeReenableRefetch);
    expect(discoveries.at(-1)).toEqual([...existing, arrival]);
    expect(catalogSlugs()).toContain(`${provider}/model-c`);
    expect(loadConfig().disabledModels ?? []).not.toContain(`${provider}/model-c`);
}), SERVER_BUDGET_MS);

test("an arrival whose persistence fails publishes no catalog change", () => lifecycle.run(async () => {
  startUpstream();
  seedCodexCatalog();
  const config = persistedConfig({ global: "off" });
  saveConfig(config);
  await syncOnStartup(config);
  const catalogBefore = readFileSync(readCodexCatalogPath(), "utf8");
  expect(catalogSlugs()).toContain(`${provider}/model-b`);

  ids = [...existing, arrival];
  clearModelCache(provider);
  // The arrival decision commits through the persisted-mutation coordinator. This one-shot
  // seam corrupts config.json after that decision but before the freshness revalidation, so
  // the commit is unavailable and the catalog must not be republished with the arrival.
  let hookRan = false;
  const corruptConfig = "{ not-json";
  setPersistedConfigMutationBeforeCommitForTests(() => {
    hookRan = true;
    writeFileSync(home.path("config.json"), corruptConfig, "utf8");
  });
  await syncOnStartup(config);

  // The seam must have fired, and the refused commit must have left the corrupt bytes in
  // place rather than rewriting config.json; a vacuous pass would miss both.
  expect(hookRan).toBe(true);
  expect(readFileSync(home.path("config.json"), "utf8")).toBe(corruptConfig);
  expect(readFileSync(readCodexCatalogPath(), "utf8")).toBe(catalogBefore);
  expect(catalogSlugs()).not.toContain(`${provider}/model-c`);
}), SERVER_BUDGET_MS);
