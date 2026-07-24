import { describe, expect, test } from "bun:test";
import {
  buildWindowsElevatedArgumentList,
  formatWindowsSchtasksError,
  isWindowsAccessDenied,
  isWindowsAccessDeniedError,
} from "../src/lib/windows-elevation";

describe("windows elevation helpers", () => {
  test("detects English and German access-denied text", () => {
    expect(isWindowsAccessDenied("FEHLER: Zugriff verweigert")).toBe(true);
    expect(isWindowsAccessDenied("ERROR: Access is denied.")).toBe(true);
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

  test("formats schtasks access-denied errors with UAC guidance", () => {
    const error = Object.assign(new Error("Command failed"), {
      stderr: "FEHLER: Zugriff verweigert\r\n",
      stdout: "",
      status: 1,
    });
    const message = formatWindowsSchtasksError(error, ["/create", "/tn", "opencodex-proxy"]);
    expect(message).toContain("Windows access denied while running Task Scheduler.");
    expect(message).toContain("schtasks /create /tn opencodex-proxy");
    expect(message).toContain("UAC prompt");
  });

  test("recognizes formatted scheduler denial text for retry detection", () => {
    expect(isWindowsAccessDenied("Windows access denied while running Task Scheduler.")).toBe(true);
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

  test("passes through non-access-denied errors unchanged", () => {
    const error = new Error("schtasks is unavailable");
    expect(formatWindowsSchtasksError(error, ["/query"])).toBe("schtasks is unavailable");
  });
});
