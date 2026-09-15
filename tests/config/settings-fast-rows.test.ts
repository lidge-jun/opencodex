/**
 * `/api/settings` round-trip for Fast selector rows.
 *
 * The toggle controls whether synthetic Fast selector rows appear in external client
 * pickers. GET reports it, PUT persists it to config.json, and a fresh `loadConfig()`
 * reads it back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { handleManagementAPI, type ManagementApiDeps } from "../../src/server/management-api";
import { invalidateStartupHealthCache } from "../../src/server/startup-health-cache";
import type { OcxConfig } from "../../src/types";
import { startupHealthFixture } from "../helpers/startup-health";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";

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

function settingsRequest(config: OcxConfig, body?: unknown, deps?: Partial<ManagementApiDeps>): Promise<Response | null> {
  const req = body === undefined
    ? new Request("http://127.0.0.1:10100/api/settings", { headers: { host: "127.0.0.1:10100" } })
    : new Request("http://127.0.0.1:10100/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", host: "127.0.0.1:10100" },
      body: JSON.stringify(body),
    });
  return handleManagementAPI(req, new URL(req.url), config, {
    getCachedStartupHealth: readTestStartupHealth,
    ...deps,
  });
}

beforeEach(() => {
  invalidateStartupHealthCache();
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-settings-fastrows-"));
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

describe("/api/settings fastRows", () => {
  test("an unconfigured install reports fastRows enabled by default", async () => {
    const res = await settingsRequest(baseConfig());
    const body = await res!.json() as { fastRows?: boolean };
    expect(body.fastRows).toBe(true);
  });

  test("disabling persists to disk and survives a reload", async () => {
    const config = baseConfig();
    saveConfig(config);
    const put = await settingsRequest(config, { fastRows: false });
    expect(put!.status).toBe(200);
    expect(await put!.json()).toMatchObject({ ok: true, fastRows: false });
    // The live object and the file must agree
    expect(config.fastRows).toBe(false);
    expect(loadConfig().fastRows).toBe(false);

    const get = await settingsRequest(config);
    expect(await get!.json()).toMatchObject({ fastRows: false });
  });

  test("it can be set on its own, without resending the other settings", async () => {
    const config = baseConfig();
    saveConfig(config);
    const res = await settingsRequest(config, { fastRows: false });
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ streamMode: "auto", codexAutoStart: true });
  });

  test("a non-boolean is rejected instead of being coerced", async () => {
    const res = await settingsRequest(baseConfig(), { fastRows: "disabled" });
    expect(res!.status).toBe(400);
    expect(await res!.json()).toMatchObject({ error: "fastRows boolean is required" });
  });

  test("turning it back on deletes the key and restores default true", async () => {
    const config = baseConfig();
    config.fastRows = false;
    saveConfig(config);
    const res = await settingsRequest(config, { fastRows: true });
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ ok: true, fastRows: true });
    expect(loadConfig().fastRows).toBe(true);
    const raw = JSON.parse(readFileSync(join(TEST_DIR, "config.json"), "utf8")) as Record<string, unknown>;
    expect(Object.hasOwn(raw, "fastRows")).toBe(false);
  });

  test("triggers catalog convergence when fastRows changes", async () => {
    let converged = 0;
    const config = baseConfig();
    saveConfig(config);
    const res = await settingsRequest(config, { fastRows: false }, {
      createManagementConvergeCodex: catalogConvergenceFactory(() => {
        converged += 1;
      }),
    });
    expect(res!.status).toBe(200);
    expect(converged).toBe(1);
  });
});
