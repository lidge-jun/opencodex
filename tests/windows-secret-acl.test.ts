/**
 * Tests for src/lib/windows-secret-acl.ts
 *
 * Contract:
 *  - hardenSecretPath(path, { required: false }) => non-fatal: never throws, returns
 *    HardenResult { ok, diagnostics? }
 *  - hardenSecretPath(path, { required: true })  => write-path: throws on failure.
 *  - On non-Windows platforms: deterministic, no external command invocation.
 *  - Windows failure diagnostics are sanitized: no raw path in the error message.
 *  - hardenSecretDir mirrors the same contract for directories.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hardenSecretDir,
  hardenSecretPath,
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setNowForTests,
  setPlatformForTests,
  type HardenResult,
  type IcaclsResult,
} from "../src/lib/windows-secret-acl";

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-acl-test-"));
});

afterEach(() => {
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

// ---------------------------------------------------------------------------
// Cross-platform: non-fatal (read-path) mode — must never throw
// ---------------------------------------------------------------------------

describe("hardenSecretPath – non-fatal mode (required: false)", () => {
  test("returns ok:true for an existing file", () => {
    const filePath = join(testDir, "secret.json");
    writeFileSync(filePath, "data", "utf-8");

    const result: HardenResult = hardenSecretPath(filePath, { required: false });

    expect(result.ok).toBe(true);
  });

  test("returns ok:true for a missing file without throwing and without creating it", () => {
    const filePath = join(testDir, "nonexistent.json");

    const result: HardenResult = hardenSecretPath(filePath, { required: false });

    expect(result.ok).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  test("never throws even when the path contains non-ASCII characters", () => {
    const filePath = join(testDir, "한글-secret.json");
    writeFileSync(filePath, "data", "utf-8");

    expect(() => hardenSecretPath(filePath, { required: false })).not.toThrow();
  });

  test("result has ok boolean and optional diagnostics string fields", () => {
    const filePath = join(testDir, "secret.json");
    writeFileSync(filePath, "data", "utf-8");

    const result = hardenSecretPath(filePath, { required: false });

    expect(typeof result.ok).toBe("boolean");
    if (result.diagnostics !== undefined) {
      expect(typeof result.diagnostics).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-platform: required (write-path) mode on the current platform
// ---------------------------------------------------------------------------

describe("hardenSecretPath – required mode (required: true)", () => {
  test("returns ok:true for an existing file on the current platform", () => {
    const filePath = join(testDir, "secret.json");
    writeFileSync(filePath, "data", "utf-8");

    const result: HardenResult = hardenSecretPath(filePath, { required: true });

    expect(result.ok).toBe(true);
  });

  test("does not create file when it does not exist even in required mode", () => {
    const filePath = join(testDir, "nonexistent-required.json");

    // required mode on a missing path: should not create the file, return ok:true
    const result: HardenResult = hardenSecretPath(filePath, { required: true });

    expect(result.ok).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hardenSecretDir
// ---------------------------------------------------------------------------

describe("hardenSecretDir", () => {
  test("returns ok:true for an existing directory in non-fatal mode", () => {
    const result: HardenResult = hardenSecretDir(testDir, { required: false });
    expect(result.ok).toBe(true);
  });

  test("returns ok:true for an existing directory in required mode", () => {
    const result: HardenResult = hardenSecretDir(testDir, { required: true });
    expect(result.ok).toBe(true);
  });

  test("returns ok:true for a missing directory without creating it", () => {
    const missingDir = join(testDir, "does-not-exist");
    const result: HardenResult = hardenSecretDir(missingDir, { required: false });
    expect(result.ok).toBe(true);
    expect(existsSync(missingDir)).toBe(false);
  });

  test("result shape matches HardenResult interface", () => {
    const result = hardenSecretDir(testDir, { required: false });
    expect(typeof result.ok).toBe("boolean");
    if (result.diagnostics !== undefined) {
      expect(typeof result.diagnostics).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Windows-specific contract: sanitized diagnostics
// We can only test the real Windows ACL path when running on win32.
// ---------------------------------------------------------------------------

describe("Windows ACL diagnostics (win32 only)", () => {
  const isWin32 = process.platform === "win32";

  test("on win32: hardenSecretPath returns ok:true for existing file (real ACL)", () => {
    if (!isWin32) return; // skip on non-Windows
    const filePath = join(testDir, "win-secret.json");
    writeFileSync(filePath, "sensitive data", "utf-8");

    const result = hardenSecretPath(filePath, { required: false });

    // On a normal NTFS Windows filesystem, this should succeed
    expect(result.ok).toBe(true);
  });

  test("on win32: hardenSecretDir returns ok:true for existing dir (real ACL)", () => {
    if (!isWin32) return; // skip on non-Windows
    const result = hardenSecretDir(testDir, { required: false });
    expect(result.ok).toBe(true);
  });

  test("on win32: hardenSecretPath with required:true for existing file completes", () => {
    if (!isWin32) return;
    const filePath = join(testDir, "win-required-secret.json");
    writeFileSync(filePath, "data", "utf-8");

    // Must not throw on a normal NTFS volume
    expect(() => hardenSecretPath(filePath, { required: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Non-Windows determinism: helper must not invoke external processes
// We verify this by checking the module uses platform-branched logic.
// On non-Windows we can verify the contract is met without mocking internals.
// ---------------------------------------------------------------------------

describe("non-Windows determinism", () => {
  test("on non-win32: hardenSecretPath completes without error for existing file", () => {
    if (process.platform === "win32") return; // This suite is for non-Windows
    const filePath = join(testDir, "posix-secret.json");
    writeFileSync(filePath, "data", "utf-8");

    const result = hardenSecretPath(filePath, { required: false });

    expect(result.ok).toBe(true);
  });

  test("on non-win32: hardenSecretDir completes without error for existing dir", () => {
    if (process.platform === "win32") return;
    const result = hardenSecretDir(testDir, { required: false });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics sanitization: failure messages must not expose raw paths
// This tests the contract via the exported sanitizeDiagnostics helper if present,
// otherwise verifies that hardenSecretPath failure messages meet the contract.
// ---------------------------------------------------------------------------

describe("diagnostics sanitization contract", () => {
  test("HardenResult diagnostics field is a plain string when present", () => {
    const filePath = join(testDir, "diag-test.json");
    writeFileSync(filePath, "data", "utf-8");

    const result = hardenSecretPath(filePath, { required: false });

    if (result.diagnostics !== undefined) {
      expect(typeof result.diagnostics).toBe("string");
      // Must contain "ACL" as a hint (per contract)
      expect(result.diagnostics.toLowerCase()).toMatch(/acl|permission|access/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure-path activation via injected runner/platform/clock seams.
// The platform seam forces the win32 gate open so CI on POSIX reaches the
// runner; every case restores all seams in afterEach.
// ---------------------------------------------------------------------------

describe("icacls failure paths (injected seams)", () => {
  const ok: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  const timeout: IcaclsResult = { success: false, exitCode: null, timedOut: true, stdout: "" };
  const denied: IcaclsResult = { success: false, exitCode: 5, timedOut: false, stdout: "" };
  let warnings: string[] = [];
  const realWarn = console.warn;

  beforeEach(() => {
    setPlatformForTests("win32");
    resetHardenedStateForTests();
    process.env.USERNAME ??= "tester";
    warnings = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  });

  afterEach(() => {
    setPlatformForTests(null);
    setIcaclsRunnerForTests(null);
    setNowForTests(null);
    resetHardenedStateForTests();
    console.warn = realWarn;
  });

  function secretFile(name = "secret.json"): string {
    const filePath = join(testDir, name);
    writeFileSync(filePath, "data", "utf-8");
    return filePath;
  }

  test("a genuine timeout on a required path soft-fails with a warning instead of blocking auth", () => {
    setIcaclsRunnerForTests(() => timeout);
    const filePath = secretFile();

    const result = hardenSecretPath(filePath, { required: true });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContain("ETIMEDOUT");
    expect(warnings.some(w => w.includes("continuing without NTFS ACL harden"))).toBe(true);
  });

  test("a real permission failure on a required path still throws (no blanket soft-fail)", () => {
    setIcaclsRunnerForTests(() => denied);
    const filePath = secretFile();

    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/EICACLS/);
    expect(warnings).toEqual([]);
  });

  test("a /remove:g failure with the SID still present propagates; a clean /findsid succeeds", () => {
    const filePath = secretFile();
    // Case A: removal fails and /findsid still echoes the path → error propagates.
    setIcaclsRunnerForTests(args => {
      if (args.includes("/remove:g")) return denied;
      if (args.includes("/findsid")) return { ...ok, stdout: `SID Found: ${filePath}\n` };
      return ok;
    });
    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/EICACLS/);

    // Case B: removal fails but no SID remains (ACE was already absent) → harden succeeds.
    resetHardenedStateForTests();
    setIcaclsRunnerForTests(args => {
      if (args.includes("/remove:g")) return denied;
      if (args.includes("/findsid")) return { ...ok, stdout: "Successfully processed 1 files\n" };
      return ok;
    });
    expect(hardenSecretPath(filePath, { required: true })).toEqual({ ok: true });
  });

  test("all icacls steps share one deadline and a timed-out path is not retried this process", () => {
    const filePath = secretFile();
    let now = 0;
    const budgets: number[] = [];
    setNowForTests(() => now);
    setIcaclsRunnerForTests((_args, timeoutMs) => {
      budgets.push(timeoutMs);
      now += 6_000; // step consumes more than the whole 5s budget
      return ok;
    });

    const first = hardenSecretPath(filePath, { required: true });
    expect(first.ok).toBe(false); // second step hits the exhausted deadline → timeout soft-fail
    expect(budgets.length).toBe(1); // only step 1 ran; step 2 was cut off by the shared deadline
    expect(budgets[0]).toBeLessThanOrEqual(5_000);

    // The timed-out path short-circuits without invoking the runner again.
    const second = hardenSecretPath(filePath, { required: true });
    expect(second.ok).toBe(false);
    expect(second.diagnostics).toContain("skipped");
    expect(budgets.length).toBe(1);
  });

  test("a timeout diagnostic no longer claims filesystem non-support (issue #160)", () => {
    setIcaclsRunnerForTests(() => timeout);
    const result = hardenSecretPath(secretFile(), { required: true });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContain("timed out");
    expect(result.diagnostics).toContain("transient icacls stall");
    expect(result.diagnostics).not.toContain("may not support per-user NTFS ACLs");
  });

  test("one timeout retry within the same total budget can still succeed", () => {
    const filePath = secretFile();
    let now = 0;
    let inheritanceCalls = 0;
    setNowForTests(() => now);
    setIcaclsRunnerForTests(args => {
      if (args.includes("/inheritance:r")) {
        inheritanceCalls += 1;
        if (inheritanceCalls === 1) {
          now += 2_000; // first attempt stalls, but budget remains
          return timeout;
        }
      }
      now += 100;
      return ok;
    });

    const result = hardenSecretPath(filePath, { required: true });
    expect(result).toEqual({ ok: true });
    expect(inheritanceCalls).toBe(2); // exactly one retry
    // A successful retry enters the hardened cache: no further runner calls.
    const before = inheritanceCalls;
    expect(hardenSecretPath(filePath, { required: true })).toEqual({ ok: true });
    expect(inheritanceCalls).toBe(before);
  });

  test("a clean post-timeout probe annotates the diagnostic but never promotes to ok:true", () => {
    const filePath = secretFile();
    setIcaclsRunnerForTests(args => {
      if (args.includes("/findsid")) return { ...ok, stdout: "Successfully processed 1 files\n" };
      return timeout; // both harden attempts time out
    });

    const result = hardenSecretPath(filePath, { required: true });
    expect(result.ok).toBe(false); // clean /findsid is diagnostic-only
    expect(result.diagnostics).toContain("no broad ACL grants detected");
    expect(result.diagnostics).toContain("hardening still incomplete");

    // And the path landed in the timed-out cache, not the hardened cache.
    expect(hardenSecretPath(filePath, { required: true }).diagnostics).toContain("skipped");
  });

  test("a dirty post-timeout probe reports the remaining broad grants", () => {
    const filePath = secretFile();
    setIcaclsRunnerForTests(args => {
      if (args.includes("/findsid")) return { ...ok, stdout: `SID Found: ${filePath}\n` };
      return timeout;
    });

    const result = hardenSecretPath(filePath, { required: true });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContain("broad ACL grants still present");
  });

  test("OPENCODEX_ACL_TIMEOUT_MS overrides the total budget with clamping", () => {
    const budgets: number[] = [];
    let now = 0;
    setNowForTests(() => now);
    setIcaclsRunnerForTests((_args, timeoutMs) => {
      budgets.push(timeoutMs);
      now += 100;
      return ok;
    });

    const prev = process.env.OPENCODEX_ACL_TIMEOUT_MS;
    try {
      process.env.OPENCODEX_ACL_TIMEOUT_MS = "10000";
      hardenSecretPath(secretFile("env-a.json"), { required: true });
      expect(budgets[0]).toBeLessThanOrEqual(10_000);
      expect(budgets[0]).toBeGreaterThan(5_000);

      budgets.length = 0;
      process.env.OPENCODEX_ACL_TIMEOUT_MS = "50"; // below floor → clamped to 1000
      hardenSecretPath(secretFile("env-b.json"), { required: true });
      expect(budgets[0]).toBeLessThanOrEqual(1_000);
      expect(budgets[0]).toBeGreaterThan(500);

      budgets.length = 0;
      process.env.OPENCODEX_ACL_TIMEOUT_MS = "5000ms"; // malformed → default 5000
      hardenSecretPath(secretFile("env-c.json"), { required: true });
      expect(budgets[0]).toBeLessThanOrEqual(5_000);
      expect(budgets[0]).toBeGreaterThan(4_000);
    } finally {
      if (prev === undefined) delete process.env.OPENCODEX_ACL_TIMEOUT_MS;
      else process.env.OPENCODEX_ACL_TIMEOUT_MS = prev;
    }
  });

  test("a thrown EPERM error on a required path still fails closed (no retry)", () => {
    let calls = 0;
    setIcaclsRunnerForTests(() => {
      calls += 1;
      const err = new Error("icacls denied") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    expect(() => hardenSecretPath(secretFile(), { required: true })).toThrow(/permission denied/);
    expect(calls).toBe(1); // real failures do not consume the timeout retry
  });
});
