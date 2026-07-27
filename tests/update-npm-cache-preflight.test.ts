import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkNpmCacheOwnership,
  findForeignOwnedNpmCacheEntry,
  formatNpmCacheOwnershipFailure,
} from "../src/update/npm-cache-preflight.mjs";

let dir: string;
let extraPaths: string[];

beforeEach(() => {
  dir = join(tmpdir(), `ocx-npm-cache-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "_cacache", "index-v5"), { recursive: true });
  writeFileSync(join(dir, "_cacache", "index-v5", "entry"), "cache");
  extraPaths = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const path of extraPaths) rmSync(path, { recursive: true, force: true });
});

function cacheLookup(path: string): typeof import("node:child_process").spawnSync {
  return (() => ({
    status: 0,
    stdout: `${path}\n`,
    stderr: "",
    pid: 1,
    output: [],
    signal: null,
  })) as never;
}

describe("npm cache ownership pre-flight", () => {
  test("accepts a cache owned by the current uid", () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    expect(checkNpmCacheOwnership({
      getuid: () => uid,
      spawn: cacheLookup(dir),
    })).toEqual({ ok: true, cachePath: dir });
  });

  test("finds a foreign-owned nested entry before package replacement", () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const foreign = join(realpathSync(dir), "_cacache", "index-v5", "entry");
    const issue = findForeignOwnedNpmCacheEntry(dir, uid, {
      lstat: (path) => {
        const stat = lstatSync(path);
        return {
          uid: path === foreign ? uid + 1 : stat.uid,
          isDirectory: () => stat.isDirectory(),
        };
      },
      readdir: path => readdirSync(path, { encoding: "utf8" }),
    });
    expect(issue).toEqual({ kind: "foreign-owner", path: foreign, actualUid: uid + 1 });
  });

  test("follows a configured cache-root symlink but not nested symlinks", () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const cacheLink = `${dir}-link`;
    const outside = `${dir}-outside`;
    extraPaths.push(cacheLink, outside);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "foreign"), "outside");
    symlinkSync(dir, cacheLink, "dir");
    symlinkSync(outside, join(dir, "nested-link"), "dir");
    const foreign = join(realpathSync(dir), "_cacache", "index-v5", "entry");
    const outsideRoot = realpathSync(outside);
    let inspectedOutside = false;
    const issue = findForeignOwnedNpmCacheEntry(cacheLink, uid, {
      lstat: (path) => {
        if (path.startsWith(outsideRoot)) inspectedOutside = true;
        const stat = lstatSync(path);
        return {
          uid: path === foreign ? uid + 1 : stat.uid,
          isDirectory: () => stat.isDirectory(),
        };
      },
      readdir: path => readdirSync(path, { encoding: "utf8" }),
    });
    expect(issue).toEqual({ kind: "foreign-owner", path: foreign, actualUid: uid + 1 });
    expect(inspectedOutside).toBe(false);
  });

  test("returns an actionable failure without changing the cache", () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const result = checkNpmCacheOwnership({
      getuid: () => uid + 1,
      spawn: cacheLookup(dir),
    });
    expect(result).toMatchObject({
      ok: false,
      cachePath: dir,
      entryPath: realpathSync(dir),
      expectedUid: uid + 1,
      actualUid: uid,
      reason: "npm cache entry ownership does not match the current user",
    });
    if (result.ok !== false) throw new Error("expected ownership failure");
    expect(formatNpmCacheOwnershipFailure(result)).toContain("before stopping the proxy");
    expect(formatNpmCacheOwnershipFailure(result)).toContain("configure a user-owned npm cache");
  });

  test("formats cache failures without persisting arbitrary path segments or account ids", () => {
    const cachePath = join(homedir(), "customer-alice-cache");
    const entryPath = join(cachePath, "_npx", "node_modules", "@alice");
    const output = formatNpmCacheOwnershipFailure({
      ok: false,
      cachePath,
      entryPath,
      expectedUid: 502,
      actualUid: 0,
      reason: "npm cache entry ownership does not match the current user",
    });
    expect(output).toContain("npm config get cache");
    expect(output).not.toContain(homedir());
    expect(output).not.toContain("customer-alice-cache");
    expect(output).not.toContain("@alice");
    expect(output).not.toContain("_npx");
    expect(output).not.toContain("502");
    expect(output).not.toMatch(/\buid\b/i);
  });

  test("fails closed when the configured cache root does not exist", () => {
    const missing = `${dir}-missing`;
    const result = checkNpmCacheOwnership({
      platform: "linux",
      getuid: () => 501,
      spawn: cacheLookup(missing),
    });
    expect(result).toMatchObject({
      ok: false,
      cachePath: missing,
      entryPath: missing,
      reason: "npm cache root does not exist",
    });
  });

  test("fails closed when the cache exceeds the entry budget", () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const issue = findForeignOwnedNpmCacheEntry(dir, uid, { maxEntries: 2 });
    expect(issue).toMatchObject({
      kind: "error",
      reason: "npm cache inspection exceeded its 2-entry budget",
    });
  });

  test("fails closed when the cache exceeds the elapsed-time budget", () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    let now = 0;
    const issue = findForeignOwnedNpmCacheEntry(dir, uid, {
      maxDurationMs: 10,
      now: () => {
        now += 6;
        return now;
      },
    });
    expect(issue).toMatchObject({
      kind: "error",
      reason: "npm cache inspection exceeded its 10ms time budget",
    });
  });

  test("terminates a scan process that ignores SIGTERM at the wall-clock deadline", () => {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const blockingScan = join(dir, "blocking-scan.mjs");
    writeFileSync(
      blockingScan,
      "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 60_000);\n",
    );
    const startedAt = Date.now();
    const result = checkNpmCacheOwnership({
      getuid: () => uid,
      spawn: cacheLookup(dir),
      scanScript: blockingScan,
      maxDurationMs: 250,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result).toMatchObject({
      ok: false,
      reason: "npm cache inspection exceeded its 250ms time budget",
    });
  });

  test("fails closed before shutdown when npm cannot resolve its cache", () => {
    let inspected = false;
    const result = checkNpmCacheOwnership({
      platform: "linux",
      getuid: () => 501,
      spawn: (() => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
        pid: 1,
        output: [],
        signal: "SIGTERM",
      })) as never,
      lstat: () => {
        inspected = true;
        throw new Error("must not inspect without a resolved cache path");
      },
    });
    expect(result).toMatchObject({
      ok: false,
      expectedUid: 501,
      reason: "could not resolve the npm cache (ETIMEDOUT)",
    });
    expect(inspected).toBe(false);
    if (result.ok !== false) throw new Error("expected lookup failure");
    expect(formatNpmCacheOwnershipFailure(result)).toContain("before stopping the proxy");
  });

  test("skips uid checks on Windows without invoking npm", () => {
    let spawned = false;
    const result = checkNpmCacheOwnership({
      platform: "win32",
      spawn: (() => {
        spawned = true;
        throw new Error("must not spawn");
      }) as never,
    });
    expect(result.ok).toBe("skipped");
    expect(spawned).toBe(false);
  });
});
