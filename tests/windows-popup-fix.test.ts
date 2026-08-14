/**
 * Regression coverage for the Windows console-popup fix (#1278).
 *
 * The desktop proxy parent runs without a console. Every console-subsystem
 * child it spawns without CREATE_NO_WINDOW (`windowsHide`) gets a fresh
 * visible console window — observed at startup, on config writes, and on
 * shutdown. The proxy-internal identity and process lookups must therefore
 * spawn PowerShell hidden, from the trusted System32 directory (never PATH),
 * and under a bounded timeout so a hung child cannot wedge those paths.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { readProcessStartMsBatch } from "../src/codex/app-server-processes";
import {
  decodeWindowsIdentityPowerShellOutputForTests,
  resolveEffectiveUserIdentity,
  windowsIdentityPowerShellCommandForTests,
  windowsIdentityPowerShellSpawnOptionsForTests,
} from "../src/codex/user-identity";
import { setTrustedWindowsElevationExecutablesForTests } from "../src/lib/windows-elevation";

const TRUSTED_POWERSHELL = "C:\\trusted-system32\\WindowsPowerShell\\v1.0\\powershell.exe";

afterEach(() => {
  setTrustedWindowsElevationExecutablesForTests(null);
});

describe("Windows identity lookup popup fix (#1278)", () => {
  test("builds a non-interactive command without the Bun-incompatible PowerShell window flag", () => {
    setTrustedWindowsElevationExecutablesForTests({ powershell: TRUSTED_POWERSHELL });
    const command = windowsIdentityPowerShellCommandForTests(
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    );
    expect(command[0]).toBe(TRUSTED_POWERSHELL);
    expect(command).toContain("-NoProfile");
    expect(command).toContain("-NonInteractive");
    expect(command).not.toContain("-WindowStyle");
    expect(command).not.toContain("Hidden");
    expect(command[command.length - 2]).toBe("-Command");
    expect(command[command.length - 1])
      .toContain("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
    expect(command[command.length - 1]).toContain("ToBase64String");
    expect(command[command.length - 1]).toContain("Encoding]::Unicode");
  });

  test("spawn options are hidden and bounded", () => {
    const options = windowsIdentityPowerShellSpawnOptionsForTests();
    expect(options.windowsHide).toBe(true);
    expect(options.stdin).toBe("ignore");
    // Assert the exact budget: the identity lookup contract is an 8-second
    // bound, and a looser assertion would let a silent re-tune through.
    expect(options.timeout).toBe(8_000);
  });

  test("decodes non-ASCII known-folder values from the ASCII-safe envelope", () => {
    const path = "C:\\Users\\한글\\AppData\\Local";
    const envelope = Buffer.from(path, "utf16le").toString("base64");
    expect(decodeWindowsIdentityPowerShellOutputForTests(Buffer.from(`${envelope}\r\n`, "ascii")))
      .toBe(path);
  });

  test("the hidden trusted lookup resolves the real token on Windows", () => {
    if (process.platform !== "win32") return;
    const identity = resolveEffectiveUserIdentity();
    expect(identity.platform).toBe("win32");
    if (identity.platform === "win32") {
      expect(identity.sid).toMatch(/^S-1-(?:\d+-)+\d+$/i);
    }
  });
});

describe("Windows process-lookup popup fix (#1278)", () => {
  test("batch start-time lookup is trusted, bounded, and never throws cross-platform", () => {
    // On POSIX hosts the trusted System32 resolver throws inside the win32
    // branch's catch — the batch must degrade to nulls, exactly like a
    // missing/failed PowerShell, instead of propagating.
    const batch = readProcessStartMsBatch([process.pid], "win32");
    const startedAtMs = batch.get(process.pid) ?? null;
    if (process.platform === "win32") {
      expect(startedAtMs).not.toBeNull();
      expect(Number.isFinite(startedAtMs)).toBe(true);
      expect(startedAtMs!).toBeGreaterThan(0);
    } else {
      expect(startedAtMs).toBeNull();
    }
  });
});
