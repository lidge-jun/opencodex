/**
 * tests/helpers/codex-home-sandbox.ts must resolve a test file's Codex paths into a temp directory
 * this process owns, whatever the environment says, and refuse otherwise. Each no-preload case runs
 * a child from a cwd with no bunfig.toml (so tests/preload.ts never loads), with CODEX_HOME pointing
 * at a temp directory posing as a user's custom real Codex home; nothing here reaches a real home.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertCodexHomeOwned, createdCodexHomeForTests } from "../helpers/codex-home-sandbox";
import { CODEX_HOME } from "../../src/codex/paths";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { repoPath } from "../helpers/repo-root";

const handles: TempHome[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.remove(); });

function runUnpreloaded(script: string, env: Record<string, string>) {
  const handle = createTempHome("ocx-codex-sandbox-child-");
  handles.push(handle);
  const customHome = handle.path("custom-codex-home");
  mkdirSync(customHome, { recursive: true });
  writeFileSync(join(customHome, "opencodex-catalog.json"), "{\"sentinel\":true}");
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: handle.root,
    env: { PATH: process.env.PATH ?? "", HOME: handle.root, CODEX_HOME: customHome, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  return { customHome, status: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString() };
}

const helperUrl = pathToFileURL(repoPath("tests", "helpers", "codex-home-sandbox.ts")).href;
const pathsUrl = pathToFileURL(repoPath("src", "codex", "paths.ts")).href;
const helperThenPaths = `
  const helper = await import(${JSON.stringify(helperUrl)});
  const paths = await import(${JSON.stringify(pathsUrl)});
  let owned = "yes";
  try { helper.assertCodexHomeOwned(paths.CODEX_HOME); } catch { owned = "no"; }
  console.log(JSON.stringify({ catalog: paths.DEFAULT_CATALOG_PATH, created: helper.createdCodexHomeForTests(), owned }));
`;

describe("codex-home-sandbox without the preload", () => {
  test.each([
    ["an inherited guard flag", { OCX_TEST_HOME_GUARD: "1" }],
    ["a custom CODEX_HOME alone", {}],
  ] as const)("%s still resolves into a directory this process created", (_name, env) => {
    const run = runUnpreloaded(helperThenPaths, env);
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as { catalog: string; created: string | null; owned: string };
    expect(out.created).not.toBeNull();
    expect(out.catalog).toBe(join(out.created!, "opencodex-catalog.json"));
    expect(out.catalog.startsWith(run.customHome)).toBe(false);
    expect(out.owned).toBe("yes");
    // The custom home is untouched.
    expect(readdirSync(run.customHome)).toEqual(["opencodex-catalog.json"]);
  });

  test("paths loaded before the helper are refused", () => {
    const run = runUnpreloaded(`
      const paths = await import(${JSON.stringify(pathsUrl)});
      const helper = await import(${JSON.stringify(helperUrl)});
      let refused = false;
      try { helper.assertCodexHomeOwned(paths.CODEX_HOME); } catch { refused = true; }
      console.log(JSON.stringify({ refused, home: paths.CODEX_HOME }));
    `, { OCX_TEST_HOME_GUARD: "1" });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as { refused: boolean; home: string };
    expect(out.refused).toBe(true);
    expect(out.home).toBe(run.customHome);
  });
});

describe("codex-home-sandbox in this process", () => {
  // Valid with or without the preload: whichever branch is in effect is asserted, never skipped.
  test("this file's own Codex home is proven owned on the branch in effect", () => {
    const created = createdCodexHomeForTests();
    if (created !== null) {
      // No preload: the helper ran before src/codex/paths and owns the home it resolved to.
      expect(realpathSync.native(CODEX_HOME)).toBe(created);
    } else {
      // The preload loaded src/codex/paths first; its test root's owner marker names this process.
      expect(existsSync(join(dirname(realpathSync.native(CODEX_HOME)), ".opencodex-test-owner.json"))).toBe(true);
    }
    expect(() => assertCodexHomeOwned(CODEX_HOME)).not.toThrow();
  });
});
