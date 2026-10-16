import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-management-request-pacing-"));
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let isolatedCodexHome: IsolatedCodexHome | null = null;
beforeEach(() => { isolatedCodexHome = installIsolatedCodexHome("ocx-pacing-home-"); });
afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

describe("provider management request pacing", () => {
  test("provider request pacing PATCH persists provider and model limits without catalog churn", async () => {
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "nvidia",
      providers: {
        nvidia: {
          adapter: "openai-chat",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "sk-nvidia",
          apiKeyPool: [{ id: "fixture-1", key: "sk-nvidia" }, { id: "fixture-2", key: "fixture-secondary" }],
        },
      },
    };
    saveConfig(liveConfig);
    let catalogRefreshes = 0;
    const request = async (path: string, init?: RequestInit) => {
      const req = new Request(`http://127.0.0.1${path}`, init);
      return handleManagementAPI(req, new URL(req.url), liveConfig, {
        createManagementConvergeCodex: catalogConvergenceFactory(() => { catalogRefreshes += 1; }),
      });
    };
    const policy = {
      enabled: true,
      requestsPerMinute: 38,
      minIntervalMs: 1_600,
      maxConcurrentRequests: 4,
      keySelection: "round-robin",
      keys: { requestsPerMinute: 15, maxConcurrentRequests: 1 },
      models: { "deepseek-ai/deepseek-v4-flash-0731": { requestsPerMinute: 10 } },
    };

    const saved = await request("/api/providers?name=nvidia", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestPacing: policy }),
    });
    expect(saved?.status).toBe(200);
    expect(liveConfig.providers.nvidia?.requestPacing).toEqual(policy);
    expect(loadConfig().providers.nvidia?.requestPacing).toEqual(policy);
    expect(catalogRefreshes).toBe(0);

    const providers = await request("/api/providers");
    expect((await providers?.json()).find((row: { name: string }) => row.name === "nvidia").requestPacing).toEqual(policy);
    const status = await request("/api/provider-request-pacing?name=nvidia");
    const statusBody = await status?.json();
    expect(statusBody).toMatchObject({ provider: "nvidia", enabled: true, queued: 0, nextSlotInMs: 0 });
    expect(statusBody.keys.map((row: { id: string }) => row.id)).toEqual(["fixture-1", "fixture-2"]);
    expect(JSON.stringify(statusBody)).not.toContain("sk-nvidia");
    expect(JSON.stringify(statusBody)).not.toContain("fixture-secondary");

    const invalid = await request("/api/providers?name=nvidia", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestPacing: { enabled: true, requestsPerMinute: -1 } }),
    });
    expect(invalid?.status).toBe(400);
    expect(liveConfig.providers.nvidia?.requestPacing).toEqual(policy);

    for (const rule of [{ keySelection: "random" }, { keys: {} }, { keys: { requestsPerMinute: 0 } },
      { keys: { maxConcurrentRequests: 1.5 } }]) {
      const rejected = await request("/api/providers?name=nvidia", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestPacing: { enabled: true, ...rule } }),
      });
      expect(rejected?.status).toBe(400);
      expect(liveConfig.providers.nvidia?.requestPacing).toEqual(policy);
    }

    const timerOverflow = await request("/api/providers?name=nvidia", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestPacing: { enabled: true, requestsPerMinute: 0.001 } }),
    });
    expect(timerOverflow?.status).toBe(400);
    expect(liveConfig.providers.nvidia?.requestPacing).toEqual(policy);

    const concurrencyOnly = await request("/api/providers?name=nvidia", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestPacing: {
        enabled: true,
        maxConcurrentRequests: 2,
        models: { "deepseek-ai/deepseek-v4-flash-0731": { maxConcurrentRequests: 1 } },
      } }),
    });
    expect(concurrencyOnly?.status).toBe(200);
    expect(liveConfig.providers.nvidia?.requestPacing).toEqual({
      enabled: true,
      maxConcurrentRequests: 2,
      models: { "deepseek-ai/deepseek-v4-flash-0731": { maxConcurrentRequests: 1 } },
    });

    const invalidConcurrency = await request("/api/providers?name=nvidia", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestPacing: { enabled: true, maxConcurrentRequests: 0 } }),
    });
    expect(invalidConcurrency?.status).toBe(400);
    expect(liveConfig.providers.nvidia?.requestPacing).toEqual({
      enabled: true,
      maxConcurrentRequests: 2,
      models: { "deepseek-ai/deepseek-v4-flash-0731": { maxConcurrentRequests: 1 } },
    });
  });

});
