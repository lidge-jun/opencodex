/**
 * #5624: a Windows update that fails mid-install must keep the previous install and service and say
 * what to do next, and whatever an attempt leaves behind must not get in the way of the next one.
 * The updater only ever deletes a staging directory it can prove it created.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  STALE_STAGE_MIN_AGE_MS,
  UPDATE_OWNER_MARKER,
  launcherUsableAfterNpmUpdate,
  transactionalNpmUpdate,
} from "../../src/update/transactional-install.mjs";
import { planStoppedRuntimeRecovery } from "../../src/update/runtime-ownership.mjs";
import { npmUpdateFailureGuidance } from "../../src/update/update-failure-guidance.mjs";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PKG = "@bitkyc08/opencodex";

function writeTree(packageDir: string, version: string): void {
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  mkdirSync(join(packageDir, "node_modules", "bun", "bin"), { recursive: true });
  mkdirSync(join(packageDir, "node_modules", "zod"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: PKG, version, dependencies: { bun: "1", zod: "1" } }));
  writeFileSync(join(packageDir, "bin", "ocx.mjs"), "#!/usr/bin/env node\n" + "x".repeat(2048));
  writeFileSync(join(packageDir, "node_modules", "bun", "package.json"), JSON.stringify({ name: "bun" }));
  writeFileSync(join(packageDir, "node_modules", "bun", "bin", "bun.exe"), Buffer.alloc(10 * 1024 * 1024 + 1024));
  writeFileSync(join(packageDir, "node_modules", "bun", "bin", "bunx.exe"), "bunx");
  writeFileSync(join(packageDir, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod" }));
}

function liveVersion(packageDir: string): string | undefined {
  try {
    return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/** npm stub: materializes a global-style staged tree, optionally failing after writing it. */
function stagingNpm(version: string, opts: { failAfterWrite?: boolean; failBeforeWrite?: boolean; truncate?: boolean } = {}) {
  return (args: string[]) => {
    if (opts.failBeforeWrite) return { status: 1 };
    const stageRoot = args[args.indexOf("--prefix") + 1]!;
    const staged = join(stageRoot, "lib", "node_modules", ...PKG.split("/"));
    writeTree(staged, version);
    if (opts.truncate) rmSync(join(staged, "bin", "ocx.mjs"));
    return { status: opts.failAfterWrite ? 1 : 0 };
  };
}

function codedError(code: string): Error {
  return Object.assign(new Error(code + ": injected"), { code });
}

/** A rename seam that fails (or corrupts) at the n-th rename and otherwise renames for real. */
function renameAt(n: number, effect: "throw" | "throw-after" | "corrupt-live", packageDir: string, code?: string) {
  let count = 0;
  return (from: string, to: string) => {
    count += 1;
    if (effect === "throw" && count === n) throw code ? codedError(code) : new Error("injected rename failure");
    if (effect === "throw-after" && count >= n) throw new Error("injected rename failure");
    renameSync(from, to);
    if (effect === "corrupt-live" && count === n) rmSync(join(packageDir, "bin", "ocx.mjs"));
  };
}

function stages(scopeDir: string): string[] {
  return readdirSync(scopeDir).filter(name => name.startsWith(".ocx-staging-")).sort();
}

/** What the launcher decides after a failed replacement, for a stopped service-managed CLI runtime. */
function recoveryFor(tx: Parameters<typeof launcherUsableAfterNpmUpdate>[0]) {
  return planStoppedRuntimeRecovery({
    stopAttempted: true,
    ownership: { owner: "cli", installId: "install-under-test", consentGeneration: 1 },
    sameOwner: true,
    liveness: "dead",
    serviceInstalled: true,
    launcherUsable: launcherUsableAfterNpmUpdate(tx),
    hadRuntimeState: true,
  });
}

describe("#5624 update failure at each step keeps the previous install and service", () => {
  let scopeDir: string;
  let packageDir: string;

  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "ocx-update-leftovers-"));
    packageDir = join(scopeDir, "opencodex");
    writeTree(packageDir, "1.0.0");
  });

  afterEach(() => {
    removeTreeWithRetry(scopeDir);
  });

  const failures: Array<{
    name: string;
    phase: string;
    run: (packageDir: string) => Parameters<typeof transactionalNpmUpdate>[0];
  }> = [
    {
      name: "staging directory cannot be created",
      phase: "stage",
      run: dir => ({
        packageDir: dir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
        runNpm: stagingNpm("2.0.0"),
        deps: { mkdir: () => { throw codedError("ENOTDIR"); } },
      }),
    },
    {
      name: "npm staging install fails after writing part of the tree",
      phase: "stage",
      run: dir => ({ packageDir: dir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest", runNpm: stagingNpm("2.0.0", { failAfterWrite: true }) }),
    },
    {
      name: "staged tree fails verification",
      phase: "verify",
      run: dir => ({ packageDir: dir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest", runNpm: stagingNpm("2.0.0", { truncate: true }) }),
    },
    {
      name: "live tree cannot be moved aside",
      phase: "swap-backup",
      run: dir => ({
        packageDir: dir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
        runNpm: stagingNpm("2.0.0"),
        deps: { rename: renameAt(1, "throw", dir, "EXDEV") },
      }),
    },
    {
      name: "staged tree cannot be placed",
      phase: "swap-live",
      run: dir => ({
        packageDir: dir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
        runNpm: stagingNpm("2.0.0"),
        deps: { rename: renameAt(2, "throw", dir) },
      }),
    },
    {
      name: "placed tree fails post-swap verification",
      phase: "post-verify",
      run: dir => ({
        packageDir: dir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
        runNpm: stagingNpm("2.0.0"),
        deps: { rename: renameAt(2, "corrupt-live", dir) },
      }),
    },
  ];

  for (const failure of failures) {
    test(`${failure.name}: previous version stays live, service is restored, next step is named`, () => {
      const tx = transactionalNpmUpdate(failure.run(packageDir));
      expect(tx.ok).toBe(false);
      expect(tx.phase).toBe(failure.phase);
      expect(liveVersion(packageDir)).toBe("1.0.0");
      // This attempt's stage is gone; nothing is left for the next update to trip over.
      expect(stages(scopeDir)).toEqual([]);
      expect(recoveryFor(tx)).toEqual({ action: "service", reason: "same-cli-owner" });

      const guidance = npmUpdateFailureGuidance({ ...tx, pkgName: PKG, version: "2.0.0", tag: "latest" });
      expect(guidance.previousVersionKept).toBe(true);
      const text = guidance.lines.join(" ");
      expect(text).toContain("'ocx update'");
      expect(text).toContain("'ocx stop'");
      expect(text).toContain(`npm install -g --allow-scripts=bun ${PKG}@2.0.0`);
    });
  }

  test("double fault: the launcher refuses automatic recovery and the next step names the recovery marker", () => {
    const tx = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0"),
      deps: { rename: renameAt(2, "throw-after", packageDir) },
    });
    expect(tx.phase).toBe("double-fault");
    expect(existsSync(join(scopeDir, ".ocx-recovery.json"))).toBe(true);
    expect(recoveryFor(tx)).toEqual({ action: "manual", reason: "launcher-unavailable" });
    const guidance = npmUpdateFailureGuidance({ ...tx, pkgName: PKG, version: "2.0.0", tag: "latest" });
    expect(guidance.previousVersionKept).toBe(false);
    expect(guidance.lines.join(" ")).toContain(".ocx-recovery.json");
  });
});

describe("#5624 leftovers from earlier update attempts", () => {
  let scopeDir: string;
  let packageDir: string;

  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "ocx-update-leftovers-"));
    packageDir = join(scopeDir, "opencodex");
    writeTree(packageDir, "1.0.0");
  });

  afterEach(() => {
    removeTreeWithRetry(scopeDir);
  });

  test("a stage held by a locked file stays owned, does not block, and is removed once it is stale", () => {
    let lockedStage: string | null = null;
    const lockingRm = (target: string, options: { recursive: true; force: true }) => {
      if (lockedStage && target.startsWith(lockedStage + "/") || lockedStage && target.startsWith(lockedStage + "\\")) {
        if (!target.endsWith(UPDATE_OWNER_MARKER)) throw codedError("EPERM");
      }
      rmSync(target, options);
    };
    const failing = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: (args: string[]) => {
        lockedStage = args[args.indexOf("--prefix") + 1]!;
        return stagingNpm("2.0.0", { failAfterWrite: true })(args);
      },
      deps: { rm: lockingRm },
    });
    expect(failing.phase).toBe("stage");
    expect(liveVersion(packageDir)).toBe("1.0.0");
    const [leftover] = stages(scopeDir);
    expect(leftover).toBeDefined();
    expect(existsSync(join(scopeDir, leftover!, UPDATE_OWNER_MARKER))).toBe(true);

    // Still locked and recent: the next update steps around it and succeeds.
    const lines: string[] = [];
    const next = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0"),
      log: line => lines.push(line),
      deps: { rm: lockingRm },
    });
    expect(next.ok).toBe(true);
    expect(liveVersion(packageDir)).toBe("2.0.0");
    expect(stages(scopeDir)).toEqual([leftover!]);

    // The lock is gone and the stage is past the in-flight floor: the next update removes it.
    lockedStage = null;
    const later = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "3.0.0", tag: "latest",
      runNpm: stagingNpm("3.0.0"),
      log: line => lines.push(line),
      deps: { now: () => Date.now() + STALE_STAGE_MIN_AGE_MS + 60_000 },
    });
    expect(later.ok).toBe(true);
    expect(liveVersion(packageDir)).toBe("3.0.0");
    expect(stages(scopeDir)).toEqual([]);
    expect(lines.some(line => line.includes("Removed a staging directory left by an earlier update"))).toBe(true);
  });

  test("anything the updater did not create is never deleted", () => {
    const outside = mkdtempSync(join(tmpdir(), "ocx-update-link-target-"));
    try {
      writeFileSync(join(outside, "keep.txt"), "keep");
      // An older updater's stage (no marker), npm's own rename-aside, another package's stage,
      // a link named like a stage, and the boot probe's backup.
      const legacy = join(scopeDir, ".ocx-staging-2026-01-01T00-00-00-000Z");
      mkdirSync(join(legacy, "node_modules"), { recursive: true });
      writeFileSync(join(legacy, "node_modules", "keep.txt"), "keep");
      const renameAside = join(scopeDir, ".opencodex-1a2b3c4d");
      writeTree(renameAside, "0.9.0");
      const foreign = join(scopeDir, ".ocx-staging-foreign");
      mkdirSync(foreign);
      writeFileSync(join(foreign, UPDATE_OWNER_MARKER), JSON.stringify({ schema: 1, kind: "staging", pkgName: "other-package", pid: 1, createdAt: 0 }));
      const link = join(scopeDir, ".ocx-staging-link");
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      const backup = join(scopeDir, ".ocx-backup-2020", "opencodex");
      writeTree(backup, "0.8.0");

      const lines: string[] = [];
      const tx = transactionalNpmUpdate({
        packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
        runNpm: stagingNpm("2.0.0"),
        log: line => lines.push(line),
        deps: { now: () => Date.now() + STALE_STAGE_MIN_AGE_MS * 10 },
      });
      expect(tx.ok).toBe(true);
      expect(existsSync(join(legacy, "node_modules", "keep.txt"))).toBe(true);
      expect(liveVersion(renameAside)).toBe("0.9.0");
      expect(existsSync(join(foreign, UPDATE_OWNER_MARKER))).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(join(outside, "keep.txt"))).toBe(true);
      expect(liveVersion(backup)).toBe("0.8.0");
      for (const path of [legacy, renameAside, foreign, link]) {
        expect(lines.some(line => line.startsWith("Not removing " + basename(path) + " "))).toBe(true);
        // Folder names only: a user-scoped prefix path carries the account name.
        expect(lines.some(line => line.includes(scopeDir))).toBe(false);
      }
    } finally {
      removeTreeWithRetry(outside);
    }
  });
});
