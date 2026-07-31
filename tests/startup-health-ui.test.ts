import { describe, expect, test } from "bun:test";
import {
  PROJECT_CONFIG_DIAGNOSTICS_POLL_MS,
  beginPollEpochs,
  mapStartupHealthProbe,
  probeNeedsFastRetry,
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

  test("keeps payload status when diagnostics are stale and rejects invalid payloads", () => {
    // diagnosticStale is SWR refresh, not a hard read failure — do not map to "error".
    expect(mapStartupHealthProbe({ status: "protected", diagnosticStale: true })).toBe("protected");
    expect(mapStartupHealthProbe({ status: "at-risk", diagnosticStale: true })).toBe("at-risk");
    expect(mapStartupHealthProbe({ status: "native", diagnosticStale: false })).toBe("native");
    expect(mapStartupHealthProbe({ status: "nope" })).toBeNull();
  });

  test("settings may seed while unknown or hard-error, but not overwrite a real status", () => {
    expect(seedStartupHealthFromSettings(null, { status: "protected", diagnosticStale: false })).toBe("protected");
    expect(seedStartupHealthFromSettings("error", { status: "protected", diagnosticStale: false })).toBe("protected");
    expect(seedStartupHealthFromSettings(null, { status: "at-risk", diagnosticStale: true })).toBe("at-risk");
    expect(seedStartupHealthFromSettings("at-risk", { status: "protected", diagnosticStale: false })).toBe("at-risk");
  });
});

describe("stale startup-health fast retry", () => {
  // The chip used to sit on the server's conservative placeholder until the next 30s
  // poll, which is why it only appeared to sync when the user clicked something.
  test("a stale answer asks for a fast re-check", () => {
    expect(probeNeedsFastRetry({ status: "at-risk", stale: true })).toBe(true);
    expect(probeNeedsFastRetry({ status: "protected", stale: true })).toBe(true);
    expect(probeNeedsFastRetry({ status: "native", stale: true })).toBe(true);
  });

  test("a settled answer does not", () => {
    expect(probeNeedsFastRetry({ status: "protected", stale: false })).toBe(false);
    expect(probeNeedsFastRetry({ status: "at-risk", stale: false })).toBe(false);
  });

  test("a hard error is left to the ordinary poll", () => {
    // A read failure will not resolve itself in two seconds; retrying fast would just
    // hammer a down endpoint.
    expect(probeNeedsFastRetry({ status: "error", stale: true })).toBe(false);
    expect(probeNeedsFastRetry({ status: "error", stale: false })).toBe(false);
  });

  test("no snapshot yet is not a retry trigger", () => {
    expect(probeNeedsFastRetry(undefined)).toBe(false);
    expect(probeNeedsFastRetry(null)).toBe(false);
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
