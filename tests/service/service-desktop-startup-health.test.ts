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
