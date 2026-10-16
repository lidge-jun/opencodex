import { describe, expect, test } from "bun:test";
import {
  assessDesktopSystemProxy,
  collectDesktopSystemProxy,
  formatDesktopSystemProxyLines,
  type DesktopSystemProxyAssessment,
  type DesktopSystemProxyDeps,
  type DesktopSystemProxyInput,
} from "../../src/claude/desktop-system-proxy";
import {
  parseWindowsAutoDetect,
  parseWindowsProxyServer,
  readWindowsProxyBypassRegistry,
  windowsProxyOverrideBypasses,
  type WindowsProxyBypassValues,
} from "../../src/lib/windows-system-proxy";
import type { OcxConfig } from "../../src/types";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectDesktopPickerProfile } from "../../src/claude/desktop-picker-profile";
import { startConnectProxy } from "../../src/claude/intercept/connect-proxy";

const CLASH = parseWindowsProxyServer("127.0.0.1:7897");
const CLASH_BYPASS = "localhost;127.*;192.168.*;10.*;<local>";
const NO_WPAD: WindowsProxyBypassValues = { proxyOverride: CLASH_BYPASS, autoConfigUrl: null, autoDetect: false };
const BYPASSED: WindowsProxyBypassValues = { ...NO_WPAD, proxyOverride: `${CLASH_BYPASS};api.anthropic.com` };

function input(overrides: Partial<DesktopSystemProxyInput> = {}): DesktopSystemProxyInput {
  return { platform: "win32", firstParty: "applied", systemProxy: CLASH, bypass: NO_WPAD, ...overrides };
}

function verdict(kind: Exclude<DesktopSystemProxyAssessment["kind"], "not-applicable">, extra: { settingsStale?: boolean; autoDetectAlsoOn?: boolean } = {}) {
  return { kind, settingsStale: false, autoDetectAlsoOn: false, ...extra };
}

describe("windowsProxyOverrideBypasses", () => {
  test("matches exact hosts, wildcards and leading-dot suffixes case-insensitively", () => {
    expect(windowsProxyOverrideBypasses(`${CLASH_BYPASS};api.anthropic.com`, "api.anthropic.com")).toBe(true);
    expect(windowsProxyOverrideBypasses("*.anthropic.com", "api.anthropic.com")).toBe(true);
    expect(windowsProxyOverrideBypasses("*anthropic*", "api.anthropic.com")).toBe(true);
    expect(windowsProxyOverrideBypasses(".anthropic.com", "api.anthropic.com")).toBe(true);
    expect(windowsProxyOverrideBypasses(" API.Anthropic.COM ", "api.anthropic.com")).toBe(true);
  });

  test("does not treat <local>, private ranges, or a lookalike as covering the API host", () => {
    expect(windowsProxyOverrideBypasses(CLASH_BYPASS, "api.anthropic.com")).toBe(false);
    expect(windowsProxyOverrideBypasses("<local>", "intranet")).toBe(true);
    expect(windowsProxyOverrideBypasses("api.anthropic.com.evil", "api.anthropic.com")).toBe(false);
    expect(windowsProxyOverrideBypasses("apixanthropic.com", "api.anthropic.com")).toBe(false);
    expect(windowsProxyOverrideBypasses(null, "api.anthropic.com")).toBe(false);
    expect(windowsProxyOverrideBypasses("", "api.anthropic.com")).toBe(false);
  });

  test("honours scheme and port qualifiers for an HTTPS host", () => {
    expect(windowsProxyOverrideBypasses("https://api.anthropic.com", "api.anthropic.com")).toBe(true);
    expect(windowsProxyOverrideBypasses("http://api.anthropic.com", "api.anthropic.com")).toBe(false);
    expect(windowsProxyOverrideBypasses("api.anthropic.com:443", "api.anthropic.com")).toBe(true);
    expect(windowsProxyOverrideBypasses("api.anthropic.com:8443", "api.anthropic.com")).toBe(false);
  });
});

describe("readWindowsProxyBypassRegistry", () => {
  const SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  // Flags byte (ninth) 0x09 = direct + auto-detect; 0x03 = direct + static proxy.
  const WPAD_ON = "4600000009000000090000000000000000000000";
  const WPAD_OFF = "4600000009000000030000000000000000000000";
  const listing = (rows: string[]) => `\r\n${SETTINGS_KEY}\r\n${rows.map(row => `    ${row}`).join("\r\n")}\r\n`;

  function lister(keys: Record<string, string | null>) {
    return (key: string) => (key in keys ? keys[key]! : null);
  }

  test("a failed key read is null, not an absent value", () => {
    expect(readWindowsProxyBypassRegistry(lister({}))).toBeNull();
  });

  test("absent values stay null, and an empty AutoConfigURL is no PAC", () => {
    const values = readWindowsProxyBypassRegistry(lister({
      [SETTINGS_KEY]: listing(["ProxyEnable    REG_DWORD    0x1", "AutoConfigURL    REG_SZ"]),
      [`${SETTINGS_KEY}\\Connections`]: listing([`DefaultConnectionSettings    REG_BINARY    ${WPAD_OFF}`]),
    }));
    expect(values).toEqual({ proxyOverride: null, autoConfigUrl: null, autoDetect: false });
  });

  test("reads the bypass list, PAC URL and WPAD flag from one listing each", () => {
    const values = readWindowsProxyBypassRegistry(lister({
      [SETTINGS_KEY]: listing([
        `ProxyOverride    REG_SZ    ${CLASH_BYPASS};api.anthropic.com`,
        "AutoConfigURL    REG_SZ    http://127.0.0.1:33331/pac",
      ]),
      [`${SETTINGS_KEY}\\Connections`]: listing([`DefaultConnectionSettings    REG_BINARY    ${WPAD_ON}`]),
    }));
    expect(values).toEqual({
      proxyOverride: `${CLASH_BYPASS};api.anthropic.com`,
      autoConfigUrl: "http://127.0.0.1:33331/pac",
      autoDetect: true,
    });
  });

  test("an unreadable Connections key leaves auto-detect unknown", () => {
    const values = readWindowsProxyBypassRegistry(lister({ [SETTINGS_KEY]: listing([]) }));
    expect(values).toEqual({ proxyOverride: null, autoConfigUrl: null, autoDetect: null });
  });

  test("parseWindowsAutoDetect reads the 0x08 flag and never guesses false", () => {
    expect(parseWindowsAutoDetect(WPAD_ON)).toBe(true);
    expect(parseWindowsAutoDetect(WPAD_OFF)).toBe(false);
    expect(parseWindowsAutoDetect(null)).toBeNull();
    expect(parseWindowsAutoDetect("4600")).toBeNull();
    expect(parseWindowsAutoDetect("not-hex-at-all-xyz")).toBeNull();
  });
});

describe("assessDesktopSystemProxy", () => {
  test("flags a system proxy that covers the API host, without printing the proxy value", () => {
    expect(assessDesktopSystemProxy(input())).toEqual(verdict("conflict"));
    const credentialed = parseWindowsProxyServer("user:secret@proxy.example.test:8080");
    const result = assessDesktopSystemProxy(input({ systemProxy: credentialed }));
    expect(result).toEqual(verdict("conflict"));
    const text = formatDesktopSystemProxyLines(result).join("\n");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("proxy.example.test");
  });

  test("is clear once the API host is on the bypass list", () => {
    expect(assessDesktopSystemProxy(input({ bypass: BYPASSED }))).toEqual(verdict("bypassed"));
  });

  test("is clear when no system proxy can reach an https:// API host and WPAD is off", () => {
    expect(assessDesktopSystemProxy(input({ systemProxy: { kind: "disabled" } }))).toEqual(verdict("no-proxy"));
    expect(assessDesktopSystemProxy(input({ systemProxy: parseWindowsProxyServer("socks=127.0.0.1:1080") })))
      .toEqual(verdict("no-proxy"));
    expect(assessDesktopSystemProxy(input({ systemProxy: parseWindowsProxyServer("http=127.0.0.1:8080") })))
      .toEqual(verdict("no-proxy"));
    expect(assessDesktopSystemProxy(input({ systemProxy: parseWindowsProxyServer("https=127.0.0.1:8080") })).kind)
      .toBe("conflict");
  });

  test("WPAD on (or unknown) without a static proxy is undecidable, not ok", () => {
    for (const autoDetect of [true, null]) {
      const result = assessDesktopSystemProxy(input({ systemProxy: { kind: "disabled" }, bypass: { ...NO_WPAD, autoDetect } }));
      expect(result).toEqual(verdict("auto-detect"));
      const lines = formatDesktopSystemProxyLines(result);
      expect(lines[0]).toStartWith("  --");
      expect(lines.join("\n")).not.toContain("  ok");
    }
  });

  test("WPAD next to a bypassed static proxy qualifies the ok; a static conflict stands", () => {
    const bypassed = assessDesktopSystemProxy(input({ bypass: { ...BYPASSED, autoDetect: true } }));
    expect(bypassed).toEqual(verdict("bypassed", { autoDetectAlsoOn: true }));
    expect(formatDesktopSystemProxyLines(bypassed).join("\n")).toContain("WPAD");
    expect(assessDesktopSystemProxy(input({ bypass: { ...NO_WPAD, autoDetect: true } }))).toEqual(verdict("conflict"));
  });

  test("reports a PAC script as unknown instead of guessing", () => {
    const bypass = { ...NO_WPAD, proxyOverride: null, autoConfigUrl: "http://127.0.0.1:33331/pac" };
    expect(assessDesktopSystemProxy(input({ bypass }))).toEqual(verdict("pac"));
    expect(assessDesktopSystemProxy(input({ bypass, systemProxy: { kind: "disabled" } }))).toEqual(verdict("pac"));
  });

  test("stays silent off Windows or without a Desktop first-party env", () => {
    expect(assessDesktopSystemProxy(input({ platform: "darwin" }))).toEqual({ kind: "not-applicable" });
    expect(assessDesktopSystemProxy(input({ firstParty: "off" }))).toEqual({ kind: "not-applicable" });
    expect(formatDesktopSystemProxyLines({ kind: "not-applicable" })).toEqual([]);
  });

  test("a failed registry read is reported as unreadable, not as no proxy or a conflict", () => {
    expect(assessDesktopSystemProxy(input({ systemProxy: { kind: "unreadable" } }))).toEqual(verdict("unreadable"));
    expect(assessDesktopSystemProxy(input({ bypass: null }))).toEqual(verdict("unreadable"));
    expect(assessDesktopSystemProxy(input({ systemProxy: { kind: "disabled" }, bypass: null }))).toEqual(verdict("unreadable"));
  });
});

describe("formatDesktopSystemProxyLines", () => {
  test("a conflict names the fix and the restart", () => {
    const text = formatDesktopSystemProxyLines(verdict("conflict")).join("\n");
    expect(text).toContain("!!");
    expect(text).toContain("api.anthropic.com");
    expect(text).toContain("bypass list");
    expect(text).toContain("reopen Claude Desktop");
  });

  test("clear states print a single ok line", () => {
    for (const kind of ["no-proxy", "bypassed"] as const) {
      const lines = formatDesktopSystemProxyLines(verdict(kind));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith("  ok");
    }
  });
});

describe("collectDesktopSystemProxy", () => {
  const config = { port: 10100, clientIntegrations: { "claude-desktop": true },
    claudeCode: { desktopMode: "first-party" } } as Pick<OcxConfig, "claudeCode" | "clientIntegrations" | "port" | "runtimeRole">;
  const untouchable = () => { throw new Error("registry read off the applicable path"); };

  test("a selected Windows picker profile with a blind relay bypasses the system proxy without in-process runtime state", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-doctor-picker-"));
    const library = join(root, "configLibrary");
    const options = { platform: "win32" as const, env: { OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: library }, homeDir: root };
    const relay = await startConnectProxy(0, {
      interceptPort: 1, interceptHosts: [], selectTunnel: () => ({ kind: "blind" }),
      dialUpstream: () => { throw new Error("doctor must not dial an upstream"); },
    });
    try {
      mkdirSync(library, { recursive: true });
      writeFileSync(join(library, "_meta.json"), JSON.stringify({
        appliedId: "picker", entries: [{ id: "picker", name: "opencodex-picker" }],
      }));
      writeFileSync(join(library, "picker.json"), JSON.stringify({ egressProxyUrl: `http://127.0.0.1:${relay.port}` }));
      const result = await collectDesktopSystemProxy(config, {
        platform: "win32", firstPartyState: () => "applied",
        inspectPickerProfile: () => inspectDesktopPickerProfile(options),
        readSystemProxy: () => CLASH, readBypass: () => NO_WPAD,
      });
      expect(result).toEqual({ kind: "not-applicable" });
      expect(formatDesktopSystemProxyLines(result)).toEqual([]);
      await relay.close();
      expect(await collectDesktopSystemProxy(config, {
        platform: "win32", firstPartyState: () => "applied",
        inspectPickerProfile: () => inspectDesktopPickerProfile(options),
        readSystemProxy: () => CLASH, readBypass: () => NO_WPAD,
      })).toEqual(verdict("conflict"));
    } finally {
      await relay.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never touches the registry off Windows", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(await collectDesktopSystemProxy(config, { platform, readSystemProxy: untouchable, readBypass: untouchable,
        inspectPickerProfile: untouchable, pickerRelayAvailable: untouchable }))
        .toEqual({ kind: "not-applicable" });
    }
  });

  test("never touches the registry on Windows without a Desktop first-party env", async () => {
    const deps: DesktopSystemProxyDeps = { platform: "win32", firstPartyState: () => "off", readSystemProxy: untouchable, readBypass: untouchable,
      inspectPickerProfile: untouchable, pickerRelayAvailable: untouchable };
    expect(await collectDesktopSystemProxy(config, deps)).toEqual({ kind: "not-applicable" });
  });

  test("a stale first-party env on Windows never prints ok", async () => {
    const stale = (systemProxy: DesktopSystemProxyInput["systemProxy"], bypass: WindowsProxyBypassValues): DesktopSystemProxyDeps =>
      ({ platform: "win32", firstPartyState: () => "stale", readSystemProxy: () => systemProxy, readBypass: () => bypass,
        inspectPickerProfile: untouchable, pickerRelayAvailable: untouchable });

    for (const [systemProxy, bypass, kind] of [
      [{ kind: "disabled" }, NO_WPAD, "no-proxy"],
      [CLASH, BYPASSED, "bypassed"],
    ] as const) {
      const result = await collectDesktopSystemProxy(config, stale(systemProxy, bypass));
      expect(result).toEqual(verdict(kind, { settingsStale: true }));
      const lines = formatDesktopSystemProxyLines(result);
      expect(lines.join("\n")).not.toContain("  ok");
      expect(lines[0]).toStartWith("  --");
      expect(lines.join("\n")).toContain("ocx ensure");
    }

    const conflict = await collectDesktopSystemProxy(config, stale(CLASH, NO_WPAD));
    expect(conflict).toEqual(verdict("conflict", { settingsStale: true }));
    const text = formatDesktopSystemProxyLines(conflict).join("\n");
    expect(text).toContain("!!");
    expect(text).toContain("ocx ensure");
  });

  test("an applied env on Windows reads both registry surfaces", async () => {
    const deps: DesktopSystemProxyDeps = { platform: "win32", firstPartyState: () => "applied", readSystemProxy: () => CLASH, readBypass: () => BYPASSED,
      inspectPickerProfile: () => ({ kind: "absent" }) };
    expect(await collectDesktopSystemProxy(config, deps)).toEqual(verdict("bypassed"));
  });

  test("registry diagnostics remain for absent, unselected, unsafe or unavailable picker profiles", async () => {
    let registryReads = 0;
    const deps: DesktopSystemProxyDeps = {
      platform: "win32", firstPartyState: () => "applied",
      readSystemProxy: () => { registryReads++; return CLASH; },
      readBypass: () => { registryReads++; return NO_WPAD; },
      pickerRelayAvailable: untouchable,
    };
    for (const kind of ["absent", "not_selected", "unsafe"] as const) {
      const inspectPickerProfile: NonNullable<DesktopSystemProxyDeps["inspectPickerProfile"]> = () => kind === "absent"
        ? { kind } : kind === "not_selected" ? { kind, entryId: "picker" } : { kind, reason: "profile_missing" };
      expect(await collectDesktopSystemProxy(config, { ...deps, inspectPickerProfile })).toEqual(verdict("conflict"));
    }
    const inspectPickerProfile: NonNullable<DesktopSystemProxyDeps["inspectPickerProfile"]> = () =>
      ({ kind: "applied", entryId: "picker", proxyUrl: "http://127.0.0.1:10201" });
    for (const pickerRelayAvailable of [() => false, async () => { throw new Error("relay unavailable"); }]) {
      expect(await collectDesktopSystemProxy(config, { ...deps, inspectPickerProfile, pickerRelayAvailable })).toEqual(verdict("conflict"));
    }
    expect(await collectDesktopSystemProxy(config, { ...deps, inspectPickerProfile: untouchable })).toEqual(verdict("conflict"));
    expect(registryReads).toBe(12);
  });

  test("picker off does not hide registry diagnostics behind a leftover selected profile", async () => {
    expect(await collectDesktopSystemProxy({ ...config, claudeCode: { ...config.claudeCode, intercept: { picker: false } } }, {
      platform: "win32", firstPartyState: () => "applied",
      inspectPickerProfile: untouchable, pickerRelayAvailable: untouchable,
      readSystemProxy: () => CLASH, readBypass: () => NO_WPAD,
    })).toEqual(verdict("conflict"));
  });

  test("available picker relay skips both registry reads without checking picker trust or effectiveness", async () => {
    const urls: string[] = [];
    expect(await collectDesktopSystemProxy(config, {
      platform: "win32", firstPartyState: () => "applied",
      inspectPickerProfile: () => ({ kind: "applied", entryId: "picker", proxyUrl: "http://127.0.0.1:10201" }),
      pickerRelayAvailable: async url => { urls.push(url); return true; },
      readSystemProxy: untouchable, readBypass: untouchable,
    })).toEqual({ kind: "not-applicable" });
    expect(urls).toEqual(["http://127.0.0.1:10201"]);
  });

  test("a foreign HTTP listener or credential-bearing intercept proxy is not a Desktop picker relay", async () => {
    const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Only CONNECT", {
      status: 405, headers: { Allow: "CONNECT" },
    }) });
    const intercept = await startConnectProxy(0, { interceptPort: 1, authToken: "synthetic-test-token",
      dialUpstream: () => { throw new Error("doctor must not dial an upstream"); } });
    try {
      for (const port of [foreign.port, intercept.port]) {
        expect(await collectDesktopSystemProxy(config, {
          platform: "win32", firstPartyState: () => "applied",
          inspectPickerProfile: () => ({ kind: "applied", entryId: "picker", proxyUrl: `http://127.0.0.1:${port}` }),
          readSystemProxy: () => CLASH, readBypass: () => NO_WPAD,
        })).toEqual(verdict("conflict"));
      }
    } finally {
      foreign.stop(true);
      await intercept.close();
    }
  });
});
