import { afterEach, describe, expect, test } from "bun:test";

import {
  resetWindowsPrincipalForTests,
  resolveCurrentWindowsPrincipal,
  resolveCurrentWindowsPrincipalAsync,
  resolveWindowsPrincipalPowerShellExecutableForTests,
  setAsyncWindowsPrincipalRunnerForTests,
  setWindowsPrincipalRunnerForTests,
  windowsPrincipalPowerShellCommandForTests,
} from "../src/lib/windows-user-principal";
import {
  setTrustedWindowsElevationExecutablesForTests,
  WindowsSystemDirectoryFfiUnavailableError,
} from "../src/lib/windows-elevation";

const ok = (stdout = "S-1-5-21-111-222-333-1001\r\n") => ({
  success: true,
  exitCode: 0,
  timedOut: false,
  stdout,
});

afterEach(() => {
  setWindowsPrincipalRunnerForTests(null);
  setAsyncWindowsPrincipalRunnerForTests(null);
  setTrustedWindowsElevationExecutablesForTests(null);
  resetWindowsPrincipalForTests();
});

describe("Windows effective ACL principal", () => {
  test("builds a non-interactive command without the Bun-incompatible PowerShell window flag", () => {
    const trusted = "C:\\trusted-system32\\WindowsPowerShell\\v1.0\\powershell.exe";
    setTrustedWindowsElevationExecutablesForTests({ powershell: trusted });
    expect(windowsPrincipalPowerShellCommandForTests()).toEqual([
      trusted,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ]);
  });

  test("Windows ARM64 uses only the fixed default PowerShell path when FFI resolution is unavailable", () => {
    const lookupError = new WindowsSystemDirectoryFfiUnavailableError();
    const previousSystemRoot = process.env.SystemRoot;
    const previousWindir = process.env.WINDIR;
    const previousPath = process.env.PATH;
    process.env.SystemRoot = "C:\\attacker-controlled";
    process.env.WINDIR = "D:\\attacker-controlled";
    process.env.PATH = "E:\\attacker-controlled";
    try {
      let observedPath = "";
      const resolved = resolveWindowsPrincipalPowerShellExecutableForTests({
        platform: "win32",
        arch: "arm64",
        resolveTrusted: () => { throw lookupError; },
        pathExists: path => {
          observedPath = path;
          return true;
        },
      });
      expect(observedPath).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      expect(resolved).toBe(observedPath);
      expect(resolved).not.toContain("attacker-controlled");
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (previousWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = previousWindir;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test("a GetSystemDirectoryW call failure is rethrown without probing the fixed fallback", () => {
    const lookupError = new Error(
      "GetSystemDirectoryW failed while resolving the trusted system directory.",
    );
    let fallbackProbes = 0;
    expect(() => resolveWindowsPrincipalPowerShellExecutableForTests({
      platform: "win32",
      arch: "arm64",
      resolveTrusted: () => { throw lookupError; },
      pathExists: () => {
        fallbackProbes += 1;
        return true;
      },
    })).toThrow(lookupError);
    expect(fallbackProbes).toBe(0);
  });

  test("an unusable non-default system directory is rethrown without probing the fixed fallback", () => {
    const lookupError = new Error("GetSystemDirectoryW returned an unusable system directory.");
    let fallbackProbes = 0;
    expect(() => resolveWindowsPrincipalPowerShellExecutableForTests({
      platform: "win32",
      arch: "arm64",
      resolveTrusted: () => { throw lookupError; },
      pathExists: () => {
        fallbackProbes += 1;
        return true;
      },
    })).toThrow(lookupError);
    expect(fallbackProbes).toBe(0);
  });

  test("trusted PowerShell validation failures are rethrown without probing the fixed fallback", () => {
    const validationErrors = [
      new Error("Trusted PowerShell was not found at D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe."),
      new Error("PowerShell resolved outside the trusted Windows system directory."),
    ];
    for (const lookupError of validationErrors) {
      let fallbackProbes = 0;
      expect(() => resolveWindowsPrincipalPowerShellExecutableForTests({
        platform: "win32",
        arch: "arm64",
        resolveTrusted: () => { throw lookupError; },
        pathExists: () => {
          fallbackProbes += 1;
          return true;
        },
      })).toThrow(lookupError);
      expect(fallbackProbes).toBe(0);
    }
  });

  test("an arbitrary trusted resolver error is rethrown without probing the fixed fallback", () => {
    const lookupError = new Error("unexpected trusted resolver failure");
    let fallbackProbes = 0;
    expect(() => resolveWindowsPrincipalPowerShellExecutableForTests({
      platform: "win32",
      arch: "arm64",
      resolveTrusted: () => { throw lookupError; },
      pathExists: () => {
        fallbackProbes += 1;
        return true;
      },
    })).toThrow(lookupError);
    expect(fallbackProbes).toBe(0);
  });

  test("a successful trusted resolver always wins without probing the ARM64 fallback", () => {
    let fallbackProbes = 0;
    expect(resolveWindowsPrincipalPowerShellExecutableForTests({
      platform: "win32",
      arch: "arm64",
      resolveTrusted: () => "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      pathExists: () => {
        fallbackProbes += 1;
        return true;
      },
    })).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(fallbackProbes).toBe(0);
  });

  test("the FFI-unavailable sentinel fails closed off Windows ARM64 or without the fixed executable", () => {
    const lookupError = new WindowsSystemDirectoryFfiUnavailableError();
    const resolve = (platform: NodeJS.Platform, arch: string, present: boolean) =>
      resolveWindowsPrincipalPowerShellExecutableForTests({
        platform,
        arch,
        resolveTrusted: () => { throw lookupError; },
        pathExists: () => present,
      });

    expect(() => resolve("win32", "x64", true)).toThrow(lookupError);
    expect(() => resolve("linux", "arm64", true)).toThrow(lookupError);
    expect(() => resolve("win32", "arm64", false)).toThrow(lookupError);
  });

  test("the default trusted runner resolves the real token on Windows", () => {
    if (process.platform !== "win32") return;
    expect(resolveCurrentWindowsPrincipal(5_000)).toMatch(/^\*S-1-(?:\d+-)+\d+$/i);
  });

  test("the default trusted async runner settles and resolves the real token on Windows", async () => {
    if (process.platform !== "win32") return;
    expect(await resolveCurrentWindowsPrincipalAsync(5_000))
      .toMatch(/^\*S-1-(?:\d+-)+\d+$/i);
  });

  test("uses the token SID and normalizes it for icacls, independent of WORKGROUP env", () => {
    const oldDomain = process.env.USERDOMAIN;
    const oldUser = process.env.USERNAME;
    process.env.USERDOMAIN = "WORKGROUP";
    process.env.USERNAME = "not-the-token-authority";
    setWindowsPrincipalRunnerForTests(() => ok());
    try {
      expect(resolveCurrentWindowsPrincipal(1_000)).toBe("*S-1-5-21-111-222-333-1001");
    } finally {
      if (oldDomain === undefined) delete process.env.USERDOMAIN;
      else process.env.USERDOMAIN = oldDomain;
      if (oldUser === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = oldUser;
    }
  });

  test("caches only a successful lookup", () => {
    let calls = 0;
    setWindowsPrincipalRunnerForTests(() => {
      calls += 1;
      return ok();
    });
    expect(resolveCurrentWindowsPrincipal(1_000)).toMatch(/^\*S-1-/);
    expect(resolveCurrentWindowsPrincipal(1_000)).toMatch(/^\*S-1-/);
    expect(calls).toBe(1);
  });

  test("invalid output fails closed and is retried rather than cached", () => {
    let calls = 0;
    setWindowsPrincipalRunnerForTests(() => {
      calls += 1;
      return ok("WORKGROUP\\user\n");
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        resolveCurrentWindowsPrincipal(1_000);
        throw new Error("expected identity refusal");
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("EACLIDENTITY");
      }
    }
    expect(calls).toBe(2);
  });

  test("a resolver timeout stays EACLIDENTITY rather than entering the icacls timeout class", () => {
    setWindowsPrincipalRunnerForTests(() => ({
      success: false,
      exitCode: null,
      timedOut: true,
      stdout: "",
    }));
    try {
      resolveCurrentWindowsPrincipal(1_000);
      throw new Error("expected identity refusal");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("EACLIDENTITY");
    }
  });

  test("concurrent async callers share one owned lookup", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    setAsyncWindowsPrincipalRunnerForTests(async () => {
      calls += 1;
      await gate;
      return ok();
    });

    const first = resolveCurrentWindowsPrincipalAsync(2_000);
    const second = resolveCurrentWindowsPrincipalAsync(2_000);
    await Bun.sleep(0);
    expect(calls).toBe(1);
    release();
    await expect(first).resolves.toBe("*S-1-5-21-111-222-333-1001");
    await expect(second).resolves.toBe("*S-1-5-21-111-222-333-1001");
  });
});
