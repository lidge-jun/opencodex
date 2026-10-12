import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
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

function runInject(env: Record<string, string>, validateOnly = false): { result: { success: boolean; message: string }; stderr: string } {
  const script = `
    const { injectCodexConfig } = require("./src/codex/inject");
    injectCodexConfig(10100, {}, ${validateOnly ? "{ validateOnly: true }" : "{}"}).then(result => {
      console.log(JSON.stringify({ success: result.success, message: result.message }));
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
  const config = readFileSync(join(codexHome, "config.toml"), "utf8");
  expect(config).toContain("opencodex");
});

test("a validate-only preflight passes without creating config.toml", () => {
  const codexHome = join(root, "codex");
  mkdirSync(codexHome);
  const { result, stderr } = runInject({ CODEX_HOME: codexHome, OPENCODEX_HOME: join(root, "ocx") }, true);
  expect(result.success, stderr).toBe(true);
  expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
});

test("a missing default Codex home is refused with an actionable message and nothing is created", () => {
  const home = join(root, "home");
  mkdirSync(home);
  const { result } = runInject({
    CODEX_HOME: "", HOME: home, USERPROFILE: home, OPENCODEX_HOME: join(root, "ocx"),
  });
  expect(result.success).toBe(false);
  expect(result.message).toContain("does not exist yet");
  expect(result.message).toContain("CODEX_HOME");
  expect(existsSync(join(home, ".codex"))).toBe(false);
});

test("a failure inside the write boundary after bootstrap rolls config.toml back to absent", () => {
  const codexHome = join(root, "codex");
  mkdirSync(codexHome);
  const script = `
    const inject = require("./src/codex/inject");
    inject.setBeforeHistoryArtifactCommitForTests(() => { throw new Error("fixture failure after bootstrap"); });
    inject.injectCodexConfig(10100, {}, {}).then(
      result => console.log(JSON.stringify({ settled: "result", success: result.success })),
      error => console.log(JSON.stringify({ settled: "error", message: String(error && error.message) })),
    );
  `;
  const spawned = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_SQLITE_HOME: "", CODEX_HOME: codexHome, OPENCODEX_HOME: join(root, "ocx") },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  const lines = (spawned.stdout ?? "").trim().split("\n");
  const outcome = JSON.parse(lines[lines.length - 1] ?? "{}") as { settled?: string; success?: boolean };
  expect(outcome.settled === "error" || outcome.success === false, spawned.stderr).toBe(true);
  expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
});
