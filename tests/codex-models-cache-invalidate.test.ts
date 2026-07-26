import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateCodexModelsCache } from "../src/codex/catalog";
import { afterCatalogWriteHandleAppServers } from "../src/codex/app-server-processes";

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
});
