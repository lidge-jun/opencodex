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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetEphemeralSecretPath,
  hardenSecretDir,
  hardenSecretDirAsync,
  forgetHardenedSecretPath,
  hardenSecretPath,
  hardenSecretPathAsync,
  hardenedSecretDirCountForTests,
  hardenedSecretPathCountForTests,
  resetHardenedStateForTests,
  setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests,
  setNowForTests,
  setPlatformForTests,
  setStatForTests,
  timedOutSecretPathCountForTests,
  type HardenResult,
  type IcaclsResult,
} from "../src/lib/windows-secret-acl";
import { atomicWriteFile } from "../src/config";
import { hardenStableLockFile } from "../src/codex/native-main-lock-file";
import { nativeMainClaimPath, withNativeMainSharedClaim } from "../src/codex/native-main-claim";
import { NATIVE_MAIN_OWNER_DB, retainNativeMainOwner } from "../src/codex/native-main-owner";
import {
  resetWindowsPrincipalForTests,
  setAsyncWindowsPrincipalRunnerForTests,
  setWindowsPrincipalRunnerForTests,
} from "../src/lib/windows-user-principal";

let testDir = "";

// The default harden budget is production policy (#1156 raised it to 30s), not a value tests
// should silently inherit. Isolate the override here so a test that cares about a specific
// budget pins it explicitly, and a stray value in the developer's environment cannot change
// what any of these assert.
let previousAclTimeout: string | undefined;

beforeEach(() => {
  previousAclTimeout = process.env.OPENCODEX_ACL_TIMEOUT_MS;
  delete process.env.OPENCODEX_ACL_TIMEOUT_MS;
  testDir = mkdtempSync(join(tmpdir(), "ocx-acl-test-"));
});

afterEach(() => {
  if (previousAclTimeout === undefined) delete process.env.OPENCODEX_ACL_TIMEOUT_MS;
  else process.env.OPENCODEX_ACL_TIMEOUT_MS = previousAclTimeout;
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

describe("effective Windows principal integration", () => {
  test("the owner grant uses a numeric SID even when USERDOMAIN says WORKGROUP", () => {
    const filePath = join(testDir, "workgroup-secret.json");
    writeFileSync(filePath, "data", "utf-8");
    const oldDomain = process.env.USERDOMAIN;
    const oldUser = process.env.USERNAME;
    process.env.USERDOMAIN = "WORKGROUP";
    process.env.USERNAME = "not-authoritative";
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    const seen: string[][] = [];
    setIcaclsRunnerForTests(args => {
      seen.push(args);
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    try {
      expect(hardenSecretPath(filePath, { required: true })).toEqual({ ok: true });
      const grant = seen.find(args => args.includes("/grant:r"));
      expect(grant).toBeDefined();
      expect(grant![2]).toMatch(/^\*S-1-(?:\d+-)+\d+:\(F\)$/i);
      expect(grant![2]).not.toContain("WORKGROUP");
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (oldDomain === undefined) delete process.env.USERDOMAIN;
      else process.env.USERDOMAIN = oldDomain;
      if (oldUser === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = oldUser;
    }
  });

  // These ran only on Windows until the resolver learned to let an injected
  // runner outrank the synthetic POSIX principal. A case that silently returns
  // on two of three CI platforms is not coverage of a fail-closed boundary, and
  // the timedOutPaths isolation it asserts is the whole reason the identity
  // failure carries its own error code.
  const IDENTITY_DIAGNOSTIC =
    "ACL hardening failed (EACLIDENTITY) — the effective Windows account SID could not be resolved";

  test("a failed identity lookup fails closed, runs no icacls, and never enters the timeout memo", () => {
    const requiredPath = join(testDir, "identity-required.json");
    const optionalPath = join(testDir, "identity-optional.json");
    writeFileSync(requiredPath, "required", "utf-8");
    writeFileSync(optionalPath, "optional", "utf-8");
    let identityCalls = 0;
    let icaclsCalls = 0;
    setWindowsPrincipalRunnerForTests(() => {
      identityCalls += 1;
      return { success: false, exitCode: null, timedOut: true, stdout: "" };
    });
    setIcaclsRunnerForTests(() => {
      icaclsCalls += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    try {
      // required: throws, and the CODE survives sanitization so a caller can
      // branch on the cause rather than parse the message.
      let thrown: NodeJS.ErrnoException | undefined;
      try {
        hardenSecretPath(requiredPath, { required: true });
      } catch (error) {
        thrown = error as NodeJS.ErrnoException;
      }
      expect(thrown).toBeDefined();
      expect(thrown).toMatchObject({ code: "EACLIDENTITY" });

      // optional: soft-fails WITHOUT touching the ACL. No name-shaped fallback.
      expect(hardenSecretPath(optionalPath, { required: false })).toEqual({
        ok: false,
        diagnostics: IDENTITY_DIAGNOSTIC,
      });

      // The injected runner actually ran — this is what regressed to 0 when the
      // synthetic principal was chosen first.
      expect(identityCalls).toBe(2);
      expect(icaclsCalls).toBe(0);
      // An identity failure is not an icacls timeout: the path stays retryable.
      expect(timedOutSecretPathCountForTests()).toBe(0);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      setWindowsPrincipalRunnerForTests(null);
      resetWindowsPrincipalForTests();
    }
  });

  test("the async harden path applies the same identity policy", async () => {
    const requiredPath = join(testDir, "identity-required-async.json");
    const optionalPath = join(testDir, "identity-optional-async.json");
    writeFileSync(requiredPath, "required", "utf-8");
    writeFileSync(optionalPath, "optional", "utf-8");
    let identityCalls = 0;
    let icaclsCalls = 0;
    setAsyncWindowsPrincipalRunnerForTests(async () => {
      identityCalls += 1;
      return { success: false, exitCode: null, timedOut: true, stdout: "" };
    });
    setAsyncIcaclsRunnerForTests(async () => {
      icaclsCalls += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    try {
      let thrown: NodeJS.ErrnoException | undefined;
      try {
        await hardenSecretPathAsync(requiredPath, { required: true });
      } catch (error) {
        thrown = error as NodeJS.ErrnoException;
      }
      expect(thrown).toBeDefined();
      expect(thrown).toMatchObject({ code: "EACLIDENTITY" });

      expect(await hardenSecretPathAsync(optionalPath, { required: false })).toEqual({
        ok: false,
        diagnostics: IDENTITY_DIAGNOSTIC,
      });

      expect(identityCalls).toBe(2);
      expect(icaclsCalls).toBe(0);
      expect(timedOutSecretPathCountForTests()).toBe(0);
    } finally {
      setAsyncIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      setAsyncWindowsPrincipalRunnerForTests(null);
      resetWindowsPrincipalForTests();
    }
  });

  test("no name-shaped principal reaches icacls when the environment names a plausible account", () => {
    const filePath = join(testDir, "no-name-fallback.json");
    writeFileSync(filePath, "data", "utf-8");
    const oldDomain = process.env.USERDOMAIN;
    const oldUser = process.env.USERNAME;
    // A shape a reader would accept at a glance. It is still not the token.
    process.env.USERDOMAIN = "CORP";
    process.env.USERNAME = "administrator";
    const seen: string[][] = [];
    setWindowsPrincipalRunnerForTests(() => ({
      success: false,
      exitCode: 1,
      timedOut: false,
      stdout: "",
    }));
    setIcaclsRunnerForTests(args => {
      seen.push(args);
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    try {
      expect(hardenSecretPath(filePath, { required: false })).toEqual({
        ok: false,
        diagnostics: IDENTITY_DIAGNOSTIC,
      });
      expect(seen).toEqual([]);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      setWindowsPrincipalRunnerForTests(null);
      resetWindowsPrincipalForTests();
      if (oldDomain === undefined) delete process.env.USERDOMAIN;
      else process.env.USERDOMAIN = oldDomain;
      if (oldUser === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = oldUser;
    }
  });
});

describe("ephemeral harden success memo lifecycle", () => {
  test("forgetHardenedSecretPath releases only the actual temp and a second temp hardens again", () => {
    // Earlier cases in this file harden real paths under the win32 override and
    // legitimately leave success memos behind; this test asserts exact memo
    // counts, so it must start from a clean slate rather than inherit them.
    resetHardenedStateForTests();
    const tempA = join(testDir, "config.json.ocx.1.1.tmp");
    const tempB = join(testDir, "config.json.ocx.1.2.tmp");
    writeFileSync(tempA, "first", "utf8");
    writeFileSync(tempB, "second", "utf8");
    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    let grants = 0;
    setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) grants += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    try {
      expect(hardenSecretPath(tempA, { required: true })).toEqual({ ok: true });
      expect(hardenedSecretPathCountForTests()).toBe(1);
      forgetHardenedSecretPath(tempA);
      expect(hardenedSecretPathCountForTests()).toBe(0);

      expect(hardenSecretPath(tempB, { required: true })).toEqual({ ok: true });
      expect(grants).toBe(2);
      expect(hardenedSecretPathCountForTests()).toBe(1);
      forgetHardenedSecretPath(tempB);
      expect(hardenedSecretPathCountForTests()).toBe(0);
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
    }
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

describe("icacls executable authority", () => {
  test("default runners resolve icacls from the trusted System32 path, not PATH", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "windows-secret-acl.ts"), "utf8");
    expect(src).toContain("resolveTrustedWindowsIcaclsExe");
    expect(src).not.toMatch(/Bun\.spawn(?:Sync)?\(\["icacls\.exe"/);
  });
});

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

  test("a genuine timeout on a required path fails closed", () => {
    setIcaclsRunnerForTests(() => timeout);
    const filePath = secretFile();

    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/ETIMEDOUT/);
    expect(warnings).toEqual([]);
  });

  test("required ACL timeout prevents atomic rename and scrubs the temporary file", () => {
    setIcaclsRunnerForTests(() => timeout);
    const destination = join(testDir, "atomic-secret.json");
    let renamed = false;
    let scrubbed = false;
    expect(() => atomicWriteFile(destination, "secret", {
      write: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
      harden: path => { hardenSecretPath(path, { required: true }); },
      rename: (source, target) => { renamed = true; renameSync(source, target); },
      truncate: path => { scrubbed = true; truncateSync(path, 0); },
      unlink: unlinkSync,
    })).toThrow(/ETIMEDOUT/);
    expect(renamed).toBe(false);
    expect(scrubbed).toBe(true);
    expect(existsSync(destination)).toBe(false);
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
    // Pinned to the pre-#1156 budget: this test is about the SHARING of one envelope across
    // steps, not about how large the envelope is. Without the pin it would silently stop
    // timing out at the 30s default and assert nothing.
    process.env.OPENCODEX_ACL_TIMEOUT_MS = "5000";
    const filePath = secretFile();
    let now = 0;
    const budgets: number[] = [];
    setNowForTests(() => now);
    setIcaclsRunnerForTests((_args, timeoutMs) => {
      budgets.push(timeoutMs);
      now += 6_000; // step consumes more than the whole 5s budget
      return ok;
    });

    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/ETIMEDOUT/);
    expect(budgets.length).toBe(1); // only step 1 ran; step 2 was cut off by the shared deadline
    expect(budgets[0]).toBeLessThanOrEqual(5_000);

    // The timed-out path short-circuits without invoking the runner again.
    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/skipped/);
    expect(budgets.length).toBe(1);
  });

  test("slow successful ACL steps fit the default harden envelope (#1156)", () => {
    // The reported failure: on a machine where icacls is slow, the whole sequence could not
    // finish inside one 5s envelope, the harden failed closed, and the native-main owner
    // published a permanent `unavailable` — every native request then 503'd until restart.
    // No pin here on purpose: this test exists to exercise the SHIPPED default.
    resetHardenedStateForTests();
    const filePath = secretFile("slow-default-envelope.json");
    let now = 0;
    const steps: string[] = [];

    setNowForTests(() => now);
    setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) { steps.push("/grant:r"); now += 2_000; }
      else if (args.includes("/inheritance:r")) { steps.push("/inheritance:r"); now += 11_000; }
      else if (args.includes("/remove:g")) { steps.push("/remove:g"); }
      return ok;
    });

    // 13s of slow-but-successful work: impossible under the old 5s default, comfortable
    // under 30s with margin left for the conditional /findsid verification.
    expect(hardenSecretPath(filePath, { required: true })).toEqual({ ok: true });
    expect(steps).toEqual(["/grant:r", "/inheritance:r", "/remove:g"]);
  });

  test("a timeout diagnostic no longer claims filesystem non-support (issue #160)", () => {
    setIcaclsRunnerForTests(() => timeout);
    let message = "";
    try {
      hardenSecretPath(secretFile(), { required: true });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("timed out");
    expect(message).toContain("transient icacls stall");
    expect(message).not.toContain("may not support per-user NTFS ACLs");
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

    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/no broad ACL grants detected.*hardening still incomplete/);

    // And the path landed in the timed-out cache, not the hardened cache.
    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/skipped/);
  });

  test("a dirty post-timeout probe reports the remaining broad grants", () => {
    const filePath = secretFile();
    setIcaclsRunnerForTests(args => {
      if (args.includes("/findsid")) return { ...ok, stdout: `SID Found: ${filePath}\n` };
      return timeout;
    });

    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/broad ACL grants still present/);
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
      process.env.OPENCODEX_ACL_TIMEOUT_MS = "5000ms"; // malformed → default 30000 (#1156)
      hardenSecretPath(secretFile("env-c.json"), { required: true });
      expect(budgets[0]).toBeLessThanOrEqual(30_000);
      expect(budgets[0]).toBeGreaterThan(29_000);
    } finally {
      if (prev === undefined) delete process.env.OPENCODEX_ACL_TIMEOUT_MS;
      else process.env.OPENCODEX_ACL_TIMEOUT_MS = prev;
    }
  });

  test("a thrown EPERM error on a required path still fails closed (no retry)", () => {
    let calls = 0;
    const steps: string[] = [];
    setIcaclsRunnerForTests(args => {
      calls += 1;
      if (args.includes("/grant:r")) steps.push("grant-owner");
      else if (args.includes("/inheritance:r")) steps.push("remove-inheritance");
      else if (args.includes("/remove:g")) steps.push("remove-broad");
      else if (args.includes("/findsid")) steps.push("findsid");
      else steps.push("other");
      const err = new Error("icacls denied") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    expect(() => hardenSecretPath(secretFile(), { required: true })).toThrow(/permission denied/);
    // Grant runs first: a grant failure must not have already mutated inheritance (#596).
    expect(calls).toBe(1);
    expect(steps).toEqual(["grant-owner"]);
  });

  test("successful harden runs grant-owner before inheritance removal (#596)", () => {
    const steps: string[] = [];
    setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) steps.push("grant-owner");
      else if (args.includes("/inheritance:r")) steps.push("remove-inheritance");
      else if (args.includes("/remove:g")) steps.push("remove-broad");
      else if (args.includes("/findsid")) steps.push("findsid");
      return ok;
    });

    expect(hardenSecretPath(secretFile(), { required: true })).toEqual({ ok: true });
    expect(steps).toEqual(["grant-owner", "remove-inheritance", "remove-broad"]);
  });

  test("remove:g timeout after owner grant leaves explicit Full Control (#596)", () => {
    // Models the production strand: inheritance already removed, then a later step
    // times out. With owner-first ordering the writer still has an explicit ACE.
    let ownerHasExplicitAce = false;
    let inheritanceRemoved = false;
    const timeoutOnRemove: IcaclsResult = {
      success: false,
      exitCode: null,
      timedOut: true,
      stdout: "",
    };
    setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) {
        ownerHasExplicitAce = true;
        return ok;
      }
      if (args.includes("/inheritance:r")) {
        inheritanceRemoved = true;
        return ok;
      }
      if (args.includes("/remove:g")) return timeoutOnRemove;
      return ok;
    });

    expect(() => hardenSecretPath(secretFile(), { required: true })).toThrow(/ETIMEDOUT/);
    expect(inheritanceRemoved).toBe(true);
    expect(ownerHasExplicitAce).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Async harden (#612): same policy as sync, but yields via asyncIcaclsRunner.
// ---------------------------------------------------------------------------

describe("async hardenSecretPath (issue #612)", () => {
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
    setAsyncIcaclsRunnerForTests(null);
    setNowForTests(null);
    resetHardenedStateForTests();
    console.warn = realWarn;
  });

  function secretFile(name = "secret.json"): string {
    const filePath = join(testDir, name);
    writeFileSync(filePath, "data", "utf-8");
    return filePath;
  }

  test("async timeout fails closed with the same policy as sync", async () => {
    setAsyncIcaclsRunnerForTests(async () => timeout);
    await expect(hardenSecretPathAsync(secretFile(), { required: true })).rejects.toThrow(/ETIMEDOUT/);
    expect(warnings).toEqual([]);
  });

  test("async permission failure still throws on required paths", async () => {
    setAsyncIcaclsRunnerForTests(async () => denied);
    let caught: unknown;
    try {
      await hardenSecretPathAsync(secretFile(), { required: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as NodeJS.ErrnoException).code).toBe("EICACLS");
    expect((caught as Error).message).toMatch(/EICACLS/);
  });

  test("timeoutMemoKey shares the timeout cache across distinct temp paths", async () => {
    setAsyncIcaclsRunnerForTests(async () => timeout);
    const dest = join(testDir, "responses-state.json");
    const tempA = join(testDir, "responses-state.json.ocx.1.1.tmp");
    const tempB = join(testDir, "responses-state.json.ocx.1.2.tmp");
    writeFileSync(tempA, "a", "utf-8");
    writeFileSync(tempB, "b", "utf-8");

    await expect(hardenSecretPathAsync(tempA, { required: true, timeoutMemoKey: dest })).rejects.toThrow(/ETIMEDOUT/);

    let calls = 0;
    setAsyncIcaclsRunnerForTests(async () => {
      calls += 1;
      return timeout;
    });
    await expect(hardenSecretPathAsync(tempB, { required: true, timeoutMemoKey: dest })).rejects.toThrow(/skipped/);
    expect(calls).toBe(0); // destination-keyed memo; not a parent-directory shortcut
  });

  test("a required timeout preserves ETIMEDOUT and one explicit recovery gets a fresh budget", async () => {
    // Pinned: this asserts that a SECOND call gets a fresh envelope, not the envelope's size.
    process.env.OPENCODEX_ACL_TIMEOUT_MS = "5000";
    const target = secretFile("one-time-recovery.json");
    let now = 0;
    let grantCalls = 0;
    setNowForTests(() => now);
    setAsyncIcaclsRunnerForTests(async args => {
      if (args.includes("/grant:r")) grantCalls += 1;
      if (grantCalls === 1) {
        now = 5_000; // exhaust the first call's entire budget
        return timeout;
      }
      return ok;
    });

    let first: unknown;
    try {
      await hardenSecretPathAsync(target, { required: true });
    } catch (error) {
      first = error;
    }
    expect((first as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
    expect((first as Error).message).not.toContain(target);
    expect(timedOutSecretPathCountForTests()).toBe(1);

    await expect(hardenSecretPathAsync(target, {
      required: true,
      retryTimedOutOnce: true,
    })).resolves.toEqual({ ok: true });
    expect(grantCalls).toBe(2);
    expect(timedOutSecretPathCountForTests()).toBe(0);
  });

  test("the explicit timeout recovery cannot be consumed more than once", async () => {
    // Pinned: this asserts recovery CARDINALITY. At the 30s default the first call would
    // succeed on its internal retry and the cardinality claim would never be exercised.
    process.env.OPENCODEX_ACL_TIMEOUT_MS = "5000";
    const target = secretFile("consumed-recovery.json");
    let now = 0;
    let grantCalls = 0;
    setNowForTests(() => now);
    setAsyncIcaclsRunnerForTests(async args => {
      if (args.includes("/grant:r")) grantCalls += 1;
      now += 5_000;
      return timeout;
    });

    await expect(hardenSecretPathAsync(target, { required: true })).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    await expect(hardenSecretPathAsync(target, {
      required: true,
      retryTimedOutOnce: true,
    })).rejects.toMatchObject({ code: "ETIMEDOUT" });
    const callsAfterRecovery = grantCalls;
    await expect(hardenSecretPathAsync(target, {
      required: true,
      retryTimedOutOnce: true,
    })).rejects.toMatchObject({ code: "EACLRETRYEXHAUSTED" });
    expect(grantCalls).toBe(callsAfterRecovery);
    expect(grantCalls).toBe(2);
    expect(timedOutSecretPathCountForTests()).toBe(1);
  });

  test("optional timeout memo does not poison a later required harden of the same path", () => {
    setIcaclsRunnerForTests(() => timeout);
    const first = hardenSecretPath(secretFile(), { required: false });
    expect(first.ok).toBe(false);

    let calls = 0;
    setIcaclsRunnerForTests(() => {
      calls += 1;
      return ok;
    });
    const second = hardenSecretPath(secretFile(), { required: true });
    expect(second.ok).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });

  test("async harden still grants owner before inheritance removal", async () => {
    const steps: string[] = [];
    setAsyncIcaclsRunnerForTests(async args => {
      if (args.includes("/grant:r")) steps.push("grant-owner");
      else if (args.includes("/inheritance:r")) steps.push("remove-inheritance");
      else if (args.includes("/remove:g")) steps.push("remove-broad");
      return ok;
    });
    expect(await hardenSecretPathAsync(secretFile(), { required: true })).toEqual({ ok: true });
    expect(steps).toEqual(["grant-owner", "remove-inheritance", "remove-broad"]);
  });
});

describe("ephemeral ACL memo release (#840 refinement)", () => {
  const timeout: IcaclsResult = { success: false, exitCode: null, timedOut: true, stdout: "" };

  test("ephemeral release clears temp-keyed timeout memos in BOTH namespaces", () => {
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(() => timeout);
    // Own the environment this test needs. It used to inherit USERNAME from an
    // earlier describe's `??=`, which never restores it: run this file's blocks in
    // another order, or this test alone, and the harden fails before it ever
    // reaches the memo behavior under test.
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    const tempA = join(testDir, "dest.ocx.1.1.tmp");
    const tempB = join(testDir, "dest.ocx.1.2.tmp");
    writeFileSync(tempA, "a", "utf-8");
    writeFileSync(tempB, "b", "utf-8");
    try {
      // required timeout throws; optional timeout soft-fails — both memoize by the temp.
      expect(() => hardenSecretPath(tempA, { required: true })).toThrow(/ETIMEDOUT/);
      expect(hardenSecretPath(tempB, { required: false }).ok).toBe(false);
      expect(timedOutSecretPathCountForTests()).toBe(2);
      forgetEphemeralSecretPath(tempA);
      expect(timedOutSecretPathCountForTests()).toBe(1);
      forgetEphemeralSecretPath(tempB);
      expect(timedOutSecretPathCountForTests()).toBe(0);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("sync atomic write keys timeouts by destination, and the memo survives temp cleanup", () => {
    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    let runnerCalls = 0;
    setIcaclsRunnerForTests(() => {
      runnerCalls += 1;
      return timeout;
    });
    const dest = join(testDir, "config.json");
    // Mirrors the production sync harden in config.ts (POSIX tests cannot reach
    // the process.platform gate): required harden keyed by the DESTINATION.
    const io = {
      write: (path: string, content: string) => writeFileSync(path, content, { mode: 0o600 }),
      harden: (path: string) => {
        chmodSync(path, 0o600);
        hardenSecretPath(path, { required: true, timeoutMemoKey: dest });
      },
      rename: renameSync,
      truncate: (path: string) => truncateSync(path, 0),
      unlink: unlinkSync,
    };
    try {
      expect(() => atomicWriteFile(dest, "first", io)).toThrow();
      // Exactly ONE memo — keyed by the destination, not the unique temp.
      expect(timedOutSecretPathCountForTests()).toBe(1);
      const callsAfterFirst = runnerCalls;
      expect(() => atomicWriteFile(dest, "second", io)).toThrow();
      // Anti-restall: the destination memo short-circuits the second harden
      // (no new runner call) and is NOT cleared by the temp cleanup.
      expect(runnerCalls).toBe(callsAfterFirst);
      expect(timedOutSecretPathCountForTests()).toBe(1);
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
    }
  });
});


/**
 * F4 — the ACL success memo, run against BOTH entry points.
 *
 * These were written for `hardenSecretPath` alone, and an audit then removed the
 * async attribution entirely: all 46 tests stayed green. That is the worse half
 * to leave uncovered — `hardenStableLockFile`, which hardens the coordinator
 * database, calls `hardenSecretPathAsync`
 * (`src/codex/native-main-lock-file.ts:148`), as do `config.ts:292` and
 * `native-profile-manager.ts:153-154`. Covering only the synchronous twin proved
 * the path production does not take.
 */
type HardenFn = (path: string, opts: { required: boolean }) => Promise<HardenResult>;

/**
 * All FOUR public entry points, not two.
 *
 * `hardenSecretDir`/`hardenSecretDirAsync` share the same memo machinery through
 * `hardenedDirectories`, and an audit proved the gap: inserting
 * `if (directory && cache.has(targetPath)) return { ok: true }` — pathname-only
 * satisfaction for directories alone — left all 55 file-only tests green. That
 * reaches real callers: config (`src/config.ts:1292,1760`), management-auth,
 * tray, spill-store, and `native-profile-manager.ts:153`.
 *
 * Each entry carries its own `create`, so a directory case makes a directory.
 */
interface EntryPoint {
  readonly label: string;
  readonly harden: HardenFn;
  readonly create: (path: string) => void;
}

const ENTRY_POINTS: readonly EntryPoint[] = [
  {
    label: "file-sync",
    harden: async (path, opts) => hardenSecretPath(path, opts),
    create: path => writeFileSync(path, "x", "utf8"),
  },
  {
    label: "file-async",
    harden: (path, opts) => hardenSecretPathAsync(path, opts),
    create: path => writeFileSync(path, "x", "utf8"),
  },
  {
    label: "dir-sync",
    harden: async (path, opts) => hardenSecretDir(path, opts),
    create: path => mkdirSync(path, { recursive: true }),
  },
  {
    label: "dir-async",
    harden: (path, opts) => hardenSecretDirAsync(path, opts),
    create: path => mkdirSync(path, { recursive: true }),
  },
];

/**
 * Async on purpose. A synchronous version's `finally` runs the moment the body
 * returns its promise — before a single `await` inside it — so every seam is torn
 * down while the test is still running. The symptom is subtle: the stat seam
 * reverts to the real filesystem and identity checks silently start comparing
 * real inodes, so a test asserting a re-harden sees one that never happened.
 */
async function withWin32(body: () => Promise<void>): Promise<void> {
  setPlatformForTests("win32");
  const previousUsername = process.env.USERNAME;
  process.env.USERNAME = "ocx-test-user";
  try {
    await body();
  } finally {
    if (previousUsername === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = previousUsername;
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    setPlatformForTests(null);
    setStatForTests(null);
  }
}

/** Install the same behavior on both runner seams so one body drives either path. */
function runner(onCall: (args: string[]) => void): void {
  const result = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(args => { onCall(args); return result; });
  setAsyncIcaclsRunnerForTests(async args => { onCall(args); return result; });
}

for (const { label, harden, create } of ENTRY_POINTS) {
  // Files and directories keep separate memos; a case must read its own.
  const memoCount = label.startsWith("dir")
    ? hardenedSecretDirCountForTests
    : hardenedSecretPathCountForTests;

  describe(`F4 memo attribution — ${label} entry point`, () => {
    /**
     * The original defect. The memo was a Set of PATH STRINGS, so unlinking a
     * hardened path and recreating a different file at the same name left the
     * replacement reported as hardened while it had never seen icacls.
     *
     * Ephemeral temps escaped this only because atomic writers call
     * forgetEphemeralSecretPath once the temp is gone (`src/config.ts:214` and
     * friends). Nothing does that for a stable path.
     */
    test("a file replaced at an already-hardened stable path is hardened again", async () => {
      resetHardenedStateForTests();
      const stable = join(testDir, `replaced-${label}.sqlite`);
      create(stable);

      await withWin32(async () => {
        let grants = 0;
        runner(args => { if (args.includes("/grant:r")) grants += 1; });
        // Driven through the seam rather than the real filesystem: ext4 recycles
        // an unlinked inode immediately (100/100 cycles) while APFS recycled none
        // in 200, so a real-file version of this test asserts different things on
        // different platforms — it passed on macOS with a fix broken on Linux.
        let current = { dev: 1n, ino: 10n, ctimeNs: 100n };
        setStatForTests(() => current);

        expect(await harden(stable, { required: true })).toEqual({ ok: true });
        expect(grants).toBe(1);

        current = { dev: 1n, ino: 11n, ctimeNs: 300n };
        expect(await harden(stable, { required: true })).toEqual({ ok: true });
        expect(grants).toBe(2);
      });
    });

    /**
     * "What is at this path now" is not "what did icacls operate on". Swapping
     * the file during the final /remove:g made a post-call read record the
     * REPLACEMENT as hardened, so the next acquisition skipped ACL work on a file
     * that had never seen it.
     */
    test("a file replaced DURING hardening is not credited, and required fails closed", async () => {
      resetHardenedStateForTests();
      const stable = join(testDir, `raced-${label}.sqlite`);
      create(stable);

      await withWin32(async () => {
        let grants = 0;
        let current = { dev: 1n, ino: 10n, ctimeNs: 100n };
        setStatForTests(() => current);
        runner(args => {
          if (args.includes("/grant:r")) grants += 1;
          // Another process replaces the file before the sequence returns.
          if (args.includes("/remove:g")) current = { dev: 1n, ino: 99n, ctimeNs: 500n };
        });

        await expect(harden(stable, { required: true })).rejects.toThrow(
          /changed during hardening/,
        );
        expect(grants).toBe(1);
        // No memo was left for the replacement, so a later harden still runs.
        expect(memoCount()).toBe(0);

        // An optional caller hitting the same race soft-fails with the same
        // honest diagnostic. The runner keeps swapping the file, so this second
        // attempt races too rather than settling on the replacement.
        current = { dev: 1n, ino: 10n, ctimeNs: 100n };
        const optional = await harden(stable, { required: false });
        expect(optional.ok).toBe(false);
        expect(optional.diagnostics).toMatch(/changed during hardening/);
      });
    });

    /**
     * The bug the object/freshness split exists to prevent.
     *
     * icacls changes permissions and a permission change moves ctime — probed
     * directly, {ctimeChangedByChmod: true}. Requiring the FULL identity to be
     * unchanged across the ACL call rejects its own successful work, so on
     * Windows every first harden of every path would have failed closed.
     */
    test("ctime moving during hardening is the ACL's own doing, not a substitution", async () => {
      resetHardenedStateForTests();
      const stable = join(testDir, `acl-ctime-${label}.sqlite`);
      create(stable);

      await withWin32(async () => {
        let grants = 0;
        let ctime = 100n;
        setStatForTests(() => ({ dev: 1n, ino: 10n, ctimeNs: ctime }));
        runner(args => {
          if (args.includes("/grant:r")) grants += 1;
          ctime += 1n; // editing the DACL moves ctime; same file throughout
        });

        expect(await harden(stable, { required: true })).toEqual({ ok: true });
        expect(grants).toBe(1);
        // The memo kept the POST-harden freshness, so this is a no-op rather
        // than an endless re-harden.
        expect(await harden(stable, { required: true })).toEqual({ ok: true });
        expect(grants).toBe(1);
      });
    });

    /**
     * Each identity component is proven on its own. Earlier tests mirrored the
     * implementation's identity string in their setup, which is not coverage of
     * it: removing `dev` from production left all forty tests green.
     */
    const components: { name: string; second: { dev: bigint; ino: bigint; ctimeNs: bigint } }[] = [
      // The path resolves to another device: a different object entirely.
      { name: "dev", second: { dev: 2n, ino: 10n, ctimeNs: 100n } },
      // Ordinary replacement where the filesystem does not recycle inodes.
      { name: "ino", second: { dev: 1n, ino: 11n, ctimeNs: 100n } },
      // The ext4 case: the same inode handed straight back, only ctime moved.
      { name: "ctimeNs", second: { dev: 1n, ino: 10n, ctimeNs: 200n } },
    ];

    for (const { name, second } of components) {
      test(`a change in ${name} alone forces a re-harden`, async () => {
        resetHardenedStateForTests();
        const stable = join(testDir, `component-${name}-${label}.sqlite`);
        create(stable);

        await withWin32(async () => {
          let grants = 0;
          runner(args => { if (args.includes("/grant:r")) grants += 1; });
          let current = { dev: 1n, ino: 10n, ctimeNs: 100n };
          setStatForTests(() => current);

          expect(await harden(stable, { required: true })).toEqual({ ok: true });
          expect(grants).toBe(1);
          expect(await harden(stable, { required: true })).toEqual({ ok: true });
          expect(grants).toBe(1);

          current = second;
          expect(await harden(stable, { required: true })).toEqual({ ok: true });
          expect(grants).toBe(2);
        });
      });
    }

    /**
     * A memo lookup that cannot see what is at the path NOW must not answer.
     * A mutation turning "cannot observe" into "satisfied" survived every other
     * broken-change check, because all of them could still observe the file.
     */
    test("a stat failure after a successful harden forces the harden to run again", async () => {
      resetHardenedStateForTests();
      const stable = join(testDir, `unreadable-${label}.sqlite`);
      create(stable);

      await withWin32(async () => {
        let grants = 0;
        runner(args => { if (args.includes("/grant:r")) grants += 1; });
        let readable = true;
        setStatForTests(() => {
          if (!readable) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          return { dev: 1n, ino: 10n, ctimeNs: 100n };
        });

        expect(await harden(stable, { required: true })).toEqual({ ok: true });
        expect(grants).toBe(1);

        readable = false;
        await expect(harden(stable, { required: true })).rejects.toThrow(
          /changed during hardening/,
        );
        expect(grants).toBe(2);
        expect(memoCount()).toBe(0);
      });
    });

    /**
     * NTFS is reported to return a zero inode from the non-bigint stat, and the
     * guard treats zero as unobservable. That guard had no test at all: removing
     * it left every case green, because none ever produced one.
     */
    test("a zero inode is unobservable, not an identity", async () => {
      resetHardenedStateForTests();
      const stable = join(testDir, `zero-ino-${label}.sqlite`);
      create(stable);

      await withWin32(async () => {
        let grants = 0;
        runner(args => { if (args.includes("/grant:r")) grants += 1; });
        setStatForTests(() => ({ dev: 1n, ino: 0n, ctimeNs: 100n }));

        await expect(harden(stable, { required: true })).rejects.toThrow(
          /changed during hardening/,
        );
        expect(grants).toBe(1);
        expect(memoCount()).toBe(0);
      });
    });

    /**
     * Observed absence retires the memo. Otherwise a success entry outlives the
     * file it describes, and any later file whose identity happens to match
     * satisfies the cache. Microsoft documents that Windows file IDs may be
     * reused over time, so this is not a hypothetical on the target platform.
     */
    test("observing the path absent retires its success memo", async () => {
      resetHardenedStateForTests();
      const stable = join(testDir, `vanishes-${label}.sqlite`);
      create(stable);

      await withWin32(async () => {
        runner(() => {});
        setStatForTests(() => ({ dev: 1n, ino: 10n, ctimeNs: 100n }));

        expect(await harden(stable, { required: true })).toEqual({ ok: true });
        expect(memoCount()).toBe(1);

        rmSync(stable, { recursive: true, force: true });
        expect(await harden(stable, { required: true })).toEqual({ ok: true });
        expect(memoCount()).toBe(0);
      });
    });
  });
}

describe("hardenStableLockFile — the production call edge, not just the primitive", () => {
  /**
   * The gap this closes was invisible for three audit rounds.
   *
   * `hardenStableLockFile` is what actually hardens the coordinator database, via
   * `native-main-claim.ts:81` and `native-main-owner.ts:147`. Deleting its entire
   * Windows ACL delegation left 86 tests green across three files — because every
   * test proved the primitive, and nothing proved production still called it.
   *
   * So this asserts the edge itself: on win32 the required async hardener runs
   * against that exact path, and its failure propagates rather
   * than leaving a coordinator database other accounts can read.
   */
  test("on win32 it delegates to the required async hardener for that exact path", async () => {
    resetHardenedStateForTests();
    const lockPath = join(testDir, "coordinator-claim.sqlite");
    writeFileSync(lockPath, "x", "utf8");

    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    const seen: string[][] = [];
    setAsyncIcaclsRunnerForTests(async args => {
      seen.push(args);
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    try {
      await hardenStableLockFile(lockPath, "win32");
      // The ACL sequence ran against this exact path.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(args => args[0] === lockPath)).toBe(true);
      expect(seen.some(args => args.includes("/grant:r"))).toBe(true);
      // The redundant `timeoutMemoKey: path` argument was REMOVED from this call
      // site rather than asserted. `timeoutMemoKey()` already falls back to
      // `targetPath`, so passing the target path had no observable effect and any
      // test pinning it would have passed with the mechanism gone. The option
      // exists for atomic writers that mint a fresh temp per write and need the
      // stable destination as the key (#612); this caller has no temp.
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setAsyncIcaclsRunnerForTests(null);
      setPlatformForTests(null);
    }
  });

  test("a required ACL failure propagates instead of leaving the file unhardened", async () => {
    resetHardenedStateForTests();
    const lockPath = join(testDir, "coordinator-fails.sqlite");
    writeFileSync(lockPath, "x", "utf8");

    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    setAsyncIcaclsRunnerForTests(async () => ({
      success: false, exitCode: 5, timedOut: false, stdout: "", stderr: "",
    }));
    try {
      await expect(hardenStableLockFile(lockPath, "win32")).rejects.toThrow();
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setAsyncIcaclsRunnerForTests(null);
      setPlatformForTests(null);
    }
  });

  /**
   * On POSIX the mode IS the mechanism — there is no ACL fallback — so this
   * asserts the resulting bits, not merely that no ACL command ran.
   *
   * Asserting absence alone is what let an audit delete `chmodSync` outright
   * with 89 tests still green. An existing permissive database is not repaired
   * by reopening it with creation mode 0600, so "no ACL command ran" was true of
   * both the working and the broken implementation.
   */
  test("on posix it narrows an existing permissive file to 0600 and runs no ACL command", async () => {
    resetHardenedStateForTests();
    const lockPath = join(testDir, "coordinator-posix.sqlite");
    writeFileSync(lockPath, "x", "utf8");
    chmodSync(lockPath, 0o644);
    // Windows does not expose POSIX mode bits faithfully even when this test
    // forces the caller's platform branch to Linux. Keep the real mode proof on
    // POSIX hosts; on Windows this case still proves no ACL command is invoked.
    if (process.platform !== "win32") {
      expect(statSync(lockPath).mode & 0o777).toBe(0o644);
    }

    let calls = 0;
    setAsyncIcaclsRunnerForTests(async () => {
      calls += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    try {
      await hardenStableLockFile(lockPath, "linux");
      if (process.platform !== "win32") {
        expect(statSync(lockPath).mode & 0o777).toBe(0o600);
      }
      expect(calls).toBe(0);
    } finally {
      setAsyncIcaclsRunnerForTests(null);
    }
  });

  /**
   * And a POSIX chmod failure may not be swallowed. It was, unconditionally,
   * which told the caller a coordinator database had been hardened when its
   * permissive bits were untouched and no ACL fallback exists off Windows.
   */
  test("on posix a chmod failure propagates rather than reporting success", async () => {
    resetHardenedStateForTests();
    const missing = join(testDir, "never-created.sqlite");
    await expect(hardenStableLockFile(missing, "linux")).rejects.toThrow();
  });
});

describe("the production default hardener is reached, with the resolved platform", () => {
  /**
   * The symmetric hole, found twice.
   *
   * `native-main-claim.ts` and `native-main-owner.ts` both default to
   * `hardenStableLockFile` when no `hardenPath` is injected, and nearly every
   * test in their own files injects one. An audit replaced each default with a
   * no-op and 91 tests stayed green.
   *
   * Threading the resolved `platform` into that default is the other half. A
   * test that omits `platform` cannot tell a threaded platform from a wrapper
   * re-reading `process.platform`, because on this host they agree. So these
   * force `platform: "win32"` from the OUTER API, inject no `hardenPath`, and
   * require the real ACL runner to execute — which can only happen if the
   * default is called AND the platform reached it.
   */
  const forcedWindows = async (
    run: (codexHome: string) => Promise<void>,
    onGrant: () => void = () => {},
    gate?: Promise<void>,
    resultFor?: (args: string[]) => IcaclsResult | Promise<IcaclsResult>,
  ): Promise<string[][]> => {
    const seen: string[][] = [];
    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    setAsyncIcaclsRunnerForTests(async args => {
      seen.push(args);
      if (args.includes("/grant:r")) onGrant();
      // A deferred runner lets a test observe the window WHILE hardening is in
      // flight, which is the only way to assert nothing was published early.
      if (gate) await gate;
      return resultFor
        ? await resultFor(args)
        : { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-default-harden-"));
    try {
      await run(codexHome);
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setAsyncIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      rmSync(codexHome, { recursive: true, force: true });
    }
    return seen;
  };

  test("a claim with no hardenPath runs the real ACL sequence under a forced win32", async () => {
    resetHardenedStateForTests();
    let expected = "";
    let operationStarted = false;
    let result: unknown;
    let releaseAcl!: () => void;
    const aclBlocked = new Promise<void>(done => { releaseAcl = done; });
    const seen = await forcedWindows(async codexHome => {
      expected = nativeMainClaimPath({ codexHome } as never);
      const claim = withNativeMainSharedClaim(
        { codexHome } as never,
        async () => { operationStarted = true; return "operation-ran"; },
        { platform: "win32" },
      );
      // Recording "acl started" and then "operation" only proves the ACL BEGAN
      // first. Wrapping the harden in Promise.race([harden, sleep(1)]) — an
      // early continuation that on real Windows would let icacls still be in
      // flight — passed that version of this test. So hold the ACL unresolved
      // and require that the operation has NOT started.
      await Bun.sleep(30);
      expect(operationStarted).toBe(false);
      releaseAcl();
      result = await claim;
      expect(operationStarted).toBe(true);
    }, () => {}, aclBlocked);
    expect(seen.some(args => args.includes("/grant:r"))).toBe(true);
    // The SUCCESS path, which "some ACL ran" cannot see: the protected operation
    // actually ran and its value came back. A claim that hardens and then
    // silently skips its operation passed every other assertion here.
    expect(result).toBe("operation-ran");
    // The EXACT target, not merely that some ACL ran. Redirecting the caller at
    // an unrelated existing file passed every other dimension of this test.
    expect(seen.every(args => args[0] === expected)).toBe(true);
  });

  test("an owner with no hardenPath runs the real ACL sequence under a forced win32", async () => {
    resetHardenedStateForTests();
    let expected = "";
    const trace: string[] = [];
    let releaseAcl!: () => void;
    const aclBlocked = new Promise<void>(done => { releaseAcl = done; });
    const seen = await forcedWindows(async codexHome => {
      expected = join(codexHome, NATIVE_MAIN_OWNER_DB);
      const owner = retainNativeMainOwner({ codexHome } as never, { platform: "win32", retryMs: 10 });
      const unsubscribe = owner.subscribe(snapshot => { trace.push(snapshot.status); });
      try {
        // While the ACL is still in flight the owner may NOT report held: that
        // would be a caller believing it owns a database whose hardening has not
        // finished. Ordering is the claim, and no terminal snapshot can make it.
        await Bun.sleep(30);
        expect(trace).toEqual(["acquiring"]);
        releaseAcl();

        const deadline = Date.now() + 5_000;
        while (owner.snapshot().status === "acquiring" && Date.now() < deadline) {
          await Bun.sleep(10);
        }
        // And it must actually SUCCEED. Every earlier version accepted any
        // non-acquiring state, so an owner that hardened correctly and then
        // failed to acquire passed.
        expect(owner.snapshot()).toMatchObject({ status: "held" });
        expect(trace).toEqual(["acquiring", "held"]);
      } finally {
        unsubscribe();
        await owner.release();
      }
    }, () => {}, aclBlocked);
    expect(seen.some(args => args.includes("/grant:r"))).toBe(true);
    expect(seen.every(args => args[0] === expected)).toBe(true);
  });

  test("the production owner default consumes one timeout memo and then acquires", async () => {
    resetHardenedStateForTests();
    let now = 0;
    let grantAttempts = 0;
    const trace: string[] = [];
    let expected = "";
    setNowForTests(() => now);
    try {
      const seen = await forcedWindows(async codexHome => {
        expected = join(codexHome, NATIVE_MAIN_OWNER_DB);
        const owner = retainNativeMainOwner(
          { codexHome } as never,
          { platform: "win32", retryMs: 10 },
        );
        const unsubscribe = owner.subscribe(snapshot => { trace.push(snapshot.status); });
        try {
          const deadline = Date.now() + 5_000;
          while (owner.snapshot().status === "acquiring" && Date.now() < deadline) {
            await Bun.sleep(10);
          }
          expect(owner.snapshot()).toMatchObject({ status: "held" });
        } finally {
          unsubscribe();
          await owner.release();
        }
      }, () => {}, undefined, args => {
        if (args.includes("/grant:r")) {
          grantAttempts += 1;
          if (grantAttempts === 1) {
            now = 5_000;
            return { success: false, exitCode: null, timedOut: true, stdout: "" };
          }
        }
        return { success: true, exitCode: 0, timedOut: false, stdout: "" };
      });
      expect(trace).toEqual(["acquiring", "held"]);
      expect(grantAttempts).toBe(2);
      expect(seen.every(args => args[0] === expected)).toBe(true);
    } finally {
      setNowForTests(null);
    }
  });
});

describe("a required hardening failure stops the operation it protects", () => {
  /**
   * Proving the default hardener RUNS is not proving its failure matters.
   *
   * Appending `.catch(() => {})` at either call site left 93 tests green: the
   * forced-Windows tests above observe a successful invocation, and the
   * wrapper's own failure test cannot see a caller swallowing the rejection.
   *
   * What is at stake is the whole point of `required: true` — a coordinator
   * database whose ACL could not be applied must not go on to be used, because
   * on Windows the ACL is the only thing keeping other accounts out of it.
   */
  const forcedWindowsFailure = async (
    run: (codexHome: string) => Promise<void>,
    onAttempt: (args: string[]) => void = () => {},
  ): Promise<void> => {
    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    setAsyncIcaclsRunnerForTests(async args => {
      // Count only the first step of each sequence, so the counter is attempts
      // rather than icacls invocations.
      if (args.includes("/grant:r")) onAttempt(args);
      return { success: false, exitCode: 5, timedOut: false, stdout: "", stderr: "" };
    });
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-harden-fail-"));
    try {
      await run(codexHome);
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setAsyncIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      rmSync(codexHome, { recursive: true, force: true });
    }
  };

  test("a claim whose ACL cannot be applied never runs its operation", async () => {
    resetHardenedStateForTests();
    let operationRan = false;
    const targets: string[] = [];
    let expected = "";
    await forcedWindowsFailure(async codexHome => {
      expected = nativeMainClaimPath({ codexHome } as never);
      // The exact code matters, not merely that it threw. A denied ACL is a
      // permanent refusal; classifying it as BUSY would send a caller back to
      // retry something that will fail identically forever. Broadening isBusy()
      // to match the ACL message passed a test that only asserted "rejects".
      let code: string | undefined;
      try {
        await withNativeMainSharedClaim(
          { codexHome } as never,
          async () => { operationRan = true; },
          { platform: "win32" },
        );
        throw new Error("expected the claim to refuse");
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe("NATIVE_MAIN_CLAIM_UNAVAILABLE");
    }, args => { targets.push(args[0]!); });
    expect(operationRan).toBe(false);
    expect(targets).toEqual([expected]);
  });

  /**
   * Asserted as an ORDERED TRACE, not a terminal snapshot.
   *
   * This is the generalization that should have come eight rounds earlier. Every
   * previous version of this test read `owner.snapshot()` after the fact, and a
   * final snapshot structurally cannot prove that something never happened: an
   * implementation publishing `held` and then immediately `unavailable` passed,
   * while every subscriber saw the forbidden intermediate state.
   *
   * So subscribe first, record every published state, and assert the whole
   * sequence plus the events that must be absent.
   */
  test("an owner whose ACL cannot be applied goes acquiring -> unavailable, with no held, contended, or retry", async () => {
    resetHardenedStateForTests();
    let hardenAttempts = 0;
    const targets: string[] = [];
    let expected = "";
    await forcedWindowsFailure(async codexHome => {
      expected = join(codexHome, NATIVE_MAIN_OWNER_DB);
      const owner = retainNativeMainOwner({ codexHome } as never, { platform: "win32", retryMs: 10 });
      let second: ReturnType<typeof retainNativeMainOwner> | undefined;
      const trace: string[] = [];
      const unsubscribe = owner.subscribe(snapshot => { trace.push(snapshot.status); });
      try {
        const deadline = Date.now() + 5_000;
        while (owner.snapshot().status === "acquiring" && Date.now() < deadline) {
          await Bun.sleep(10);
        }
        // Long enough for a scheduled retry (retryMs: 10) to have fired.
        await Bun.sleep(60);

        expect(owner.snapshot()).toMatchObject({
          status: "unavailable",
          reason: "lock-unavailable",
        });
        // `held` would mean a caller briefly believed it owned an unhardened
        // database; `contended` schedules a retry, turning a permanent denial
        // into an endless reacquire loop. Neither may appear at any point.
        expect(trace).not.toContain("held");
        expect(trace).not.toContain("contended");
        // The RAW history, undeduplicated. Collapsing consecutive duplicates was
        // itself the defect the previous version shipped: a retry loop
        // republishing `unavailable` normalizes to the same two entries, so the
        // test claimed "no retry churn" while discarding the churn. Never project
        // an event trace unless the projection is part of the contract.
        expect(trace).toEqual(["acquiring", "unavailable"]);
        // And the ACL was attempted exactly once: a hidden retry would harden again.
        expect(hardenAttempts).toBe(1);
        // Exactly one attempt, against exactly the owner's own database.
        expect(targets).toEqual([expected]);
        second = retainNativeMainOwner({ codexHome } as never, { platform: "win32", retryMs: 10 });
        await Bun.sleep(60);
        expect(second.snapshot()).toMatchObject({ status: "unavailable" });
        expect(hardenAttempts).toBe(1);
      } finally {
        unsubscribe();
        if (second) await second.release();
        await owner.release();
      }
    }, args => { hardenAttempts += 1; targets.push(args[0]!); });
  });
});

/**
 * Failure POLICY, across all four entry points.
 *
 * The memo-attribution matrix above is parameterized over all four, but the
 * failure-policy tests were written only against the file APIs. Four
 * directory-only mutations survived the whole suite: required soft-failing on an
 * ordinary failure, required soft-failing on a timeout, optional throwing on an
 * ordinary failure, and optional throwing on a timeout. The production code was
 * right in each case; nothing executable said so.
 *
 * That is the same projection class one level up — parameterizing one property
 * over four entry points does not parameterize the others.
 */
for (const { label, harden, create } of ENTRY_POINTS) {
  describe(`failure policy — ${label} entry point`, () => {
    const withFailingAcl = async (
      result: IcaclsResult,
      body: (target: string) => Promise<void>,
    ): Promise<void> => {
      resetHardenedStateForTests();
      const target = join(testDir, `policy-${label}-${result.timedOut ? "timeout" : "error"}`);
      create(target);
      setPlatformForTests("win32");
      const previousUsername = process.env.USERNAME;
      process.env.USERNAME = "ocx-test-user";
      setIcaclsRunnerForTests(() => result);
      setAsyncIcaclsRunnerForTests(async () => result);
      try {
        await body(target);
      } finally {
        if (previousUsername === undefined) delete process.env.USERNAME;
        else process.env.USERNAME = previousUsername;
        setIcaclsRunnerForTests(null);
        setAsyncIcaclsRunnerForTests(null);
        setPlatformForTests(null);
      }
    };

    const ordinaryFailure: IcaclsResult = {
      success: false, exitCode: 5, timedOut: false, stdout: "", stderr: "",
    };
    const timeout: IcaclsResult = {
      success: false, exitCode: null, timedOut: true, stdout: "", stderr: "",
    };

    test("required fails closed on an ordinary ACL failure", async () => {
      await withFailingAcl(ordinaryFailure, async target => {
        await expect(harden(target, { required: true })).rejects.toThrow();
      });
    });

    test("required fails closed on a timeout", async () => {
      await withFailingAcl(timeout, async target => {
        await expect(harden(target, { required: true })).rejects.toThrow();
      });
    });

    test("optional soft-fails on an ordinary ACL failure, with a diagnostic", async () => {
      await withFailingAcl(ordinaryFailure, async target => {
        const result = await harden(target, { required: false });
        expect(result.ok).toBe(false);
        expect(typeof result.diagnostics).toBe("string");
        expect(result.diagnostics!.length).toBeGreaterThan(0);
      });
    });

    test("optional soft-fails on a timeout, with a diagnostic", async () => {
      await withFailingAcl(timeout, async target => {
        const result = await harden(target, { required: false });
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toMatch(/timed out|ETIMEDOUT/i);
      });
    });
  });
}

for (const { label, harden, create } of ENTRY_POINTS) {
  const memoCount = label.startsWith("dir")
    ? hardenedSecretDirCountForTests
    : hardenedSecretPathCountForTests;

  describe(`a memo entry proven wrong is retired, not kept — ${label}`, () => {
    /**
     * The cache state nothing justified.
     *
     * `memoSatisfied` used to return false on a mismatch and leave the entry in
     * place, so after a mismatch and a failed re-harden the stale value survived
     * and restoring the old identity satisfied it again with no ACL work. Biting
     * that needs exact-identity ABA, outside this unit's proof bound — but scope
     * is not a reason to keep an entry proven not to describe what is at the path.
     *
     * Parameterized over all four entry points because the retirement is shared
     * machinery and the first version tested only `hardenSecretPath`: restricting
     * the deletion to non-directory caches passed all 113 tests.
     */
    test("a mismatch retires the entry even when the re-harden then fails", async () => {
      resetHardenedStateForTests();
      const target = join(testDir, `retired-${label}.sqlite`);
      create(target);

      await withWin32(async () => {
        let grants = 0;
        let aclSucceeds = true;
        const result = () => (aclSucceeds
          ? { success: true, exitCode: 0, timedOut: false, stdout: "" }
          : { success: false, exitCode: 5, timedOut: false, stdout: "", stderr: "" });
        setIcaclsRunnerForTests(args => {
          if (args.includes("/grant:r")) grants += 1;
          return result();
        });
        setAsyncIcaclsRunnerForTests(async args => {
          if (args.includes("/grant:r")) grants += 1;
          return result();
        });

        const original = { dev: 1n, ino: 10n, ctimeNs: 100n };
        let current = original;
        setStatForTests(() => current);

        expect(await harden(target, { required: true })).toEqual({ ok: true });
        expect(grants).toBe(1);
        expect(memoCount()).toBe(1);

        // Something else is at the path, and the re-harden FAILS. A successful
        // re-harden would overwrite the memo and hide whether the miss retired
        // it — which is what a first version of this test did.
        current = { dev: 1n, ino: 11n, ctimeNs: 500n };
        aclSucceeds = false;
        await expect(harden(target, { required: true })).rejects.toThrow();
        expect(grants).toBe(2);
        expect(memoCount()).toBe(0);

        // And restoring the original identity is not silently re-satisfied.
        current = original;
        aclSucceeds = true;
        expect(await harden(target, { required: true })).toEqual({ ok: true });
        expect(grants).toBe(3);
      });
    });

    /**
     * The unreadable branch, isolated from `recordHarden`.
     *
     * Letting the ACL succeed here proves nothing: `recordHarden` would delete
     * the entry for its own reasons, so a terminal count of zero cannot say WHICH
     * mechanism retired it. Retaining the memo specifically when the observation
     * is unreadable passed that version. So the ACL fails BEFORE `recordHarden`
     * runs, and the re-satisfaction check is what shows the lookup retired it.
     */
    test("an unreadable observation retires the entry, and the lookup is what does it", async () => {
      resetHardenedStateForTests();
      const target = join(testDir, `retired-unreadable-${label}.sqlite`);
      create(target);

      await withWin32(async () => {
        let grants = 0;
        let aclSucceeds = true;
        const result = () => (aclSucceeds
          ? { success: true, exitCode: 0, timedOut: false, stdout: "" }
          : { success: false, exitCode: 5, timedOut: false, stdout: "", stderr: "" });
        setIcaclsRunnerForTests(args => {
          if (args.includes("/grant:r")) grants += 1;
          return result();
        });
        setAsyncIcaclsRunnerForTests(async args => {
          if (args.includes("/grant:r")) grants += 1;
          return result();
        });

        const identity = { dev: 1n, ino: 10n, ctimeNs: 100n };
        let readable = true;
        setStatForTests(() => {
          if (!readable) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          return identity;
        });

        expect(await harden(target, { required: true })).toEqual({ ok: true });
        expect(grants).toBe(1);
        expect(memoCount()).toBe(1);

        // Unreadable AND the ACL fails, so recordHarden never reaches its own
        // deletion: whatever retires the entry here is the lookup.
        readable = false;
        aclSucceeds = false;
        await expect(harden(target, { required: true })).rejects.toThrow();
        expect(grants).toBe(2);
        expect(memoCount()).toBe(0);

        // Restoring the exact original identity must not be silently satisfied.
        readable = true;
        aclSucceeds = true;
        expect(await harden(target, { required: true })).toEqual({ ok: true });
        expect(grants).toBe(3);
      });
    });
  });
}

/**
 * Memo attribution across the full cross-product.
 *
 * Four public entry points x {required, optional} x how the memo can be wrong.
 * That last axis is itself two axes, which took two rounds to see:
 *
 *   - WHICH identity component moved: dev alone, ino alone, freshness alone. A
 *     memo that ignores freshness but still compares dev:ino passed a matrix
 *     whose "stale" case moved both ino and ctimeNs together.
 *   - WHY the identity is unobservable: a thrown stat, or a zero inode. Both
 *     produce observe() === null, and the zero-inode case is the one NTFS is
 *     reported to produce — so testing only EACCES leaves the platform this
 *     module exists for uncovered.
 *
 * Requiredness runs through all of it. Optional means a failure is REPORTED
 * rather than thrown; it never means the memo may describe a different file, an
 * unobservable one, or one that is gone.
 */
const IDENTITY_MOVES = [
  { name: "dev-only", to: { dev: 2n, ino: 10n, ctimeNs: 100n } },
  { name: "ino-only", to: { dev: 1n, ino: 11n, ctimeNs: 100n } },
  { name: "freshness-only", to: { dev: 1n, ino: 10n, ctimeNs: 200n } },
] as const;

const UNOBSERVABLE = [
  { name: "stat throws", stat: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } },
  // NTFS is reported to return a zero inode from this stat form; observe()
  // treats that as unobservable, and it had only ever been driven required.
  { name: "zero inode", stat: () => ({ dev: 1n, ino: 0n, ctimeNs: 100n }) },
] as const;

for (const { label, harden, create } of ENTRY_POINTS) {
  const memoCount = label.startsWith("dir")
    ? hardenedSecretDirCountForTests
    : hardenedSecretPathCountForTests;

  for (const required of [true, false]) {
    const mode = required ? "required" : "optional";
    const expectRefused = async (target: string): Promise<void> => {
      if (required) {
        await expect(harden(target, { required })).rejects.toThrow();
        return;
      }
      const result = await harden(target, { required });
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toBeTruthy();
    };

    /** Both runner seams, so one body drives the sync and async entry points. */
    const runner = (onGrant: () => void, succeeds: () => boolean): void => {
      const result = () => (succeeds()
        ? { success: true, exitCode: 0, timedOut: false, stdout: "" }
        : { success: false, exitCode: 5, timedOut: false, stdout: "", stderr: "" });
      setIcaclsRunnerForTests(args => {
        if (args.includes("/grant:r")) onGrant();
        return result();
      });
      setAsyncIcaclsRunnerForTests(async args => {
        if (args.includes("/grant:r")) onGrant();
        return result();
      });
    };

    describe(`memo attribution — ${label} / ${mode}`, () => {
      for (const move of IDENTITY_MOVES) {
        test(`a ${move.name} change retires the memo even when the re-harden fails`, async () => {
          resetHardenedStateForTests();
          const target = join(testDir, `attr-${move.name}-${label}-${mode}.sqlite`);
          create(target);

          await withWin32(async () => {
            let grants = 0;
            let aclSucceeds = true;
            runner(() => { grants += 1; }, () => aclSucceeds);

            const original = { dev: 1n, ino: 10n, ctimeNs: 100n };
            let current: { dev: bigint; ino: bigint; ctimeNs: bigint } = original;
            setStatForTests(() => current);

            expect(await harden(target, { required })).toEqual({ ok: true });
            expect(grants).toBe(1);
            expect(memoCount()).toBe(1);

            // One component moves, and the re-harden FAILS — a successful one
            // would overwrite the memo and hide whether the miss retired it.
            current = move.to;
            aclSucceeds = false;
            await expectRefused(target);
            expect(grants).toBe(2);
            expect(memoCount()).toBe(0);

            // Restoring the original identity is not silently re-satisfied.
            current = original;
            aclSucceeds = true;
            expect(await harden(target, { required })).toEqual({ ok: true });
            expect(grants).toBe(3);
          });
        });
      }

      for (const cause of UNOBSERVABLE) {
        test(`an identity unobservable because ${cause.name} does not answer`, async () => {
          resetHardenedStateForTests();
          const target = join(testDir, `attr-unobs-${cause.name.replace(/\s+/g, "-")}-${label}-${mode}.sqlite`);
          create(target);

          await withWin32(async () => {
            let grants = 0;
            let aclSucceeds = true;
            runner(() => { grants += 1; }, () => aclSucceeds);

            let observable = true;
            setStatForTests(() => (observable
              ? { dev: 1n, ino: 10n, ctimeNs: 100n }
              : cause.stat()));

            expect(await harden(target, { required })).toEqual({ ok: true });
            expect(grants).toBe(1);
            expect(memoCount()).toBe(1);

            // Unobservable AND the ACL fails, so recordHarden never reaches its
            // own deletion: whatever retires the entry here is the lookup.
            observable = false;
            aclSucceeds = false;
            await expectRefused(target);
            expect(grants).toBe(2);
            expect(memoCount()).toBe(0);

            observable = true;
            aclSucceeds = true;
            expect(await harden(target, { required })).toEqual({ ok: true });
            expect(grants).toBe(3);
          });
        });
      }

      test("observed absence retires the memo", async () => {
        resetHardenedStateForTests();
        const target = join(testDir, `attr-absent-${label}-${mode}.sqlite`);
        create(target);

        await withWin32(async () => {
          let grants = 0;
          runner(() => { grants += 1; }, () => true);
          const identity = { dev: 1n, ino: 10n, ctimeNs: 100n };
          setStatForTests(() => identity);

          expect(await harden(target, { required })).toEqual({ ok: true });
          expect(grants).toBe(1);
          expect(memoCount()).toBe(1);

          // Gone. A harden of an absent path is a no-op that must still forget it.
          rmSync(target, { recursive: true, force: true });
          expect(await harden(target, { required })).toEqual({ ok: true });
          expect(grants).toBe(1);
          expect(memoCount()).toBe(0);

          // Back at the SAME identity: it must harden again rather than be
          // satisfied by an entry that outlived the file it described.
          create(target);
          expect(await harden(target, { required })).toEqual({ ok: true });
          expect(grants).toBe(2);
        });
      });
    });
  }
}
