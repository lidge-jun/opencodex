import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import * as management from "../../src/server/management-api";
import * as paths from "../../src/config/paths";
import { applyDesktop, applyProfile } from "../../src/cli/claude-desktop";
import * as firstParty from "../../src/claude/desktop-first-party";
import * as desktop3p from "../../src/claude/desktop-3p";
import * as configModule from "../../src/config";
import * as persistedMutation from "../../src/config/persisted-mutation";
import * as pickerRoutes from "../../src/server/management/claude-desktop-picker-routes";
import { handleAgentSettingsRoutes } from "../../src/server/management/agent-settings-routes";
import { handleConfigRoutes } from "../../src/server/management/config-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { setLocalCaWindowsAclRunnerForTests } from "../../src/claude/intercept/local-ca-windows";
import { inspectDesktop3pConfigLibrary, writeDesktop3pConfig } from "../../src/claude/desktop-3p";
import { resolveDesktop3pConfigLibraryPath } from "../../src/claude/desktop-3p-library";
import { resetHardenedStateForTests, setAsyncIcaclsBeltSchedulerForTests, setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests, setNowForTests, setPlatformForTests, windowsSecretAclReapPendingForPath, type IcaclsResult } from "../../src/lib/windows-secret-acl";
import { setSyntheticWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";
import { setWindowsOwnerAclRunnerForTests } from "../../src/lib/windows-owner-acl";
import { writeServiceApiTokenFile } from "../../src/lib/service-secrets";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { isolateClientLifecycleLock } from "../helpers/client-lifecycle-lock";

const success: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const turn = () => new Promise<void>(done => setImmediate(done));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const keys = ["OPENCODEX_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "OPENCODEX_ACL_TIMEOUT_MS", "OPENCODEX_ACL_VERIFY_EXISTING"] as const;
let root: string;
let lifecycleLock: ReturnType<typeof isolateClientLifecycleLock>;
let previous: (string | undefined)[];
let restores: Array<() => void>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-config-writer-barrier-"));
  lifecycleLock = isolateClientLifecycleLock(root);
  previous = keys.map(key => process.env[key]);
  process.env.OPENCODEX_HOME = root;
  process.env.CODEX_HOME = join(root, "codex");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  writeFileSync(join(process.env.CODEX_HOME, "config.toml"), "");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "desktop");
  process.env.OPENCODEX_ACL_TIMEOUT_MS = "1000";
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  restores = [];
  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setSyntheticWindowsPrincipalForTests("*S-1-5-21-1-2-3-1001");
  setIcaclsRunnerForTests(() => success);
  // icacls is mocked, so the real PowerShell owner check must not decide hardening:
  // a cold probe can exhaust the 1s ACL budget and refuse before the mocked icacls runs.
  setWindowsOwnerAclRunnerForTests(() => ({ success: false, timedOut: false, stdout: "" }));
});
afterEach(async () => {
  await paths.flushConfigDirHardeningAndReaps(root);
  for (const restore of restores.reverse()) restore();
  lifecycleLock.restore();
  setAsyncIcaclsRunnerForTests(null);
  setAsyncIcaclsBeltSchedulerForTests(null);
  setNowForTests(null);
  setIcaclsRunnerForTests(null);
  setWindowsOwnerAclRunnerForTests(null);
  setLocalCaWindowsAclRunnerForTests(null);
  setPlatformForTests(null);
  setSyntheticWindowsPrincipalForTests(null);
  resetHardenedStateForTests();
  keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
  removeTreeWithRetry(root);
});

function holdParent(writerRoot = root, observe = true) {
  const entered = deferred(), release = deferred(), reached = deferred();
  let held = true;
  const descendants: string[] = [];
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  setIcaclsRunnerForTests(args => {
    if (held && args[0]?.startsWith(writerRoot + sep)) { descendants.push(args[0]); reached.resolve(); }
    return success;
  });
  const barrier = paths.withConfigDirHardeningSettled;
  if (observe) {
    const entry = spyOn(paths, "withConfigDirHardeningSettled").mockImplementation(<T>(dir: string, mutate: () => T) => {
      const work = barrier(dir, mutate); reached.resolve(); return work;
    });
    restores.push(() => entry.mockRestore());
  }
  paths.hardenConfigDir();
  return { entered: entered.promise, reached: reached.promise, arrive: reached.resolve, descendants, release: () => { held = false; release.resolve(); } };
}
function clock() {
  let now = 0;
  const timers = new Map<() => void, number>();
  setNowForTests(() => now);
  setAsyncIcaclsBeltSchedulerForTests((callback, milliseconds) => {
    timers.set(callback, now + milliseconds);
    return () => { timers.delete(callback); };
  });
  return { advance(milliseconds: number) {
    now += milliseconds;
    for (const [callback, deadline] of timers) if (deadline <= now) { timers.delete(callback); callback(); }
  } };
}
const fixture = () => ({ port: 10100, providers: {
  mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-only", allowPrivateNetwork: true, models: ["test-model"] },
}, defaultProvider: "mock",
  claudeCode: { desktopMode: "gateway", cliFirstParty: true } }) as OcxConfig;

function context(config: OcxConfig, path: string, body: unknown, method = "PUT"): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  return { config, url, req: new Request(url, { method, headers: { Host: url.host, "content-type": "application/json" }, body: JSON.stringify(body) }),
    deps: {}, convergeCodexCatalog: async () => ({}), syncClaudeAgentDefsBestEffort: async () => {},
  } as unknown as ManagementContext;
}
const liveCases = [
  ["/api/shadow-call-settings", { enabled: false }, { shadowCallIntercept: { enabled: true, model: "mock/test-model" } }],
  ["/api/sidecar-settings", { vision: { enabled: false }, webSearch: { enabled: false } }, {}],
  ["/api/settings", { oauthOpenBrowser: false }, { oauthOpenBrowser: true }],
  ["/api/auto-review-settings", { enabled: false }, { autoReviewOverride: { enabled: true } }],
  ["/api/injection-model", { multiAgentGuidanceEnabled: false }, { multiAgentGuidanceEnabled: true }],
  ["/api/effort-caps", { effortCap: "low" }, { effortCap: "high" }],
  ["/api/subagent-model-fallback", { models: ["mock/test-model"] }, {}],
  ["/api/grok/selection", { excluded: ["fixture-model"] }, {}],
  ["/api/claude-code", { enabled: false, fastMode: true }, { claudeCode: { enabled: true } }],
  ["/api/v2", { multiAgentMode: "default" }, {}],
  ["/api/v2", { keepNativeChatGptOnV1: true }, {}],
  ["/api/v2", { multiAgentSurfaceAdvisoryAcknowledged: true }, {}],
] as const;
test.each(liveCases)("pre-commit timeout keeps disk and live unchanged: %s %j", async (path, body, initial) => {
  const config = Object.assign(fixture(), structuredClone(initial));
  const file = join(root, "config.json"), original = JSON.stringify(config);
  writeFileSync(file, original);
  const time = clock(), parent = holdParent();
  await parent.entered;
  const ctx = context(config, path, body);
  const handler = ["/api/settings", "/api/sidecar-settings", "/api/shadow-call-settings", "/api/auto-review-settings"].includes(path) ? handleConfigRoutes : handleAgentSettingsRoutes;
  const work = handler(ctx).then(value => ({ value }), error => ({ error }));
  void work.then(parent.arrive);
  try {
    await parent.reached; await turn();
    const beforeAdmission = JSON.stringify(config);
    time.advance(1000); await turn();
    const result = await work;
    expect(beforeAdmission).toBe(original);
    expect(JSON.stringify(config)).toBe(original);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(result).not.toHaveProperty("error");
    if (!("value" in result)) throw result.error;
    expect(result.value?.status).toBe(500);
    expect(await result.value!.json()).toMatchObject({ code: "write_failed" });
    expect(parent.descendants).toEqual([]);
    time.advance(100_000); await paths.flushConfigDirHardening(root);
    expect(windowsSecretAclReapPendingForPath(root)).toBe(true);
  } finally { parent.release(); await work; }
});

function seedFirstParty(mode: "gateway" | "first-party" = "gateway") {
  const config = fixture();
  config.claudeCode = { desktopMode: mode, intercept: { picker: false } };
  config.clientIntegrations = { "claude-desktop": true };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  mkdirSync(join(root, "claude"), { recursive: true });
  setAsyncIcaclsRunnerForTests(async () => success);
  setLocalCaWindowsAclRunnerForTests(() => ({ ...success, stdout: JSON.stringify({ owner: "S-1-5-21-1-2-3-1001", protected: true,
    rules: [{ sid: "S-1-5-21-1-2-3-1001", type: 0, rights: 2032127 }] }) }));
  return config;
}
function desktopRequest(config: OcxConfig, surface: "api" | "native", mode: "first-party" | "gateway") {
  const ctx = context(config, surface === "api" ? "/api/claude-desktop/apply" : "/api/native-integrations/claude-desktop",
    surface === "api" ? { mode } : { enabled: true }, surface === "api" ? "POST" : "PUT");
  return management.handleManagementAPI(ctx.req, ctx.url, config, { fetchAllModels: async () => [],
    probeClaudeDesktopPolicy: async () => "present",
    ensureClaudeIntercept: async () => ({ ok: true, state: { proxyPort: 10200, caCertPath: join(root, "claude-intercept", "ca.pem"), pickerProxyPort: null } }),
  }, "admin-token", undefined, { trustedLoopback: true });
}

test.each((["cli", "api", "native"] as const).flatMap(surface =>
  (["invalid", "throw"] as const).flatMap(failure =>
    (["restored", "refused", "throw"] as const).map(rollback => ({ surface, failure, rollback }))),
))("$surface unavailable cleanup authority compensates first-party apply: $failure / $rollback", async ({ surface, failure, rollback: rollbackOutcome }) => {
  const config = seedFirstParty(surface === "native" ? "first-party" : "gateway");
  const seeded = writeDesktop3pConfig(10100, [], [], undefined, "static", undefined, undefined, { lockPath: join(root, "lifecycle.sqlite") });
  expect(seeded.written).toBe(true);
  config.claudeCode!.desktopProfile = { version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null }, appliedFingerprint: seeded.fingerprint };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const file = join(root, "claude", "settings.json"), original = { env: { KEEP: "fixture" } };
  writeFileSync(file, JSON.stringify(original));
  await paths.flushConfigDirHardeningAndReaps(root);
  const apply = firstParty.applyDesktopFirstParty;
  let committed = false;
  const reader = persistedMutation.readConfigForAdmittedMutation;
  const authority = spyOn(persistedMutation, "readConfigForAdmittedMutation").mockImplementation(() => {
    if (committed && failure === "throw") throw new Error("fixture-secret-must-not-escape");
    return reader();
  });
  const hook = spyOn(firstParty, "applyDesktopFirstParty").mockImplementation((...args) => {
    const result = apply(...args);
    expect(result.ok).toBe(true);
    queueMicrotask(() => { committed = true; if (failure === "invalid") writeFileSync(join(root, "config.json"), "{"); });
    return result;
  });
  const restore = firstParty.rollbackDesktopFirstPartySettled;
  const rollback = spyOn(firstParty, "rollbackDesktopFirstPartySettled").mockImplementation((dir, action) =>
    restore(dir, rollbackOutcome === "restored" ? action : () => {
      if (rollbackOutcome === "throw") throw new Error("fixture-secret-must-not-escape");
      return false;
    }));
  restores.push(() => hook.mockRestore(), () => rollback.mockRestore(), () => authority.mockRestore());
  const result = surface === "cli"
    ? await applyDesktop(undefined, { kind: "first-party" }, { findLiveProxyImpl: async () => null, lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") } })
    : await desktopRequest(config, surface, "first-party").then(async response => ({ status: response!.status, body: await response!.json() }));
  expect(rollback).toHaveBeenCalledTimes(1);
  if (rollbackOutcome === "restored") expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);
  else expect(JSON.parse(readFileSync(file, "utf8")).env.HTTPS_PROXY).toBeString();
  expect(inspectDesktop3pConfigLibrary({ appliedFingerprint: seeded.fingerprint }).kind).toBe("gateway_ours");
  if ("body" in result) {
    expect(result.status).toBe(surface === "native" && rollbackOutcome !== "restored" ? 500 : 409);
    expect(result.body).toMatchObject({ code: surface === "api" ? "claude_desktop_gateway_removal_failed"
      : rollbackOutcome === "restored" ? "native_integration_refused" : "native_integration_failed" });
    if (surface === "native") expect(result.body).toMatchObject({ desiredEnabled: true });
  } else expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("gateway_profile_active:") });
  if (rollbackOutcome !== "restored") expect(JSON.stringify(result)).toContain("rollback did not complete");
  expect(JSON.stringify(result)).not.toContain("fixture-secret-must-not-escape");
});

test.each(["cli", "api", "native"] as const)("%s late first-party marker timeout reports applied settings", async surface => {
  const config = seedFirstParty(surface === "native" ? "first-party" : "gateway");
  await paths.flushConfigDirHardeningAndReaps(root);
  const time = clock(), started = deferred();
  let parent: ReturnType<typeof holdParent> | undefined;
  let beforeMarker = "";
  const apply = firstParty.applyDesktopFirstParty;
  const hook = spyOn(firstParty, "applyDesktopFirstParty").mockImplementation((...args) => {
    const result = apply(...args); expect(result.ok).toBe(true);
    beforeMarker = readFileSync(join(root, "config.json"), "utf8");
    queueMicrotask(() => { resetHardenedStateForTests(); parent = holdParent(); started.resolve(); });
    return result;
  });
  restores.push(() => hook.mockRestore());
  const work = (surface === "cli" ? applyDesktop(undefined, { kind: "first-party" }, { findLiveProxyImpl: async () => null, lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") } })
    : desktopRequest(config, surface, "first-party").then(async response => ({ status: response!.status, body: await response!.json() })))
    .then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([started.promise, work.then(() => { throw new Error("apply never reached marker"); })]);
    await parent!.entered; await parent!.reached; await turn();
    time.advance(1000); await turn();
    const result = await work;
    expect(JSON.parse(readFileSync(join(root, "claude", "settings.json"), "utf8")).env.HTTPS_PROXY).toBeString();
    expect(result).not.toHaveProperty("error");
    if (!("value" in result)) throw result.error;
    if ("body" in result.value) {
      expect(result.value.status).toBe(200);
      if (surface === "api") expect(result.value.body).toMatchObject({ applied: true, saved: false, mode: "first-party" });
      expect(JSON.stringify(result.value.body)).toContain("mode marker");
    } else expect(result.value).toMatchObject({ ok: true, warning: expect.stringContaining("mode marker") });
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(beforeMarker);
    // Existing library/status readers may harden config.json; a refused marker
    // must not touch its lock or any other descendant.
    expect(parent!.descendants.filter(path => path !== join(root, "config.json"))).toEqual([]);
  } finally { parent?.release(); await work; }
});

test.each((["cli", "api", "native"] as const).flatMap(surface =>
  (["first-party", "gateway"] as const).map(mode => ({ surface, mode })),
))("$surface $mode marker exception preserves apply and reaches cleanup", async ({ surface, mode }) => {
  const config = seedFirstParty(mode === "first-party" && surface === "native" ? "first-party" : "gateway");
  const state = spyOn(management, "buildClaudeDesktopState").mockResolvedValue({
    profile: { version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null } }, models: [],
  } as Awaited<ReturnType<typeof management.buildClaudeDesktopState>>);
  const models = spyOn(management, "fetchAllModels").mockResolvedValue([]);
  let armed = false;
  const barrier = paths.withConfigDirHardeningSettled;
  const admission = spyOn(paths, "withConfigDirHardeningSettled").mockImplementation(<T>(dir: string, action: () => T) => {
    if (armed) { armed = false; return Promise.reject(new Error("fixture-secret-must-not-escape")); }
    return barrier(dir, action);
  });
  const write = desktop3p.writeDesktop3pConfig;
  const writer = spyOn(desktop3p, "writeDesktop3pConfig").mockImplementation((...args) => {
    args[7] = { lockPath: join(root, "lifecycle.sqlite") };
    const result = write(...args);
    if (mode === "gateway" && result.written) queueMicrotask(() => { armed = true; });
    return result;
  });
  const apply = firstParty.applyDesktopFirstParty;
  const applier = spyOn(firstParty, "applyDesktopFirstParty").mockImplementation((...args) => {
    const result = apply(...args);
    if (mode === "first-party" && result.ok) queueMicrotask(() => { armed = true; });
    return result;
  });
  const cleanup = spyOn(firstParty, "removeDesktopFirstPartySettled").mockResolvedValue({ ok: true, changed: false, path: "fixture" });
  restores.push(() => state.mockRestore(), () => models.mockRestore(), () => admission.mockRestore(), () => writer.mockRestore(), () => applier.mockRestore(), () => cleanup.mockRestore());
  const result = surface === "cli"
    ? await applyDesktop(undefined, mode === "gateway" ? { kind: "gateway", mode: "static" } : { kind: "first-party" }, { findLiveProxyImpl: async () => null, lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") } })
    : await desktopRequest(config, surface, mode).then(async response => ({ status: response!.status, body: await response!.json() }));
  if ("body" in result) {
    expect(result.status).toBe(200);
    if (surface === "api") expect(result.body).toMatchObject({ applied: true, saved: false, mode });
  } else expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).toContain(mode === "gateway" ? "mode/profile state was not saved" : "mode marker");
  expect(JSON.stringify(result)).not.toContain("fixture-secret-must-not-escape");
  if (mode === "gateway") {
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(inspectDesktop3pConfigLibrary().kind).toBe("gateway_drifted");
  } else expect(JSON.parse(readFileSync(join(root, "claude", "settings.json"), "utf8")).env.HTTPS_PROXY).toBeString();
});

test.each(["cli", "api", "native"] as const)("%s general exception after intent reports committed state", async surface => {
  const config = seedFirstParty("gateway");
  const state = spyOn(management, "buildClaudeDesktopState").mockRejectedValue(new Error("fixture-secret-must-not-escape"));
  restores.push(() => state.mockRestore());
  const result = surface === "cli"
    ? await applyProfile(undefined, "static", { findLiveProxyImpl: async () => null, lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") } })
    : surface === "api" ? await desktopRequest(config, surface, "gateway").then(async response => ({ status: response!.status, body: await response!.json() }))
    : await (async () => {
      const path = "/api/native-integrations/claude-desktop", ctx = context(config, path, { enabled: false });
      const hook = spyOn(pickerRoutes, "runPickerTransition").mockRejectedValue(new Error("fixture-secret-must-not-escape"));
      restores.push(() => hook.mockRestore());
      const response = await management.handleManagementAPI(ctx.req, ctx.url, config, {}, "admin-token", undefined, { trustedLoopback: true });
      return { status: response!.status, body: await response!.json() };
    })();
  if ("body" in result) {
    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ desiredEnabled: surface !== "native" });
    if (surface === "api") expect(result.body).toMatchObject({ saved: false, applied: false, code: "write_failed" });
  } else expect(result).toMatchObject({ ok: false, desiredEnabled: true, saved: false, applied: false });
  expect(JSON.stringify(result)).not.toContain("fixture-secret-must-not-escape");
  expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).clientIntegrations?.["claude-desktop"] !== false).toBe(surface !== "native");
});

test.each(["cli", "api", "native"] as const)("%s gateway inspection exception rolls back first-party settings", async surface => {
  const config = seedFirstParty(surface === "native" ? "first-party" : "gateway");
  const file = join(root, "claude", "settings.json"), original = { env: { KEEP: "fixture" } };
  writeFileSync(file, JSON.stringify(original));
  let committed = false;
  const apply = firstParty.applyDesktopFirstParty, inspect = desktop3p.inspectDesktop3pConfigLibrary;
  const applier = spyOn(firstParty, "applyDesktopFirstParty").mockImplementation((...args) => {
    const result = apply(...args); queueMicrotask(() => { committed = result.ok; }); return result;
  });
  const inspector = spyOn(desktop3p, "inspectDesktop3pConfigLibrary").mockImplementation((...args) => {
    if (committed) throw new Error("fixture-secret-must-not-escape");
    return inspect(...args);
  });
  const rollback = spyOn(firstParty, "rollbackDesktopFirstPartySettled");
  restores.push(() => applier.mockRestore(), () => inspector.mockRestore(), () => rollback.mockRestore());
  const result = surface === "cli"
    ? await applyDesktop(undefined, { kind: "first-party" }, { findLiveProxyImpl: async () => null, lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") } })
    : await desktopRequest(config, surface, "first-party").then(async response => ({ status: response!.status, body: await response!.json() }));
  expect(rollback).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);
  expect(JSON.stringify(result)).not.toContain("fixture-secret-must-not-escape");
  if ("body" in result) { expect(result.status).toBe(500); expect(result.body.desiredEnabled).toBe(true); }
  else expect(result).toMatchObject({ ok: false, desiredEnabled: true, applied: false });
});

test.each(["cli", "api", "native"] as const)("%s gateway apply reports first-party cleanup exception as partial", async surface => {
  const config = seedFirstParty("gateway");
  const state = spyOn(management, "buildClaudeDesktopState").mockResolvedValue({
    profile: { version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null } }, models: [],
  } as Awaited<ReturnType<typeof management.buildClaudeDesktopState>>);
  const models = spyOn(management, "fetchAllModels").mockResolvedValue([]);
  const remove = firstParty.removeDesktopFirstPartySettled;
  const cleanup = spyOn(firstParty, "removeDesktopFirstPartySettled").mockImplementation(() =>
    remove(() => { throw new Error("fixture-secret-must-not-escape"); }));
  restores.push(() => state.mockRestore(), () => models.mockRestore(), () => cleanup.mockRestore());
  const result = surface === "cli"
    ? await applyDesktop(undefined, { kind: "gateway", mode: "static" }, { findLiveProxyImpl: async () => null, lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") } })
    : await desktopRequest(config, surface, "gateway").then(async response => ({ status: response!.status, body: await response!.json() }));
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("fixture-secret-must-not-escape");
  const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
  expect(saved.claudeCode.desktopMode).toBe("gateway");
  expect(inspectDesktop3pConfigLibrary({ appliedFingerprint: saved.claudeCode.desktopProfile.appliedFingerprint }).kind).toBe("gateway_ours");
  if ("body" in result) {
    expect(result.status).toBe(500);
    if (surface === "api") expect(result.body).toMatchObject({ applied: true, saved: true, mode: "gateway" });
    else expect(result.body.message).toContain("Gateway applied");
  } else expect(result).toMatchObject({ ok: false, reason: "first_party_settings_unreadable", warning: expect.stringContaining("gateway applied") });
});

test.each(["api", "native"] as const)("%s late gateway fingerprint timeout keeps partial apply and runs cleanup", async surface => {
  const config = seedFirstParty("gateway");
  const state = spyOn(management, "buildClaudeDesktopState").mockResolvedValue({
    profile: { version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null } }, models: [],
  } as Awaited<ReturnType<typeof management.buildClaudeDesktopState>>);
  restores.push(() => state.mockRestore());
  await paths.flushConfigDirHardeningAndReaps(root);
  const time = clock(), started = deferred();
  let parent: ReturnType<typeof holdParent> | undefined;
  let beforeMarker = "";
  const write = desktop3p.writeDesktop3pConfig;
  const hook = spyOn(desktop3p, "writeDesktop3pConfig").mockImplementation((...args) => {
    args[7] = { lockPath: join(root, "lifecycle.sqlite") };
    const result = write(...args); expect(result.written).toBe(true);
    beforeMarker = readFileSync(join(root, "config.json"), "utf8");
    queueMicrotask(() => { resetHardenedStateForTests(); parent = holdParent(); started.resolve(); });
    return result;
  });
  const cleanup = spyOn(firstParty, "removeDesktopFirstPartySettled").mockResolvedValue({ ok: true, changed: false, path: "fixture" });
  restores.push(() => hook.mockRestore(), () => cleanup.mockRestore());
  const work = desktopRequest(config, surface, "gateway").then(async value => ({ status: value!.status, body: await value!.json() }));
  try {
    await Promise.race([started.promise, work.then(() => { throw new Error("gateway not applied"); })]);
    await parent!.entered; await parent!.reached; await turn();
    time.advance(1000); await turn();
    const result = await work;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    if (surface === "api") expect(result.body).toMatchObject({ applied: true, saved: false, mode: "gateway" });
    expect(JSON.stringify(result.body)).toContain("mode/profile state was not saved");
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(beforeMarker);
    // Gateway bytes landed, but its applied fingerprint could not be saved.
    expect(inspectDesktop3pConfigLibrary().kind).toBe("gateway_drifted");
    expect(parent!.descendants).toEqual([]);
  } finally { parent?.release(); await work; }
});

test.each(["cli", "api", "native"] as const)("%s partial gateway cleanup survives late mode timeout", async surface => {
  const config = seedFirstParty(surface === "native" ? "first-party" : "gateway");
  const seeded = writeDesktop3pConfig(10100, [], [], undefined, "static", undefined, undefined, { lockPath: join(root, "lifecycle.sqlite") });
  expect(seeded.written).toBe(true);
  config.claudeCode!.desktopProfile = { version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null }, appliedFingerprint: seeded.fingerprint };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  await paths.flushConfigDirHardeningAndReaps(root);
  const time = clock(), started = deferred();
  let parent: ReturnType<typeof holdParent> | undefined;
  const hook = spyOn(desktop3p, "removeDesktop3pStandardPivot").mockImplementation(() => {
    queueMicrotask(() => { resetHardenedStateForTests(); parent = holdParent(); started.resolve(); });
    return { ok: false, changed: true, kind: "cleanup_incomplete", libraryPath: resolveDesktop3pConfigLibraryPath(), reason: "cleanup_incomplete", residualPaths: [] };
  });
  restores.push(() => hook.mockRestore());
  const work = (surface === "cli" ? applyDesktop(undefined, { kind: "first-party" }, { findLiveProxyImpl: async () => null, lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") } })
    : desktopRequest(config, surface, "first-party").then(async value => ({ status: value!.status, body: await value!.json() })))
    .then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([started.promise, work.then(() => { throw new Error("cleanup not reached"); })]);
    await parent!.entered; await parent!.reached; await turn(); time.advance(1000); await turn();
    const result = await work;
    expect(result).not.toHaveProperty("error");
    if (!("value" in result)) throw result.error;
    if ("body" in result.value) {
      expect(result.value.status).toBe(500);
      expect(result.value.body).toMatchObject({ code: surface === "api" ? "claude_desktop_gateway_removal_failed" : "native_integration_failed" });
      expect(JSON.stringify(result.value.body)).toContain("mode marker");
      if (surface === "native") expect(result.value.body).toMatchObject({ desiredEnabled: true, reason: "cleanup_incomplete" });
    } else expect(result.value).toMatchObject({ ok: false, reason: "gateway_cleanup_incomplete", warning: expect.stringContaining("mode marker") });
    expect(JSON.parse(readFileSync(join(root, "claude", "settings.json"), "utf8")).env.HTTPS_PROXY).toBeString();
    expect(parent!.descendants).toEqual([]);
  } finally { parent?.release(); await work; }
});

test("CLI gateway mode timeout retains apply result and still cleans up first-party", async () => {
  seedFirstParty();
  const state = spyOn(management, "buildClaudeDesktopState").mockResolvedValue({
    profile: { version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null } }, models: [],
  } as Awaited<ReturnType<typeof management.buildClaudeDesktopState>>);
  const models = spyOn(management, "fetchAllModels").mockResolvedValue([]);
  await paths.flushConfigDirHardeningAndReaps(root);
  const time = clock(), started = deferred();
  let parent: ReturnType<typeof holdParent> | undefined;
  const mutate = configModule.mutatePersistedConfig;
  const hook = spyOn(configModule, "mutatePersistedConfig").mockImplementation((...args: Parameters<typeof mutate>) => {
    const result = mutate(...args);
    const persisted = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
    if (!parent && persisted.claudeCode?.desktopProfile?.appliedFingerprint) {
      queueMicrotask(() => { resetHardenedStateForTests(); parent = holdParent(); started.resolve(); });
    }
    return result;
  });
  const cleanup = spyOn(firstParty, "removeDesktopFirstPartySettled").mockResolvedValue({ ok: true, changed: false, path: "fixture" });
  restores.push(() => state.mockRestore(), () => models.mockRestore(), () => hook.mockRestore(), () => cleanup.mockRestore());
  const work = applyDesktop(undefined, { kind: "gateway", mode: "static" }, { findLiveProxyImpl: async () => null,
    lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") }, probeClaudeDesktopPolicy: () => "present" })
    .then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([started.promise, work.then(() => { throw new Error("gateway not committed"); })]);
    await parent!.entered; await parent!.reached; await turn(); time.advance(1000); await turn();
    const result = await work;
    expect(result).not.toHaveProperty("error");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ value: { ok: true, warning: expect.stringContaining("mode marker") } });
    expect(parent!.descendants).toEqual([]);
  } finally { parent?.release(); await work; }
});

function blockAdmission(target: number, afterPicker = false) {
  const started = deferred(), barrier = paths.withConfigDirHardeningSettled;
  let count = 0, parent: ReturnType<typeof holdParent> | undefined;
  const begin = () => { resetHardenedStateForTests(); parent = holdParent(root, afterPicker); parent.arrive(); started.resolve(); };
  if (afterPicker) {
    const transition = pickerRoutes.runPickerTransition;
    const hook = spyOn(pickerRoutes, "runPickerTransition").mockImplementation((config, fn) => transition(config, ops => fn({ ...ops,
      disableLocked: async options => { const value = await ops.disableLocked(options); begin(); return value; },
    })));
    restores.push(() => hook.mockRestore());
  } else {
    const hook = spyOn(paths, "withConfigDirHardeningSettled").mockImplementation(<T>(dir: string, mutate: () => T) => {
      if (++count === target) begin();
      return barrier(dir, mutate);
    });
    restores.push(() => hook.mockRestore());
  }
  return { started: started.promise, get parent() { return parent!; } };
}
test.each([
  ["cli", 1], ["cli", 2], ["cli", 3], ["api", 1], ["api", 2], ["api", 3],
] as const)("%s gateway admission %i reports committed intent/profile accurately", async (surface, phase) => {
  const config = seedFirstParty();
  config.clientIntegrations = { "claude-desktop": false };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const state = spyOn(management, "buildClaudeDesktopState").mockResolvedValue({
    profile: { version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null } }, models: [],
  } as Awaited<ReturnType<typeof management.buildClaudeDesktopState>>);
  const models = spyOn(management, "fetchAllModels").mockResolvedValue([]);
  restores.push(() => state.mockRestore(), () => models.mockRestore());
  await paths.flushConfigDirHardeningAndReaps(root);
  const time = clock(), blocked = blockAdmission(phase, surface === "api" && phase === 3);
  const work = (surface === "cli" ? applyProfile(undefined, "static", { findLiveProxyImpl: async () => null, lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") } })
    : desktopRequest(config, "api", "gateway").then(async response => ({ status: response!.status, body: await response!.json() })))
    .then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([blocked.started, work.then(() => { throw new Error("target admission not reached"); })]);
    await blocked.parent.entered; await turn(); time.advance(1000); await turn();
    const result = await work;
    expect(result).not.toHaveProperty("error");
    if (!("value" in result)) throw result.error;
    const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
    expect(saved.clientIntegrations?.["claude-desktop"] !== false).toBe(phase > 1);
    expect(saved.claudeCode.desktopProfile !== undefined).toBe(phase > 2);
    expect(existsSync(resolveDesktop3pConfigLibraryPath())).toBe(false);
    if ("body" in result.value) {
      expect(result.value.status).toBe(500);
      if (phase === 1) expect(result.value.body).toMatchObject({ code: "write_failed" });
      else expect(result.value.body).toMatchObject({ desiredEnabled: true, saved: phase > 2, applied: false });
    } else {
      expect(result.value).toMatchObject({ ok: false, reason: "ca_unavailable" });
      if (phase > 1) expect(result.value).toMatchObject({ desiredEnabled: true, saved: phase > 2, applied: false, warning: expect.stringContaining("intent") });
    }
    expect(blocked.parent.descendants).toEqual([]);
  } finally { blocked.parent?.release(); await work; }
});

test.each(["profile", "bindings"] as const)("Desktop %s pre-commit timeout is a write refusal", async flow => {
  const config = seedFirstParty();
  const profile = { version: 1 as const, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null } };
  const state = spyOn(management, "buildClaudeDesktopState").mockResolvedValue({ profile, models: [] } as Awaited<ReturnType<typeof management.buildClaudeDesktopState>>);
  restores.push(() => state.mockRestore());
  await paths.flushConfigDirHardeningAndReaps(root);
  const original = readFileSync(join(root, "config.json"), "utf8"), live = JSON.stringify(config);
  const time = clock(), blocked = blockAdmission(1);
  const work = handleAgentSettingsRoutes(context(config, flow === "profile" ? "/api/claude-desktop" : "/api/claude-desktop/first-party-bindings",
    flow === "profile" ? { profile } : { remove: ["claude-opus-fixture"] }));
  try {
    await Promise.race([blocked.started, work.then(() => { throw new Error("admission not reached"); })]);
    await blocked.parent.entered; await turn(); time.advance(1000); await turn();
    const result = await work;
    expect(result?.status).toBe(500);
    expect(await result!.json()).toMatchObject({ code: "write_failed" });
    expect(JSON.stringify(config)).toBe(live);
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(original);
  } finally { blocked.parent?.release(); await work; }
});

test("CLI first-party rollback admission timeout reports retained committed intent", async () => {
  const config = seedFirstParty();
  config.claudeCode!.cliFirstParty = false;
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  await paths.flushConfigDirHardeningAndReaps(root);
  const time = clock(), blocked = blockAdmission(3);
  const ctx = context(config, "/api/claude-code", { cliFirstParty: true });
  ctx.principal = "admin-token";
  ctx.trustedLoopbackIngress = true;
  ctx.deps = { ensureClaudeIntercept: async () => ({ ok: true, state: { proxyPort: 10200, caCertPath: "fixture", pickerProxyPort: null } }),
    reconcileClaudeFirstPartySettings: () => ({ ok: false, reason: "ca_unavailable", path: "", diagnostic: { stage: "ca", cause: "ETIMEDOUT" } }),
  };
  const work = handleAgentSettingsRoutes(ctx);
  try {
    await Promise.race([blocked.started, work.then(() => { throw new Error("rollback admission not reached"); })]);
    await blocked.parent.entered; await turn(); time.advance(1000); await turn();
    const response = await work;
    expect(response?.status).toBe(500);
    expect(await response!.json()).toMatchObject({ code: "write_failed", cliFirstParty: true, warnings: ["settings_rollback_incomplete"] });
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).claudeCode.cliFirstParty).toBe(true);
    expect(config.claudeCode?.cliFirstParty).toBe(true);
  } finally { blocked.parent?.release(); await work; }
});

test("remote store timeout reports durable enable intent without claiming an apply", async () => {
  setAsyncIcaclsRunnerForTests(async () => success);
  const { fingerprint } = writeServiceApiTokenFile("ocx_desktop_fixture_token");
  const config = fixture();
  config.runtimeRole = "client";
  config.client = { serverUrl: "https://hub.example.test", managementUrl: "https://hub.example.test", managementTransport: "direct",
    selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "desktop-key", tokenFingerprint: fingerprint,
    protocolVersion: 1, connectedAt: "2026-09-06T00:00:00.000Z" };
  config.clientIntegrations = { "claude-desktop": false };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  await paths.flushConfigDirHardeningAndReaps(root);
  const time = clock(), blocked = blockAdmission(2);
  const work = applyProfile(undefined, "static", { lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") },
    downloadDesktop3pModelsImpl: async () => ({ version: 1, models: [] }), probeClaudeDesktopPolicy: () => "present" });
  try {
    await Promise.race([blocked.started, work.then(() => { throw new Error("remote admission not reached"); })]);
    await blocked.parent.entered; await turn(); time.advance(1000); await turn();
    expect(await work).toMatchObject({ ok: false, reason: "ca_unavailable", warning: expect.stringContaining("enable intent was saved") });
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).clientIntegrations?.["claude-desktop"]).not.toBe(false);
    expect(existsSync(join(root, "desktop-remote"))).toBe(false);
  } finally { blocked.parent?.release(); await work; }
});

test.each([
  ["/api/shadow-call-settings", { enabled: false }, { shadowCallIntercept: { enabled: true, model: "mock/test-model" } }],
  ["/api/claude-code", { enabled: false }, { claudeCode: { enabled: true } }],
] as const)("release publishes live and disk together: %s", async (path, body, initial) => {
  const config = Object.assign(fixture(), structuredClone(initial)), original = JSON.stringify(config);
  writeFileSync(join(root, "config.json"), original);
  const parent = holdParent(); await parent.entered;
  const handler = path === "/api/claude-code" ? handleAgentSettingsRoutes : handleConfigRoutes;
  const work = handler(context(config, path, body));
  try {
    await parent.reached; await turn();
    const beforeAdmission = JSON.stringify(config);
    parent.release(); const result = await work;
    expect(beforeAdmission).toBe(original);
    expect(result?.status).toBe(200);
    const disk = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
    if (path === "/api/claude-code") { expect(config.claudeCode?.enabled).toBe(false); expect(disk.claudeCode.enabled).toBe(false); }
    else { expect(config.shadowCallIntercept?.enabled).toBe(false); expect(disk.shadowCallIntercept.enabled).toBe(false); }
  } finally { parent.release(); await work; }
});
