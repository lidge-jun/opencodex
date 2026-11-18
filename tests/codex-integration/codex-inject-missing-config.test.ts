import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * Issue 5422: a fresh Codex install can have its home but no config.toml yet (Codex writes it
 * lazily; an authless Desktop user may never get one). Injection must bootstrap the file in the
 * resolved home instead of reporting "Is Codex installed?", never overwrite an existing file,
 * write nothing during a validate-only preflight, and still refuse when the home itself is
 * missing. CODEX_HOME is resolved at import, so each case runs in its own process.
 */
const repoRoot = resolveRepoRoot();
let root: string;

setDefaultTimeout(SPAWN_BUDGET_MS);

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-inject-missing-config-")));
});

afterEach(() => {
  removeTreeWithRetry(root);
});

function runInject(env: Record<string, string>, validateOnly = false): { result: { success: boolean; message: string; configChanged?: boolean }; stderr: string } {
  const script = `
    const { injectCodexConfig } = require("./src/codex/inject");
    injectCodexConfig(10100, {}, ${validateOnly ? "{ validateOnly: true }" : "{}"}).then(result => {
      console.log(JSON.stringify({ success: result.success, message: result.message, configChanged: result.configChanged }));
    });
  `;
  const spawned = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_SQLITE_HOME: "", ...env },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  const lines = (spawned.stdout ?? "").trim().split("\n");
  return { result: JSON.parse(lines[lines.length - 1] ?? "{}"), stderr: spawned.stderr ?? "" };
}

test("a Codex home without config.toml is bootstrapped and routed", () => {
  const codexHome = join(root, "codex");
  mkdirSync(codexHome);
  const { result, stderr } = runInject({ CODEX_HOME: codexHome, OPENCODEX_HOME: join(root, "ocx") });
  expect(result.success, stderr).toBe(true);
  expect(result.configChanged).toBe(true);
  const config = readFileSync(join(codexHome, "config.toml"), "utf8");
  expect(config).toContain("opencodex");
});

test("preserves a user's same-named catalog binding and writes its absolute path in the profile", () => {
  const codexHome = join(root, "codex");
  const configPath = join(codexHome, "config.toml");
  const catalogPath = join(root, "opencodex-catalog.json");
  mkdirSync(codexHome);
  writeFileSync(configPath, 'model = "gpt-5.5"\nmodel_catalog_json = "../opencodex-catalog.json"\n');
  writeFileSync(catalogPath, '{"models":[]}\n');

  const { result, stderr } = runInject({ CODEX_HOME: codexHome, OPENCODEX_HOME: join(root, "ocx") });
  expect(result.success, stderr).toBe(true);
  expect(Bun.TOML.parse(readFileSync(configPath, "utf8")).model_catalog_json).toBe("../opencodex-catalog.json");
  const profile = join(codexHome, "opencodex.config.toml");
  expect(Bun.TOML.parse(readFileSync(profile, "utf8")).model_catalog_json).toBe(catalogPath);
  const reinjected = runInject({ CODEX_HOME: codexHome, OPENCODEX_HOME: join(root, "ocx") });
  expect(reinjected.result.success, reinjected.stderr).toBe(true);
  expect(Bun.TOML.parse(readFileSync(configPath, "utf8")).model_catalog_json).toBe("../opencodex-catalog.json");
});

test.each([false, true])("preserves a user catalog selected by a legacy journal (sync first: %s)", (syncFirst) => {
  const codexHome = join(root, "codex");
  const opencodexHome = join(root, "ocx");
  const configPath = join(codexHome, "config.toml");
  const catalogPath = join(codexHome, "custom.json");
  const original = 'model = "gpt-5.5"\n';
  const userBinding = '"model_catalog_json" = "./custom.json" # user selection';
  mkdirSync(codexHome);
  writeFileSync(configPath, `${original}${userBinding}\n`);
  writeFileSync(catalogPath, '{"models":[]}\n');
  const script = `
    const { JOURNAL_PATH, journaledInjectedCatalogPath } = require("./src/codex/journal");
    const { readFileSync, writeFileSync } = require("node:fs");
    const { sameCodexCatalogPath } = require("./src/codex/paths");
    const { injectCodexConfig, removeCodexConfig } = require("./src/codex/inject");
    const configPath = ${JSON.stringify(configPath)};
    const catalogPath = ${JSON.stringify(catalogPath)};
    writeFileSync(JOURNAL_PATH, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from(${JSON.stringify(original)}).toString("base64"),
      originalProfile: null,
      injectedCatalogPath: "custom.json",
    }));
    const canRecoverFile = sameCodexCatalogPath(configPath, journaledInjectedCatalogPath(), catalogPath);
    const result = ${syncFirst} ? await injectCodexConfig(10100, {}) : null;
    const afterSync = readFileSync(configPath, "utf8");
    const removal = removeCodexConfig();
    console.log(JSON.stringify({ canRecoverFile, result, afterSync, removal }));
  `;
  const spawned = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome, CODEX_SQLITE_HOME: "" },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  expect(spawned.status, spawned.stderr).toBe(0);
  const { canRecoverFile, result, afterSync, removal } = JSON.parse(spawned.stdout.trim().split("\n").at(-1)!);
  expect(canRecoverFile).toBe(true);
  expect(result?.success ?? !syncFirst, result?.message).toBe(true);
  expect(afterSync).toContain(userBinding);
  expect(removal.success, removal.message).toBe(true);
  expect(readFileSync(configPath, "utf8")).toContain(userBinding);
});

test("catalog readers honor a quoted root key after multiline TOML data", () => {
  const codexHome = join(root, "codex");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), [
    "instructions = '''",
    "[not_a_table]",
    'model_catalog_json = "not-the-catalog.json"',
    "'''",
    '"model_catalog_json" = "catalogs/custom.json" # selected by the user',
    "[profile]",
    'model_catalog_json = "nested.json"',
  ].join("\n"));
  const spawned = spawnSync(process.execPath, ["--eval", `
    const paths = require("./src/codex/paths");
    const picker = require("./src/codex/desktop-app/picker-freshness");
    console.log(JSON.stringify([paths.readCodexCatalogPath(), picker.readCodexCatalogBinding()]));
  `], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: join(root, "ocx") },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  expect(spawned.status, spawned.stderr).toBe(0);
  expect(JSON.parse(spawned.stdout)).toEqual(Array(2).fill(join(codexHome, "catalogs", "custom.json")));
});

test("catalog and Desktop picker readers resolve from the config home with a different cwd", () => {
  const codexHome = join(root, "codex");
  const catalogPath = join(codexHome, "opencodex-catalog.json");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n');
  const script = `
    const paths = require("./src/codex/paths");
    const picker = require("./src/codex/desktop-app/picker-freshness");
    const status = require("./src/cli/status");
    console.log(JSON.stringify([
      paths.readCodexCatalogPath(),
      paths.readCodexCatalogPathForHome(process.env.CODEX_HOME),
      picker.readCodexCatalogBinding(),
      status.detectMissingCodexCatalogPath(),
    ]));
  `;
  const spawned = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: join(root, "ocx") },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  expect(spawned.status, spawned.stderr).toBe(0);
  expect(JSON.parse(spawned.stdout)).toEqual(Array(4).fill(catalogPath));
});

test("a validate-only preflight passes without creating config.toml", () => {
  const codexHome = join(root, "codex");
  mkdirSync(codexHome);
  const { result, stderr } = runInject({ CODEX_HOME: codexHome, OPENCODEX_HOME: join(root, "ocx") }, true);
  expect(result.success, stderr).toBe(true);
  expect(result.configChanged).not.toBe(true);
  expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
});

test("a missing default Codex home is refused with an actionable message and nothing is created", () => {
  const home = join(root, "home");
  mkdirSync(home);
  const { result } = runInject({
    CODEX_HOME: "", HOME: home, USERPROFILE: home, OPENCODEX_HOME: join(root, "ocx"),
  });
  expect(result.success).toBe(false);
  expect(result.configChanged).not.toBe(true);
  expect(result.message).toContain("does not exist yet");
  expect(result.message).toContain("CODEX_HOME");
  expect(existsSync(join(home, ".codex"))).toBe(false);
});

test("a failure inside the write boundary after bootstrap rolls config.toml back to absent", () => {
  const codexHome = join(root, "codex");
  mkdirSync(codexHome);
  const script = `
    const inject = require("./src/codex/inject");
    let reachedArtifactCommit = false;
    inject.setBeforeHistoryArtifactCommitForTests(() => {
      reachedArtifactCommit = true;
      throw new Error("fixture failure after bootstrap");
    });
    inject.injectCodexConfig(10100, {}, {}).then(
      result => console.log(JSON.stringify({ settled: "result", success: result.success, configChanged: result.configChanged, reachedArtifactCommit })),
      error => console.log(JSON.stringify({ settled: "error", message: String(error && error.message), reachedArtifactCommit })),
    );
  `;
  const spawned = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_SQLITE_HOME: "", CODEX_HOME: codexHome, OPENCODEX_HOME: join(root, "ocx") },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  const lines = (spawned.stdout ?? "").trim().split("\n");
  const outcome = JSON.parse(lines[lines.length - 1] ?? "{}") as { settled?: string; success?: boolean; configChanged?: boolean; reachedArtifactCommit?: boolean };
  expect(outcome.reachedArtifactCommit, spawned.stderr).toBe(true);
  expect(outcome.configChanged).not.toBe(true);
  expect(outcome.settled === "error" || outcome.success === false, spawned.stderr).toBe(true);
  expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
});
