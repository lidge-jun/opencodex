import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import * as destinationPolicy from "../../src/lib/destination-policy";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Multi-step provider POST/GET flows exceed the default 5s per-test budget under
// full-suite Windows load (same flake class as management-provider-validation.test.ts).
setDefaultTimeout(60_000);

const previousOpencodexHome = process.env.OPENCODEX_HOME;
// A per-run directory, not a fixed literal: two concurrent runs of this file, or of any
// other management test that reuses a shared path, would delete each other's
// OPENCODEX_HOME mid-flight.
const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-management-provider-websocket-"));
let isolatedCodexHome: IsolatedCodexHome | null = null;

const canonicalDirect = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  codexAccountMode: "direct",
} as const;

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-upstream-websocket-codex-");
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

function makeConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "nvidia",
    providers: {
      nvidia: {
        adapter: "openai-chat",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "sk-nvidia",
      },
    },
  };
}

type ProviderRow = Record<string, unknown> & { name: string };
type RequestFn = (path: string, init?: RequestInit) => Promise<Response | null>;

// Direct handleManagementAPI calls (no startServer) keep the write/read contract in one
// synchronous authority, matching the transport tests in management-provider-validation.
async function withRequest(liveConfig: OcxConfig, run: (request: RequestFn) => Promise<void>): Promise<void> {
  const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  try {
    const request: RequestFn = async (path, init) => {
      const req = new Request(`http://127.0.0.1${path}`, init);
      return handleManagementAPI(req, new URL(req.url), liveConfig, {
        createManagementConvergeCodex: catalogConvergenceFactory(),
      });
    };
    await run(request);
  } finally {
    resolvedError.mockRestore();
  }
}

function postProvider(request: RequestFn, name: string, provider: Record<string, unknown>) {
  return request("/api/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, provider }),
  });
}

async function providerRow(request: RequestFn, name: string): Promise<ProviderRow> {
  const list = await request("/api/providers");
  expect(list?.status).toBe(200);
  const rows = await list!.json() as ProviderRow[];
  const row = rows.find(candidate => candidate.name === name);
  expect(row).toBeDefined();
  return row!;
}

/**
 * Repost a GET /api/providers row through POST /api/providers.
 *
 * The row is the source of every value, but it is not a legal POST body verbatim: for the
 * reserved `openai` name `providerManagementConfigError` compares the submitted provider
 * against the registry seed key for key, so the GET-only projections (`hasApiKey`,
 * `hasHeaders`, `discovery`, `entitlement`) and the row's non-seed defaults (`liveModels`,
 * `models`, `disabled`, `allowPrivateNetwork`) all have to go. What remains are the
 * canonical transport fields plus `upstreamWebsocket` when the row reports it -- which is
 * the field under test, because before #5704 the row always reported one.
 */
function repostedProvider(row: ProviderRow): Record<string, unknown> {
  const provider: Record<string, unknown> = {};
  for (const key of ["adapter", "baseUrl", "authMode", "codexAccountMode"] as const) {
    if (row[key] !== undefined) provider[key] = row[key];
  }
  if (row.upstreamWebsocket !== undefined) provider.upstreamWebsocket = row.upstreamWebsocket;
  return provider;
}

describe("provider upstream WebSocket reporting (#5704)", () => {
  test("canonical openai with upstreamWebsocket unset reports no key and reposts unset", async () => {
    saveConfig(makeConfig());
    const liveConfig = loadConfig();
    await withRequest(liveConfig, async (request) => {
      const created = await postProvider(request, "openai", { ...canonicalDirect });
      expect(created?.status).toBe(200);
      expect(loadConfig().providers.openai?.upstreamWebsocket).toBeUndefined();

      const row = await providerRow(request, "openai");
      expect(row).not.toHaveProperty("upstreamWebsocket");
      expect(row.upstreamWebsocket).toBeUndefined();

      const reposted = await postProvider(request, "openai", repostedProvider(row));
      expect(reposted?.status).toBe(200);
      expect(loadConfig().providers.openai?.upstreamWebsocket).toBeUndefined();
      expect(liveConfig.providers.openai?.upstreamWebsocket).toBeUndefined();
    });
  });

  test("canonical openai saved with upstreamWebsocket false reports false and reposts false", async () => {
    saveConfig(makeConfig());
    const liveConfig = loadConfig();
    await withRequest(liveConfig, async (request) => {
      const created = await postProvider(request, "openai", { ...canonicalDirect, upstreamWebsocket: false });
      expect(created?.status).toBe(200);

      const row = await providerRow(request, "openai");
      expect(row.upstreamWebsocket).toBe(false);

      const reposted = await postProvider(request, "openai", repostedProvider(row));
      expect(reposted?.status).toBe(200);
      expect(loadConfig().providers.openai?.upstreamWebsocket).toBe(false);
    });
  });

  test("a custom provider with upstreamWebsocket true still reports true", async () => {
    saveConfig(makeConfig());
    const liveConfig = loadConfig();
    await withRequest(liveConfig, async (request) => {
      const created = await postProvider(request, "ws-custom", {
        adapter: "openai-responses",
        baseUrl: "https://api.example.test/v1",
        upstreamWebsocket: true,
      });
      expect(created?.status).toBe(200);

      const row = await providerRow(request, "ws-custom");
      expect(row.upstreamWebsocket).toBe(true);

      const reposted = await postProvider(request, "ws-custom", repostedProvider(row));
      expect(reposted?.status).toBe(200);
      expect(loadConfig().providers["ws-custom"]?.upstreamWebsocket).toBe(true);
    });
  });
});
