/**
 * The pins-less provider POST validation case, held in a sibling file.
 *
 * Split out of management-provider-validation.test.ts for the reason recorded in
 * d3ca5522db and #4908: that file sits at its file-size ratchet cap and the cap only
 * ever moves downward, so a case added after it was set fails the ratchet for every
 * later pull request. The case is unchanged apart from its own temp directory.
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { config } from "../helpers/management-relative-send-paths";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

setDefaultTimeout(60_000);

const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-management-provider-pinsless-"));
const previousHome = process.env.OPENCODEX_HOME;

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

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
});

describe("provider management validation", () => {
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
