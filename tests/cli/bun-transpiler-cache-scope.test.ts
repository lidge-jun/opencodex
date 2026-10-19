import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeTranspilerCacheToRuntime, TRANSPILER_CACHE_ENV } from "../../src/lib/bun-transpiler-cache-scope.mjs";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { COLD_SPAWN_BUDGET_MS } from "../helpers/test-budget";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

describe("launcher transpiler cache scope", () => {
  test("an explicit cache is scoped to the started runtime's version", () => {
    const env = { [TRANSPILER_CACHE_ENV]: "/cache", OTHER: "kept" };
    expect(scopeTranspilerCacheToRuntime(env, "1.4.2", join)).toEqual({ [TRANSPILER_CACHE_ENV]: join("/cache", "bun-1.4.2"), OTHER: "kept" });
    expect(env[TRANSPILER_CACHE_ENV]).toBe("/cache");
  });

  test("a disabled, unset or unknown-version cache is left as given", () => {
    for (const value of ["0", "", undefined]) {
      const env = { [TRANSPILER_CACHE_ENV]: value };
      expect(scopeTranspilerCacheToRuntime(env, "1.4.2", join)).toBe(env);
    }
    const env = { [TRANSPILER_CACHE_ENV]: "/cache" };
    for (const version of [null, undefined, "", "../1.4.2", "1.4", "latest"]) {
      expect(scopeTranspilerCacheToRuntime(env, version, join)).toBe(env);
    }
  });

  // CI shares one cache between the test-runner Bun and the bundled Bun the launcher starts.
  // Their .pile formats differ and each deletes the other's entries, so before this scope every
  // launcher child re-transpiled its CLI graph cold (15 s spawnSync timeouts on Windows).
  test.skipIf(spawnSync("node", ["--version"], { windowsHide: true }).status !== 0)(
    "the published launcher writes its runtime's entries beside the runner's, never over them", () => {
      const cache = mkdtempSync(join(tmpdir(), "ocx-transpiler-scope-"));
      roots.push(cache);
      const bundled = JSON.parse(readFileSync(repoPath("node_modules", "bun", "package.json"), "utf8")).version as string;
      const result = spawnSync("node", [repoPath("bin", "ocx.mjs"), "--version"], {
        cwd: repoRoot(), encoding: "utf8", timeout: COLD_SPAWN_BUDGET_MS - 5_000, windowsHide: true,
        env: { ...process.env, [TRANSPILER_CACHE_ENV]: cache, OPENCODEX_BUN_PATH: "" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(readdirSync(cache)).toEqual([`bun-${bundled}`]);
      expect(existsSync(join(cache, `bun-${bundled}`)) && readdirSync(join(cache, `bun-${bundled}`)).length > 0).toBe(true);
    }, COLD_SPAWN_BUDGET_MS);
});

