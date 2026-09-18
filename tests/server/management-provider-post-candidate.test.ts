/**
 * Split out of management-provider-validation.test.ts because that file sits at its file-size
 * ratchet cap; the case itself is unchanged.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { config } from "../helpers/management-relative-send-paths";
import { managementFetch as fetch } from "../helpers/management-auth";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

setDefaultTimeout(60_000);

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const originalGlobalFetch = globalThis.fetch;
const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-management-provider-post-candidate-"));
let isolatedCodexHome: IsolatedCodexHome | null = null;

const canonicalDirect = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  codexAccountMode: "direct",
} as const;

function poolProviders(): OcxConfig["providers"] {
  return {
    openai: { ...canonicalDirect, codexAccountMode: "pool" },
  };
}

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-auth-codex-");
});

afterEach(() => {
  globalThis.fetch = originalGlobalFetch;
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

describe("provider management validation", () => {
  // A pins-less POST used to skip validateConfigCandidate entirely, so a provider
  // field the management boundary does not check (apiKeyPoolStrategy is an
  // editor-owned enum) could persist a schema-invalid candidate. The candidate
  // draft is now validated for every completed POST before live adoption.
  test("provider POST validates a pins-less candidate before live adoption", async () => {
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({ ...config("127.0.0.1"), providers: poolProviders() });

    const server = startServer(0);
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      const response = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "relay",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://relay.example/v1",
            apiKeyPoolStrategy: "bogus",
          },
        }),
      });
      expect(response.status).toBe(400);
      expect(loadConfig().providers.relay).toBeUndefined();
    } finally {
      resolvedError.mockRestore();
      await server.stop(true);
    }
  });
});
