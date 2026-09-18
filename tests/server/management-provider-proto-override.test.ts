/**
 * The prototype-named model context override, held in a sibling file.
 *
 * Split out of management-provider-validation.test.ts for the reason recorded in
 * d3ca5522db and #4908: that file sits at its file-size ratchet cap, and the cap only
 * ever moves downward, so a test added to it after the cap was set fails the ratchet
 * for every later pull request rather than only its own. The case is unchanged.
 */
import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

setDefaultTimeout(60_000);

const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-management-provider-proto-"));

const canonicalDirect = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  codexAccountMode: "direct",
} as const;

describe("provider management validation", () => {
  // A "__proto__" model id is a legitimate override key once the GUI can draft it.
  // The merge target must be a null-prototype map: on an ordinary object the
  // assignment windows["__proto__"] = n invokes the inherited setter, so the
  // PATCH would return success while silently dropping the override.
  test("PATCH modelContextWindows persists a __proto__-named model override", async () => {
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      openaiProviderTierVersion: 2,
      defaultProvider: "openai",
      providers: {
        openai: { ...canonicalDirect },
      },
    } as OcxConfig);
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);

    const server = startServer(0);
    try {
      const patch = await fetch(new URL("/api/providers?name=openai", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // Written as a raw body: an object literal "__proto__" key would set the
        // prototype instead of creating the own property under test.
        body: '{"modelContextWindows":{"__proto__":128000}}',
      });
      expect(patch.status).toBe(200);
      const windows = loadConfig().providers.openai?.modelContextWindows ?? {};
      expect(Object.hasOwn(windows, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(windows, "__proto__")?.value).toBe(128000);
    } finally {
      resolvedError.mockRestore();
      await server.stop(true);
      removeTreeWithRetry(TEST_DIR);
    }
  });
});
