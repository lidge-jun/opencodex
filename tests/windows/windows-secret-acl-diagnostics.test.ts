/**
 * Failure-diagnostics contract for src/lib/windows-secret-acl.ts.
 *
 * A required ACL failure used to surface only a sanitized message and a code —
 * "icacls exited 5" with no record of WHICH step or stage failed, what budget
 * it was given, or how long it ran. The error now also carries `aclFailure`:
 * a bounded record of fixed enum literals and finite numbers, copied
 * field-by-field through the same allowlist boundary as the error code.
 *
 * What these tests defend is the boundary, not just the fields: nothing a
 * child, a spawn error, or an injected runner produces — path, argv, SID,
 * stdout, stderr, message or stack — may reach `aclFailure`, the sanitized
 * message, or the diagnostics string.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, renameSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flushWindowsSecretAclReapsBeforeRemoval,
  hardenSecretPath,
  hardenSecretPathAsync,
  resetHardenedStateForTests,
  setAsyncIcaclsBeltSchedulerForTests,
  setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests,
  setNowForTests,
  setPlatformForTests,
  windowsSecretAclReapPendingForPath,
  type AclFailureDiagnostics,
  type IcaclsResult,
} from "../../src/lib/windows-secret-acl";
import { atomicWriteFile } from "../../src/config";
import { setTrustedWindowsElevationExecutablesForTests } from "../../src/lib/windows-elevation";
import {
  resetWindowsPrincipalForTests,
  setAsyncWindowsPrincipalRunnerForTests,
  setWindowsPrincipalRunnerForTests,
} from "../../src/lib/windows-user-principal";

type ThrownAclError = NodeJS.ErrnoException & { aclFailure?: AclFailureDiagnostics };

const ownerSid = "S-1-5-21-111-222-333-1001";
const ownerName = "EXAMPLE\\Owner";

const ok: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const denied = (exitCode = 5): IcaclsResult => ({ success: false, exitCode, timedOut: false, stdout: "" });
const timedOut: IcaclsResult = { success: false, exitCode: null, timedOut: true, stdout: "" };
const principalResult = { success: true, exitCode: 0, timedOut: false, stdout: `${ownerSid}\r\n${ownerName}\r\n` };

let testDir = "";
let previousAclTimeout: string | undefined;
let previousAclVerifyExisting: string | undefined;

function secretFile(name = "secret.json"): string {
  const filePath = join(testDir, name);
  writeFileSync(filePath, "data", "utf-8");
  return filePath;
}

function thrownAclError(fn: () => unknown): ThrownAclError {
  try {
    fn();
  } catch (error) {
    return error as ThrownAclError;
  }
  throw new Error("expected the ACL harden to throw");
}

beforeEach(() => {
  previousAclTimeout = process.env.OPENCODEX_ACL_TIMEOUT_MS;
  delete process.env.OPENCODEX_ACL_TIMEOUT_MS;
  previousAclVerifyExisting = process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  testDir = mkdtempSync(join(tmpdir(), "ocx-acl-diag-"));
  setPlatformForTests("win32");
  resetHardenedStateForTests();
  resetWindowsPrincipalForTests();
  setWindowsPrincipalRunnerForTests(() => ({ ...principalResult }));
  setAsyncWindowsPrincipalRunnerForTests(async () => ({ ...principalResult }));
});

afterEach(() => {
  if (previousAclTimeout === undefined) delete process.env.OPENCODEX_ACL_TIMEOUT_MS;
  else process.env.OPENCODEX_ACL_TIMEOUT_MS = previousAclTimeout;
  if (previousAclVerifyExisting === undefined) delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  else process.env.OPENCODEX_ACL_VERIFY_EXISTING = previousAclVerifyExisting;
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  setAsyncIcaclsBeltSchedulerForTests(null);
  setNowForTests(null);
  setPlatformForTests(null);
  setTrustedWindowsElevationExecutablesForTests(null);
  setWindowsPrincipalRunnerForTests(null);
  setAsyncWindowsPrincipalRunnerForTests(null);
  resetWindowsPrincipalForTests();
  resetHardenedStateForTests();
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("aclFailure diagnostics on required harden errors", () => {
  test("a mid-sequence child failure reports step, stage, exit code, budget and elapsed", () => {
    const filePath = secretFile();
    setIcaclsRunnerForTests(args => (args.includes("/inheritance:r") ? denied(5) : ok));

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    expect(error.code).toBe("EICACLS");
    expect(error.aclFailure).toMatchObject({
      step: "/inheritance:r",
      stage: "child_result",
      success: false,
      exitCode: 5,
      timedOut: false,
    });
    expect(error.aclFailure!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(error.aclFailure!.elapsedMs)).toBe(true);
    expect(error.aclFailure!.budgetMs).toBeGreaterThan(0);
    expect(error.aclFailure!.spawnErrorCode).toBeUndefined();
  });

  test("the icacls step order is preserved and a /remove:g timeout is attributed to /remove:g", () => {
    const filePath = secretFile();
    const calls: string[][] = [];
    setIcaclsRunnerForTests(args => {
      calls.push(args);
      return args.includes("/remove:g") ? timedOut : ok;
    });

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    expect(error.code).toBe("ETIMEDOUT");
    // The post-timeout /findsid state probe appends more calls after the throw;
    // the mutation prefix is the order contract.
    expect(calls.slice(0, 3).map(args => args[1])).toEqual(["/grant:r", "/inheritance:r", "/remove:g"]);
    expect(error.aclFailure).toMatchObject({
      step: "/remove:g",
      stage: "child_result",
      timedOut: true,
      exitCode: null,
      success: false,
    });
  });

  test("a /remove:g denial with surviving SIDs is attributed to /remove:g, not /findsid", () => {
    const filePath = secretFile();
    setIcaclsRunnerForTests(args => {
      if (args.includes("/remove:g")) return denied(3);
      if (args.includes("/findsid")) return { ...ok, stdout: `SID Found: ${filePath}\n` };
      return ok;
    });

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    expect(error.code).toBe("EICACLS");
    expect(error.aclFailure).toMatchObject({ step: "/remove:g", stage: "child_result", exitCode: 3 });
  });

  test("a deadline cutoff before the next spawn is reported as deadline_before_spawn", () => {
    const filePath = secretFile();
    let now = 0;
    setNowForTests(() => now);
    setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) now += 2_000; // the grant eats the whole 1s budget
      return ok;
    });

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true, deadlineMs: 1_000 }));

    expect(error.code).toBe("ETIMEDOUT");
    // The /inheritance:r step never reached the runner: the shared deadline was
    // already gone, which used to read identically to a real child timeout.
    expect(error.aclFailure).toMatchObject({
      step: "/inheritance:r",
      stage: "deadline_before_spawn",
      timedOut: true,
      exitCode: null,
      success: false,
    });
    expect(error.aclFailure!.budgetMs).toBeLessThanOrEqual(0);
    expect(error.aclFailure!.elapsedMs).toBeGreaterThan(0);
  });

  test("a spawn that cannot start is reported as spawn_failed with an allowlisted code", () => {
    const filePath = secretFile();
    // No icacls runner injection: the REAL default runner tries to spawn the
    // trusted executable, which this seam points at a path that cannot exist.
    setTrustedWindowsElevationExecutablesForTests({ icacls: join(testDir, "missing-icacls.exe") });

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    expect(error.code).toBe("EICACLS");
    expect(error.aclFailure).toMatchObject({
      step: "/grant:r",
      stage: "spawn_failed",
      success: false,
      exitCode: null,
      timedOut: false,
    });
    // The only acceptable payload is an allowlisted symbolic code; ENOENT is
    // what a missing executable reports on every supported platform.
    expect(
      error.aclFailure!.spawnErrorCode === undefined || error.aclFailure!.spawnErrorCode === "ENOENT",
    ).toBe(true);
  });

  test("a non-allowlisted spawn code is dropped, and no child output reaches the record", () => {
    const filePath = secretFile();
    const hostile = testDir; // a raw filesystem path masquerading as a spawn code
    setIcaclsRunnerForTests(() => ({
      success: false,
      exitCode: null,
      timedOut: false,
      stdout: "marker-stdout",
      failureStage: "spawn_failed",
      spawnErrorCode: hostile,
    }));

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    expect(error.aclFailure!.stage).toBe("spawn_failed");
    expect(error.aclFailure!.spawnErrorCode).toBeUndefined();
    const serialized = JSON.stringify(error.aclFailure);
    expect(serialized).not.toContain(hostile);
    expect(serialized).not.toContain("marker-stdout");
    expect(serialized).not.toContain(filePath);
    expect(serialized).not.toContain(ownerSid);
    expect(error.message).not.toContain(filePath);
  });

  test("an allowlisted spawn code survives verbatim — ENOENT proves the contract, not just its absence", () => {
    const filePath = secretFile();
    setIcaclsRunnerForTests(() => ({
      success: false,
      exitCode: null,
      timedOut: false,
      stdout: "",
      failureStage: "spawn_failed",
      spawnErrorCode: "ENOENT",
    }));

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    expect(error.code).toBe("EICACLS");
    expect(error.aclFailure).toMatchObject({
      step: "/grant:r",
      stage: "spawn_failed",
      timedOut: false,
      exitCode: null,
    });
    expect(error.aclFailure!.spawnErrorCode).toBe("ENOENT");
  });

  test("mistyped runner fields are coerced, never propagated", () => {
    const filePath = secretFile();
    setIcaclsRunnerForTests(() => ({
      success: false,
      exitCode: "5" as unknown as number,
      timedOut: "yes" as unknown as boolean,
      stdout: "",
    }));

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    // The original truthy contract is kept: a truthy timedOut — even a
    // mistyped one — is a timeout, and the code and the record are coerced
    // from the same Boolean() so they can never disagree. A non-numeric
    // exitCode still collapses to null rather than propagating.
    expect(error.code).toBe("ETIMEDOUT");
    expect(error.aclFailure).toMatchObject({
      stage: "child_result",
      success: false,
      exitCode: null,
      timedOut: true,
    });
  });

  test("the async runner path reports the same bounded record", async () => {
    const filePath = secretFile();
    setAsyncIcaclsRunnerForTests(async args => (args.includes("/grant:r") ? denied(9) : ok));

    const error = await hardenSecretPathAsync(filePath, { required: true }).then(
      () => { throw new Error("expected the async harden to reject"); },
      cause => cause as ThrownAclError,
    );

    expect(error.code).toBe("EICACLS");
    expect(error.aclFailure).toMatchObject({
      step: "/grant:r",
      stage: "child_result",
      success: false,
      exitCode: 9,
      timedOut: false,
    });
  });

  test("an async runner that rejects is runner_rejected, not spawn evidence", async () => {
    const filePath = secretFile();
    setAsyncIcaclsRunnerForTests(async () => {
      throw new Error(`marker-rejection ${filePath}`);
    });

    const error = await hardenSecretPathAsync(filePath, { required: true }).then(
      () => { throw new Error("expected the async harden to reject"); },
      cause => cause as ThrownAclError,
    );

    // Nothing proves a child ever existed, so the stage must not claim a
    // spawn failure — and the raw rejection carries no path to the boundary.
    expect(error.code).toBe("EICACLS");
    expect(error.aclFailure).toMatchObject({
      step: "/grant:r",
      stage: "runner_rejected",
      success: false,
      exitCode: null,
      timedOut: false,
    });
    expect(error.aclFailure!.spawnErrorCode).toBeUndefined();
    expect(JSON.stringify(error.aclFailure)).not.toContain("marker-rejection");
    expect(error.message).not.toContain(filePath);
  });

  test("a caller-side belt that fires first is runner_watchdog and the late reap is tracked", async () => {
    const filePath = secretFile();
    const releases: Array<() => void> = [];
    setAsyncIcaclsRunnerForTests(() => new Promise<IcaclsResult>(resolve => {
      releases.push(() => resolve(ok));
    }));
    // Fire the caller-facing belt immediately through the existing scheduler
    // seam — no timer, no sleep, and the runner stays in flight.
    setAsyncIcaclsBeltSchedulerForTests(callback => {
      callback();
      return () => {};
    });

    try {
      const error = await hardenSecretPathAsync(filePath, { required: true }).then(
        () => { throw new Error("expected the async harden to reject"); },
        cause => cause as ThrownAclError,
      );

      // The belt released the caller while the runner was still unsettled; that
      // is a watchdog verdict, never a fabricated child_result timeout.
      expect(error.code).toBe("ETIMEDOUT");
      expect(error.aclFailure).toMatchObject({
        step: "/grant:r",
        stage: "runner_watchdog",
        timedOut: true,
        exitCode: null,
        success: false,
      });
      // The unsettled runner is registered as a pending reap for this path —
      // removal must wait for it, not treat the caller release as proof of exit.
      expect(windowsSecretAclReapPendingForPath(filePath)).toBe(true);

    } finally {
      for (const release of releases) release();
      await flushWindowsSecretAclReapsBeforeRemoval(testDir);
    }
    expect(windowsSecretAclReapPendingForPath(filePath)).toBe(false);
  });

  test("an ACL failure still blocks publication — now with the bounded record attached", () => {
    setIcaclsRunnerForTests(args => (args.includes("/grant:r") ? denied(5) : ok));
    const destination = join(testDir, "atomic-secret.json");
    let renamed = false;
    let scrubbed = false;

    const error = thrownAclError(() => atomicWriteFile(destination, "secret", {
      write: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
      harden: path => { hardenSecretPath(path, { required: true }); },
      rename: (source, target) => { renamed = true; renameSync(source, target); },
      truncate: path => { scrubbed = true; truncateSync(path, 0); },
      unlink: unlinkSync,
    }));

    expect(error.code).toBe("EICACLS");
    expect(error.aclFailure!.step).toBe("/grant:r");
    expect(renamed).toBe(false); // the rename — the publish — never ran
    expect(scrubbed).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });

  test("optional mode keeps its path-free diagnostic string and gains nothing new", () => {
    const filePath = secretFile();
    setIcaclsRunnerForTests(() => denied(5));

    const result = hardenSecretPath(filePath, { required: false });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContain("EICACLS");
    expect(result.diagnostics).not.toContain(filePath);
    expect(result.diagnostics).not.toContain(ownerSid);
  });
});

describe("aclFailure boundary against an untrusted runner-thrown cause", () => {
  // A runner that throws instead of returning a result hands its raw error to
  // the required-mode sanitizer. Every aclFailure field on that error is
  // untrusted: a getter may return a different value on each read or throw, and
  // a Proxy may trap `in` or `get`. The sanitizer must read each field once,
  // validate and copy only that local value, and drop the whole record when any
  // read throws — a hostile exception must never replace the sanitized error.
  const throwingRunnerCause = (aclFailure: unknown): Error =>
    Object.assign(new Error("injected runner failure"), { code: "EICACLS", aclFailure });

  test("a changing step getter cannot swap the validated value for a path at copy time", () => {
    const filePath = secretFile();
    let stepReads = 0;
    let exitCodeReads = 0;
    const hostile = {
      get step() { stepReads += 1; return stepReads <= 2 ? "/grant:r" : filePath; },
      stage: "child_result",
      elapsedMs: 1,
      budgetMs: 100,
      success: false,
      get exitCode() { exitCodeReads += 1; return exitCodeReads <= 3 ? 5 : `marker:${filePath}`; },
      timedOut: false,
    };
    setIcaclsRunnerForTests(() => { throw throwingRunnerCause(hostile); });

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    expect(error.code).toBe("EICACLS");
    // Validated values — never the later hostile reads — reach the record.
    expect(error.aclFailure).toMatchObject({ step: "/grant:r", stage: "child_result", exitCode: 5 });
    expect(JSON.stringify(error.aclFailure)).not.toContain(filePath);
  });

  test("every copied field is read exactly once, keeping valid edge values", () => {
    const filePath = secretFile();
    const reads: Record<string, number> = {};
    const field = <T>(name: string, value: T): PropertyDescriptor => ({
      enumerable: true,
      get() { reads[name] = (reads[name] ?? 0) + 1; return value; },
    });
    const hostile = Object.defineProperties({}, {
      step: field("step", "/grant:r"),
      stage: field("stage", "child_result"),
      elapsedMs: field("elapsedMs", -1),
      budgetMs: field("budgetMs", 0),
      success: field("success", false),
      exitCode: field("exitCode", null),
      timedOut: field("timedOut", false),
    });
    setIcaclsRunnerForTests(() => { throw throwingRunnerCause(hostile); });

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    expect(error.code).toBe("EICACLS");
    expect(error.aclFailure).toEqual({
      step: "/grant:r",
      stage: "child_result",
      elapsedMs: -1,
      budgetMs: 0,
      success: false,
      exitCode: null,
      timedOut: false,
    });
    for (const name of ["step", "stage", "elapsedMs", "budgetMs", "success", "exitCode", "timedOut"]) {
      expect(reads[name]).toBe(1);
    }
  });

  test("an invalid first read drops the record even when a later read would pass", () => {
    const filePath = secretFile();
    let stepReads = 0;
    const hostile = {
      get step() { stepReads += 1; return stepReads === 1 ? filePath : "/grant:r"; },
      stage: "child_result",
      elapsedMs: 1,
      budgetMs: 100,
      success: false,
      exitCode: 5,
      timedOut: false,
    };
    setIcaclsRunnerForTests(() => { throw throwingRunnerCause(hostile); });

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    expect(error.code).toBe("EICACLS");
    expect(error.aclFailure).toBeUndefined();
  });

  test("an invalid success field short-circuits before the timedOut getter runs", () => {
    const filePath = secretFile();
    let timedOutReads = 0;
    const hostile = {
      step: "/grant:r",
      stage: "child_result",
      elapsedMs: 1,
      budgetMs: 100,
      success: "yes" as unknown as boolean,
      get timedOut() { timedOutReads += 1; return false; },
      exitCode: 5,
    };
    setIcaclsRunnerForTests(() => { throw throwingRunnerCause(hostile); });

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    expect(error.code).toBe("EICACLS");
    expect(error.aclFailure).toBeUndefined();
    // Original guard read timedOut only after success passed; keep that order.
    expect(timedOutReads).toBe(0);
  });

  test("a throwing aclFailure field getter drops the record but keeps the sanitized error", () => {
    const filePath = secretFile();
    const hostile = Object.defineProperty({
      stage: "child_result",
      elapsedMs: 1,
      budgetMs: 100,
      success: false,
      exitCode: 5,
      timedOut: false,
    }, "step", {
      enumerable: true,
      get() { throw new Error(`getter-marker ${filePath}`); },
    });
    setIcaclsRunnerForTests(() => { throw throwingRunnerCause(hostile); });

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    expect(error.code).toBe("EICACLS");
    expect(error.aclFailure).toBeUndefined();
    expect(error.message).not.toContain("getter-marker");
    expect(error.message).not.toContain(filePath);
  });

  test("proxy has/get traps on the untrusted cause drop the record without replacing the error", () => {
    const wellFormed = {
      step: "/grant:r",
      stage: "child_result",
      elapsedMs: 1,
      budgetMs: 100,
      success: false,
      exitCode: 5,
      timedOut: false,
    };

    // The record's own get trap throws when step is read.
    const recordProxy = new Proxy({ ...wellFormed }, {
      get(target, prop) {
        if (prop === "step") throw new Error("record-get-marker");
        return (target as Record<string | symbol, unknown>)[prop];
      },
    });
    const filePath1 = secretFile("secret-a.json");
    setIcaclsRunnerForTests(() => { throw throwingRunnerCause(recordProxy); });
    const first = thrownAclError(() => hardenSecretPath(filePath1, { required: true }));
    expect(first.code).toBe("EICACLS");
    expect(first.aclFailure).toBeUndefined();
    expect(first.message).not.toContain("record-get-marker");

    // The cause's own has trap throws only for the aclFailure key — a trap that
    // also fires on the separate cause.code boundary is outside this fix.
    const filePath2 = secretFile("secret-b.json");
    const causeProxy = new Proxy(throwingRunnerCause({ ...wellFormed }), {
      has(target, prop) {
        if (prop === "aclFailure") throw new Error(`cause-has-marker ${filePath2}`);
        return prop in target;
      },
    });
    setIcaclsRunnerForTests(() => { throw causeProxy; });
    const second = thrownAclError(() => hardenSecretPath(filePath2, { required: true }));
    expect(second.code).toBe("EICACLS");
    expect(second.aclFailure).toBeUndefined();
    expect(second.message).not.toContain("cause-has-marker");
    expect(second.message).not.toContain(filePath2);
  });

  test("a well-formed plain record and its allowlisted spawn code survive verbatim", () => {
    const filePath = secretFile();
    const clean = {
      step: "/remove:g",
      stage: "spawn_failed",
      elapsedMs: 2,
      budgetMs: 50,
      success: false,
      exitCode: null,
      timedOut: false,
      spawnErrorCode: "ENOENT",
    };
    setIcaclsRunnerForTests(() => { throw throwingRunnerCause(clean); });

    const error = thrownAclError(() => hardenSecretPath(filePath, { required: true }));

    expect(error.code).toBe("EICACLS");
    expect(error.aclFailure).toEqual({ ...clean });
  });
});
