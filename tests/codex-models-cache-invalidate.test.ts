import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateCodexModelsCache } from "../src/codex/catalog";
import { invalidateCodexModelsCacheWithPermit } from "../src/codex/catalog/sync";
import { withCatalogWriteSerialization } from "../src/codex/catalog-write-serialization";
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

  test("permit-bound invalidation stays on its owning home after ambient drift", () => {
    const ambientCodexHome = mkdtempSync(join(tmpdir(), "ocx-invalidate-ambient-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "pinned-catalog.json"\n');
      writeFileSync(join(codexHome, "pinned-catalog.json"), JSON.stringify({
        models: [{ slug: "gpt-pinned-home" }],
      }, null, 2) + "\n");
      writeFileSync(join(ambientCodexHome, "opencodex-catalog.json"), JSON.stringify({
        models: [{ slug: "gpt-ambient-home" }],
      }, null, 2) + "\n");
      process.env.CODEX_HOME = ambientCodexHome;

      const outcome = withCatalogWriteSerialization(codexHome, permit =>
        invalidateCodexModelsCacheWithPermit(permit, codexHome));

      expect(outcome).toMatchObject({ kind: "completed", value: true });
      expect(existsSync(join(ambientCodexHome, "models_cache.json"))).toBe(false);
      const cache = JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf8")) as {
        models: Array<{ slug: string }>;
      };
      expect(cache.models).toEqual([{ slug: "gpt-pinned-home" }]);
    } finally {
      process.env.CODEX_HOME = codexHome;
      rmSync(ambientCodexHome, { recursive: true, force: true });
    }
  });

  test("preserves an observed unknown native as a hidden sync observation", () => {
    writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({
      models: [{ slug: "gpt-5.5" }],
    }, null, 2) + "\n");
    writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({
      models: [{
        // gpt-daybreak-blue-latest is a KNOWN global native now (devlog 260816_.../011),
        // so it can no longer stand in for an unknown observed id.
        slug: "gpt-future-unlisted",
        visibility: "list",
        supported_in_api: true,
        shell_type: "shell_command",
        comp_hash: "native-comp-hash",
        model_messages: { instructions_template: "You are Codex." },
        base_instructions: "You are Codex.",
        supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
      }],
    }, null, 2) + "\n");

    expect(invalidateCodexModelsCache()).toBe(true);
    const cache = JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    expect(cache.models.find(model => model.slug === "gpt-future-unlisted")).toMatchObject({
      visibility: "hide",
      opencodex_account_observed_native: true,
    });
  });

  test("refuses the cache rewrite when desired state flipped OFF between commit and reacquisition", () => {
    // The commit-path desired-state check runs under the FIRST catalog permit;
    // refreshCodexModelCatalog then releases K before invalidateCodexModelsCache
    // reacquires it. An OFF landing in that gap must gate this second write too —
    // otherwise a routed models_cache survives a completed disable while the
    // injector honestly reports status:"skipped".
    writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({
      models: [{ slug: "gpt-5.5" }],
    }, null, 2) + "\n");
    mkdirSync(join(opencodexHome, ".opencodex"), { recursive: true });
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "openai",
      providers: {},
      clientIntegrations: { codex: false },
    }, null, 2) + "\n");

    expect(invalidateCodexModelsCache()).toBe(false);
    expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
  });

  test("catalog-only override writes models_cache when desired state is OFF", () => {
    writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({
      models: [{ slug: "gpt-5.5" }],
    }, null, 2) + "\n");
    mkdirSync(join(opencodexHome, ".opencodex"), { recursive: true });
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "openai",
      providers: {},
      clientIntegrations: { codex: false },
    }, null, 2) + "\n");

    // Explicit sync/sync-cache refresh the cache for side profiles even when the
    // Codex integration toggle is OFF; only config/history stay native.
    expect(invalidateCodexModelsCache({ allowWhenDesiredDisabled: true })).toBe(true);
    expect(existsSync(join(codexHome, "models_cache.json"))).toBe(true);
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
