import { describe, expect, test } from "bun:test";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import type { OcxConfig } from "../src/types";

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as OcxConfig;

describe("Codex catalog refresh", () => {
  test("writes an expired Codex models cache whenever the materialized catalog exists", async () => {
    let invalidated = 0;
    const result = await refreshCodexModelCatalog(config, {
      syncCatalogModels: async () => ({
        added: 0,
        path: "/tmp/opencodex-catalog.json",
        catalogWritten: true,
        comboOmissions: [],
      }),
      invalidateCodexModelsCache: () => {
        invalidated += 1;
        return true;
      },
      existsSync: () => true,
    });

    expect(result).toEqual({
      added: 0,
      path: "/tmp/opencodex-catalog.json",
      catalogExists: true,
      catalogWritten: true,
      cacheSynced: true,
      comboOmissions: [],
    });
    expect(invalidated).toBe(1);
  });

  test("does not touch the cache when no Codex catalog can be materialized", async () => {
    let invalidated = 0;
    const result = await refreshCodexModelCatalog(config, {
      syncCatalogModels: async () => ({
        added: 0,
        path: "/tmp/missing-catalog.json",
        catalogWritten: false,
        comboOmissions: [],
      }),
      invalidateCodexModelsCache: () => {
        invalidated += 1;
        return true;
      },
      existsSync: () => false,
    });

    expect(result.catalogExists).toBe(false);
    expect(result.catalogWritten).toBe(false);
    expect(result.cacheSynced).toBe(false);
    expect(result.comboOmissions).toEqual([]);
    expect(invalidated).toBe(0);
  });

  test("reports cacheSynced false when invalidate cannot write", async () => {
    const result = await refreshCodexModelCatalog(config, {
      syncCatalogModels: async () => ({
        added: 0,
        path: "/tmp/opencodex-catalog.json",
        catalogWritten: true,
        comboOmissions: [],
      }),
      invalidateCodexModelsCache: () => false,
      existsSync: () => true,
    });

    expect(result.catalogExists).toBe(true);
    expect(result.catalogWritten).toBe(true);
    expect(result.cacheSynced).toBe(false);
    expect(result.comboOmissions).toEqual([]);
  });

  test("preserves catalogWritten false when the catalog path exists but sync did not write", async () => {
    const result = await refreshCodexModelCatalog(config, {
      syncCatalogModels: async () => ({
        added: 0,
        path: "/tmp/broken-catalog.json",
        catalogWritten: false,
        comboOmissions: [],
      }),
      invalidateCodexModelsCache: () => false,
      existsSync: () => true,
    });

    expect(result.catalogExists).toBe(true);
    expect(result.catalogWritten).toBe(false);
    expect(result.cacheSynced).toBe(false);
  });
});
