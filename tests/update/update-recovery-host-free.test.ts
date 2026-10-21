import { describe, expect, test } from "bun:test";
import { isTestScopedWindowsAcl, isWindowsIcaclsBinary } from "../helpers/update-recovery-host-free";

const ROOT = "C:\\Windows";
const ICACLS = "C:\\Windows\\system32\\icacls.exe";
const HOME = "C:\\Users\\runner\\AppData\\Local\\Temp\\ocx-test-home";
const roots = [HOME, "D:\\a\\_temp"];

describe("update-recovery host-free helper: Windows ACL exemption", () => {
  test("matches only the exact System32 icacls binary", () => {
    expect(isWindowsIcaclsBinary(ICACLS, ROOT)).toBe(true);
    expect(isWindowsIcaclsBinary("c:/windows/SYSTEM32/ICACLS.EXE", ROOT)).toBe(true);
    expect(isWindowsIcaclsBinary("icacls.exe", ROOT)).toBe(false);
    expect(isWindowsIcaclsBinary("C:\\tools\\icacls.exe", ROOT)).toBe(false);
    expect(isWindowsIcaclsBinary("C:\\Windows\\System32\\icacls.exe.bak", ROOT)).toBe(false);
  });

  test("allows icacls only when every path argument is inside a test root", () => {
    const argv = [ICACLS, `${HOME}\\config.json`, "/inheritance:r", "/grant:r", "runner:F"];
    expect(isTestScopedWindowsAcl(ICACLS, argv, "win32", roots, ROOT)).toBe(true);
    expect(isTestScopedWindowsAcl(ICACLS, [ICACLS, "D:\\a\\_temp\\x"], "win32", roots, ROOT)).toBe(true);
  });

  test("refuses a target outside the test roots, including a mixed list", () => {
    expect(isTestScopedWindowsAcl(ICACLS, [ICACLS, "C:\\Users\\runner\\.opencodex\\auth.json"], "win32", roots, ROOT)).toBe(false);
    expect(isTestScopedWindowsAcl(ICACLS, [ICACLS, `${HOME}\\a`, "C:\\Windows\\b"], "win32", roots, ROOT)).toBe(false);
    expect(isTestScopedWindowsAcl(ICACLS, [ICACLS, `${HOME}-sibling\\a`], "win32", roots, ROOT)).toBe(false);
  });

  test("switches are not paths, and an argv without paths is refused", () => {
    expect(isTestScopedWindowsAcl(ICACLS, [ICACLS, "/grant:r", "/T", "/C"], "win32", roots, ROOT)).toBe(false);
  });

  test("never allows anything off Windows or for another binary", () => {
    expect(isTestScopedWindowsAcl(ICACLS, [ICACLS, `${HOME}\\a`], "linux", roots, ROOT)).toBe(false);
    expect(isTestScopedWindowsAcl(ICACLS, [ICACLS, `${HOME}\\a`], "darwin", roots, ROOT)).toBe(false);
    expect(isTestScopedWindowsAcl("C:\\Windows\\System32\\cmd.exe", ["cmd.exe", `${HOME}\\a`], "win32", roots, ROOT)).toBe(false);
  });

  test("accepts UNC targets under a UNC root, case-insensitively", () => {
    const unc = "\\\\host\\share\\home";
    expect(isTestScopedWindowsAcl(ICACLS, [ICACLS, "\\\\HOST\\Share\\home\\cfg"], "win32", [unc], ROOT)).toBe(true);
  });
});

