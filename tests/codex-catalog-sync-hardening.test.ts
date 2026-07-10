import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function runScript(codexHome: string, opencodexHome: string, script: string): { stdout: string; status: number; stderr: string } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome },
    encoding: "utf8",
  });
  return { stdout: result.stdout?.trim() ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

function nativeEntry(slug: string, priority: number): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: "native",
    priority,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [{ effort: "medium", description: "m" }],
  };
}

function routedEntry(slug: string, priority: number): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: "routed",
    priority,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [],
  };
}

describe("Codex catalog sync hardening", () => {
  let codexHome: string;
  let opencodexHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "ocx-sync-home-"));
    opencodexHome = mkdtempSync(join(tmpdir(), "ocx-sync-ocx-"));
  });

  afterEach(() => {
    if (existsSync(codexHome)) rmSync(codexHome, { recursive: true, force: true });
    if (existsSync(opencodexHome)) rmSync(opencodexHome, { recursive: true, force: true });
  });

  test("Gap B: drops legacy OpenAI-family natives but keeps supported + user natives", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        nativeEntry("gpt-5.4", 1),
        nativeEntry("gpt-5.4-mini", 2),
        nativeEntry("gpt-5.3-codex-spark", 3),
        nativeEntry("gpt-5.6-sol", 4),
        nativeEntry("gpt-5.6-terra", 5),
        nativeEntry("gpt-5.6-luna", 6),
        nativeEntry("gpt-5.3-codex", 104),   // legacy -> drop
        nativeEntry("gpt-5.2", 104),          // legacy -> drop
        nativeEntry("codex-auto-review", 104),// legacy -> drop
        nativeEntry("user-native", 10),       // user-added -> keep
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({ providers: {} }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("gpt-5.5");
    expect(slugs).toContain("gpt-5.4");
    expect(slugs).toContain("gpt-5.4-mini");
    expect(slugs).toContain("gpt-5.3-codex-spark");
    expect(slugs).toContain("gpt-5.6-sol");
    expect(slugs).toContain("gpt-5.6-terra");
    expect(slugs).toContain("gpt-5.6-luna");
    expect(slugs).toContain("user-native");           // genuine user native preserved
    expect(slugs).not.toContain("gpt-5.3-codex");      // legacy dropped
    expect(slugs).not.toContain("gpt-5.2");            // legacy dropped
    expect(slugs).not.toContain("codex-auto-review");  // legacy dropped
  });

  test("Gap A: an empty routed fetch preserves existing routed entries on disk", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        { slug: "kiro/claude-opus-4.8", display_name: "kiro", description: "r", priority: 5, visibility: "list", base_instructions: "x", supported_reasoning_levels: [] },
        { slug: "opencode-go/glm-5.2", display_name: "go", description: "r", priority: 5, visibility: "list", base_instructions: "x", supported_reasoning_levels: [] },
      ],
    }, null, 2) + "\n");

    // config has NO providers => gatherRoutedModels returns [] (transient empty fetch).
    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({ providers: {} }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("routed model fetch returned empty; preserving 2 existing routed entries");

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("kiro/claude-opus-4.8");   // routed preserved despite empty fetch
    expect(slugs).toContain("opencode-go/glm-5.2");
    expect(slugs).toContain("gpt-5.5");
  });

  test("empty routed refresh drops compatibility-excluded rows while preserving other routed entries", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        routedEntry("kiro/claude-opus-4.8", 5),
        routedEntry("opencode-go/glm-5.2", 6),
        routedEntry("opencode-go/hy3-preview", 7),
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({ providers: {} }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("routed model fetch returned empty; preserving 2 existing routed entries");

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("kiro/claude-opus-4.8");
    expect(slugs).toContain("opencode-go/glm-5.2");
    expect(slugs).not.toContain("opencode-go/hy3-preview");
  });

  test("preserves existing routed entries for providers absent from the current sync config", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        routedEntry("cursor/composer-2.5", 5),
        routedEntry("openai/stale-model", 6),
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({
        providers: {
          openai: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            liveModels: false,
            models: ["fresh-model"]
          }
        }
      }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("cursor/composer-2.5");
    expect(slugs).toContain("openai/fresh-model");
    expect(slugs).not.toContain("openai/stale-model");
  });

  test("replaces existing routed entries for providers present in the current sync config", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        routedEntry("cursor/stale-model", 5),
        routedEntry("xai/grok-5-code", 6),
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({
        providers: {
          cursor: {
            adapter: "cursor",
            baseUrl: "https://api2.cursor.sh",
            liveModels: false,
            models: ["composer-2.5"]
          }
        }
      }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("cursor/composer-2.5");
    expect(slugs).toContain("xai/grok-5-code");
    expect(slugs).not.toContain("cursor/stale-model");
  });

  test("readCodexCatalogPath honors CODEX_HOME at call time", () => {
    const alternateHome = join(codexHome, "alternate-codex-home");
    mkdirSync(alternateHome, { recursive: true });
    writeFileSync(join(alternateHome, "config.toml"), 'model_catalog_json = "nested/catalog.json"\n', "utf8");

    const r = runScript(codexHome, opencodexHome, `
      const { readCodexCatalogPath } = require("./src/codex/catalog");
      process.env.CODEX_HOME = ${JSON.stringify(alternateHome)};
      console.log(readCodexCatalogPath());
    `);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(resolve(realpathSync.native(alternateHome), "nested/catalog.json"));
  });
});
