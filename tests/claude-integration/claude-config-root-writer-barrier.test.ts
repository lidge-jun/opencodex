import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import * as management from "../../src/server/management-api";
import * as paths from "../../src/config/paths";
import { applyDesktop, applyProfile } from "../../src/cli/claude-desktop";
import * as firstParty from "../../src/claude/desktop-first-party";
import { setLocalCaWindowsAclRunnerForTests } from "../../src/claude/intercept/local-ca-windows";
import { ensureClaudeDesktopMatchesDesired, type EnsureDesiredIntegrationsDeps } from "../../src/cli/ensure-desired-integrations";
import { syncEnabledClientIntegrations } from "../../src/server/management/config-routes";
import { inspectDesktop3pConfigLibrary, removeDesktop3pStandardPivot, writeDesktop3pConfig } from "../../src/claude/desktop-3p";
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
const keys = ["OPENCODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "OPENCODEX_ACL_TIMEOUT_MS", "OPENCODEX_ACL_VERIFY_EXISTING"] as const;
let root: string;
let lifecycleLock: ReturnType<typeof isolateClientLifecycleLock>;
let previous: (string | undefined)[];
let restores: Array<() => void>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-config-writer-barrier-"));
  lifecycleLock = isolateClientLifecycleLock(root);
  previous = keys.map(key => process.env[key]);
  process.env.OPENCODEX_HOME = root;
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

async function seedLateTimeoutGateway() {
  const config = fixture();
  config.claudeCode = { desktopMode: "gateway", intercept: { picker: false } };
  config.clientIntegrations = { "claude-desktop": true };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  setAsyncIcaclsRunnerForTests(async () => success);
  const seeded = writeDesktop3pConfig(10100, [], [], undefined, "static", undefined, undefined, { lockPath: join(root, "lifecycle.sqlite") });
  expect(seeded.written).toBe(true);
  config.claudeCode.desktopProfile = { version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null }, appliedFingerprint: seeded.fingerprint };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  await paths.flushConfigDirHardeningAndReaps(root);
  return config;
}

function lateTimeoutRequest(config: OcxConfig, surface: "api" | "native", enabled = true) {
  const url = new URL(`http://127.0.0.1:10100${surface === "api" ? "/api/claude-desktop/apply" : "/api/native-integrations/claude-desktop"}`);
  return management.handleManagementAPI(new Request(url, {
    method: surface === "api" ? "POST" : "PUT", headers: { Host: url.host, "content-type": "application/json" },
    body: JSON.stringify(surface === "api" ? { mode: "first-party" } : { enabled }),
  }), url, config, { ensureClaudeIntercept: async () => ({ ok: true, state: {
    proxyPort: 10200, caCertPath: join(root, "claude-intercept", "ca.pem"), pickerProxyPort: null,
  } }) }, "admin-token", undefined, { trustedLoopback: true });
}

test("native OFF late admission timeout preserves committed intent in its refusal", async () => {
  const config = await seedLateTimeoutGateway(), time = clock(), started = deferred();
  let parent: ReturnType<typeof holdParent> | undefined;
  const original = firstParty.removeDesktopFirstPartySettled;
  const hook = spyOn(firstParty, "removeDesktopFirstPartySettled").mockImplementation(async (...args) => {
    const removed = await original(...args);
    resetHardenedStateForTests(); parent = holdParent(); started.resolve();
    return removed;
  });
  restores.push(() => hook.mockRestore());
  const work = lateTimeoutRequest(config, "native", false);
  try {
    await Promise.race([started.promise, work.then(() => { throw new Error("request completed before the late flight"); })]);
    await parent!.entered; await parent!.reached; await turn();
    time.advance(1000);
    const response = await work, body = await response!.json();
    expect(response!.status).toBe(500);
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).clientIntegrations["claude-desktop"]).toBe(false);
    expect(config.clientIntegrations?.["claude-desktop"]).toBe(false);
    expect(body).toMatchObject({ code: "native_integration_failed", clientId: "claude-desktop", reason: "write_failed", desiredEnabled: false });
    expect(body.message).toContain("cleanup");
    expect(body.message).not.toContain("Nothing was written");
    expect(JSON.stringify(body)).not.toContain(JSON.stringify(root).slice(1, -1));
    expect(parent!.descendants).toEqual([]);
    time.advance(100_000); await paths.flushConfigDirHardening(root);
    expect(windowsSecretAclReapPendingForPath(root)).toBe(true);
  } finally { parent?.release(); await work; }
});

test.each([
  ["cli", false], ["api", false], ["native", false],
  ["cli", true], ["api", true], ["native", true],
] as const)("%s late admission timeout enters settled rollback (released=%s)", async (surface, releaseForRollback) => {
  const config = await seedLateTimeoutGateway(), time = clock(), started = deferred();
  if (surface === "native") {
    config.claudeCode!.desktopMode = "first-party";
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
  }
  mkdirSync(join(root, "claude"), { recursive: true });
  const settings = join(root, "claude", "settings.json"), originalSettings = { env: { KEEP: "fixture" } };
  writeFileSync(settings, JSON.stringify(originalSettings));
  setLocalCaWindowsAclRunnerForTests(() => ({ ...success, stdout: JSON.stringify({
    owner: "S-1-5-21-1-2-3-1001", protected: true,
    rules: [{ sid: "S-1-5-21-1-2-3-1001", type: 0, rights: 2032127 }],
  }) }));
  let parent: ReturnType<typeof holdParent> | undefined;
  const originalApply = firstParty.applyDesktopFirstParty;
  const hook = spyOn(firstParty, "applyDesktopFirstParty").mockImplementation((...args) => {
    const applied = originalApply(...args);
    expect(applied.ok).toBe(true);
    queueMicrotask(() => { resetHardenedStateForTests(); parent = holdParent(); started.resolve(); });
    return applied;
  });
  const originalRollback = firstParty.rollbackDesktopFirstPartySettled;
  const rollback = spyOn(firstParty, "rollbackDesktopFirstPartySettled").mockImplementation(async (...args) => {
    if (releaseForRollback) { parent!.release(); await paths.flushConfigDirHardeningAndReaps(root); }
    return originalRollback(...args);
  });
  restores.push(() => hook.mockRestore(), () => rollback.mockRestore());
  const work = (surface === "cli"
    ? applyDesktop(undefined, { kind: "first-party" }, { findLiveProxyImpl: async () => null, lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") } })
    : lateTimeoutRequest(config, surface).then(async response => ({ status: response!.status, body: await response!.json() })))
    .then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([started.promise, work.then(() => { throw new Error("apply completed before the late flight"); })]);
    await parent!.entered; await parent!.reached; await turn();
    time.advance(1000); await turn();
    // The rollback has its existing admission deadline; keep the retained child held through it.
    if (!releaseForRollback) { time.advance(1000); await turn(); }
    const result = await work;
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty("error");
    if (!("value" in result)) throw result.error;
    const value = result.value;
    if ("body" in value) {
      expect(value.status).toBe(surface === "api" || releaseForRollback ? 409 : 500);
      expect(value.body).toMatchObject(surface === "api"
        ? { code: "claude_desktop_gateway_removal_failed", reason: "acl_settlement_timeout" }
        : { code: releaseForRollback ? "native_integration_refused" : "native_integration_failed", desiredEnabled: true, reason: "write_failed" });
      expect(JSON.stringify(value.body)).not.toContain(JSON.stringify(root).slice(1, -1));
    } else {
      expect(value).toMatchObject({ ok: false, reason: "gateway_profile_active:acl_settlement_timeout" });
    }
    const outcome = "body" in value ? value.body : value;
    expect(JSON.stringify(outcome).includes("rollback did not complete")).toBe(!releaseForRollback);
    const saved = JSON.parse(readFileSync(settings, "utf8"));
    if (releaseForRollback) expect(saved).toEqual(originalSettings);
    else {
      expect(saved.env.KEEP).toBe("fixture");
      expect(saved.env.HTTPS_PROXY).toBeString();
      expect(parent!.descendants).toEqual([]);
      time.advance(100_000); await paths.flushConfigDirHardening(root);
      expect(windowsSecretAclReapPendingForPath(root)).toBe(true);
    }
    expect(inspectDesktop3pConfigLibrary({ appliedFingerprint: config.claudeCode!.desktopProfile!.appliedFingerprint }).kind).toBe("gateway_ours");
  } finally { parent?.release(); await work; }
});
function holdParent(writerRoot = root) {
  const entered = deferred(), release = deferred(), reached = deferred();
  let held = true;
  const descendants: string[] = [];
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  setIcaclsRunnerForTests(args => {
    if (held && args[0]?.startsWith(writerRoot + sep)) { descendants.push(args[0]); reached.resolve(); }
    return success;
  });
  const barrier = paths.withConfigDirHardeningSettled;
  const entry = spyOn(paths, "withConfigDirHardeningSettled").mockImplementation(<T>(dir: string, mutate: () => T) => {
    const work = barrier(dir, mutate); reached.resolve(); return work;
  });
  restores.push(() => entry.mockRestore());
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
async function putIntent(config: OcxConfig, native = false) {
  const url = new URL(`http://127.0.0.1:10100${native ? "/api/native-integrations/claude-desktop" : "/api/claude-code"}`);
  return management.handleManagementAPI(new Request(url, { method: "PUT",
    headers: { Host: url.host, "Content-Type": "application/json" }, body: JSON.stringify(native ? { enabled: false } : { cliFirstParty: false }),
  }), url, config, {}, "admin-token", undefined, { trustedLoopback: true });
}

test.each([["CLI release", false, false], ["CLI timeout", true, false], ["native release", false, true], ["native timeout", true, true]] as const)("config intent publication: %s", async (_name, timeout, native) => {
  const config = fixture(), file = join(root, "config.json");
  const original = JSON.stringify(config);
  writeFileSync(file, original);
  const time = clock(), parent = holdParent();
  await parent.entered;
  let settled = false;
  const work = putIntent(config, native).then(result => { settled = true; return result; });
  void work.finally(parent.arrive);
  try {
    await parent.reached; await turn();
    expect(parent.descendants).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(settled).toBe(false);
    if (timeout) {
      time.advance(999); await turn(); expect(settled).toBe(false);
      time.advance(1); await turn();
      const response = await work;
      expect(response?.status).toBe(500);
      if (!native) expect(await response?.json()).toMatchObject({ code: "write_failed" });
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(existsSync(join(root, "config-mutation.sqlite"))).toBe(false);
      time.advance(100_000); await paths.flushConfigDirHardening(root);
      expect(windowsSecretAclReapPendingForPath(root)).toBe(true);
    }
  } finally { parent.release(); await work; }
  if (!timeout) {
    expect((await work)?.status).toBe(200);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (native) expect(saved.clientIntegrations["claude-desktop"]).toBe(false);
    else expect(saved.claudeCode.cliFirstParty).not.toBe(true);
  }
});

test.each([["release", false], ["timeout", true]] as const)("offline gateway re-enters after discovery: %s", async (_name, timeout) => {
  writeFileSync(join(root, "config.json"), JSON.stringify(fixture()));
  const time = clock();
  let parent: ReturnType<typeof holdParent> | undefined;
  const discovered = deferred();
  const state = spyOn(management, "buildClaudeDesktopState").mockResolvedValue({
    profile: { version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null } }, models: [],
  } as Awaited<ReturnType<typeof management.buildClaudeDesktopState>>);
  restores.push(() => state.mockRestore());
  const models = spyOn(management, "fetchAllModels").mockImplementation(async () => {
    await paths.flushConfigDirHardeningAndReaps(root);
    resetHardenedStateForTests();
    parent = holdParent(resolveDesktop3pConfigLibraryPath()); await parent.entered; discovered.resolve();
    return [];
  });
  restores.push(() => models.mockRestore());
  let settled = false;
  const work = applyProfile(undefined, "static", { findLiveProxyImpl: async () => null, lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") } })
    .then(value => { settled = true; return value; }, error => { settled = true; return { ok: false, reason: error.message }; });
  void work.finally(() => { discovered.resolve(); parent?.arrive(); });
  await discovered.promise;
  const library = resolveDesktop3pConfigLibraryPath();
  try {
    await parent!.reached; await turn();
    expect(parent!.descendants).toEqual([]);
    expect(existsSync(library)).toBe(false);
    expect(settled).toBe(false);
    if (timeout) {
      time.advance(999); await turn(); expect(settled).toBe(false);
      time.advance(1); await turn();
      expect(await work).toMatchObject({ ok: false });
      expect(existsSync(library)).toBe(false);
      time.advance(100_000); await paths.flushConfigDirHardening(root);
      expect(windowsSecretAclReapPendingForPath(root)).toBe(true);
    }
  } finally { parent!.release(); await work; }
  if (!timeout) expect(await work).toMatchObject({ ok: true });
});

test.each([["release", false], ["timeout", true]] as const)("remote Desktop store re-enters after download: %s", async (_name, timeout) => {
  const { fingerprint } = writeServiceApiTokenFile("ocx_desktop_fixture_token");
  const config = fixture();
  config.runtimeRole = "client";
  config.client = { serverUrl: "https://hub.example.test", managementUrl: "https://hub.example.test", managementTransport: "direct",
    selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "desktop-key",
    tokenFingerprint: fingerprint, protocolVersion: 1, connectedAt: "2026-09-06T00:00:00.000Z" };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const time = clock(), downloaded = deferred();
  let parent: ReturnType<typeof holdParent> | undefined;
  let settled = false;
  const work = applyProfile(undefined, "static", { lifecycleLockDeps: { lockPath: join(root, "lifecycle.sqlite") },
    downloadDesktop3pModelsImpl: async () => {
      await paths.flushConfigDirHardeningAndReaps(root);
      resetHardenedStateForTests();
      parent = holdParent(join(root, "desktop-remote")); await parent.entered; downloaded.resolve();
      return { version: 1, models: [{ name: "claude-opus-4-8-20260203", labelOverride: "Fixture", anthropicFamilyTier: "sonnet",
        isFamilyDefault: true, supports1m: true }] };
    }, probeClaudeDesktopPolicy: () => "present",
  }).then(value => { settled = true; return value; }, error => { settled = true; return { ok: false, reason: error.message }; });
  void work.finally(() => { downloaded.resolve(); parent?.arrive(); });
  await downloaded.promise;
  try {
    await parent!.reached; await turn();
    expect(parent!.descendants).toEqual([]);
    expect(existsSync(join(root, "desktop-remote"))).toBe(false);
    expect(settled).toBe(false);
    if (timeout) {
      time.advance(999); await turn(); expect(settled).toBe(false);
      time.advance(1); await turn();
      expect(await work).toMatchObject({ ok: false });
      expect(existsSync(join(root, "desktop-remote"))).toBe(false);
      time.advance(100_000); await paths.flushConfigDirHardening(root);
      expect(windowsSecretAclReapPendingForPath(root)).toBe(true);
    }
  } finally { parent!.release(); await work; }
  if (!timeout) expect(await work).toMatchObject({ ok: true });
});

test.each([["refresh release", false, false], ["refresh timeout", true, false], ["cleanup release", false, true], ["cleanup timeout", true, true]] as const)("gateway maintenance: %s", async (_name, timeout, cleanup) => {
  const config = fixture();
  delete config.claudeCode!.cliFirstParty;
  config.clientIntegrations = { grok: false };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  let meta: string | undefined;
  let original: string | undefined;
  if (cleanup) {
    const seed = writeDesktop3pConfig(10100, [], [], undefined, "static", undefined, undefined, { lockPath: join(root, "lifecycle.sqlite") });
    expect(seed.written).toBe(true);
    config.claudeCode!.desktopProfile = { version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null }, appliedFingerprint: seed.fingerprint };
    config.clientIntegrations["claude-desktop"] = false;
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    meta = join(resolveDesktop3pConfigLibraryPath(), "_meta.json");
    original = readFileSync(meta, "utf8");
  }
  await paths.flushConfigDirHardeningAndReaps(root);
  const time = clock(), atAwait = deferred();
  let parent: ReturnType<typeof holdParent> | undefined;
  let settled = false;
  const beginFlight = () => { resetHardenedStateForTests(); parent = holdParent(resolveDesktop3pConfigLibraryPath()); atAwait.resolve(); };
  const work = (cleanup ? ensureClaudeDesktopMatchesDesired({
    loadConfig: () => config, stripGrokConfig: () => { throw new Error("unused"); }, syncGrokConfig: async () => { throw new Error("unused"); },
    findLiveProxyImpl: async () => null, removeDesktopPickerArtifacts: async () => ({ ok: true, removed: false }),
    removeDesktopFirstParty: () => { beginFlight(); return { ok: true, changed: false, path: "fixture" }; },
    removeDesktop3pStandardPivot,
  } as EnsureDesiredIntegrationsDeps) : syncEnabledClientIntegrations(10100, config, {
    fetchAllModels: async () => { beginFlight(); return []; }, refreshOwnedCatalogIntegrations: async () => [],
    writeDesktop3pConfig: (...args) => { args[7] = { lockPath: join(root, "lifecycle.sqlite") }; return writeDesktop3pConfig(...args); },
  })).then(value => { settled = true; return value; });
  void work.finally(() => { atAwait.resolve(); parent?.arrive(); });
  await atAwait.promise;
  try {
    await parent!.entered; await parent!.reached; await turn();
    expect(parent!.descendants).toEqual([]);
    expect(settled).toBe(false);
    if (cleanup) expect(readFileSync(meta!, "utf8")).toBe(original);
    else expect(existsSync(resolveDesktop3pConfigLibraryPath())).toBe(false);
    if (timeout) {
      time.advance(999); await turn(); expect(settled).toBe(false);
      time.advance(1); await turn(); expect(settled).toBe(true);
      if (cleanup) expect(readFileSync(meta!, "utf8")).toBe(original);
      else expect(await work).toContainEqual(expect.objectContaining({ client: "claude-desktop", ok: false }));
      time.advance(100_000); await paths.flushConfigDirHardening(root);
      expect(windowsSecretAclReapPendingForPath(root)).toBe(true);
    }
  } finally { parent!.release(); await work; }
  if (!timeout) {
    if (cleanup) expect(readFileSync(meta!, "utf8")).not.toBe(original);
    else expect(await work).toContainEqual(expect.objectContaining({ client: "claude-desktop", ok: true }));
  }
});
