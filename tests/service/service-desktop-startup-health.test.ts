import { expect, test } from "bun:test";
import { deriveStartupHealth, startupHealthSummary } from "../../src/codex/autostart-health";
import { deriveDesktopStartup } from "../../src/service/desktop-startup";
import { markStartupHealthDiagnosticStale } from "../../src/server/startup-health-cache";

const base = {
  routingKind: "opencodex-local" as const, platform: "darwin" as const,
  autostartEnabled: true, serviceInstalled: false, serviceViable: false,
  serviceEnabled: false, serviceRunning: false, serviceStale: false,
  serviceConflict: false, serviceSupported: true, shimInstalled: false, shimHealthy: false,
};

test("desktop ownership keeps failed and stale diagnostics from recommending a competing service", () => {
  const desktop = deriveDesktopStartup({ owned: true, loginEnabled: true, running: false });
  const health = deriveStartupHealth({ ...base, desktop });
  expect(health).toMatchObject({ status: "at-risk", rebootSafe: false, protection: "none", recommendedCommand: null });
  expect(startupHealthSummary(health)).toContain("Start at Login");
  expect(startupHealthSummary(health)).not.toContain("ocx service");
  const stale = markStartupHealthDiagnosticStale(deriveStartupHealth({
    ...base, desktop: deriveDesktopStartup({ owned: true, loginEnabled: true, running: true }),
  }));
  expect(stale).toMatchObject({ status: "at-risk", protection: "none", rebootSafe: false, diagnosticStale: true, recommendedCommand: null });
});

test("stale or inconsistent desktop evidence cannot grant protection", () => {
  for (const override of [{ diagnosticStale: true }, { desktop: { owned: false, loginEnabled: true, running: true, viable: true } }]) {
    const health = deriveStartupHealth({ ...base, desktop: deriveDesktopStartup({ owned: true, loginEnabled: true, running: true }), ...override });
    expect(health).toMatchObject({ status: "at-risk", rebootSafe: false, protection: "none" });
  }
});


test("unowned desktop supervision with login grants protection on macOS and Linux", () => {
  const supervisor = { supervisorPid: 3131, runtimePid: 4242, app: "/fixture/opencodex-desktop" };
  for (const platform of ["darwin", "linux"] as const) {
    const desktop = { owned: false, loginEnabled: true, running: true, viable: true, supervisor };
    const health = deriveStartupHealth({ ...base, platform, desktop });
    expect(health).toMatchObject({ status: "protected", protection: "desktop", rebootSafe: true, recommendedCommand: null, recommendedAction: null });
    for (const override of [{ diagnosticStale: true }, { platform: "win32" as const },
      { desktop: { ...desktop, running: false } }, { desktop: { ...desktop, viable: false } }]) {
      expect(deriveStartupHealth({ ...base, platform, desktop, ...override }).rebootSafe).toBe(false);
    }
  }
});

test("supervision without verified login uses Desktop recovery and stale readings revoke protection", () => {
  const desktop = { owned: false, loginEnabled: false, running: true, viable: false,
    supervisor: { supervisorPid: 3131, runtimePid: 4242, app: "/fixture/opencodex-desktop" } };
  const health = deriveStartupHealth({ ...base, desktop });
  expect(health).toMatchObject({ status: "at-risk", protection: "none", recommendedCommand: null,
    recommendedAction: "Turn on Start at Login in the OpenCodex menu so the desktop app starts this proxy after a restart." });
  expect(startupHealthSummary(health)).toContain("OpenCodex Desktop runs this proxy");
  expect(startupHealthSummary(health)).toContain("Start at Login could not be verified");
  expect(startupHealthSummary(health)).not.toContain("run '");
  const stale = markStartupHealthDiagnosticStale(deriveStartupHealth({ ...base,
    desktop: { ...desktop, loginEnabled: true, viable: true } }));
  expect(stale).toMatchObject({ status: "at-risk", protection: "none", rebootSafe: false,
    diagnosticStale: true, recommendedCommand: null, recommendedAction: "Reopen OpenCodex and check Start at Login." });
});
