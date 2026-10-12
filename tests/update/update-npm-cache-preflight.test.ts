import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectNpmCacheDirectory,
  inspectNpmCacheRoot,
  npmCachePreflightFailureMessage,
  resolveNpmCachePath,
  runNpmCachePreflight,
} from "../../src/update/npm-cache-preflight.mjs";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];

/**
 * Windows without Developer Mode or admin cannot create symlinks (EPERM). The
 * cases guarded below are about symlink handling itself, so detect the privilege
 * once and take a visible skip rather than failing in the fixture.
 */
const canSymlink = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), "ocx-cache-preflight-symlink-probe-"));
  try {
    symlinkSync(join(probeDir, "probe-target"), join(probeDir, "probe-link"));
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return false;
    throw e;
  } finally {
    removeTreeWithRetry(probeDir);
  }
})();

/**
 * Windows needs its own guard, separate from `canSymlink`.
 *
 * The capability probe answers "may this user create a symlink", and on a GitHub-hosted
 * Windows runner the answer is YES — so these cases ran and then failed in the fixture with
 * `cache_entry_inaccessible`, because what actually differs there is how the preflight reads
 * mode and access through a Windows symlink, not whether the link can be made (#2152).
 *
 * Two neighbouring cases in this file already skip on `process.platform === "win32"` for the
 * same reason, so this reuses that guard rather than inventing a second mechanism. The
 * capability check stays: an unprivileged POSIX-like environment still skips honestly.
 */
const WINDOWS = process.platform === "win32";

function tempRoot(name: string): string {
  const root = join(tmpdir(), `ocx-cache-preflight-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

describe("npm cache access pre-flight", () => {
  test("rejects foreign-owned nested entries with a structured reason", () => {
    const foreignCache = tempRoot("foreign");
    const nested = join(foreignCache, "_cacache", "content-v2");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "entry"), "cached");

    const actualUid = process.getuid?.() ?? 0;
    expect(inspectNpmCacheDirectory(foreignCache, { expectedUid: actualUid + 1 })).toEqual({
      ok: false,
      reason: "cache_entry_foreign_owner",
    });
  });

  test("rejects inaccessible nested entries with a structured reason", () => {
    const inaccessibleCache = tempRoot("inaccessible");
    const blocked = join(inaccessibleCache, "_cacache");
    mkdirSync(blocked);
    chmodSync(blocked, 0o000);
    try {
      expect(inspectNpmCacheDirectory(inaccessibleCache)).toEqual({
        ok: false,
        reason: "cache_entry_inaccessible",
      });
    } finally {
      chmodSync(blocked, 0o700);
    }
  });

  test.skipIf(WINDOWS || !canSymlink)("lstats normal nested symlinks but never traverses their targets", () => {
    const cache = tempRoot("symlink-cache");
    const missingTarget = join(tempRoot("symlink-target"), "does-not-exist");
    const npx = join(cache, "_npx");
    const nodeModules = join(npx, "123", "node_modules");
    mkdirSync(join(nodeModules, ".bin"), { recursive: true });
    symlinkSync(missingTarget, join(nodeModules, "linked-package"), "dir");
    symlinkSync(missingTarget, join(nodeModules, ".bin", "linked-bin"));

    expect(inspectNpmCacheDirectory(cache)).toEqual({ ok: true, reason: "cache_accessible" });
  });

  test.skipIf(WINDOWS || !canSymlink)("a foreign-owned nested symlink does not block the update", () => {
    // The distinction that decides whether this feature is usable. A real npm cache is full of
    // symlinks below _npx/node_modules/.bin, and their owner is irrelevant because we never
    // follow them. Rejecting on ownership before skipping the link would abort updates for
    // ordinary users — worse than the bug the preflight exists to prevent.
    // Bind the assertion to ownership specifically. A real foreign-owned symlink cannot be
    // created in a unit test (that needs a second uid), so the uid is supplied through the
    // injected seam: report the link as foreign-owned and everything else as ours. If the
    // symlink skip is moved back below the ownership check, this aborts.
    const cache = tempRoot("foreign-symlink");
    const nodeModules = join(cache, "_npx", "abc", "node_modules");
    mkdirSync(nodeModules, { recursive: true });
    const linkPath = join(nodeModules, "pkg");
    symlinkSync(join(tempRoot("foreign-symlink-target"), "nowhere"), linkPath, "dir");

    const ours = process.getuid?.() ?? 0;
    expect(inspectNpmCacheDirectory(cache, {
      expectedUid: ours,
      uidOf: path => (path === linkPath ? ours + 1 : ours),
    })).toEqual({ ok: true, reason: "cache_accessible" });

    // A foreign-owned REAL directory is still a hard stop — the skip is for links only.
    expect(inspectNpmCacheDirectory(cache, {
      expectedUid: ours,
      uidOf: path => (path === nodeModules ? ours + 1 : ours),
    })).toEqual({ ok: false, reason: "cache_entry_foreign_owner" });
  });

  // Unix mode semantics: a Windows directory reports 0o666 with no execute bit, so the
  // owner-rwx accessibility check can never pass there. Production runs only the cache-root
  // check on Windows (the worker's --root-only mode), so this proves nothing there.
  test.skipIf(process.platform === "win32")("an inspection budget that runs out lets the update proceed", () => {
    // A mature npm cache legitimately holds hundreds of thousands of entries. "We ran out of
    // budget looking" is not evidence of a broken cache, and treating it as failure locked
    // ordinary users out of updating entirely.
    const cache = tempRoot("budget");
    const deep = join(cache, "_cacache", "content-v2", "sha512");
    mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 8; i += 1) writeFileSync(join(deep, `entry-${i}`), "cached");

    expect(inspectNpmCacheDirectory(cache, { maxEntries: 2 })).toEqual({
      ok: true,
      reason: "inspection_incomplete",
    });
    expect(inspectNpmCacheDirectory(cache, { maxDepth: 1 })).toEqual({
      ok: true,
      reason: "inspection_incomplete",
    });

    // A deadline that has already passed is the same class of answer, not a failure.
    let clock = 0;
    expect(inspectNpmCacheDirectory(cache, { nowMs: () => (clock += 10_000), timeoutMs: 1 })).toEqual({
      ok: true,
      reason: "inspection_incomplete",
    });
  });

  test("the worker protocol accepts an incomplete-but-clean inspection", () => {
    // The gap that made the budget fix inert: `inspectNpmCacheDirectory` returned ok:true with
    // `inspection_incomplete`, and the protocol parser then rejected it because it only accepted
    // `cache_accessible` alongside ok:true. Every large cache still failed — as
    // `worker_output_malformed`, which hid the real cause. Assert the wire contract directly.
    const emit = (payload: Record<string, unknown>) => (() => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify(payload),
      stderr: "",
    })) as never;

    expect(runNpmCachePreflight({
      platform: "linux",
      spawnSyncFn: emit({ protocol: 1, ok: true, reason: "inspection_incomplete" }),
    })).toEqual({ ok: true, reason: "inspection_incomplete" });

    // The cross-check still holds in both directions: a reason cannot lie about its flag.
    expect(runNpmCachePreflight({
      platform: "linux",
      spawnSyncFn: emit({ protocol: 1, ok: false, reason: "inspection_incomplete" }),
    })).toEqual({ ok: false, reason: "worker_output_malformed" });
    expect(runNpmCachePreflight({
      platform: "linux",
      spawnSyncFn: emit({ protocol: 1, ok: true, reason: "cache_entry_foreign_owner" }),
    })).toEqual({ ok: false, reason: "worker_output_malformed" });
  });

  test.skipIf(WINDOWS || !canSymlink)("a cache root symlinked to another volume is inspected, not rejected", () => {
    // Pointing ~/.npm at another volume is ordinary npm configuration. Rejecting it outright was
    // the same class of false positive as failing on a large cache: it blocks updates for users
    // whose setup is fine. The root is resolved once; nested links are still never followed.
    const realCache = tempRoot("symlinked-root-target");
    mkdirSync(join(realCache, "_cacache", "content-v2"), { recursive: true });
    writeFileSync(join(realCache, "_cacache", "content-v2", "entry"), "cached");

    const linkHome = tempRoot("symlinked-root-home");
    const linkedRoot = join(linkHome, ".npm");
    symlinkSync(realCache, linkedRoot, "dir");

    expect(inspectNpmCacheDirectory(linkedRoot)).toEqual({ ok: true, reason: "cache_accessible" });

    // An unresolvable root is still a hard stop.
    expect(inspectNpmCacheDirectory(linkedRoot, {
      realpathFn: () => { throw new Error("ELOOP"); },
    })).toEqual({ ok: false, reason: "cache_entry_inaccessible" });
  });

  test("fails closed on worker timeout", () => {
    const timeoutSpawn = (() => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "" })) as never;
    expect(runNpmCachePreflight({ platform: "linux", spawnSyncFn: timeoutSpawn })).toEqual({
      ok: false,
      reason: "worker_timeout",
    });
  });

  test("fails closed on malformed worker output", () => {
    const malformedSpawn = (() => ({ status: 0, signal: null, stdout: "worker says /Users/Private Name/.npm is broken", stderr: "" })) as never;
    expect(runNpmCachePreflight({ platform: "linux", spawnSyncFn: malformedSpawn })).toEqual({
      ok: false,
      reason: "worker_output_malformed",
    });

    const contradictorySpawn = (() => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify({ protocol: 1, ok: true, reason: "cache_entry_foreign_owner" }),
      stderr: "",
    })) as never;
    expect(runNpmCachePreflight({ platform: "linux", spawnSyncFn: contradictorySpawn })).toEqual({
      ok: false,
      reason: "worker_output_malformed",
    });
  });

  // Spawns the real npm to read its configured cache path while claiming a non-Windows
  // platform. On Windows that is both slow and meaningless: production takes the
  // windows_skip branch, covered by the case below.
  test.skipIf(process.platform === "win32")("runs the real worker protocol against npm's configured cache path", () => {
    const cache = tempRoot("worker-round-trip");
    mkdirSync(join(cache, "_cacache"));

    expect(runNpmCachePreflight({
      platform: process.platform === "win32" ? "linux" : process.platform,
      env: { ...process.env, npm_config_cache: cache },
    })).toEqual({ ok: true, reason: "cache_accessible" });
  });

  test("Windows runs the root-only worker against the resolved cache instead of skipping (#6288)", () => {
    let workerArgs: string[] = [];
    const spawn = ((_file: string, args: string[]) => {
      workerArgs = args;
      return { status: 0, signal: null, stdout: JSON.stringify({ protocol: 1, ok: false, reason: "cache_root_dangling_link" }), stderr: "" };
    }) as never;

    expect(runNpmCachePreflight({ platform: "win32", cachePath: "C:\\cache\\npm-cache", spawnSyncFn: spawn })).toEqual({
      ok: false,
      reason: "cache_root_dangling_link",
    });
    expect(workerArgs.slice(1)).toEqual(["--ocx-npm-cache-preflight-worker", "--root-only", "C:\\cache\\npm-cache"]);
  });
});

describe("npm cache root usability (#6288)", () => {
  const runWorker = (cachePath: string) => runNpmCachePreflight({ platform: "win32", cachePath });

  test("a usable or not-yet-created cache root passes", () => {
    const parent = tempRoot("root-usable");
    mkdirSync(join(parent, "npm-cache"));
    expect(inspectNpmCacheRoot(join(parent, "npm-cache"))).toEqual({ ok: true, reason: "cache_accessible" });
    // npm creates a missing root itself; only what it would mkdir under has to be a directory.
    expect(inspectNpmCacheRoot(join(parent, "missing", "npm-cache"))).toEqual({ ok: true, reason: "cache_accessible" });
  });

  test("a file where the root or one of its parents should be is classified, on every platform", () => {
    const parent = tempRoot("root-file");
    const fileRoot = join(parent, "npm-cache");
    writeFileSync(fileRoot, "not a directory");
    const notDirectory = { ok: false, reason: "cache_root_not_directory" };
    expect(inspectNpmCacheRoot(fileRoot)).toEqual(notDirectory);
    expect(inspectNpmCacheRoot(join(fileRoot, "nested", "cache"))).toEqual(notDirectory);
    // The POSIX deep inspection used to walk past a file root and report it accessible.
    expect(inspectNpmCacheDirectory(fileRoot)).toEqual(notDirectory);
    // Same answer through the real worker in its Windows (root-only) mode.
    expect(runWorker(fileRoot)).toEqual(notDirectory);
  });

  test("a junction-shaped root whose target is gone is a dangling link, not a generic failure", () => {
    // Simulates the reported Windows shape: lstat sees a reparse point, following it fails.
    const junction = { isSymbolicLink: () => true, isDirectory: () => false };
    const missing = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
    expect(inspectNpmCacheRoot("/synthetic/npm-cache", { lstatFn: () => junction, statFn: missing })).toEqual({
      ok: false,
      reason: "cache_root_dangling_link",
    });
    // A relocated root whose target exists is ordinary configuration.
    const directory = { isSymbolicLink: () => false, isDirectory: () => true };
    expect(inspectNpmCacheRoot("/synthetic/npm-cache", { lstatFn: () => junction, statFn: () => directory })).toEqual({
      ok: true,
      reason: "cache_accessible",
    });
  });

  test.skipIf(!canSymlink)("a real dangling link root fails before the proxy stop, through the worker", () => {
    const home = tempRoot("root-dangling");
    const target = join(tempRoot("root-dangling-target"), "npm-cache");
    mkdirSync(target);
    const link = join(home, "npm-cache");
    symlinkSync(target, link, WINDOWS ? "junction" : "dir");
    expect(runWorker(link)).toEqual({ ok: true, reason: "cache_accessible" });

    rmSync(target, { recursive: true });
    expect(inspectNpmCacheRoot(link)).toEqual({ ok: false, reason: "cache_root_dangling_link" });
    expect(runWorker(link)).toEqual({ ok: false, reason: "cache_root_dangling_link" });
  });

  test.skipIf(!WINDOWS)("Windows: a real directory junction to a removed target is detected", () => {
    // Junctions need no symlink privilege, so this runs on every Windows host.
    const home = tempRoot("junction-home");
    const target = join(tempRoot("junction-target"), "npm-cache");
    mkdirSync(target);
    const junction = join(home, "npm-cache");
    symlinkSync(target, junction, "junction");
    expect(runNpmCachePreflight({ cachePath: junction })).toEqual({ ok: true, reason: "cache_accessible" });
    rmSync(target, { recursive: true });
    expect(runNpmCachePreflight({ cachePath: junction })).toEqual({ ok: false, reason: "cache_root_dangling_link" });
  });

  test("the worker refuses a supplied cache path that is not absolute", () => {
    expect(runNpmCachePreflight({ platform: "linux", cachePath: "relative/npm-cache" }))
      .toEqual({ ok: false, reason: "cache_path_malformed" });
  });

  test("Windows keeps the pre-#6288 skip for inconclusive results and blocks only a broken root", () => {
    const emit = (status: number | null, payload?: Record<string, unknown>) => (() => ({
      status, signal: null, stdout: payload ? JSON.stringify(payload) : "", stderr: "",
    })) as never;
    const skip = { ok: true, reason: "windows_skip" };
    expect(runNpmCachePreflight({ platform: "win32", spawnSyncFn: emit(null) })).toEqual(skip);
    expect(runNpmCachePreflight({ platform: "win32", spawnSyncFn: emit(1) })).toEqual(skip);
    for (const reason of ["npm_config_failed", "npm_unavailable", "cache_entry_inaccessible"]) {
      expect(runNpmCachePreflight({ platform: "win32", spawnSyncFn: emit(0, { protocol: 1, ok: false, reason }) })).toEqual(skip);
    }
    for (const reason of ["cache_root_dangling_link", "cache_root_not_directory"]) {
      expect(runNpmCachePreflight({ platform: "win32", spawnSyncFn: emit(0, { protocol: 1, ok: false, reason }) }))
        .toEqual({ ok: false, reason });
    }
    // POSIX still fails closed on the same inconclusive results.
    expect(runNpmCachePreflight({ platform: "linux", spawnSyncFn: emit(null) })).toEqual({ ok: false, reason: "worker_timeout" });
  });

  test("resolveNpmCachePath returns npm's configured cache with the caller's environment", () => {
    const invocation = (args: string[]) => ({ file: "npm", args, options: {} });
    let seenEnv: NodeJS.ProcessEnv | undefined;
    let seenArgs: string[] = [];
    let seenCwd: string | undefined;
    const answer = (stdout: string, status = 0) => ((_file: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => {
      seenEnv = options.env;
      seenArgs = args;
      seenCwd = options.cwd;
      return { status, signal: null, stdout, stderr: "" };
    }) as never;
    const env = { FIXTURE_ENV: "1" };
    const configured = join(tmpdir(), "configured-npm-cache");

    expect(resolveNpmCachePath({ env, invocationFn: invocation, spawnSyncFn: answer(configured + "\n") })).toEqual({
      ok: true,
      path: configured,
    });
    expect(seenEnv).toBe(env);
    // Global mode from the home directory: a project .npmrc in the caller's cwd cannot pick the
    // cache that the global staging install is pinned to.
    expect(seenArgs).toEqual(["config", "get", "cache", "--global"]);
    expect(seenCwd).toBe(homedir());
    expect(resolveNpmCachePath({ invocationFn: invocation, spawnSyncFn: answer("", 1) })).toEqual({ ok: false, reason: "npm_config_failed" });
    expect(resolveNpmCachePath({ invocationFn: invocation, spawnSyncFn: answer("a\nb") })).toEqual({ ok: false, reason: "cache_path_malformed" });
    expect(resolveNpmCachePath({ invocationFn: () => null })).toEqual({ ok: false, reason: "npm_unavailable" });
  });

  test("Windows refuses to pin a cache path carrying cmd.exe metacharacters", () => {
    const invocation = (args: string[]) => ({ file: "npm", args, options: {} });
    const answer = (stdout: string) => (() => ({ status: 0, signal: null, stdout, stderr: "" })) as never;
    const absolute = join(tmpdir(), "npm-cache");
    for (const unsafe of ['" & calc & "', "%PATH%", "a!b", "a^b", "a|b", "a<b", "a>b"]) {
      expect(resolveNpmCachePath({ platform: "win32", invocationFn: invocation, spawnSyncFn: answer(absolute + unsafe) }))
        .toEqual({ ok: false, reason: "cache_path_malformed" });
    }
    expect(resolveNpmCachePath({ platform: "win32", invocationFn: invocation, spawnSyncFn: answer(absolute) }))
      .toEqual({ ok: true, path: absolute });
    // POSIX passes argv without a shell, so the same characters stay a literal path there.
    expect(resolveNpmCachePath({ platform: "linux", invocationFn: invocation, spawnSyncFn: answer(absolute + "&x") }))
      .toEqual({ ok: true, path: absolute + "&x" });
  });

  test("root failures carry fixed, path-free guidance", () => {
    const dangling = npmCachePreflightFailureMessage("cache_root_dangling_link");
    const notDirectory = npmCachePreflightFailureMessage("cache_root_not_directory");
    expect(dangling).toContain("target is missing");
    expect(notDirectory).toContain("ENOTDIR");
    for (const message of [dangling, notDirectory]) {
      expect(message).toContain("npm config get cache");
      expect(message).not.toContain("ownership");
    }
  });
});
