import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownImageMover } from "../../src/desktop-update/image";
import { createStagingDirectory, PROTECTED_STAGING_SDDL, type StagingDirectoryDeps } from "../../src/desktop-update/staging";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function installation() {
  const dir = mkdtempSync(join(tmpdir(), "ocx-desktop-image-"));
  dirs.push(dir);
  const install = { dir, ocxExe: join(dir, "ocx.exe"), desktopExe: join(dir, "opencodex-desktop.exe") };
  writeFileSync(install.ocxExe, "old image");
  const scheduled: string[] = [];
  const mover = ownImageMover(install, { execPath: install.ocxExe, pid: 42, now: () => 1, join, deleteAtReboot: path => { scheduled.push(path); } });
  return { install, mover, scheduled };
}

describe("the updater's own running image", () => {
  test("the installed path still holds an ocx.exe while msiexec runs, so an interrupted command loses nothing", () => {
    const { install, mover } = installation();
    const moved = mover.moveAsideOwnImage();
    expect(moved).toBe(join(install.dir, "ocx.exe.42-1.update-old"));
    // The command is killed here (Ctrl+C, closed console, dropped SSH session): nothing restores.
    expect(readFileSync(install.ocxExe, "utf8")).toBe("old image");
    expect(readFileSync(moved!, "utf8")).toBe("old image");
    expect(readdirSync(install.dir).sort()).toEqual(["ocx.exe", "ocx.exe.42-1.update-old"]);
  });

  test("a failed copy moves nothing and leaves no partial file", () => {
    const { install, mover } = installation();
    writeFileSync(join(install.dir, "ocx.exe.42-1.update-new"), "planted");
    expect(() => mover.moveAsideOwnImage()).toThrow();
    expect(readFileSync(install.ocxExe, "utf8")).toBe("old image");
    expect(existsSync(join(install.dir, "ocx.exe.42-1.update-old"))).toBe(false);
  });

  test("an install that replaced ocx.exe is never overwritten by the restore, and leftovers are retired", () => {
    const { install, mover, scheduled } = installation();
    const moved = mover.moveAsideOwnImage()!;
    writeFileSync(install.ocxExe, "new image");
    expect(mover.restoreOwnImage(moved)).toBe(true);
    expect(readFileSync(install.ocxExe, "utf8")).toBe("new image");
    writeFileSync(join(install.dir, "ocx.exe.7-3.update-old"), "older run");
    writeFileSync(join(install.dir, "ocx.exe.7-3.update-new"), "interrupted copy");
    mover.retireMovedImages(moved);
    expect(readdirSync(install.dir).sort()).toEqual(["ocx.exe", "ocx.exe.42-1.update-old"]);
    expect(scheduled).toEqual([moved]);
  });

  test("a process that is not running the installed image moves nothing", () => {
    const { install } = installation();
    const mover = ownImageMover(install, { execPath: join(install.dir, "bun.exe"), join });
    expect(mover.moveAsideOwnImage()).toBeNull();
    expect(readdirSync(install.dir)).toEqual(["ocx.exe"]);
  });
});

describe("where the verified MSI is staged", () => {
  function staging(elevated: boolean | Error, failCreate = false) {
    const calls: string[] = [];
    const deps: StagingDirectoryDeps = {
      elevated: () => { if (elevated instanceof Error) throw elevated; return elevated; },
      windowsDirectory: () => "C:\\Windows",
      createProtectedDirectory: (path, sddl) => {
        calls.push(`protected ${path} ${sddl}`);
        if (failCreate) throw new Error("ERROR_ALREADY_EXISTS");
      },
      createPrivateTempDirectory: () => { calls.push("temp"); return "C:\\Users\\u\\AppData\\Local\\Temp\\ocx-desktop-update-x"; },
      randomSuffix: () => "0123abcd",
    };
    return { calls, deps };
  }

  test("an elevated command stages outside the user's TEMP, in a directory only SYSTEM and Administrators can change", () => {
    const { calls, deps } = staging(true);
    expect(createStagingDirectory(deps)).toBe("C:\\Windows\\Temp\\ocx-desktop-update-0123abcd");
    expect(calls).toEqual([`protected C:\\Windows\\Temp\\ocx-desktop-update-0123abcd ${PROTECTED_STAGING_SDDL}`]);
  });

  test("an elevation probe that fails is treated as elevated, and a directory that cannot be created fails closed", () => {
    const probe = staging(new Error("advapi32 unavailable"));
    createStagingDirectory(probe.deps);
    expect(probe.calls).toEqual([`protected C:\\Windows\\Temp\\ocx-desktop-update-0123abcd ${PROTECTED_STAGING_SDDL}`]);
    const taken = staging(true, true);
    expect(() => createStagingDirectory(taken.deps)).toThrow("ERROR_ALREADY_EXISTS");
    expect(taken.calls.includes("temp")).toBe(false);
  });

  test("a command that is not elevated stages in its own TEMP, where only same-rights processes could reach the file", () => {
    const { calls, deps } = staging(false);
    expect(createStagingDirectory(deps)).toBe("C:\\Users\\u\\AppData\\Local\\Temp\\ocx-desktop-update-x");
    expect(calls).toEqual(["temp"]);
  });

  test("the staging descriptor ignores inherited entries and lets only SYSTEM and Administrators write", () => {
    const match = /^D:P((?:\([^)]*\))+)$/.exec(PROTECTED_STAGING_SDDL);
    expect(match).not.toBeNull();
    const aces = [...match![1]!.matchAll(/\(([^)]*)\)/g)].map(ace => ace[1]!.split(";"));
    for (const [type, , rights, , , trustee] of aces) {
      expect(type).toBe("A");
      if (trustee === "OW") expect(rights).toBe("RC");
      else { expect(["SY", "BA"]).toContain(trustee); expect(rights).toBe("FA"); }
    }
    expect(aces.map(ace => ace[5]).sort()).toEqual(["BA", "OW", "SY"]);
  });
});

