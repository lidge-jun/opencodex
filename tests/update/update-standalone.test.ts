import { describe, expect, mock, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { repoPath } from "../helpers/repo-root";
import { createRuntimePackageTreeIntegrityGuard } from "../../src/lib/package-tree-integrity";
import { createRefreshScheduler, type RefreshDeps } from "../../src/update/refresh-scheduler";
import { latestVersionAsync } from "../../src/update/async-check";
import { detectInstall, detectInstallOwnership, latestVersion, updateCommand } from "../../src/update/index";
import { checkForUpdate } from "../../src/update/job";

const windowsModuleUrls = [
  "file:///C:/~BUN/root/src/update/index.ts",
  "file:///C:/%7EBUN/root/src/update/index.ts",
];

describe("standalone update checks", () => {
  test.each(windowsModuleUrls)("Windows MSI compiled module %s is not a source checkout", moduleUrl => {
    const ownership = detectInstallOwnership(moduleUrl);
    expect(ownership).toEqual({ installer: "standalone" });
    expect(detectInstall(moduleUrl)).toBe("standalone");
    const latestVersion = mock(() => "2.85.0");
    const result = checkForUpdate("latest", {
      currentVersion: () => "2.84.0",
      detectInstall: () => detectInstall(moduleUrl),
      detectInstallOwnership: () => ownership,
      latestVersion,
    });
    expect(result).toMatchObject({
      installer: "standalone", canUpdate: false, updateAvailable: false,
      latestVersion: null, reason: "standalone_install",
    });
    expect(result.command).toContain("OpenCodex Desktop");
    expect(result.command).toContain("Check for Updates");
    expect(result.command).not.toContain("git pull");
    expect(latestVersion).not.toHaveBeenCalled();
  });

  test("standalone checks never launch package registry probes or refresh timers", async () => {
    const lookup = mock(async () => "2.85.0");
    const timer = mock(() => { throw new Error("standalone refresh must not schedule a timer"); });
    const deps: RefreshDeps = {
      current: () => "2.84.0", install: () => "standalone",
      ownership: () => ({ installer: "standalone" }), guidance: () => null,
      lookup, now: Date.now, disabled: () => false,
      read: () => null, write: () => { throw new Error("must not write package cache"); },
      setTimer: timer as typeof setTimeout, clearTimer: clearTimeout,
    };
    const scheduler = createRefreshScheduler(deps);
    scheduler.start();
    try {
      expect(await scheduler.check("latest")).toMatchObject({
        installer: "standalone", canUpdate: false, reason: "standalone_install",
      });
      expect(lookup).not.toHaveBeenCalled();
      expect(timer).not.toHaveBeenCalled();
      const spawnFn = mock(() => { throw new Error("must not launch a package manager"); });
      expect(latestVersion("latest", "standalone", undefined, spawnFn as never)).toBeNull();
      expect(await latestVersionAsync("latest", "standalone", {
        ownerFn: async () => null, spawnFn: spawnFn as never,
      })).toBeNull();
      expect(spawnFn).not.toHaveBeenCalled();
      expect(() => updateCommand("standalone", "latest")).toThrow("OpenCodex Desktop");
    } finally { scheduler.stop(); }
  });

  test("standalone installs retain the disabled package-tree guard", () => {
    const observe = mock(() => { throw new Error("standalone has no package tree"); });
    const guard = createRuntimePackageTreeIntegrityGuard("standalone", observe);
    expect(guard.status()).toEqual({ ok: true });
    expect(observe).not.toHaveBeenCalled();
    guard.dispose();
  });

  test("POSIX compiled binary is standalone too", () => {
    expect(detectInstallOwnership("file:///$bunfs/root/src/update/index.ts"))
      .toEqual({ installer: "standalone" });
  });

  test("real source checkout keeps source guidance", () => {
    const moduleUrl = pathToFileURL(repoPath("src/update/index.ts")).href;
    expect(detectInstallOwnership(moduleUrl)).toEqual({ installer: "source" });
    const result = checkForUpdate("latest", {
      currentVersion: () => "2.84.0",
      detectInstall: () => detectInstall(moduleUrl),
      detectInstallOwnership: () => detectInstallOwnership(moduleUrl),
      latestVersion: () => { throw new Error("source checks must not query the registry"); },
    });
    expect(result).toMatchObject({ installer: "source", canUpdate: false, reason: "source_checkout" });
    expect(result.command).toBe("git pull && bun install && bun run build:gui");
  });
});
