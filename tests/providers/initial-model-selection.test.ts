import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configStore from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { filterCatalogVisibleModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { initializeProviderModelSelection, reconcileInitialModelSelections } from "../../src/providers/initial-model-selection";
import { captureInitialSelectionBaseline, finalizeInitialModelSelection, resolvePendingInitialModelSelection } from "../../src/providers/initial-model-selection-runtime";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { safeConfigDTO, providerEditorConfigDTO } from "../../src/server/auth-cors";
import { handleManagementAPI } from "../../src/server/management-api";
import { upsertOAuthProvider } from "../../src/oauth";
import { commitKeyLoginProvider } from "../../src/oauth/login-cli";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";

let home = "";
let previousHome: string | undefined;
let codex: IsolatedCodexHome;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-initial-selection-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("ocx-initial-selection-codex-");
});
afterEach(async () => {
  clearModelCache();
  await flushConfigDirHardeningForTests();
  codex.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function fixture(count = 20): OcxConfig {
  const provider: OcxProviderConfig = {
    adapter: "openai-chat", baseUrl: "https://models.example.test/v1", authMode: "key",
    apiKey: "fixture-key", liveModels: false,
    models: Array.from({ length: count }, (_, i) => `model-${i}`),
  };
  initializeProviderModelSelection("vendor", provider);
  return { port: 0, defaultProvider: "vendor", providers: { vendor: provider }, clientIntegrations: { codex: false } };
}
function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({ provider: "vendor", id: `model-${i}` }));
}
async function api(config: OcxConfig, path: string, body?: unknown, method = "PUT"): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  const response = await handleManagementAPI(new ManagementRequest(url, body === undefined ? {} : {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), url, config, { createManagementConvergeCodex: catalogConvergenceFactory() });
  if (!response) throw new Error("route missing");
  return response;
}

describe("initial provider model switches", () => {
  test.each([0, 19, 20])("authoritative %i-row boundary keeps the provider active", count => {
    const config = fixture(count);
    expect(reconcileInitialModelSelections(config, rows(count), ["vendor"])).toBe(true);
    expect(config.providers.vendor.initialModelSelection).toEqual({ version: 1, registrationId: expect.any(String), status: count >= 20 ? "all-off" : "ready", modelCount: count });
    expect(config.providers.vendor.disabled).not.toBe(true);
    expect(config.disabledModels ?? []).toHaveLength(count >= 20 ? count : 0);
    expect(reconcileInitialModelSelections(config, rows(count), ["vendor"])).toBe(false);
  });

  test("counts duplicate selectors once and metadata overrides as real switch rows", () => {
    const config = fixture();
    const listed = [...rows(19), { provider: "vendor", id: "model-0", custom: true }];
    reconcileInitialModelSelections(config, listed, ["vendor"]);
    expect(config.providers.vendor.initialModelSelection?.modelCount).toBe(19);
    expect(config.disabledModels).toBeUndefined();
    const withExtraRow = fixture();
    reconcileInitialModelSelections(withExtraRow, [...listed, { provider: "vendor", id: "additional-catalog-id" }], ["vendor"]);
    expect(withExtraRow.providers.vendor.initialModelSelection?.status).toBe("all-off");
    expect(withExtraRow.disabledModels).toContain("vendor/additional-catalog-id");
  });

  test("OFF preserves unrelated exclusions, uses canonical IDs and never repeats", () => {
    const config = fixture();
    config.disabledModels = ["other/keep", "vendor/a/b"];
    const listed = [...rows(19), { provider: "vendor", id: "a/b" }];
    reconcileInitialModelSelections(config, listed, ["vendor"]);
    expect(config.disabledModels).toHaveLength(21);
    expect(config.disabledModels).toContain("other/keep");
    config.disabledModels = config.disabledModels.filter(id => id !== "vendor/model-0");
    expect(reconcileInitialModelSelections(config, listed, ["vendor"])).toBe(false);
    expect(config.disabledModels).not.toContain("vendor/model-0");
  });

  test("OAuth and ChatGPT forwarding are exempt, mixed-auth key connections are not", () => {
    for (const name of ["openai", "cursor", "xai"]) {
      const provider = providerConfigSeed(getProviderRegistryEntry(name)!);
      initializeProviderModelSelection(name, provider);
      expect(provider.initialModelSelection).toBeUndefined();
    }
    const key = providerConfigSeed(getProviderRegistryEntry("xai")!);
    key.authMode = "key";
    key.apiKey = "fixture-key";
    initializeProviderModelSelection("xai", key);
    expect(key.initialModelSelection?.status).toBe("pending");
    const local = { adapter: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", authMode: "local" } satisfies OcxProviderConfig;
    initializeProviderModelSelection("local-test", local);
    expect((local as OcxProviderConfig).initialModelSelection?.status).toBe("pending");
  });

  test("existing selections and marker survive provider replacement and OAuth upsert", () => {
    const existing = fixture().providers.vendor;
    existing.selectedModels = ["chosen"];
    existing.modelPreset = { mode: "custom" };
    existing.newModelPolicy = "off";
    existing.initialModelSelection = { ...existing.initialModelSelection!, status: "all-off", modelCount: 20 };
    const replacement: OcxProviderConfig = { adapter: "openai-chat", baseUrl: existing.baseUrl };
    initializeProviderModelSelection("vendor", replacement, existing);
    expect(replacement.selectedModels).toEqual(["chosen"]);
    expect(replacement.modelPreset).toEqual({ mode: "custom" });
    expect(replacement.newModelPolicy).toBe("off");
    expect(replacement.initialModelSelection).toEqual(existing.initialModelSelection);
    const xai = providerConfigSeed(getProviderRegistryEntry("xai")!);
    xai.selectedModels = ["grok-4.6"];
    const config: OcxConfig = { port: 0, defaultProvider: "xai", providers: { xai } };
    upsertOAuthProvider(config, "xai");
    expect(config.providers.xai.selectedModels).toEqual(["grok-4.6"]);
    expect(config.providers.xai.initialModelSelection).toBeUndefined();
  });

  test("an unresolved mixed-auth key follows the router's OAuth exemption", () => {
    const env = "OCX_INITIAL_SELECTION_KEY_FIXTURE";
    const previous = process.env[env];
    delete process.env[env];
    try {
      const provider = providerConfigSeed(getProviderRegistryEntry("xai")!);
      provider.authMode = "key";
      provider.apiKey = `\${${env}}`;
      initializeProviderModelSelection("xai", provider);
      expect(provider.initialModelSelection).toBeUndefined();
      process.env[env] = "fixture-key";
      initializeProviderModelSelection("xai", provider);
      expect(provider.initialModelSelection?.status).toBe("pending");
    } finally {
      if (previous === undefined) delete process.env[env];
      else process.env[env] = previous;
    }
  });

  test("intentional live/disk listener differences do not fence initial selection forever", async () => {
    const config = fixture();
    configStore.saveConfig(config);
    const baseline = configStore.loadConfig();
    const edited = configStore.loadConfig();
    edited.port = 23456;
    edited.hostname = "127.0.0.2";
    configStore.saveConfig(edited);
    configStore.reconcileLiveConfigFromDisk(config, baseline);
    expect(config.port).toBe(0);
    await resolvePendingInitialModelSelection(config);
    expect(config.providers.vendor.initialModelSelection?.status).toBe("all-off");
    expect(config.port).toBe(0);
    expect(configStore.loadConfig().port).toBe(23456);
    expect(configStore.loadConfig().hostname).toBe("127.0.0.2");
    expect(configStore.loadConfig().disabledModels).toHaveLength(20);
  });

  test("management discovery finalizes and persists with Codex integration OFF", async () => {
    const config = fixture();
    configStore.saveConfig(config);
    expect(config.clientIntegrations?.codex).toBe(false);
    const response = await api(config, "/api/models");
    expect(response.status).toBe(200);
    const listed = (await response.json()).filter((row: { provider: string }) => row.provider === "vendor");
    expect(listed).toHaveLength(20);
    expect(listed.every((row: { disabled: boolean }) => row.disabled)).toBe(true);
    expect(config.providers.vendor.initialModelSelection?.status).toBe("all-off");
    const saved = configStore.loadConfig();
    expect(saved.providers.vendor.initialModelSelection?.modelCount).toBe(20);
    expect(saved.disabledModels).toHaveLength(20);
    expect(filterCatalogVisibleModels(rows(20), saved)).toEqual([]);
  });

  test("POST creation stamps its own pending state and overwrite preserves selections", async () => {
    const config: OcxConfig = { ...configStore.getDefaultConfig(), port: 0, clientIntegrations: { codex: false } };
    configStore.saveConfig(config);
    const provider = {
      adapter: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", allowPrivateNetwork: true,
      liveModels: false, models: rows(20).map(row => row.id),
      initialModelSelection: { version: 1, registrationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "ready" },
    };
    expect((await api(config, "/api/providers", { name: "vendor", provider }, "POST")).status).toBe(200);
    const created = config.providers.vendor;
    expect(created.initialModelSelection?.status).toBe("pending");
    const registrationId = created.initialModelSelection?.registrationId;
    expect(registrationId).not.toBe(provider.initialModelSelection.registrationId);
    created.selectedModels = ["model-2"];
    created.modelPreset = { mode: "custom" };
    configStore.saveConfig(config);
    expect((await api(config, "/api/providers", { name: "vendor", provider }, "POST")).status).toBe(200);
    const saved = configStore.loadConfig().providers.vendor;
    expect(saved.selectedModels).toEqual(["model-2"]);
    expect(saved.modelPreset).toEqual({ mode: "custom" });
    expect(saved.initialModelSelection?.registrationId).toBe(registrationId);
    expect(saved.disabled).not.toBe(true);
  });

  test("new registration clears orphaned OFF selectors without touching other providers", async () => {
    const config: OcxConfig = {
      ...configStore.getDefaultConfig(), port: 0, clientIntegrations: { codex: false },
      disabledModels: ["vendor/model-0", "vendor/a/b", "vendor-old/keep", "other/keep"],
      modelDiscovery: {
        newModelPolicy: "off",
        knownModels: { vendor: { ids: ["old"], removed: [], updatedAt: "old" }, other: { ids: ["keep"], removed: [], updatedAt: "old" } },
        recentArrivals: { vendor: [{ id: "old", at: "old" }] },
      },
    };
    configStore.saveConfig(config);
    const provider = { adapter: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", allowPrivateNetwork: true, liveModels: false, models: ["model-0", "a/b"] };
    expect((await api(config, "/api/providers", { name: "vendor", provider }, "POST")).status).toBe(200);
    await api(config, "/api/models");
    expect(configStore.loadConfig().disabledModels).toEqual(["vendor-old/keep", "other/keep"]);
    expect(config.providers.vendor.initialModelSelection?.status).toBe("ready");
    expect(config.providers.vendor.disabled).not.toBe(true);
    expect(configStore.loadConfig().modelDiscovery?.knownModels?.vendor).toBeUndefined();
    expect(configStore.loadConfig().modelDiscovery?.knownModels?.other?.ids).toEqual(["keep"]);
    expect(configStore.loadConfig().modelDiscovery?.recentArrivals?.vendor).toBeUndefined();
  });

  test("new-registration cleanup preserves a current combo alias sharing the namespace", () => {
    const config = fixture();
    config.disabledModels = ["vendor/combo-alias", "vendor/orphan", "other/keep"];
    config.combos = { retained: { alias: "vendor/combo-alias", targets: [{ provider: "other", model: "keep" }] } };
    const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://models.example.test/v1" };
    initializeProviderModelSelection("vendor", provider, undefined, config);
    expect(config.disabledModels).toEqual(["vendor/combo-alias", "other/keep"]);
  });

  test("key-login commit initializes new rows and preserves choices during key replacement", async () => {
    const config: OcxConfig = { ...configStore.getDefaultConfig(), port: 0, clientIntegrations: { codex: false } };
    configStore.saveConfig(config);
    const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://models.example.test/v1", apiKey: "fixture-first" };
    await commitKeyLoginProvider(config, "vendor", provider);
    const first = configStore.loadConfig().providers.vendor;
    expect(first.initialModelSelection?.status).toBe("pending");
    config.providers.vendor.selectedModels = ["chosen"];
    configStore.saveConfig(config);
    await commitKeyLoginProvider(config, "vendor", { ...provider, apiKey: "fixture-second" });
    const saved = configStore.loadConfig().providers.vendor;
    expect(saved.apiKey).toBe("fixture-second");
    expect(saved.selectedModels).toEqual(["chosen"]);
    expect(saved.initialModelSelection?.registrationId).toBe(first.initialModelSelection?.registrationId);
  });

  test("batch editor creates pending state server-side without resetting edited existing rows", async () => {
    const config = fixture();
    config.providers.vendor.baseUrl = "http://127.0.0.1:11434/v1";
    config.providers.vendor.allowPrivateNetwork = true;
    config.disabledModels = ["batch/model-0", "other/keep"];
    configStore.saveConfig(config);
    const registrationId = config.providers.vendor.initialModelSelection?.registrationId;
    const baseline = providerEditorConfigDTO(config);
    const next = structuredClone(baseline);
    next.providers.vendor.selectedModels = ["model-1"];
    next.providers.batch = { adapter: "openai-chat", baseUrl: "http://127.0.0.1:11435/v1", allowPrivateNetwork: true, liveModels: false, models: ["model-0"] };
    const response = await api(config, "/api/providers", { baseline, next });
    expect(response.status).toBe(200);
    const saved = configStore.loadConfig();
    expect(saved.providers.batch.initialModelSelection?.status).toBe("pending");
    expect(saved.providers.batch.disabled).not.toBe(true);
    expect(saved.providers.vendor.initialModelSelection?.registrationId).toBe(registrationId);
    expect(saved.providers.vendor.selectedModels).toEqual(["model-1"]);
    expect(saved.disabledModels).toEqual(["other/keep"]);
    expect(config.disabledModels).toEqual(["other/keep"]);
  });

  test("degraded discovery does not complete initialization or expose models", () => {
    const config = fixture();
    configStore.saveConfig(config);
    const before = readFileSync(configStore.getConfigPath(), "utf8");
    finalizeInitialModelSelection(config, captureInitialSelectionBaseline(config), rows(20), []);
    expect(config.providers.vendor.initialModelSelection?.status).toBe("pending");
    expect(filterCatalogVisibleModels(rows(20), config)).toEqual([]);
    expect(readFileSync(configStore.getConfigPath(), "utf8")).toBe(before);
  });

  test("another initializer and subsequent manual enable are adopted, never overwritten", async () => {
    const config = fixture();
    configStore.saveConfig(config);
    const baseline = captureInitialSelectionBaseline(config);
    const other = configStore.loadConfig();
    await resolvePendingInitialModelSelection(other);
    other.disabledModels = other.disabledModels!.filter(id => id !== "vendor/model-0");
    configStore.saveConfig(other);
    finalizeInitialModelSelection(config, baseline, rows(20), ["vendor"]);
    expect(config.providers.vendor.initialModelSelection?.status).toBe("all-off");
    expect(config.disabledModels).not.toContain("vendor/model-0");
    expect(configStore.loadConfig().disabledModels).not.toContain("vendor/model-0");
  });

  test("a concurrent provider edit invalidates an initial decision", () => {
    const config = fixture();
    configStore.saveConfig(config);
    const baseline = captureInitialSelectionBaseline(config);
    const edited = configStore.loadConfig();
    edited.providers.vendor.selectedModels = ["model-2"];
    configStore.saveConfig(edited);
    finalizeInitialModelSelection(config, baseline, rows(20), ["vendor"]);
    expect(configStore.loadConfig().providers.vendor.selectedModels).toEqual(["model-2"]);
    expect(configStore.loadConfig().disabledModels).toBeUndefined();
  });

  test("failed persistence keeps pending, including management rows and candidate APIs", async () => {
    // The failed write must leave both policy and visibility pending.
    const config = fixture();
    configStore.saveConfig(config);
    writeFileSync(configStore.getConfigPath(), "{invalid");
    const response = await api(config, "/api/models");
    const listed = (await response.json()).filter((row: { provider: string }) => row.provider === "vendor");
    expect(listed).toHaveLength(20);
    expect(listed.every((row: { disabled: boolean; initialSelectionPending: boolean }) => row.disabled && row.initialSelectionPending)).toBe(true);
    const desktop = await api(config, "/api/claude-desktop");
    expect(desktop.status).toBe(200);
    expect((await desktop.json()).models.some((model: { route: string }) => model.route.startsWith("vendor/"))).toBe(false);
    for (const path of ["/api/injection-model", "/api/subagent-model-fallback"]) {
      const candidates = await (await api(config, path)).json();
      expect(JSON.stringify(candidates.available)).not.toContain("vendor/");
    }
    const put = await api(config, "/api/model-visibility", { scope: "provider", provider: "vendor", enabled: true, targets: [{ id: "model-0" }] });
    expect(put.status).toBe(409);
    expect(config.providers.vendor.disabled).not.toBe(true);
    expect(readFileSync(configStore.getConfigPath(), "utf8")).toBe("{invalid");
  });

  test("identical delete and re-registration cannot consume an earlier discovery", () => {
    const old = fixture();
    configStore.saveConfig(old);
    const baseline = captureInitialSelectionBaseline(old);
    const replacement = fixture();
    expect(replacement.providers.vendor.initialModelSelection?.registrationId)
      .not.toBe(old.providers.vendor.initialModelSelection?.registrationId);
    configStore.saveConfig(replacement);
    finalizeInitialModelSelection(old, baseline, rows(20), ["vendor"]);
    const saved = configStore.loadConfig();
    expect(saved.providers.vendor.initialModelSelection?.status).toBe("pending");
    expect(saved.providers.vendor.initialModelSelection?.registrationId).toBe(replacement.providers.vendor.initialModelSelection?.registrationId);
    expect(saved.disabledModels).toBeUndefined();
  });

  test("custom inventory changes invalidate a gathered count", () => {
    const config = fixture(19);
    configStore.saveConfig(config);
    const baseline = captureInitialSelectionBaseline(config);
    const edited = configStore.loadConfig();
    edited.customModels = [{ id: "extra", provider: "vendor", modelId: "extra-model", displayName: "Extra" }];
    configStore.saveConfig(edited);
    finalizeInitialModelSelection(config, baseline, rows(19), ["vendor"]);
    const saved = configStore.loadConfig();
    expect(saved.providers.vendor.initialModelSelection?.status).toBe("pending");
    expect(saved.customModels?.[0].modelId).toBe("extra-model");
  });

  test("a thrown transaction never publishes a completed marker", () => {
    const config = fixture();
    configStore.saveConfig(config);
    const mutation = spyOn(configStore, "mutatePersistedConfig").mockImplementation(() => { throw new Error("fixture failure"); });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      finalizeInitialModelSelection(config, captureInitialSelectionBaseline(config), rows(20), ["vendor"]);
      expect(config.providers.vendor.initialModelSelection?.status).toBe("pending");
      expect(config.disabledModels).toBeUndefined();
    } finally { mutation.mockRestore(); warn.mockRestore(); }
  });

  test("state round-trips as read-only DTO metadata; malformed state does not discard providers", () => {
    const config = fixture();
    configStore.saveConfig(config);
    const loaded = configStore.loadConfig();
    expect(loaded.providers.vendor.initialModelSelection?.status).toBe("pending");
    expect((safeConfigDTO(loaded) as { providers: Record<string, OcxProviderConfig> }).providers.vendor.initialModelSelection?.status).toBe("pending");
    expect(providerEditorConfigDTO(loaded).providers.vendor.initialModelSelection).toBeUndefined();
    writeFileSync(configStore.getConfigPath(), JSON.stringify({ ...config, providers: { vendor: { ...config.providers.vendor, initialModelSelection: { version: 1, status: "invalid" } } } }));
    expect(configStore.loadConfig().providers.vendor.initialModelSelection).toBeUndefined();
    expect(configStore.loadConfig().providers.vendor.apiKey).toBe("fixture-key");
  });
});
