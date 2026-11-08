import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySystemEnvToggle, injectSystemEnv, revertSystemEnv } from "../../src/server/system-env";
import { PROXY_MARKER } from "../../src/claude/auth-detect";
import { claudeKeychain } from "../../src/lib/claude-keychain";
import * as contextWindows from "../../src/claude/context-windows";
import * as configMutation from "../../src/config/mutation-lock";
import * as configDiagnostics from "../../src/config/diagnostics";
import type { OcxConfig } from "../../src/types";

/**
 * Auto must reach PLAIN `claude` launches, not just `ocx claude`. Before this, the
 * shell-env file and launchctl keyed on a stored "proxy", so an auto+absent user got
 * nothing from auto-connect (devlog 260726_claude_auth_auto/035).
 *
 * The detector reads HOME-relative files and probes the macOS keychain, so these
 * tests point HOME and CLAUDE_CONFIG_DIR at an empty temp dir AND stub the Keychain
 * probe with an authoritative absent result. Without the stub the
 * suite reads the developer's own keychain and every assertion inverts.
 */

const originalPlatform = process.platform;
let execSpy: ReturnType<typeof spyOn>;
let keychainSpy: ReturnType<typeof spyOn>;
let readSpy: ReturnType<typeof spyOn>;
let writeSpy: ReturnType<typeof spyOn>;
let mkdirSpy: ReturnType<typeof spyOn>;
let unlinkSpy: ReturnType<typeof spyOn>;
let configLockSpy: ReturnType<typeof spyOn>;
let configGenerationSpy: ReturnType<typeof spyOn>;
let configSnapshotSpy: ReturnType<typeof spyOn>;
let configBumpSpy: ReturnType<typeof spyOn>;
let shellEnvContents = "";
let fakeTracking: string | undefined;
let fakeLaunchd: Map<string, string>;
let fakeConfigGeneration = 0;
let previousConfigDir: string | undefined;
let previousHome: string | undefined;
let previousApiKey: string | undefined;
let previousAuthToken: string | undefined;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

const baseConfig = {
  port: 4096,
  providers: {},
  defaultProvider: "test",
  claudeCode: { systemEnv: true },
} as unknown as OcxConfig;

beforeEach(() => {
  setPlatform("darwin");
  configLockSpy = spyOn(configMutation, "withConfigMutationLockSync").mockImplementation((fn => fn()) as never);
  fakeConfigGeneration = 0;
  configGenerationSpy = spyOn(configMutation, "readConfigGenerationInCurrentMutationTransaction").mockImplementation(() => ({ value: fakeConfigGeneration }));
  configBumpSpy = spyOn(configMutation, "bumpGenerationForCooperatingConfigWrite").mockImplementation(() => { fakeConfigGeneration++; });
  configSnapshotSpy = spyOn(configDiagnostics, "readConfigFileSnapshot").mockReturnValue({
    diagnostics: { source: "default", error: null, config: baseConfig },
  });
  shellEnvContents = "";
  fakeTracking = undefined;
  fakeLaunchd = new Map();
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  previousHome = process.env.HOME;
  // The detector also reads the AMBIENT env (source S5). A runner that exports an
  // Anthropic key would otherwise make "no detectable auth" quietly false and invert
  // every assertion below for reasons unrelated to this code.
  previousApiKey = process.env.ANTHROPIC_API_KEY;
  previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  // An empty profile dir + a HOME with no ~/.claude.json = detection "absent".
  const empty = fs.mkdtempSync(join(tmpdir(), "ocx-sysenv-"));
  process.env.CLAUDE_CONFIG_DIR = empty;
  process.env.HOME = empty;

  execSpy = spyOn(childProcess, "execFileSync").mockImplementation(((file: string, args?: string[]) => {
    if (file === "/bin/launchctl" && args?.[0] === "getenv") return fakeLaunchd.get(args[1]!) ?? "";
    if (file === "/bin/launchctl" && args?.[0] === "setenv") fakeLaunchd.set(args[1]!, args[2]!);
    if (file === "/bin/launchctl" && args?.[0] === "unsetenv") fakeLaunchd.delete(args[1]!);
    return "";
  }) as never);
  keychainSpy = spyOn(claudeKeychain, "probe").mockResolvedValue({ status: "absent" });
  readSpy = spyOn(fs, "readFileSync").mockImplementation(((path: string) => {
    if (String(path).includes("system-env-port")) {
      if (fakeTracking !== undefined) return fakeTracking;
      throw new Error("ENOENT");
    }
    return "";
  }) as never);
  writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((path: string, data: string) => {
    if (String(path).includes("claude-env.sh")) shellEnvContents = String(data);
    if (String(path).includes("system-env-port")) fakeTracking = String(data);
  }) as never);
  unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(((path: string) => {
    if (String(path).includes("system-env-port")) fakeTracking = undefined;
    if (String(path).includes("claude-env.sh")) shellEnvContents = "";
  }) as never);
  mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  configSnapshotSpy.mockRestore();
  configBumpSpy.mockRestore();
  configGenerationSpy.mockRestore();
  configLockSpy.mockRestore();
  execSpy.mockRestore();
  keychainSpy.mockRestore();
  readSpy.mockRestore();
  writeSpy.mockRestore();
  unlinkSpy.mockRestore();
  mkdirSpy.mockRestore();
  setPlatform(originalPlatform);
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousApiKey;
  if (previousAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = previousAuthToken;
});

// THE point of this phase: an auto config with no detectable auth must still wire up
// plain `claude`, exactly as a stored "proxy" always did.
test("auto with no detectable auth writes the proxy marker", async () => {
  await injectSystemEnv(4567, baseConfig);
  expect(shellEnvContents).toContain(`ANTHROPIC_AUTH_TOKEN='${PROXY_MARKER}'`);
});

test("disabling system environment during a pending Keychain probe prevents late injection", async () => {
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  keychainSpy.mockImplementation(async () => { started(); await blocked; return { status: "absent" }; });
  try {
    const pending = injectSystemEnv(4567, baseConfig);
    await entered;
    await applySystemEnvToggle({ ...baseConfig, claudeCode: { systemEnv: false } }, 4567);
    release();
    expect(await pending).toMatchObject({ injected: false });
    expect(execSpy.mock.calls.filter(call => call[0] === "/bin/launchctl"
      && (call[1] as string[] | undefined)?.[0] === "setenv")).toHaveLength(0);
    expect(shellEnvContents).toBe("");
  } finally { release(); }
});

test("a simulated external config generation change invalidates a pending injection", async () => {
  let started!: () => void, release!: () => void, generation = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  configGenerationSpy.mockImplementation(() => ({ value: generation }));
  keychainSpy.mockImplementation(async () => { started(); await blocked; return { status: "absent" }; });
  try {
    const pending = injectSystemEnv(4567, baseConfig);
    await entered; generation++; release();
    expect(await pending).toMatchObject({ injected: false });
    expect(execSpy.mock.calls.filter(call => call[0] === "/bin/launchctl"
      && (call[1] as string[] | undefined)?.[0] === "setenv")).toHaveLength(0);
    expect(shellEnvContents).toBe("");
  } finally { release(); }
});

test("an already stale enabled configuration cannot override the saved disabled state", async () => {
  configSnapshotSpy.mockReturnValue({
    diagnostics: { source: "file", error: null, config: { ...baseConfig, claudeCode: { systemEnv: false } } }, raw: "synthetic",
  });
  expect(await injectSystemEnv(4567, baseConfig)).toMatchObject({ injected: false });
  expect(keychainSpy).not.toHaveBeenCalled();
  expect(execSpy.mock.calls.filter(call => call[0] === "/bin/launchctl"
    && (call[1] as string[] | undefined)?.[0] === "setenv")).toHaveLength(0);
});

for (const stale of [
  { systemEnv: true, authMode: "proxy" as const },
  { systemEnv: false },
  { systemEnv: true, enabled: false },
]) {
  test(`an ineligible older request cannot cancel the current reconciliation (${JSON.stringify(stale)})`, async () => {
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    configSnapshotSpy.mockReturnValue({ diagnostics: { source: "file", error: null, config: baseConfig }, raw: "synthetic" });
    keychainSpy.mockImplementation(async () => { started(); await blocked; return { status: "absent" }; });
    try {
      const current = injectSystemEnv(4567, baseConfig);
      await entered;
      expect(await injectSystemEnv(4567, { ...baseConfig, claudeCode: stale })).toMatchObject({ injected: false });
      release();
      expect(await current).toEqual({ injected: true });
    } finally { release(); }
  });
}

test("a stale disabled settings request cannot revert a newer enabled configuration", async () => {
  configSnapshotSpy.mockReturnValue({ diagnostics: { source: "file", error: null, config: baseConfig }, raw: "synthetic" });
  expect(await applySystemEnvToggle({ ...baseConfig, claudeCode: { systemEnv: false } }, 4567))
    .toEqual({ reverted: false, reason: "superseded" });
  expect(configBumpSpy).not.toHaveBeenCalled();
});

test("an explicit revert advances the shared generation even without a tracking file", async () => {
  expect(configBumpSpy).not.toHaveBeenCalled();
  await applySystemEnvToggle({ ...baseConfig, claudeCode: { systemEnv: false } }, 4567);
  expect(configBumpSpy).toHaveBeenCalledTimes(1);
});

test("an unavailable config coordinator refuses a revert without touching launchd", () => {
  configLockSpy.mockImplementation(() => { throw new Error("synthetic coordinator busy"); });
  expect(revertSystemEnv()).toEqual({ reverted: false, reason: "coordination unavailable" });
  expect(execSpy).not.toHaveBeenCalled();
});

test("removing the saved configuration during a pending probe prevents injection", async () => {
  let started!: () => void, release!: () => void, present = true;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  configSnapshotSpy.mockImplementation(() => ({
    diagnostics: { source: present ? "file" : "default", error: null, config: baseConfig },
    ...(present ? { raw: "synthetic" } : {}),
  }));
  keychainSpy.mockImplementation(async () => { started(); await blocked; return { status: "absent" }; });
  try {
    const pending = injectSystemEnv(4567, baseConfig);
    await entered; present = false; release();
    expect(await pending).toMatchObject({ injected: false });
    expect(execSpy.mock.calls.filter(call => call[0] === "/bin/launchctl"
      && (call[1] as string[] | undefined)?.[0] === "setenv")).toHaveLength(0);
  } finally { release(); }
});

test("newer enabled settings supersede a pending Keychain observation", async () => {
  let started!: () => void, release!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  keychainSpy.mockImplementation(async () => {
    if (++calls === 1) { started(); await blocked; }
    return { status: "absent" };
  });
  try {
    const old = injectSystemEnv(4567, baseConfig);
    await entered;
    const newer = await injectSystemEnv(4567, { ...baseConfig, claudeCode: { systemEnv: true, authMode: "subscription" } });
    expect(newer).toMatchObject({ injected: true });
    const writes = execSpy.mock.calls.filter(call => call[0] === "/bin/launchctl"
      && (call[1] as string[] | undefined)?.[0] === "setenv").length;
    release();
    expect(await old).toMatchObject({ injected: false });
    expect(execSpy.mock.calls.filter(call => call[0] === "/bin/launchctl"
      && (call[1] as string[] | undefined)?.[0] === "setenv")).toHaveLength(writes);
    expect(shellEnvContents).not.toContain(PROXY_MARKER);
  } finally { release(); }
});

test("disabling system environment while model resolution is pending prevents later writes", async () => {
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const windows = spyOn(contextWindows, "boundedContextWindows").mockImplementation(async () => {
    started(); await blocked; return {};
  });
  try {
    const pending = injectSystemEnv(4567, baseConfig);
    await entered;
    await applySystemEnvToggle({ ...baseConfig, claudeCode: { systemEnv: false } }, 4567);
    const writes = execSpy.mock.calls.filter(call => call[0] === "/bin/launchctl"
      && (call[1] as string[] | undefined)?.[0] === "setenv").length;
    release();
    expect(await pending).toMatchObject({ injected: false });
    expect(execSpy.mock.calls.filter(call => call[0] === "/bin/launchctl"
      && (call[1] as string[] | undefined)?.[0] === "setenv")).toHaveLength(writes);
    expect(shellEnvContents).toBe("");
  } finally { release(); windows.mockRestore(); }
});

test("a foreign tracking owner arriving during model resolution is not overwritten", async () => {
  let started!: () => void, release!: () => void, tracking: string | undefined;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  readSpy.mockImplementation(((path: string) => {
    if (String(path).includes("system-env-port")) {
      if (tracking !== undefined) return tracking;
      throw Object.assign(new Error("synthetic missing file"), { code: "ENOENT" });
    }
    return "";
  }) as never);
  const windows = spyOn(contextWindows, "boundedContextWindows").mockImplementation(async () => {
    started(); await blocked; return {};
  });
  try {
    const pending = injectSystemEnv(4567, baseConfig);
    await entered;
    tracking = JSON.stringify({ pid: 123, port: 4568, injectedAt: "synthetic" });
    release();
    expect(await pending).toMatchObject({ injected: false });
    expect(execSpy.mock.calls.filter(call => call[0] === "/bin/launchctl"
      && (call[1] as string[] | undefined)?.[0] === "setenv")).toHaveLength(0);
  } finally { release(); windows.mockRestore(); }
});

test("failed initial injection rolls back before a later owner can take over", async () => {
  const failure = new Error("synthetic launchctl failure");
  const foreign = "http://127.0.0.1:4568";
  let foreignArrived = false;
  const log = spyOn(console, "error").mockImplementation(() => {});
  configLockSpy.mockImplementation((fn => {
    try { return fn(); }
    catch (error) {
      if (error === failure) {
        foreignArrived = true;
        fakeLaunchd.set("ANTHROPIC_BASE_URL", foreign);
        fakeTracking = JSON.stringify({ pid: 42, port: 4568, injectedAt: "synthetic-foreign" });
      }
      throw error;
    }
  }) as never);
  execSpy.mockImplementation(((file: string, args?: string[]) => {
    if (file !== "/bin/launchctl") return "";
    if (args?.[0] === "getenv") return fakeLaunchd.get(args[1]!) ?? "";
    if (args?.[0] === "setenv" && args[1] === "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY") throw failure;
    if (args?.[0] === "setenv") fakeLaunchd.set(args[1]!, args[2]!);
    if (args?.[0] === "unsetenv") fakeLaunchd.delete(args[1]!);
    return "";
  }) as never);
  try {
    await expect(injectSystemEnv(4567, baseConfig)).rejects.toBe(failure);
    expect(foreignArrived).toBe(true);
    expect(fakeLaunchd.get("ANTHROPIC_BASE_URL")).toBe(foreign);
    expect(JSON.parse(fakeTracking!)).toMatchObject({ pid: 42, port: 4568 });
  } finally { log.mockRestore(); }
});

test("a database commit failure compensates its environment writes and surfaces the error", async () => {
  const failure = new Error("synthetic transaction commit failed");
  const original = fakeConfigGeneration;
  let injectionCallbackReturned = false;
  const log = spyOn(console, "error").mockImplementation(() => {});
  configLockSpy.mockImplementation((fn => {
    const value = fn();
    if (!injectionCallbackReturned && fakeTracking !== undefined && fakeConfigGeneration > original) {
      injectionCallbackReturned = true;
      fakeConfigGeneration = original;
      throw failure;
    }
    return value;
  }) as never);
  try {
    await expect(injectSystemEnv(4567, baseConfig)).rejects.toBe(failure);
    expect(injectionCallbackReturned).toBe(true);
    expect(fakeLaunchd.size).toBe(0);
    expect(fakeTracking).toBeUndefined();
    expect(shellEnvContents).toBe("");
  } finally { log.mockRestore(); }
});

test("commit failure never compensates over a replacement environment owner", async () => {
  const failure = new Error("synthetic transaction commit failed");
  const original = fakeConfigGeneration;
  const foreign = "http://127.0.0.1:4568";
  let failed = false;
  configLockSpy.mockImplementation((fn => {
    const value = fn();
    if (!failed && fakeTracking !== undefined && fakeConfigGeneration > original) {
      failed = true;
      fakeConfigGeneration = original + 1;
      fakeTracking = JSON.stringify({ pid: 42, port: 4568, injectedAt: "synthetic-foreign" });
      fakeLaunchd.set("ANTHROPIC_BASE_URL", foreign);
      throw failure;
    }
    return value;
  }) as never);
  await expect(injectSystemEnv(4567, baseConfig)).rejects.toThrow("ownership could not be recovered");
  expect(failed).toBe(true);
  expect(fakeLaunchd.get("ANTHROPIC_BASE_URL")).toBe(foreign);
  expect(JSON.parse(fakeTracking!)).toMatchObject({ pid: 42, port: 4568 });
});

test("a completed injection cannot run a follow-up after another owner replaces it", async () => {
  const { captureSystemEnvFollowup } = await import("../../src/server/system-env");
  const result = await injectSystemEnv(4567, baseConfig);
  expect(result).toEqual({ injected: true });
  const followup = captureSystemEnvFollowup(baseConfig, result);
  let writes = 0;
  expect(followup?.(() => { writes++; })).toBe(true);
  fakeTracking = JSON.stringify({ pid: 42, port: 4568, injectedAt: "synthetic-foreign" });
  fakeLaunchd.set("ANTHROPIC_BASE_URL", "http://127.0.0.1:4568");
  expect(followup?.(() => { writes++; })).toBe(false);
  expect(writes).toBe(1);
});

test("a disabled-state follow-up cannot run after the saved config changes", async () => {
  const { captureSystemEnvFollowup } = await import("../../src/server/system-env");
  const disabled = { ...baseConfig, claudeCode: { systemEnv: false } };
  configSnapshotSpy.mockReturnValue({ diagnostics: { source: "file", error: null, config: disabled }, raw: "synthetic" });
  const result = await injectSystemEnv(4567, disabled);
  const followup = captureSystemEnvFollowup(disabled, result);
  let writes = 0;
  expect(followup?.(() => { writes++; })).toBe(true);
  configSnapshotSpy.mockReturnValue({ diagnostics: { source: "file", error: null, config: baseConfig }, raw: "synthetic-new" });
  fakeConfigGeneration++;
  expect(followup?.(() => { writes++; })).toBe(false);
  expect(writes).toBe(1);
});

test("a disabled-state follow-up cannot write after another environment owner appears", async () => {
  const { captureSystemEnvFollowup } = await import("../../src/server/system-env");
  const disabled = { ...baseConfig, claudeCode: { systemEnv: false } };
  configSnapshotSpy.mockReturnValue({ diagnostics: { source: "file", error: null, config: disabled }, raw: "synthetic" });
  const followup = captureSystemEnvFollowup(disabled, await injectSystemEnv(4567, disabled));
  fakeTracking = JSON.stringify({ pid: 42, port: 4568, injectedAt: "synthetic-foreign" });
  fakeLaunchd.set("ANTHROPIC_BASE_URL", "http://127.0.0.1:4568");
  let writes = 0;
  expect(followup?.(() => { writes++; })).toBe(false);
  expect(writes).toBe(0);
});

test("a follow-up refuses an already live foreign environment owner", async () => {
  const { captureSystemEnvFollowup } = await import("../../src/server/system-env");
  fakeTracking = JSON.stringify({ pid: 42, port: 4568, injectedAt: "synthetic-foreign" });
  fakeLaunchd.set("ANTHROPIC_BASE_URL", "http://127.0.0.1:4568");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  try {
    const result = await injectSystemEnv(4567, baseConfig);
    expect(result).toEqual({ injected: false, reason: "another instance owns env (port 4568)" });
    expect(captureSystemEnvFollowup(baseConfig, result)).toBeUndefined();
  } finally { fetchSpy.mockRestore(); }
});

test("a follow-up refuses and reports a busy coordinator", async () => {
  const { captureSystemEnvFollowup } = await import("../../src/server/system-env");
  const result = await injectSystemEnv(4567, baseConfig);
  const followup = captureSystemEnvFollowup(baseConfig, result);
  const log = spyOn(console, "error").mockImplementation(() => {});
  let writes = 0;
  try {
    configLockSpy.mockImplementation(() => { throw new Error("synthetic busy"); });
    expect(followup?.(() => { writes++; })).toBe(false);
    expect(writes).toBe(0);
    expect(log).toHaveBeenCalledWith("System environment follow-up unavailable.");
  } finally { log.mockRestore(); }
});

test("disabling during gateway fetch prevents late cache and tracking writes", async () => {
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const savedFetch = globalThis.fetch;
  const values = new Map<string, string>();
  let tracking: string | undefined, cacheWrites = 0;
  const unlink = spyOn(fs, "unlinkSync").mockImplementation(((path: string) => {
    if (String(path).includes("system-env-port")) tracking = undefined;
    if (String(path).includes("claude-env.sh")) shellEnvContents = "";
  }) as never);
  execSpy.mockImplementation(((file: string, args?: string[]) => {
    if (file !== "/bin/launchctl") return "";
    if (args?.[0] === "getenv") return values.get(args[1]!) ?? "";
    if (args?.[0] === "setenv") values.set(args[1]!, args[2]!);
    if (args?.[0] === "unsetenv") values.delete(args[1]!);
    return "";
  }) as never);
  readSpy.mockImplementation(((path: string) => {
    if (String(path).includes("system-env-port") && tracking !== undefined) return tracking;
    throw Object.assign(new Error("synthetic missing file"), { code: "ENOENT" });
  }) as never);
  writeSpy.mockImplementation(((path: string, data: string) => {
    if (String(path).includes("system-env-port")) tracking = String(data);
    if (String(path).includes("claude-env.sh")) shellEnvContents = String(data);
    if (String(path).includes("gateway-models.json")) cacheWrites++;
  }) as never);
  globalThis.fetch = (async () => {
    started(); await blocked;
    return Response.json({ data: [{ id: "synthetic-claude-model" }] });
  }) as typeof fetch;
  try {
    const pending = injectSystemEnv(4567, baseConfig);
    await entered;
    expect(values.get("ANTHROPIC_BASE_URL")).toBe("http://127.0.0.1:4567");
    expect(await applySystemEnvToggle({ ...baseConfig, claudeCode: { systemEnv: false } }, 4567)).toMatchObject({ reverted: true });
    release();
    expect(await pending).toMatchObject({ injected: false });
    expect(values.size).toBe(0);
    expect(tracking).toBeUndefined();
    expect(shellEnvContents).toBe("");
    expect(cacheWrites).toBe(0);
  } finally { release(); globalThis.fetch = savedFetch; unlink.mockRestore(); }
});

test("a stale health probe cannot undo a newer system environment revert", async () => {
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const savedFetch = globalThis.fetch;
  let tracking: string | undefined = JSON.stringify({ pid: 1, port: 4567, injectedAt: "synthetic",
    injectedKeys: ["ANTHROPIC_BASE_URL"] });
  const values = new Map([["ANTHROPIC_BASE_URL", "http://127.0.0.1:4567"]]);
  const unlink = spyOn(fs, "unlinkSync").mockImplementation(((path: string) => {
    if (String(path).includes("system-env-port")) tracking = undefined;
  }) as never);
  execSpy.mockImplementation(((file: string, args?: string[]) => {
    if (file !== "/bin/launchctl") return "";
    if (args?.[0] === "getenv") return values.get(args[1]!) ?? "";
    if (args?.[0] === "setenv") values.set(args[1]!, args[2]!);
    if (args?.[0] === "unsetenv") values.delete(args[1]!);
    return "";
  }) as never);
  readSpy.mockImplementation(((path: string) => {
    if (String(path).includes("system-env-port") && tracking !== undefined) return tracking;
    throw Object.assign(new Error("synthetic missing file"), { code: "ENOENT" });
  }) as never);
  globalThis.fetch = (async () => { started(); await blocked; return new Response(null, { status: 503 }); }) as typeof fetch;
  try {
    const pending = injectSystemEnv(4567, baseConfig);
    await entered;
    expect(await applySystemEnvToggle({ ...baseConfig, claudeCode: { systemEnv: false } }, 4567)).toMatchObject({ reverted: true });
    release();
    expect(await pending).toMatchObject({ injected: false });
    expect(tracking).toBeUndefined();
    expect(values.size).toBe(0);
    expect(keychainSpy).not.toHaveBeenCalled();
  } finally { release(); globalThis.fetch = savedFetch; unlink.mockRestore(); }
});

test("launchd and shell use one Keychain presence snapshot", async () => {
  let probes = 0;
  await injectSystemEnv(4567, baseConfig, { authDetect: {
    keychainProbe: () => ++probes === 1 ? "absent" : "unknown",
  } });
  expect(probes).toBe(1);
  expect(execSpy.mock.calls.some(call => call[0] === "/bin/launchctl"
    && (call[1] as string[] | undefined)?.join(" ") === `setenv ANTHROPIC_AUTH_TOKEN ${PROXY_MARKER}`)).toBe(true);
  expect(shellEnvContents).toContain(`ANTHROPIC_AUTH_TOKEN='${PROXY_MARKER}'`);
});

test("an explicit subscription withholds the marker even under the same detection", async () => {
  await injectSystemEnv(4567, {
    ...baseConfig,
    claudeCode: { systemEnv: true, authMode: "subscription" },
  } as unknown as OcxConfig);
  expect(shellEnvContents).not.toContain(PROXY_MARKER);
});

test("an explicit proxy still writes the marker", async () => {
  await injectSystemEnv(4567, {
    ...baseConfig,
    claudeCode: { systemEnv: true, authMode: "proxy" },
  } as unknown as OcxConfig);
  expect(shellEnvContents).toContain(`ANTHROPIC_AUTH_TOKEN='${PROXY_MARKER}'`);
});

// Proxy mode owns the Claude auth slot and may use the configured admission key.
test("proxy mode writes the configured admission key instead of the marker", async () => {
  await injectSystemEnv(4567, {
    ...baseConfig,
    claudeCode: { systemEnv: true, authMode: "proxy" },
    apiKeys: [{ key: "admission-key" }],
  } as unknown as OcxConfig);
  expect(shellEnvContents).toContain("ANTHROPIC_AUTH_TOKEN='admission-key'");
  expect(shellEnvContents).not.toContain(PROXY_MARKER);
});

test("subscription mode omits the configured admission key", async () => {
  await injectSystemEnv(4567, {
    ...baseConfig,
    claudeCode: { systemEnv: true, authMode: "subscription" },
    apiKeys: [{ key: "admission-key" }],
  } as unknown as OcxConfig);
  expect(shellEnvContents).not.toContain("ANTHROPIC_AUTH_TOKEN='admission-key'");
  expect(shellEnvContents).not.toContain(PROXY_MARKER);
});

// Detection is env-aware: a proof-bound parent export means auth is present, so auto
// resolves subscription and the marker stays out of the file. An unproven Bun dotenv
// value is deliberately ignored by system-env (covered in system-env.test.ts).
test("auto with a proof-bound user API key writes no marker", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-user";
  try {
    await injectSystemEnv(4567, baseConfig, {
      preBunAnthropicSlots: ["ANTHROPIC_API_KEY"],
    });
    expect(shellEnvContents).not.toContain(PROXY_MARKER);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});
