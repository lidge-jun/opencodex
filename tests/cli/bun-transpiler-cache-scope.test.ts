import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { scopeTranspilerCacheToRuntime, TRANSPILER_CACHE_ENV } from "../../src/lib/bun-transpiler-cache-scope.mjs";
import { durableBunChildEnv, durableBunRuntime } from "../../src/lib/bun-runtime";
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

  test("Windows matches every spelling of the name and leaves one scoped entry", () => {
    const env = { Bun_Runtime_Transpiler_Cache_Path: "C:\\cache", OTHER: "kept" };
    expect(scopeTranspilerCacheToRuntime(env, "1.4.2", join, "win32"))
      .toEqual({ [TRANSPILER_CACHE_ENV]: join("C:\\cache", "bun-1.4.2"), OTHER: "kept" });
    const both = { [TRANSPILER_CACHE_ENV]: "C:\\exact", bun_runtime_transpiler_cache_path: "C:\\other" };
    expect(scopeTranspilerCacheToRuntime(both, "1.4.2", join, "win32"))
      .toEqual({ [TRANSPILER_CACHE_ENV]: join("C:\\exact", "bun-1.4.2") });
    // POSIX names are case-sensitive: Bun never reads the lower-case spelling there.
    const posix = { bun_runtime_transpiler_cache_path: "/cache" };
    expect(scopeTranspilerCacheToRuntime(posix, "1.4.2", join, "linux")).toBe(posix);
  });

  test("a scoped cache stays beneath the configured path, never escaping to a sibling", () => {
    const scoped = (cache: string, version: string) =>
      scopeTranspilerCacheToRuntime({ [TRANSPILER_CACHE_ENV]: cache }, version, posix.join, "linux")[TRANSPILER_CACHE_ENV];
    // The same runtime reaches the same warm directory: the path is kept unchanged.
    expect(scoped("/cache/bun-1.4.2", "1.4.2")).toBe("/cache/bun-1.4.2");
    expect(scoped("/cache/bun-1.4.2/", "1.4.2")).toBe("/cache/bun-1.4.2/");
    expect(scoped("/a/b/bun-1.4.2", "1.4.2")).toBe("/a/b/bun-1.4.2");
    // A version change nests beneath the configured path. A version-shaped basename is an
    // ordinary directory name, not provenance: the parent is never handed to the sibling.
    expect(scoped("/cache/bun-1.4.2", "1.5.0")).toBe("/cache/bun-1.4.2/bun-1.5.0");
    expect(scoped("/cache/bun-9.9.9", "1.4.2")).toBe("/cache/bun-9.9.9/bun-1.4.2");
    expect(scoped("/bun-1.4.2", "1.5.0")).toBe("/bun-1.4.2/bun-1.5.0");
    expect(scoped("/bun-1.4.2/", "1.5.0")).toBe("/bun-1.4.2/bun-1.5.0");
    expect(scoped("bun-1.4.2", "1.5.0")).toBe("bun-1.4.2/bun-1.5.0");
    // A chain of changed versions nests inward; an independent launch configured with the
    // original base still lands one level down.
    expect(scoped(scoped("/cache", "1.4.2")!, "1.5.0")).toBe("/cache/bun-1.4.2/bun-1.5.0");
    expect(scoped(scoped(scoped("/cache", "1.4.2")!, "1.5.0")!, "1.4.2"))
      .toBe("/cache/bun-1.4.2/bun-1.5.0/bun-1.4.2");
    expect(scoped("/cache", "1.4.2")).toBe("/cache/bun-1.4.2");
    // A directory that merely contains a bun- name fragment stays an ordinary parent.
    expect(scoped("/cache/bun-cache", "1.4.2")).toBe("/cache/bun-cache/bun-1.4.2");
    expect(scoped("xbun-1.4.2", "1.5.0")).toBe("xbun-1.4.2/bun-1.5.0");
    // POSIX names are case-sensitive and "\" is an ordinary character there.
    expect(scoped("/cache/BUN-1.4.2", "1.4.2")).toBe("/cache/BUN-1.4.2/bun-1.4.2");
    expect(scoped("/cache\\bun-1.4.2", "1.4.2")).toBe("/cache\\bun-1.4.2/bun-1.4.2");
    // Roots have no leaf to match and gain the version child directly.
    expect(scoped("/", "1.5.0")).toBe("/bun-1.5.0");
  });

  test("Windows scoping folds leaf case and both separators, preserving path form", () => {
    const scoped = (cache: string, version: string) =>
      scopeTranspilerCacheToRuntime({ [TRANSPILER_CACHE_ENV]: cache }, version, win32.join, "win32")[TRANSPILER_CACHE_ENV];
    expect(scoped("C:\\cache\\bun-1.4.2", "1.4.2")).toBe("C:\\cache\\bun-1.4.2");
    // The same directory on a case-insensitive filesystem, so the leaf still matches.
    expect(scoped("C:\\cache\\BUN-1.4.2", "1.4.2")).toBe("C:\\cache\\BUN-1.4.2");
    expect(scoped("C:/cache/bun-1.4.2", "1.4.2")).toBe("C:/cache/bun-1.4.2");
    // A version change nests beneath the configured path, never beside it.
    expect(scoped("C:\\cache\\bun-1.4.2", "1.5.0")).toBe("C:\\cache\\bun-1.4.2\\bun-1.5.0");
    expect(scoped("C:\\cache\\bun-9.9.9", "1.4.2")).toBe("C:\\cache\\bun-9.9.9\\bun-1.4.2");
    // Roots, UNC shares and drive-relative paths keep their form.
    expect(scoped("C:\\", "1.5.0")).toBe("C:\\bun-1.5.0");
    expect(scoped("/", "1.5.0")).toBe(win32.join("/", "bun-1.5.0"));
    expect(scoped("\\\\server\\share", "1.5.0")).toBe("\\\\server\\share\\bun-1.5.0");
    expect(scoped("\\\\server\\share\\bun-1.5.0", "1.5.0")).toBe("\\\\server\\share\\bun-1.5.0");
    // join("C:", x) would produce the drive root "C:\\x"; drive-relative stays relative.
    expect(scoped("C:", "1.5.0")).toBe("C:bun-1.5.0");
    expect(scoped("C:bun-1.5.0", "1.5.0")).toBe("C:bun-1.5.0");
    expect(scoped("C:bun-1.4.2", "1.5.0")).toBe("C:bun-1.4.2\\bun-1.5.0");
  });

  test("no marker-style variable forgery changes where the cache is scoped", () => {
    // The scope comes from the configured path alone. A marker-looking entry, forged or
    // stale, must neither suppress nesting nor redirect the cache elsewhere.
    const env = {
      [TRANSPILER_CACHE_ENV]: "/cache/bun-9.9.9",
      OCX_TRANSPILER_CACHE_SCOPED: "/elsewhere",
    };
    const result = scopeTranspilerCacheToRuntime(env, "1.4.2", posix.join, "linux");
    expect(result[TRANSPILER_CACHE_ENV]).toBe("/cache/bun-9.9.9/bun-1.4.2");
    expect(result.OCX_TRANSPILER_CACHE_SCOPED).toBe("/elsewhere");
  });

  test("prerelease and build metadata versions are accepted, oversized ones are not", () => {
    const env = { [TRANSPILER_CACHE_ENV]: "/cache" };
    expect(scopeTranspilerCacheToRuntime(env, "1.4.0+build.1", join)[TRANSPILER_CACHE_ENV]).toBe(join("/cache", "bun-1.4.0+build.1"));
    expect(scopeTranspilerCacheToRuntime(env, "1.4.3-canary-1", join)[TRANSPILER_CACHE_ENV]).toBe(join("/cache", "bun-1.4.3-canary-1"));
    expect(scopeTranspilerCacheToRuntime(env, "1.4.3-" + "a".repeat(64), join)).toBe(env);
  });

  test("server children on the bundled runtime get a scoped cache only across a version change", () => {
    const env = { ...process.env, [TRANSPILER_CACHE_ENV]: join(tmpdir(), "ocx-durable-scope") };
    const runtime = durableBunRuntime();
    const child = durableBunChildEnv(env);
    if (runtime.source !== "bundled") { expect(child).toBe(env); return; }
    const bundled = JSON.parse(readFileSync(join(dirname(dirname(runtime.path)), "package.json"), "utf8")).version as string;
    expect(child[TRANSPILER_CACHE_ENV]).toBe(bundled === Bun.version ? env[TRANSPILER_CACHE_ENV] : join(env[TRANSPILER_CACHE_ENV]!, `bun-${bundled}`));
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

