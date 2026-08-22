import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER,
  WindowsSchtasksError,
  assertTrustedSystemExecutableForTests,
  buildWindowsElevatedArgumentList,
  formatWindowsSchtasksError,
  isWindowsAccessDenied,
  isWindowsAccessDeniedError,
  isWindowsSchtasksCreateAccessDenied,
  resolveTrustedWindowsIcaclsExe,
  resolveTrustedWindowsPowerShellExe,
  resolveTrustedWindowsSchtasksExe,
  schtasksOperationFromArgs,
  setTrustedWindowsElevationExecutablesForTests,
  setTrustedWindowsSystemDirectoryResolverForTests,
  setWindowsElevationProbeForTests,
  toWindowsSchtasksError,
  windowsCmdQuote,
} from "../src/lib/windows-elevation";

describe("windows elevation helpers", () => {
  test("detects English and German access-denied text", () => {
    expect(isWindowsAccessDenied("FEHLER: Zugriff verweigert")).toBe(true);
    expect(isWindowsAccessDenied("ERROR: Access is denied.")).toBe(true);
    expect(isWindowsAccessDenied("Windows denied access while running Task Scheduler.")).toBe(true);
    expect(isWindowsAccessDenied("service installed")).toBe(false);
  });

  test("detects access-denied exec errors from stderr", () => {
    const error = Object.assign(new Error("Command failed"), {
      stderr: "FEHLER: Zugriff verweigert\r\n",
      stdout: "",
      status: 1,
    });
    expect(isWindowsAccessDeniedError(error)).toBe(true);
  });

  test("formats schtasks create access-denied errors with marker and UAC guidance", () => {
    const error = Object.assign(new Error("Command failed"), {
      stderr: "FEHLER: Zugriff verweigert\r\n",
      stdout: "",
      status: 1,
    });
    const message = formatWindowsSchtasksError(error, [
      "/create",
      "/tn",
      "opencodex-proxy",
      "/xml",
      "task.xml",
      "/f",
    ]);
    expect(message).toContain("Windows access denied while running Task Scheduler.");
    expect(message).toContain("schtasks /create /tn opencodex-proxy /xml task.xml /f");
    expect(message).toContain("UAC prompt");
    expect(message).toContain(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(isWindowsSchtasksCreateAccessDenied(message)).toBe(true);
  });

  test("does not emit create-access-denied marker for non-create operations", () => {
    const error = Object.assign(new Error("Command failed"), {
      stderr: "Access is denied.",
      stdout: "",
    });
    const message = formatWindowsSchtasksError(error, ["/run", "/tn", "opencodex-proxy"]);
    expect(message).toContain("Windows access denied while running Task Scheduler.");
    expect(message).not.toContain(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(isWindowsSchtasksCreateAccessDenied(message)).toBe(false);
  });

  test("generic access-denied text alone does not classify as create denial", () => {
    expect(isWindowsSchtasksCreateAccessDenied("Access is denied.")).toBe(false);
    expect(isWindowsSchtasksCreateAccessDenied("Cannot remove the native service: Access is denied.")).toBe(false);
    expect(isWindowsSchtasksCreateAccessDenied("EACCES: permission denied, open 'token'")).toBe(false);
  });

  test("toWindowsSchtasksError preserves operation and reason", () => {
    const error = Object.assign(new Error("Command failed"), { stderr: "Access is denied." });
    const structured = toWindowsSchtasksError(error, [
      "/create",
      "/tn",
      "opencodex-proxy",
      "/xml",
      "task.xml",
      "/f",
    ]);
    expect(structured).toBeInstanceOf(WindowsSchtasksError);
    expect(structured.operation).toBe("create");
    expect(structured.reason).toBe("access-denied");
    expect(structured.machineMarker).toBe(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(schtasksOperationFromArgs(["/delete", "/tn", "x"])).toBe("delete");
  });

  test("classifies an owned scheduler create failure without localized text", () => {
    setWindowsElevationProbeForTests(() => false);
    try {
      const error = Object.assign(new Error("Command failed"), {
        // A real non-English Windows install can arrive as mojibake here.
        stderr: "����: �ܾ����ʡ�\r\n",
        stdout: "",
        status: 1,
      });
      const structured = toWindowsSchtasksError(error, [
        "/create",
        "/tn",
        "opencodex-proxy",
        "/xml",
        "C:\\Users\\tester\\.opencodex\\opencodex-service-task.xml",
        "/f",
      ]);
      expect(structured.reason).toBe("access-denied");
      expect(structured.message).toContain("Windows access denied while running Task Scheduler.");
      expect(structured.machineMarker).toBe(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    } finally {
      setWindowsElevationProbeForTests(null);
    }
  });

  test("locale-independent elevation fallback is scoped and fails closed", () => {
    const error = Object.assign(new Error("Command failed"), {
      stderr: "unrecognized localized output",
      status: 1,
    });
    setWindowsElevationProbeForTests(() => false);
    try {
      expect(toWindowsSchtasksError(error, ["/query", "/tn", "opencodex-proxy"]).reason).toBe("other");
      expect(toWindowsSchtasksError(error, [
        "/create",
        "/tn",
        "someone-elses-task",
        "/xml",
        "task.xml",
        "/f",
      ]).reason).toBe("other");

      const foreignDenied = toWindowsSchtasksError(
        Object.assign(new Error("Command failed"), { stderr: "Access is denied.", status: 1 }),
        ["/create", "/tn", "someone-elses-task", "/xml", "task.xml", "/f"],
      );
      expect(foreignDenied.reason).toBe("other");
      expect(foreignDenied.message).toContain("Windows access denied while running Task Scheduler.");
      expect(foreignDenied.machineMarker).toBeNull();
    } finally {
      setWindowsElevationProbeForTests(null);
    }

    setWindowsElevationProbeForTests(() => null);
    try {
      expect(toWindowsSchtasksError(error, [
        "/create",
        "/tn",
        "opencodex-proxy",
        "/xml",
        "task.xml",
        "/f",
      ]).reason).toBe("other");
    } finally {
      setWindowsElevationProbeForTests(null);
    }

    setWindowsElevationProbeForTests(() => true);
    try {
      expect(toWindowsSchtasksError(error, [
        "/create",
        "/tn",
        "opencodex-proxy",
        "/xml",
        "task.xml",
        "/f",
      ]).reason).toBe("other");
    } finally {
      setWindowsElevationProbeForTests(null);
    }
  });

  test("builds one Win32-quoted argument list for spaced paths", () => {
    expect(buildWindowsElevatedArgumentList([
      "/create",
      "/tn",
      "opencodex-proxy",
      "/xml",
      "C:\\Users\\Jane Doe\\.opencodex\\opencodex-service-task.xml",
      "/f",
    ])).toBe(
      '/create /tn opencodex-proxy /xml "C:\\Users\\Jane Doe\\.opencodex\\opencodex-service-task.xml" /f',
    );
  });

  test("quotes empty args, embedded quotes, trailing backslashes, and unicode paths", () => {
    expect(windowsCmdQuote("")).toBe('""');
    expect(windowsCmdQuote("simple")).toBe("simple");
    expect(windowsCmdQuote('say "hi"')).toBe('"say \\"hi\\""');
    // Unquoted paths keep a single trailing backslash; only quoted args double it.
    expect(windowsCmdQuote("C:\\temp\\")).toBe("C:\\temp\\");
    expect(windowsCmdQuote("C:\\temp dir\\")).toBe('"C:\\temp dir\\\\"');
    expect(windowsCmdQuote("C:\\Users\\한글\\task")).toBe("C:\\Users\\한글\\task");
    expect(windowsCmdQuote("task name with spaces")).toBe('"task name with spaces"');
    expect(buildWindowsElevatedArgumentList(["/tn", "Open Codex Proxy", ""])).toBe(
      '/tn "Open Codex Proxy" ""',
    );
  });

  test("passes through non-access-denied errors unchanged", () => {
    const error = new Error("schtasks is unavailable");
    expect(formatWindowsSchtasksError(error, ["/query"])).toBe("schtasks is unavailable");
  });

  test("elevated executables ignore a hostile SystemRoot and enforce path containment", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

    const trustedRoot = mkdtempSync(join(tmpdir(), "ocx-trusted-sys-"));
    const trustedSystem32 = join(trustedRoot, "System32");
    mkdirSync(join(trustedSystem32, "WindowsPowerShell", "v1.0"), { recursive: true });
    writeFileSync(join(trustedSystem32, "schtasks.exe"), "");
    writeFileSync(join(trustedSystem32, "icacls.exe"), "");
    writeFileSync(join(trustedSystem32, "WindowsPowerShell", "v1.0", "powershell.exe"), "");

    const evilRoot = mkdtempSync(join(tmpdir(), "ocx-evil-sys-"));
    const evilSystem32 = join(evilRoot, "System32");
    mkdirSync(join(evilSystem32, "WindowsPowerShell", "v1.0"), { recursive: true });
    writeFileSync(join(evilSystem32, "schtasks.exe"), "evil");
    writeFileSync(join(evilSystem32, "icacls.exe"), "evil");
    writeFileSync(join(evilSystem32, "WindowsPowerShell", "v1.0", "powershell.exe"), "evil");

    const previousSystemRoot = process.env.SystemRoot;
    const previousWindir = process.env.WINDIR;
    process.env.SystemRoot = evilRoot;
    process.env.WINDIR = evilRoot;
    try {
      setTrustedWindowsElevationExecutablesForTests(null);
      setTrustedWindowsSystemDirectoryResolverForTests(() => trustedSystem32);

      const powershell = resolveTrustedWindowsPowerShellExe();
      const schtasks = resolveTrustedWindowsSchtasksExe();
      const icacls = resolveTrustedWindowsIcaclsExe();
      expect(powershell.toLowerCase().includes("ocx-evil-sys")).toBe(false);
      expect(schtasks.toLowerCase().includes("ocx-evil-sys")).toBe(false);
      expect(icacls.toLowerCase().includes("ocx-evil-sys")).toBe(false);
      expect(powershell.toLowerCase()).toContain(trustedSystem32.toLowerCase());
      expect(schtasks.toLowerCase()).toContain(trustedSystem32.toLowerCase());
      expect(icacls.toLowerCase()).toContain(trustedSystem32.toLowerCase());

      // Containment must reject an existing executable outside the trusted system directory
      // (not merely a missing-file failure).
      expect(() => assertTrustedSystemExecutableForTests(join(evilSystem32, "schtasks.exe"), "schtasks.exe"))
        .toThrow(/outside the trusted/i);
      expect(() => assertTrustedSystemExecutableForTests(
        join(evilSystem32, "WindowsPowerShell", "v1.0", "powershell.exe"),
        "PowerShell",
      )).toThrow(/outside the trusted/i);
    } finally {
      setTrustedWindowsSystemDirectoryResolverForTests(null);
      setTrustedWindowsElevationExecutablesForTests(null);
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (previousWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = previousWindir;
    }
  });
});
