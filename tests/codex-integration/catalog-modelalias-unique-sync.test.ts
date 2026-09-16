import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Integration regression for #4730: whatever the upstream merge emits, the catalog a sync
// WRITES must carry every slug exactly once, and the guard must not collapse distinct
// slugs — the aliased (`CC-…`) and canonical (`command-code/…`) rows of one provider model
// are different public names and both must survive. Runs the real sync twice (idempotence)
// in an isolated CODEX_HOME/OPENCODEX_HOME with the reporter's config shape: provider
// `alias: "CC"` plus `modelAliases` mappings.

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

function runScript(codexHome: string, opencodexHome: string, script: string, extraEnv: Record<string, string> = {}): { stdout: string; status: number; stderr: string } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome, ...extraEnv },
    encoding: "utf8",
  });
  const diagnostics = [result.stderr ?? ""];
  if (result.error) {
    const code = "code" in result.error ? String(result.error.code) : result.error.name;
    diagnostics.push(`[spawn error: ${code}] ${result.error.stack ?? result.error.message}`);
  }
  if (result.signal) diagnostics.push(`[spawn signal] ${result.signal}`);
  return { stdout: result.stdout?.trim() ?? "", stderr: diagnostics.filter(Boolean).join("\n"), status: result.status ?? 1 };
}

function createCodexCatalogFixture(dir: string): string {
  const scriptPath = join(dir, "codex-catalog-fixture.js");
  const bundled = JSON.stringify({ models: [{
    slug: "gpt-5.5", display_name: "gpt-5.5", description: "native", priority: 0,
    visibility: "list", shell_type: "shell_command", comp_hash: "native-comp-hash",
    model_messages: { instructions_template: "You are Codex." },
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [{ effort: "medium", description: "m" }],
  }] });
  writeFileSync(scriptPath, [
    'if (process.argv.includes("--version")) {',
    '  console.log("codex-cli 0.999.0");',
    '} else {',
    `  process.stdout.write(${JSON.stringify(bundled)});`,
    '}',
  ].join("\n"), "utf8");
  // Without the executable bit the spawn fails and the loader silently falls back to another
  // candidate (src/codex/catalog/bundled.ts), so the test would pass while reading whatever Codex
  // the host has installed. Windows rejects an extensionless launcher outright, hence the .cmd
  // branch — same shape as tests/codex-integration/codex-catalog-sync-hardening.test.ts.
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

function routedEntry(slug: string, priority: number, display?: string): Record<string, unknown> {
  return {
    slug, display_name: display ?? slug, description: "routed", priority,
    visibility: "list", supported_reasoning_levels: [],
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
  };
}

describe("modelAliases sync writes unique slugs (#4730)", () => {
  let codexHome: string;
  let opencodexHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "ocx-alias-home-"));
    opencodexHome = mkdtempSync(join(tmpdir(), "ocx-alias-ocx-"));
  });

  afterEach(() => {
    if (existsSync(codexHome)) removeTreeWithRetry(codexHome);
    if (existsSync(opencodexHome)) removeTreeWithRetry(opencodexHome);
  });

  test("real sync dedups duplicate rows and keeps the alias/canonical pair distinct", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n');
    // Baseline carries duplicate rows of the SAME slug (the #4730 symptom) next to the
    // alias/canonical pair of one model and a native — the pair must NOT be collapsed.
    writeFileSync(catalogPath, JSON.stringify({ models: [
      routedEntry("command-code/MiniMaxAI-MiniMax-M3", 5),
      routedEntry("command-code/MiniMaxAI-MiniMax-M3", 5),
      routedEntry("CC-MiniMaxAI-MiniMax-M3", 5),
      routedEntry("CC-MiniMaxAI-MiniMax-M3", 5),
      routedEntry("command-code/deepseek-deepseek-v4-flash", 6),
    ] }));
    const runtime = createCodexCatalogFixture(opencodexHome);
    const config = {
      providers: {
        // The forward surface is what keeps includeNativeOpenAi true; without it the merge
        // drops every slash-less baseline row before the write guard ever sees them.
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
        "command-code": {
          adapter: "openai-chat",
          baseUrl: "https://catalog-fixture.invalid/v1",
          authMode: "key",
          apiKey: "fixture-key",
          liveModels: false,
          models: ["MiniMaxAI/MiniMax-M3", "deepseek/deepseek-v4-flash"],
          alias: "CC",
          modelAliases: {
            "MiniMaxAI/MiniMax-M3": "CC-MiniMaxAI-MiniMax-M3",
            "deepseek/deepseek-v4-flash": "CC-deepseek-deepseek-v4-flash",
          },
        },
      },
    };
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify(config));
    const passesPath = join(opencodexHome, "alias-sync-passes.json");
    const r = runScript(codexHome, opencodexHome, `
      const { readFileSync, writeFileSync } = require("node:fs");
      const { syncCatalogModels } = require("./src/codex/catalog");
      const config = ${JSON.stringify(config)};
      const passes = [];
      for (let pass = 0; pass < 2; pass++) {
        const result = await syncCatalogModels(config);
        passes.push({
          written: result.catalogWritten,
          catalog: JSON.parse(readFileSync(${JSON.stringify(catalogPath)}, "utf8")).models,
        });
      }
      writeFileSync(${JSON.stringify(passesPath)}, JSON.stringify(passes));
    `, { CODEX_CLI_PATH: runtime });
    expect(r.status, r.stderr).toBe(0);
    const passes = JSON.parse(readFileSync(passesPath, "utf8")) as Array<{
      written: boolean;
      catalog: Array<{ slug: string }>;
    }>;
    expect(passes).toHaveLength(2);
    expect(passes[0]!.written).toBe(true);
    // Slug-level idempotence: the same public names land in the same order every pass. Row
    // bodies may legitimately differ between passes (native metadata refresh), so equality
    // is asserted on the slug sequence, not on full rows.
    expect(passes[1]!.catalog.map(row => row.slug)).toEqual(passes[0]!.catalog.map(row => row.slug));
    for (const pass of passes) {
      const slugs = pass.catalog.map(row => row.slug);
      // The write-path guard: whatever the merge/retention emitted, every slug lands once.
      expect(new Set(slugs).size).toBe(slugs.length);
      // Distinct public names of the same provider model both survive, once each.
      expect(slugs).toContain("CC-MiniMaxAI-MiniMax-M3");
      expect(slugs).toContain("command-code/MiniMaxAI-MiniMax-M3");
      expect(slugs).toContain("command-code/deepseek-deepseek-v4-flash");
    }
  }, { timeout: 20_000 });
});
