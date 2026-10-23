import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import { handleComboCommand } from "../../src/cli/combo";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { handleComboRoutes } from "../../src/server/management/combo-routes";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const targets = [{ provider: "fixture", model: "m" }];
let home: TempHome;
let config: OcxConfig;
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = createTempHome("ocx-jev-session-pin-cli-");
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
  config = {
    port: 10100,
    defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", models: ["m"] } },
    combos: { saved: { strategy: "jev", targets } },
  };
  saveConfig(config);
});
afterEach(() => { log.mockRestore(); error.mockRestore(); home.remove(); });

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
const put = (combo: unknown, id = "saved", renameFrom?: string) => api("PUT", { id, combo, ...(renameFrom ? { renameFrom } : {}) });
const stored = () => JSON.parse(readFileSync(getConfigPath(), "utf8")).combos as Record<string, Record<string, unknown>>;

describe("JEV session pin management (#7525)", () => {
  test("the API stores the pin sparsely, keeps it across omitted saves and renames, and drops it on clear or switch", async () => {
    expect((await put({ strategy: "jev", targets, sessionPin: { ttlMs: 1_200_000 } })).status).toBe(200);
    expect(stored().saved).toMatchObject({ sessionPin: { ttlMs: 1_200_000 } });
    expect((await (await api("GET")).json()).combos[0]).toMatchObject({ sessionPin: { ttlMs: 1_200_000 } });
    // The dashboard does not send the field; its save must not turn the pin off.
    expect((await put({ strategy: "jev", targets }, "renamed", "saved")).status).toBe(200);
    expect(loadConfig().combos?.renamed?.sessionPin).toEqual({ ttlMs: 1_200_000 });
    expect((await put({ strategy: "jev", targets, sessionPin: null }, "renamed")).status).toBe(200);
    expect(stored().renamed).not.toHaveProperty("sessionPin");
    expect((await put({ strategy: "jev", targets, sessionPin: { ttlMs: 60_000 } }, "renamed")).status).toBe(200);
    expect((await put({ strategy: "failover", targets }, "renamed")).status).toBe(200);
    expect(stored().renamed).not.toHaveProperty("sessionPin");
  });

  test("the API refuses an out-of-range or non-JEV pin without writing", async () => {
    const before = readFileSync(getConfigPath(), "utf8");
    expect((await put({ strategy: "jev", targets, sessionPin: { ttlMs: 1_000 } })).status).toBe(400);
    expect((await put({ strategy: "failover", targets, sessionPin: { ttlMs: 60_000 } })).status).toBe(400);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("the CLI sets, keeps, clears and rejects the pin", async () => {
    expect(await handleComboCommand(["set", "saved", "--session-pin", "20m", "--json"], deps)).toBe(0);
    expect(config.combos?.saved?.sessionPin).toEqual({ ttlMs: 1_200_000 });
    expect(await handleComboCommand(["set", "saved", "--decision-timeout", "5000", "--json"], deps)).toBe(0);
    expect(config.combos?.saved?.sessionPin).toEqual({ ttlMs: 1_200_000 });
    expect(await handleComboCommand(["set", "saved", "--session-pin", "-", "--json"], deps)).toBe(0);
    expect(config.combos?.saved).not.toHaveProperty("sessionPin");
    for (const value of ["30s", "2d", "soon"]) {
      expect(await handleComboCommand(["set", "saved", "--session-pin", value, "--json"], deps)).not.toBe(0);
    }
    expect(await handleComboCommand(["set", "saved", "--strategy", "failover", "--session-pin", "20m", "--json"], deps)).not.toBe(0);
    expect(await handleComboCommand(["set", "saved", "--session-pin", "1h", "--json"], deps)).toBe(0);
    expect(await handleComboCommand(["set", "saved", "--strategy", "failover", "--json"], deps)).toBe(0);
    expect(config.combos?.saved).not.toHaveProperty("sessionPin");
  });
});
