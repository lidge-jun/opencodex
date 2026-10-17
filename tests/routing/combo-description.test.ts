import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { comboConfigIssues, normalizeComboConfig } from "../../src/combos";
import { getConfigPath, readConfigDiagnostics, saveConfig } from "../../src/config";
import { handleComboCommand } from "../../src/cli/combo";
import { printComboWriteResult } from "../../src/cli/combo-result";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { handleComboRoutes } from "../../src/server/management/combo-routes";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const targets = [{ provider: "fixture", model: "model" }];
const refresh = { status: "committed" as const, changed: false, degraded: false, notices: [] };
let home: TempHome;
let token: string | undefined;
let output: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;
let network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-combo-description-");
  token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  output.mockRestore(); errors.mockRestore(); network.mockRestore();
  if (token === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = token;
  home.remove();
});
function config(): OcxConfig {
  return {
    port: 10100, defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", models: ["model"], liveModels: false } },
    combos: { saved: { targets } },
  };
}
async function api(config: OcxConfig, method: string, body?: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/combos", {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await handleComboRoutes({
    req, url: new URL(req.url), config, deps: {}, version: "fixture",
    trustedLoopbackIngress: true, guiSessionIssuance: null,
    convergeCodexCatalog: async () => refresh,
    syncClaudeAgentDefsBestEffort: async () => {},
  });
  expect(response).not.toBeNull();
  return response!;
}
async function listed(config: OcxConfig): Promise<Record<string, unknown>[]> {
  const response = await api(config, "GET");
  expect(response.status).toBe(200);
  return (await response.json()).combos;
}

describe("combo description contract (#7229)", () => {
  for (const [label, description] of [
    ["number", 42], ["null", null], ["129 characters", "x".repeat(129)],
    ["C0", "before\u0000after"], ["newline", "before\nafter"], ["DEL", "before\u007fafter"],
    ["C1 NEL", "before\u0085after"], ["C1 CSI", "before\u009bafter"],
  ] as const) test(`rejects ${label} with the description path`, () => {
    const issues = comboConfigIssues("saved", { targets, description }, config().providers);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["description"]);
    expect(issues[0]?.message).toContain("description must be");
  });
  test("accepts the trimmed 128-character boundary and normalizes sparsely", () => {
    const description = "x".repeat(128);
    expect(comboConfigIssues("saved", { targets, description: `  ${description}  ` }, config().providers)).toEqual([]);
    expect(normalizeComboConfig({ targets, description: "  A useful combo  " }).description).toBe("A useful combo");
    for (const description of [undefined, "", "   "]) {
      expect(normalizeComboConfig({ targets, description })).not.toHaveProperty("description");
    }
  });

  test("management set, GET, omission, rename and explicit clear preserve sparse disk state", async () => {
    const cfg = config();
    saveConfig(cfg);
    const set = await api(cfg, "PUT", { id: "saved", combo: { targets, description: "  Fast coding route  " } });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ combo: { description: "Fast coding route" } });
    expect((await listed(cfg))[0]).toMatchObject({ id: "saved", description: "Fast coding route" });
    expect((await api(cfg, "PUT", { id: "saved", combo: { targets } })).status).toBe(200);
    expect((await listed(cfg))[0]?.description).toBe("Fast coding route");
    expect((await api(cfg, "PUT", { id: "renamed", renameFrom: "saved", combo: { targets } })).status).toBe(200);
    expect(cfg.combos).not.toHaveProperty("saved");
    expect((await listed(cfg))[0]).toMatchObject({ id: "renamed", description: "Fast coding route" });
    expect(readConfigDiagnostics().config.combos?.renamed?.description).toBe("Fast coding route");
    expect((await api(cfg, "PUT", { id: "renamed", combo: { targets, description: "" } })).status).toBe(200);
    expect((await listed(cfg))[0]).not.toHaveProperty("description");
    expect(cfg.combos?.renamed).not.toHaveProperty("description");
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).combos.renamed).not.toHaveProperty("description");
  });

  test("invalid management descriptions return 400 and leave memory and disk intact", async () => {
    const cfg = config();
    saveConfig(cfg);
    const before = structuredClone(cfg);
    const disk = readFileSync(getConfigPath(), "utf8");
    for (const description of [false, null, "x".repeat(129), "bad\u001ftext", "bad\u007ftext"]) {
      const response = await api(cfg, "PUT", { id: "saved", combo: { targets, description } });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("description must be");
      expect(cfg).toEqual(before);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(disk);
    }
  });

  test("CLI --description and '-' round-trip through the real management handler and receipt", async () => {
    const cfg = config();
    saveConfig(cfg);
    const deps: RuntimeApiDeps = {
      findLiveProxy: async () => ({ pid: null, port: 14000, source: "runtime" }),
      fetchImpl: (async (input, init) => {
        expect(new URL(String(input)).pathname).toBe("/api/combos");
        return api(cfg, init?.method ?? "GET", init?.body ? JSON.parse(String(init.body)) : undefined);
      }) as typeof fetch,
    };
    expect(await handleComboCommand(["set", "saved", "--description", "CLI description", "--json"], deps)).toBe(0);
    expect(cfg.combos?.saved?.description).toBe("CLI description");
    const receipt = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
    expect(receipt.combo.description).toBe("CLI description");
    expect(printComboWriteResult(receipt, "saved", true)).toBe(0);
    expect(() => printComboWriteResult({ ...receipt, combo: { ...receipt.combo, description: 1 } }, "saved", true))
      .toThrow("Invalid combo receipt");
    expect(await handleComboCommand(["set", "saved", "--description", "-", "--json"], deps)).toBe(0);
    expect(cfg.combos?.saved).not.toHaveProperty("description");
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).combo).not.toHaveProperty("description");
    expect(readConfigDiagnostics().config.combos?.saved).not.toHaveProperty("description");
  });

  test("config salvage drops the whole invalid combo just as it does an invalid displayName", () => {
    for (const field of ["displayName", "description"] as const) {
      const cfg = config();
      cfg.combos = { valid: { targets, description: "Keep this description" }, invalid: { targets, [field]: "x".repeat(129) } };
      writeFileSync(getConfigPath(), JSON.stringify(cfg));
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain(`combos.invalid.${field}`);
      expect(diagnostics.config.combos).not.toHaveProperty("invalid");
      expect(diagnostics.config.combos?.valid?.description).toBe("Keep this description");
      expect(diagnostics.config.providers.fixture).toEqual(expect.objectContaining(cfg.providers.fixture!));
    }
  });

  test("a valid description survives save and reload without dropping sibling combos", () => {
    const cfg = config();
    cfg.combos!.saved!.description = "A persisted description";
    cfg.combos!.other = { targets };
    saveConfig(cfg);
    const first = readConfigDiagnostics();
    expect(first.source).toBe("file");
    expect(first.error).toBeNull();
    expect(first.config.combos?.saved?.description).toBe("A persisted description");
    saveConfig(first.config);
    expect(readConfigDiagnostics().config.combos?.saved?.description).toBe("A persisted description");
    expect(readConfigDiagnostics().config.combos?.other).not.toHaveProperty("description");
  });
});
