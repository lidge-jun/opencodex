import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, saveConfig } from "../../src/config";
import { setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import { clearModelCache } from "../../src/codex/model-cache";
import { CatalogGatherBusyError } from "../../src/codex/catalog/routed-gather";
import {
  loadExportModels,
  previewExportModels,
  resetExportSnapshotForTests,
} from "../../src/server/management/model-rows";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { createTestCaseLifecycle } from "../helpers/test-sandbox-cleanup";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

/**
 * The export roster (`loadExportModels`) is the ONE loader behind `/api/client-config`, the
 * Integrations picker and the CLI model list. It reaches providers through `gatherRoutedModels`
 * rather than `fetchAllModels`, so when it is the FIRST consumer of a discovery the effective
 * `newModelPolicy` must still apply before the arrival can be published to a client (#6260).
 *
 * These cases drive the real loader against a fake local upstream and check the observable
 * contract: a policy-disabled arrival is absent from the export and persisted, the baseline is
 * absorbed, a manual re-enable survives the next export, a preview never gathers or writes, and a
 * failed persistence publishes nothing.
 */
const provider = "export-fixture";
const existing = ["model-a", "model-b"];
const arrival = "model-c";
const now = "2026-01-01T00:00:00Z";

let home: TempHome;
let lifecycle: ReturnType<typeof createTestCaseLifecycle>;
let ids: string[] = [];
let discoveries: string[][] = [];
let upstream: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  home = createTempHome("ocx-model-export-");
  mkdirSync(home.codexHome, { recursive: true });
  lifecycle = createTestCaseLifecycle();
  // `lastExportSnapshot` is module state shared by every case in this process.
  resetExportSnapshotForTests();
  clearModelCache(provider);
});

afterEach(async () => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  try {
    await lifecycle.close();
  } finally {
    resetExportSnapshotForTests();
    clearModelCache(provider);
    home.remove();
  }
});

function startUpstream(beforeRespond?: () => void): void {
  ids = [...existing];
  discoveries = [];
  upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/v1/models") {
      return new Response("Unexpected upstream request", { status: 404 });
    }
    discoveries.push([...ids]);
    beforeRespond?.();
    return Response.json({ data: ids.map(id => ({ id })) });
  } });
  lifecycle.ownStop(() => upstream.stop(true));
}

/** Persist a baseline whose known roster is already A/B, so C is a genuine new arrival. */
function seedConfig(policy: { global: "on" | "off"; local?: "on" | "off" }): void {
  const config: OcxConfig = {
    port: 0, hostname: "127.0.0.1", defaultProvider: provider,
    providers: { [provider]: {
      adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href,
      apiKey: "fixture-key", allowPrivateNetwork: true, liveModels: true, models: [...existing],
      ...(policy.local === undefined ? {} : { newModelPolicy: policy.local }),
    } },
    modelDiscovery: { newModelPolicy: policy.global, knownModels: {
      [provider]: { ids: [...existing], removed: [], updatedAt: now },
    } },
  };
  saveConfig(config);
}

/** The export roster as a client sees it, restricted to this fixture's provider. */
async function exportIds(): Promise<string[]> {
  const models = await loadExportModels(loadConfig());
  return models.filter(model => model.provider === provider).map(model => model.namespaced).sort();
}

const cases: Array<{ name: string; global: "on" | "off"; local?: "on" | "off"; visible: boolean }> = [
  { name: "provider override off beats global on", global: "on", local: "off", visible: false },
  { name: "inherited global off", global: "off", visible: false },
  { name: "control: inherited global on keeps the arrival", global: "on", visible: true },
];

test.each(cases)("export as first consumer: $name", policy => lifecycle.run(async () => {
  startUpstream();
  seedConfig(policy);
  // The seeded baseline already resolves to A/B on both sides, so nothing arrives yet.
  expect(await exportIds()).toEqual([`${provider}/model-a`, `${provider}/model-b`]);

  ids = [...existing, arrival];
  clearModelCache(provider);
  const before = discoveries.length;
  const after = await exportIds();
  // Fresh roster read, not a stale cache: the arrival came from a new upstream fetch.
  expect(discoveries.length).toBeGreaterThan(before);
  expect(discoveries.at(-1)).toEqual([...existing, arrival]);
  expect(after).toContain(`${provider}/model-a`);
  expect(after).toContain(`${provider}/model-b`);
  // Direct reason, before any persistence claim: the published roster must already agree with
  // the effective policy on the very first export that discovers the arrival.
  if (policy.visible) expect(after).toContain(`${provider}/model-c`);
  else expect(after).not.toContain(`${provider}/model-c`);

  const persisted = loadConfig();
  expect(persisted.modelDiscovery?.knownModels?.[provider]?.ids).toEqual([...existing, arrival]);
  expect(persisted.modelDiscovery?.recentArrivals?.[provider] ?? [])
    .toContainEqual(expect.objectContaining({ id: arrival }));
  if (policy.visible) {
    expect(persisted.disabledModels ?? []).not.toContain(`${provider}/model-c`);
  } else {
    expect(persisted.disabledModels ?? []).toContain(`${provider}/model-c`);
  }
}), SERVER_BUDGET_MS);

test("a manual re-enable survives the next export because the first export absorbed the arrival",
  () => lifecycle.run(async () => {
    startUpstream();
    seedConfig({ global: "off" });

    ids = [...existing, arrival];
    clearModelCache(provider);
    expect(await exportIds()).not.toContain(`${provider}/model-c`);
    expect(loadConfig().disabledModels ?? []).toContain(`${provider}/model-c`);

    // Drop the auto-added disable — the operator re-enabling the arrival in the Models tab.
    const reenabled = loadConfig();
    reenabled.disabledModels = (reenabled.disabledModels ?? []).filter(slug => slug !== `${provider}/model-c`);
    saveConfig(reenabled);
    clearModelCache(provider);
    const before = discoveries.length;
    const after = await exportIds();
    // The baseline absorbed C on the first export, so it is no longer new and must stay visible.
    expect(discoveries.length).toBeGreaterThan(before);
    expect(after).toContain(`${provider}/model-c`);
    expect(loadConfig().disabledModels ?? []).not.toContain(`${provider}/model-c`);
  }), SERVER_BUDGET_MS);

test("a mid-gather configuration change falls back to the pre-gather projection",
  () => lifecycle.run(async () => {
    // Land the operator's manual disable while the discovery request is open: after the export
    // captured its admission, before the gather resolves. The decision is then stale.
    let mutated = false;
    startUpstream(() => {
      if (mutated) return;
      mutated = true;
      const live = loadConfig();
      live.disabledModels = [...(live.disabledModels ?? []), `${provider}/model-b`];
      saveConfig(live);
    });
    seedConfig({ global: "off" });
    ids = [...existing, arrival];
    clearModelCache(provider);

    const after = await exportIds();
    expect(mutated).toBe(true);
    // Pre-gather projection: B was not disabled when the roster was admitted, so A and B survive,
    // and the stale Off decision still hides C because the policy applies to the projection in
    // memory without committing anything.
    expect(after).toContain(`${provider}/model-a`);
    expect(after).toContain(`${provider}/model-b`);
    expect(after).not.toContain(`${provider}/model-c`);

    // The stale decision never commits: the live/disk manual disable stands, the arrival is not
    // absorbed into the persisted baseline, and no snapshot is retained for a preview.
    const persisted = loadConfig();
    expect(persisted.disabledModels ?? []).toContain(`${provider}/model-b`);
    expect(persisted.disabledModels ?? []).not.toContain(`${provider}/model-c`);
    expect(persisted.modelDiscovery?.knownModels?.[provider]?.ids).toEqual([...existing]);
    expect(previewExportModels(loadConfig())).toBeNull();
  }), SERVER_BUDGET_MS);

test("previewExportModels serves the retained roster without gathering or writing",
  () => lifecycle.run(async () => {
    startUpstream();
    seedConfig({ global: "off" });
    ids = [...existing, arrival];
    clearModelCache(provider);

    // The FIRST export is already the authority: it absorbs and persists the arrival, and the
    // retained snapshot must be usable from that load without a second steady-state pass.
    const first = await exportIds();
    expect(first).not.toContain(`${provider}/model-c`);

    const configBefore = readFileSync(home.path("config.json"), "utf8");
    const before = discoveries.length;
    const preview = previewExportModels(loadConfig());
    expect(preview).not.toBeNull();
    // Read-only in both directions: no upstream fetch and no rewrite of the configuration file.
    expect(discoveries.length).toBe(before);
    expect(readFileSync(home.path("config.json"), "utf8")).toBe(configBefore);
    expect(preview!.filter(model => model.provider === provider).map(model => model.namespaced).sort())
      .toEqual(first);
    // A repeated preview is stable: still no gather, still no write.
    expect(previewExportModels(loadConfig())).toEqual(preview);
    expect(discoveries.length).toBe(before);
    expect(readFileSync(home.path("config.json"), "utf8")).toBe(configBefore);
  }), SERVER_BUDGET_MS);

test("a persistence failure raises CatalogGatherBusyError and publishes nothing",
  () => lifecycle.run(async () => {
    startUpstream();
    seedConfig({ global: "off" });
    ids = [...existing, arrival];
    clearModelCache(provider);

    // Corrupt the configuration at the commit seam so the arrival decision cannot persist.
    const corrupt = "{ not-json";
    let hookRan = false;
    setPersistedConfigMutationBeforeCommitForTests(() => {
      hookRan = true;
      writeFileSync(home.path("config.json"), corrupt, "utf8");
    });

    await expect(loadExportModels(loadConfig())).rejects.toThrow(CatalogGatherBusyError);

    // The seam fired, and the refused commit left the corrupt bytes rather than publishing.
    expect(hookRan).toBe(true);
    expect(readFileSync(home.path("config.json"), "utf8")).toBe(corrupt);
  }), SERVER_BUDGET_MS);
