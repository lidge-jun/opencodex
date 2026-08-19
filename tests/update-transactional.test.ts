/**
 * #1942 / #1849: transactional update invariant — the live tree is always either
 * old-complete or new-complete, never a partial skeleton, across every injected fault.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootRestoreProbe,
  transactionalNpmUpdate,
  verifyInstallTree,
} from "../src/update/transactional-install.mjs";

const PKG = "@bitkyc08/opencodex";

function writeTree(packageDir: string, version: string): void {
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  mkdirSync(join(packageDir, "node_modules", "bun"), { recursive: true });
  mkdirSync(join(packageDir, "node_modules", "zod"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: PKG, version, dependencies: { bun: "1", zod: "1" },
  }));
  writeFileSync(join(packageDir, "bin", "ocx.mjs"), "#!/usr/bin/env node\n" + "x".repeat(2048));
  writeFileSync(join(packageDir, "node_modules", "bun", "package.json"), JSON.stringify({ name: "bun" }));
  // The manifest size-gates the real Bun binary (>= 10MB); give the fixture one.
  writeFileSync(join(packageDir, "node_modules", "bun", "bun.exe"), Buffer.alloc(10 * 1024 * 1024 + 1024));
  writeFileSync(join(packageDir, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod" }));
}

function liveVersion(packageDir: string): string | undefined {
  try {
    return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/** npm stub that materializes a GLOBAL-style staged tree (deps nested inside the package). */
function stagingNpm(version: string, opts: { fail?: boolean; truncate?: boolean } = {}) {
  return (args: string[]) => {
    if (opts.fail) return { status: 1 };
    const prefixIndex = args.indexOf("--prefix");
    const stageRoot = args[prefixIndex + 1]!;
    // Mirror npm -g layout on POSIX: <prefix>/lib/node_modules/<pkg>.
    const staged = join(stageRoot, "lib", "node_modules", ...PKG.split("/"));
    writeTree(staged, version);
    if (opts.truncate) rmSync(join(staged, "bin", "ocx.mjs"));
    return { status: 0 };
  };
}

describe("#1942 transactional update", () => {
  let scopeDir: string;
  let packageDir: string;

  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "ocx-tx-update-"));
    packageDir = join(scopeDir, "opencodex");
    writeTree(packageDir, "1.0.0");
  });

  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  test("manifest verifies a complete tree and rejects a truncated one", () => {
    expect(verifyInstallTree(packageDir, "1.0.0").ok).toBe(true);
    expect(verifyInstallTree(packageDir, "9.9.9").ok).toBe(false);
    rmSync(join(packageDir, "bin", "ocx.mjs"));
    expect(verifyInstallTree(packageDir).ok).toBe(false);
  });

  test("happy path swaps and keeps a backup; stage scaffolding is gone", () => {
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0"),
    });
    expect(result.ok).toBe(true);
    expect(liveVersion(packageDir)).toBe("2.0.0");
    expect(existsSync(result.backup!)).toBe(true);
    expect(liveVersion(result.backup!)).toBe("1.0.0");
  });

  test("stage install failure leaves live untouched (D4 row 1)", () => {
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0", { fail: true }),
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("stage");
    expect(liveVersion(packageDir)).toBe("1.0.0");
  });

  test("verification failure leaves live untouched (D4 row 2)", () => {
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0", { truncate: true }),
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("verify");
    expect(liveVersion(packageDir)).toBe("1.0.0");
  });

  test("wrong staged version is refused before any swap", () => {
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("3.0.0"),
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("verify");
    expect(liveVersion(packageDir)).toBe("1.0.0");
  });

  test("swap-live failure rolls back to the old tree (D4 locked-file row)", () => {
    let renames = 0;
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0"),
      deps: {
        rename: (from: string, to: string) => {
          renames += 1;
          if (renames === 2) throw new Error("EBUSY: locked");
          const { renameSync } = require("node:fs");
          renameSync(from, to);
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("swap-live");
    expect(result.rolledBack).toBe(true);
    expect(liveVersion(packageDir)).toBe("1.0.0");
  });

  test("double fault writes the recovery marker with a one-line restore (D4 last row)", () => {
    let renames = 0;
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0"),
      deps: {
        rename: (from: string, to: string) => {
          renames += 1;
          if (renames >= 2) throw new Error("EPERM: still locked");
          const { renameSync } = require("node:fs");
          renameSync(from, to);
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("double-fault");
    const marker = JSON.parse(readFileSync(join(scopeDir, ".ocx-recovery.json"), "utf8"));
    expect(marker.restore).toContain("opencodex");
  });

  test("boot probe restores the backup over a broken live tree (D4 power-loss rows)", () => {
    // Simulate: swap moved live aside, then power loss before stage landed.
    const backupRoot = join(scopeDir, ".ocx-backup-2026");
    mkdirSync(backupRoot, { recursive: true });
    const { renameSync } = require("node:fs");
    renameSync(packageDir, join(backupRoot, "opencodex"));
    expect(existsSync(packageDir)).toBe(false);
    const probe = bootRestoreProbe(packageDir);
    expect(probe.action).toBe("restored");
    expect(liveVersion(packageDir)).toBe("1.0.0");
  });

  test("boot probe reaps stale backups when live is healthy", () => {
    const backupRoot = join(scopeDir, ".ocx-backup-2026");
    mkdirSync(join(backupRoot, "opencodex"), { recursive: true });
    writeFileSync(join(backupRoot, "opencodex", "package.json"), JSON.stringify({ version: "0.9.0" }));
    const probe = bootRestoreProbe(packageDir);
    expect(probe.action).toBe("reaped");
    expect(existsSync(backupRoot)).toBe(false);
  });
});
