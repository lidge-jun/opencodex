import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDesktopPickerController,
  offlinePickerStatus,
  removeDesktopPickerArtifacts,
  type DesktopPickerProfileInspection,
} from "../../src/claude/desktop-picker";
import type { PickerRuntime, PickerRuntimeStatus } from "../../src/claude/intercept/picker-runtime";
import type { SecurityResult, SecurityRunner } from "../../src/claude/intercept/picker-trust";
import { pickerCaCertPath, pickerCaFingerprints } from "../../src/claude/intercept/picker-ca";
import type { OcxConfig } from "../../src/types";

let root = "";

function config(extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    runtimeRole: "hub",
    clientIntegrations: { "claude-desktop": true },
    claudeCode: { desktopMode: "first-party" },
    ...extra,
  } as OcxConfig;
}

function pickerSecurity(options: { trusted?: boolean; addTrust?: boolean; removeTrust?: boolean } = {}): {
  run: SecurityRunner;
  calls: string[][];
} {
  let trusted = options.trusted ?? false;
  const calls: string[][] = [];
  const ok: SecurityResult = { code: 0, stdout: "", stderr: "" };
  const run: SecurityRunner = async args => {
    calls.push([...args]);
    if (args[0] === "find-certificate") {
      const certPath = pickerCaCertPath(root);
      let sha1 = "";
      try { sha1 = pickerCaFingerprints(readFileSync(certPath, "utf8")).sha1; } catch { /* certificate is created lazily */ }
      return trusted
        ? { ...ok, stdout: `SHA-1 hash: ${sha1}` }
        : { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "verify-cert") return trusted ? ok : { code: 1, stdout: "", stderr: "" };
    if (args[0] === "trust-settings-export") {
      writeFileSync(args[1]!, "<plist><dict></dict></plist>");
      return ok;
    }
    if (args[0] === "add-trusted-cert") {
      trusted = options.addTrust ?? true;
      return trusted ? ok : { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "remove-trusted-cert") {
      trusted = options.removeTrust ?? false;
      return trusted ? { code: 1, stdout: "", stderr: "" } : ok;
    }
    if (args[0] === "delete-certificate") return ok;
    return ok;
  };
  return { run, calls };
}

function fakeRuntime(events: string[] = []): { runtime: PickerRuntime; state: PickerRuntimeStatus } {
  const state: PickerRuntimeStatus = {
    desired: true, supported: true, trust: "trusted", listenerReady: true, effective: false,
    latched: false, reason: "disarmed", models: 3, snapshotAt: 10, lastBootstrapAt: null,
  };
  const runtime = {
    selectTunnel: () => ({ kind: "blind" as const }),
    refreshTrust: async () => state.trust,
    refresh: async () => {},
    disarm: () => { events.push("disarm"); state.effective = false; state.latched = true; state.reason = "disarmed"; },
    rearm: async () => { events.push("rearm"); state.effective = true; state.latched = false; state.reason = "active"; },
    ensureStarted: async () => {},
    start: async () => {},
    ready: Promise.resolve(),
    status: () => ({ ...state }),
    stop: async () => {},
  } as unknown as PickerRuntime;
  return { runtime, state };
}

function profileFake(events: string[] = []): {
  inspect: () => DesktopPickerProfileInspection;
  apply: (options: { proxyPort: number }) => { ok: true; changed: boolean; path: string };
  remove: () => { ok: true; changed: boolean };
  selected: () => boolean;
} {
  let selected = false;
  return {
    inspect: () => selected ? { kind: "applied", entryId: "picker", proxyUrl: "http://127.0.0.1:10201" } : { kind: "absent" },
    apply: ({ proxyPort }) => {
      events.push("profile");
      selected = true;
      return { ok: true, changed: true, path: `picker-${proxyPort}.json` };
    },
    remove: () => { events.push("remove"); selected = false; return { ok: true, changed: true }; },
    selected: () => selected,
  };
}

function controllerFor(options: {
  config?: OcxConfig;
  runtime?: PickerRuntime;
  events?: string[];
  security?: SecurityRunner;
  profile?: ReturnType<typeof profileFake>;
  proxy?: number | null;
} = {}) {
  const current = options.config ?? config();
  const runtime = options.runtime ?? fakeRuntime(options.events).runtime;
  const profile = options.profile ?? profileFake(options.events);
  return createDesktopPickerController({
    runtime,
    readConfig: () => current,
    persistPreference: value => {
      options.events?.push(`persist:${value}`);
      current.claudeCode = { ...(current.claudeCode ?? {}), intercept: { ...(current.claudeCode?.intercept ?? {}), picker: value } };
      return true;
    },
    proxyPort: () => options.proxy === undefined ? 10201 : options.proxy,
    configDir: root,
    platform: "darwin",
    security: options.security,
    applyProfile: profile.apply as never,
    removeProfile: profile.remove as never,
    inspectProfile: profile.inspect as never,
  });
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ocx-picker-controller-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test("enable orders trust, fresh recheck, profile, and rearm", async () => {
  const events: string[] = [];
  const trust = pickerSecurity({ trusted: false, addTrust: true });
  const profile = profileFake(events);
  const controller = controllerFor({ events, security: trust.run, profile });
  const result = await controller.enable({ persist: true, context: "server" });
  expect(result).toMatchObject({ reason: "restart_required", profile: "applied", effective: true, models: 3 });
  expect(events).toEqual(["persist:true", "profile", "rearm"]);
  expect(trust.calls.map(call => call[0])).toEqual([
    "find-certificate", "add-trusted-cert", "find-certificate", "verify-cert", "trust-settings-export",
  ]);
});

test("persisted false is allowed to become true on explicit enable", async () => {
  const current = config({ claudeCode: { desktopMode: "first-party", intercept: { picker: false } } });
  const trust = pickerSecurity({ trusted: true });
  const controller = controllerFor({ config: current, security: trust.run, profile: profileFake() });
  const result = await controller.enable({ persist: true, context: "server" });
  expect(result.reason).toBe("restart_required");
  expect(current.claudeCode?.intercept?.picker).toBe(true);
});

test("independent preconditions refuse before writing the preference", async () => {
  for (const [name, current, expected] of [
    ["mode", config({ claudeCode: { desktopMode: "gateway" } }), "mode_not_committed"],
    ["intent", config({ clientIntegrations: { "claude-desktop": false } }), "integration_off"],
    ["proxy", config(), "proxy_unavailable"],
  ] as const) {
    const trust = pickerSecurity({ trusted: true });
    const controller = controllerFor({ config: current, security: trust.run, proxy: name === "proxy" ? null : 10201 });
    const result = await controller.enable({ persist: true, context: "server" });
    expect(result.reason).toBe(expected);
    expect(current.claudeCode?.intercept?.picker).not.toBe(true);
  }
  const unsupportedRuntime = fakeRuntime().runtime;
  const unsupported = createDesktopPickerController({
    runtime: unsupportedRuntime,
    readConfig: () => config(),
    persistPreference: () => { throw new Error("must not persist"); },
    proxyPort: () => 10201,
    configDir: root,
    platform: "linux",
    applyProfile: (() => ({ ok: true, changed: true, path: "" })) as never,
    removeProfile: (() => ({ ok: true, changed: false })) as never,
    inspectProfile: (() => ({ kind: "absent" })) as never,
  });
  expect((await unsupported.enable({ persist: true, context: "server" })).reason).toBe("unsupported_platform");
});

test("server trust refusal reports trust_pending and CLI trust refusal reports trust_declined", async () => {
  const declined = pickerSecurity({ trusted: false, addTrust: false });
  const server = await controllerFor({ security: declined.run }).enable({ persist: false, context: "server" });
  expect(server).toMatchObject({ reason: "trust_pending", hint: "ocx claude desktop picker trust", profile: "absent" });
  const cli = await controllerFor({ security: pickerSecurity({ trusted: false }).run }).enable({ persist: false, context: "cli-trusted" });
  expect(cli.reason).toBe("trust_declined");
});

test("trust added by the server is removed when profile activation fails", async () => {
  const trust = pickerSecurity({ trusted: false, addTrust: true });
  const failedProfile = profileFake();
  failedProfile.apply = (() => ({ ok: false, reason: "write_failed" })) as never;
  const controller = controllerFor({ security: trust.run, profile: failedProfile });
  const result = await controller.enable({ persist: false, context: "server" });
  expect(result).toMatchObject({ reason: "profile_failed", profile: "absent", effective: false });
  expect(trust.calls.some(call => call[0] === "remove-trusted-cert")).toBe(true);
});

test("disable disarms, optionally persists, removes the profile, and untrusts", async () => {
  const events: string[] = [];
  const trust = pickerSecurity({ trusted: true });
  const profile = profileFake(events);
  const runtimeParts = fakeRuntime(events);
  const controller = controllerFor({ events, security: trust.run, profile, runtime: runtimeParts.runtime });
  await controller.enable({ persist: false, context: "server" });
  events.length = 0;
  const result = await controller.disable({ persist: true });
  expect(result.reason).toBe("disabled");
  expect(result.effective).toBe(false);
  expect(events).toEqual(["disarm", "persist:false", "remove"]);
  expect(trust.calls.slice(-4).map(call => call[0])).toEqual(["find-certificate", "remove-trusted-cert", "delete-certificate", "find-certificate"]);
});

test("disable keeps the CA trusted while Desktop still selects the picker profile", async () => {
  const events: string[] = [];
  const trust = pickerSecurity({ trusted: true });
  const base = profileFake(events);
  let failRemove = false;
  const profile = {
    ...base,
    remove: () => failRemove
      ? ({ ok: false, reason: "write_failed" } as never)
      : base.remove(),
  };
  const runtimeParts = fakeRuntime(events);
  const controller = controllerFor({ events, security: trust.run, profile, runtime: runtimeParts.runtime });
  await controller.enable({ persist: false, context: "server" });
  // The metadata write fails: the profile stays selected.
  failRemove = true;
  const callsBefore = trust.calls.length;
  const result = await controller.disable({ persist: false });
  expect(profile.selected()).toBe(true);
  expect(result.residual).toEqual(["profile"]);
  expect(result.effective).toBe(false);
  expect(trust.calls.slice(callsBefore).some(call => call[0] === "remove-trusted-cert")).toBe(false);
});

test("one lock serializes a pending enable and a queued disable", async () => {
  const events: string[] = [];
  const profile = profileFake(events);
  const runtimeParts = fakeRuntime(events);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalRearm = runtimeParts.runtime.rearm;
  runtimeParts.runtime.rearm = async () => { events.push("rearm-start"); await gate; await originalRearm(); };
  const controller = controllerFor({ events, security: pickerSecurity({ trusted: true }).run, profile, runtime: runtimeParts.runtime });
  const enable = controller.enable({ persist: false, context: "server" });
  while (!events.includes("rearm-start")) await Bun.sleep(0);
  expect(controller.busy()).toBe(true);
  const disable = controller.disable({ persist: false });
  release();
  await Promise.all([enable, disable]);
  expect(controller.busy()).toBe(false);
  expect(profile.selected()).toBe(false);
});

test("caller-added trust is compensated on an early refusal", async () => {
  const trust = pickerSecurity({ trusted: true, removeTrust: true });
  const current = config({ clientIntegrations: { "claude-desktop": false } });
  const controller = controllerFor({ config: current, security: trust.run });
  const result = await controller.enable({ persist: false, context: "cli-trusted", callerAddedTrust: true });
  expect(result.reason).toBe("integration_off");
  expect(trust.calls.some(call => call[0] === "remove-trusted-cert")).toBe(true);
});

test("offline status explains why a picker cannot run", () => {
  expect(offlinePickerStatus(config(), "linux")).toMatchObject({ reason: "unsupported_platform", effective: false, supported: false });
  expect(offlinePickerStatus(config({ claudeCode: { desktopMode: "gateway" } }), "darwin").reason).toBe("not_first_party");
});

test("offline cleanup reports residual work", async () => {
  const result = await removeDesktopPickerArtifacts({ configDir: root, platform: "linux", security: async () => ({ code: 1, stdout: "", stderr: "" }) });
  expect(result.ok).toBe(true);
});

test("a restart is asked for only after this process changed the profile, never after a plain opencodex restart", async () => {
  const events: string[] = [];
  const profile = profileFake(events);
  const runtimeParts = fakeRuntime(events);
  // The profile already points at this proxy, as after an opencodex restart.
  profile.apply({ proxyPort: 10201 });
  const unchanged = { ...profile, apply: () => ({ ok: true as const, changed: false, path: "picker.json" }) };
  const controller = controllerFor({ events, security: pickerSecurity({ trusted: true }).run, profile: unchanged, runtime: runtimeParts.runtime });
  expect((await controller.enable({ persist: false, context: "server" })).reason).toBe("active");

  const fresh = profileFake(events);
  const second = fakeRuntime(events);
  const changed = controllerFor({ events, security: pickerSecurity({ trusted: true }).run, profile: fresh, runtime: second.runtime });
  expect((await changed.enable({ persist: false, context: "server" })).reason).toBe("restart_required");
  second.state.lastBootstrapAt = Date.now() + 1;
  expect((await changed.status()).reason).toBe("active");
});
