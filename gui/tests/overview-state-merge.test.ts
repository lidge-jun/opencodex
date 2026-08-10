import { expect, test } from "bun:test";
import { buildOverviewRows, type OverviewSources } from "../src/pages/integrations/overview-clients";
import { describeRefusal } from "../src/pages/integrations/refusal-copy";
import { NativeApiError, type NativeRefusalReason, type NativeStatus } from "../src/pages/integrations/native-api";

function nativeStatus(clientId: NativeStatus["clientId"], overrides: Partial<NativeStatus> = {}): NativeStatus {
  return {
    clientId,
    state: "current",
    installed: true,
    configPath: clientId === "grok" ? "/live/grok/config.toml" : "/live/opencodex/config.json",
    disableBlocked: null,
    ...overrides,
  };
}

function sources(overrides: Partial<OverviewSources> = {}): OverviewSources {
  return {
    clients: [],
    clientsSettled: true,
    codex: null,
    keyCount: null,
    keyPhase: "settled",
    claude: { enabled: false, authMode: "subscription" },
    claudeDesktop: null,
    grok: { present: false, models: [] },
    native: [nativeStatus("claude"), nativeStatus("grok")],
    nativeSettled: true,
    ...overrides,
  };
}

function row(overrides: Partial<OverviewSources>, id: "claude" | "grok") {
  const found = buildOverviewRows(sources(overrides)).rows.find(candidate => candidate.id === id);
  if (!found) throw new Error(`missing ${id} row`);
  return found;
}

test("settled native state owns the badge, applied flag, and installed detection", () => {
  for (const state of ["current", "absent", "unsafe"] as const) {
    const grok = row({
      native: [nativeStatus("claude"), nativeStatus("grok", { state, installed: state !== "unsafe" })],
      // Deliberately disagree: detail payloads must never regain state authority.
      grok: { present: state !== "current", models: [{}, {}] },
    }, "grok");
    expect(grok.state).toBe(state);
    expect(grok.applied).toBe(state === "current");
    expect(grok.installed).toBe(state !== "unsafe");
    expect(grok.toggle).toBe("grok");
  }
});

test("an installed but unfenced Grok client is detected from the native payload", () => {
  const grok = row({
    native: [nativeStatus("claude"), nativeStatus("grok", { state: "absent", installed: true })],
    grok: { present: false, models: [] },
  }, "grok");
  expect(grok.state).toBe("absent");
  expect(grok.installed).toBe(true);
  expect(grok.applied).toBe(false);
});

test("an unsettled native read keeps a disabled-capable switch instead of guessing", () => {
  for (const id of ["claude", "grok"] as const) {
    const nativeRow = row({ native: null, nativeSettled: false }, id);
    expect(nativeRow.state).toBe("unknown");
    expect(nativeRow.toggle).toBe(id);
    expect(nativeRow.applied).toBe(false);
  }
});

test("a client omitted from a settled native contract has no switch", () => {
  const grok = row({ native: [nativeStatus("claude")], nativeSettled: true }, "grok");
  expect(grok.state).toBe("unknown");
  expect(grok.toggle).toBeNull();
});

test("native badge state and applied never disagree", () => {
  for (const clientId of ["claude", "grok"] as const) {
    for (const state of ["current", "absent", "unsafe"] as const) {
      for (const detailApplied of [true, false]) {
        const native = [
          nativeStatus("claude", clientId === "claude" ? { state } : {}),
          nativeStatus("grok", clientId === "grok" ? { state } : {}),
        ];
        const candidate = row({
          native,
          claude: { enabled: detailApplied, authMode: "proxy" },
          grok: { present: detailApplied, models: [{}] },
        }, clientId);
        expect(candidate.applied).toBe(candidate.state === "current");
      }
    }
  }
});

test("detail lines still come from the per-client payloads", () => {
  const claude = row({
    native: [nativeStatus("claude", { state: "absent" }), nativeStatus("grok")],
    claude: { enabled: true, authMode: "subscription" },
  }, "claude");
  expect(claude.state).toBe("absent");
  expect(claude.detailKey).toBe("claude.authModeSubscription");

  const grok = row({
    native: [nativeStatus("claude"), nativeStatus("grok", { state: "absent" })],
    grok: { present: true, models: [{}, {}, {}] },
  }, "grok");
  expect(grok.state).toBe("absent");
  expect(grok.detailKey).toBe("integrations.detail.grokModels");
  expect(grok.detailVars).toEqual({ count: "3" });
});

test("native refusals replace server English except for the load-bearing home conflict", () => {
  const dictionary: Record<string, string> = {
    "integrations.native.error.orphanedMarker": "{path} marker explanation",
    "integrations.native.error.homeMismatch": "localized home lead",
    "integrations.native.error.notInstalled": "localized not installed",
    "integrations.native.error.configBusy": "localized busy",
    "integrations.error.generic": "generic",
  };
  const t = ((key: string, vars?: Record<string, string>) => {
    let text = dictionary[key] ?? key;
    for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, value);
    return text;
  }) as Parameters<typeof describeRefusal>[0];
  const error = (reason: NativeRefusalReason, message: string) => new NativeApiError(409, {
    error: "raw error",
    code: reason === "write_failed" ? "native_integration_failed" : "native_integration_refused",
    clientId: "grok",
    reason,
    message,
  });

  expect(describeRefusal(t, error("orphaned_marker", "raw orphan"), undefined, "/live/path"))
    .toBe("/live/path marker explanation");
  expect(describeRefusal(t, error("config_busy", "raw busy"))).toBe("localized busy");
  expect(describeRefusal(t, error("home_mismatch", "recorded=/a current=/b")))
    .toBe("localized home lead recorded=/a current=/b");
  expect(describeRefusal(t, error("write_failed", "disk is read-only"))).toBe("disk is read-only");
});
