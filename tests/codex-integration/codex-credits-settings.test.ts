import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { validateConfigCandidate } from "../../src/config/diagnostics";
import { configSchema } from "../../src/config/schema/config-schema";
import { safeConfigDTO } from "../../src/server/auth-cors";
import { handleManagementAPI, type ManagementApiDeps } from "../../src/server/management-api";
import { invalidateStartupHealthCache } from "../../src/server/startup-health-cache";
import type { OcxConfig } from "../../src/types";
import { startupHealthFixture } from "../helpers/startup-health";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir: string;
let previousHome: string | undefined;
const baseConfig = (): OcxConfig => ({ port: 10100, defaultProvider: "openai", providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "fixture-key", defaultModel: "gpt-test" } } });

function request(config: OcxConfig, body?: unknown, deps: Partial<ManagementApiDeps> = {}) {
  const req = new Request("http://127.0.0.1:10100/api/settings", {
    method: body === undefined ? "GET" : "PUT",
    headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleManagementAPI(req, new URL(req.url), config, {
    getCachedStartupHealth: async () => startupHealthFixture(), ...deps,
  });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-credits-settings-"));
  process.env.OPENCODEX_HOME = testDir;
  invalidateStartupHealthCache();
});
afterEach(() => {
  invalidateStartupHealthCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(testDir);
});

describe("credits settings contract", () => {
  test("GET settings and safe config default off", async () => {
    const config = baseConfig();
    const response = await request(config);
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ showCodexCredits: false });
    expect(safeConfigDTO(config)).toMatchObject({ showCodexCredits: false });
  });
  test("PUT true and false persist, respond, and survive config reload", async () => {
    const config = baseConfig();
    saveConfig(config);
    for (const enabled of [true, false]) {
      const put = await request(config, { showCodexCredits: enabled });
      expect(put!.status).toBe(200);
      expect(await put!.json()).toMatchObject({ ok: true, showCodexCredits: enabled });
      expect(config.showCodexCredits).toBe(enabled);
      expect(loadConfig().showCodexCredits).toBe(enabled);
      expect(await (await request(config))!.json()).toMatchObject({ showCodexCredits: enabled });
      expect(safeConfigDTO(config)).toMatchObject({ showCodexCredits: enabled });
    }
  });
  test.each(["true", 1, null, {}, []].map(value => [value]))("PUT rejects non-boolean %j before mutation or persistence", async value => {
    const config = baseConfig();
    let saves = 0;
    const response = await request(config, { showCodexCredits: value }, { saveConfigPreservingClaudeCode: () => { saves++; } });
    expect(response!.status).toBe(400);
    expect(await response!.json()).toMatchObject({ error: "showCodexCredits boolean is required" });
    expect(Object.hasOwn(config, "showCodexCredits")).toBe(false);
    expect(saves).toBe(0);
  });
  test.each([undefined, false, true])("save failure restores value and presence %s", async previous => {
    const config = baseConfig();
    if (previous !== undefined) config.showCodexCredits = previous;
    await expect(request(config, { showCodexCredits: previous !== true }, {
      saveConfigPreservingClaudeCode: () => { throw new Error("fixture disk failure"); },
    })).rejects.toThrow("fixture disk failure");
    expect(config.showCodexCredits).toBe(previous);
    expect(Object.hasOwn(config, "showCodexCredits")).toBe(previous !== undefined);
  });
  test("disk loading degrades malformed boolean but config candidates reject it", () => {
    expect(configSchema.parse({ ...baseConfig(), showCodexCredits: "bad" }).showCodexCredits).toBe(false);
    expect(configSchema.parse(baseConfig()).showCodexCredits).toBeUndefined();
    expect(validateConfigCandidate({ ...baseConfig(), showCodexCredits: "bad" })).toEqual({
      ok: false, error: "schema_invalid: showCodexCredits: must be a boolean or omitted",
    });
    expect(validateConfigCandidate({ ...baseConfig(), showCodexCredits: true }).ok).toBe(true);
  });
});
