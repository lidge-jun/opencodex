import { describe, expect, test } from "bun:test";
import {
  startupServiceNeedsRepair,
  startupServiceRecoveryCommand,
  type StartupHealthData,
} from "../src/pages/startup-shared";

const base: StartupHealthData = {
  status: "at-risk",
  routingKind: "opencodex-local",
  routingInjected: true,
  localRoutingDependency: true,
  autostartEnabled: true,
  rebootSafe: false,
  protection: "none",
  serviceInstalled: true,
  serviceViable: false,
  serviceEnabled: true,
  serviceRunning: false,
  serviceStale: false,
  serviceConflict: false,
  serviceSupported: true,
  shimInstalled: false,
  shimHealthy: false,
  shimCoverage: "none",
  platform: "win32",
  recommendedCommand: "ocx service start",
  diagnosticStale: false,
  commands: {
    installService: "ocx service install",
    startService: "ocx service start",
    repairService: "ocx service repair",
    installShim: "ocx codex-shim install",
    restoreNative: "ocx restore",
  },
};

describe("startup service recovery controls", () => {
  test("offers one-click repair while recommending start for an enabled stopped service", () => {
    expect(startupServiceNeedsRepair(base)).toBe(true);
    expect(startupServiceRecoveryCommand(base)).toBe("ocx service start");
  });

  test("uses repair for a stale installed service", () => {
    const stale = { ...base, serviceRunning: true, serviceStale: true };
    expect(startupServiceNeedsRepair(stale)).toBe(true);
    expect(startupServiceRecoveryCommand(stale)).toBe("ocx service repair");
  });

  test("keeps install for a genuinely missing service", () => {
    const missing = { ...base, serviceInstalled: false, serviceEnabled: false };
    expect(startupServiceNeedsRepair(missing)).toBe(false);
    expect(startupServiceRecoveryCommand(missing)).toBe("ocx service install");
  });

  test("does not offer repair for disabled or conflicting registrations", () => {
    expect(startupServiceNeedsRepair({ ...base, serviceEnabled: false })).toBe(false);
    expect(startupServiceNeedsRepair({ ...base, serviceConflict: true })).toBe(false);
  });
});
