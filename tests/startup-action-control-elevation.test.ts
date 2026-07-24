import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as actualService from "../src/service";

const execFileMock = mock((
  _file: string,
  _args: string[],
  _options: unknown,
  callback: (error: Error | null, stdout?: string, stderr?: string) => void,
) => {
  callback(null, "", "");
});

const finalizeWindowsSchedulerServiceRegistrationMock = mock(async () => {});
const windowsSchedulerTaskInstalledMock = mock(() => true);

mock.module("node:child_process", () => ({
  ...childProcess,
  execFile: execFileMock,
}));

mock.module("../src/service", () => ({
  ...actualService,
  finalizeWindowsSchedulerServiceRegistration: finalizeWindowsSchedulerServiceRegistrationMock,
  windowsSchedulerTaskInstalled: windowsSchedulerTaskInstalledMock,
}));

const { runStartupInstallAction } = await import("../src/server/startup-action-control");

describe("startup install elevation retry", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    execFileMock.mockReset();
    finalizeWindowsSchedulerServiceRegistrationMock.mockReset();
    windowsSchedulerTaskInstalledMock.mockReset();
    windowsSchedulerTaskInstalledMock.mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  test("retries scheduler registration when the child install reports access denied", async () => {
    execFileMock.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback(new Error("Windows access denied while running Task Scheduler."), "", "");
    });

    const result = await runStartupInstallAction("install-service");

    expect(result).toEqual({ message: "Background service installed." });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(finalizeWindowsSchedulerServiceRegistrationMock).toHaveBeenCalledTimes(1);
    expect(windowsSchedulerTaskInstalledMock).toHaveBeenCalledTimes(1);
  });

  test("fails when scheduler registration still did not create the task", async () => {
    execFileMock.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback(new Error("Windows access denied while running Task Scheduler."), "", "");
    });
    windowsSchedulerTaskInstalledMock.mockReturnValue(false);

    await expect(runStartupInstallAction("install-service")).rejects.toThrow(
      "Background service install still failed after requesting administrator approval.",
    );
    expect(finalizeWindowsSchedulerServiceRegistrationMock).toHaveBeenCalledTimes(1);
  });

  test("does not retry non-service installs", async () => {
    execFileMock.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback(new Error("Windows access denied while running Task Scheduler."), "", "");
    });

    await expect(runStartupInstallAction("install-shim")).rejects.toThrow(
      "Windows access denied while running Task Scheduler.",
    );
    expect(finalizeWindowsSchedulerServiceRegistrationMock).not.toHaveBeenCalled();
  });
});
