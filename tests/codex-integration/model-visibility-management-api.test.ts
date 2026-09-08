import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeModelRows } from "../../src/codex/catalog";
import { loadConfig, saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { listManagementModelRows, type ManagementModelRow } from "../../src/server/management/model-rows";
import { routedSlug } from "../../src/providers/slug-codec";

const TEST_DIR = join(import.meta.dir, `.tmp-model-visibility-management-${process.pid}`);
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let refreshes = 0;

beforeEach(() => {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-model-visibility-codex-");
  refreshes = 0;
  saveConfig({
    port: 0,
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        liveModels: false,
        models: ["claude-opus-4-6-thinking", "claude-sonnet-4-6", "gemini-3.1-pro", "gemini-3.6-flash", "gpt-oss-120b-medium", "vendor/model"],
        selectedModels: ["gemini-3.1-pro", "gemini-3.6-flash"],
      },
    },
    combos: {
      free: { alias: "fast-chat", targets: [{ provider: "google-antigravity", model: "gemini-3.1-pro" }] },
      plain: { targets: [{ provider: "google-antigravity", model: "gemini-3.6-flash" }] },
    },
    disabledModels: ["google-antigravity/gpt-oss-120b-medium", "google-antigravity/temporarily-missing", "other/keep"],
  });
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

async function putWithConfig(body: unknown, config = loadConfig()): Promise<Response> {
  const url = new URL("http://localhost/api/model-visibility");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), url, config, { createManagementConvergeCodex: catalogConvergenceFactory(() => { refreshes += 1; }) });
  if (!response) throw new Error("model visibility route was not handled");
  return response;
}

async function put(body: unknown): Promise<Response> {
  return putWithConfig(body);
}

describe("atomic model visibility management", () => {
  test("catalog busy maps management and v1 models to 503 startup to warn-skip and system-env to skip", async () => {
    const management = await Bun.file(new URL("../../src/server/management-api.ts", import.meta.url)).text();
    const server = await Bun.file(new URL("../../src/server/index.ts", import.meta.url)).text();
    const prewarm = await Bun.file(new URL("../../src/cli/catalog-prewarm.ts", import.meta.url)).text();
    const systemEnv = await Bun.file(new URL("../../src/server/system-env.ts", import.meta.url)).text();
    for (const source of [management, server]) {
      expect(source).toContain("CatalogGatherBusyError");
      expect(source).toContain('"catalog_busy"');
      expect(source).toContain('"Retry-After": "1"');
    }
    expect(prewarm).toContain("startup discovery skipped");
    expect(systemEnv).toContain('(error as { code?: unknown }).code === "catalog_busy"');
  });
  test("enables excluded or blocked models and disables without erasing the allowlist", async () => {
    expect((await put({ scope: "models", provider: "google-antigravity", targets: [{ id: "claude-sonnet-4-6" }], enabled: true })).status).toBe(200);
    expect(loadConfig().providers["google-antigravity"].selectedModels)
      .toEqual(["gemini-3.1-pro", "gemini-3.6-flash", "claude-sonnet-4-6"]);

    expect((await put({ scope: "models", provider: "google-antigravity", targets: [{ id: "gpt-oss-120b-medium" }], enabled: true })).status).toBe(200);
    expect(loadConfig().disabledModels).not.toContain("google-antigravity/gpt-oss-120b-medium");

    expect((await put({ scope: "models", provider: "google-antigravity", targets: [{ id: "gemini-3.1-pro" }], enabled: false })).status).toBe(200);
    expect(loadConfig().disabledModels).toContain("google-antigravity/gemini-3.1-pro");
    expect(loadConfig().providers["google-antigravity"].selectedModels).toContain("gemini-3.1-pro");
    expect(refreshes).toBe(3);
  });

  test("all-on enters future-proof All mode while all-off blocks only current targets", async () => {
    const targets = ["claude-sonnet-4-6", "gemini-3.1-pro", "gpt-oss-120b-medium"].map(id => ({ id }));
    expect((await put({ scope: "provider", provider: "google-antigravity", targets, enabled: true })).status).toBe(200);
    expect(loadConfig().providers["google-antigravity"].selectedModels).toBeUndefined();
    expect(loadConfig().disabledModels).toEqual(["other/keep"]);

    expect((await put({ scope: "provider", provider: "google-antigravity", targets, enabled: false })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual([
      "other/keep",
      "google-antigravity/claude-sonnet-4-6",
      "google-antigravity/gemini-3.1-pro",
      "google-antigravity/gpt-oss-120b-medium",
    ]);
    expect(loadConfig().disabledModels).not.toContain("google-antigravity/future-model");
    expect(refreshes).toBe(2);
  });

  test("all-on clears stale native ids while preserving combo selectors", async () => {
    const config = loadConfig();
    const targets = nativeModelRows(config).map(row => ({ id: row.slug, native: true }));
    expect(targets.length).toBeGreaterThan(0);
    config.disabledModels = [
      targets[0]!.id,
      "stale-native-model",
      "fast-chat",
      "combo/free",
      "google-antigravity/keep",
      "other/keep",
    ];
    saveConfig(config);

    expect((await put({ scope: "provider", provider: "openai", targets, enabled: true })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual([
      "fast-chat",
      "combo/free",
      "google-antigravity/keep",
      "other/keep",
    ]);
    expect(refreshes).toBe(1);
  });

  test("treats a physical combo provider with no configured combos as a routed provider", async () => {
    saveConfig({
      port: 0,
      defaultProvider: "combo",
      providers: {
        combo: {
          adapter: "openai-chat",
          baseUrl: "https://combo.example.test/v1",
          apiKey: "test-key",
          liveModels: false,
          models: ["model-a", "vendor/model"],
          selectedModels: ["model-a"],
        },
      },
      combos: {},
      disabledModels: ["combo/vendor-model", "combo/temporarily-missing", "other/keep"],
    });

    expect((await put({ scope: "models", provider: "combo", targets: [{ id: "vendor/model" }], enabled: true })).status).toBe(200);
    expect(loadConfig().providers.combo.selectedModels).toEqual(["model-a", "vendor/model"]);
    expect(loadConfig().disabledModels).toEqual(["combo/temporarily-missing", "other/keep"]);
    expect(refreshes).toBe(1);

    expect((await put({ scope: "models", provider: "combo", targets: [{ id: "model-a" }], enabled: false })).status).toBe(200);
    expect(loadConfig().providers.combo.selectedModels).toEqual(["model-a", "vendor/model"]);
    expect(loadConfig().disabledModels).toEqual(["combo/temporarily-missing", "other/keep", "combo/model-a"]);
    expect(refreshes).toBe(2);

    const targets = [{ id: "model-a" }, { id: "vendor/model" }];
    expect((await put({ scope: "provider", provider: "combo", targets, enabled: false })).status).toBe(200);
    expect(loadConfig().providers.combo.selectedModels).toEqual(["model-a", "vendor/model"]);
    expect(loadConfig().disabledModels).toEqual([
      "combo/temporarily-missing",
      "other/keep",
      "combo/model-a",
      "combo/vendor-model",
    ]);
    expect(loadConfig().disabledModels).not.toContain("combo/future-model");
    expect(refreshes).toBe(3);

    expect((await put({ scope: "provider", provider: "combo", targets, enabled: true })).status).toBe(200);
    expect(loadConfig().providers.combo.selectedModels).toBeUndefined();
    expect(loadConfig().disabledModels).toEqual(["other/keep"]);
    expect(refreshes).toBe(4);
  });

  test("preserves provider-prefixed combo aliases until the combo provider enables them", async () => {
    const config = loadConfig();
    config.providers.anthropic = {
      adapter: "openai-chat",
      baseUrl: "https://anthropic.example.test/v1",
      apiKey: "test-key",
      liveModels: false,
      models: ["claude-a"],
      selectedModels: ["claude-a"],
    };
    config.combos!.free!.alias = "anthropic/fast";
    config.disabledModels = [
      "anthropic/claude-a",
      "anthropic/temporarily-missing",
      "anthropic/fast",
      "combo/free",
      "combo/plain",
      "other/keep",
      "other/provider",
    ];
    saveConfig(config);

    expect((await put({ scope: "provider", provider: "anthropic", targets: [{ id: "claude-a" }], enabled: true })).status).toBe(200);
    expect(loadConfig().providers.anthropic.selectedModels).toBeUndefined();
    expect(loadConfig().disabledModels).toEqual([
      "anthropic/fast",
      "combo/free",
      "combo/plain",
      "other/keep",
      "other/provider",
    ]);
    expect(refreshes).toBe(1);

    expect((await put({ scope: "provider", provider: "combo", targets: [{ id: "free" }, { id: "plain" }], enabled: true })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual(["other/keep", "other/provider"]);
    expect(refreshes).toBe(2);
  });

  test("keeps a colliding physical combo allowlist untouched when virtual combos take precedence", async () => {
    const config = loadConfig();
    config.providers.combo = {
      adapter: "openai-chat",
      baseUrl: "https://combo.example.test/v1",
      models: ["physical-only"],
      selectedModels: ["physical-only"],
    };
    config.combos = {
      free: { alias: "anthropic/fast", targets: [{ provider: "google-antigravity", model: "gemini-3.1-pro" }] },
    };
    config.disabledModels = ["anthropic/fast", "other/keep"];

    expect((await putWithConfig({ scope: "models", provider: "combo", targets: [{ id: "free" }], enabled: true }, config)).status).toBe(200);
    expect(config.providers.combo.selectedModels).toEqual(["physical-only"]);
    expect(config.disabledModels).toEqual(["other/keep"]);
    expect(refreshes).toBe(1);

    config.disabledModels = ["combo/free", "anthropic/fast", "other/keep"];
    expect((await putWithConfig({ scope: "provider", provider: "combo", targets: [{ id: "free" }], enabled: true }, config)).status).toBe(200);
    expect(config.providers.combo.selectedModels).toEqual(["physical-only"]);
    expect(config.disabledModels).toEqual(["other/keep"]);
    expect(refreshes).toBe(2);
  });

  test("toggles canonical and aliased combo rows", async () => {
    const config = loadConfig();
    config.disabledModels?.push("fast-chat", "combo/plain");
    saveConfig(config);
    expect((await put({ scope: "models", provider: "combo", targets: [{ id: "free" }, { id: "plain" }], enabled: true })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual(["google-antigravity/gpt-oss-120b-medium", "google-antigravity/temporarily-missing", "other/keep"]);
    expect((await put({ scope: "models", provider: "combo", targets: [{ id: "free" }], enabled: false })).status).toBe(200);
    expect(loadConfig().disabledModels).toContain("combo/free");
    const beforeAllOn = loadConfig();
    beforeAllOn.disabledModels?.push("fast-chat", "combo/plain");
    saveConfig(beforeAllOn);
    expect((await put({ scope: "provider", provider: "combo", targets: [{ id: "free" }, { id: "plain" }], enabled: true })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual(["google-antigravity/gpt-oss-120b-medium", "google-antigravity/temporarily-missing", "other/keep"]);
    expect((await put({ scope: "provider", provider: "combo", targets: [{ id: "free" }, { id: "plain" }], enabled: false })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual(expect.arrayContaining(["combo/free", "combo/plain"]));
    expect((await put({ scope: "models", provider: "combo", targets: [{ id: "missing" }], enabled: true })).status).toBe(400);
    expect(refreshes).toBe(4);
  });

  test("native-alias toggles preserve the separate bare native disable key", async () => {
    const config = loadConfig();
    config.combos = {
      nova: {
        alias: "gpt-5.6-sol",
        nativeAlias: true,
        displayName: "Nova1 - Sol",
        targets: [{ provider: "google-antigravity", model: "gemini-3.1-pro" }],
      },
    };
    config.disabledModels = ["gpt-5.6-sol", "gpt-5.5", "combo/nova", "other/keep"];
    saveConfig(config);

    expect((await put({
      scope: "models",
      provider: "combo",
      targets: [{ id: "nova" }],
      enabled: true,
    })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual(["gpt-5.6-sol", "gpt-5.5", "other/keep"]);

    expect((await put({
      scope: "models",
      provider: "combo",
      targets: [{ id: "nova" }],
      enabled: false,
    })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual([
      "gpt-5.6-sol", "gpt-5.5", "other/keep", "combo/nova",
    ]);

    const current = loadConfig();
    const nativeTargets = nativeModelRows(current).map(row => ({ id: row.slug, native: true }));
    expect(nativeTargets.some(target => target.id === "gpt-5.6-sol")).toBe(false);
    expect((await put({
      scope: "provider",
      provider: "openai",
      targets: nativeTargets,
      enabled: true,
    })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual(["gpt-5.6-sol", "other/keep", "combo/nova"]);
  });

  test("uses raw allowlist ids, canonical routed slugs, and rejects invalid requests", async () => {
    await put({ scope: "models", provider: "google-antigravity", targets: [{ id: "vendor/model" }, { id: "vendor/model" }], enabled: true });
    expect(loadConfig().providers["google-antigravity"].selectedModels).toContain("vendor/model");
    expect(loadConfig().providers["google-antigravity"].selectedModels).not.toContain("google-antigravity/vendor-model");
    await put({ scope: "models", provider: "google-antigravity", targets: [{ id: "vendor/model" }], enabled: false });
    expect(loadConfig().disabledModels).toContain("google-antigravity/vendor-model");

    const before = loadConfig();
    expect((await put("{")).status).toBe(400);
    for (const nonObject of [null, [], 1, JSON.stringify("value")]) {
      expect((await put(nonObject)).status).toBe(400);
    }
    expect((await put({ scope: "bad", provider: "google-antigravity", targets: [], enabled: true })).status).toBe(400);
    expect((await put({ scope: "models", provider: "missing-provider", targets: [{ id: "model" }], enabled: true })).status).toBe(400);
    expect((await put({ scope: "models", provider: "google-antigravity", targets: [{ id: "gpt-5.6-sol", native: true }], enabled: true })).status).toBe(400);
    expect((await put({ scope: "models", provider: "openai", targets: [{ id: "gpt-5.6-sol" }], enabled: true })).status).toBe(400);
    expect((await put({ scope: "models", provider: "combo", targets: [{ id: "toString" }], enabled: true })).status).toBe(400);
    expect(loadConfig()).toEqual(before);
    expect(refreshes).toBe(2);
  });

  test("a native model suppressed by an unconfirmed roster is still a valid visibility target (#2886)", async () => {
    // The endpoint validated bare native targets against nativeModelRows, which has already
    // dropped rows an unconfirmed entitlement roster suppressed. So `ocx models enable
    // gpt-5.6-sol` answered "invalid model visibility target" for a model this build knows
    // perfectly well, leaving the operator with no way to clear its disable key.
    //
    // Scope: accepting the target says "this build knows this model", not "this account may
    // use it". Visibility only writes disabledModels; entitlement still filters the rendered
    // rows and routing stays gated, so this removes a misleading error rather than granting
    // access.
    saveConfig({ ...loadConfig(), disabledModels: ["gpt-5.6-sol", "other/keep"] });
    // Precondition: the model is genuinely absent from the rendered rows here -- asserted on
    // DAYBREAK, which is still account-gated. Sol stopped being gated on 2026-09-04, so it now
    // renders even without a roster and could no longer stand in for a suppressed model.
    expect(nativeModelRows(loadConfig()).some(row => row.slug === "gpt-daybreak-blue-latest"))
      .toBe(false);

    const response = await put({
      scope: "models",
      provider: "openai",
      targets: [{ id: "gpt-5.6-sol", native: true }],
      enabled: true,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("invalid model visibility target");
    expect(loadConfig().disabledModels).toEqual(["other/keep"]);
  });

  test("an unknown native id is still rejected (#2886)", async () => {
    // The validation set widens to what this build knows, not to anything a caller names.
    const before = loadConfig();
    expect((await put({
      scope: "models",
      provider: "openai",
      targets: [{ id: "gpt-9.9-imaginary", native: true }],
      enabled: true,
    })).status).toBe(400);
    expect(loadConfig()).toEqual(before);
  });
});

test("configured manual OpenAI rows can be toggled alongside native rows", async () => {
  const config = loadConfig();
  config.providers.openai = {adapter:"openai-responses",authMode:"forward",baseUrl:"https://chatgpt.com/backend-api/codex",liveModels:false};
  config.customModels = [{id:"manual-gpt",provider:"openai",modelId:"gpt-5.5",contextWindow:128_000}];
  config.disabledModels = ["openai/gpt-5.5", "gpt-5.4"];
  expect((await putWithConfig({scope:"models",provider:"openai",targets:[{id:"gpt-5.5",native:false}],enabled:true},config)).status).toBe(200);
  expect(config.disabledModels).toEqual(["gpt-5.4"]);
  expect((await putWithConfig({scope:"models",provider:"openai",targets:[{id:"gpt-5.5",native:false},{id:"gpt-5.4",native:true}],enabled:false},config)).status).toBe(200);
  expect(config.disabledModels).toContain("openai/gpt-5.5");
  expect(config.disabledModels).toContain("gpt-5.4");
  expect((await putWithConfig({scope:"models",provider:"openai",targets:[{id:"not-configured",native:false}],enabled:true},config)).status).toBe(400);
});

test("provider-group toggles persist mixed native and manual OpenAI targets together", async () => {
  const config = loadConfig();
  config.providers.openai = {
    adapter: "openai-responses", authMode: "forward", liveModels: false,
    baseUrl: "https://chatgpt.com/backend-api/codex", selectedModels: ["gpt-5.5"],
  };
  config.customModels = [{ id: "manual-gpt", provider: "openai", modelId: "gpt-5.5" }];
  const unrelatedDisabled = [...config.disabledModels!];
  const unrelatedProvider = structuredClone(config.providers["google-antigravity"]);
  const targets = [{ id: "gpt-5.5", native: false }, { id: "gpt-5.4", native: true }];
  saveConfig(config);

  const disabled = await putWithConfig({ scope: "provider", provider: "openai", targets, enabled: false }, config);
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).toMatchObject({ ok: true, scope: "provider", provider: "openai", enabled: false });
  expect(config.disabledModels).toEqual([...unrelatedDisabled, "openai/gpt-5.5", "gpt-5.4"]);
  expect(config.providers.openai.selectedModels).toEqual(["gpt-5.5"]);
  expect(loadConfig().disabledModels).toEqual([...unrelatedDisabled, "openai/gpt-5.5", "gpt-5.4"]);
  expect(loadConfig().providers.openai.selectedModels).toEqual(["gpt-5.5"]);
  expect(loadConfig().providers["google-antigravity"]).toEqual(unrelatedProvider);
  expect(refreshes).toBe(1);

  const enabled = await putWithConfig({ scope: "provider", provider: "openai", targets, enabled: true }, config);
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toMatchObject({ ok: true, scope: "provider", provider: "openai", enabled: true });
  expect(config.disabledModels).toEqual(unrelatedDisabled);
  expect(config.providers.openai.selectedModels).toBeUndefined();
  expect(loadConfig().disabledModels).toEqual(unrelatedDisabled);
  expect(loadConfig().providers.openai.selectedModels).toBeUndefined();
  expect(loadConfig().providers["google-antigravity"]).toEqual(unrelatedProvider);
  expect(refreshes).toBe(2);
});

test("an invalid trailing target leaves a mixed OpenAI provider-group update atomic", async () => {
  const config = loadConfig();
  config.providers.openai = {
    adapter: "openai-responses", authMode: "forward", liveModels: false,
    baseUrl: "https://chatgpt.com/backend-api/codex", selectedModels: ["gpt-5.5"],
  };
  config.customModels = [{ id: "manual-gpt", provider: "openai", modelId: "gpt-5.5" }];
  saveConfig(config);

  for (const enabled of [false, true]) {
    // Both valid targets would change state before the final invalid target is reached.
    config.disabledModels = enabled ? ["other/keep", "openai/gpt-5.5", "gpt-5.4"] : ["other/keep"];
    saveConfig(config);
    const before = structuredClone(config);
    const persistedBefore = loadConfig();
    for (const invalid of [{ id: "not-configured", native: false }, { id: "gpt-9.9-imaginary", native: true }]) {
      const response = await putWithConfig({
        scope: "provider", provider: "openai", enabled,
        targets: [{ id: "gpt-5.5", native: false }, { id: "gpt-5.4", native: true }, invalid],
      }, config);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid model visibility target" });
      expect(config).toEqual(before);
      expect(loadConfig()).toEqual(persistedBefore);
      expect(refreshes).toBe(0);
    }
  }
});

test("manual models replace management rows with the same provider/id and deletion restores natives", async () => {
  const config = loadConfig();
  config.providers.openai = {adapter:"openai-responses",authMode:"forward",baseUrl:"https://chatgpt.com/backend-api/codex",liveModels:false};
  config.customModels = [
    {id:"manual-gpt",provider:"openai",modelId:"gpt-5.5",contextWindow:128_000},
    {id:"manual-google",provider:"google-antigravity",modelId:"gemini-3.1-pro",contextWindow:128_000},
  ];
  config.codexAccountNamespaces = { desktop: "@main" };
  config.codexAccountPickerEnabled = true;
  const accountModel = "gpt-5.5-account-fixture";
  const qualifiedId = `desktop/${accountModel}`;
  writeFileSync(join(isolatedCodexHome!.path, "models_cache.json"), JSON.stringify({
    models: [{
      slug: accountModel, supported_in_api: true, visibility: "list",
      base_instructions: "You are Codex.", comp_hash: null, shell_type: "unified_exec",
      supported_reasoning_levels: [{ effort: "medium" }], model_messages: {},
    }],
  }));
  // Even an exact qualified-ID collision must preserve the account-bound native route.
  config.customModels.push({ id: "manual-qualified", provider: "openai", modelId: qualifiedId });
  const rows = await listManagementModelRows(config,{entitlementWaitMs:0});
  expect(rows.filter(row=>row.provider==="openai" && row.id==="gpt-5.5")).toEqual([
    expect.objectContaining({namespaced:"openai/gpt-5.5",custom:true,customId:"manual-gpt",contextWindow:128_000,fastRowAvailable:true}),
  ]);
  expect(rows.filter(row=>row.provider==="google-antigravity" && row.id==="gemini-3.1-pro")).toHaveLength(1);
  expect(rows.filter(row => row.id === qualifiedId && row.native)).toEqual([
    expect.objectContaining({ namespaced: qualifiedId, provider: "openai", native: true }),
  ]);
  config.disabledModels = ["openai/gpt-5.5"];
  const disabledRows = await listManagementModelRows(config, { entitlementWaitMs: 0 });
  expect(disabledRows.find(row => row.namespaced === "openai/gpt-5.5")).toMatchObject({
    custom: true, disabled: true, fastRowAvailable: false,
  });
  config.disabledModels = [];
  config.customModels = [];
  const restored = await listManagementModelRows(config,{entitlementWaitMs:0});
  expect(restored.some(row => row.id === qualifiedId && row.native)).toBe(true);
  expect(restored.filter(row=>row.provider==="openai" && row.id==="gpt-5.5")).toEqual([
    expect.objectContaining({namespaced:"gpt-5.5",native:true}),
  ]);
});

test("manual OpenAI visibility preserves the pending-selection error contract", async () => {
  const config = loadConfig();
  config.providers.openai = {
    adapter: "openai-responses", authMode: "forward", liveModels: false,
    baseUrl: "https://chatgpt.com/backend-api/codex",
    initialModelSelection: { version: 1, registrationId: "11111111-1111-4111-8111-111111111111", status: "pending" },
  };
  config.customModels = [{ id: "manual-gpt", provider: "openai", modelId: "gpt-5.5" }];
  const before = structuredClone(config);
  for (const target of [{ id: "gpt-5.5", native: false }, { id: "not-configured", native: false }]) {
    const response = await putWithConfig({ scope: "models", provider: "openai", targets: [target], enabled: true }, config);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "initial_model_selection_pending" });
    expect(config).toEqual(before);
  }
  expect((await putWithConfig({ scope: "invalid", provider: "openai", targets: [], enabled: true }, config)).status).toBe(400);
  expect(config).toEqual(before);
});

describe("provider workspace custom-model API round trips", () => {
  async function request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Response> {
    const url = new URL(path, "http://localhost");
    const response = await handleManagementAPI(new Request(url, {
      method,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }),
    }), url, loadConfig(), {
      createManagementConvergeCodex: catalogConvergenceFactory(() => { refreshes += 1; }),
    });
    if (!response) throw new Error(`management route was not handled: ${path}`);
    return response;
  }

  async function createCustom(provider: string, modelId: string): Promise<string> {
    const response = await request("POST", "/api/custom-models", { provider, modelId });
    expect(response.status).toBe(201);
    const created = await response.json() as { id: string; provider: string; modelId: string };
    expect(created.provider).toBe(provider);
    expect(created.modelId).toBe(modelId);
    expect(typeof created.id).toBe("string");
    expect(created.id.length).toBeGreaterThan(0);
    return created.id;
  }

  async function readRows(): Promise<ManagementModelRow[]> {
    const response = await request("GET", "/api/models");
    expect(response.status).toBe(200);
    return await response.json() as ManagementModelRow[];
  }

  async function readCustoms(): Promise<Array<{ id: string; provider: string; modelId: string }>> {
    const response = await request("GET", "/api/custom-models");
    expect(response.status).toBe(200);
    return await response.json() as Array<{ id: string; provider: string; modelId: string }>;
  }

  test("custom-only DELETE then POST creates a new stable id without clearing hides or allowlists", async () => {
    const provider = "google-antigravity";
    const modelId = "workspace-custom-only";
    const config = loadConfig();
    config.providers["other-static"] = {
      adapter: "openai-chat", baseUrl: "https://other.example.test/v1", liveModels: false,
      models: [], selectedModels: ["other-selected"],
    };
    config.disabledModels!.push(routedSlug(provider, modelId), routedSlug("other-static", modelId));
    saveConfig(config);
    const hidden = [...loadConfig().disabledModels!];
    const selected = [...loadConfig().providers[provider].selectedModels!];
    const otherProvider = structuredClone(loadConfig().providers["other-static"]);
    const firstId = await createCustom(provider, modelId);
    const otherId = await createCustom("other-static", modelId);
    const otherBefore = (await readRows()).find(row => row.customId === otherId);
    expect(otherBefore).toBeDefined();

    expect((await request("DELETE", `/api/custom-models/${encodeURIComponent(firstId)}`)).status).toBe(200);
    expect((await readCustoms()).map(row => row.id)).toEqual([otherId]);
    const afterDelete = await readRows();
    expect(afterDelete.some(row => row.provider === provider && row.id === modelId)).toBe(false);
    expect(afterDelete.find(row => row.customId === otherId)).toEqual(otherBefore);

    const secondId = await createCustom(provider, modelId);
    expect(secondId).not.toBe(firstId);
    const reopened = (await readRows()).find(row => row.customId === secondId);
    expect(reopened?.namespaced).toBe(routedSlug(provider, modelId));
    expect(reopened?.disabled).toBe(true);
    expect((await readCustoms()).filter(row => row.provider === provider).map(row => row.id)).toEqual([secondId]);
    expect(loadConfig().disabledModels).toEqual(hidden);
    expect(loadConfig().providers[provider].selectedModels).toEqual(selected);
    expect(loadConfig().providers["other-static"]).toEqual(otherProvider);
    expect((await readRows()).find(row => row.customId === otherId)).toEqual(otherBefore);
    expect(refreshes).toBe(4); // Three explicit POSTs and one DELETE; GETs never converge.
  });

  test.each([
    { bareHidden: false, routedHidden: true },
    { bareHidden: true, routedHidden: false },
    { bareHidden: true, routedHidden: true },
  ])("DELETE restores native identity with independent hides %j", async ({ bareHidden, routedHidden }) => {
    const modelId = "gpt-5.5";
    const config = loadConfig();
    config.providers.openai = {
      adapter: "openai-responses", authMode: "forward", liveModels: false,
      baseUrl: "https://chatgpt.com/backend-api/codex", selectedModels: ["manual-selection"],
    };
    config.disabledModels!.push(
      ...(bareHidden ? [modelId] : []),
      ...(routedHidden ? [routedSlug("openai", modelId)] : []),
    );
    saveConfig(config);
    const hidden = [...loadConfig().disabledModels!];
    const selected = [...loadConfig().providers.openai.selectedModels!];
    const manualId = await createCustom("openai", modelId);
    const otherId = await createCustom("google-antigravity", modelId);
    const before = await readRows();
    const manual = before.filter(row => row.provider === "openai" && row.id === modelId);
    expect(manual).toHaveLength(1);
    expect(manual[0]!.customId).toBe(manualId);
    expect(manual[0]!.namespaced).toBe(routedSlug("openai", modelId));
    expect(manual[0]!.disabled).toBe(routedHidden);
    const otherBefore = before.find(row => row.customId === otherId);
    expect(otherBefore).toBeDefined();

    expect((await request("DELETE", `/api/custom-models/${encodeURIComponent(manualId)}`)).status).toBe(200);
    expect((await readCustoms()).map(row => row.id)).toEqual([otherId]);
    const after = await readRows();
    const native = after.filter(row => row.provider === "openai" && row.id === modelId);
    expect(native).toHaveLength(1);
    expect(native[0]!.native).toBe(true);
    expect(native[0]!.customId).toBeUndefined();
    expect(native[0]!.namespaced).toBe(modelId);
    expect(native[0]!.disabled).toBe(bareHidden);
    expect(after.find(row => row.customId === otherId)).toEqual(otherBefore);
    expect(loadConfig().disabledModels).toEqual(hidden);
    expect(loadConfig().providers.openai.selectedModels).toEqual(selected);
    expect(refreshes).toBe(3);

    // A deleted manual identity must not remain a valid non-native OpenAI visibility target.
    const persistedBeforeInvalid = loadConfig();
    expect((await put({ scope: "models", provider: "openai", targets: [{ id: modelId }], enabled: false })).status).toBe(400);
    expect((await request("DELETE", `/api/custom-models/${encodeURIComponent(manualId)}`)).status).toBe(404);
    expect(loadConfig()).toEqual(persistedBeforeInvalid);
    expect(refreshes).toBe(3);
  });

  test("DELETE of a custom override reveals its static provider row without hiding it", async () => {
    const provider = "google-antigravity";
    const modelId = "claude-sonnet-4-6";
    const hidden = [...loadConfig().disabledModels!];
    const selected = [...loadConfig().providers[provider].selectedModels!];
    const id = await createCustom(provider, modelId);
    const before = (await readRows()).filter(row => row.provider === provider);
    expect(before.filter(row => row.id === modelId).map(row => row.customId)).toEqual([id]);
    expect((await request("DELETE", `/api/custom-models/${encodeURIComponent(id)}`)).status).toBe(200);
    const after = (await readRows()).filter(row => row.provider === provider);
    const restored = after.filter(row => row.id === modelId);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.customId).toBeUndefined();
    expect(restored[0]!.namespaced).toBe(routedSlug(provider, modelId));
    expect(restored[0]!.disabled).toBe(false);
    expect(after).toHaveLength(before.length);
    expect(await readCustoms()).toEqual([]);
    expect(loadConfig().disabledModels).toEqual(hidden);
    expect(loadConfig().providers[provider].selectedModels).toEqual(selected);
    expect(refreshes).toBe(2);
  });

  test("DELETE of a qualified custom override preserves the independent account-native identity", async () => {
    const config = loadConfig();
    config.providers.openai = {
      adapter: "openai-responses", authMode: "forward", liveModels: false,
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    config.codexAccountNamespaces = { desktop: "@main" };
    config.codexAccountPickerEnabled = true;
    const accountModel = "gpt-5.5-account-fixture";
    const qualifiedId = `desktop/${accountModel}`;
    config.customModels = [{ id: "qualified-custom", provider: "openai", modelId: qualifiedId }];
    config.disabledModels!.push(qualifiedId, routedSlug("openai", qualifiedId));
    saveConfig(config);
    writeFileSync(join(isolatedCodexHome!.path, "models_cache.json"), JSON.stringify({ models: [{
      slug: accountModel, supported_in_api: true, visibility: "list",
      base_instructions: "You are Codex.", comp_hash: null, shell_type: "unified_exec",
      supported_reasoning_levels: [{ effort: "medium" }], model_messages: {},
    }] }));
    const hidden = [...loadConfig().disabledModels!];
    const before = (await readRows()).filter(row => row.id === qualifiedId);
    expect(before).toHaveLength(2);
    const nativeBefore = before.find(row => row.native === true);
    expect(nativeBefore?.namespaced).toBe(qualifiedId);
    expect(nativeBefore?.disabled).toBe(true);
    expect(before.find(row => row.customId === "qualified-custom")?.namespaced).toBe(routedSlug("openai", qualifiedId));

    expect((await request("DELETE", "/api/custom-models/qualified-custom")).status).toBe(200);
    expect(await readCustoms()).toEqual([]);
    expect((await readRows()).filter(row => row.id === qualifiedId)).toEqual([nativeBefore!]);
    expect(loadConfig().disabledModels).toEqual(hidden);
    expect(loadConfig().codexAccountNamespaces).toEqual({ desktop: "@main" });
    expect(refreshes).toBe(1);
  });
});
