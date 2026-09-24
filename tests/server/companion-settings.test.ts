import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCompanionSettingsPatch,
  DEFAULT_COMPANION_SETTINGS,
  loadCompanionSettings,
  saveCompanionSettings,
} from "../../src/companion/settings";
import type { OcxConfig } from "../../src/types";

// `mock.module` outlives this file: Bun keeps the override below for every file that runs after
// this one in the same process. This is a spread snapshot of the real module, taken before it.
const realOpenUrl = { ...(await import("../../src/lib/open-url")) };
const opened: string[] = [];
mock.module("../../src/lib/open-url", () => ({
  openUrl: (url: string) => {
    opened.push(url);
  },
}));
afterAll(() => {  // Put the real module back for every later file in the same process.
  mock.module("../../src/lib/open-url", () => realOpenUrl);
});
const { resetCompanionPresenceForTests } = await import("../../src/server/management/companion-routes");
const { handleManagementAPI } = await import("../../src/server/management-api");

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
async function callPath(path: string, method: string, body?: unknown, userAgent?: string): Promise<{ status: number; body: any }> {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const req = new Request(url, {
    method,
    headers: {
      host: "127.0.0.1:10100",
      ...(userAgent ? { "user-agent": userAgent } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleManagementAPI(req, url, config, {}, "admin-token");
  return { status: response?.status ?? 404, body: response ? await response.json() : null };
}
async function call(method: string, body?: unknown, userAgent?: string): Promise<{ status: number; body: any }> {
  return callPath("/api/companion/settings", method, body, userAgent);
}

describe("companion settings", () => {
  // INV-COMPANION-02
  test("a chart selection saved per pool account names the merged timeline row", async () => {
    await withHome(async home => {
      writeFileSync(join(home, "companion.json"), JSON.stringify({
        models: ["openai-p6bc633/gpt-6-astra", "openai-pe2d42f/gpt-6-astra", "chatgpt/gpt-5.6-sol", "xai/grok-4.7"],
      }));
      expect(loadCompanionSettings().settings.models).toEqual(["openai/gpt-6-astra", "openai/gpt-5.6-sol", "xai/grok-4.7"]);
      const result = await call("PUT", { settings: { models: ["openai-main/gpt-5.6-luna", "openai/gpt-5.6-luna"] } });
      expect(result.body.settings.models).toEqual(["openai/gpt-5.6-luna"]);
    });
  });

  test("nested native model identifiers survive settings writes", async () => {
    await withHome(async () => {
      const models = ["cloudflare-ai/@cf/meta/llama", "github-models/openai/gpt-4.1"];
      const result = await call("PUT", { settings: { models } });
      expect(result.status).toBe(200);
      expect(result.body.settings.models).toEqual(models);
      expect(loadCompanionSettings().settings.models).toEqual(models);
      for (const invalid of ["/model", "provider/", "provider/two words"]) {
        expect((await call("PUT", { settings: { models: [invalid] } })).status).toBe(400);
      }
    });
  });

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

  test.each(["{", JSON.stringify({ version: 999, futureSetting: "preserve" })])("partial writes preserve unsupported settings until an explicit reset: %s", async contents => {
    await withHome(async home => {
      const path = join(home, "companion.json");
      writeFileSync(path, contents);
      const rejected = await call("PUT", { settings: { showChart: false } });
      expect(rejected.status).toBe(409);
      expect(rejected.body.code).toBe("companion_settings_corrupt");
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect((await call("PUT", { reset: true })).status).toBe(200);
      expect(loadCompanionSettings().corrupt).toBeUndefined();
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

  test("GET records menu bar presence only for the companion user agent", async () => {
    await withHome(async () => {
      resetCompanionPresenceForTests();
      const initial = await call("GET");
      expect(initial.body.companion.lastSeenAt).toBeNull();
      const ordinary = await call("GET", undefined, "Mozilla/5.0");
      expect(ordinary.body.companion.lastSeenAt).toBeNull();
      const companion = await call("GET", undefined, "OpenCodexMenuBar/2.60.0");
      expect(companion.body.companion.lastSeenAt).toBeNumber();
      expect(companion.body.companion.kind).toBe("menuBar");
      resetCompanionPresenceForTests();
      const desktop = await call("GET", undefined, "OpenCodexDesktop/2.61.0");
      expect(desktop.body.companion.lastSeenAt).toBeNumber();
      expect(desktop.body.companion.kind).toBe("desktop");
    });
  });

  test("opens only validated local dashboard paths in the browser", async () => {
    await withHome(async () => {
      opened.length = 0;
      for (const path of ["https://x", "//x", 42]) {
        const result = await callPath("/api/companion/open-in-browser", "POST", { path });
        expect(result.status).toBe(400);
        expect(result.body).toEqual({ error: "invalid path" });
        expect(opened).toEqual([]);
      }
      const result = await callPath("/api/companion/open-in-browser", "POST", { path: "/#/usage" });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, url: "http://127.0.0.1:10100/#/usage" });
      expect(opened).toEqual(["http://127.0.0.1:10100/#/usage"]);
    });
  });
});
