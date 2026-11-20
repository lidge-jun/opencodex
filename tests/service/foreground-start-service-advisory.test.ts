import { describe, expect, test } from "bun:test";
import { deriveLaunchdServiceDiagnostic, foregroundStartServiceAdvisoryLines, warnForegroundStartService } from "../../src/service/diagnostics";
import type { ServiceDiagnostic } from "../../src/service/diagnostics";

const diagnostic = (overrides: Partial<ServiceDiagnostic> = {}): ServiceDiagnostic => ({
  supported: true,
  installed: true,
  enabled: false,
  running: false,
  viable: false,
  startable: true,
  stale: false,
  conflict: false,
  backend: "launchd",
  summary: "installed, not loaded (launchd; ok)",
  confirmedStopped: true,
  ...overrides,
});

describe("foregroundStartServiceAdvisoryLines", () => {
  test("advises when the managed service is installed but not serving", () => {
    const lines = foregroundStartServiceAdvisoryLines(diagnostic());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("not loaded");
    expect(lines[0]).toContain("installed, not loaded");
    expect(lines[1]).toContain("'ocx service repair'");
  });

  test("stays silent when the service is serving", () => {
    const service = diagnostic({ running: true, enabled: true, viable: true, summary: "installed and loaded (launchd; ok)" });
    expect(foregroundStartServiceAdvisoryLines(service)).toEqual([]);
  });

  test("stays silent when no service is installed", () => {
    const service = diagnostic({ installed: false, startable: false, backend: null, summary: "not installed (launchd; ok)" });
    expect(foregroundStartServiceAdvisoryLines(service)).toEqual([]);
  });

  test("stays silent when another manager holds a conflict", () => {
    const service = diagnostic({ conflict: true, summary: "conflicting manager (launchd; ok)" });
    expect(foregroundStartServiceAdvisoryLines(service)).toEqual([]);
  });

  test("stays silent on unsupported platforms", () => {
    const service = diagnostic({ supported: false, startable: false, summary: "unsupported on freebsd" });
    expect(foregroundStartServiceAdvisoryLines(service)).toEqual([]);
  });

  test("advises on a stale registration that is not serving", () => {
    const service = diagnostic({ stale: true, startable: false, summary: "installed, but stale (launchd; baked paths moved)" });
    const lines = foregroundStartServiceAdvisoryLines(service);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("'ocx service repair'");
  });

  test("does not treat launchd unknown as stopped, whether or not paths are stale", () => {
    for (const stale of [false, true]) {
      const result = deriveLaunchdServiceDiagnostic({
        installed: true, stale, load: { state: "unknown" }, diagnostics: "fixture",
      });
      const lines = foregroundStartServiceAdvisoryLines(result).join("\n");
      expect(lines).toContain("Could not confirm");
      expect(lines).toContain("ocx status");
      expect(lines.includes("ocx service repair")).toBe(false);
    }
  });

  test("derives confirmation from verified launchd not-loaded, not summary text", () => {
    const result = deriveLaunchdServiceDiagnostic({
      installed: true, stale: false, load: { state: "not-loaded" }, diagnostics: "fixture",
    });
    expect(foregroundStartServiceAdvisoryLines({ ...result, summary: "changed wording" })).toHaveLength(2);
  });

  test("keeps status guidance across unknown and non-launchd backends without copying repair hints", () => {
    for (const backend of ["systemd", "native", "scheduler", null] as const) {
      const lines = foregroundStartServiceAdvisoryLines(diagnostic({
        backend, confirmedStopped: undefined, summary: "stale assets — run ocx service repair",
      })).join("\n");
      expect(lines).toContain("Could not confirm");
      expect(lines).toContain("ocx status");
      expect(lines.includes("ocx service repair")).toBe(false);
    }
  });

  test("probe or warning exceptions cannot propagate to bind", () => {
    const fail = (): never => { throw new Error("fixture"); };
    expect(() => warnForegroundStartService(fail, fail)).not.toThrow();
    expect(() => warnForegroundStartService(() => diagnostic(), fail)).not.toThrow();
  });
});
