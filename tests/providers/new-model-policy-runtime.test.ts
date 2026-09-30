import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig, saveConfig } from "../../src/config";
import { armClaudeCodeBaseline, saveConfigPreservingClaudeCode } from "../../src/config/live-reconcile";
import { setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import { clearModelCache, observeModelCacheRevision, setCached } from "../../src/codex/model-cache";
import { captureModelDiscoveryBaseline, finalizeModelDiscovery } from "../../src/providers/new-model-policy-runtime";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
const rows = ["a", "b", "c"].map(id => ({ provider: "vendor", id }));
const stamp = "2026-01-01T00:00:00Z";
function fixture(): OcxConfig {
  return { port: 10100, defaultProvider: "vendor", providers: { vendor: {
    adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", models: ["a", "b"], newModelPolicy: "off",
  } }, disabledModels: ["vendor/b"], modelDiscovery: {
    knownModels: { vendor: { ids: ["a", "b"], removed: [], updatedAt: stamp } },
  } };
}
const bytes = () => readFileSync(home.path("config.json"), "utf8");
function complete(config: OcxConfig, providers = ["vendor"]) {
  return finalizeModelDiscovery(config, captureModelDiscoveryBaseline(config), rows, providers, new Map());
}
beforeEach(() => { home = createTempHome("ocx-arrival-persistence-"); });
afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  clearModelCache("vendor");
  home.remove();
});

test("discovery persists arrival and disable together, then preserves a manual enable without rewriting", () => {
  saveConfig(fixture());
  const config = loadConfig();
  expect(complete(config)).toBe(true);
  expect(loadConfig().disabledModels).toEqual(["vendor/b", "vendor/c"]);
  expect(loadConfig().modelDiscovery?.knownModels?.vendor.ids).toEqual(["a", "b", "c"]);
  const enabled = loadConfig();
  enabled.disabledModels = ["vendor/b"];
  saveConfig(enabled);
  const before = bytes();
  expect(complete(config)).toBe(true);
  expect(config.disabledModels).toEqual(["vendor/b"]);
  expect(bytes()).toBe(before);
});

test("a concurrent writer's manual enable and unrelated edit survive mutation rebasing", () => {
  saveConfig(fixture());
  const config = loadConfig();
  setPersistedConfigMutationBeforeCommitForTests(() => {
    const concurrent = loadConfig();
    concurrent.modelDiscovery!.knownModels!.vendor.ids.push("c");
    concurrent.disabledModels = ["vendor/b"];
    concurrent.defaultModel = "a";
    writeFileSync(home.path("config.json"), JSON.stringify(concurrent));
  });
  expect(complete(config)).toBe(true);
  expect(config.disabledModels).toEqual(["vendor/b"]);
  expect(loadConfig().defaultModel).toBe("a");
});

test("stale discovery cannot update a replaced provider or expose an uncommitted result", () => {
  saveConfig(fixture());
  const config = loadConfig();
  const baseline = captureModelDiscoveryBaseline(config);
  const replacement = loadConfig();
  replacement.providers.vendor.baseUrl = "https://replacement.invalid/v1";
  saveConfig(replacement);
  const before = bytes();
  expect(finalizeModelDiscovery(config, baseline, rows, ["vendor"], new Map())).toBe(false);
  expect(bytes()).toBe(before);
  expect(config.modelDiscovery?.knownModels?.vendor.ids).toEqual(["a", "b"]);
});

test("a superseded cache snapshot is refused before advancing the baseline", () => {
  saveConfig(fixture());
  const config = loadConfig();
  const baseline = captureModelDiscoveryBaseline(config);
  const revisions = new Map([["vendor", observeModelCacheRevision("vendor")]]);
  setCached("vendor", rows);
  const before = bytes();
  expect(finalizeModelDiscovery(config, baseline, rows, ["vendor"], revisions)).toBe(false);
  expect(bytes()).toBe(before);
});

test("degraded discovery never advances the baseline or records arrivals", () => {
  saveConfig(fixture());
  const config = loadConfig();
  const before = bytes();
  expect(complete(config, [])).toBe(true);
  expect(bytes()).toBe(before);
  expect(config.modelDiscovery?.recentArrivals).toBeUndefined();
});

test("a first authoritative discovery bootstraps without hiding the existing catalog", () => {
  const initial = fixture();
  delete initial.modelDiscovery;
  saveConfig(initial);
  const config = loadConfig();
  expect(complete(config)).toBe(true);
  expect(config.disabledModels).toEqual(["vendor/b"]);
  expect(loadConfig().modelDiscovery?.knownModels?.vendor.ids).toEqual(["a", "b", "c"]);
});

test("standalone and unrelated synthetic configurations never replace persisted provider state", () => {
  const standalone = fixture();
  expect(complete(standalone)).toBe(true);
  expect(standalone.disabledModels).toContain("vendor/c");
  const persisted = fixture();
  persisted.providers.vendor.baseUrl = "https://other.invalid/v1";
  saveConfig(persisted);
  const before = bytes();
  expect(complete(fixture())).toBe(true);
  expect(bytes()).toBe(before);
});

test("failed persistence refuses publication and does not advance in-memory discovery", () => {
  saveConfig(fixture());
  const config = loadConfig();
  setPersistedConfigMutationBeforeCommitForTests(() => writeFileSync(home.path("config.json"), "invalid"));
  expect(complete(config)).toBe(false);
  expect(config.modelDiscovery?.knownModels?.vendor.ids).toEqual(["a", "b"]);
  expect(config.disabledModels).toEqual(["vendor/b"]);
  expect(bytes()).toBe("invalid");
});

test("repeated discovery of a partial roster does not write or advance removal grace", () => {
  saveConfig(fixture());
  const config = loadConfig();
  const before = bytes();
  for (let poll = 0; poll < 4; poll++) {
    expect(finalizeModelDiscovery(config, captureModelDiscoveryBaseline(config),
      [{ provider: "vendor", id: "a" }], ["vendor"], new Map())).toBe(true);
  }
  expect(bytes()).toBe(before);
  expect(config.modelDiscovery?.knownModels?.vendor.ids).toEqual(["a", "b"]);
  expect(config.modelDiscovery?.knownModels?.vendor.missing).toBeUndefined();
});

test("a stale file-backed discovery preserves another writer's enabled model through an unrelated save", () => {
  saveConfig(fixture());
  const config = loadConfig();
  armClaudeCodeBaseline(config);
  const concurrent = loadConfig();
  concurrent.providers.vendor.models!.push("c");
  concurrent.modelDiscovery!.knownModels!.vendor.ids.push("c");
  saveConfig(concurrent);
  const before = bytes();

  const published = complete(config);
  expect(bytes()).toBe(before);
  config.contextCapValue = 320000;
  saveConfigPreservingClaudeCode(config);
  expect(loadConfig().disabledModels).toEqual(["vendor/b"]);
  expect(loadConfig().providers.vendor.models).toEqual(["a", "b", "c"]);
  expect(loadConfig().contextCapValue).toBe(320000);
  expect(config.disabledModels).toEqual(["vendor/b"]);
  expect(published).toBe(false);
});


test.each([false, true])("an unarmed file-backed caller rejects stale discovery (detached baseline: %s)", detached => {
  saveConfig(fixture());
  const config = loadConfig();
  const concurrent = loadConfig();
  concurrent.providers.vendor.models!.push("c");
  concurrent.modelDiscovery!.knownModels!.vendor.ids.push("c");
  saveConfig(concurrent);
  const before = bytes();
  const input = detached ? structuredClone(config) : config;
  const baseline = captureModelDiscoveryBaseline(input);
  expect(finalizeModelDiscovery(config, baseline, rows, ["vendor"], new Map())).toBe(false);
  expect(config.disabledModels).toEqual(["vendor/b"]);
  expect(config.modelDiscovery?.knownModels?.vendor.ids).toEqual(["a", "b"]);
  expect(bytes()).toBe(before);
});

test("a file-backed provider replaced before discovery cannot be treated as synthetic", () => {
  saveConfig(fixture());
  const config = loadConfig();
  const replacement = loadConfig();
  replacement.providers.vendor.baseUrl = "https://replacement.invalid/v1";
  saveConfig(replacement);
  const before = bytes();
  expect(complete(config)).toBe(false);
  expect(config.disabledModels).toEqual(["vendor/b"]);
  expect(bytes()).toBe(before);
});

test("file-backed discovery cannot publish to a different config home", () => {
  saveConfig(fixture());
  const config = loadConfig();
  const other = createTempHome("ocx-arrival-other-home-");
  try {
    saveConfig(fixture());
    const before = readFileSync(other.path("config.json"), "utf8");
    expect(complete(config)).toBe(false);
    expect(config.disabledModels).toEqual(["vendor/b"]);
    expect(readFileSync(other.path("config.json"), "utf8")).toBe(before);
  } finally {
    other.remove();
  }
});
