import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateCodexModelsCache } from "../src/codex/catalog";
import { afterCatalogWriteHandleAppServers } from "../src/codex/app-server-processes";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import { syncModelsToCodex } from "../src/codex/sync";
import type { OcxConfig } from "../src/types";

const emptyConfig = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as OcxConfig;

describe("invalidateCodexModelsCache write gate (#476 / #518)", () => {
  let previousCodexHome: string | undefined;
  let previousOpenCodexHome: string | undefined;
  let codexHome = "";
  let opencodexHome = "";

  beforeEach(() => {
    previousCodexHome = process.env.CODEX_HOME;
    previousOpenCodexHome = process.env.OPENCODEX_HOME;
    codexHome = mkdtempSync(join(tmpdir(), "ocx-invalidate-codex-"));
    opencodexHome = mkdtempSync(join(tmpdir(), "ocx-invalidate-ocx-"));
    process.env.CODEX_HOME = codexHome;
    process.env.OPENCODEX_HOME = opencodexHome;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpenCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(opencodexHome, { recursive: true, force: true });
  });

  test("returns true and writes models_cache when catalog.json is readable", () => {
    writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({
      models: [{ slug: "gpt-5.5" }],
    }, null, 2) + "\n");

    expect(invalidateCodexModelsCache()).toBe(true);
    const cachePath = join(codexHome, "models_cache.json");
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
      fetched_at: string;
      models: Array<{ slug: string }>;
    };
    expect(cache.fetched_at).toBe("2000-01-01T00:00:00Z");
    expect(cache.models).toEqual([{ slug: "gpt-5.5" }]);
  });

  test("returns false for a missing catalog and does not warn/restart app-servers", () => {
    const errors: string[] = [];
    const logs: string[] = [];
    let listed = 0;

    expect(invalidateCodexModelsCache()).toBe(false);
    expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);

    // Mirrors ocx sync-cache: only call the handler when invalidate wrote.
    if (invalidateCodexModelsCache()) {
      afterCatalogWriteHandleAppServers({
        restart: true,
        log: { log: line => logs.push(String(line)), error: line => errors.push(String(line)) },
        io: {
          listSnapshots: () => {
            listed += 1;
            return [{ pid: 7, commandLine: "codex app-server" }];
          },
          kill: () => {},
          isAlive: () => false,
          waitExit: () => true,
        },
      });
    }

    expect(listed).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("returns false for invalid catalog JSON and does not warn/restart app-servers", () => {
    writeFileSync(join(codexHome, "opencodex-catalog.json"), "{ not-json");
    const errors: string[] = [];
    const logs: string[] = [];
    let listed = 0;

    expect(invalidateCodexModelsCache()).toBe(false);
    expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);

    if (invalidateCodexModelsCache()) {
      afterCatalogWriteHandleAppServers({
        restart: false,
        log: { log: line => logs.push(String(line)), error: line => errors.push(String(line)) },
        io: {
          listSnapshots: () => {
            listed += 1;
            return [{ pid: 7, commandLine: "codex app-server" }];
          },
        },
      });
    }

    expect(listed).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("ocx sync --restart-codex neither warns nor restarts when catalog exists but is unreadable", async () => {
    // Non-default catalog path that exists on disk but cannot be read or rewritten as JSON.
    // (A directory at the catalog path: existsSync true, load/write both fail.)
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "broken.json"\n', "utf8");
    mkdirSync(join(codexHome, "broken.json"));

    const syncResult = await syncModelsToCodex(10100, emptyConfig, null, {
      refreshCodexModelCatalog,
      injectCodexConfig: async () => ({ success: true, message: "injected" }),
      currentExternalCodexModelProvider: () => null,
    });

    expect(syncResult.catalogExists).toBe(true);
    expect(syncResult.catalogWritten).toBe(false);
    expect(syncResult.cacheSynced).toBe(false);

    const errors: string[] = [];
    const logs: string[] = [];
    let listed = 0;

    // Mirrors `ocx sync --restart-codex`: only handle app-servers after a real write.
    if (syncResult.catalogWritten || syncResult.cacheSynced) {
      afterCatalogWriteHandleAppServers({
        restart: true,
        log: { log: line => logs.push(String(line)), error: line => errors.push(String(line)) },
        io: {
          listSnapshots: () => {
            listed += 1;
            return [{ pid: 7, commandLine: "codex app-server" }];
          },
          kill: () => {},
          isAlive: () => false,
          waitExit: () => true,
        },
      });
    }

    expect(listed).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("ocx sync --restart-codex neither warns nor restarts when catalog JSON is malformed", async () => {
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "broken.json"\n', "utf8");
    writeFileSync(join(codexHome, "broken.json"), "{ not-json", "utf8");

    // Real sync may rematerialize bundled content over a writable malformed file; the
    // regression target is the CLI gate using catalogWritten, not bundled recovery.
    const syncResult = await syncModelsToCodex(10100, emptyConfig, null, {
      refreshCodexModelCatalog: async () => ({
        added: 0,
        path: join(codexHome, "broken.json"),
        catalogExists: true,
        catalogWritten: false,
        cacheSynced: false,
        comboOmissions: [],
      }),
      injectCodexConfig: async () => ({ success: true, message: "injected" }),
      currentExternalCodexModelProvider: () => null,
    });

    expect(syncResult.catalogExists).toBe(true);
    expect(syncResult.catalogWritten).toBe(false);
    expect(syncResult.cacheSynced).toBe(false);

    const errors: string[] = [];
    const logs: string[] = [];
    let listed = 0;

    if (syncResult.catalogWritten || syncResult.cacheSynced) {
      afterCatalogWriteHandleAppServers({
        restart: true,
        log: { log: line => logs.push(String(line)), error: line => errors.push(String(line)) },
        io: {
          listSnapshots: () => {
            listed += 1;
            return [{ pid: 7, commandLine: "codex app-server" }];
          },
          kill: () => {},
          isAlive: () => false,
          waitExit: () => true,
        },
      });
    }

    expect(listed).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toEqual([]);
  });
});
