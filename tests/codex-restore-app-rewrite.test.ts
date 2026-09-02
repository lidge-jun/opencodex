import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * #1798: the Codex app rewrites config.toml AFTER injection, so the journal's
 * exact-bytes restore no longer fires and the fallback strip is the only thing left.
 * That fallback recognizes an injected `openai_base_url` ONLY by the marker comment
 * on the line above it. An app rewrite reserializes the file and drops the comment, so
 * the proxy URL stops being recognized as ours and survives `ocx stop` / `ocx restore`
 * while the command reports success -- leaving plain Codex pointed at a dead port.
 *
 * These tests reproduce that state literally: inject, drop every comment the way a TOML
 * reserializer would (values kept, comments gone), then restore.
 */

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

/** Inject, simulate the app's comment-dropping rewrite, then restore. */
const INJECT_REWRITE_RESTORE = [
  'const fs = require("fs");',
  'const path = require("path");',
  'const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");',
  "(async () => {",
  "  await injectCodexConfig(10100, {",
  "    port: 10100,",
  "    providers: {},",
  '    defaultProvider: "openai",',
  '    injectionModel: "gpt-5.6-sol",',
  '    injectionEffort: "high",',
  "  }, { catalogPath: null });",
  '  const configPath = path.join(process.env.CODEX_HOME, "config.toml");',
  '  const injected = fs.readFileSync(configPath, "utf8");',
  "  // Exactly what a reserializing app writer produces: every VALUE survives,",
  "  // every COMMENT -- including our ownership marker -- is gone.",
  "  const rewritten = injected",
  "    .split(String.fromCharCode(10))",
  '    .filter(line => !line.trim().startsWith("#"))',
  "    .join(String.fromCharCode(10)) + String.fromCharCode(10) + '# app rewrite';",
  '  fs.writeFileSync(configPath, rewritten, "utf8");',
  "  const result = restoreNativeCodex();",
  "  console.log(JSON.stringify({ success: result.success, message: result.message }));",
  "})();",
].join("\n");

/** Inject with an explicit catalog path, drop `model_catalog_json` the way a rewrite does, then restore. */
const CATALOG_REWRITE_RESTORE = [
  'const fs = require("fs");',
  'const path = require("path");',
  'const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");',
  "(async () => {",
  '  const cachePath = path.join(process.env.CODEX_HOME, "models_cache.json");',
  "  // The catalog file itself is written by catalog sync, which needs network state this",
  "  // test has no business standing up. Seed it directly: what is under test is WHICH file",
  "  // restore targets, not how sync populates it.",
  '  fs.writeFileSync(cachePath, JSON.stringify({ models: [{ slug: "gpt-5.5" }, { slug: "opencode-go/deepseek-v4-flash" }] }), "utf8");',
  "  await injectCodexConfig(10100, {",
  "    port: 10100,",
  "    providers: {},",
  '    defaultProvider: "openai",',
  '    injectionModel: "gpt-5.6-sol",',
  '    injectionEffort: "high",',
  "  }, { catalogPath: cachePath });",
  '  const configPath = path.join(process.env.CODEX_HOME, "config.toml");',
  '  const rewritten = fs.readFileSync(configPath, "utf8")',
  "    .split(String.fromCharCode(10))",
  '    .filter(line => !line.trim().startsWith("#") && !line.includes("model_catalog_json"))',
  "    .join(String.fromCharCode(10));",
  '  fs.writeFileSync(configPath, rewritten, "utf8");',
  "  const result = restoreNativeCodex();",
  "  console.log(JSON.stringify({ success: result.success, catalog: result.artifacts.catalog.path }));",
  "})();",
].join(String.fromCharCode(10));

/** Reinject with a new route and catalog, then expose the durable ownership record. */
const REINJECT_AND_READ_JOURNAL = [
  'const fs = require("fs");',
  'const path = require("path");',
  'const { injectCodexConfig } = require("./src/codex/inject");',
  "(async () => {",
  '  const firstCatalog = path.join(process.env.CODEX_HOME, "first-catalog.json");',
  '  const secondCatalog = path.join(process.env.CODEX_HOME, "second-catalog.json");',
  "  const config = {",
  "    port: 10100,",
  "    providers: {},",
  '    defaultProvider: "openai",',
  '    injectionModel: "gpt-5.6-sol",',
  '    injectionEffort: "high",',
  "  };",
  "  await injectCodexConfig(10100, config, { catalogPath: firstCatalog });",
  "  await injectCodexConfig(10200, { ...config, port: 10200 }, { catalogPath: secondCatalog });",
  '  const journal = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"), "utf8"));',
  "  console.log(JSON.stringify({ url: journal.injectedOpenaiBaseUrl, catalog: journal.injectedCatalogPath }));",
  "})();",
].join(String.fromCharCode(10));

/** Preserve a user edit made after the first injection across reinjection and restore. */
const REINJECT_AFTER_USER_EDIT_RESTORE = [
  'const fs = require("fs");',
  'const path = require("path");',
  'const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");',
  "(async () => {",
  "  const config = {",
  "    port: 10100,",
  "    providers: {},",
  '    defaultProvider: "openai",',
  '    injectionModel: "gpt-5.6-sol",',
  '    injectionEffort: "high",',
  "  };",
  "  await injectCodexConfig(10100, config, { catalogPath: null });",
  '  const configPath = path.join(process.env.CODEX_HOME, "config.toml");',
  '  fs.appendFileSync(configPath, String.fromCharCode(10) + \'approval_policy = "never"\' + String.fromCharCode(10), "utf8");',
  "  await injectCodexConfig(10200, { ...config, port: 10200 }, { catalogPath: null });",
  '  const beforeRestore = fs.readFileSync(configPath, "utf8");',
  "  const result = restoreNativeCodex({ skipHistory: true });",
  '  const afterRestore = fs.readFileSync(configPath, "utf8");',
  '  const profileExistsAfterRestore = fs.existsSync(path.join(process.env.CODEX_HOME, "opencodex.config.toml"));',
  "  console.log(JSON.stringify({",
  "    success: result.success,",
  "    action: result.artifacts.config.action,",
  "    beforeRestore,",
  "    afterRestore,",
  "    profileExistsAfterRestore,",
  "  }));",
  "})();",
].join(String.fromCharCode(10));

function runScript(codexHome: string, script: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: "utf8",
  });
  return { stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "", status: result.status ?? 1 };
}

describe("#1798 restore after the Codex app rewrites the config", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ocx-1798-"));
  });

  afterEach(() => {
    removeTreeWithRetry(testDir);
  });

  test("an unmarked injected openai_base_url is still removed", () => {
    writeFileSync(join(testDir, "config.toml"), '# original config\nmodel = "gpt-5.5"\n', "utf8");

    const r = runScript(testDir, INJECT_REWRITE_RESTORE);
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);

    const restored = readFileSync(join(testDir, "config.toml"), "utf8");
    // The reported defect: the proxy URL survives, so plain Codex talks to a dead port.
    expect(restored).not.toContain("openai_base_url");
    expect(restored).not.toContain("127.0.0.1:10100");
    // The user's own pre-injection content is still theirs.
    expect(restored).toContain("gpt-5.5");
  }, 15_000);

  test("a user's own openai_base_url written before injection is preserved", () => {
    // Force a byte mismatch so exact journal restore cannot hide a fallback ownership bug.
    // The mirror-image risk of the fix: stripping ANY unmarked openai_base_url would
    // delete a URL we never wrote. The journaled ownership evidence is the arbiter.
    writeFileSync(
      join(testDir, "config.toml"),
      'openai_base_url = "https://my-own-gateway.example/v1"\nmodel = "gpt-5.5"\n',
      "utf8",
    );

    const r = runScript(testDir, INJECT_REWRITE_RESTORE);
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);

    const restored = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(restored).toContain("https://my-own-gateway.example/v1");
    expect(restored).not.toContain("127.0.0.1:10100");
  }, 15_000);

  test("reinjection refreshes the owned route and catalog recorded for restore", () => {
    writeFileSync(join(testDir, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runScript(testDir, REINJECT_AND_READ_JOURNAL);
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);

    const recorded = JSON.parse(r.stdout) as { url: string; catalog: string };
    expect(recorded.url).toBe("http://127.0.0.1:10200/v1");
    expect(recorded.catalog).toBe(join(testDir, "second-catalog.json"));
  }, 20_000);

  test("a user setting added after first injection survives reinjection and restore", () => {
    writeFileSync(join(testDir, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runScript(testDir, REINJECT_AFTER_USER_EDIT_RESTORE);
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);

    const result = JSON.parse(r.stdout) as {
      success: boolean;
      action: string;
      beforeRestore: string;
      afterRestore: string;
      profileExistsAfterRestore: boolean;
    };
    expect(result.success).toBe(true);
    expect(result.action).toBe("owned-fields-stripped");
    expect(result.beforeRestore).toContain('approval_policy = "never"');
    expect(result.beforeRestore).toContain("127.0.0.1:10200");
    expect(result.afterRestore).toContain('approval_policy = "never"');
    expect(result.afterRestore).toContain('model = "gpt-5.5"');
    expect(result.afterRestore).not.toContain("openai_base_url");
    expect(result.afterRestore).not.toContain("127.0.0.1:10200");
    expect(result.profileExistsAfterRestore).toBe(false);
  }, 20_000);

  test("the routed catalog we wrote is restored even when the rewrite dropped model_catalog_json", () => {
    // The catalog half of #1798. Restore used to re-resolve its target from the CURRENT
    // config, so a rewrite that removed `model_catalog_json` sent it to the default catalog
    // while the proxy-written models_cache.json kept every routed entry.
    writeFileSync(join(testDir, "config.toml"), 'model = "gpt-5.5"' + String.fromCharCode(10), "utf8");

    const r = runScript(testDir, CATALOG_REWRITE_RESTORE);
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);

    const cachePath = join(testDir, "models_cache.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    const routed = (cache.models ?? []).filter((m: { slug?: string }) => typeof m.slug === "string" && m.slug.includes("/"));
    expect(routed).toEqual([]);
    expect(JSON.parse(r.stdout).catalog).toBe(cachePath);
  }, 15_000);
});
