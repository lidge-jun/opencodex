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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
    //
    // Both values are pinned, because there are now two. A contended CI runner cannot start
    // powershell.exe inside 8s while it runs a quarter of this suite, and the composed
    // acceptance cases failed there with "Windows effective-account lookup timed out" —
    // contention, not a hung child, which is the only thing this budget exists to bound.
    // A user's machine keeps 8s exactly as before.
    const previous = process.env.CI;
    try {
      delete process.env.CI;
      expect(windowsIdentityPowerShellSpawnOptionsForTests().timeout).toBe(8_000);
      process.env.CI = "true";
      expect(windowsIdentityPowerShellSpawnOptionsForTests().timeout).toBe(30_000);
    } finally {
      if (previous === undefined) delete process.env.CI;
      else process.env.CI = previous;
    }
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

describe("no direct PowerShell argv carries the Bun-incompatible window flag (#1589)", () => {
  // src/codex/user-identity.ts records the invariant in prose: PowerShell's
  // `-WindowStyle Hidden` CLI pair can fail under Bun 1.3.14 before the command
  // runs, and process-level `windowsHide` is what actually suppresses the window.
  // The prose held for the file that carried it and drifted everywhere else, so
  // this sweeps the whole runtime instead of one file.
  //
  // Only the ARGV form is forbidden. Passing `-WindowStyle Hidden` inside a
  // PowerShell script string (`Start-Process ... -WindowStyle Hidden`) is a
  // different construct that Bun never parses, and six legitimate call sites
  // rely on it.
  const runtimeFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...runtimeFiles(full));
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  };

  // "-WindowStyle" and "Hidden" as adjacent quoted argv elements, in either
  // quote style, tolerating whitespace or a line break between them.
  const FORBIDDEN_ARGV = /["']-WindowStyle["']\s*,\s*["']Hidden["']/;

  const srcRoot = join(import.meta.dir, "..", "src");

  test("no src/**/*.ts passes -WindowStyle Hidden as an argv pair", () => {
    const offenders = runtimeFiles(srcRoot)
      .filter(file => FORBIDDEN_ARGV.test(readFileSync(file, "utf8")))
      .map(file => file.slice(srcRoot.length + 1).replaceAll("\\", "/"));
    expect(offenders).toEqual([]);
  });

  test("the pattern accepts the script-string form and rejects the argv form", () => {
    // Guard the guard: if this ever stops discriminating, the sweep above is
    // either vacuous or about to fail six correct call sites.
    expect(FORBIDDEN_ARGV.test('"-NonInteractive", "-WindowStyle", "Hidden",')).toBe(true);
    expect(FORBIDDEN_ARGV.test("'-WindowStyle', 'Hidden'")).toBe(true);
    expect(FORBIDDEN_ARGV.test('" -Verb RunAs -WindowStyle Hidden -PassThru -Wait;"')).toBe(false);
    expect(FORBIDDEN_ARGV.test('"$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden"')).toBe(false);
  });
});
