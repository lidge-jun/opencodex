import { describe, expect, test } from "bun:test";
import {
  PROJECT_CONFIG_DIAGNOSTICS_POLL_MS,
  beginPollEpochs,
  mapStartupHealthProbe,
  seedStartupHealthFromSettings,
  settingsPollMayCommit,
  startupRiskDetailKey,
} from "../gui/src/startup-health-ui";

describe("startup health UI decisions", () => {
  test("selects the shared risk-detail message", () => {
    expect(startupRiskDetailKey({ routingKind: "custom-local", shimCoverage: "none" }))
      .toBe("startup.riskDetailCustomLocal");
    expect(startupRiskDetailKey({ routingKind: "opencodex-local", shimCoverage: "cli-only" }))
      .toBe("startup.riskDetailWindowsShim");
    expect(startupRiskDetailKey({ routingKind: "unknown", shimCoverage: "none" }))
      .toBe("startup.riskDetail");
  });

  test("rejects stale or mutation-racing settings polls", () => {
    const started = { request: 4, mutation: 2 };
    expect(settingsPollMayCommit(started, { request: 4, mutation: 2, mutationInFlight: false })).toBe(true);
    expect(settingsPollMayCommit(started, { request: 5, mutation: 2, mutationInFlight: false })).toBe(false);
    expect(settingsPollMayCommit(started, { request: 4, mutation: 3, mutationInFlight: false })).toBe(false);
    expect(settingsPollMayCommit(started, { request: 4, mutation: 2, mutationInFlight: true })).toBe(false);
  });

  test("maps stale diagnostics to error and rejects invalid payloads", () => {
    expect(mapStartupHealthProbe({ status: "protected", diagnosticStale: true })).toBe("error");
    expect(mapStartupHealthProbe({ status: "native", diagnosticStale: false })).toBe("native");
    expect(mapStartupHealthProbe({ status: "nope" })).toBeNull();
  });

  test("settings may only seed while startup health is still unknown", () => {
    expect(seedStartupHealthFromSettings(null, { status: "protected", diagnosticStale: false })).toBe("protected");
    expect(seedStartupHealthFromSettings("error", { status: "protected", diagnosticStale: false })).toBe("error");
    expect(seedStartupHealthFromSettings(null, { status: "at-risk", diagnosticStale: true })).toBe("error");
  });
});

describe("dashboard poll epochs", () => {
  test("captures and bumps request epochs before fetches", () => {
    const refs = {
      settingsRequest: { current: 0 },
      settingsMutation: { current: 2 },
      shadowRequest: { current: 0 },
      shadowMutation: { current: 4 },
    };
    const first = beginPollEpochs(refs);
    const second = beginPollEpochs(refs);
    expect(first.settings).toEqual({ request: 1, mutation: 2 });
    expect(second.settings).toEqual({ request: 2, mutation: 2 });
    expect(first.shadow).toEqual({ request: 1, mutation: 4 });
    expect(second.shadow.request).toBe(2);
  });

  test("stale poll after successful mutation cannot commit", () => {
    const started = beginPollEpochs({
      settingsRequest: { current: 3 },
      settingsMutation: { current: 1 },
      shadowRequest: { current: 3 },
      shadowMutation: { current: 1 },
    });
    expect(settingsPollMayCommit(started.settings, {
      request: started.settings.request,
      mutation: 2,
      mutationInFlight: false,
    })).toBe(false);
    expect(settingsPollMayCommit(started.shadow, {
      request: started.shadow.request,
      mutation: 2,
      mutationInFlight: false,
    })).toBe(false);
  });

  test("overlapping polls resolving out of order keep only the latest request identity", () => {
    const refs = {
      settingsRequest: { current: 0 },
      settingsMutation: { current: 0 },
      shadowRequest: { current: 0 },
      shadowMutation: { current: 0 },
    };
    const older = beginPollEpochs(refs);
    const newer = beginPollEpochs(refs);
    expect(settingsPollMayCommit(older.settings, {
      request: refs.settingsRequest.current,
      mutation: 0,
      mutationInFlight: false,
    })).toBe(false);
    expect(settingsPollMayCommit(newer.settings, {
      request: refs.settingsRequest.current,
      mutation: 0,
      mutationInFlight: false,
    })).toBe(true);
  });

  test("project-config diagnostics uses a single 30s owner cadence", () => {
    expect(PROJECT_CONFIG_DIAGNOSTICS_POLL_MS).toBe(30_000);
  });
});
