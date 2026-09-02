/**
 * `/api/settings` round-trip for the browser-open choice.
 *
 * The toggle is only useful if it survives a save and a reload, so this covers
 * the whole path the GUI actually uses: GET reports it, PUT persists it to
 * config.json, and a fresh `loadConfig()` reads it back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { handleManagementAPI, type ManagementApiDeps } from "../src/server/management-api";
import { invalidateStartupHealthCache } from "../src/server/startup-health-cache";
import type { OcxConfig } from "../src/types";
import { startupHealthFixture } from "./helpers/startup-health";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let TEST_DIR = "";
const previousHome = process.env.OPENCODEX_HOME;
const readTestStartupHealth: NonNullable<ManagementApiDeps["getCachedStartupHealth"]> = async () => (
  startupHealthFixture()
);

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-x", defaultModel: "gpt-test" },
    },
  };
}

function settingsRequest(config: OcxConfig, body?: unknown): Promise<Response | null> {
  const req = body === undefined
    ? new Request("http://127.0.0.1:10100/api/settings", { headers: { host: "127.0.0.1:10100" } })
    : new Request("http://127.0.0.1:10100/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", host: "127.0.0.1:10100" },
      body: JSON.stringify(body),
    });
  return handleManagementAPI(req, new URL(req.url), config, { getCachedStartupHealth: readTestStartupHealth });
}

beforeEach(() => {
  invalidateStartupHealthCache();
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-settings-openbrowser-"));
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  invalidateStartupHealthCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (TEST_DIR && existsSync(TEST_DIR)) {
    try { removeTreeWithRetry(TEST_DIR); } catch { /* Windows handle retention */ }
  }
});

describe("/api/settings oauthOpenBrowser", () => {
  test("an unconfigured install reports the historical auto-open", async () => {
    const res = await settingsRequest(baseConfig());
    const body = await res!.json() as { oauthOpenBrowser?: boolean };
    expect(body.oauthOpenBrowser).toBe(true);
  });

  test("declining persists to disk and survives a reload", async () => {
    const config = baseConfig();
    saveConfig(config);
    const put = await settingsRequest(config, { oauthOpenBrowser: false });
    expect(put!.status).toBe(200);
    expect(await put!.json()).toMatchObject({ ok: true, oauthOpenBrowser: false });
    // The live object and the file must agree, or a restart silently re-enables it.
    expect(config.oauthOpenBrowser).toBe(false);
    expect(loadConfig().oauthOpenBrowser).toBe(false);

    const get = await settingsRequest(config);
    expect(await get!.json()).toMatchObject({ oauthOpenBrowser: false });
  });

  test("it can be set on its own, without resending the other settings", async () => {
    const config = baseConfig();
    saveConfig(config);
    const res = await settingsRequest(config, { oauthOpenBrowser: false });
    expect(res!.status).toBe(200);
    // Unrelated settings keep their defaults rather than being cleared by a partial PUT.
    expect(await res!.json()).toMatchObject({ streamMode: "auto", codexAutoStart: true });
  });

  test("a non-boolean is rejected instead of being coerced", async () => {
    const res = await settingsRequest(baseConfig(), { oauthOpenBrowser: "no" });
    expect(res!.status).toBe(400);
    expect(await res!.json()).toMatchObject({ error: "oauthOpenBrowser boolean is required" });
  });

  test("turning it back on is also persisted", async () => {
    const config = baseConfig();
    config.oauthOpenBrowser = false;
    saveConfig(config);
    const res = await settingsRequest(config, { oauthOpenBrowser: true });
    expect(res!.status).toBe(200);
    expect(loadConfig().oauthOpenBrowser).toBe(true);
  });
});
