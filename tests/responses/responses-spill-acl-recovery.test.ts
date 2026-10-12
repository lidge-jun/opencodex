import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  flushPendingResponseSpillsForTests,
  rememberResponseState,
  responseStateMetrics,
  setResponseSpillAsyncAclAttemptBudgetForTests,
  setResponseStateByteCapForTests,
} from "../../src/responses/state";
import {
  responseSpillDirectory,
  setResponseSpillNowForTests,
} from "../../src/responses/spill-store";
import {
  TIMEOUT_MEMO_REARM_MS,
  resetHardenedStateForTests,
  setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests,
  setNowForTests,
  setPlatformForTests,
  setStatForTests,
  timedOutSecretPathCountForTests,
} from "../../src/lib/windows-secret-acl";
import {
  resetWindowsPrincipalForTests,
  setAsyncWindowsPrincipalRunnerForTests,
  setWindowsPrincipalRunnerForTests,
} from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const SYNTHETIC_SID = { success: true, exitCode: 0, timedOut: false, stdout: "S-1-5-21-1-2-3-1001\nocx-test\n" };

function forceWindowsAclLane(): void {
  setPlatformForTests("win32");
  setWindowsPrincipalRunnerForTests(() => SYNTHETIC_SID);
  setAsyncWindowsPrincipalRunnerForTests(async () => SYNTHETIC_SID);
}

function fixedResponse(id: string, output: unknown[]): { id: string; output: unknown[]; status: string } {
  return { id, output, status: "completed" };
}

function rememberLarge(id: string, text: string): void {
  rememberResponseState(
    { model: "test/model", input: text, store: false },
    fixedResponse(id, [{ type: "message", role: "assistant", content: text }]),
    undefined,
    { force: true },
  );
}

function spillFileNames(home: string): string[] {
  const dir = responseSpillDirectory(home);
  return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".spill.json")) : [];
}

/**
 * Issue #3522 incident shape: on a stable spill directory the destination-keyed
 * timeout memo refuses every later publication once its single recovery attempt is
 * consumed, so the write counter freezes while failures accumulate behind a healthy
 * process. The memo re-arms once per bounded window for the caller-owned retry, so a
 * recovered icacls resumes publication in the same process without weakening ACL
 * enforcement — while a still-stalled runner keeps every refusal instant.
 */
describe("response spill ACL timeout memo recovery", () => {
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-spill-acl-recovery-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
    setPlatformForTests("linux");
  });

  afterEach(() => {
    setResponseSpillNowForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    setIcaclsRunnerForTests(null);
    setNowForTests(null);
    setPlatformForTests(null);
    setWindowsPrincipalRunnerForTests(null);
    setAsyncWindowsPrincipalRunnerForTests(null);
    resetWindowsPrincipalForTests();
    setStatForTests(null);
    resetHardenedStateForTests();
    delete process.env.OPENCODEX_ACL_TIMEOUT_MS;
    setResponseSpillAsyncAclAttemptBudgetForTests(null);
    setResponseStateByteCapForTests(null);
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  test("a consumed stable-directory memo re-arms after the window and publication resumes", async () => {
    forceWindowsAclLane();
    let clock = 0;
    setNowForTests(() => clock);
    setResponseSpillNowForTests(() => clock);
    setResponseSpillAsyncAclAttemptBudgetForTests(100);
    setResponseStateByteCapForTests(1_024);
    const spillDir = responseSpillDirectory();
    let grantCalls = 0;
    let healthy = false;
    setAsyncIcaclsRunnerForTests(async args => {
      if (args[0] !== spillDir) return ICACLS_OK;
      if (args.includes("/grant:r")) grantCalls += 1;
      if (healthy) return ICACLS_OK;
      clock += 100;
      return { success: false, exitCode: null, timedOut: true, stdout: "" };
    });

    // Two timed-out attempts consume the stable directory's single recovery.
    rememberLarge("resp_rearm_stall", "x".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(grantCalls).toBe(2);
    expect(responseStateMetrics()).toMatchObject({
      spillWrites: 0,
      spillWriteFailures: 1,
      spillWriteStatus: "degraded",
      spillLastWriteFailureCode: "EACLRETRYEXHAUSTED",
      spillLastWriteFailureOrigin: "retry_returned_timeout",
      spillAclRetryReturnedTimeouts: 1,
    });
    expect(timedOutSecretPathCountForTests()).toBe(1);

    // The runner is healthy again, but inside the window every write is still an
    // instant refusal — anti-restall. This is the incident: successes stay frozen
    // and failures accumulate with no fresh icacls call.
    healthy = true;
    rememberLarge("resp_rearm_refused", "y".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(grantCalls).toBe(2);
    expect(responseStateMetrics()).toMatchObject({
      spillWrites: 0,
      spillWriteFailures: 2,
      spillWriteConsecutiveFailures: 2,
      spillLastWriteFailureCode: "EACLRETRYEXHAUSTED",
      spillLastWriteFailureOrigin: "timeout_memo_refusal",
      spillAclTimeoutMemoRefusals: 1,
    });
    expect(spillFileNames(home)).toHaveLength(0);

    // Past the window the memo re-arms once for the caller-owned retry: the flagless
    // refusal is reported as a timeout so the queue's bounded retry carries the flag
    // into one real harden, and a healthy runner clears the memo for good.
    clock += TIMEOUT_MEMO_REARM_MS + 1;
    rememberLarge("resp_rearm_recovered", "z".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(grantCalls).toBe(3);
    expect(responseStateMetrics()).toMatchObject({
      spillStubCount: 1,
      spillWrites: 1,
      spillWriteFailures: 2,
      spillWriteStatus: "healthy",
      spillWriteConsecutiveFailures: 0,
      spillAclRetryReturnedTimeouts: 1,
      spillAclTimeoutMemoRefusals: 1,
    });
    expect(timedOutSecretPathCountForTests()).toBe(0);
    expect(spillFileNames(home)).toHaveLength(1);

    // Publication keeps working afterwards — the memo is gone, not merely bypassed.
    rememberLarge("resp_rearm_after", "w".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(responseStateMetrics()).toMatchObject({
      spillStubCount: 2,
      spillWrites: 2,
      spillWriteConsecutiveFailures: 0,
    });
  });

  test("a still-stalled runner gets one bounded probe per window", async () => {
    forceWindowsAclLane();
    let clock = 0;
    setNowForTests(() => clock);
    setResponseSpillNowForTests(() => clock);
    setResponseSpillAsyncAclAttemptBudgetForTests(100);
    setResponseStateByteCapForTests(1_024);
    const spillDir = responseSpillDirectory();
    let grantCalls = 0;
    setAsyncIcaclsRunnerForTests(async args => {
      if (args[0] !== spillDir) return ICACLS_OK;
      if (args.includes("/grant:r")) grantCalls += 1;
      clock += 100;
      return { success: false, exitCode: null, timedOut: true, stdout: "" };
    });

    rememberLarge("resp_probe_stall", "x".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(grantCalls).toBe(2);
    expect(responseStateMetrics().spillWriteFailures).toBe(1);

    // First window: one re-armed probe stalls again; the memo re-consumes and the
    // next write inside the same window refuses without any icacls call.
    clock += TIMEOUT_MEMO_REARM_MS + 1;
    rememberLarge("resp_probe_window1", "y".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(grantCalls).toBe(3);
    expect(responseStateMetrics()).toMatchObject({
      spillWriteFailures: 2,
      spillWriteConsecutiveFailures: 2,
      spillLastWriteFailureCode: "EACLRETRYEXHAUSTED",
      spillLastWriteFailureOrigin: "retry_returned_timeout",
    });
    rememberLarge("resp_probe_same_window", "z".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(grantCalls).toBe(3);
    expect(responseStateMetrics()).toMatchObject({
      spillWriteFailures: 3,
      spillLastWriteFailureCode: "EACLRETRYEXHAUSTED",
      spillLastWriteFailureOrigin: "timeout_memo_refusal",
    });

    // Second window: exactly one more bounded probe — failures stay cheap and the
    // harden sequence never runs more than once per window.
    clock += TIMEOUT_MEMO_REARM_MS + 1;
    rememberLarge("resp_probe_window2", "q".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(grantCalls).toBe(4);
    expect(responseStateMetrics()).toMatchObject({
      spillWrites: 0,
      spillWriteConsecutiveFailures: 4,
      spillLastWriteFailureOrigin: "retry_returned_timeout",
    });
    expect(timedOutSecretPathCountForTests()).toBe(1);
  });
});
