import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncModelsToCodex } from "../src/codex/sync";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-sync-api");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
let prevCodexHome: string | undefined;

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as OcxConfig;

describe("GUI/CLI Codex sync backend", () => {
  beforeEach(() => {
    prevCodexHome = process.env.CODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    process.env.CODEX_HOME = TEST_CODEX_HOME;
    writeFileSync(join(TEST_CODEX_HOME, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });
  test("returns the structured sync result used by POST /api/sync", async () => {
    let injectedPort = 0;
    let injectedCatalogPath: string | null | undefined;

    const result = await syncModelsToCodex(12345, config, null, {
      refreshCodexModelCatalog: async () => ({
        added: 3,
        path: "/tmp/opencodex-catalog.json",
        catalogExists: true,
        cacheSynced: true,
      }),
      injectCodexConfig: async (port, _config, options) => {
        injectedPort = port;
        injectedCatalogPath = options.catalogPath;
        return { success: true, message: "injected" };
      },
    });

    expect(injectedPort).toBe(12345);
    expect(injectedCatalogPath).toBe("/tmp/opencodex-catalog.json");
    expect(result).toEqual({
      ok: true,
      added: 3,
      catalogPath: "/tmp/opencodex-catalog.json",
      catalogExists: true,
      cacheSynced: true,
      message: "injected",
    });
  });

  test("keeps injection fallback behavior when catalog refresh throws", async () => {
    let injectedCatalogPath: string | null | undefined = "unset";

    const result = await syncModelsToCodex(undefined, config, null, {
      refreshCodexModelCatalog: async () => {
        throw new Error("catalog boom");
      },
      injectCodexConfig: async (_port, _config, options) => {
        injectedCatalogPath = options.catalogPath;
        return { success: true, message: "injected fallback" };
      },
    });

    expect(injectedCatalogPath).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.catalogPath).toBeNull();
    expect(result.warning).toContain("catalog boom");
  });
});
