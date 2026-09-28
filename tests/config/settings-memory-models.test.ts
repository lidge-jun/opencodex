/**
 * `/api/settings` round-trip for per-phase memory routing.
 *
 * GET reports the block, PUT persists it to config.json and echoes it in its own response,
 * and a fresh `loadConfig()` reads it back. The echo is load-bearing: the dashboard panel
 * re-reads the response of its own save, so a response without the block would render both
 * phases as "Off" while the server still held them.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import { handleManagementAPI, type ManagementApiDeps } from "../../src/server/management-api";
import { invalidateStartupHealthCache } from "../../src/server/startup-health-cache";
import type { OcxConfig } from "../../src/types";
import { startupHealthFixture } from "../helpers/startup-health";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
let previousHome: string | undefined;

const baseConfig = (): OcxConfig => ({
  port: 10100,
  defaultProvider: "gateway",
  providers: { gateway: { adapter: "openai-chat", baseUrl: "https://gateway.test/v1", apiKey: "fixture" } },
});

function settings(cfg: OcxConfig, body?: unknown) {
  const req = new Request("http://127.0.0.1:10100/api/settings", {
    method: body === undefined ? "GET" : "PUT",
    headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const deps: Partial<ManagementApiDeps> = { getCachedStartupHealth: async () => startupHealthFixture() };
  return handleManagementAPI(req, new URL(req.url), cfg, deps);
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-memory-models-settings-"));
  process.env.OPENCODEX_HOME = home;
  invalidateStartupHealthCache();
});

afterEach(() => {
  invalidateStartupHealthCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("/api/settings memoryModels", () => {
  test("an unconfigured install reports no memory routing", async () => {
    const response = await settings(baseConfig());
    expect(await response!.json()).toMatchObject({ memoryModels: null });
  });

  test("a save is echoed in the PUT response, persisted, and reported by GET", async () => {
    const config = baseConfig();
    saveConfig(config);
    const setting = {
      extract: { model: "gateway/cheap" },
      consolidation: { model: "gateway/strong", reasoningEffort: "high" },
    };
    const put = await settings(config, { memoryModels: setting });
    expect(put!.status).toBe(200);
    expect(await put!.json()).toMatchObject({ ok: true, memoryModels: setting });
    expect(config.memoryModels).toEqual(setting);
    expect(loadConfig().memoryModels).toEqual(setting);
    expect(await (await settings(config))!.json()).toMatchObject({ memoryModels: setting });
  });

  test("null clears the block from the file and from the response", async () => {
    const config = baseConfig();
    config.memoryModels = { extract: { model: "gateway/cheap" } };
    saveConfig(config);
    const put = await settings(config, { memoryModels: null });
    expect(put!.status).toBe(200);
    expect(await put!.json()).toMatchObject({ memoryModels: null });
    expect(config.memoryModels).toBeUndefined();
    expect(loadConfig().memoryModels).toBeUndefined();
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    expect(Object.hasOwn(raw, "memoryModels")).toBe(false);
  });

  test("a malformed phase is rejected before any mutation", async () => {
    const config = baseConfig();
    config.memoryModels = { extract: { model: "gateway/cheap" } };
    saveConfig(config);
    const before = structuredClone(config);
    for (const value of [{ extract: { model: " " } }, { extract: { model: "m", reasoningEffort: "bogus" } },
      { extract: { model: "m", extra: true } }, { extract: "gateway/cheap" }]) {
      const response = await settings(config, { memoryModels: value });
      expect(response!.status).toBe(400);
      expect(config).toEqual(before);
    }
  });

  test.each(["merged defaults", "salvaged profile"])("warns about a degraded phase after %s", route => {
    const raw: Record<string, unknown> = { ...baseConfig(), memoryModels: { extract: { model: " " } } };
    if (route === "merged defaults") delete raw.defaultProvider;
    else raw.routingProfiles = { bad: { candidates: [] } };
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = loadConfig();
      expect(loaded.providers.gateway).toBeDefined();
      expect(loaded.memoryModels?.extract).toBeUndefined();
      expect(warn.mock.calls.flat().join("\n")).toContain("memoryModels.extract is invalid");
    } finally { warn.mockRestore(); }
  });
});
