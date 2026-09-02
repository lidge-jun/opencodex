import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function backupPathForTestCatalog(codexHome: string, opencodexHome: string, catalogName: string): string {
  const catalogPath = join(realpathSync.native(codexHome), catalogName);
  const normalized = process.platform === "win32" ? resolve(catalogPath).toLowerCase() : resolve(catalogPath);
  const backupId = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(opencodexHome, `catalog-backup-${backupId}.json`);
}

function runScript(codexHome: string, opencodexHome: string, script: string): { stdout: string; status: number } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome },
    encoding: "utf8",
  });
  return { stdout: result.stdout?.trim() ?? "", status: result.status ?? 1 };
}

describe("Codex catalog restore", () => {
  let codexHome: string;
  let opencodexHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "ocx-catalog-home-"));
    opencodexHome = mkdtempSync(join(tmpdir(), "ocx-catalog-ocx-"));
  });

  afterEach(() => {
    if (existsSync(codexHome)) removeTreeWithRetry(codexHome);
    if (existsSync(opencodexHome)) removeTreeWithRetry(opencodexHome);
  });

  test("version-1 process journals restore, while matching client ownership is durable", () => {
    const configPath = join(codexHome, "config.toml");
    const journalPath = join(codexHome, "opencodex-journal.json");
    const original = '# original\nmodel_provider = "openai"\n';
    const injected = '# injected\nmodel_provider = "opencodex"\n';
    writeFileSync(configPath, injected);
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from(original).toString("base64"),
      originalProfile: null,
      pid: 999_999,
      timestamp: new Date().toISOString(),
    }));
    const legacy = runScript(codexHome, opencodexHome, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify({ restored: reconcileJournal() }));
    `);
    expect(legacy.status).toBe(0);
    expect(JSON.parse(legacy.stdout).restored).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(original);

    writeFileSync(configPath, injected);
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from(original).toString("base64"),
      originalProfile: null,
      owner: { kind: "client", apiKeyId: "client-key-1" },
      pid: 999_999,
      timestamp: new Date().toISOString(),
    }));
    const client = runScript(codexHome, opencodexHome, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify({ restored: reconcileJournal({ activeClientApiKeyId: "client-key-1" }) }));
    `);
    expect(client.status).toBe(0);
    expect(JSON.parse(client.stdout).restored).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(injected);
    expect(existsSync(journalPath)).toBe(true);
  });

  // spawnSync(bun --eval) under `bun test --isolate` on Windows can exceed the
  // default 5s case budget when the runner is under load (seen at ~5.4s on GHA).
  test("drops routed entries without overwriting user-added native entries", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5" },
        { slug: "opencode-go/deepseek-v4-pro" },
        { slug: "user-native" },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const result = restoreCodexCatalog();
      console.log(JSON.stringify(result));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 1, kept: 2 });
    const slugs = JSON.parse(readFileSync(catalogPath, "utf8")).models.map((m: { slug: string }) => m.slug);
    expect(slugs).toEqual(["gpt-5.5", "user-native"]);
  }, { timeout: 15_000 });

  test("fallback restore repairs only enabled natives with unanimously visible account clones", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
      disabledModels: ["gpt-5.4", "desktop/gpt-5.5"],
    }), "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", visibility: "hide", priority: 7 },
        { slug: "gpt-5.4", visibility: "hide" },
        { slug: "gpt-5.3-codex-spark", visibility: "hide" },
        { slug: "user-native", visibility: "hide" },
        {
          slug: "team/gpt-5.5",
          visibility: "list",
          opencodex_catalog_kind: "account-selector-v1",
        },
        {
          slug: "desktop/gpt-5.5",
          visibility: "hide",
          opencodex_catalog_kind: "account-selector-v1",
        },
        {
          slug: "team/gpt-5.4",
          visibility: "list",
          opencodex_catalog_kind: "account-selector-v1",
        },
        { slug: "provider/gpt-5.3-codex-spark", visibility: "list" },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const first = restoreCodexCatalog();
      const second = restoreCodexCatalog();
      console.log(JSON.stringify({ first, second }));
    `);

    expect(r.status).toBe(0);
    const resolvedCatalogPath = join(realpathSync.native(codexHome), "catalog.json");
    expect(JSON.parse(r.stdout)).toEqual({
      first: { removed: 4, kept: 4, path: resolvedCatalogPath },
      second: { removed: 0, kept: 4, path: resolvedCatalogPath },
    });
    const restored = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(restored.find(model => model.slug === "gpt-5.5")).toMatchObject({
      visibility: "list",
      priority: 7,
    });
    expect(restored.find(model => model.slug === "gpt-5.4")?.visibility).toBe("hide");
    expect(restored.find(model => model.slug === "gpt-5.3-codex-spark")?.visibility).toBe("hide");
    expect(restored.find(model => model.slug === "user-native")?.visibility).toBe("hide");
    expect(restored.some(model => String(model.slug).includes("/"))).toBe(false);
  }, { timeout: 15_000 });

  test("fallback restore leaves hidden natives untouched when current config is unreadable", () => {
    const catalogPath = join(codexHome, "catalog.json");
    const configPath = join(opencodexHome, "config.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(configPath, "{", "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", visibility: "hide" },
        {
          slug: "team/gpt-5.5",
          visibility: "list",
          opencodex_catalog_kind: "account-selector-v1",
        },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      console.log(JSON.stringify(restoreCodexCatalog()));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 1, kept: 1 });
    expect(JSON.parse(readFileSync(catalogPath, "utf8")).models).toEqual([
      { slug: "gpt-5.5", visibility: "hide" },
    ]);
    expect(readFileSync(configPath, "utf8")).toBe("{");
  }, { timeout: 15_000 });

  test("backup restore repairs only later native additions with trusted visible clones", () => {
    const catalogPath = join(codexHome, "catalog.json");
    const backupPath = backupPathForTestCatalog(codexHome, opencodexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(backupPath, JSON.stringify({
      models: [{ slug: "gpt-5.4", visibility: "hide", priority: 50 }],
    }, null, 2) + "\n");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.4", visibility: "hide", priority: 0 },
        { slug: "gpt-5.5", visibility: "hide", priority: 7 },
        { slug: "gpt-5.3-codex-spark", visibility: "hide" },
        {
          slug: "team/gpt-5.4",
          visibility: "list",
          opencodex_catalog_kind: "account-selector-v1",
        },
        {
          slug: "team/gpt-5.5",
          visibility: "list",
          opencodex_catalog_kind: "account-selector-v1",
        },
        {
          slug: "team/gpt-5.3-codex-spark",
          visibility: "list",
          opencodex_catalog_kind: "account-selector-v1",
        },
        {
          slug: "desktop/gpt-5.3-codex-spark",
          visibility: "hide",
          opencodex_catalog_kind: "account-selector-v1",
        },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      console.log(JSON.stringify(restoreCodexCatalog()));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 4, kept: 3 });
    const restored = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(restored).toEqual([
      { slug: "gpt-5.4", visibility: "hide", priority: 50 },
      { slug: "gpt-5.5", visibility: "list", priority: 7 },
      { slug: "gpt-5.3-codex-spark", visibility: "hide" },
    ]);
  }, { timeout: 15_000 });

  test("uses pristine backup while preserving native entries added after sync", () => {
    const catalogPath = join(codexHome, "catalog.json");
    const backupPath = backupPathForTestCatalog(codexHome, opencodexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(backupPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", priority: 50 },
        { slug: "codex-mini", priority: 60 },
      ],
    }, null, 2) + "\n");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", priority: 0, supports_websockets: true },
        { slug: "codex-mini", priority: 60, supports_websockets: true },
        { slug: "umans/umans-kimi-k2.7" },
        { slug: "user-native", priority: 10 },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const result = restoreCodexCatalog();
      console.log(JSON.stringify(result));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 1, kept: 3 });
    const restored = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(restored).toEqual([
      { slug: "gpt-5.5", priority: 50 },
      { slug: "codex-mini", priority: 60 },
      { slug: "user-native", priority: 10 },
    ]);
  }, { timeout: 15_000 });

  test("does not apply generic legacy backup to a custom catalog path", () => {
    const catalogPath = join(codexHome, "custom-catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "custom-catalog.json"\n', "utf8");
    writeFileSync(join(opencodexHome, "catalog-backup.json"), JSON.stringify({
      models: [{ slug: "wrong-legacy", priority: 1 }],
    }, null, 2) + "\n");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", priority: 50 },
        { slug: "umans/umans-kimi-k2.7" },
        { slug: "user-native", priority: 10 },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const result = restoreCodexCatalog();
      console.log(JSON.stringify(result));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 1, kept: 2 });
    const restored = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(restored.map(m => m.slug)).toEqual(["gpt-5.5", "user-native"]);
  }, { timeout: 15_000 });

  test("sync applies native-only subagent priority selections", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", priority: 50, base_instructions: "native", visibility: "list" },
        { slug: "gpt-5.4", priority: 0, base_instructions: "native", visibility: "list" },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      const { seedCodexModelEntitlementsForTests } = require("./src/codex/model-entitlements");
      seedCodexModelEntitlementsForTests("__main__", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
      (async () => {
        const result = await syncCatalogModels({
          port: 10100,
          providers: {},
          defaultProvider: "openai",
          subagentModels: ["gpt-5.5"],
        });
        console.log(JSON.stringify(result));
      })();
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ added: 0 });
    const synced = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(synced.find(m => m.slug === "gpt-5.5")?.priority).toBe(0);
    expect(synced.find(m => m.slug === "gpt-5.4")?.priority).toBeGreaterThan(100);
  }, { timeout: 15_000 });

  test("sync advertises documented Codex-native additions omitted by the bundled catalog", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: "catalog-main-access", account_id: "catalog-main-account" },
    }), "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        {
          slug: "gpt-5.5",
          priority: 0,
          base_instructions: "native",
          visibility: "list",
          context_window: 272_000,
          max_context_window: 272_000,
        },
        {
          slug: "gpt-5.4",
          priority: 2,
          base_instructions: "native",
          visibility: "list",
          context_window: 272_000,
          max_context_window: 1_000_000,
        },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (request.method !== "GET" || url.pathname !== "/backend-api/codex/models") {
          throw new Error("unexpected fetch: " + request.method + " " + url.href);
        }
        const entitled = request.headers.get("authorization") === "Bearer catalog-main-access"
          && request.headers.get("chatgpt-account-id") === "catalog-main-account";
        const slugs = entitled ? ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] : [];
        return Response.json({
          models: slugs.map(slug => ({ slug, supported_in_api: true, visibility: "list" })),
        });
      };
      (async () => {
        const result = await syncCatalogModels({
          port: 10100,
          providers: {},
          defaultProvider: "openai",
          subagentModels: ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex-spark", "gpt-5.6-sol"],
        });
        console.log(JSON.stringify(result));
      })();
    `);

    expect(r.status).toBe(0);
    const synced = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(synced.map(m => m.slug)).toContain("gpt-5.3-codex-spark");
    expect(synced.map(m => m.slug)).toContain("gpt-5.6-sol");
    expect(synced.map(m => m.slug)).toContain("gpt-5.6-terra");
    expect(synced.map(m => m.slug)).toContain("gpt-5.6-luna");
    expect(synced.find(m => m.slug === "gpt-5.4")?.max_context_window).toBe(1_000_000);
  }, { timeout: 15_000 });
});
