import { describe, expect, test } from "bun:test";
import { isTestScopedWindowsAcl, isWindowsIcaclsBinary } from "../helpers/update-recovery-host-free";

const ROOT = "C:\\Windows";
const ICACLS = "C:\\Windows\\system32\\icacls.exe";
const HOME = "C:\\Users\\runner\\AppData\\Local\\Temp\\ocx-test-home";
const roots = [HOME, "D:\\a\\_temp"];
const SID = "*S-1-5-21-1111-2222-3333-1001";
const target = `${HOME}\\config.json`;
const allowed = (argv: string[], command = ICACLS) => isTestScopedWindowsAcl(command, [command, ...argv], "win32", roots, ROOT);

describe("update-recovery host-free helper: Windows ACL exemption", () => {
  test("matches only the exact System32 icacls binary", () => {
    expect(isWindowsIcaclsBinary(ICACLS, ROOT)).toBe(true);
    expect(isWindowsIcaclsBinary("c:/windows/SYSTEM32/ICACLS.EXE", ROOT)).toBe(true);
    expect(isWindowsIcaclsBinary("icacls.exe", ROOT)).toBe(false);
    expect(isWindowsIcaclsBinary("C:\\tools\\icacls.exe", ROOT)).toBe(false);
    expect(isWindowsIcaclsBinary("C:\\Windows\\System32\\icacls.exe.bak", ROOT)).toBe(false);
  });

  test("allows every argv shape the production ACL belt builds (src/lib/windows-secret-acl.ts)", () => {
    expect(allowed([target])).toBe(true);
    expect(allowed([target, "/grant:r", `${SID}:(F)`])).toBe(true);
    expect(allowed([HOME, "/grant:r", `${SID}:(OI)(CI)(F)`, "*S-1-5-18:(R)"])).toBe(true);
    expect(allowed([target, "/inheritance:r"])).toBe(true);
    expect(allowed([target, "/remove:g", "*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"])).toBe(true);
    expect(allowed([target, "/findsid", "*S-1-1-0"])).toBe(true);
    expect(allowed(["D:\\a\\_temp\\x"])).toBe(true);
  });

  test("canonicalizes the target, so traversal out of a root is refused", () => {
    expect(allowed([`${HOME}\\..\\victim`, "/inheritance:r"])).toBe(false);
    expect(allowed(["D:\\a\\_temp\\..\\..\\x"])).toBe(false);
    expect(allowed([`${HOME}\\sub\\..\\config.json`])).toBe(true);
    expect(allowed([`${HOME}-sibling\\a`])).toBe(false);
    expect(allowed(["C:\\Users\\runner\\.opencodex\\auth.json"])).toBe(false);
  });

  test("refuses switches and operands the ACL belt never passes", () => {
    expect(allowed([HOME, "/save", "aclfile"])).toBe(false);
    expect(allowed([HOME, "/restore", "aclfile"])).toBe(false);
    expect(allowed([target, "/setowner", SID])).toBe(false);
    expect(allowed([target, "/grant:r", `${SID}:(F)`, "/T"])).toBe(false);
    expect(allowed([target, "/grant:r", "relative\\file"])).toBe(false);
    expect(allowed([target, `${HOME}\\second.json`])).toBe(false);
    expect(allowed([target, "/grant:r", `${HOME}\\x`])).toBe(false);
    expect(allowed(["relative\\config.json"])).toBe(false);
    expect(allowed(["/grant:r", target])).toBe(false);
    expect(allowed([])).toBe(false);
  });

  test("never allows anything off Windows or for another binary", () => {
    expect(isTestScopedWindowsAcl(ICACLS, [ICACLS, target], "linux", roots, ROOT)).toBe(false);
    expect(isTestScopedWindowsAcl(ICACLS, [ICACLS, target], "darwin", roots, ROOT)).toBe(false);
    expect(allowed([target], "C:\\Windows\\System32\\cmd.exe")).toBe(false);
  });

  test("accepts UNC targets under a UNC root, case-insensitively", () => {
    const unc = "\\\\host\\share\\home";
    expect(isTestScopedWindowsAcl(ICACLS, [ICACLS, "\\\\HOST\\Share\\home\\cfg"], "win32", [unc], ROOT)).toBe(true);
    expect(isTestScopedWindowsAcl(ICACLS, [ICACLS, "\\\\host\\share\\other"], "win32", [unc], ROOT)).toBe(false);
  });
});

