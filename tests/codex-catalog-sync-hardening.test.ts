import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../src/codex/catalog/native-models";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function runScript(
  codexHome: string,
  opencodexHome: string,
  script: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; status: number; stderr: string } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return { stdout: result.stdout?.trim() ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

function createCodexCatalogFixture(dir: string): string {
  const scriptPath = join(dir, "codex-catalog-fixture.js");
  const bundled = JSON.stringify({ models: [nativeEntry("gpt-5.5", 0)] });
  writeFileSync(scriptPath, [
    'if (process.argv.includes("--version")) {',
    '  console.log("codex-cli 0.999.0");',
    '} else {',
    `  process.stdout.write(${JSON.stringify(bundled)});`,
    '}',
  ].join("\n"), "utf8");

  if (process.platform === "win32") {
    const commandPath = join(dir, "codex-catalog-fixture.cmd");
    writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
    return commandPath;
  }

  const commandPath = join(dir, "codex-catalog-fixture");
  writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, "utf8");
  chmodSync(commandPath, 0o755);
  return commandPath;
}

function nativeEntry(slug: string, priority: number): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: "native",
    priority,
    visibility: "list",
    shell_type: "shell_command",
    comp_hash: "native-comp-hash",
    model_messages: { instructions_template: "You are Codex." },
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

/** Row shape OpenCodex itself generates for routed models (ownership signature). */
function ocxAuthoredEntry(slug: string, priority: number): Record<string, unknown> {
  return {
    ...routedEntry(slug, priority),
    description: `Routed via opencodex → ${slug} (test-owner).`,
  };
}

/** Legacy generated shape (June–July 2026): provider name, not the full slug. */
function ocxLegacyAuthoredEntry(slug: string, priority: number): Record<string, unknown> {
  const provider = slug.slice(0, slug.indexOf("/"));
  return {
    ...routedEntry(slug, priority),
    description: `Routed via opencodex → ${provider} (test-owner).`,
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
    if (existsSync(codexHome)) removeTreeWithRetry(codexHome);
    if (existsSync(opencodexHome)) removeTreeWithRetry(opencodexHome);
  });

  test("Gap B: drops legacy and unentitled account-gated natives but keeps supported + user natives", () => {
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
    // This isolated fixture has no authenticated ChatGPT roster, so account-gated
    // native models must fail closed rather than remain selectable.
    expect(slugs).not.toContain("gpt-5.6-sol");
    expect(slugs).not.toContain("gpt-5.6-terra");
    expect(slugs).not.toContain("gpt-5.6-luna");
    expect(slugs).toContain("user-native");           // genuine user native preserved
    expect(slugs).not.toContain("gpt-5.3-codex");      // legacy dropped
    expect(slugs).not.toContain("gpt-5.2");            // legacy dropped
    expect(slugs).not.toContain("codex-auto-review");  // legacy dropped
  });

  test("native-alias suppression preserves authoritative metadata on account-qualified rows", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        {
          ...nativeEntry("gpt-5.5", 0),
          display_name: "Original GPT-5.5",
          comp_hash: "native-sol-hash",
          base_instructions: "Native Sol instructions",
          model_messages: { instructions_template: "Native Sol instructions" },
          tool_mode: "code_mode_only",
        },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      const config = {
        port: 10100,
        defaultProvider: "Nova1",
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            liveModels: false
          },
          Nova1: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            liveModels: false,
            models: ["codex/gpt-5.5"]
          }
        },
        codexAccounts: [{ id: "stored-team-account", isMain: false }],
        codexAccountNamespaces: { team: "stored-team-account" },
        combos: {
          "nova-sol": {
            alias: "gpt-5.5",
            nativeAlias: true,
            displayName: "Nova GPT-5.5",
            targets: [{ provider: "Nova1", model: "codex/gpt-5.5" }]
          }
        }
      };
      syncCatalogModels(config).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{
      slug: string;
      display_name?: string;
      comp_hash?: string;
      base_instructions?: string;
      model_messages?: { instructions_template?: string };
      tool_mode?: string | null;
      opencodex_catalog_kind?: string;
    }>;
    expect(rows.filter(row => row.slug === "gpt-5.5")).toEqual([
      expect.objectContaining({
        display_name: "Nova GPT-5.5",
        opencodex_catalog_kind: "combo-native-alias-v1",
      }),
    ]);
    expect(rows.find(row => row.slug === "team/gpt-5.5")).toMatchObject({
      comp_hash: "native-sol-hash",
      base_instructions: "Native Sol instructions",
      model_messages: { instructions_template: "Native Sol instructions" },
      tool_mode: "code_mode_only",
      opencodex_catalog_kind: "account-selector-v1",
    });
  });

  test("providers absent from config preserve foreign routed entries without an outage warning", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        { slug: "kiro/claude-opus-4.8", display_name: "kiro", description: "r", priority: 5, visibility: "list", base_instructions: "x", supported_reasoning_levels: [] },
        { slug: "opencode-go/glm-5.2", display_name: "go", description: "r", priority: 5, visibility: "list", base_instructions: "x", supported_reasoning_levels: [] },
      ],
    }, null, 2) + "\n");

    // No provider claims these foreign rows, so an empty gather preserves them without
    // misreporting a provider outage.
    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({ providers: {} }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("provider discovery degraded");

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("kiro/claude-opus-4.8");
    expect(slugs).toContain("opencode-go/glm-5.2");
    expect(slugs).toContain("gpt-5.5");
  });

  test("account rows reconcile idempotently and independently from authoritative provider empties", () => {
    const catalogPath = join(codexHome, "catalog.json");
    const firstCatalogPath = join(opencodexHome, "first-catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    const accountMarker = "account-selector-v1";
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        {
          ...nativeEntry("gpt-5.5", 0),
          comp_hash: "native-5.5-hash",
          base_instructions: "Native 5.5 instructions",
          model_messages: { instructions_template: "Native 5.5 instructions" },
          tool_mode: null,
          context_window: 128_000,
          max_context_window: 128_000,
          auto_compact_token_limit: 115_200,
        },
        {
          ...nativeEntry("gpt-5.4", 1),
          comp_hash: "native-5.4-hash",
          base_instructions: "Native 5.4 instructions",
          model_messages: { instructions_template: "Native 5.4 instructions" },
          tool_mode: "code_mode_only",
        },
        nativeEntry("gpt-5.4-mini", 2),
        routedEntry("vendor/stable-model", 5),
        { ...routedEntry("foreign/gpt-5.5", 6), description: "Foreign provider description" },
        {
          ...routedEntry("team/gpt-5.5", 7),
          display_name: "Stale provider row with a colliding slug",
        },
        {
          ...nativeEntry("removed/gpt-5.5", 8),
          description: "Retired generated row",
          opencodex_catalog_kind: accountMarker,
        },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { copyFileSync } = require("node:fs");
      const { syncCatalogModels } = require("./src/codex/catalog");
      const catalogPath = ${JSON.stringify(catalogPath)};
      const firstCatalogPath = ${JSON.stringify(firstCatalogPath)};
      const config = {
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            liveModels: false
          }
        },
        codexAccounts: [{
          id: "stored-team-account",
          email: "private@example.test",
          alias: "Private Display Name",
          isMain: false
        }],
        codexAccountNamespaces: {
          desktop: "@main",
          team: "stored-team-account",
          removed: "missing-account"
        }
      };
      await syncCatalogModels(config);
      copyFileSync(catalogPath, firstCatalogPath);
      await syncCatalogModels(config);
    `);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("provider discovery degraded");
    expect(r.stderr).not.toContain("account selector collision");

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{
      slug: string;
      display_name?: string;
      description?: string;
      visibility?: string;
      comp_hash?: string;
      opencodex_catalog_kind?: string;
      base_instructions?: string;
      model_messages?: { instructions_template?: string };
      tool_mode?: string | null;
      context_window?: number;
      max_context_window?: number;
      auto_compact_token_limit?: number;
    }>;
    const firstRows = JSON.parse(readFileSync(firstCatalogPath, "utf8")).models as typeof rows;
    expect(rows).toEqual(firstRows);
    const firstBare = firstRows.find(row => row.slug === "gpt-5.5");
    const firstTeam = firstRows.find(row => row.slug === "team/gpt-5.5");
    expect(firstBare).toMatchObject({
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: 244_800,
    });
    expect(firstTeam).toMatchObject({
      context_window: firstBare?.context_window,
      max_context_window: firstBare?.max_context_window,
      auto_compact_token_limit: firstBare?.auto_compact_token_limit,
    });
    expect(rows.some(row => row.slug === "vendor/stable-model")).toBe(true);
    expect(rows.some(row => row.slug === "foreign/gpt-5.5")).toBe(true);
    expect(rows.some(row => row.slug === "removed/gpt-5.5")).toBe(false);
    expect(rows.find(row => row.slug === "gpt-5.5")?.visibility).toBe("hide");
    expect(rows.find(row => row.slug === "desktop/gpt-5.5")?.visibility).toBe("list");
    const bare = rows.find(row => row.slug === "gpt-5.5");
    const team = rows.find(row => row.slug === "team/gpt-5.5");
    expect(team).toMatchObject({
      display_name: "team / 5.5",
      opencodex_catalog_kind: accountMarker,
      comp_hash: "native-5.5-hash",
      visibility: "list",
    });
    expect(team?.description).toBe(bare?.description);
    expect(rows.filter(row => row.slug === "team/gpt-5.5")).toHaveLength(1);
    for (const selector of ["desktop", "team"]) {
      expect(rows.some(row => row.slug === `${selector}/gpt-5.4`)).toBe(true);
      expect(rows.some(row => row.slug === `${selector}/gpt-5.4-mini`)).toBe(true);
    }
    for (const nativeSlug of ["gpt-5.5", "gpt-5.4"]) {
      const native = rows.find(row => row.slug === nativeSlug);
      const qualified = rows.find(row => row.slug === `team/${nativeSlug}`);
      expect(qualified).toMatchObject({
        comp_hash: native?.comp_hash,
        base_instructions: native?.base_instructions,
        model_messages: native?.model_messages,
        tool_mode: native?.tool_mode,
      });
    }
    expect(JSON.stringify(rows)).not.toContain("stored-team-account");
    expect(JSON.stringify(rows)).not.toContain("private@example.test");
    expect(JSON.stringify(rows)).not.toContain("Private Display Name");
  });

  test("account sync preserves an observed gated native only after the mapped account confirms it", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [nativeEntry("gpt-5.5", 0)],
    }, null, 2) + "\n");
    writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({
      models: [{
        ...nativeEntry("gpt-daybreak-blue-latest", 1),
        supported_in_api: true,
        visibility: "hide",
        opencodex_account_observed_native: true,
      }],
    }, null, 2) + "\n");
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: "main-token", account_id: "main-account" },
    }), "utf8");

    const r = runScript(codexHome, opencodexHome, `
      globalThis.fetch = async input => {
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.hostname === "chatgpt.com" && url.pathname.endsWith("/models")) {
          return Response.json({ models: [{
            slug: "gpt-daybreak-blue-latest",
            supported_in_api: true,
            visibility: "list"
          }] });
        }
        throw new Error("unexpected fetch");
      };
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            liveModels: false
          }
        },
        codexAccountNamespaces: { team: "@main" }
      }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(rows.find(row => row.slug === "team/gpt-daybreak-blue-latest")).toMatchObject({
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: 244_800,
      comp_hash: "3000",
      tool_mode: "code_mode_only",
      use_responses_lite: true,
      supports_parallel_tool_calls: true,
    });
    // Main's authenticated roster grants Daybreak, so Pool publishes one bare row alongside
    // the exact selector row. The observed cache row alone is not entitlement evidence.
    expect(rows.filter(row => row.slug === "gpt-daybreak-blue-latest")).toHaveLength(1);
  });

  test("explicit Codex-forward Daybreak survives sync with Sol metadata while account picker is off", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [nativeEntry("gpt-5.5", 0)],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
            codexAccountMode: "pool"
          }
        },
        defaultProvider: "openai",
        codexAccountPickerEnabled: false,
        codexAccountNamespaces: { main: "@main" },
        customModels: [{
          id: "daybreak-codex-forward",
          provider: "openai",
          modelId: "gpt-daybreak-blue-latest",
          contextWindow: 1050000
        }]
      }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    const daybreak = rows.find(row => row.slug === "openai/gpt-daybreak-blue-latest");
    expect(daybreak).toMatchObject({
      display_name: "Daybreak Blue",
      context_window: 922_000,
      max_context_window: 922_000,
      auto_compact_token_limit: 829_800,
      comp_hash: "3000",
      tool_mode: "code_mode_only",
      use_responses_lite: true,
      supports_parallel_tool_calls: true,
      supports_search_tool: true,
      multi_agent_version: "v2",
      opencodex_catalog_kind: "custom-model-v1",
    });
    expect(daybreak?.base_instructions).toContain("powered by the gpt-daybreak-blue-latest");
    // The explicit custom row is independent of native account entitlement. With no confirmed
    // account roster, the account-gated bare row stays absent instead of collapsing into it.
    expect(rows.filter(row => row.slug === "gpt-daybreak-blue-latest")).toHaveLength(0);
    expect(rows.some(row => row.slug === "main/gpt-daybreak-blue-latest")).toBe(false);
    // The separately billed API-key alias must still never reach the Codex surface.
    expect(rows.some(row => row.slug === "openai-apikey/daybreak-blue-latest")).toBe(false);
  });

  test("a live provider row shadowed by an account selector warns once per runtime generation", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [nativeEntry("gpt-5.5", 0)],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { resetCatalogRuntimeStateForTests, syncCatalogModels } = require("./src/codex/catalog");
      const config = {
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            liveModels: false
          },
          team: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            liveModels: false,
            models: ["gpt-5.5"]
          }
        },
        codexAccounts: [{ id: "stored-team-account", isMain: false }],
        codexAccountNamespaces: { team: "stored-team-account" }
      };
      syncCatalogModels(config)
        .then(() => syncCatalogModels(config))
        .then(() => {
          resetCatalogRuntimeStateForTests();
          return syncCatalogModels(config);
        })
        .then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);
    expect((r.stderr.match(/account selector collision on "team\/gpt-5\.5"/g) ?? []).length).toBe(2);

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{
      slug: string;
      opencodex_catalog_kind?: string;
    }>;
    expect(rows.filter(row => row.slug === "team/gpt-5.5")).toEqual([
      expect.objectContaining({ opencodex_catalog_kind: "account-selector-v1" }),
    ]);
  });

  test("non-OpenAI-only sync omits account rows without reprioritizing routed models", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({ models: [nativeEntry("gpt-5.5", 0)] }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({
        providers: {
          mock: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            liveModels: false,
            models: ["static-model"]
          }
        },
        codexAccountNamespaces: { desktop: "@main" }
      }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{
      slug: string;
      priority?: number;
    }>;
    expect(rows.find(row => row.slug === "mock/static-model")?.priority).toBe(5);
    expect(rows.some(row => row.slug === "gpt-5.5")).toBe(false);
    expect(rows.some(row => row.slug === "desktop/gpt-5.5")).toBe(false);
  });

  test("catalog sync persists routed code mode without changing native account rows", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [{ ...nativeEntry("gpt-5.5", 0), tool_mode: "code" }],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            liveModels: false
          },
          deepseek: {
            adapter: "openai-responses",
            baseUrl: "https://api.example.test/v1",
            liveModels: false,
            models: ["deepseek-v4-flash"]
          }
        },
        codexAccounts: [{ id: "stored-team-account", isMain: false }],
        codexAccountNamespaces: { team: "stored-team-account" }
      }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{
      slug: string;
      tool_mode?: string | null;
    }>;
    expect(rows.find(row => row.slug === "deepseek/deepseek-v4-flash")?.tool_mode)
      .toBe("code_mode_only");
    expect(rows.find(row => row.slug === "gpt-5.5")?.tool_mode).toBe("code");
    expect(rows.find(row => row.slug === "team/gpt-5.5")?.tool_mode).toBe("code");
  });

  test("disabled canonical OpenAI keeps bare bootstrap rows but omits unrouteable account rows", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [nativeEntry("gpt-5.5", 0)],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            disabled: true,
            liveModels: false
          }
        },
        codexAccounts: [{ id: "stored-side-account", isMain: false }],
        codexAccountNamespaces: { team: "stored-side-account" }
      }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{
      slug: string;
      visibility?: string;
    }>;
    expect(rows.find(row => row.slug === "gpt-5.5")?.visibility).toBe("list");
    expect(rows.some(row => row.slug.startsWith("team/"))).toBe(false);
  });

  test("native model fallback remains reachable without a live catalog", () => {
    writeFileSync(
      join(codexHome, "config.toml"),
      'model_catalog_json = "missing-catalog.json"\n',
      "utf8",
    );
    const r = runScript(codexHome, opencodexHome, `
      const { listCatalogNativeSlugs, nativeOpenAiSlugs, NATIVE_OPENAI_MODELS } = await import("./src/codex/catalog");
      console.log(JSON.stringify({ picker: listCatalogNativeSlugs(), native: nativeOpenAiSlugs(), fallback: NATIVE_OPENAI_MODELS }));
    `);

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout) as { picker: string[]; native: string[]; fallback: string[] };
    expect(result.picker).toContain("gpt-5.3-codex-spark");
    expect(result.native).toEqual(
      result.fallback.filter(slug => !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug)),
    );
  });

  test("account sync recovers supported natives that were hidden before selectors existed", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { ...nativeEntry("gpt-5.5", 0), visibility: "hide" },
        nativeEntry("gpt-5.4", 1),
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            liveModels: false
          }
        },
        disabledModels: ["gpt-5.4", "team/gpt-5.5"],
        codexAccounts: [{ id: "stored-side-account", isMain: false }],
        codexAccountNamespaces: { desktop: "@main", team: "stored-side-account" }
      }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{
      slug: string;
      visibility?: string;
      opencodex_catalog_kind?: string;
    }>;
    expect(rows.find(row => row.slug === "gpt-5.5")?.visibility).toBe("hide");
    // Generated rows recover from stale bare visibility, but still honor explicit native disables.
    expect(rows.find(row => row.slug === "team/gpt-5.5")).toMatchObject({
      visibility: "hide",
      opencodex_catalog_kind: "account-selector-v1",
    });
    expect(rows.find(row => row.slug === "desktop/gpt-5.5")).toMatchObject({
      visibility: "list",
      opencodex_catalog_kind: "account-selector-v1",
    });
    expect(rows.find(row => row.slug === "team/gpt-5.4")?.visibility).toBe("hide");
  });

  test("default catalog path merges from disk instead of replacing it with bundled rows", () => {
    const catalogPath = join(codexHome, "opencodex-catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'openai_base_url = "http://127.0.0.1:10100/v1"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        nativeEntry("user-native", 4),
        routedEntry("kiro/claude-opus-4.8", 5),
        routedEntry("opencode-go/glm-5.2", 6),
      ],
    }, null, 2) + "\n");

    // Force the default-path bundled shortcut to succeed. The fixture intentionally returns only
    // a native row so this test fails if sync uses the bundled catalog as its merge input.
    const codexCliPath = createCodexCatalogFixture(opencodexHome);
    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({ providers: {} }).then(res => console.log(JSON.stringify(res)));
    `, { CODEX_CLI_PATH: codexCliPath });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("provider discovery degraded");

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("gpt-5.5");
    expect(slugs).toContain("user-native");
    expect(slugs).toContain("kiro/claude-opus-4.8");
    expect(slugs).toContain("opencode-go/glm-5.2");
  });

  test("provider absence drops compatibility-excluded rows while preserving foreign routed entries", () => {
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
    expect(r.stderr).not.toContain("provider discovery degraded");

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("kiro/claude-opus-4.8");
    expect(slugs).toContain("opencode-go/glm-5.2");
    expect(slugs).not.toContain("opencode-go/hy3-preview");
  });

  /*
   * #759. A provider advertised `input_modalities: [..., "video"]`, which Codex parses as a
   * closed text|image|audio enum, so it rejected the ENTIRE catalog file: plugins, apps and
   * MCP servers all went to zero over one model's metadata, with only "Unable to load apps"
   * on screen.
   *
   * The provider-side filter and the ensureStrictCatalogFields normalization cover entry
   * construction, and unit tests already pin those. This covers the case those miss: a
   * poisoned row ALREADY on disk, which sync deliberately preserves when no provider is
   * configured and must repair on the way back out.
   *
   * The model must survive. Asserting only "no video in the output" would pass just as
   * happily if sync dropped the row instead of cleaning it, which would quietly delete a
   * provider model and call it a fix.
   */
  test("a poisoned routed row already on disk is repaired, not dropped, by the next sync", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    const poisoned = {
      ...routedEntry("zenmux/meta-muse-spark-1.1", 5),
      input_modalities: ["text", "image", "video"],
    };
    writeFileSync(catalogPath, JSON.stringify({
      models: [nativeEntry("gpt-5.5", 0), poisoned],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({ providers: {} }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const written = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      models: Array<{ slug: string; input_modalities?: unknown }>;
    };
    const row = written.models.find(m => m.slug === "zenmux/meta-muse-spark-1.1");
    // Survives the sync rather than being discarded as unparseable.
    expect(row).toBeDefined();
    expect(row!.input_modalities).toEqual(["text", "image"]);

    // And nothing anywhere in the written file is outside the enum Codex accepts, because one
    // bad value in any entry rejects the whole file.
    const outOfEnum = written.models.flatMap(m => (
      Array.isArray(m.input_modalities)
        ? (m.input_modalities as unknown[]).filter(v => v !== "text" && v !== "image" && v !== "audio")
        : []
    ));
    expect(outOfEnum).toEqual([]);
  });

  /*
   * #855. Deleting a provider must remove the rows OpenCodex generated for it
   * on the next sync. Rows authored by foreign tooling (Cursor, user edits)
   * stay preserved — the ownership signature in the generated description is
   * what separates the two.
   */
  test("drops OpenCodex-authored rows of a deleted provider, keeps foreign rows", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        ocxAuthoredEntry("future-grok/old-model", 5),
        routedEntry("cursor/composer-2.5", 6),
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
    expect(slugs).not.toContain("future-grok/old-model");
    expect(slugs).toContain("cursor/composer-2.5");
    expect(slugs).toContain("openai/fresh-model");
  });

  test("authoritative empty providers drop their own rows and deleted-provider ghosts", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        ocxAuthoredEntry("future-grok/old-model", 5),
        ocxAuthoredEntry("openai/keep-model", 6),
        routedEntry("cursor/composer-2.5", 7),
      ],
    }, null, 2) + "\n");

    // Static discovery is authoritative even when its configured allowlist is empty. Both the
    // configured provider's stale row and the deleted provider's ghost must go; foreign rows stay.
    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({
        providers: {
          openai: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            liveModels: false,
            models: []
          }
        }
      }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).not.toContain("future-grok/old-model");
    expect(slugs).not.toContain("openai/keep-model");
    expect(slugs).toContain("cursor/composer-2.5");
  });

  test("a degraded provider preserves only its own prior rows", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        ocxAuthoredEntry("offline/keep-model", 5),
        ocxAuthoredEntry("offline/disabled-model", 6),
        ocxAuthoredEntry("removed/ghost", 7),
        routedEntry("cursor/composer-2.5", 8),
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      globalThis.fetch = async () => new Response("{}", { status: 503 });
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({
        disabledModels: ["offline/disabled-model"],
        providers: {
          offline: {
            adapter: "openai-chat",
            authMode: "key",
            apiKey: "fixture-key",
            baseUrl: "https://api.example.test/v1",
            allowPrivateNetwork: true,
            models: ["fallback-model"]
          }
        }
      }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("provider discovery degraded; preserving 1 existing routed entry");

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("offline/keep-model");
    expect(slugs).toContain("offline/fallback-model");
    expect(slugs).not.toContain("offline/disabled-model");
    expect(slugs).not.toContain("removed/ghost");
    expect(slugs).toContain("cursor/composer-2.5");
  }, 15_000);

  test("drops legacy-signature ghost rows in both gather branches", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        ocxLegacyAuthoredEntry("future-grok/legacy-model", 5),
        routedEntry("cursor/composer-2.5", 6),
      ],
    }, null, 2) + "\n");

    // Partial-gather branch: another provider is configured and gathers rows.
    const partial = runScript(codexHome, opencodexHome, `
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
    expect(partial.status).toBe(0);
    let slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).not.toContain("future-grok/legacy-model");
    expect(slugs).toContain("cursor/composer-2.5");

    // Empty-gather branch: re-seed the legacy ghost and gather nothing.
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        ocxLegacyAuthoredEntry("future-grok/legacy-model", 5),
        routedEntry("cursor/composer-2.5", 6),
      ],
    }, null, 2) + "\n");
    const empty = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({ providers: {} }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(empty.status).toBe(0);
    slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).not.toContain("future-grok/legacy-model");
    expect(slugs).toContain("cursor/composer-2.5");
  });

  test("drops legacy combo-alias ghost rows in both gather branches", () => {
    const legacyComboAlias = {
      ...routedEntry("vendor/fast", 5),
      description: "Routed via opencodex → combo (combo).",
      owned_by: "combo",
    };
    const seed = () => writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        legacyComboAlias,
        routedEntry("cursor/composer-2.5", 6),
      ],
    }, null, 2) + "\n");
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");

    // Partial-gather branch: a PHYSICAL combo provider bypasses the generic
    // combo cleanup, so only the ownership matcher can remove the alias.
    seed();
    const partial = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({
        providers: {
          combo: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            liveModels: false,
            models: ["fresh-model"]
          }
        }
      }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(partial.status).toBe(0);
    let slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).not.toContain("vendor/fast");
    expect(slugs).toContain("cursor/composer-2.5");

    // Empty-gather branch: physical combo present but gathers zero rows.
    seed();
    const empty = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      syncCatalogModels({
        providers: {
          combo: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            liveModels: false,
            models: []
          }
        }
      }).then(res => console.log(JSON.stringify(res)));
    `);
    expect(empty.status).toBe(0);
    slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).not.toContain("vendor/fast");
    expect(slugs).toContain("cursor/composer-2.5");
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

  test("an identical resync leaves the catalog file untouched, a real change still writes", () => {
    // The app-server staleness classifier (#857) compares this file's mtime against
    // each running Codex's start time, so a no-op rewrite would report every
    // already-running Codex as holding an outdated catalog — and since #1407 that
    // verdict withholds opencodex's model guidance for the rest of that Codex's
    // lifetime, even though the advertised model set never changed.
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        nativeEntry("gpt-5.2", 104), // legacy -> dropped by the first sync
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { statSync, writeFileSync, readFileSync } = require("node:fs");
      const { syncCatalogModels } = require("./src/codex/catalog");
      const path = ${JSON.stringify(catalogPath)};
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      (async () => {
        const first = await syncCatalogModels({ providers: {} });
        const afterFirst = statSync(path).mtimeMs;
        await sleep(1100);
        const second = await syncCatalogModels({ providers: {} });
        const afterSecond = statSync(path).mtimeMs;
        // Not vacuous: a catalog that really differs must still be rewritten.
        const catalog = JSON.parse(readFileSync(path, "utf8"));
        catalog.models = catalog.models.filter(model => model.slug !== "gpt-5.5");
        writeFileSync(path, JSON.stringify(catalog, null, 2) + "\\n");
        const changedAt = statSync(path).mtimeMs;
        await sleep(1100);
        const third = await syncCatalogModels({ providers: {} });
        console.log(JSON.stringify({
          firstWritten: first.catalogWritten,
          secondWritten: second.catalogWritten,
          secondAdded: second.added,
          identicalResyncKeptMtime: afterFirst === afterSecond,
          thirdWritten: third.catalogWritten,
          realChangeBumpedMtime: statSync(path).mtimeMs > changedAt,
        }));
      })();
    `);
    expect(r.status).toBe(0);

    const out = JSON.parse(r.stdout) as {
      firstWritten: boolean;
      secondWritten: boolean;
      secondAdded: number;
      identicalResyncKeptMtime: boolean;
      thirdWritten: boolean;
      realChangeBumpedMtime: boolean;
    };
    expect(out.firstWritten).toBe(true);
    expect(out.secondWritten).toBe(false);
    expect(out.identicalResyncKeptMtime).toBe(true);
    expect(out.thirdWritten).toBe(true);
    expect(out.realChangeBumpedMtime).toBe(true);
  }, 15_000);

  test("the no-op guard compares bytes, so a malformed byte decoding to U+FFFD is still repaired", () => {
    // The guard above must not preserve corruption. `readFileSync(path, "utf8")`
    // substitutes U+FFFD for every invalid byte, so a catalog holding a bare 0x80
    // decodes equal to prepared content holding a real U+FFFD. A decoded-string
    // comparison calls that pair identical, skips the atomic repair write, and
    // reports catalogWritten:false while the bytes on disk differ from the bytes we
    // prepared — leaving malformed UTF-8 in the file Codex reads.
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [{ ...nativeEntry("gpt-5.5", 0), description: "native \uFFFD tail" }],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { readFileSync, writeFileSync } = require("node:fs");
      const { syncCatalogModels } = require("./src/codex/catalog");
      const path = ${JSON.stringify(catalogPath)};
      (async () => {
        // Converge first: the U+FFFD in the retained description survives into the
        // prepared content, so the following sync is a genuine byte-identical no-op.
        await syncCatalogModels({ providers: {} });
        const converged = readFileSync(path);
        const idempotent = await syncCatalogModels({ providers: {} });

        // Now corrupt exactly that replacement character into a bare 0x80. The
        // decoded strings stay equal; the bytes do not.
        const replacement = Buffer.from([0xef, 0xbf, 0xbd]);
        const at = converged.indexOf(replacement);
        const corrupted = Buffer.concat([
          converged.subarray(0, at),
          Buffer.from([0x80]),
          converged.subarray(at + replacement.length),
        ]);
        writeFileSync(path, corrupted);

        const repair = await syncCatalogModels({ providers: {} });
        const after = readFileSync(path);
        // A bare 0x80 is only malformed as a *leading* byte; the converged catalog
        // legitimately contains 0x80 as a continuation byte of multi-byte
        // characters, so count decode failures instead of raw byte occurrences.
        const malformedRuns = (buffer) => {
          let count = 0;
          for (let i = 0; i < buffer.length; i += 1) {
            const byte = buffer[i];
            if (byte < 0x80) continue;
            const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 0;
            if (width === 0) { count += 1; continue; }
            let ok = true;
            for (let k = 1; k < width; k += 1) {
              const next = buffer[i + k];
              if (next === undefined || next < 0x80 || next > 0xbf) { ok = false; break; }
            }
            if (!ok) { count += 1; continue; }
            i += width - 1;
          }
          return count;
        };
        console.log(JSON.stringify({
          foundReplacementByte: at >= 0,
          decodedEqual: corrupted.toString("utf8") === converged.toString("utf8"),
          bytesEqual: corrupted.equals(converged),
          identicalResyncSkipped: idempotent.catalogWritten === false,
          corruptedRewritten: repair.catalogWritten,
          bytesRepaired: after.equals(converged),
          malformedInCorrupted: malformedRuns(corrupted),
          malformedAfterRepair: malformedRuns(after),
        }));
      })();
    `);
    expect(r.status).toBe(0);

    const out = JSON.parse(r.stdout) as {
      foundReplacementByte: boolean;
      decodedEqual: boolean;
      bytesEqual: boolean;
      identicalResyncSkipped: boolean;
      corruptedRewritten: boolean;
      bytesRepaired: boolean;
      malformedInCorrupted: number;
      malformedAfterRepair: number;
    };
    // The premise: these two buffers decode the same and differ in bytes.
    expect(out.foundReplacementByte).toBe(true);
    expect(out.decodedEqual).toBe(true);
    expect(out.bytesEqual).toBe(false);
    expect(out.malformedInCorrupted).toBe(1);
    // Not vacuous: a truly byte-identical resync is still skipped, so this test
    // fails if the no-op guard is deleted rather than corrected.
    expect(out.identicalResyncSkipped).toBe(true);
    // The correction: differing bytes are rewritten and the malformed byte is gone.
    expect(out.corruptedRewritten).toBe(true);
    expect(out.bytesRepaired).toBe(true);
    expect(out.malformedAfterRepair).toBe(0);
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
