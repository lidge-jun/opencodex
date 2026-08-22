import type { StartupHealth } from "../../src/codex/autostart-health";

export function startupHealthFixture(overrides: Partial<StartupHealth> = {}): StartupHealth {
  return {
    status: "native",
    routingKind: "native",
    routingInjected: false,
    localRoutingDependency: false,
    autostartEnabled: false,
    rebootSafe: true,
    protection: "none",
    serviceInstalled: false,
    serviceViable: false,
    serviceEnabled: false,
    serviceRunning: false,
    serviceStale: false,
    serviceConflict: false,
    shimInstalled: false,
    shimHealthy: false,
    shimCoverage: "none",
    serviceSupported: true,
    platform: process.platform,
    diagnosticStale: false,
    recommendedCommand: null,
    commands: {
      installService: "ocx service install",
      repairService: "ocx service repair",
      installShim: "ocx codex-shim install",
      restoreNative: "ocx restore",
    },
    ...overrides,
  };
}
