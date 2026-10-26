import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as firstParty from "../../src/claude/desktop-first-party";
import * as localCa from "../../src/claude/intercept/local-ca";
import * as proxyAuth from "../../src/claude/intercept/proxy-auth";
import * as configPaths from "../../src/config/paths";
import { applyDesktop } from "../../src/cli/claude-desktop";
import { ensureClaudeDesktopMatchesDesired } from "../../src/cli/ensure-desired-integrations";
import { startClaudeIntercept } from "../../src/claude/intercept/runtime";
import { startConnectProxy } from "../../src/claude/intercept/connect-proxy";
import { flushConfigDirHardeningAndReaps, hardenConfigDir, withConfigDirHardeningSettled } from "../../src/config/paths";
import { setLocalCaWindowsAclRunnerForTests } from "../../src/claude/intercept/local-ca-windows";
import { readClaudeInterceptProxyToken } from "../../src/claude/intercept/proxy-auth";
import { hardenSecretDirAsync, resetHardenedStateForTests, setAsyncIcaclsBeltSchedulerForTests, setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests, setNowForTests, setPlatformForTests, type IcaclsResult } from "../../src/lib/windows-secret-acl";
import { setSyntheticWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const success: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const sid = "S-1-5-21-1-2-3-1001";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const keys = ["OPENCODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "OPENCODEX_ACL_VERIFY_EXISTING"] as const;
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
    await Promise.resolve();
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
  try { await Promise.resolve(); expect(mutated).toBe(false); }
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
    await Promise.resolve();
    expect(readClaudeInterceptProxyToken(root)).toBeNull();
  } finally {
    release.resolve();
    try { await (await work)?.stop(); } finally { startupCa.mockRestore(); }
  }
  expect(readClaudeInterceptProxyToken(root)).not.toBeNull();
});
