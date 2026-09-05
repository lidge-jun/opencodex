import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import { handleManagementAPI, type ManagementApiDeps } from "../../src/server/management-api";
import { invalidateStartupHealthCache } from "../../src/server/startup-health-cache";
import type { OcxConfig } from "../../src/types";
import { startupHealthFixture } from "../helpers/startup-health";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
const config = (): OcxConfig => ({
  port: 10100,
  defaultProvider: "example",
  providers: { example: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "fixture" } },
});

function request(cfg: OcxConfig, body?: unknown, overrides: Partial<ManagementApiDeps> = {}) {
  const req = new Request("http://127.0.0.1:10100/api/settings", {
    method: body === undefined ? "GET" : "PUT",
    headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleManagementAPI(req, new URL(req.url), cfg, {
    getCachedStartupHealth: async () => startupHealthFixture(),
    ...overrides,
  });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-hard-lock-settings-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  invalidateStartupHealthCache();
});

afterEach(() => {
  invalidateStartupHealthCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

describe("main-account 99 percent setting", () => {
  test("GET reports off without an implicit opt-in", async () => {
    const response = await request(config());
    expect(await response!.json()).toMatchObject({
      codexMainAccountHardLock: false,
      mainAccountHardLock: { enabled: false, state: "off" },
    });
  });

  test("PUT acknowledges the stored boolean and survives reload", async () => {
    const cfg = config();
    saveConfig(cfg);
    const response = await request(cfg, { codexMainAccountHardLock: true });
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: true, codexMainAccountHardLock: true });
    expect(loadConfig().codexMainAccountHardLock).toBe(true);
    expect(cfg.providers.example.baseUrl).toBe("https://example.test/v1");
  });

  test("disabling deletes only this key and preserves other account controls", async () => {
    const cfg = { ...config(), codexMainAccountHardLock: true, pausedCodexAccountIds: ["__main__"], autoSwitchThreshold: 73 };
    saveConfig(cfg);
    const response = await request(cfg, { codexMainAccountHardLock: false });
    expect(await response!.json()).toMatchObject({ ok: true, codexMainAccountHardLock: false });
    expect(Object.hasOwn(cfg, "codexMainAccountHardLock")).toBe(false);
    const disk = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    expect(Object.hasOwn(disk, "codexMainAccountHardLock")).toBe(false);
    expect(cfg.pausedCodexAccountIds).toEqual(["__main__"]);
    expect(cfg.autoSwitchThreshold).toBe(73);
  });

  test.each(["true", 99, null, [], {}])("rejects nonboolean %j without mutation", async value => {
    const cfg = config();
    const response = await request(cfg, { codexMainAccountHardLock: value });
    expect(response!.status).toBe(400);
    expect(Object.hasOwn(cfg, "codexMainAccountHardLock")).toBe(false);
  });

  test("persistence failure restores absent and present values exactly", async () => {
    for (const previous of [undefined, false, true]) {
      const cfg = config();
      if (previous !== undefined) cfg.codexMainAccountHardLock = previous;
      await expect(request(cfg, { codexMainAccountHardLock: previous !== true }, {
        saveConfigPreservingClaudeCode: () => { throw new Error("fixture save failure"); },
      })).rejects.toThrow("fixture save failure");
      expect(cfg.codexMainAccountHardLock).toBe(previous);
      expect(Object.hasOwn(cfg, "codexMainAccountHardLock")).toBe(previous !== undefined);
    }
  });

  test("malformed hand edits remain off", () => {
    saveConfig(config());
    const path = getConfigPath();
    const disk = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...disk, codexMainAccountHardLock: "yes" }));
    expect(loadConfig().codexMainAccountHardLock).toBe(false);
  });
});
