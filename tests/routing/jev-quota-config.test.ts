import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { comboConfigIssues, getCombo } from "../../src/combos/types";
import { configSchema } from "../../src/config/schema/config-schema";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import { handleComboRoutes } from "../../src/server/management/combo-routes";
import { handleComboCommand } from "../../src/cli/combo";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const targets = [{ provider: "fixture", model: "m" }];
let home: TempHome;
let config: OcxConfig;
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-jq-config-");
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
  config = { port: 10100, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", models: ["m"] } }, combos: { saved: { strategy: "jev", targets, decisionQuotaSignals: true, decisionQuotaTiers: { moderate: 40 } } } };
  saveConfig(config);
});
afterEach(() => { log.mockRestore(); error.mockRestore(); home.remove(); });
/** Call the real combo management route handler and parse its response. */
async function api(method: string, body?: unknown): Promise<Response> {
  const req = new Request("http://127.0.0.1/api/combos", { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const response = await handleComboRoutes({ req, url: new URL(req.url), config, deps: {}, version: "fixture", trustedLoopbackIngress: true, guiSessionIssuance: null,
    convergeCodexCatalog: async () => ({ status: "committed", changed: false, degraded: false, notices: [] }), syncClaudeAgentDefsBestEffort: async () => {} });
  if (!response) throw new Error("missing combo response");
  return response;
}
const deps: RuntimeApiDeps = {
  findLiveProxy: async () => ({ pid: null, port: 14000, source: "runtime" }),
  fetchImpl: (async (_input, init) => api(init?.method ?? "GET", init?.body ? JSON.parse(String(init.body)) : undefined)) as typeof fetch,
};
/** PUT a combo definition, optionally renaming from an existing id. */
const put = (combo: unknown, id = "saved", renameFrom?: string) => api("PUT", { id, combo, ...(renameFrom ? { renameFrom } : {}) });

describe("quota config load and validation", () => {
  test("partial thresholds merge without enabling quota and load through real schema", () => {
    config.combos!.saved!.decisionQuotaSignals = false;
    config.combos!.saved!.decisionQuotaTiers = { limited: 80 };
    saveConfig(config);
    expect(getCombo(loadConfig(), "saved")).toMatchObject({ decisionQuotaTiers: { limited: 80, nearlyExhausted: 90 } });
    expect(getCombo(loadConfig(), "saved")).not.toHaveProperty("decisionQuotaSignals");
    expect(configSchema.safeParse(config).success).toBe(true);
    config.combos!.saved!.decisionQuotaTiers = { limited: 95 };
    expect(configSchema.safeParse(config).success).toBe(false);
  });
  test("only JEV strategy accepts policy, null clears and invalid values reject", () => {
    for (const combo of [{ strategy: "failover", targets, decisionQuotaSignals: true }, { strategy: "jev", targets, decisionQuotaSignals: "on" }, { strategy: "jev", targets, decisionQuotaTiers: { limited: 90 } }, { strategy: "jev", targets, decisionQuotaTiers: { moderate: 70 } }]) expect(comboConfigIssues("saved", combo, config.providers).length).toBeGreaterThan(0);
    expect(comboConfigIssues("saved", { strategy: "jev", targets, decisionQuotaSignals: null, decisionQuotaTiers: null }, config.providers)).toEqual([]);
  });
});
describe("actual API quota persistence", () => {
  test("GET/omitted GUI-style PUT/rename preserve advanced fields; clear/switch remove", async () => {
    expect((await put({ strategy: "jev", targets })).status).toBe(200);
    const listed = await (await api("GET")).json();
    expect(listed.combos[0]).toMatchObject({ decisionQuotaSignals: true, decisionQuotaTiers: { moderate: 40, limited: 70, nearlyExhausted: 90 } });
    expect((await put({ strategy: "jev", targets }, "renamed", "saved")).status).toBe(200);
    expect(config.combos?.saved).toBeUndefined();
    expect(loadConfig().combos?.renamed?.decisionQuotaSignals).toBe(true);
    expect((await put({ strategy: "jev", targets, decisionQuotaSignals: false }, "renamed")).status).toBe(200);
    expect(config.combos?.renamed).not.toHaveProperty("decisionQuotaSignals");
    expect(config.combos?.renamed).toHaveProperty("decisionQuotaTiers");
    expect((await put({ strategy: "jev", targets, decisionQuotaSignals: null, decisionQuotaTiers: null }, "renamed")).status).toBe(200);
    expect(config.combos?.renamed).not.toHaveProperty("decisionQuotaTiers");
    expect((await put({ strategy: "jev", targets, decisionQuotaSignals: true, decisionQuotaTiers: {} }, "renamed")).status).toBe(200);
    expect((await put({ strategy: "failover", targets }, "renamed")).status).toBe(200);
    expect(loadConfig().combos?.renamed).not.toHaveProperty("decisionQuotaSignals");
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).combos.renamed).not.toHaveProperty("decisionQuotaTiers");
  });
  test("invalid overrides do not mutate persisted policy", async () => {
    const before = readFileSync(getConfigPath(), "utf8");
    expect((await put({ strategy: "jev", targets, decisionQuotaTiers: { limited: 91 } })).status).toBe(400);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
  });
});
describe("actual CLI quota round trip", () => {
  test("partial update, raw target replacement, rename, off, explicit clear and strategy switch", async () => {
    expect(await handleComboCommand(["set", "saved", "--decision-quota-tiers", '{"limited":80}', "--json"], deps)).toBe(0);
    expect(config.combos?.saved).toMatchObject({ decisionQuotaSignals: true, decisionQuotaTiers: { limited: 80, nearlyExhausted: 90 } });
    expect(await handleComboCommand(["set", "saved", "--targets", "fixture/m", "--strategy", "jev", "--json"], deps)).toBe(0);
    expect(config.combos?.saved?.decisionQuotaSignals).toBe(true);
    expect(await handleComboCommand(["set", "renamed", "--rename-from", "saved", "--json"], deps)).toBe(0);
    expect(config.combos?.renamed?.decisionQuotaSignals).toBe(true);
    expect(await handleComboCommand(["set", "renamed", "--decision-quota-signals", "off", "--json"], deps)).toBe(0);
    expect(config.combos?.renamed).not.toHaveProperty("decisionQuotaSignals");
    expect(config.combos?.renamed).toHaveProperty("decisionQuotaTiers");
    expect(await handleComboCommand(["set", "renamed", "--decision-quota-signals", "on", "--decision-quota-tiers", "-", "--json"], deps)).toBe(0);
    expect(config.combos?.renamed).not.toHaveProperty("decisionQuotaTiers");
    expect(await handleComboCommand(["set", "renamed", "--decision-quota-signals", "-", "--json"], deps)).toBe(0);
    expect(config.combos?.renamed).not.toHaveProperty("decisionQuotaSignals");
    expect(await handleComboCommand(["set", "renamed", "--decision-quota-signals", "on", "--json"], deps)).toBe(0);
    expect(await handleComboCommand(["set", "renamed", "--strategy", "failover", "--json"], deps)).toBe(0);
    expect(config.combos?.renamed).not.toHaveProperty("decisionQuotaSignals");
  });
  test("malformed CLI overrides fail before writing", async () => {
    for (const args of [["--decision-quota-signals", "yes"], ["--decision-quota-tiers", "{"], ["--decision-quota-tiers", '{"limited":100}']]) expect(await handleComboCommand(["set", "saved", ...args, "--json"], deps)).not.toBe(0);
    expect(config.combos?.saved?.decisionQuotaTiers).toEqual({ moderate: 40 });
    const path = home.path("targets.json"); writeFileSync(path, JSON.stringify(targets));
    expect(await handleComboCommand(["set", "saved", "--targets-file", path, "--json"], deps)).toBe(0);
    expect(config.combos?.saved?.decisionQuotaSignals).toBe(true);
  });
});
