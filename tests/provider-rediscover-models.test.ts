import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleManagementAPI } from "../src/server/management-api";
import { saveConfig } from "../src/config";
import { clearModelCache, getFreshCached, setCached } from "../src/codex/model-cache";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(tmpdir(), `ocx-rediscover-${process.pid}`);
const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  clearModelCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function baseConfig(providers: OcxConfig["providers"]): OcxConfig {
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: Object.keys(providers)[0]!,
    providers,
  } as OcxConfig;
  saveConfig(config);
  return config;
}

async function rediscover(config: OcxConfig, name: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request(`http://127.0.0.1/api/providers/rediscover-models?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { Host: "127.0.0.1" },
  });
  const res = await handleManagementAPI(req, new URL(req.url), config, {});
  if (!res) throw new Error("handler returned no response");
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe("POST /api/providers/rediscover-models", () => {
  test("static catalogs are not applicable", async () => {
    const config = baseConfig({
      staticy: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        liveModels: false,
        models: ["a"],
      },
    });
    const { status, body } = await rediscover(config, "staticy");
    expect(status).toBe(200);
    expect(body.applicable).toBe(false);
    expect(body.reason).toBe("static_catalog");
  });

  test("clears the provider model cache before catalog converge", async () => {
    setCached("proxy", [{ provider: "proxy", id: "stale-model", owned_by: "proxy" }], Date.now());
    expect(getFreshCached("proxy", 60_000)?.map(m => m.id)).toEqual(["stale-model"]);

    let sawModelsFetch = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/models")) {
        sawModelsFetch = true;
        return new Response(JSON.stringify({ data: [{ id: "fresh-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input);
    }) as typeof fetch;

    const config = baseConfig({
      proxy: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
        liveModels: true,
        models: [],
      },
    });
    (config.providers.proxy as { fetch?: typeof fetch }).fetch = globalThis.fetch;

    const { body } = await rediscover(config, "proxy");
    expect(getFreshCached("proxy", 60_000)?.map(m => m.id) ?? []).not.toContain("stale-model");
    expect(body).toMatchObject({ applicable: true, name: "proxy" });
    expect(typeof body.latencyMs).toBe("number");
    expect(sawModelsFetch || typeof body.ok === "boolean").toBe(true);
  });

  test("unknown provider is 404", async () => {
    const config = baseConfig({
      proxy: { adapter: "openai-chat", baseUrl: "https://example.test/v1", liveModels: true },
    });
    const { status, body } = await rediscover(config, "missing");
    expect(status).toBe(404);
    expect(body.error).toBe("unknown provider");
  });
});
