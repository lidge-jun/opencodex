import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteConfigTopLevelKey, getConfigPath, getDefaultConfig, loadConfig, readConfigDiagnostics,
  saveConfig, saveConfigPreservingClaudeCode, validateConfigCandidate,
} from "../../src/config";
import { modelPinnedEffortsConfigError, pinnedReasoningEffortConfigError } from "../../src/config/provider-validation";
import { configRebaseDeletionKeys, projectConfigRebaseProvenance } from "../../src/config/rebase-provenance";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { providerEditorConfigDTO, providerManagementConfigError, safeConfigDTO } from "../../src/server/auth-cors";
import { handleAgentSettingsRoutes } from "../../src/server/management/agent-settings-routes";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let directory: string;
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;

function fixture(): OcxConfig {
  return {
    ...getDefaultConfig(), defaultProvider: "alpha",
    providers: { alpha: {
      adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", apiKey: "fixture-private-key",
      pinnedReasoningEffort: "high", modelPinnedReasoningEfforts: { one: "low", two: "none" },
    } },
    effortCap: "max", subagentEffortCap: "medium", modelPinnedEfforts: { "alpha/one": "ultra", two: "minimal" },
  };
}

function context(config: OcxConfig, path: string, method: string, body?: unknown): ManagementContext {
  const url = new URL(`http://localhost${path}`);
  return {
    url, config, version: "fixture",
    req: new ManagementRequest(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    deps: { saveConfigPreservingClaudeCode, clearThreadAccountMap: () => {}, clearProviderQuotaCache: () => {} },
    convergeCodexCatalog: mock(async () => ({ status: "committed", changed: true, degraded: false, notices: [] } as const)),
    syncClaudeAgentDefsBestEffort: mock(async () => {}),
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  directory = mkdtempSync(join(tmpdir(), "ocx-pinned-config-"));
  process.env.OPENCODEX_HOME = directory;
  codexHome = installIsolatedCodexHome("ocx-pinned-codex-");
  saveConfig(fixture());
});

afterEach(() => {
  codexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(directory);
});

describe("reasoning pin config boundaries", () => {
  test("accepts declared efforts and rejects malformed maps, reserved keys and trim collisions", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(pinnedReasoningEffortConfigError(effort)).toBeNull();
      expect(modelPinnedEffortsConfigError({ model: effort })).toBeNull();
    }
    for (const value of [null, [], "high", new Date(), Object.create({ inherited: "high" }),
      { " ": "high" }, { constructor: "low" }, { prototype: "low" },
      JSON.parse('{"__proto__":"high"}'), { " model ": "low", model: "high" }, { model: undefined },
      { model: "invented" }, { model: null }, { model: "" }]) {
      expect(modelPinnedEffortsConfigError(value)).not.toBeNull();
    }
    expect(modelPinnedEffortsConfigError({ model: null, other: "" }, "pins", true)).toBeNull();
    expect(modelPinnedEffortsConfigError({ " model ": null, model: "high" }, "pins", true)).not.toBeNull();
  });

  test("load and diagnostics salvage the same entries without fallback, secret warnings or disk rewrite", () => {
    const raw = fixture();
    const provider = raw.providers.alpha! as unknown as Record<string, unknown>;
    provider.pinnedReasoningEffort = { secret: "do-not-log-pin-value" };
    provider.modelPinnedReasoningEfforts = { keep: "none", bad: "do-not-log-pin-value", " clash ": "low", clash: "high" };
    raw.modelPinnedEfforts = JSON.parse('{"keep":"minimal","__proto__":"high"," ":"high","bad":12}');
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    const before = readFileSync(getConfigPath(), "utf8");
    const filesBefore = readdirSync(directory).sort();
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args.join(" ")); });
    try {
      const loaded = loadConfig();
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("file");
      expect(diagnostics.error).toBeNull();
      for (const config of [loaded, diagnostics.config]) {
        expect(config.providers.alpha!.apiKey).toBe("fixture-private-key");
        expect(config.providers.alpha!.pinnedReasoningEffort).toBeUndefined();
        expect(config.providers.alpha!.modelPinnedReasoningEfforts).toEqual({ keep: "none" });
        expect(config.modelPinnedEfforts).toEqual({ keep: "minimal" });
        expect(config.defaultProvider).toBe("alpha");
      }
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.join("\n")).not.toContain("do-not-log-pin-value");
      expect(warnings.join("\n")).not.toContain("clash");
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
      expect(readdirSync(directory).sort()).toEqual(filesBefore);
    } finally { warn.mockRestore(); }
  });

  test("candidate and direct writers reject invalid pins before live or disk mutation", () => {
    for (const mutation of [
      (config: OcxConfig) => { config.modelPinnedEfforts = { model: "invalid" }; },
      (config: OcxConfig) => { config.providers.alpha!.pinnedReasoningEffort = "invalid"; },
      (config: OcxConfig) => { config.providers.alpha!.modelPinnedReasoningEfforts = { " ": "high" }; },
      (config: OcxConfig) => { Reflect.set(config, "modelPinnedEfforts", null); },
    ]) {
      const config = loadConfig();
      mutation(config);
      const beforeLive = structuredClone(config);
      const beforeDisk = readFileSync(getConfigPath(), "utf8");
      expect(validateConfigCandidate(config).ok).toBe(false);
      expect(() => saveConfig(config)).toThrow();
      expect(() => saveConfigPreservingClaudeCode(config)).toThrow();
      expect(config).toEqual(beforeLive);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
    }
  });

  test("malformed whole maps degrade only their own optional fields in both read paths", () => {
    const raw = fixture();
    Reflect.set(raw, "modelPinnedEfforts", []);
    Reflect.set(raw.providers.alpha!, "modelPinnedReasoningEfforts", null);
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    const disk = readFileSync(getConfigPath(), "utf8");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const config of [loadConfig(), readConfigDiagnostics().config]) {
        expect(config.modelPinnedEfforts).toBeUndefined();
        expect(config.providers.alpha!.modelPinnedReasoningEfforts).toBeUndefined();
        expect(config.providers.alpha!.pinnedReasoningEffort).toBe("high");
        expect(config.providers.alpha!.apiKey).toBe("fixture-private-key");
      }
      expect(readFileSync(getConfigPath(), "utf8")).toBe(disk);
    } finally { warn.mockRestore(); }
  });

  test("strict candidate parsing normalizes pin keys without changing input", () => {
    const config = fixture();
    config.modelPinnedEfforts = { " alpha/one ": "none" };
    config.providers.alpha!.modelPinnedReasoningEfforts = { " one ": "minimal" };
    const result = validateConfigCandidate(config);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.config.modelPinnedEfforts).toEqual({ "alpha/one": "none" });
    expect(result.config.providers.alpha!.modelPinnedReasoningEfforts).toEqual({ one: "minimal" });
    expect(config.modelPinnedEfforts).toEqual({ " alpha/one ": "none" });
  });

  test("canonical OpenAI admits validated pin overlays while retaining transport and credential checks", () => {
    const seed = providerConfigSeed(getProviderRegistryEntry("openai")!);
    const pins = { pinnedReasoningEffort: "none", modelPinnedReasoningEfforts: { "gpt-test": "ultra" } };
    const provider = { ...seed, ...pins };
    expect(providerManagementConfigError("openai", provider)).toBeNull();
    for (const patch of [
      { pinnedReasoningEffort: "invalid" }, { modelPinnedReasoningEfforts: [] },
      { modelPinnedReasoningEfforts: { constructor: "high" } },
      { baseUrl: "https://elsewhere.example.test/v1" }, { authMode: "local" }, { apiKey: "do-not-admit" },
    ]) expect(providerManagementConfigError("openai", { ...provider, ...patch })).not.toBeNull();
    const config = { ...getDefaultConfig(), providers: { openai: provider } };
    expect(providerEditorConfigDTO(config).providers.openai).toMatchObject(pins);
    const privateConfig = fixture();
    expect(providerEditorConfigDTO(privateConfig).providers.alpha).not.toHaveProperty("apiKey");
    expect(JSON.stringify(safeConfigDTO(privateConfig))).not.toContain("fixture-private-key");
  });
});

describe("provider pin management", () => {
  test("GET returns provider pins and canonical OpenAI PATCH/POST round-trip them", async () => {
    const dns = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      const config = getDefaultConfig();
      config.providers.openai = providerConfigSeed(getProviderRegistryEntry("openai")!);
      saveConfig(config);
      expect((await handleProviderRoutes(context(config, "/api/providers?name=openai", "PATCH", {
        pinnedReasoningEffort: "none", modelPinnedReasoningEfforts: { "gpt-test": "ultra" },
      })))?.status).toBe(200);
      const response = await handleProviderRoutes(context(config, "/api/providers", "GET"));
      const providers = await response!.json() as Array<{ name: string; pinnedReasoningEffort?: string; modelPinnedReasoningEfforts?: Record<string, string> }>;
      expect(providers.find(provider => provider.name === "openai")).toMatchObject({
        pinnedReasoningEffort: "none", modelPinnedReasoningEfforts: { "gpt-test": "ultra" },
      });
      const seed = providerConfigSeed(getProviderRegistryEntry("openai")!);
      expect((await handleProviderRoutes(context(config, "/api/providers", "POST", { name: "openai", provider: seed })))?.status).toBe(200);
      expect(loadConfig().providers.openai).toMatchObject({ pinnedReasoningEffort: "none", modelPinnedReasoningEfforts: { "gpt-test": "ultra" } });
    } finally { dns.mockRestore(); }
  });

  test("PATCH merges normalized keys, clears entries and persists whole-field clears", async () => {
    const dns = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      const config = loadConfig();
      let ctx = context(config, "/api/providers?name=alpha", "PATCH", {
        modelPinnedReasoningEfforts: { " one ": null, " three ": "ultra" },
      });
      expect((await handleProviderRoutes(ctx))?.status).toBe(200);
      expect(config.providers.alpha!.modelPinnedReasoningEfforts).toEqual({ two: "none", three: "ultra" });
      expect(config.providers.alpha!.pinnedReasoningEffort).toBe("high");
      ctx = context(config, "/api/providers?name=alpha", "PATCH", { pinnedReasoningEffort: null, modelPinnedReasoningEfforts: null });
      expect((await handleProviderRoutes(ctx))?.status).toBe(200);
      const reloaded = loadConfig();
      expect(reloaded.providers.alpha).not.toHaveProperty("pinnedReasoningEffort");
      expect(reloaded.providers.alpha).not.toHaveProperty("modelPinnedReasoningEfforts");
    } finally { dns.mockRestore(); }
  });

  test("POST omission preserves pins; entry tombstones and explicit null do not remerge old pins", async () => {
    const dns = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      const config = loadConfig();
      const base = { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1" };
      for (const [patch, expectedScalar, expectedMap] of [
        [{}, "high", { one: "low", two: "none" }],
        [{ modelPinnedReasoningEfforts: { one: "", " three ": "minimal" } }, "high", { two: "none", three: "minimal" }],
        [{ pinnedReasoningEffort: null, modelPinnedReasoningEfforts: null }, undefined, undefined],
      ] as const) {
        const ctx = context(config, "/api/providers", "POST", { name: "alpha", provider: { ...base, ...patch } });
        expect((await handleProviderRoutes(ctx))?.status).toBe(200);
        const reloaded = loadConfig().providers.alpha!;
        expect(reloaded.pinnedReasoningEffort).toBe(expectedScalar);
        expect(reloaded.modelPinnedReasoningEfforts).toEqual(expectedMap);
      }
    } finally { dns.mockRestore(); }
  });

  test("invalid pin PATCH/POST leaves live and disk unchanged and never calls save", async () => {
    const config = loadConfig();
    const beforeLive = structuredClone(config);
    const beforeDisk = readFileSync(getConfigPath(), "utf8");
    for (const method of ["PATCH", "POST"]) {
      const pins = { pinnedReasoningEffort: "low", modelPinnedReasoningEfforts: { " same ": "none", same: "high" } };
      const ctx = context(config, "/api/providers?name=alpha", method, method === "POST"
        ? { name: "alpha", provider: { ...config.providers.alpha, ...pins } } : pins);
      ctx.deps.saveConfigPreservingClaudeCode = mock(() => {});
      expect((await handleProviderRoutes(ctx))?.status).toBe(400);
      expect(ctx.deps.saveConfigPreservingClaudeCode).not.toHaveBeenCalled();
      expect(config).toEqual(beforeLive);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
    }
  });

  test("PATCH and POST save failures restore exact provider ownership and pending deletion metadata", async () => {
    const dns = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      for (const method of ["PATCH", "POST"]) {
        const config = loadConfig();
        deleteConfigTopLevelKey(config, "modelPickerOrder");
        const row = config.providers.alpha;
        const beforeLive = structuredClone(config);
        const beforeProjection = projectConfigRebaseProvenance(config);
        const beforeDisk = readFileSync(getConfigPath(), "utf8");
        const patch = { pinnedReasoningEffort: null, modelPinnedReasoningEfforts: null };
        const ctx = context(config, "/api/providers?name=alpha", method, method === "POST"
          ? { name: "alpha", provider: { ...row, ...patch }, setDefault: true } : patch);
        ctx.deps.saveConfigPreservingClaudeCode = () => {
          deleteConfigTopLevelKey(config, "modelPinnedEfforts");
          // Restore the value but leave the injected deletion intent pending.
          config.modelPinnedEfforts = beforeLive.modelPinnedEfforts;
          config.configRebaseProvenance = { version: 1, deletedTopLevelKeys: ["effortCap"] };
          throw new Error("fixture pin save failure");
        };
        await expect(handleProviderRoutes(ctx)).rejects.toThrow("fixture pin save failure");
        expect(config.providers.alpha).toBe(row);
        expect(config).toEqual(beforeLive);
        expect(projectConfigRebaseProvenance(config)).toEqual(beforeProjection);
        expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
      }
    } finally { dns.mockRestore(); }
  });

  test("raw editor omission deletes both pin fields while preserving provider credentials", async () => {
    const dns = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      const config = loadConfig();
      const baseline = providerEditorConfigDTO(config);
      const next = structuredClone(baseline);
      delete next.providers.alpha!.pinnedReasoningEffort;
      delete next.providers.alpha!.modelPinnedReasoningEfforts;
      expect((await handleProviderRoutes(context(config, "/api/providers", "PUT", { baseline, next })))?.status).toBe(200);
      const provider = loadConfig().providers.alpha!;
      expect(provider).not.toHaveProperty("pinnedReasoningEffort");
      expect(provider).not.toHaveProperty("modelPinnedReasoningEfforts");
      expect(provider.apiKey).toBe("fixture-private-key");
    } finally { dns.mockRestore(); }
  });

  test("new provider POST save failure restores registration state, default and absent row", async () => {
    const dns = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      const config = loadConfig();
      config.disabledModels = ["beta/stale", "alpha/keep"];
      config.modelDiscovery = {
        knownModels: { beta: { ids: ["stale"], removed: [], updatedAt: "2026-01-01T00:00:00Z" } },
        recentArrivals: { beta: [{ id: "stale", at: "2026-01-01T00:00:00Z" }] },
      };
      const before = structuredClone(config);
      const disk = readFileSync(getConfigPath(), "utf8");
      const ctx = context(config, "/api/providers", "POST", { name: "beta", setDefault: true, provider: {
        adapter: "openai-chat", baseUrl: "https://beta.example.test/v1", pinnedReasoningEffort: "minimal",
      } });
      ctx.deps.saveConfigPreservingClaudeCode = candidate => {
        expect(candidate.defaultProvider).toBe("beta");
        expect(candidate.disabledModels).toEqual(["alpha/keep"]);
        expect(candidate.modelDiscovery!.knownModels).not.toHaveProperty("beta");
        expect(candidate.modelDiscovery!.recentArrivals).not.toHaveProperty("beta");
        throw new Error("fixture registration save failure");
      };
      await expect(handleProviderRoutes(ctx)).rejects.toThrow("fixture registration save failure");
      expect(config).toEqual(before);
      expect(config.providers).not.toHaveProperty("beta");
      expect(readFileSync(getConfigPath(), "utf8")).toBe(disk);
    } finally { dns.mockRestore(); }
  });
});

describe("effort caps pin transaction", () => {
  test("GET exposes pins; mixed invalid PUT requests leave live and disk unchanged", async () => {
    const config = loadConfig();
    const get = await handleAgentSettingsRoutes(context(config, "/api/effort-caps", "GET"));
    expect(await get!.json()).toMatchObject({ modelPinnedEfforts: { "alpha/one": "ultra", two: "minimal" } });
    const before = structuredClone(config);
    const disk = readFileSync(getConfigPath(), "utf8");
    for (const patch of [
      { effortCap: "low", modelPinnedEfforts: { bad: "invalid" } },
      { effortCap: null, subagentEffortCap: "invalid", modelPinnedEfforts: null },
      { effortCap: "low", modelPinnedEfforts: { " two ": null, two: "high" } },
      { effortCap: "low", modelPinnedEfforts: JSON.parse('{"__proto__":"high"}') },
      null, [],
    ]) {
      const ctx = context(config, "/api/effort-caps", "PUT", patch);
      ctx.deps.saveConfigPreservingClaudeCode = mock(() => {});
      expect((await handleAgentSettingsRoutes(ctx))?.status).toBe(400);
      expect(ctx.deps.saveConfigPreservingClaudeCode).not.toHaveBeenCalled();
      expect(config).toEqual(before);
      expect(configRebaseDeletionKeys(config).size).toBe(0);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(disk);
    }
  });

  test("PUT merges pin keys and persists null clears with deletion provenance", async () => {
    const config = loadConfig();
    let ctx = context(config, "/api/effort-caps", "PUT", { effortCap: "high", modelPinnedEfforts: { two: "", " third ": "none" } });
    expect((await handleAgentSettingsRoutes(ctx))?.status).toBe(200);
    expect(loadConfig().modelPinnedEfforts).toEqual({ "alpha/one": "ultra", third: "none" });
    ctx = context(config, "/api/effort-caps", "PUT", { effortCap: null, subagentEffortCap: null, modelPinnedEfforts: null });
    expect((await handleAgentSettingsRoutes(ctx))?.status).toBe(200);
    const reloaded = loadConfig();
    for (const key of ["effortCap", "subagentEffortCap", "modelPinnedEfforts"] as const) {
      expect(reloaded).not.toHaveProperty(key);
      expect(configRebaseDeletionKeys(reloaded).has(key)).toBe(true);
    }
  });

  test("save failure rolls back caps, pins, provenance and preexisting pending deletion intent", async () => {
    const config = loadConfig();
    deleteConfigTopLevelKey(config, "modelPickerOrder");
    const before = structuredClone(config);
    const projection = projectConfigRebaseProvenance(config);
    const disk = readFileSync(getConfigPath(), "utf8");
    const ctx = context(config, "/api/effort-caps", "PUT", { effortCap: null, subagentEffortCap: "low", modelPinnedEfforts: null });
    ctx.deps.saveConfigPreservingClaudeCode = () => { throw new Error("fixture disk full"); };
    await expect(handleAgentSettingsRoutes(ctx)).rejects.toThrow("fixture disk full");
    expect(config).toEqual(before);
    expect(projectConfigRebaseProvenance(config)).toEqual(projection);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(disk);
    saveConfigPreservingClaudeCode(config);
    expect(loadConfig().modelPinnedEfforts).toEqual(before.modelPinnedEfforts);
    expect(configRebaseDeletionKeys(loadConfig()).has("modelPickerOrder")).toBe(true);
  });

  test("unknown future deletion provenance rejects a clear before mutation", async () => {
    const config = loadConfig();
    config.configRebaseProvenance = { version: 2, future: true };
    const before = structuredClone(config);
    const ctx = context(config, "/api/effort-caps", "PUT", { modelPinnedEfforts: null });
    ctx.deps.saveConfigPreservingClaudeCode = mock(() => {});
    expect((await handleAgentSettingsRoutes(ctx))?.status).toBe(409);
    expect(config).toEqual(before);
    expect(ctx.deps.saveConfigPreservingClaudeCode).not.toHaveBeenCalled();
  });
});
