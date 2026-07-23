import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { clearModelCache } from "../src/codex/model-cache";
import { loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const previousOpencodexHome = process.env.OPENCODEX_HOME;
const TEST_DIR = join(import.meta.dir, ".tmp-discovery-status-api");
let isolatedCodexHome: IsolatedCodexHome | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-discovery-status-");
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  clearModelCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("product path: Models discovery status via management API (#329)", () => {
  test("GET /api/providers exposes HTTP 401 discovery after catalog poll, and provider stays grouped", async () => {
    // Upstream that authorizes inference-shaped POSTs but rejects /models listing,
    // matching the Volcengine Agent Plan shape reported in #329.
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/models") || url.pathname.includes("/v1/models")) {
          return new Response(JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "AuthenticationError" },
          }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        if (req.method === "POST") {
          return new Response(JSON.stringify({ id: "msg_ok", content: [{ type: "text", text: "OK" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const config: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "agent-plan",
      providers: {
        "agent-plan": {
          adapter: "anthropic",
          baseUrl: `http://127.0.0.1:${upstream.port}/api/plan`,
          authMode: "key",
          apiKey: "plan-key-redacted",
          defaultModel: "glm-5-2",
          allowPrivateNetwork: true,
        },
      },
    };
    saveConfig(config);

    const server = startServer(0);
    try {
      // Product path #1: Models page loads /api/models (triggers live discovery).
      const modelsRes = await fetch(new URL("/api/models", server.url));
      expect(modelsRes.status).toBe(200);
      const models = await modelsRes.json() as Array<{ provider: string; id: string }>;
      const agentRows = models.filter(row => row.provider === "agent-plan");
      expect(agentRows.map(row => row.id)).toEqual(["glm-5-2"]);

      // Product path #2: Models page loads /api/providers for group metadata + badge.
      const providersRes = await fetch(new URL("/api/providers", server.url));
      expect(providersRes.status).toBe(200);
      const providers = await providersRes.json() as Array<{
        name: string;
        liveModels: boolean;
        discovery: {
          ok: boolean;
          kind: string;
          httpStatus?: number;
          fallback?: string;
        } | null;
      }>;
      const agent = providers.find(provider => provider.name === "agent-plan");
      expect(agent).toMatchObject({
        liveModels: true,
        discovery: {
          ok: false,
          kind: "http",
          httpStatus: 401,
          fallback: "configured",
        },
      });

      // Credential/config changes clear the cache (PATCH /api/providers, POST key, etc.).
      clearModelCache("agent-plan");
      const providersAfterClear = await fetch(new URL("/api/providers", server.url)).then(r => r.json()) as Array<{
        name: string;
        discovery: unknown;
      }>;
      expect(providersAfterClear.find(p => p.name === "agent-plan")?.discovery).toBeNull();
    } finally {
      await server.stop(true);
      upstream.stop(true);
    }
  }, 20_000);
});
