import { afterEach, describe, expect, test } from "bun:test";

import {
  resetWindowsPrincipalForTests,
  resolveCurrentWindowsPrincipal,
  resolveCurrentWindowsPrincipalAsync,
  setAsyncWindowsPrincipalRunnerForTests,
  setWindowsPrincipalRunnerForTests,
  windowsPrincipalPowerShellCommandForTests,
} from "../src/lib/windows-user-principal";
import { setTrustedWindowsElevationExecutablesForTests } from "../src/lib/windows-elevation";

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
  test("builds a hidden non-interactive command from the trusted PowerShell path", () => {
    const trusted = "C:\\trusted-system32\\WindowsPowerShell\\v1.0\\powershell.exe";
    setTrustedWindowsElevationExecutablesForTests({ powershell: trusted });
    expect(windowsPrincipalPowerShellCommandForTests()).toEqual([
      trusted,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ]);
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
