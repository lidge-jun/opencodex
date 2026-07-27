import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkNpmCacheOwnership,
  findForeignOwnedNpmCacheEntry,
  formatNpmCacheOwnershipFailure,
} from "../src/update/npm-cache-preflight.mjs";

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `ocx-npm-cache-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "_cacache", "index-v5"), { recursive: true });
  writeFileSync(join(dir, "_cacache", "index-v5", "entry"), "cache");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
    const foreign = join(dir, "_cacache", "index-v5", "entry");
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
      entryPath: dir,
      expectedUid: uid + 1,
      actualUid: uid,
    });
    if (result.ok !== false) throw new Error("expected ownership failure");
    expect(formatNpmCacheOwnershipFailure(result)).toContain("before stopping the proxy");
    expect(formatNpmCacheOwnershipFailure(result)).toContain("configure a user-owned npm cache");
  });

  test("fails closed before shutdown when npm cannot resolve its cache", () => {
    let inspected = false;
    const result = checkNpmCacheOwnership({
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
