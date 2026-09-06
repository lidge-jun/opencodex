/**
 * A saved subagent roster must survive an unrelated model-visibility change.
 *
 * The dashboard renders the roster from the reported available list and PUTs exactly what it
 * holds, so a
 * chosen id that GET omits is not merely hidden: the next Save writes the truncated list
 * back to config.json. Disabling a model on the Models page, narrowing a provider
 * allowlist, or removing a provider therefore used to silently shrink a deliberate
 * 5-model roster.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { handleAgentSettingsRoutes } from "../../src/server/management/agent-settings-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { deleteConfigTopLevelKey, loadConfig, saveConfigPreservingClaudeCode } from "../../src/config";
import { configHasRebaseProvenance, configRebaseDeletionKeys, projectConfigRebaseProvenance } from "../../src/config/rebase-provenance";
import type { OcxConfig } from "../../src/types";

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...overrides } as OcxConfig;
}

async function getRoster(config: OcxConfig): Promise<{ chosen: string[]; available: string[] }> {
  const res = await handleManagementAPI(
    new Request("http://localhost/api/subagent-models"),
    new URL("http://localhost/api/subagent-models"),
    config,
  );
  expect(res).not.toBeNull();
  return await res!.json() as { chosen: string[]; available: string[] };
}

describe("/api/subagent-models roster retention", () => {
  test("a chosen model disabled elsewhere stays listed in available", async () => {
    const chosen = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"];
    const config = makeConfig({
      subagentModels: [...chosen],
      disabledModels: ["gpt-5.5", "gpt-5.4-mini"],
    });

    const roster = await getRoster(config);

    // The saved list itself is untouched.
    expect(roster.chosen).toEqual(chosen);
    // And every slot the user saved can still be rendered, so a Save round-trip
    // cannot truncate the roster to the models that happen to be enabled today.
    for (const model of chosen) expect(roster.available).toContain(model);
  });

  test("retained roster entries are appended once, after the selectable models", async () => {
    const config = makeConfig({
      subagentModels: ["gpt-5.5", "gpt-5.5", "gpt-5.6-terra"],
      disabledModels: ["gpt-5.5"],
    });

    const { available } = await getRoster(config);

    // A duplicate saved id must not produce a duplicate row.
    expect(available.filter(model => model === "gpt-5.5").length).toBe(1);
    // An enabled chosen model is already selectable and must not be re-appended.
    expect(available.filter(model => model === "gpt-5.6-terra").length).toBe(1);
    // Retained-but-disabled entries sort after everything still selectable.
    expect(available.indexOf("gpt-5.5")).toBeGreaterThan(available.indexOf("gpt-5.6-terra"));
  });

  test("a disabled model that is NOT in the roster stays out of available", async () => {
    const config = makeConfig({
      subagentModels: ["gpt-5.6-terra"],
      disabledModels: ["gpt-5.6-sol"],
    });

    const { available } = await getRoster(config);

    expect(available).not.toContain("gpt-5.6-sol");
    expect(available).toContain("gpt-5.6-terra");
  });
});


describe("picker updates preserve roster and persistence intent", () => {
  let directory: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    directory = mkdtempSync(join(tmpdir(), "ocx-picker-settings-"));
    process.env.OPENCODEX_HOME = directory;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(directory);
  });
  const rows = [{ provider: "alpha", id: "one" }, { provider: "beta", id: "two" }];
  function context(config: OcxConfig, body: unknown): ManagementContext {
    const url = new URL("http://localhost/api/subagent-models");
    return {
      url, config, version: "fixture",
      req: new Request(url, { method: "PUT", body: JSON.stringify(body) }),
      deps: { fetchAllModels: async () => rows, saveConfigPreservingClaudeCode: mock(() => {}) },
      convergeCodexCatalog: mock(async () => ({ status: "committed", changed: true, degraded: false, notices: [] } as const)),
      syncClaudeAgentDefsBestEffort: mock(async () => {}),
    };
  }
  test("picker save/reset never changes retained roster, version, fallback or Claude agents", async () => {
    const config = makeConfig({ subagentModels: ["missing/model", "account/gpt-5.5"], subagentModelsVersion: 1,
      subagentModelFallback: ["fallback/model"] });
    for (const pickerOrder of [["beta/two", "alpha/one"], null, []]) {
      const ctx = context(config, { pickerOrder, pickerOrderMode: "most-used" });
      const res = await handleAgentSettingsRoutes(ctx);
      expect(res?.status).toBe(200);
      expect(config.subagentModels).toEqual(["missing/model", "account/gpt-5.5"]);
      expect(config.subagentModelsVersion).toBe(1);
      expect(config.subagentModelFallback).toEqual(["fallback/model"]);
      expect(ctx.syncClaudeAgentDefsBestEffort).not.toHaveBeenCalled();
      expect(ctx.deps.saveConfigPreservingClaudeCode).toHaveBeenCalledTimes(1);
      expect(ctx.convergeCodexCatalog).toHaveBeenCalledTimes(1);
      const result = await res!.json() as { pickerOrder: string[]; pickerOrderMode: string | null };
      expect(result.pickerOrder).toEqual(pickerOrder ?? []);
      expect(result.pickerOrderMode).toBe(pickerOrder?.length ? "most-used" : null);
    }
  });
  test("valid original roster arrays retain exact values, duplicates and five-slot cap", async () => {
    const config = makeConfig({ modelPickerOrder: ["gpt-5.5", "alpha/one"], modelPickerOrderMode: "provider" });
    const values = ["missing/model", "missing/model", "account/gpt-5.5", " native ", "", "sixth"];
    const ctx = context(config, { models: values });
    expect((await handleAgentSettingsRoutes(ctx))?.status).toBe(200);
    expect(config.subagentModels).toEqual(values.slice(0, 5));
    expect(config.modelPickerOrder).toEqual(["gpt-5.5", "alpha/one"]);
    expect(config.modelPickerOrderMode).toBe("provider");
    expect(ctx.syncClaudeAgentDefsBestEffort).toHaveBeenCalledTimes(1);
  });
  test.each([null, [], 1, "bad", {}, { pickerOrderMode: "provider" }, { models: null },
    { models: [1] }, { pickerOrder: [" "] }, { pickerOrder: ["alpha/one", " alpha/one "] },
    { pickerOrder: ["absent/model"], models: ["replacement"] },
    { pickerOrder: null, pickerOrderMode: "custom" }, { pickerOrder: ["gpt-5.5"] },
  ])("invalid body %j is rejected before any mutation", async body => {
    const config = makeConfig({ subagentModels: ["keep"], modelPickerOrder: ["alpha/one"], modelPickerOrderMode: "most-used" });
    const before = structuredClone(config);
    const ctx = context(config, body);
    expect((await handleAgentSettingsRoutes(ctx))?.status).toBe(400);
    expect(config).toEqual(before);
    expect(ctx.deps.saveConfigPreservingClaudeCode).not.toHaveBeenCalled();
    expect(ctx.convergeCodexCatalog).not.toHaveBeenCalled();
  });
  test("picker eligibility uses current allowlists and disabled rows, not retained roster membership", async () => {
    const config = makeConfig({ subagentModels: ["alpha/one", "beta/two"], disabledModels: ["beta/two"],
      providers: { alpha: { adapter: "openai-chat", baseUrl: "https://example.test/v1", selectedModels: ["other"] } } });
    const ctx = context(config, {});
    ctx.req = new Request(ctx.url);
    const res = await handleAgentSettingsRoutes(ctx);
    const result = await res!.json() as { available: string[]; pickerAvailable: string[] };
    expect(result.available).toContain("alpha/one");
    expect(result.available).toContain("beta/two");
    expect(result.pickerAvailable).toEqual([]);
    for (const id of ["alpha/one", "beta/two"]) {
      expect((await handleAgentSettingsRoutes(context(config, { pickerOrder: [id] })))?.status).toBe(400);
    }
  });
  test.each([{ pickerOrder: null }, { pickerOrder: ["beta/two"] }])("failed picker save %j restores fields AND deletion provenance", async ({ pickerOrder }) => {
    const config = makeConfig({ subagentModels: ["keep"], modelPickerOrder: ["alpha/one"], modelPickerOrderMode: "most-used" });
    deleteConfigTopLevelKey(config, "streamMode");
    const before = structuredClone(config);
    const intent = [...configRebaseDeletionKeys(config)];
    const projected = projectConfigRebaseProvenance(config);
    const ctx = context(config, { models: ["replacement"], pickerOrder });
    const save = mock((candidate: OcxConfig) => {
      expect(candidate.subagentModels).toEqual(["replacement"]);
      expect(candidate.modelPickerOrder).toEqual(pickerOrder ?? undefined);
      throw new Error("disk full");
    });
    ctx.deps.saveConfigPreservingClaudeCode = save;
    await expect(handleAgentSettingsRoutes(ctx)).rejects.toThrow("disk full");
    expect(save).toHaveBeenCalledTimes(1);
    expect(config).toEqual(before);
    expect([...configRebaseDeletionKeys(config)]).toEqual(intent);
    expect(projectConfigRebaseProvenance(config)).toEqual(projected);
    expect(ctx.convergeCodexCatalog).not.toHaveBeenCalled();
    // The next unrelated real save must not carry a phantom picker deletion.
    saveConfigPreservingClaudeCode(config);
    expect(loadConfig().modelPickerOrder).toEqual(["alpha/one"]);
    expect(loadConfig().modelPickerOrderMode).toBe("most-used");
  });
  test("unknown deletion provenance rejects picker writes without overwriting the newer format", async () => {
    const config = makeConfig({ modelPickerOrder: ["alpha/one"], configRebaseProvenance: { version: 2, deletedTopLevelKeys: [] } });
    const before = structuredClone(config);
    const ctx = context(config, { pickerOrder: null });
    expect((await handleAgentSettingsRoutes(ctx))?.status).toBe(409);
    expect(config).toEqual(before);
    expect(ctx.deps.saveConfigPreservingClaudeCode).not.toHaveBeenCalled();
  });
  test("failed clear from absent fields leaves no phantom deletion or provenance", async () => {
    const config = makeConfig();
    const ctx = context(config, { pickerOrder: null });
    ctx.deps.saveConfigPreservingClaudeCode = () => { throw new Error("disk full"); };
    await expect(handleAgentSettingsRoutes(ctx)).rejects.toThrow();
    expect(configHasRebaseProvenance(config)).toBe(false);
    expect([...configRebaseDeletionKeys(config)]).toEqual([]);
    expect(config).not.toHaveProperty("modelPickerOrder");
  });
  test("discovery yield cannot replace a concurrently saved roster", async () => {
    const config = makeConfig({ subagentModels: ["old"] });
    const ctx = context(config, { pickerOrder: ["alpha/one"] });
    let release!: (models: typeof rows) => void;
    let started!: () => void;
    const enteredDiscovery = new Promise<void>(resolve => { started = resolve; });
    ctx.deps.fetchAllModels = () => new Promise(resolve => { release = resolve; started(); });
    const pending = handleAgentSettingsRoutes(ctx);
    await enteredDiscovery;
    config.subagentModels = ["newer", "account/gpt-5.5"];
    release(rows);
    const result = await (await pending)!.json() as { applied: string[] };
    expect(config.subagentModels).toEqual(["newer", "account/gpt-5.5"]);
    expect(result.applied).toEqual(config.subagentModels);
  });
  test("failed convergence reports durable order without rolling it back", async () => {
    const config = makeConfig();
    const ctx = context(config, { pickerOrder: ["alpha/one"], pickerOrderMode: "provider" });
    ctx.convergeCodexCatalog = async () => ({ status: "failed", reason: "disk", phase: "commit", retryable: true, partialWrite: false });
    const result = await (await handleAgentSettingsRoutes(ctx))!.json() as { catalogRefresh: { status: string } };
    expect(result.catalogRefresh.status).toBe("failed");
    expect(config.modelPickerOrder).toEqual(["alpha/one"]);
  });
});
