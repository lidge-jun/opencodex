import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import * as firstParty from "../../src/claude/desktop-first-party";
import * as localCa from "../../src/claude/intercept/local-ca";
import * as proxyAuth from "../../src/claude/intercept/proxy-auth";
import * as configPaths from "../../src/config/paths";
import * as pickerTrust from "../../src/claude/intercept/picker-trust";
import { pickerCaFingerprints, pickerCaPendingUntrustPath, pickerStateDir } from "../../src/claude/intercept/picker-ca";
import { drainPendingPickerCaUntrust } from "../../src/claude/intercept/picker-ca-cleanup";
import { preparePersistentPickerAuthority } from "../../src/claude/intercept/picker-ca-startup";
import { createDesktopPickerController } from "../../src/claude/desktop-picker";
import { createPickerModelSnapshot } from "../../src/claude/intercept/picker-models";
import type { PickerRuntime } from "../../src/claude/intercept/picker-runtime";
import { applyDesktop } from "../../src/cli/claude-desktop";
import { ensureClaudeDesktopMatchesDesired } from "../../src/cli/ensure-desired-integrations";
import { startClaudeIntercept } from "../../src/claude/intercept/runtime";
import { startConnectProxy } from "../../src/claude/intercept/connect-proxy";
import { flushConfigDirHardeningAndReaps, hardenConfigDir, withConfigDirHardeningSettled } from "../../src/config/paths";
import { setLocalCaWindowsAclRunnerForTests } from "../../src/claude/intercept/local-ca-windows";
import { readClaudeInterceptProxyToken } from "../../src/claude/intercept/proxy-auth";
import { hardenSecretDirAsync, resetHardenedStateForTests, setAsyncIcaclsBeltSchedulerForTests, setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests, setNowForTests, setPlatformForTests, windowsSecretAclReapPendingForPath, type IcaclsResult } from "../../src/lib/windows-secret-acl";
import { setSyntheticWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";
import { handleManagementAPI } from "../../src/server/management-api";
import { previewClaudeModelDefaults } from "../../src/claude/model-default-settings";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const success: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const sid = "S-1-5-21-1-2-3-1001";
// Drain every queued microtask, however many awaits the code under test adds, without waiting on the gate.
const macrotask = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const keys = ["OPENCODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "OPENCODEX_ACL_VERIFY_EXISTING", "OPENCODEX_ACL_TIMEOUT_MS"] as const;
let root: string;
let previous: (string | undefined)[];
let entrySpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-intercept-acl-barrier-"));
  previous = keys.map(key => process.env[key]);
  process.env.OPENCODEX_HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "desktop");
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  process.env.OPENCODEX_ACL_TIMEOUT_MS = "1000";
  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setSyntheticWindowsPrincipalForTests(`*${sid}`);
  setIcaclsRunnerForTests(() => success);
  setLocalCaWindowsAclRunnerForTests(() => ({ ...success, stdout: JSON.stringify({
    owner: sid, protected: true, rules: [{ sid, type: 0, rights: 2032127 }],
  }) }));
});

test.each(["ca", "token"] as const)("first-party failure retains a sanitized %s stage and cause", stage => {
  const secret = "private-fixture-value";
  const ca = spyOn(localCa, "ensureLocalInterceptCa").mockImplementation(() => {
    if (stage === "ca") throw Object.assign(new Error(secret), { code: "EACCES" });
    return {} as ReturnType<typeof localCa.ensureLocalInterceptCa>;
  });
  const token = spyOn(proxyAuth, "ensureClaudeInterceptProxyToken").mockImplementation(() => {
    throw Object.assign(new Error(secret), { code: "EACCES" });
  });
  try {
    const result = firstParty.applyDesktopFirstParty({ port: 10100 });
    expect(result).toMatchObject({ ok: false, reason: "ca_unavailable", diagnostic: { stage, cause: "EACCES" } });
    expect(JSON.stringify(result)).not.toContain(secret);
  } finally { ca.mockRestore(); token.mockRestore(); }
});
afterEach(async () => {
  await flushConfigDirHardeningAndReaps(root);
  entrySpy?.mockRestore();
  entrySpy = undefined;
  setAsyncIcaclsRunnerForTests(null);
  setAsyncIcaclsBeltSchedulerForTests(null);
  setNowForTests(null);
  setIcaclsRunnerForTests(null);
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

test.each(["config root", "ancestor"])("startup CA waits for an ACL flight on its %s", async scope => {
  const configDir = scope === "ancestor" ? join(root, "nested-home") : root;
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const entered = deferred(), release = deferred();
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  const flight = hardenSecretDirAsync(root, { required: false });
  await entered.promise;
  const startup = localCa.ensureLocalInterceptCaForStartup(configDir);
  try {
    await macrotask();
    expect(existsSync(join(configDir, "claude-intercept"))).toBe(false);
  } finally { release.resolve(); await flight; await startup; }
  expect(existsSync(join(configDir, "claude-intercept", "ca.pem"))).toBe(true);
});

test("a settled optional deadline still waits for its live ancestor child", async () => {
  const configDir = join(root, "nested-home");
  mkdirSync(configDir, { mode: 0o700 });
  const entered = deferred(), release = deferred();
  let expire!: () => void;
  let now = 0;
  setNowForTests(() => now);
  setAsyncIcaclsBeltSchedulerForTests(callback => { expire = callback; return () => {}; });
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  const flight = hardenSecretDirAsync(root, { required: false, deadlineMs: 1_000 });
  await entered.promise;
  now = 1_001;
  expire();
  expect((await flight).ok).toBe(false);
  let mutated = false;
  const work = withConfigDirHardeningSettled(configDir, () => { mutated = true; });
  try { await macrotask(); expect(mutated).toBe(false); }
  finally { release.resolve(); await work; }
  expect(mutated).toBe(true);
});

test("the settled check and secret mutation cannot be split by a queued hardener", async () => {
  const events: string[] = [];
  let flight: Promise<unknown> | undefined;
  setAsyncIcaclsRunnerForTests(async () => { events.push("icacls"); return success; });
  await withConfigDirHardeningSettled(root, () => {
    events.push("mutation starts");
    flight = hardenSecretDirAsync(root, { required: true });
    events.push("mutation ends");
  });
  await flight;
  expect(events.slice(0, 3)).toEqual(["mutation starts", "mutation ends", "icacls"]);
});

test.each(["live-owner inspection", "post-untrust acknowledgement"])("pending cleanup gates %s with a fresh parent barrier", async step => {
  mkdirSync(pickerStateDir(root));
  const ca = localCa.createCertificateAuthority({ commonName: "pending cleanup fixture" });
  writeFileSync(pickerCaPendingUntrustPath(root), JSON.stringify({ certPem: ca.certPem, ...pickerCaFingerprints(ca.certPem) }));
  const entered = deferred(), release = deferred(), atStep = deferred();
  let held = false;
  const overlapping: string[][] = [];
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  setIcaclsRunnerForTests(args => {
    if (held && args[0]?.startsWith(pickerStateDir(root))) { overlapping.push(args); atStep.resolve(); }
    return success;
  });
  const barrier = configPaths.withConfigDirHardeningSettled;
  entrySpy = spyOn(configPaths, "withConfigDirHardeningSettled").mockImplementation(<T>(dir: string, mutate: () => T) => {
    const work = barrier(dir, mutate);
    if (held) atStep.resolve();
    return work;
  });
  const untrust = spyOn(pickerTrust, "untrustPickerCa").mockImplementation(async () => {
    if (step === "live-owner inspection") return { ok: false };
    // Simulate a new optional parent flight during the OS await, invalidating successful
    // child memos so the acknowledgement must really harden its SQLite lease again.
    resetHardenedStateForTests();
    held = true; hardenConfigDir(); await entered.promise;
    return { ok: true };
  });
  let work: Promise<unknown> | undefined;
  try {
    if (step === "live-owner inspection") { held = true; hardenConfigDir(); await entered.promise; }
    work = step === "live-owner inspection"
      ? preparePersistentPickerAuthority({ configDir: root, platform: "win32" }).then(() => "unexpected success", error => error.message)
      : drainPendingPickerCaUntrust(root);
    await atStep.promise;
    expect(overlapping).toEqual([]);
    expect(existsSync(pickerCaPendingUntrustPath(root))).toBe(true);
    if (step === "live-owner inspection") {
      expect(existsSync(join(pickerStateDir(root), "ca.lock.sqlite"))).toBe(false);
      expect(untrust).not.toHaveBeenCalled();
    }
  } finally { held = false; release.resolve(); await work; untrust.mockRestore(); }
  expect(await work).toBe(step === "live-owner inspection" ? "picker_ca_pending_untrust" : true);
  expect(existsSync(pickerCaPendingUntrustPath(root))).toBe(step === "live-owner inspection");
});

function aclClock() {
  let now = 0;
  const timers = new Map<() => void, number>();
  setNowForTests(() => now);
  setAsyncIcaclsBeltSchedulerForTests((callback, milliseconds) => {
    timers.set(callback, now + milliseconds);
    return () => { timers.delete(callback); };
  });
  return {
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [callback, deadline] of timers) {
        if (deadline <= now) { timers.delete(callback); callback(); }
      }
    },
    pending: () => timers.size,
  };
}
const nextTurn = () => new Promise<void>(done => setImmediate(done));

test("picker profile publication drains a parent flight started during trust inspection", async () => {
  const entered = deferred(), release = deferred(), atProfile = deferred();
  let held = false;
  const overlapping: string[] = [];
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  setIcaclsRunnerForTests(args => {
    if (held && args[0]?.startsWith(pickerStateDir(root))) overlapping.push(args[1]!);
    return success;
  });
  const barrier = configPaths.withConfigDirHardeningSettled;
  entrySpy = spyOn(configPaths, "withConfigDirHardeningSettled").mockImplementation(<T>(dir: string, mutate: () => T) => {
    const work = barrier(dir, mutate); if (held) atProfile.resolve(); return work;
  });
  const inspect = spyOn(pickerTrust, "inspectPickerTrust").mockImplementation(async () => {
    held = true; hardenConfigDir(); await entered.promise; return "trusted";
  });
  const runtime = { status: () => ({ desired: true, supported: true, trust: "trusted", listenerReady: true,
    effective: true, latched: false, reason: "active", models: 0, snapshotAt: null, lastBootstrapAt: null }),
    rearm: async () => {}, disarm: () => {}, refreshTrust: async () => "trusted" } as PickerRuntime;
  const controller = createDesktopPickerController({ configDir: root, platform: "win32", runtime,
    readConfig: () => ({ port: 10100, claudeCode: { desktopMode: "first-party" } }) as OcxConfig,
    persistPreference: () => true, proxyPort: () => 10201,
  });
  const work = controller.enable({ persist: false, context: "server" });
  // The unchanged writer may finish before the barrier exists; either path signals arrival.
  void work.then(() => atProfile.resolve());
  try {
    await atProfile.promise;
    expect(overlapping).toEqual([]);
    expect(existsSync(join(pickerStateDir(root), "profile-state.json"))).toBe(false);
  } finally { held = false; release.resolve(); await work; inspect.mockRestore(); }
  expect(await work).toMatchObject({ reason: "restart_required", profile: "applied", effective: true });
  expect(existsSync(join(pickerStateDir(root), "profile-state.json"))).toBe(true);
});

test("picker snapshot persistence drains a parent flight started during discovery", async () => {
  const entered = deferred(), release = deferred(), atPersist = deferred();
  const file = join(pickerStateDir(root), "models.json");
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  const barrier = configPaths.withConfigDirHardeningSettled;
  entrySpy = spyOn(configPaths, "withConfigDirHardeningSettled").mockImplementation(<T>(dir: string, mutate: () => T) => {
    const work = barrier(dir, mutate); atPersist.resolve(); return work;
  });
  const snapshot = createPickerModelSnapshot(async () => {
    hardenConfigDir(); await entered.promise; return { nativeSlugs: [], routedModels: [] };
  }, file);
  const work = snapshot.refresh();
  void work.then(() => atPersist.resolve());
  try {
    await atPersist.promise;
    expect(existsSync(file)).toBe(false);
    expect(snapshot.current()).toBeNull();
  } finally { release.resolve(); await work; }
  expect(existsSync(file)).toBe(true);
  expect(snapshot.current()?.models).toEqual([]);
});

test.each(["mutation", "active config flight", "startup", "offline apply", "native PUT", "agent-settings POST", "CLI-intent PUT", "picker transition"])("a retained child deadline refuses %s without publishing or losing cleanup ownership", async caller => {
  const clock = aclClock();
  const entered = deferred(), release = deferred(), atAdmission = deferred();
  const config = { port: 10100, providers: {}, defaultProvider: "openai",
    claudeCode: { desktopMode: "first-party", intercept: { picker: false } } } as OcxConfig;
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  const barrier = configPaths.withConfigDirHardeningSettled;
  entrySpy = spyOn(configPaths, "withConfigDirHardeningSettled").mockImplementation(<T>(dir: string, mutate: () => T) => {
    const work = barrier(dir, mutate); atAdmission.resolve(); return work;
  });
  hardenConfigDir(); await entered.promise;
  if (caller !== "active config flight") {
    clock.advance(100_000);
    await configPaths.flushConfigDirHardening(root);
    expect(windowsSecretAclReapPendingForPath(root)).toBe(true);
  }
  let mutated = false;
  let outcome: unknown = "pending";
  const controller = createDesktopPickerController({ configDir: root, platform: "win32",
    readConfig: () => ({ ...config, claudeCode: { desktopMode: "first-party" } }) as OcxConfig,
    persistPreference: () => true, proxyPort: () => 10201,
    runtime: { status: () => ({ desired: true, supported: true, trust: "unknown", listenerReady: false,
      effective: false, latched: false, reason: "starting", models: 0, snapshotAt: null, lastBootstrapAt: null }) } as PickerRuntime,
  });
  const work = (caller === "mutation" || caller === "active config flight"
    ? configPaths.withConfigDirHardeningSettled(root, () => { mutated = true; })
    : caller === "startup"
      ? localCa.ensureLocalInterceptCaForStartup(root)
      : caller === "picker transition"
        ? controller.enable({ persist: false, context: "server" })
        : caller === "offline apply"
        ? applyDesktop(undefined, { kind: "first-party" }, { findLiveProxyImpl: async () => null })
        : (async () => {
          const path = caller === "native PUT" ? "/api/native-integrations/claude-desktop"
            : caller === "CLI-intent PUT" ? "/api/claude-code" : "/api/claude-desktop/apply";
          const url = new URL(`http://127.0.0.1:10100${path}`);
          const response = await handleManagementAPI(new Request(url, { method: caller === "agent-settings POST" ? "POST" : "PUT",
            headers: { Host: url.host, "Content-Type": "application/json" },
            body: JSON.stringify(caller === "native PUT" ? { enabled: true } : caller === "CLI-intent PUT" ? { cliFirstParty: true } : { mode: "first-party" }),
          }), url, config, { ensureClaudeIntercept: async () => ({ ok: true,
            state: { proxyPort: 10200, caCertPath: join(root, "claude-intercept", "ca.pem"), pickerProxyPort: null } }) },
          "admin-token", undefined, { trustedLoopback: true });
          expect(response!.status).toBe(500);
          return response!.json();
        })())
    .then(value => { outcome = value; }, error => { outcome = { code: error.code, message: error.message }; });
  try {
    await atAdmission.promise; await nextTurn();
    expect(outcome).toBe("pending");
    clock.advance(999); await nextTurn();
    expect(outcome).toBe("pending");
    clock.advance(1); await nextTurn();
    expect(outcome).not.toBe("pending");
    if (["mutation", "active config flight", "startup"].includes(caller)) {
      expect(outcome).toMatchObject({ code: "ETIMEDOUT", message: "ACL settlement timed out" });
    } else if (caller === "picker transition") {
      expect(outcome).toMatchObject({ reason: "profile_failed", effective: false });
      expect(controller.busy()).toBe(false);
      expect(await controller.transition(async () => "lock released")).toBe("lock released");
    } else {
      expect(outcome).toMatchObject({ diagnostic: { stage: "ca", cause: "ETIMEDOUT" } });
      if (caller === "offline apply") expect(outcome).toMatchObject({ ok: false, reason: "ca_unavailable" });
    }
    expect(mutated).toBe(false);
    expect(existsSync(join(root, "claude-intercept"))).toBe(false);
    if (caller !== "active config flight") {
      expect(windowsSecretAclReapPendingForPath(root)).toBe(true);
      expect(clock.pending()).toBe(0); // No startup lease retry, timer leak, or second deadline.
    }
  } finally { release.resolve(); await work; }
  expect(mutated).toBe(false);
  expect(existsSync(join(root, "claude-intercept"))).toBe(false);
});

test("new overlapping work cannot renew the admission deadline", async () => {
  const clock = aclClock();
  const firstEntered = deferred(), firstRelease = deferred(), secondEntered = deferred(), secondRelease = deferred();
  const later = join(root, "later"); mkdirSync(later);
  setAsyncIcaclsRunnerForTests(async args => {
    if (args[0] === root) { firstEntered.resolve(); await firstRelease.promise; }
    else { secondEntered.resolve(); await secondRelease.promise; }
    return success;
  });
  const first = hardenSecretDirAsync(root, { required: false }); await firstEntered.promise;
  let mutated = false, outcome: unknown = "pending";
  const admission = withConfigDirHardeningSettled(root, () => { mutated = true; }).catch(error => { outcome = error.code; });
  await nextTurn(); clock.advance(600);
  const second = hardenSecretDirAsync(later, { required: false }); await secondEntered.promise;
  firstRelease.resolve(); await first; await nextTurn();
  try {
    expect(outcome).toBe("pending");
    clock.advance(400); await nextTurn();
    expect(outcome).toBe("ETIMEDOUT");
    expect(mutated).toBe(false);
  } finally { secondRelease.resolve(); await second; await admission; }
  expect(mutated).toBe(false);
  expect(clock.pending()).toBe(0);
});

test("diagnostics discard arbitrary error codes, names and messages", () => {
  const sensitive = "private-fixture-value";
  const ca = spyOn(localCa, "ensureLocalInterceptCa").mockImplementation(() => {
    throw Object.assign(new Error(sensitive), { code: sensitive, name: sensitive });
  });
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = firstParty.applyDesktopFirstParty({ port: 10100 });
    expect(result).toMatchObject({ ok: false, reason: "ca_unavailable", diagnostic: { stage: "ca", cause: "unknown" } });
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(warnings).toHaveBeenCalledWith("[claude-intercept] secret preparation failed: stage=ca cause=unknown");
  } finally { ca.mockRestore(); warnings.mockRestore(); }
});

test.each(["native PUT", "agent-settings POST", "CLI-intent PUT", "offline CLI"])("%s waits for the config ACL flight before creating intercept secrets", async entry => {
  const config = { port: 10100, providers: {}, defaultProvider: "openai",
    claudeCode: { desktopMode: "first-party", intercept: { picker: false } } } as OcxConfig;
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const entered = deferred(), release = deferred(), atApply = deferred();
  let pending = true;
  const overlapping: string[] = [];
  setAsyncIcaclsRunnerForTests(async args => {
    if (args[0] === root) { entered.resolve(); await release.promise; }
    return success;
  });
  setIcaclsRunnerForTests(args => {
    if (pending && args[0]?.startsWith(join(root, "claude-intercept"))) {
      overlapping.push(args[1]!); atApply.resolve();
    }
    return success;
  });
  const originalBarrier = configPaths.withConfigDirHardeningSettled;
  entrySpy = spyOn(configPaths, "withConfigDirHardeningSettled").mockImplementation(<T>(dir: string, mutate: () => T): Promise<T> => {
    const work = originalBarrier(dir, mutate);
    atApply.resolve(); return work;
  });
  hardenConfigDir();
  await entered.promise;
  const request = entry === "offline CLI"
    ? applyDesktop(undefined, { kind: "first-party" }, { findLiveProxyImpl: async () => null })
    : (async () => {
      const path = entry === "native PUT" ? "/api/native-integrations/claude-desktop"
        : entry === "CLI-intent PUT" ? "/api/claude-code" : "/api/claude-desktop/apply";
      const url = new URL(`http://127.0.0.1:10100${path}`);
      const response = await handleManagementAPI(new Request(url, { method: entry === "agent-settings POST" ? "POST" : "PUT",
        headers: { Host: url.host, "Content-Type": "application/json" },
        body: JSON.stringify(entry === "native PUT" ? { enabled: true } : entry === "CLI-intent PUT" ? { cliFirstParty: true } : { mode: "first-party" }),
      }), url, config, { ensureClaudeIntercept: async () => ({ ok: true,
        state: { proxyPort: 10200, caCertPath: join(root, "claude-intercept", "ca.pem"), pickerProxyPort: null } }) },
      "admin-token", undefined, { trustedLoopback: true });
      const body = await response!.json();
      expect(response!.status, JSON.stringify(body)).toBe(200);
      return body;
    })();
  try {
    // Observe arrival at either the real barrier or the first child ACL command. This
    // handshake covers dynamic imports without sleeps or a guessed microtask count.
    await atApply.promise;
    expect(overlapping).toEqual([]);
    expect(existsSync(join(root, "claude-intercept"))).toBe(false);
  } finally { pending = false; release.resolve(); await request; }
  expect(await request).toMatchObject({ ok: true });
  expect(existsSync(join(root, "claude-intercept", "ca.pem"))).toBe(true);
  expect(readClaudeInterceptProxyToken(root)).not.toBeNull();
});

test("desired-state CLI reconciliation waits immediately before its synchronous leaf", async () => {
  const config = { port: 10100, claudeCode: { desktopMode: "first-party", cliFirstParty: true } } as OcxConfig;
  const entered = deferred(), release = deferred(), inspected = deferred();
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  hardenConfigDir();
  await entered.promise;
  const original = firstParty.inspectDesktopFirstParty;
  const inspection = spyOn(firstParty, "inspectDesktopFirstParty").mockImplementation((...args) => {
    const result = original(...args); inspected.resolve(); return result;
  });
  const work = ensureClaudeDesktopMatchesDesired({ loadConfig: () => config, log: () => {}, error: () => {} } as Parameters<typeof ensureClaudeDesktopMatchesDesired>[0]);
  try {
    await inspected.promise;
    expect(existsSync(join(root, "claude-intercept"))).toBe(false);
  } finally { release.resolve(); await work; inspection.mockRestore(); }
  expect(readClaudeInterceptProxyToken(root)).not.toBeNull();
});

test("runtime token creation drains a parent flight started during the CA await", async () => {
  const ca = localCa.ensureLocalInterceptCa(root);
  const entered = deferred(), release = deferred(), returnedCa = deferred();
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  const startupCa = spyOn(localCa, "ensureLocalInterceptCaForStartup").mockImplementation(async () => {
    hardenConfigDir(); await entered.promise; returnedCa.resolve(); return ca;
  });
  const work = startClaudeIntercept({ config: { claudeCode: { cliFirstParty: true } } as OcxConfig,
    publicPort: 10100, configDir: root, dispatch: async () => new Response("ok"), pickerPlatform: "linux",
    startProxy: async (_port, options) => startConnectProxy(0, options),
  });
  try {
    await returnedCa.promise;
    await macrotask();
    expect(readClaudeInterceptProxyToken(root)).toBeNull();
  } finally {
    release.resolve();
    try { await (await work)?.stop(); } finally { startupCa.mockRestore(); }
  }
  expect(readClaudeInterceptProxyToken(root)).not.toBeNull();
});

// #7777 review r2 F3: a CLAUDE_CONFIG_DIR nested in the opencodex home shares the config-root
// flight, so its credential-bearing settings rewrites need the same fresh admission.
test("startup settings migration after the proxy bind waits for a parent flight over a nested Claude home", async () => {
  const overlapping: string[] = [];
  let held = false;
  setIcaclsRunnerForTests(args => {
    if (held && args[0]?.startsWith(join(root, "claude") + sep)) overlapping.push(args[1] ?? "");
    return success;
  });
  const entered = deferred(), release = deferred();
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  expect(firstParty.applyDesktopFirstParty({ port: 10100 })).toMatchObject({ ok: true });
  const work = startClaudeIntercept({ config: { port: 10100, claudeCode: { cliFirstParty: true } } as OcxConfig,
    configDir: root, publicPort: 10100, dispatch: async () => new Response("ok"), pickerPlatform: "linux",
    startProxy: async (_port, options) => {
      const proxy = await startConnectProxy(0, options);
      held = true; hardenConfigDir(); await entered.promise;
      return proxy;
    },
  });
  let handle: Awaited<typeof work> | undefined;
  try {
    await entered.promise;
    await macrotask();
    expect(overlapping).toEqual([]);
  } finally {
    held = false; release.resolve();
    handle = await work;
  }
  try {
    // The ordering check alone would also pass if startup skipped the migration entirely.
    const env = (JSON.parse(readFileSync(join(root, "claude", "settings.json"), "utf8")) as { env?: Record<string, string> }).env;
    expect(handle?.proxyPort).toBeGreaterThan(0);
    expect(env?.HTTPS_PROXY).toContain(`:${handle?.proxyPort}`);
  } finally { await handle?.stop(); }
});

test("settled first-party removal waits for a parent flight over a nested Claude home", async () => {
  expect(firstParty.applyDesktopFirstParty({ port: 10100 })).toMatchObject({ ok: true });
  const entered = deferred(), release = deferred();
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  const flight = hardenSecretDirAsync(root, { required: false });
  await entered.promise;
  let removed = false;
  const work = firstParty.removeDesktopFirstPartySettled(() => ({}), {}, (config, options) => {
    removed = true;
    return firstParty.removeDesktopFirstParty(config, options);
  });
  try { await macrotask(); expect(removed).toBe(false); }
  finally { release.resolve(); await flight; }
  expect(await work).toMatchObject({ ok: true, changed: true });
  expect(removed).toBe(true);
});

// #7777 review r3 F4: the model-defaults rewrite also runs after a body await on the Claude home.
test("model-defaults POST waits for a parent flight over a nested Claude home", async () => {
  const home = join(root, "claude");
  mkdirSync(home, { recursive: true });
  const path = join(home, "settings.json");
  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: "http://opencodex:fixture-token@127.0.0.1:10200" } }));
  const models = { sonnet: "claude-sonnet-4-6" };
  const fingerprint = previewClaudeModelDefaults(models).fingerprint;
  const overlapping: string[] = [];
  let held = true;
  setIcaclsRunnerForTests(args => { if (held && args[0]?.startsWith(home + sep)) overlapping.push(args[1] ?? ""); return success; });
  const entered = deferred(), release = deferred();
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  hardenConfigDir();
  await entered.promise;
  const url = new URL("http://127.0.0.1:10100/api/claude-code/model-defaults");
  const work = handleManagementAPI(new Request(url, { method: "POST", headers: { Host: url.host, "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint }) }), url, { port: 10100, providers: {}, claudeCode: { tierModels: models } } as OcxConfig,
    {}, "admin-token", undefined, { trustedLoopback: true });
  try {
    await macrotask();
    expect(overlapping).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
  } finally { held = false; release.resolve(); }
  expect((await work)?.status).toBe(200);
  expect(JSON.parse(readFileSync(path, "utf8")).env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(models.sonnet);
});
