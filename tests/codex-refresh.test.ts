import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateCodexModelsCache, syncCatalogModels } from "../src/codex/catalog";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import type { OcxConfig } from "../src/types";

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as OcxConfig;

const tempHomes: string[] = [];

function installTempHomes(): { codexHome: string; opencodexHome: string; restore(): void } {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousOpenCodexHome = process.env.OPENCODEX_HOME;
  const codexHome = mkdtempSync(join(tmpdir(), "ocx-refresh-codex-"));
  const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-refresh-ocx-"));
  tempHomes.push(codexHome, opencodexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;

  return {
    codexHome,
    opencodexHome,
    restore() {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpenCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(opencodexHome, { recursive: true, force: true });
    },
  };
}

function nativeCatalogFixture(slug = "gpt-5.5"): string {
  return JSON.stringify({
    models: [{
      slug,
      display_name: slug,
      description: "native",
      priority: 9,
      visibility: "list",
      base_instructions: "You are Codex, a coding agent based on GPT-5.",
      supported_reasoning_levels: [{ effort: "medium", description: "m" }],
    }],
  }, null, 2) + "\n";
}

afterEach(() => {
  for (const path of tempHomes.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

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

  test("reports catalogWritten true after syncCatalogModels rewrites a real catalog file", async () => {
    const home = installTempHomes();
    try {
      const catalogPath = join(home.codexHome, "nested", "catalog.json");
      mkdirSync(join(home.codexHome, "nested"), { recursive: true });
      writeFileSync(join(home.codexHome, "config.toml"), 'model_catalog_json = "nested/catalog.json"\n', "utf8");
      writeFileSync(catalogPath, nativeCatalogFixture("gpt-5.6-sol"), "utf8");
      const before = readFileSync(catalogPath, "utf8");

      const result = await syncCatalogModels(config);
      const after = readFileSync(catalogPath, "utf8");
      const rewritten = JSON.parse(after);

      expect(result.path).toBe(join(realpathSync.native(home.codexHome), "nested", "catalog.json"));
      expect(result.catalogWritten).toBe(true);
      expect(after).not.toBe(before);
      // The fixture seeds gated Sol rows, but this isolated home has no authenticated
      // roster, so sync drops them and the first surviving row is gpt-5.5.
      expect(rewritten.models[0].slug).toBe("gpt-5.5");
      expect(rewritten.models[0].display_name).toBe("gpt-5.5");
      expect(rewritten.models[0].context_window).toBeGreaterThan(0);
    } finally {
      home.restore();
    }
  });

  test("invalidateCodexModelsCache reports real cache write success and failure cases", () => {
    const success = installTempHomes();
    try {
      writeFileSync(join(success.codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n', "utf8");
      writeFileSync(join(success.codexHome, "opencodex-catalog.json"), nativeCatalogFixture("gpt-5.6-sol"), "utf8");

      expect(invalidateCodexModelsCache()).toBe(true);
      const cache = JSON.parse(readFileSync(join(success.codexHome, "models_cache.json"), "utf8"));
      expect(cache.fetched_at).toBe("2000-01-01T00:00:00Z");
      expect(cache.client_version).toBe("0.0.0");
      expect(cache.models[0].slug).toBe("gpt-5.6-sol");
    } finally {
      success.restore();
    }

    const missingCatalog = installTempHomes();
    try {
      writeFileSync(join(missingCatalog.codexHome, "config.toml"), 'model_catalog_json = "missing-catalog.json"\n', "utf8");

      expect(invalidateCodexModelsCache()).toBe(false);
      expect(existsSync(join(missingCatalog.codexHome, "models_cache.json"))).toBe(false);
    } finally {
      missingCatalog.restore();
    }

    const malformedCatalog = installTempHomes();
    try {
      writeFileSync(join(malformedCatalog.codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n', "utf8");
      writeFileSync(join(malformedCatalog.codexHome, "opencodex-catalog.json"), "{not-json", "utf8");

      expect(invalidateCodexModelsCache()).toBe(false);
      expect(existsSync(join(malformedCatalog.codexHome, "models_cache.json"))).toBe(false);
    } finally {
      malformedCatalog.restore();
    }

    const unwritableCache = installTempHomes();
    try {
      writeFileSync(join(unwritableCache.codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n', "utf8");
      writeFileSync(join(unwritableCache.codexHome, "opencodex-catalog.json"), nativeCatalogFixture(), "utf8");
      mkdirSync(join(unwritableCache.codexHome, "models_cache.json"));

      expect(invalidateCodexModelsCache()).toBe(false);
    } finally {
      unwritableCache.restore();
    }
  });
});
