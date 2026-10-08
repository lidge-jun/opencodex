import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import * as pickerPreparation from "../../src/claude/intercept/picker-ca-startup";
import { startClaudeIntercept, getClaudePickerController, getClaudePickerRuntime } from "../../src/claude/intercept/runtime";
import { createPickerRuntime } from "../../src/claude/intercept/picker-runtime";
import { startConnectProxy } from "../../src/claude/intercept/connect-proxy";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import { PICKER_CA_COMMON_NAME, PICKER_HOST } from "../../src/claude/intercept/picker-ca";
import { pickerCaCertPath, pickerCaFingerprints } from "../../src/claude/intercept/picker-ca";
import { watchdogMs } from "../helpers/ci-watchdog";
import { memoryPickerCaStore } from "../helpers/picker-ca-store";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningAndReaps, hardenConfigDir } from "../../src/config/paths";
import { resetHardenedStateForTests, setAsyncIcaclsRunnerForTests, setPlatformForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const roots: string[] = [];
const handles: Array<Awaited<ReturnType<typeof startClaudeIntercept>>> = [];
const priorHome = process.env.OPENCODEX_HOME;
const priorDesktop = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
// loadConfig() can start an optional Windows ACL hardening flight (icacls) on the config root
// that intercept stop() does not drain; it is a possible owner of the handle behind the EBUSY a
// Windows shard hit while removing the root (run 37735258668). Drain every root's hardening and
// reaps, then remove with the shared release-race retry. Every stop and every root is attempted
// even when an earlier one fails, the environment is always restored, and failures are rethrown.
async function cleanupPickerStartup(remove: (dir: string) => void = removeTreeWithRetry): Promise<void> {
  const failures: unknown[] = [];
  for (const handle of handles.splice(0)) {
    try { await handle?.stop(); } catch (error) { failures.push(error); }
  }
  for (const dir of roots.splice(0)) {
    try {
      await flushConfigDirHardeningAndReaps(dir);
      remove(dir);
    } catch (error) { failures.push(error); }
  }
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = priorHome;
  if (priorDesktop === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR; else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = priorDesktop;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "picker-startup cleanup failed");
}
afterEach(() => cleanupPickerStartup());
const routes = async () => ({ nativeSlugs: [], routedModels: [] });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "ocx-picker-startup-")); roots.push(root);
  process.env.OPENCODEX_HOME = root;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "desktop");
  const config = { port: 10100, providers: {}, defaultProvider: "openai",
    claudeCode: { desktopMode: "gateway", intercept: { port: 10200 } } } as OcxConfig;
  return { root, config };
}

// Each restart child cold-imports the intercept runtime and the first one mints the picker
// CA. A neighbouring case takes 8.5 s on a Windows shard, and the first child here passed a
// flat 10 s bound in three dev/PR runs (37360604391, 37443819560, 37449564955). spawnSync
// blocks the loop, so each multi-child test's own bound covers all of its children.
const PICKER_CHILD_TIMEOUT_MS = watchdogMs(10_000);

test("fixture cleanup waits for pending Windows config-directory hardening", async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const { root } = setup();
  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setAsyncIcaclsRunnerForTests(async () => {
    started();
    await blocked;
    return { success: true, exitCode: 0, timedOut: false, stdout: "" };
  });
  let cleanup: Promise<void> | undefined;
  try {
    hardenConfigDir();
    await entered;
    cleanup = cleanupPickerStartup();
    await Promise.resolve();
    expect(existsSync(root)).toBe(true);
    release();
    await cleanup;
    expect(existsSync(root)).toBe(false);
    expect(process.env.OPENCODEX_HOME).toBe(priorHome);
  } finally {
    release();
    try {
      await flushConfigDirHardeningAndReaps(root);
      await cleanup;
    } finally {
      setAsyncIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
    }
  }
});

test("fixture cleanup stops every handle and removes every root when a stop throws", async () => {
  const first = setup().root, second = setup().root;
  let laterStops = 0;
  type Handle = Awaited<ReturnType<typeof startClaudeIntercept>>;
  handles.push({ stop: async () => { throw new Error("stop failed"); } } as unknown as Handle);
  handles.push({ stop: async () => { laterStops++; } } as unknown as Handle);
  await expect(cleanupPickerStartup()).rejects.toThrow("stop failed");
  expect(laterStops).toBe(1);
  expect([existsSync(first), existsSync(second)]).toEqual([false, false]);
  expect(process.env.OPENCODEX_HOME).toBe(priorHome);
  expect(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR).toBe(priorDesktop);
});

test("fixture cleanup restores env and attempts later roots when a removal throws", async () => {
  const first = setup().root, second = setup().root;
  const attempted: string[] = [];
  await expect(cleanupPickerStartup(dir => {
    attempted.push(dir);
    if (dir === first) throw new Error("EBUSY: resource busy or locked");
    removeTreeWithRetry(dir);
  })).rejects.toThrow("EBUSY");
  expect(attempted).toEqual([first, second]);
  expect(existsSync(second)).toBe(false);
  expect(process.env.OPENCODEX_HOME).toBe(priorHome);
  expect(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR).toBe(priorDesktop);
  removeTreeWithRetry(first);
});

test("Windows and Linux skip all picker effects while still discarding legacy key", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const { root, config } = setup();
    config.claudeCode!.desktopMode = "first-party";
    mkdirSync(join(root, "claude-picker"));
    writeFileSync(join(root, "claude-picker", "ca.key"), "legacy-test-key");
    let creates = 0, binds = 0, storeCalls = 0;
    const handle = await startClaudeIntercept({ config, configDir: root, publicPort: 10100,
      dispatch: async () => new Response(), loadPickerRoutes: routes, pickerPlatform: platform,
      pickerCaStore: () => { storeCalls++; throw new Error("must not access credentials"); },
      createPicker: () => { creates++; throw new Error("must not create picker"); },
      pickerSecurity: async () => { throw new Error("must not inspect trust"); },
      startProxy: async (_port, options) => { binds++; return startConnectProxy(0, options); },
    });
    handles.push(handle);
    expect({ creates, binds, storeCalls }).toEqual({ creates: 0, binds: 1, storeCalls: 0 });
    expect(existsSync(join(root, "claude-picker", "ca.key"))).toBe(false);
    expect(existsSync(pickerCaCertPath(root))).toBe(false);
    expect(handle?.pickerProxyPort).toBeNull();
  }
});

test("gateway startup retains controller but defers credentials until explicit first-party enable", async () => {
  const { root, config } = setup();
  const fake = memoryPickerCaStore();
  let storeCalls = 0;
  saveConfig(config);
  const handle = await startClaudeIntercept({ config, configDir: root, publicPort: 10100,
    dispatch: async () => new Response(), loadPickerRoutes: routes, pickerPlatform: "darwin",
    pickerCaStore: (service, account) => { storeCalls++; return fake.store(service, account); },
    createPicker: options => createPickerRuntime({ ...options, readConfig: () => config, resolveMode: c => c.claudeCode!.desktopMode! as "gateway" | "first-party" }),
    pickerSecurity: async args => {
      if (args[0] === "find-certificate") return { code: 0, stdout: `SHA-1 hash: ${pickerCaFingerprints(readFileSync(pickerCaCertPath(root), "utf8")).sha1}`, stderr: "" };
      if (args[0] === "trust-settings-export") writeFileSync(args[1]!, "<plist><dict></dict></plist>");
      return { code: 0, stdout: "", stderr: "" };
    },
    startProxy: async (_port, options) => startConnectProxy(0, options),
  });
  handles.push(handle);
  expect(storeCalls).toBe(0);
  expect(existsSync(pickerCaCertPath(root))).toBe(false);
  const controller = getClaudePickerController();
  expect(controller).not.toBeNull();
  const runtime = getClaudePickerRuntime()!;
  await controller!.status();
  await runtime.refresh();
  await runtime.refreshTrust();
  await controller!.disable({ persist: false });
  expect(storeCalls).toBe(0);
  expect(existsSync(pickerCaCertPath(root))).toBe(false);
  config.claudeCode!.desktopMode = "first-party"; saveConfig(config);
  await controller!.enable({ persist: false, context: "server" });
  expect(storeCalls).toBeGreaterThan(0);
  expect(fake.writes).toBe(1);
  expect(existsSync(join(root, "claude-picker", "authority.json"))).toBe(true);
});

test("fresh production restarts retain fingerprint and issue no trust mutations, including lost trust", () => {
  const { root } = setup();
  const runtimeUrl = pathToFileURL(join(import.meta.dir, "../../src/claude/intercept/runtime.ts")).href;
  const pickerUrl = pathToFileURL(join(import.meta.dir, "../../src/claude/intercept/picker-runtime.ts")).href;
  const caUrl = pathToFileURL(join(import.meta.dir, "../../src/claude/intercept/picker-ca.ts")).href;
  const profileUrl = pathToFileURL(join(import.meta.dir, "../../src/claude/desktop-picker-profile.ts")).href;
  const helperUrl = pathToFileURL(join(import.meta.dir, "../helpers/picker-ca-store.ts")).href;
  const run = (trusted: boolean) => {
    const child = Bun.spawnSync({ cmd: [process.execPath, "-e", `
      import { readFileSync, writeFileSync } from "node:fs";
      import { startClaudeIntercept, getClaudePickerController } from ${JSON.stringify(runtimeUrl)};
      import { createPickerRuntime } from ${JSON.stringify(pickerUrl)};
      import { pickerCaFingerprints, pickerCaCertPath } from ${JSON.stringify(caUrl)};
      import { applyDesktopPickerProfile } from ${JSON.stringify(profileUrl)};
      import { filePickerCaStore } from ${JSON.stringify(helperUrl)};
      const root = ${JSON.stringify(root)};
      const config = { port: 10100, defaultProvider: "openai", providers: {},
        claudeCode: { desktopMode: "first-party", intercept: { port: 10200 } } };
      writeFileSync(root + "/config.json", JSON.stringify(config));
      applyDesktopPickerProfile({ configDir: root, platform: "darwin", proxyPort: 10201 });
      const mutations = [];
      const security = async args => {
        if (["add-trusted-cert", "remove-trusted-cert", "delete-certificate"].includes(args[0])) mutations.push(args[0]);
        if (args[0] === "find-certificate") return { code: ${trusted ? 0 : 1}, stdout: ${trusted}
          ? "SHA-1 hash: " + pickerCaFingerprints(readFileSync(pickerCaCertPath(root), "utf8")).sha1 : "", stderr: "" };
        if (args[0] === "trust-settings-export") writeFileSync(args[1], "<plist><dict></dict></plist>");
        return { code: ${trusted ? 0 : 1}, stdout: "", stderr: "" };
      };
      const handle = await startClaudeIntercept({ config, configDir: root, publicPort: 10100,
        dispatch: async () => new Response(), loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
        pickerPlatform: "darwin", pickerSecurity: security,
        pickerCaStore: filePickerCaStore(root + "/test-only-store"),
        startProxy: async port => ({ port, close: async () => {} }),
        createPicker: options => createPickerRuntime({ ...options, readConfig: () => config, resolveMode: () => "first-party",
          startListener: async () => ({ port: 10444, close: async () => {} }) }),
      });
      const controller = getClaudePickerController();
      await controller.transition(async () => {});
      const status = await controller.status();
      const fingerprint = pickerCaFingerprints(readFileSync(pickerCaCertPath(root), "utf8")).sha256;
      await handle.stop();
      process.stdout.write(JSON.stringify({ fingerprint, mutations, effective: status.effective, reason: status.reason }));
    `], env: { ...process.env, HOME: root, OPENCODEX_HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude"),
      OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(root, "desktop") }, stdout: "pipe", stderr: "pipe", timeout: PICKER_CHILD_TIMEOUT_MS });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return JSON.parse(child.stdout.toString()) as { fingerprint: string; mutations: string[]; effective: boolean; reason: string };
  };
  const first = run(true), second = run(true), lost = run(false);
  expect(first.effective).toBe(true);
  expect(second).toEqual(first);
  expect(lost).toMatchObject({ fingerprint: first.fingerprint, mutations: [], effective: false, reason: "trust_pending" });
  expect(first.mutations).toEqual([]);
}, PICKER_CHILD_TIMEOUT_MS * 3 + 5_000);

test("late first-party enable migrates a dead ephemeral predecessor before persistent activation", () => {
  const { root } = setup();
  const caUrl = pathToFileURL(join(import.meta.dir, "../../src/claude/intercept/picker-ca.ts")).href;
  const controllerUrl = pathToFileURL(join(import.meta.dir, "../../src/claude/desktop-picker.ts")).href;
  const helperUrl = pathToFileURL(join(import.meta.dir, "../helpers/picker-ca-store.ts")).href;
  const prior = Bun.spawnSync({ cmd: [process.execPath, "-e", `
    import { ensurePickerCa } from ${JSON.stringify(caUrl)};
    process.stdout.write(ensurePickerCa(${JSON.stringify(root)}).fingerprint);
  `], stdout: "pipe", stderr: "pipe", timeout: PICKER_CHILD_TIMEOUT_MS });
  expect(prior.exitCode, prior.stderr.toString()).toBe(0);
  const child = Bun.spawnSync({ cmd: [process.execPath, "-e", `
    import { readFileSync } from "node:fs";
    import { createDesktopPickerController } from ${JSON.stringify(controllerUrl)};
    import { pickerCaCertPath, pickerCaFingerprints, readPendingPickerCaUntrust } from ${JSON.stringify(caUrl)};
    import { memoryPickerCaStore } from ${JSON.stringify(helperUrl)};
    const root = ${JSON.stringify(root)};
    const oldSha = pickerCaFingerprints(readFileSync(pickerCaCertPath(root), "utf8")).sha1;
    let oldListed = true;
    const removed = [];
    const config = { port: 10100, providers: {}, claudeCode: { desktopMode: "first-party" } };
    const fake = memoryPickerCaStore();
    const controller = createDesktopPickerController({ configDir: root, platform: "darwin", persistentAuthority: { store: fake.store },
      readConfig: () => config, persistPreference: () => true, proxyPort: () => 10201,
      inspectProfile: () => ({ kind: "absent" }), applyProfile: () => ({ ok: true, changed: false, path: "fixture" }),
      runtime: { status: () => ({ desired: true, supported: true, trust: "untrusted", effective: false, models: 0 }), rearm: async () => {} },
      security: async args => {
        if (args[0] === "find-certificate") return { code: oldListed ? 0 : 1, stdout: oldListed ? "SHA-1 hash: " + oldSha : "", stderr: "" };
        if (args[0] === "remove-trusted-cert") removed.push(pickerCaFingerprints(readFileSync(args[1], "utf8")).sha1);
        if (args[0] === "delete-certificate") oldListed = false;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    // Trust remains pending in this test; migration itself must still finish before enable inspects it.
    await controller.enable({ persist: false, context: "server", allowTrustPrompt: false });
    process.stdout.write(JSON.stringify({ removed, oldSha, writes: fake.writes, pending: readPendingPickerCaUntrust(root),
      fingerprint: pickerCaFingerprints(readFileSync(pickerCaCertPath(root), "utf8")).sha256 }));
  `], stdout: "pipe", stderr: "pipe", timeout: PICKER_CHILD_TIMEOUT_MS });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.removed).toEqual([result.oldSha]);
  expect(result.writes).toBe(1);
  expect(result.pending).toBeNull();
  expect(result.fingerprint).not.toBe(prior.stdout.toString());
}, PICKER_CHILD_TIMEOUT_MS * 2 + 5_000);

test("default, off, and disabled integration remain credential-free through status, refresh, and off", async () => {
  for (const claudeCode of [undefined, { desktopMode: "first-party", intercept: { picker: false } }, { desktopMode: "first-party" }]) {
    const { root, config } = setup();
    config.claudeCode = claudeCode as OcxConfig["claudeCode"];
    if (claudeCode?.desktopMode === "first-party" && !claudeCode.intercept) config.clientIntegrations = { "claude-desktop": false };
    saveConfig(config);
    let calls = 0;
    const handle = await startClaudeIntercept({ config, configDir: root, publicPort: 10100,
      dispatch: async () => new Response(), loadPickerRoutes: routes, pickerPlatform: "darwin",
      pickerCaStore: () => { calls++; throw new Error("dormant credential access"); },
      createPicker: options => createPickerRuntime({ ...options, readConfig: () => config,
        resolveMode: () => config.claudeCode?.desktopMode === "first-party" ? "first-party" : "gateway" }),
      pickerSecurity: async () => { throw new Error("dormant trust access"); },
      startProxy: async (_port, options) => startConnectProxy(0, options),
    });
    handles.push(handle);
    await getClaudePickerController()!.status();
    await getClaudePickerRuntime()!.refresh();
    await getClaudePickerRuntime()!.refreshTrust();
    await getClaudePickerController()!.disable({ persist: false });
    expect(calls).toBe(0);
    expect(existsSync(pickerCaCertPath(root))).toBe(false);
  }
});

test("disarm during async predecessor cleanup prevents a later TLS listener from opening", async () => {
  const { root, config } = setup();
  config.claudeCode!.desktopMode = "first-party";
  const predecessor = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
  mkdirSync(join(root, "claude-picker")); writeFileSync(pickerCaCertPath(root), predecessor.certPem);
  const oldSha = pickerCaFingerprints(predecessor.certPem).sha1;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const deleting = new Promise<void>(resolve => { entered = resolve; });
  let oldListed = true, listeners = 0;
  const runtime = createPickerRuntime({ config, configDir: root, loadRoutes: routes, readConfig: () => config,
    resolveMode: () => "first-party", platform: "darwin", persistentAuthority: { store: memoryPickerCaStore().store },
    startListener: async () => { listeners++; return { port: 10444, close: async () => {} }; },
    security: async args => {
      if (args[0] === "find-certificate") return { code: oldListed ? 0 : 1, stdout: oldListed ? `SHA-1 hash: ${oldSha}` : "", stderr: "" };
      if (args[0] === "remove-trusted-cert") { entered(); await gate; }
      if (args[0] === "delete-certificate") oldListed = false;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  try {
    const starting = runtime.start();
    await deleting;
    runtime.disarm();
    release();
    await starting;
    expect(listeners).toBe(0);
    expect(runtime.selectTunnel("claude.ai", 443)).toEqual({ kind: "blind" });
  } finally { release(); await runtime.stop(); }
});

test("startup preparation diagnostics distinguish cleanup and sanitize authority failures", async () => {
  for (const [message, expected] of [
    ["picker_ca_pending_untrust", "⚠ Claude Desktop picker disabled: the previous certificate could not be untrusted"],
    ["picker_ca_store_unavailable", "⚠ Claude Desktop picker disabled: picker authority unavailable (picker_ca_store_unavailable)"],
    ["picker_ca_metadata_mismatch", "⚠ Claude Desktop picker disabled: picker authority unavailable (picker_ca_metadata_mismatch)"],
    ["picker_ca_native_error PRIVATE-KEY-DIAGNOSTIC", "⚠ Claude Desktop picker disabled: picker authority unavailable"],
  ]) {
    const { root, config } = setup(); config.claudeCode!.desktopMode = "first-party";
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation(line => { warnings.push(String(line)); });
    const prepare = spyOn(pickerPreparation, "preparePersistentPickerAuthority").mockRejectedValue(new Error(message));
    try {
      const handle = await startClaudeIntercept({ config, configDir: root, publicPort: 10100,
        dispatch: async () => new Response(), loadPickerRoutes: routes, pickerPlatform: "darwin",
        pickerCaStore: () => { throw new Error("must not touch credential store"); },
        pickerSecurity: async () => { throw new Error("must not touch OS trust"); },
        startProxy: async (_port, options) => startConnectProxy(0, options),
      });
      handles.push(handle);
      expect(warnings.filter(line => line.includes("Claude Desktop picker"))).toEqual([expected]);
      expect(warnings.join(" ")).not.toContain("PRIVATE-KEY-DIAGNOSTIC");
      expect(handle?.pickerReason).toBe("failed");
    } finally { prepare.mockRestore(); warn.mockRestore(); }
  }
});
