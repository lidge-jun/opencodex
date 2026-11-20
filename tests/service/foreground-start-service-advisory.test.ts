import { describe, expect, test } from "bun:test";
import { foregroundStartServiceAdvisoryLines } from "../../src/service/diagnostics";
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
  ...overrides,
});

describe("foregroundStartServiceAdvisoryLines", () => {
  test("advises when the managed service is installed but not serving", () => {
    const lines = foregroundStartServiceAdvisoryLines(diagnostic());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("not serving");
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

  test("advises for non-launchd backends too", () => {
    for (const backend of ["systemd", "scheduler", null] as const) {
      const lines = foregroundStartServiceAdvisoryLines(diagnostic({ backend, summary: "installed, not running" }));
      expect(lines).toHaveLength(2);
    }
  });
});
