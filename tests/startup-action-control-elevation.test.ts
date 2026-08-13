import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";
import { WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER } from "../src/lib/windows-elevation";

const execFileMock = mock((
  _file: string,
  _args: string[],
  _options: unknown,
  callback: (error: Error | null, stdout?: string, stderr?: string) => void,
) => {
  callback(null, "", "");
});

const finalizeMock = mock(async () => ({ kind: "done" as const }));

mock.module("node:child_process", () => ({
  ...childProcess,
  execFile: execFileMock,
}));

const {
  classifyCliInstallFailure,
  clearStartupInstallPartialBlock,
  getStartupInstallState,
  installFailureDetail,
  resetStartupInstallStateForTests,
  runStartupInstallAction,
  setStartupInstallFinalizeForTests,
} = await import("../src/server/startup-action-control");

describe("startup install elevation retry", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    resetStartupInstallStateForTests();
    execFileMock.mockReset();
    finalizeMock.mockReset();
    finalizeMock.mockResolvedValue({ kind: "done" });
    setStartupInstallFinalizeForTests(finalizeMock as never);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    setStartupInstallFinalizeForTests(null);
    resetStartupInstallStateForTests();
  });

  function failCli(message: string) {
    execFileMock.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback(new Error(message), "", message);
    });
  }

  function failCliStreams(stdout: string, stderr: string) {
    execFileMock.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback(new Error("Command failed"), stdout, stderr);
    });
  }

  test("a CLI-completed two-phase scheduler install does not enter the legacy Dashboard finalizer", async () => {
    execFileMock.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback(null, "service installed", "");
    });

    await expect(runStartupInstallAction("install-service")).resolves.toEqual({
      message: "Background service installed.",
    });
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(getStartupInstallState().status).toBe("idle");
    expect((execFileMock.mock.calls[0]![2] as { timeout?: number }).timeout).toBe(0);
  });

  test("retries only for structured schtasks /create access denied", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);

    const result = await runStartupInstallAction("install-service");

    expect(result).toEqual({ message: "Background service installed." });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(getStartupInstallState().status).toBe("idle");
  });

  test("UAC cancellation during elevated retry surfaces and leaves the lock idle", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    finalizeMock.mockRejectedValue(
      new Error("Windows administrator approval was required, but the UAC prompt was cancelled or denied."),
    );
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/UAC prompt was cancelled/);
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(getStartupInstallState().status).toBe("idle");
  });

  test("elevated success that cannot prove the task is present does not leave a false idle install", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    finalizeMock.mockRejectedValue(
      new Error("Elevated Task Scheduler registration did not produce a conflict-free install. Task Scheduler task is not installed."),
    );
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/not installed/);
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(getStartupInstallState().status).toBe("idle");
  });

  test("retries when the create-access-denied marker is on stdout and stderr has noise", async () => {
    failCliStreams(
      `Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`,
      "WARNING: unrelated installer warning",
    );

    const result = await runStartupInstallAction("install-service");

    expect(result).toEqual({ message: "Background service installed." });
    expect(finalizeMock).toHaveBeenCalledTimes(1);
  });

  test("retries when the marker is only on stderr", async () => {
    failCliStreams("", `denied\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    await expect(runStartupInstallAction("install-service")).resolves.toEqual({
      message: "Background service installed.",
    });
    expect(finalizeMock).toHaveBeenCalledTimes(1);
  });

  test("does not elevate when marker is absent across both streams", async () => {
    failCliStreams("service install failed", "Access is denied.");
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/Access is denied/);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  test("does not elevate for WinSW removal access denied", async () => {
    failCli("Cannot remove the native service before switching to Task Scheduler: Access is denied.");
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/Cannot remove the native service/);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  test("does not elevate for asset-write access denied", async () => {
    failCli("EACCES: permission denied, open 'C:\\Users\\x\\.opencodex\\opencodex-service.cmd'");
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/EACCES/);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  test("does not elevate for generic access-denied stderr", async () => {
    failCli("Access is denied.");
    await expect(runStartupInstallAction("install-service")).rejects.toThrow("Access is denied.");
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  test("does not elevate install-shim", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    await expect(runStartupInstallAction("install-shim")).rejects.toThrow(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  test("does not elevate service repair even with create-access-denied marker", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    await expect(runStartupInstallAction("install-service", { repair: true })).rejects.toThrow(
      WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER,
    );
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalled();
    const argv = execFileMock.mock.calls[0]![1] as string[];
    expect(argv.slice(-2)).toEqual(["service", "repair"]);
  });

  test("does not elevate on non-Windows platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  test("surfaces finalize conflict/rollback failures without reporting success", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    finalizeMock.mockRejectedValue(
      new Error("Elevated Task Scheduler registration did not produce a conflict-free install. CONFLICT: Task Scheduler and native WinSW are both present."),
    );

    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/CONFLICT/);
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(getStartupInstallState().status).toBe("idle");
  });

  test("elevation request timeout enters indeterminate and blocks new installs", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    let resolveReconciliation!: (value: "released" | "blocked-partial") => void;
    const reconciliation = new Promise<"released" | "blocked-partial">(resolve => {
      resolveReconciliation = resolve;
    });
    finalizeMock.mockResolvedValue({
      kind: "indeterminate",
      attemptId: "attempt-timeout-1",
      reconciliation,
    });

    await expect(runStartupInstallAction("install-service")).rejects.toThrow(
      /elevated Task Scheduler transaction may still be running/,
    );
    expect(getStartupInstallState()).toMatchObject({
      status: "indeterminate",
      attemptId: "attempt-timeout-1",
      action: "install-service",
    });

    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/still being reconciled/);
    await expect(runStartupInstallAction("install-shim")).rejects.toThrow(/still being reconciled/);
    expect(finalizeMock).toHaveBeenCalledTimes(1);

    resolveReconciliation("released");
    await reconciliation;
    await Promise.resolve();
    expect(getStartupInstallState().status).toBe("idle");

    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    finalizeMock.mockResolvedValue({ kind: "done" });
    await expect(runStartupInstallAction("install-service")).resolves.toEqual({
      message: "Background service installed.",
    });
  });

  test("late blocked-partial keeps install lock blocked until cleared", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    let resolveReconciliation!: (value: "released" | "blocked-partial") => void;
    const reconciliation = new Promise<"released" | "blocked-partial">(resolve => {
      resolveReconciliation = resolve;
    });
    finalizeMock.mockResolvedValue({
      kind: "indeterminate",
      attemptId: "attempt-partial-1",
      reconciliation,
    });

    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/may still be running/);
    resolveReconciliation("blocked-partial");
    await reconciliation;
    await Promise.resolve();
    expect(getStartupInstallState()).toMatchObject({
      status: "blocked",
      reason: "partial-elevated-install",
      attemptId: "attempt-partial-1",
    });

    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/partial Task Scheduler state/);
    expect(clearStartupInstallPartialBlock({ probe: { status: "present" } }).cleared).toBe(false);
    expect(clearStartupInstallPartialBlock({
      probe: { status: "unknown", detail: "Access is denied." },
    }).cleared).toBe(false);
    expect(clearStartupInstallPartialBlock({ probe: { status: "absent" } }).cleared).toBe(true);
    expect(getStartupInstallState().status).toBe("idle");
  });

  test("stale reconciliation cannot clear a newer indeterminate attempt", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    let resolveOld!: (value: "released" | "blocked-partial") => void;
    const oldReconciliation = new Promise<"released" | "blocked-partial">(resolve => {
      resolveOld = resolve;
    });
    finalizeMock.mockResolvedValue({
      kind: "indeterminate",
      attemptId: "old-attempt",
      reconciliation: oldReconciliation,
    });
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/may still be running/);

    // Simulate an ownership hand-off that should not happen in production, then prove defense-in-depth.
    resetStartupInstallStateForTests();
    finalizeMock.mockResolvedValue({
      kind: "indeterminate",
      attemptId: "new-attempt",
      reconciliation: new Promise<"released">(() => {}),
    });
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/may still be running/);
    expect(getStartupInstallState()).toMatchObject({ attemptId: "new-attempt", status: "indeterminate" });

    resolveOld("released");
    await oldReconciliation;
    await Promise.resolve();
    expect(getStartupInstallState()).toMatchObject({ attemptId: "new-attempt", status: "indeterminate" });
  });

  test("rejected reconciliation fails closed into blocked state", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    let rejectReconciliation!: (error: Error) => void;
    const reconciliation = new Promise<"released" | "blocked-partial">((_, reject) => {
      rejectReconciliation = reject;
    });
    finalizeMock.mockResolvedValue({
      kind: "indeterminate",
      attemptId: "attempt-reject-1",
      reconciliation,
    });

    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/may still be running/);
    rejectReconciliation(new Error("reconciliation boom"));
    await reconciliation.catch(() => {});
    expect(getStartupInstallState()).toMatchObject({
      status: "blocked",
      reason: "partial-elevated-install",
      attemptId: "attempt-reject-1",
    });
  });
});

describe("classifyCliInstallFailure marker transport", () => {
  test("marker in stderr only", () => {
    const failure = classifyCliInstallFailure("", `x\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`, new Error("fail"));
    expect(failure.code).toBe(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(failure.detail).toContain(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
  });

  test("marker in stdout only", () => {
    const failure = classifyCliInstallFailure(`x\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`, "", new Error("fail"));
    expect(failure.code).toBe(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
  });

  test("marker in stdout plus unrelated stderr warning", () => {
    const failure = classifyCliInstallFailure(
      WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER,
      "WARNING: noise",
      new Error("Command failed"),
    );
    expect(failure.code).toBe(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(failure.detail).toContain("WARNING: noise");
  });

  test("generic access-denied text without marker", () => {
    const failure = classifyCliInstallFailure("", "Access is denied.", new Error("Command failed"));
    expect(failure.code).toBeNull();
  });

  test("marker beyond displayed truncation boundary is preserved", () => {
    const failure = classifyCliInstallFailure(
      `${"x".repeat(3_000)}\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`,
      "stderr-head",
      new Error("Command failed"),
    );
    expect(failure.code).toBe(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(failure.detail).toContain(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(failure.detail).toContain("truncated");
  });

  test("falls back to error.message when streams are empty", () => {
    const failure = classifyCliInstallFailure("", "", new Error("only-message"));
    expect(failure.detail).toBe("only-message");
    expect(installFailureDetail("", "", new Error("only-message"))).toBe("only-message");
  });
});
