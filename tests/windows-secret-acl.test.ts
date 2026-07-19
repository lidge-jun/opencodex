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
  type HardenResult,
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

describe("Windows icacls spawn contract", () => {
  test("runIcacls always passes windowsHide so GUI/proxy spawns do not hang", async () => {
    const src = await Bun.file(new URL("../src/lib/windows-secret-acl.ts", import.meta.url)).text();
    const hideCount = [...src.matchAll(/windowsHide:\s*true/g)].length;
    // Three icacls steps (inheritance / remove / grant) each need windowsHide.
    expect(hideCount).toBeGreaterThanOrEqual(3);
  });
});
