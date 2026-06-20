import { describe, expect, test } from "bun:test";
import { refreshCodexModelCatalog } from "../src/codex-refresh";
import type { OcxConfig } from "../src/types";

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as OcxConfig;

describe("Codex catalog refresh", () => {
  test("replaces Codex's models cache whenever the materialized catalog exists", async () => {
    let invalidated = 0;
    let syncedFrom: string | null = null;
    const result = await refreshCodexModelCatalog(config, {
      syncCatalogModels: async () => ({ added: 0, path: "/tmp/opencodex-catalog.json" }),
      invalidateCodexModelsCache: () => { invalidated += 1; },
      syncCodexModelsCacheFromCatalog: (path) => { syncedFrom = path; },
      existsSync: () => true,
    });

    expect(result).toEqual({
      added: 0,
      path: "/tmp/opencodex-catalog.json",
      catalogExists: true,
      cacheSynced: true,
    });
    expect(invalidated).toBe(1);
    expect(syncedFrom).toBe("/tmp/opencodex-catalog.json");
  });

  test("does not touch the cache when no Codex catalog can be materialized", async () => {
    let invalidated = 0;
    let synced = false;
    const result = await refreshCodexModelCatalog(config, {
      syncCatalogModels: async () => ({ added: 0, path: "/tmp/missing-catalog.json" }),
      invalidateCodexModelsCache: () => { invalidated += 1; },
      syncCodexModelsCacheFromCatalog: () => { synced = true; },
      existsSync: () => false,
    });

    expect(result.catalogExists).toBe(false);
    expect(result.cacheSynced).toBe(false);
    expect(invalidated).toBe(0);
    expect(synced).toBe(false);
  });
});
