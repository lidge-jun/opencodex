import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDesktopFirstParty } from "../../src/claude/desktop-first-party";
import { claudeDesktopIntegrationEnabled } from "../../src/codex/desired-state";
import { pickerCaCertPath, pickerCaFingerprints, pickerStateDir } from "../../src/claude/intercept/picker-ca";
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
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${ua}\r\n`);
    });
    const done = () => { socket.destroy(); resolve(buffered.split("\r\n")[0] ?? ""); };
    socket.on("data", chunk => { buffered += chunk.toString("latin1"); if (buffered.includes("\r\n")) done(); });
    socket.on("error", done);
    setTimeout(done, 10_000);
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
