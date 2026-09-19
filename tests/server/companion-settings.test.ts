import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCompanionSettingsPatch,
  DEFAULT_COMPANION_SETTINGS,
  loadCompanionSettings,
  saveCompanionSettings,
} from "../../src/companion/settings";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";

const config = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;
async function withHome<T>(run: (home: string) => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "ocx-companion-"));
  const old = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try { return await run(home); } finally {
    if (old === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = old;
    rmSync(home, { recursive: true, force: true });
  }
}
async function call(method: string, body?: unknown): Promise<{ status: number; body: any }> {
  const url = new URL("http://127.0.0.1:10100/api/companion/settings");
  const req = new Request(url, {
    method,
    headers: { host: "127.0.0.1:10100", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleManagementAPI(req, url, config, {}, "admin-token");
  return { status: response?.status ?? 404, body: response ? await response.json() : null };
}

describe("companion settings", () => {
  test("defaults, corrupt files, validation, and roundtrip persistence", async () => {
    await withHome(home => {
      expect(loadCompanionSettings().settings).toEqual(DEFAULT_COMPANION_SETTINGS);
      writeFileSync(join(home, "companion.json"), "{");
      expect(loadCompanionSettings().settings).toEqual(DEFAULT_COMPANION_SETTINGS);
      expect(loadCompanionSettings().corrupt).toBe(true);
      expect(applyCompanionSettingsPatch(DEFAULT_COMPANION_SETTINGS, { unknown: true })).toEqual({ error: expect.any(String) });
      expect(applyCompanionSettingsPatch(DEFAULT_COMPANION_SETTINGS, { menuBarTemplate: "x".repeat(201) })).toEqual({ error: expect.any(String) });
      const updated = applyCompanionSettingsPatch(DEFAULT_COMPANION_SETTINGS, { showChart: false });
      if ("error" in updated) throw new Error(updated.error);
      saveCompanionSettings(updated);
      expect(loadCompanionSettings().settings.showChart).toBe(false);
    });
  });

  test("GET, PUT, and reset are routed", async () => {
    await withHome(async () => {
      expect((await call("GET")).status).toBe(200);
      expect((await call("PUT", { settings: { showToday: false } })).body.settings.showToday).toBe(false);
      expect((await call("PUT", { reset: true })).body.settings).toEqual(DEFAULT_COMPANION_SETTINGS);
      expect((await call("PUT", { settings: { bad: true } })).status).toBe(400);
    });
  });

  test("GET reports corrupt persisted settings without overwriting them", async () => {
    await withHome(async home => {
      writeFileSync(join(home, "companion.json"), "{");
      const result = await call("GET");
      expect(result.status).toBe(200);
      expect(result.body.corrupt).toBe(true);
      expect(readFileSync(join(home, "companion.json"), "utf8")).toBe("{");
    });
  });
});
