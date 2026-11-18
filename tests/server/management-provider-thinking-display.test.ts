/**
 * Management-boundary coverage for the Anthropic thinking display policy (#8363).
 *
 * A sibling file rather than an addition to management-provider-validation.test.ts, which
 * sits at its file-size ratchet cap (the same reason recorded in d3ca5522db and #4908).
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { providerManagementConfigError } from "../../src/server/auth-cors";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

setDefaultTimeout(60_000);

const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-management-thinking-display-"));
const previousHome = process.env.OPENCODEX_HOME;

function seedConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "synthetic",
        thinkingDisplay: "summarized",
      },
    },
  };
}

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

describe("provider management thinking display policy", () => {
  test("shared validator rejects unknown provider and model values", () => {
    const provider = { adapter: "anthropic" as const, baseUrl: "https://api.anthropic.com" };
    expect(providerManagementConfigError("anthropic", { ...provider, thinkingDisplay: "summarized" })).toBeNull();
    expect(providerManagementConfigError("anthropic", { ...provider, modelThinkingDisplay: { "claude-opus-5-5": "omitted" } })).toBeNull();
    expect(providerManagementConfigError("anthropic", { ...provider, thinkingDisplay: "always" })).toContain("thinkingDisplay");
    expect(providerManagementConfigError("anthropic", {
      ...provider,
      modelThinkingDisplay: { "claude-opus-5-5": "verbose" },
    })).toContain("modelThinkingDisplay");
  });

  test("PATCH merges model entries, clears one with null, and rejects an unknown value", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(seedConfig());
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    const server = startServer(0);
    try {
      const patch = (body: unknown) => fetch(new URL("/api/providers?name=anthropic", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      const merged = await patch({ modelThinkingDisplay: { "claude-opus-5-5": "summarized" } });
      expect(merged.status).toBe(200);
      expect(loadConfig().providers.anthropic!.modelThinkingDisplay).toEqual({ "claude-opus-5-5": "summarized" });

      const rejected = await patch({ modelThinkingDisplay: { "claude-opus-5-5": "verbose" } });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual(expect.objectContaining({
        error: expect.stringContaining("modelThinkingDisplay"),
      }));
      expect(loadConfig().providers.anthropic!.modelThinkingDisplay).toEqual({ "claude-opus-5-5": "summarized" });

      const cleared = await patch({ modelThinkingDisplay: { "claude-opus-5-5": null } });
      expect(cleared.status).toBe(200);
      expect(loadConfig().providers.anthropic!.modelThinkingDisplay).toBeUndefined();

      const clearedProvider = await patch({ thinkingDisplay: null });
      expect(clearedProvider.status).toBe(200);
      expect(loadConfig().providers.anthropic!.thinkingDisplay).toBeUndefined();
    } finally {
      await server.stop(true);
      resolvedError.mockRestore();
    }
  });

  test("same-destination POST keeps a policy the dashboard form cannot send", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      ...seedConfig(),
      providers: {
        anthropic: {
          ...seedConfig().providers.anthropic!,
          modelThinkingDisplay: { "claude-opus-5-5": "updates" },
        },
      },
    });
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "anthropic",
          provider: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "synthetic", defaultModel: "claude-opus-5-5" },
        }),
      });
      expect(response.status).toBe(200);
      const saved = loadConfig().providers.anthropic!;
      expect(saved.thinkingDisplay).toBe("summarized");
      expect(saved.modelThinkingDisplay).toEqual({ "claude-opus-5-5": "updates" });
    } finally {
      await server.stop(true);
      resolvedError.mockRestore();
    }
  });
});

