import { memoryPickerCaStore } from "../helpers/picker-ca-store";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDesktopFirstParty } from "../../src/claude/desktop-first-party";
import { applyDesktopPickerProfile, inspectDesktopPickerProfile } from "../../src/claude/desktop-picker-profile";
import { claudeDesktopIntegrationEnabled } from "../../src/codex/desired-state";
import { ensurePickerCa, pickerCaCertPath, pickerCaFingerprints, pickerCaPendingUntrustPath, pickerStateDir, PICKER_CA_COMMON_NAME, PICKER_HOST } from "../../src/claude/intercept/picker-ca";
import { startConnectProxy } from "../../src/claude/intercept/connect-proxy";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import { readClaudeInterceptProxyToken } from "../../src/claude/intercept/proxy-auth";
import type { PickerListenerOptions } from "../../src/claude/intercept/picker-listener";
import {
  createPickerRuntime,
  pickerDesired,
  PICKER_MODELS_FILE,
  type CreatePickerRuntimeOptions,
  type PickerRuntime,
} from "../../src/claude/intercept/picker-runtime";
import type { SecurityRunner } from "../../src/claude/intercept/picker-trust";
import { getClaudePickerRuntime, startClaudeIntercept } from "../../src/claude/intercept/runtime";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
const previous: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENCODEX_HOME", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] as const;
const running: PickerRuntime[] = [];
const LISTENER_PORT = 45_678;

function config(extra: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...extra } as OcxConfig;
}
const firstParty = (extra: Partial<OcxConfig> = {}) => config({ claudeCode: { desktopMode: "first-party" }, ...extra });

/** Fake `security`: find-certificate lists the current picker CA while trusted; verify-cert follows. */
function keychain(state: { trusted: boolean }) {
  const calls: string[][] = [];
  const run: SecurityRunner = async args => {
    calls.push([...args]);
    if (args[0] === "find-certificate") {
      if (!state.trusted) return { code: 1, stdout: "", stderr: "" };
      const { sha1 } = pickerCaFingerprints(readFileSync(pickerCaCertPath(root), "utf8"));
      return { code: 0, stdout: `SHA-1 hash: ${sha1}\n`, stderr: "" };
    }
    if (args[0] === "verify-cert") return { code: state.trusted ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "trust-settings-export") writeFileSync(args[1]!, "<plist><dict></dict></plist>");
    if (args[0] === "add-trusted-cert") state.trusted = true;
    if (args[0] === "remove-trusted-cert" || args[0] === "delete-certificate") state.trusted = false;
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

function fakeListener(hold?: Promise<void>) {
  const state = { started: 0, closed: 0, models: null as PickerListenerOptions["models"] | null };
  const start = async (options: PickerListenerOptions) => {
    state.started += 1;
    state.models = options.models;
    if (hold) await hold;
    return { port: LISTENER_PORT, close: async () => { state.closed += 1; } };
  };
  return { state, start: start as unknown as NonNullable<CreatePickerRuntimeOptions["startListener"]> };
}

function runtime(overrides: Partial<CreatePickerRuntimeOptions> & { current?: () => OcxConfig } = {}): PickerRuntime {
  const { current, ...rest } = overrides;
  const created = createPickerRuntime({
    config: firstParty(),
    readConfig: current ?? (() => firstParty()),
    configDir: root,
    loadRoutes: async () => ({ nativeSlugs: [], routedModels: [{ provider: "xai", id: "grok-4.7", contextWindow: 256_000 }] }),
    platform: "darwin",
    resolveMode: fresh => fresh.claudeCode?.desktopMode ?? "gateway",
    trustTtlMs: 0,
    refreshIntervalMs: 3_600_000,
    ...rest,
  });
  running.push(created);
  return created;
}

const INTERCEPT = { kind: "intercept", port: LISTENER_PORT };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-picker-runtime-"));
  for (const key of ENV_KEYS) previous[key] = process.env[key];
  process.env.OPENCODEX_HOME = root;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "desktop-library");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
});

afterEach(async () => {
  for (const created of running.splice(0)) await created.stop();
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  removeTreeWithRetry(root);
});

describe("pickerDesired", () => {
  test("needs macOS, first-party, Desktop intent and no explicit picker off", () => {
    expect(pickerDesired(firstParty(), "first-party", "darwin")).toBe(true);
    expect(pickerDesired(firstParty(), "gateway", "darwin")).toBe(false);
    expect(pickerDesired(firstParty(), "first-party", "linux")).toBe(false);
    expect(pickerDesired(firstParty(), "first-party", "win32")).toBe(false);
    expect(pickerDesired(firstParty({ claudeCode: { desktopMode: "first-party", intercept: { picker: false } } }), "first-party", "darwin")).toBe(false);
    expect(pickerDesired(firstParty({ claudeCode: { desktopMode: "first-party", intercept: { picker: true } } }), "first-party", "darwin")).toBe(true);
  });

  test("Desktop intent follows claudeDesktopIntegrationEnabled exactly", () => {
    for (const clientIntegrations of [undefined, {}, { "claude-desktop": true }, { "claude-desktop": false }] as const) {
      const input = firstParty({ clientIntegrations: clientIntegrations as OcxConfig["clientIntegrations"] });
      expect(pickerDesired(input, "first-party", "darwin")).toBe(claudeDesktopIntegrationEnabled(input));
    }
  });
});

describe("tunnel decision", () => {
  test("the first claude.ai CONNECT after start() resolves is intercepted with no timer tick", async () => {
    const trust = keychain({ trusted: true });
    const listener = fakeListener();
    const picker = runtime({ security: trust.run, startListener: listener.start });
    await picker.start();
    expect(picker.selectTunnel("claude.ai", 443)).toEqual(INTERCEPT);
    expect(picker.selectTunnel("CLAUDE.AI", 443)).toEqual(INTERCEPT);
    expect(picker.selectTunnel("api.anthropic.com", 443)).toBeNull();
    expect(picker.selectTunnel("claude.ai", 80)).toBeNull();
    expect(picker.selectTunnel("a.claude.ai", 443)).toBeNull();
    expect(picker.status()).toMatchObject({ desired: true, trust: "trusted", listenerReady: true, effective: true, reason: "active" });
  });

  test("a claude.ai CONNECT during the first refresh waits for it and is intercepted", async () => {
    const trust = keychain({ trusted: true });
    let release!: () => void;
    const held = new Promise<"first-party">(resolve => { release = () => resolve("first-party"); });
    const picker = runtime({ security: trust.run, startListener: fakeListener().start, resolveMode: () => held });
    void picker.start();
    const pending = picker.selectTunnel("claude.ai", 443);
    expect(pending).toBeInstanceOf(Promise);
    release();
    expect(await pending).toEqual(INTERCEPT);
  });

  test("a first refresh held past the startup bound leaves that CONNECT blind", async () => {
    const trust = keychain({ trusted: true });
    const picker = runtime({ security: trust.run, startListener: fakeListener().start, resolveMode: () => new Promise(() => {}), startupWaitMs: 20 });
    void picker.start();
    expect(await picker.selectTunnel("claude.ai", 443)).toEqual({ kind: "blind" });
  });

  test("claude.ai stays blind until trusted and goes blind again when trust is lost", async () => {
    const state = { trusted: false };
    const trust = keychain(state);
    const picker = runtime({ security: trust.run, startListener: fakeListener().start });
    await picker.start();
    expect(picker.selectTunnel("claude.ai", 443)).toEqual({ kind: "blind" });
    expect(picker.status().reason).toBe("trust_untrusted");
    state.trusted = true;
    await picker.refresh();
    expect(picker.selectTunnel("claude.ai", 443)).toEqual(INTERCEPT);
    state.trusted = false;
    await picker.refresh();
    expect(picker.selectTunnel("claude.ai", 443)).toEqual({ kind: "blind" });
  });

  test("off macOS, in gateway mode or with the preference off it never intercepts or touches the keychain", async () => {
    for (const overrides of [
      { platform: "linux" as const },
      { current: () => config({ claudeCode: { desktopMode: "gateway" } }) },
      { current: () => firstParty({ claudeCode: { desktopMode: "first-party", intercept: { picker: false } } }) },
    ]) {
      const trust = keychain({ trusted: true });
      const listener = fakeListener();
      const picker = runtime({ security: trust.run, startListener: listener.start, ...overrides });
      await picker.start();
      expect(picker.selectTunnel("claude.ai", 443)).toEqual({ kind: "blind" });
      expect(trust.calls).toEqual([]);
      expect(listener.state.started).toBe(0);
    }
  });
});

describe("disarm latch and controller lock", () => {
  test("disarm goes blind at once and only the owner's rearm clears it", async () => {
    const trust = keychain({ trusted: true });
    const listener = fakeListener();
    const picker = runtime({ security: trust.run, startListener: listener.start });
    await picker.start();
    expect(picker.selectTunnel("claude.ai", 443)).toEqual(INTERCEPT);
    picker.disarm();
    expect(picker.selectTunnel("claude.ai", 443)).toEqual({ kind: "blind" });
    await picker.refresh();
    await picker.ensureStarted();
    expect(picker.selectTunnel("claude.ai", 443)).toEqual({ kind: "blind" });
    expect(picker.status()).toMatchObject({ latched: true, reason: "disarmed" });
    await Bun.sleep(0);
    expect(listener.state.closed).toBe(1);
    await picker.rearm();
    expect(picker.selectTunnel("claude.ai", 443)).toEqual(INTERCEPT);
  });

  test("refresh never arms while the controller holds its lock; rearm bypasses the check", async () => {
    const trust = keychain({ trusted: true });
    const picker = runtime({ security: trust.run, startListener: fakeListener().start, isBusy: () => true });
    await picker.start();
    expect(picker.selectTunnel("claude.ai", 443)).toEqual({ kind: "blind" });
    expect(picker.status().reason).toBe("busy");
    await picker.rearm();
    expect(picker.selectTunnel("claude.ai", 443)).toEqual(INTERCEPT);
  });

  test("a start still in flight when disarm lands never arms and its listener is closed", async () => {
    const trust = keychain({ trusted: true });
    let release!: () => void;
    const listener = fakeListener(new Promise<void>(resolve => { release = resolve; }));
    const picker = runtime({ security: trust.run, startListener: listener.start });
    const started = picker.start();
    while (listener.state.started === 0) await Bun.sleep(1);
    picker.disarm();
    release();
    await started;
    await Bun.sleep(0);
    expect(picker.selectTunnel("claude.ai", 443)).toEqual({ kind: "blind" });
    expect(picker.status().listenerReady).toBe(false);
    expect(listener.state.closed).toBe(1);
  });
});

describe("upgrade and restart", () => {
  test("a pre-field install with owned first-party env keeps picker mode on by default", async () => {
    const legacy = config();
    expect(applyDesktopFirstParty(legacy).ok).toBe(true);
    const trust = keychain({ trusted: true });
    const picker = runtime({ security: trust.run, startListener: fakeListener().start, current: () => legacy, resolveMode: undefined });
    await picker.start();
    expect(picker.status()).toMatchObject({ desired: true, effective: true });
    expect(picker.selectTunnel("claude.ai", 443)).toEqual(INTERCEPT);
  });

  test("a snapshot persisted by one run feeds the first bootstrap after a restart before discovery", async () => {
    const trust = keychain({ trusted: true });
    const first = runtime({ security: trust.run, startListener: fakeListener().start });
    await first.start();
    const persisted = join(pickerStateDir(root), PICKER_MODELS_FILE);
    for (let i = 0; i < 200 && !existsSync(persisted); i += 1) await Bun.sleep(5);
    const models = first.status().models;
    expect(models).toBeGreaterThan(0);
    await first.stop();

    const listener = fakeListener();
    const second = runtime({ security: trust.run, startListener: listener.start, loadRoutes: () => new Promise(() => {}) });
    await second.start();
    const served = listener.state.models?.() ?? [];
    expect(served.length).toBe(models);
    expect(served.some(model => model.id.startsWith("ocx-claude-xai--"))).toBe(true);
    expect(second.status().lastBootstrapAt).not.toBeNull();
  });
});

async function canBind(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function freePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    if (await canBind(port) && await canBind(port + 1)) return port;
  }
  throw new Error("no free port pair");
}

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/2.7032.0";

function connectStatusLine(port: number, host: string, userAgent?: string): Promise<string> {
  return new Promise(resolve => {
    let buffered = "";
    const socket = connect({ host: "127.0.0.1", port }, () => {
      const ua = userAgent ? `User-Agent: ${userAgent}\r\n` : "";
      const token = readClaudeInterceptProxyToken(root) ?? "";
      const auth = `Proxy-Authorization: Basic ${Buffer.from(`opencodex:${token}`).toString("base64")}\r\n`;
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${auth}${ua}\r\n`);
    });
    const done = () => { socket.destroy(); resolve(buffered.split("\r\n")[0] ?? ""); };
    socket.on("data", chunk => { buffered += chunk.toString("latin1"); if (buffered.includes("\r\n")) done(); });
    socket.on("error", done);
    setTimeout(done, 10_000);
  });
}

function blindRoundTrip(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let received = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("blind tunnel timed out")); }, 5000);
    socket.once("connect", () => socket.write("CONNECT fake.invalid:443 HTTP/1.1\r\nHost: fake.invalid:443\r\nUser-Agent: Mozilla/5.0\r\n\r\n"));
    socket.on("data", chunk => {
      received += chunk.toString();
      if (received.includes("\r\n\r\n") && !received.includes("tunnel-payload")) socket.write("tunnel-payload");
      if (received.includes("tunnel-payload")) {
        clearTimeout(timer);
        socket.destroy();
        resolve(received);
      }
    });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
}

describe("startClaudeIntercept wiring", () => {
  function interceptOptions(port: number, createPicker: Parameters<typeof startClaudeIntercept>[0]["createPicker"]) {
    return {
      config: config({ claudeCode: { intercept: { port } } }),
      publicPort: 10100,
      configDir: root,
      dispatch: async () => new Response("unused"),
      loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
      createPicker,
      pickerCaStore: memoryPickerCaStore().store, pickerPlatform: "darwin" as NodeJS.Platform,
    };
  }

  for (const failure of ["construction", "start"] as const) {
    test(`a picker ${failure} failure rejects the start and releases every port`, async () => {
      const port = await freePortPair();
      const createPicker = failure === "construction"
        ? () => { throw new Error("picker construction failed"); }
        : () => ({
          selectTunnel: () => null,
          start: async () => { throw new Error("picker start failed"); },
          stop: async () => {},
        }) as unknown as PickerRuntime;
      await expect(startClaudeIntercept(interceptOptions(port, createPicker))).rejects.toThrow(`picker ${failure} failed`);
      expect(await canBind(port)).toBe(true);
      expect(await canBind(port + 1)).toBe(true);
      expect(getClaudePickerRuntime()).toBeNull();
    });
  }

  test("a restart with an applied picker profile keeps the reused CA trusted and reselects the profile", { timeout: 30_000 }, async () => {
    const port = await freePortPair();
    const pickerPort = port + 1;
    // Before the restart: an authority was published and Desktop had the picker profile selected.
    ensurePickerCa(root);
    expect(applyDesktopPickerProfile({ configDir: root, platform: "darwin", proxyPort: pickerPort }).ok).toBe(true);
    writeFileSync(join(root, "config.json"), JSON.stringify({
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      clientIntegrations: { "claude-desktop": true },
      claudeCode: { desktopMode: "first-party", intercept: { picker: true } },
    }));
    const trust = keychain({ trusted: true });
    const listener = fakeListener();
    const handle = await startClaudeIntercept({
      config: config({ claudeCode: { intercept: { port } } }),
      publicPort: 10100,
      configDir: root,
      dispatch: async () => new Response("unused"),
      loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
      createPicker: options => createPickerRuntime({
        ...options,
        platform: "darwin",
        security: trust.run,
        resolveMode: () => "first-party",
        startListener: listener.start,
        refreshIntervalMs: 3_600_000,
      }),
      pickerSecurity: trust.run,
      pickerCaStore: memoryPickerCaStore().store, pickerPlatform: "darwin",
    });
    try {
      // The restart reuses this process's authority, so cleanup must NOT untrust it — the applied
      // row survives in place and the restore enable only rewrites the row's proxy URL. Poll until
      // that rewrite lands; the metadata's atomic write can otherwise be observed as a transient
      // absence. On Windows each lifecycle-lock acquisition is a PowerShell SID lookup, so allow
      // several seconds of slack.
      const settled = () => {
        const profile = inspectDesktopPickerProfile({ configDir: root, platform: "darwin" });
        return profile.kind === "applied" && profile.proxyUrl === `http://127.0.0.1:${pickerPort}`;
      };
      for (let i = 0; i < 1600 && !settled(); i += 1) {
        await Bun.sleep(5);
      }
      expect(inspectDesktopPickerProfile({ configDir: root, platform: "darwin" }))
        .toMatchObject({ kind: "applied", proxyUrl: `http://127.0.0.1:${pickerPort}` });
      const names = trust.calls.map(call => call[0]);
      // Same authority on disk and in the process cache: trust is retained, not removed and re-added.
      expect(names).not.toContain("remove-trusted-cert");
      expect(names).not.toContain("add-trusted-cert");
      expect(getClaudePickerRuntime()?.selectTunnel("claude.ai", 443)).toEqual(INTERCEPT);
    } finally {
      await handle?.stop();
    }
    expect(getClaudePickerRuntime()).toBeNull();
  });

  test("a restart keeps a reused authority trusted without touching the keychain", async () => {
    const port = await freePortPair();
    // Published authority is the process cache's — restarting in-process must not revoke its trust.
    ensurePickerCa(root);
    const trust = keychain({ trusted: true });
    const fake = {
      selectTunnel: () => null,
      start: async () => {},
      stop: async () => {},
    } as unknown as PickerRuntime;
    const handle = await startClaudeIntercept({
      config: config({ claudeCode: { intercept: { port } } }),
      publicPort: 10100,
      configDir: root,
      dispatch: async () => new Response("unused"),
      loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
      createPicker: () => fake,
      pickerSecurity: trust.run,
      pickerCaStore: memoryPickerCaStore().store, pickerPlatform: "darwin",
    });
    try {
      expect(handle).not.toBeNull();
      expect(getClaudePickerRuntime()).toBe(fake);
      const names = trust.calls.map(call => call[0]);
      expect(names).not.toContain("remove-trusted-cert");
      expect(names).not.toContain("delete-certificate");
    } finally {
      await handle?.stop();
    }
    expect(getClaudePickerRuntime()).toBeNull();
  });

  test("a restart with a foreign published CA untrusts the outgoing certificate and arms the picker", async () => {
    const port = await freePortPair();
    // The file on disk holds a different authority than this process will publish — e.g. written
    // by a since-exited peer — so startup must drop its keychain trust before arming.
    ensurePickerCa(root);
    const foreign = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
    writeFileSync(pickerCaCertPath(root), foreign.certPem);
    const foreignSha1 = pickerCaFingerprints(foreign.certPem).sha1;
    let trusted = true;
    let removedTargetSha1: string | null = null;
    const run: SecurityRunner = async args => {
      if (args[0] === "find-certificate") {
        return trusted ? { code: 0, stdout: `SHA-1 hash: ${foreignSha1}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "remove-trusted-cert") {
        // The file passed to the keychain must be the outgoing certificate, not the replacement
        // now occupying ca.pem.
        removedTargetSha1 = pickerCaFingerprints(readFileSync(args[1]!, "utf8")).sha1;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "delete-certificate") { trusted = false; }
      return { code: 0, stdout: "", stderr: "" };
    };
    const fake = {
      selectTunnel: () => null,
      start: async () => {},
      stop: async () => {},
    } as unknown as PickerRuntime;
    const handle = await startClaudeIntercept({
      config: config({ claudeCode: { desktopMode: "first-party", intercept: { port } } }),
      publicPort: 10100,
      configDir: root,
      dispatch: async () => new Response("unused"),
      loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
      createPicker: () => fake,
      pickerSecurity: run,
      pickerCaStore: memoryPickerCaStore().store, pickerPlatform: "darwin",
    });
    try {
      expect(handle).not.toBeNull();
      expect(removedTargetSha1).toBe(foreignSha1);
      expect(trusted).toBe(false);
      expect(pickerCaFingerprints(readFileSync(pickerCaCertPath(root), "utf8")).sha1).not.toBe(foreignSha1);
      expect(getClaudePickerRuntime()).toBe(fake);
    } finally {
      await handle?.stop();
    }
    expect(getClaudePickerRuntime()).toBeNull();
  });

  test("a malformed published certificate is unidentifiable, so startup still arms", async () => {
    const port = await freePortPair();
    // Damaged write: the file exists but is not a certificate. Nothing can be identified for
    // removal, so startup must keep the intercept pair and picker running rather than fail.
    ensurePickerCa(root);
    writeFileSync(pickerCaCertPath(root), "not a certificate\n");
    const trust = keychain({ trusted: false });
    const fake = {
      selectTunnel: () => null,
      start: async () => {},
      stop: async () => {},
    } as unknown as PickerRuntime;
    const handle = await startClaudeIntercept({
      config: config({ claudeCode: { desktopMode: "first-party", intercept: { port } } }),
      publicPort: 10100,
      configDir: root,
      dispatch: async () => new Response("unused"),
      loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
      createPicker: () => fake,
      pickerSecurity: trust.run,
      pickerCaStore: memoryPickerCaStore().store, pickerPlatform: "darwin",
    });
    try {
      expect(handle).not.toBeNull();
      expect(getClaudePickerRuntime()).toBe(fake);
      expect(await connectStatusLine(port, "api.anthropic.com")).toContain("200");
      const names = trust.calls.map(call => call[0]);
      expect(names).not.toContain("remove-trusted-cert");
      expect(names).not.toContain("delete-certificate");
    } finally {
      await handle?.stop();
    }
    expect(getClaudePickerRuntime()).toBeNull();
  });

  // INV-PICKER-01: a failed predecessor untrust keeps the applied profile's egress URL serving blind CONNECT, never picker TLS.
  test("a failed rotation untrust refuses the picker but keeps the intercept pair serving", async () => {
    const port = await freePortPair();
    const pickerPort = port + 1;
    const stateDir = pickerStateDir(root);
    // Legacy state: a published certificate and the exportable signing key it paired with.
    ensurePickerCa(root);
    const library = join(root, "desktop-library");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, "_meta.json"), JSON.stringify({
      appliedId: "previous-profile", entries: [{ id: "previous-profile", name: "Personal" }],
    }));
    writeFileSync(join(library, "previous-profile.json"), "{}\n");
    expect(applyDesktopPickerProfile({ configDir: root, platform: "darwin", proxyPort: pickerPort }).ok).toBe(true);
    const appliedBefore = inspectDesktopPickerProfile({ configDir: root, platform: "darwin" });
    if (appliedBefore.kind !== "applied") throw new Error("profile did not apply");
    const stateBefore = readFileSync(join(stateDir, "profile-state.json"), "utf8");
    const egressPort = Number(new URL(appliedBefore.proxyUrl).port);
    const upstream = createServer(socket => socket.on("data", bytes => socket.write(bytes)));
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    writeFileSync(join(stateDir, "ca.key"), "legacy-exportable-key\n");
    // A different authority than this process will publish — e.g. written by a since-exited peer —
    // must actually leave the keychain before the replacement arms.
    const foreign = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
    writeFileSync(pickerCaCertPath(root), foreign.certPem);
    const foreignSha1 = pickerCaFingerprints(foreign.certPem).sha1;
    // The keychain still trusts the foreign certificate; every removal attempt fails.
    const securityCalls: string[] = [];
    const broken: SecurityRunner = async args => {
      securityCalls.push(args[0]!);
      if (args[0] === "find-certificate") {
        return { code: 0, stdout: `SHA-1 hash: ${foreignSha1}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    let pickerCreated = false;
    const handle = await startClaudeIntercept({
      config: config({ claudeCode: { intercept: { port } } }),
      publicPort: 10100,
      configDir: root,
      dispatch: async () => new Response("unused"),
      loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
      createPicker: () => { pickerCreated = true; throw new Error("must not start"); },
      startProxy: (boundPort, options) => startConnectProxy(boundPort, {
        ...options,
        ...(boundPort === egressPort ? { dialUpstream: () => connect({ host: "127.0.0.1", port: upstreamPort }) } : {}),
      }),
      pickerSecurity: broken,
      pickerCaStore: memoryPickerCaStore().store, pickerPlatform: "darwin",
    });
    try {
      expect(handle).not.toBeNull();
      // The exportable key still cannot outlive the failed cleanup.
      expect(existsSync(join(stateDir, "ca.key"))).toBe(false);
      // Failing closed: the picker never arms while a foreign signing key stays trusted.
      expect(pickerCreated).toBe(false);
      expect(getClaudePickerRuntime()).toBeNull();
      expect(securityCalls).not.toContain("add-trusted-cert");
      expect(handle?.pickerProxyPort).toBe(egressPort);
      expect(await blindRoundTrip(egressPort)).toContain("HTTP/1.1 200 Connection Established\r\n\r\ntunnel-payload");
      expect(inspectDesktopPickerProfile({ configDir: root, platform: "darwin" })).toEqual(appliedBefore);
      expect(readFileSync(join(stateDir, "profile-state.json"), "utf8")).toBe(stateBefore);
      expect(JSON.parse(stateBefore).previousAppliedId).toBe("previous-profile");
      expect(existsSync(pickerCaPendingUntrustPath(root))).toBe(true);
      // The main intercept proxy stayed bound and still terminates api.anthropic.com CONNECTs.
      expect(await canBind(port)).toBe(false);
      expect(await connectStatusLine(port, "api.anthropic.com")).toContain("200");
    } finally {
      await handle?.stop();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
    expect(getClaudePickerRuntime()).toBeNull();
    expect(await canBind(egressPort)).toBe(true);
  });

  test("a busy applied egress port leaves the failed-cleanup profile and journal intact", async () => {
    const port = await freePortPair();
    const pickerPort = port + 1;
    ensurePickerCa(root);
    expect(applyDesktopPickerProfile({ configDir: root, platform: "darwin", proxyPort: pickerPort }).ok).toBe(true);
    const profileBefore = inspectDesktopPickerProfile({ configDir: root, platform: "darwin" });
    const stateBefore = readFileSync(join(pickerStateDir(root), "profile-state.json"), "utf8");
    const foreign = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
    writeFileSync(pickerCaCertPath(root), foreign.certPem);
    const sha1 = pickerCaFingerprints(foreign.certPem).sha1;
    const squatter = createServer(socket => socket.end("held-by-peer"));
    await new Promise<void>(resolve => squatter.listen(pickerPort, "127.0.0.1", resolve));
    let handle;
    try {
      handle = await startClaudeIntercept({
        config: config({ claudeCode: { intercept: { port } } }), publicPort: 10100, configDir: root,
        dispatch: async () => new Response("unused"),
        loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
        createPicker: () => { throw new Error("must not create picker"); },
        pickerSecurity: async args => args[0] === "find-certificate"
          ? { code: 0, stdout: `SHA-1 hash: ${sha1}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "" },
        pickerCaStore: memoryPickerCaStore().store, pickerPlatform: "darwin",
      });
      expect(handle?.pickerProxyPort).toBeNull();
      expect(handle).toMatchObject({ pickerReason: "port_in_use", pickerFailurePort: pickerPort });
      expect(getClaudePickerRuntime()).toBeNull();
      expect(squatter.listening).toBe(true);
      expect(inspectDesktopPickerProfile({ configDir: root, platform: "darwin" })).toEqual(profileBefore);
      expect(readFileSync(join(pickerStateDir(root), "profile-state.json"), "utf8")).toBe(stateBefore);
      expect(existsSync(pickerCaPendingUntrustPath(root))).toBe(true);
    } finally {
      await handle?.stop();
      await new Promise<void>(resolve => squatter.close(() => resolve()));
    }
  });

  test("a corrupt pending record keeps an applied egress blind without a keychain call", async () => {
    const port = await freePortPair();
    const pickerPort = port + 1;
    ensurePickerCa(root);
    expect(applyDesktopPickerProfile({ configDir: root, platform: "darwin", proxyPort: pickerPort }).ok).toBe(true);
    writeFileSync(pickerCaPendingUntrustPath(root), "{corrupt");
    let created = false;
    const calls: string[] = [];
    const handle = await startClaudeIntercept({
      config: config({ claudeCode: { intercept: { port } } }), publicPort: 10100, configDir: root,
      dispatch: async () => new Response("unused"),
      loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
      createPicker: () => { created = true; throw new Error("must not create picker"); },
      pickerSecurity: async args => {
        calls.push(args[0]!);
        return { code: 0, stdout: "", stderr: "" };
      },
      pickerCaStore: memoryPickerCaStore().store, pickerPlatform: "darwin",
    });
    try {
      expect(handle?.pickerProxyPort).toBe(pickerPort);
      expect(created).toBe(false);
      expect(calls).toEqual([]);
      expect(readFileSync(pickerCaPendingUntrustPath(root), "utf8")).toBe("{corrupt");
    } finally {
      await handle?.stop();
    }
  });

  test("a restart preserves the picker row identity and its recorded previous selection", { timeout: 30_000 }, async () => {
    const port = await freePortPair();
    const pickerPort = port + 1;
    const library = join(root, "desktop-library");
    // Before the restart: Desktop selected a foreign profile "Personal", then the picker was
    // applied — so profile-state.json records it as the previous selection.
    const previous = "foreign-selected";
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, `${previous}.json`), "{\"foreign\":true}\n");
    writeFileSync(join(library, "_meta.json"), JSON.stringify({
      appliedId: previous, entries: [{ id: previous, name: "Personal" }],
    }, null, 2) + "\n");
    ensurePickerCa(root);
    expect(applyDesktopPickerProfile({ configDir: root, platform: "darwin", proxyPort: pickerPort }).ok).toBe(true);
    const stateBefore = JSON.parse(readFileSync(join(root, "claude-picker", "profile-state.json"), "utf8")) as { entryId: string };
    writeFileSync(join(root, "config.json"), JSON.stringify({
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      clientIntegrations: { "claude-desktop": true },
      claudeCode: { desktopMode: "first-party", intercept: { picker: true } },
    }));
    const trust = keychain({ trusted: true });
    const listener = fakeListener();
    const handle = await startClaudeIntercept({
      config: config({ claudeCode: { intercept: { port } } }),
      publicPort: 10100,
      configDir: root,
      dispatch: async () => new Response("unused"),
      loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
      createPicker: options => createPickerRuntime({
        ...options,
        platform: "darwin",
        security: trust.run,
        resolveMode: () => "first-party",
        startListener: listener.start,
        refreshIntervalMs: 3_600_000,
      }),
      pickerSecurity: trust.run,
      pickerCaStore: memoryPickerCaStore().store, pickerPlatform: "darwin",
    });
    try {
      // The rotation must not pivot through the previous profile: no placeholder is created, the
      // row keeps its id, and the recorded previous selection still points at "Personal".
      // Same slack as the sibling restart test: on Windows each lifecycle-lock acquisition is a
      // PowerShell SID lookup, so the restore enable can take several seconds to land.
      for (let i = 0; i < 1600 && inspectDesktopPickerProfile({ configDir: root, platform: "darwin" }).kind !== "applied"; i += 1) {
        await Bun.sleep(5);
      }
      const applied = inspectDesktopPickerProfile({ configDir: root, platform: "darwin" });
      expect(applied).toMatchObject({ kind: "applied", proxyUrl: `http://127.0.0.1:${pickerPort}` });
      if (applied.kind !== "applied") throw new Error("not applied");
      expect(applied.entryId).toBe(stateBefore.entryId);
      const stateAfter = JSON.parse(readFileSync(join(root, "claude-picker", "profile-state.json"), "utf8")) as { previousAppliedId: string | null };
      expect(stateAfter.previousAppliedId).toBe(previous);
      const metadata = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as { entries: { name: string }[] };
      expect(metadata.entries.some(entry => entry.name === "opencodex-standard")).toBe(false);
    } finally {
      await handle?.stop();
    }
  });

  test("a busy picker port leaves the applied profile for the next restart to retry", { timeout: 30_000 }, async () => {
    const port = await freePortPair();
    const pickerPort = port + 1;
    // Before the restart: an authority was published and Desktop had the picker profile selected.
    ensurePickerCa(root);
    expect(applyDesktopPickerProfile({ configDir: root, platform: "darwin", proxyPort: pickerPort }).ok).toBe(true);
    writeFileSync(join(root, "config.json"), JSON.stringify({
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      clientIntegrations: { "claude-desktop": true },
      claudeCode: { desktopMode: "first-party", intercept: { picker: true } },
    }));
    const trust = keychain({ trusted: true });
    const listener = fakeListener();
    const store = memoryPickerCaStore().store;
    const startOpts = () => ({
      config: config({ claudeCode: { intercept: { port } } }),
      publicPort: 10100,
      configDir: root,
      dispatch: async () => new Response("unused"),
      loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
      createPicker: (options: CreatePickerRuntimeOptions) => createPickerRuntime({
        ...options,
        platform: "darwin" as NodeJS.Platform,
        security: trust.run,
        resolveMode: () => "first-party" as const,
        startListener: listener.start,
        refreshIntervalMs: 3_600_000,
      }),
      pickerSecurity: trust.run,
      pickerCaStore: store, pickerPlatform: "darwin" as NodeJS.Platform,
    });
    // Occupy the picker port: this restart cannot bind it.
    const squatter = createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen({ port: pickerPort, host: "127.0.0.1" }, () => resolve());
    });
    let first;
    try {
      first = await startClaudeIntercept(startOpts());
      expect(first?.pickerProxyPort).toBeNull();
      expect(first).toMatchObject({ pickerReason: "port_in_use", pickerFailurePort: pickerPort });
      // The main pair still serves, and the applied selection is durable evidence for a retry.
      expect(await connectStatusLine(port, "api.anthropic.com")).toContain("200");
      expect(inspectDesktopPickerProfile({ configDir: root, platform: "darwin" }).kind).toBe("applied");
    } finally {
      await first?.stop();
      await new Promise<void>(resolve => squatter.close(() => resolve()));
    }
    // Port free on the next restart: the surviving selection restores in place.
    const second = await startClaudeIntercept(startOpts());
    try {
      expect(second?.pickerProxyPort).toBe(pickerPort);
      for (let i = 0; i < 1600 && inspectDesktopPickerProfile({ configDir: root, platform: "darwin" }).kind !== "applied"; i += 1) {
        await Bun.sleep(5);
      }
      expect(inspectDesktopPickerProfile({ configDir: root, platform: "darwin" }))
        .toMatchObject({ kind: "applied", proxyUrl: `http://127.0.0.1:${pickerPort}` });
    } finally {
      await second?.stop();
    }
  });

  test("only the app's browser tunnels on Desktop's egress proxy consult the picker", async () => {
    const port = await freePortPair();
    const asked: string[] = [];
    const fake = {
      selectTunnel: (host: string) => { asked.push(host); return null; },
      start: async () => {},
      stop: async () => {},
    } as unknown as PickerRuntime;
    const handle = await startClaudeIntercept(interceptOptions(port, () => fake));
    try {
      expect(handle?.proxyPort).toBe(port);
      expect(handle?.pickerProxyPort).toBe(port + 1);
      expect(getClaudePickerRuntime()).toBe(fake);
      // The Claude Code proxy never consults the picker, whoever connects.
      expect(await connectStatusLine(port, "picker-probe.invalid", BROWSER_UA)).toContain("502");
      expect(asked).toEqual([]);
      // Claude Code processes Desktop spawns reach the egress proxy without a User-Agent: claude.ai
      // stays blind for them, and api.anthropic.com gets the intercept (a local listener, so 200).
      expect(await connectStatusLine(port + 1, "picker-probe.invalid")).toContain("502");
      expect(await connectStatusLine(port + 1, "api.anthropic.com")).toContain("200");
      expect(asked).toEqual([]);
      // The app's own tunnels carry its browser User-Agent and are the only ones the picker sees.
      expect(await connectStatusLine(port + 1, "picker-probe.invalid", BROWSER_UA)).toContain("502");
      expect(asked).toEqual(["picker-probe.invalid"]);
      // The User-Agent is a routing hint. A client that fakes a browser one only reaches the picker
      // decision (claude.ai relay, which needs the keychain-trusted CA); one that omits it only
      // reaches the api.anthropic.com intercept, which the Claude Code proxy already offers any
      // local process, and its api.anthropic.com tunnel is not asked of the picker.
      expect(await connectStatusLine(port + 1, "api.anthropic.com", "curl/8.7.1")).toContain("200");
      // An empty User-Agent is not a browser: blind, not asked. A faked browser one is only asked.
      expect(await connectStatusLine(port + 1, "empty-ua.invalid", "")).toContain("502");
      expect(await connectStatusLine(port + 1, "spoofed-ua.invalid", `${BROWSER_UA} spoofed`)).toContain("502");
      expect(asked).toEqual(["picker-probe.invalid", "spoofed-ua.invalid"]);
    } finally {
      await handle?.stop();
    }
    expect(getClaudePickerRuntime()).toBeNull();
    expect(await canBind(port + 1)).toBe(true);
  });
});

describe("legacy picker signing key", () => {
  // An upgrade with the picker (or the whole intercept) off must still drop the old exportable key.
  test("is removed at intercept start even when the intercept is disabled", async () => {
    const legacyKey = join(pickerStateDir(root), "ca.key");
    mkdirSync(pickerStateDir(root), { recursive: true });
    writeFileSync(legacyKey, "legacy key fixture");
    const handle = await startClaudeIntercept({
      config: config({ claudeCode: { intercept: { enabled: false } } }),
      publicPort: 10100,
      configDir: root,
      dispatch: async () => new Response("unused"),
    });
    expect(handle).toBeNull();
    expect(existsSync(legacyKey)).toBe(false);
  });
});
