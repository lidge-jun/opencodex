import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitResponseSpillPublicationTailForTests,
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushPendingResponseSpillsForTests,
  pendingResponseSpillMetricsForTests,
  rememberResponseState,
  responseStateMetrics,
  setResponseSpillShutdownBudgetForTests,
  setResponseStateByteCapForTests,
} from "../../src/responses/state";
import {
  RESPONSE_SPILL_DIR_NAME,
  setResponseSpillNowForTests,
} from "../../src/responses/spill-store";
import {
  resetHardenedStateForTests,
  setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests,
  setNowForTests,
  setPlatformForTests,
} from "../../src/lib/windows-secret-acl";
import {
  resetWindowsPrincipalForTests,
  setAsyncWindowsPrincipalRunnerForTests,
  setWindowsPrincipalRunnerForTests,
} from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const SYNTHETIC_SID = {
  success: true,
  exitCode: 0,
  timedOut: false,
  stdout: "S-1-5-21-1-2-3-1001\nocx-test\n",
};
const FALLBACK_RESERVE_MS = 5;
const REAL_WALL_BURN_MS = 200;

function isSpillAclTarget(args: string[]): boolean {
  return args.some(arg => arg.includes(RESPONSE_SPILL_DIR_NAME));
}

function rememberLarge(id: string, text: string): void {
  rememberResponseState(
    { model: "test/model", input: text, store: false },
    {
      id,
      output: [{ type: "message", role: "assistant", content: text }],
      status: "completed",
    },
    undefined,
    { force: true },
  );
}

function fallbackErrors(error: unknown): Error[] {
  if (!(error instanceof AggregateError)) return [];
  return error.errors.filter((item): item is Error => item instanceof Error);
}

describe("response spill shutdown clock", () => {
  let home: string;
  let releaseAsyncGate: (() => void) | null = null;
  let restoreDateNow: (() => void) | null = null;
  const priorHome = process.env["OPENCODEX_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-spill-shutdown-clock-test-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
    setPlatformForTests("win32");
    setWindowsPrincipalRunnerForTests(() => SYNTHETIC_SID);
    setAsyncWindowsPrincipalRunnerForTests(async () => SYNTHETIC_SID);
    setResponseStateByteCapForTests(1_024);
    setResponseSpillShutdownBudgetForTests({
      totalMs: FALLBACK_RESERVE_MS + 3,
      fallbackReserveMs: FALLBACK_RESERVE_MS,
    });
  });

  afterEach(async () => {
    try {
      releaseAsyncGate?.();
      await awaitResponseSpillPublicationTailForTests();
    } finally {
      releaseAsyncGate = null;
      restoreDateNow?.();
      restoreDateNow = null;
      setResponseSpillNowForTests(null);
      setAsyncIcaclsRunnerForTests(null);
      setIcaclsRunnerForTests(null);
      setNowForTests(null);
      setPlatformForTests(null);
      setWindowsPrincipalRunnerForTests(null);
      setAsyncWindowsPrincipalRunnerForTests(null);
      resetWindowsPrincipalForTests();
      resetHardenedStateForTests();
      setResponseSpillShutdownBudgetForTests(null);
      setResponseStateByteCapForTests(null);
      clearResponseStateForTests();
      removeTreeWithRetry(home);
      if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
      else process.env["OPENCODEX_HOME"] = priorHome;
    }
  });

  async function queueTwoBlockedSpills(): Promise<void> {
    let announceStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { announceStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    releaseAsyncGate = release;
    let announced = false;
    setAsyncIcaclsRunnerForTests(async args => {
      if (!isSpillAclTarget(args)) return ICACLS_OK;
      if (!announced) {
        announced = true;
        announceStarted();
      }
      await gate;
      return ICACLS_OK;
    });
    rememberLarge("resp_shutdown_clock_first", "a".repeat(8_000));
    rememberLarge("resp_shutdown_clock_second", "b".repeat(8_000));
    await started;
  }

  test("frozen spill clock excludes real wall time from the shutdown fallback reserve", async () => {
    const spillClock = 0;
    setNowForTests(() => 0);
    setResponseSpillNowForTests(() => spillClock);
    let synchronousCalls = 0;
    setIcaclsRunnerForTests(args => {
      if (!isSpillAclTarget(args)) return ICACLS_OK;
      synchronousCalls += 1;
      if (synchronousCalls === 1) {
        const wallDeadline = Date.now() + REAL_WALL_BURN_MS;
        while (Date.now() < wallDeadline) { /* deliberately consume real wall time */ }
      }
      return ICACLS_OK;
    });
    await queueTwoBlockedSpills();

    await expect(flushPendingResponseSpillsForTests()).resolves.toBeUndefined();

    expect(synchronousCalls).toBeGreaterThan(0);
    expect(pendingResponseSpillMetricsForTests()).toEqual({ count: 0, bytes: 0 });
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, spillStubCount: 2 });
    for (const [id, payload] of [
      ["resp_shutdown_clock_first", "a"],
      ["resp_shutdown_clock_second", "b"],
    ] as const) {
      expect(JSON.stringify(expandPreviousResponseInput({
        previous_response_id: id,
        input: "next",
      }))).toContain(payload.repeat(8_000));
    }
  });

  test("advancing the spill clock beyond the reserve enforces shutdown fallback expiry", async () => {
    let spillClock = 0;
    setNowForTests(() => 0);
    setResponseSpillNowForTests(() => spillClock);
    const nowSpy = spyOn(Date, "now").mockReturnValue(1_000_000);
    restoreDateNow = () => { nowSpy.mockRestore(); };
    let synchronousCalls = 0;
    setIcaclsRunnerForTests(args => {
      if (!isSpillAclTarget(args)) return ICACLS_OK;
      synchronousCalls += 1;
      if (synchronousCalls === 1) spillClock = FALLBACK_RESERVE_MS + 1;
      return ICACLS_OK;
    });
    await queueTwoBlockedSpills();

    let thrown: unknown;
    try {
      await flushPendingResponseSpillsForTests();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(fallbackErrors(thrown).some(error =>
      error.message === "Response spill shutdown fallback budget exhausted"
      && (error as NodeJS.ErrnoException).code === "ETIMEDOUT"
    )).toBe(true);
    expect(pendingResponseSpillMetricsForTests()).toEqual({ count: 0, bytes: 0 });
  });
});
