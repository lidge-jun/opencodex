import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import {
  createPackageTreeIntegrityGuard,
  createRuntimePackageTreeIntegrityGuard,
  type PackageTreeObservation,
} from "../src/lib/package-tree-integrity";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const TEST_DIR = join(import.meta.dir, ".tmp-package-tree-integrity");
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function config(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["gpt-test"],
      },
    },
  };
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-package-tree-integrity-");
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("package tree integrity", () => {
  test("source checkouts stay live when package.json changes during development", () => {
    let observation: PackageTreeObservation = {
      device: 1n,
      inode: 10n,
      contentTimeNs: 100n,
      size: 500n,
    };
    let clock = 0;
    const sourceGuard = createRuntimePackageTreeIntegrityGuard(
      "source",
      () => observation,
      () => clock,
    );
    const installedGuard = createPackageTreeIntegrityGuard(
      () => observation,
      () => clock,
    );

    expect(sourceGuard.status()).toEqual({ ok: true });
    expect(installedGuard.status()).toEqual({ ok: true });
    observation = { device: 1n, inode: 11n, contentTimeNs: 200n, size: 700n };
    clock += 2_000;
    expect(sourceGuard.status()).toEqual({ ok: true });
    expect(installedGuard.status()).toEqual({ ok: false, reason: "package_tree_replaced" });
  });

  test.each(["npm", "bun"] as const)("%s installs still refuse a replaced package tree", installer => {
    let observation: PackageTreeObservation = {
      device: 1n,
      inode: 10n,
      contentTimeNs: 100n,
      size: 500n,
    };
    let clock = 0;
    const guard = createRuntimePackageTreeIntegrityGuard(
      installer,
      () => observation,
      () => clock,
    );

    expect(guard.status()).toEqual({ ok: true });
    observation = { ...observation, inode: 11n, contentTimeNs: 200n };
    clock += 2_000;
    expect(guard.status()).toEqual({ ok: false, reason: "package_tree_replaced" });
  });

  test("detects replacement even when the package version and file size are unchanged", () => {
    let observation: PackageTreeObservation = {
      device: 1n,
      inode: 10n,
      contentTimeNs: 100n,
      size: 500n,
    };
    // An explicit clock: `status()` reuses an `ok` reading for a second so the guard does not
    // stat the manifest on every request, and two calls in the same millisecond would otherwise
    // never re-observe.
    let clock = 0;
    const guard = createPackageTreeIntegrityGuard(() => observation, () => clock);

    expect(guard.status()).toEqual({ ok: true });

    observation = { ...observation, inode: 11n, contentTimeNs: 200n };
    clock += 2_000;
    expect(guard.status()).toEqual({ ok: false, reason: "package_tree_replaced" });
  });

  test("an ok reading is reused briefly, and a bad one is never cached", () => {
    let observation: PackageTreeObservation | null = {
      device: 1n, inode: 10n, contentTimeNs: 100n, size: 500n,
    };
    let observations = 0;
    let clock = 0;
    const guard = createPackageTreeIntegrityGuard(
      () => { observations += 1; return observation; },
      () => clock,
    );

    // Hot path: repeated calls inside the window cost one observation, not one each.
    expect(guard.status()).toEqual({ ok: true });
    expect(guard.status()).toEqual({ ok: true });
    expect(guard.status()).toEqual({ ok: true });
    expect(observations).toBe(2); // one at construction, one for the first status()

    // A failure is re-observed every time, so a repaired install recovers on its own rather
    // than staying refused for the rest of a window.
    clock += 2_000;
    observation = null;
    expect(guard.status()).toEqual({ ok: false, reason: "package_tree_unreadable" });
    const afterFirstFailure = observations;
    expect(guard.status()).toEqual({ ok: false, reason: "package_tree_unreadable" });
    expect(observations).toBe(afterFirstFailure + 1);
  });

  test("fails closed when the package manifest disappears", () => {
    let observation: PackageTreeObservation | null = {
      device: 1n,
      inode: 10n,
      contentTimeNs: 100n,
      size: 500n,
    };
    const guard = createPackageTreeIntegrityGuard(() => observation);
    observation = null;

    expect(guard.status()).toEqual({ ok: false, reason: "package_tree_unreadable" });
  });

  // BUG-R1: a chmod fenced the whole data plane behind 503.
  //
  // These three drive the REAL filesystem rather than a hand-built observation,
  // because the defect lived in which stat field was read - a synthetic
  // PackageTreeObservation cannot tell ctime from mtime, so a fixture-only test
  // would have passed both before and after the fix.
  const manifest = () => join(TEST_DIR, "package.json");
  const observeAt = (path: string) => () => {
    const stat = statSync(path, { bigint: true });
    return {
      device: stat.dev,
      inode: stat.ino,
      contentTimeNs: stat.mtimeNs,
      size: stat.size,
    };
  };

  /**
   * Write the manifest and return once the filesystem reports a DIFFERENT mtime
   * than before.
   *
   * The same-length-rewrite case leaves device, inode, and size untouched on
   * purpose, so mtime is the only remaining signal -- that is the whole point of
   * the case. But mtime granularity is a filesystem property, not ours: two
   * back-to-back writes on Windows land inside one tick, the guard reads an
   * unchanged observation, and it reports `ok: true` for a genuine replacement.
   * That is the environment failing to distinguish the two writes, not the guard
   * failing to notice.
   *
   * Rewriting until the timestamp moves keeps the real-filesystem property the
   * comment above depends on -- a synthetic observation still could not tell
   * ctime from mtime -- while removing the dependency on tick size. It bounds the
   * wait so a filesystem with no mtime at all fails loudly instead of hanging.
   */
  const rewriteManifestWithDistinctMtime = (contents: string): void => {
    const before = statSync(manifest(), { bigint: true }).mtimeNs;
    const deadline = Date.now() + 5_000;
    for (;;) {
      writeFileSync(manifest(), contents);
      if (statSync(manifest(), { bigint: true }).mtimeNs !== before) return;
      if (Date.now() > deadline) {
        throw new Error("filesystem mtime did not advance within 5s; cannot test content-time detection");
      }
      Bun.sleepSync(5);
    }
  };

  test("a permission change is not a replacement", () => {
    writeFileSync(manifest(), '{"name":"ocx","version":"1.0.0"}');
    let clock = 0;
    const guard = createPackageTreeIntegrityGuard(observeAt(manifest()), () => clock);
    expect(guard.status()).toEqual({ ok: true });

    chmodSync(manifest(), 0o600);
    clock += 2_000;
    expect(guard.status()).toEqual({ ok: true });
  });

  test("an in-place rewrite of the same byte length is still a replacement", () => {
    writeFileSync(manifest(), '{"name":"ocx","version":"1.0.0"}');
    let clock = 0;
    const guard = createPackageTreeIntegrityGuard(observeAt(manifest()), () => clock);
    expect(guard.status()).toEqual({ ok: true });

    // Same length, different bytes: neither inode nor size moves, so mtime is the
    // only signal left. This is the case that would break if someone "simplified"
    // the comparison down to inode and size.
    rewriteManifestWithDistinctMtime('{"name":"ocx","version":"9.9.9"}');
    clock += 2_000;
    expect(guard.status()).toEqual({ ok: false, reason: "package_tree_replaced" });
  });

  test("an atomic install is still a replacement", () => {
    writeFileSync(manifest(), '{"name":"ocx","version":"1.0.0"}');
    let clock = 0;
    const guard = createPackageTreeIntegrityGuard(observeAt(manifest()), () => clock);
    expect(guard.status()).toEqual({ ok: true });

    // write-then-rename, which is what a package manager actually does.
    writeFileSync(join(TEST_DIR, "package.json.new"), '{"name":"ocx","version":"1.0.0"}');
    renameSync(join(TEST_DIR, "package.json.new"), manifest());
    clock += 2_000;
    expect(guard.status()).toEqual({ ok: false, reason: "package_tree_replaced" });
  });

  test("degrades health and refuses Responses requests with a restart-required error", async () => {
    saveConfig(config());
    const packageTreeIntegrity = {
      status: () => ({ ok: false as const, reason: "package_tree_replaced" as const }),
    };
    const server = startServer(0, { packageTreeIntegrity });
    try {
      const health = await fetch(new URL("/healthz", server.url));
      expect(health.status).toBe(503);
      expect(health.headers.get("retry-after")).toBe("5");
      expect(await health.json()).toMatchObject({
        status: "restart_required",
        service: "opencodex",
        error: { code: "package_tree_changed" },
      });

      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test/gpt-test", input: "hello" }),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.json()).toMatchObject({
        error: {
          type: "server_error",
          code: "package_tree_changed",
          message: expect.stringContaining("restart"),
        },
      });
    } finally {
      await server.stop(true);
    }
  });
});
