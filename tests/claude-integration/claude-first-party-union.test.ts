import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDesktopFirstParty, observeClaudeDesktopMode, removeDesktopFirstParty, resolveClaudeDesktopMode } from "../../src/claude/desktop-first-party";
import { firstPartyDesired, firstPartyProxyStatus, readFirstPartyProxyStatus, reconcileClaudeFirstPartySettings, type FirstPartyProxyStatus } from "../../src/claude/first-party-settings";
import { claudeInterceptCaCertPath } from "../../src/claude/intercept/local-ca";
import { claudeInterceptProxyTokenPath } from "../../src/claude/intercept/proxy-auth";
import type { ClaudeInterceptSettingsState } from "../../src/claude/intercept/settings";
import { configSchema } from "../../src/config/schema/config-schema";
import { normalizePersistedClaudeCode } from "../../src/config/load-degrade";
import { loadConfig } from "../../src/config";
import { cliFirstPartyDesired } from "../../src/claude/first-party-settings";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
let claudeHome = "";
let oldLibrary: string | undefined;
function cfg(desktop: boolean, cli: boolean, extra: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, defaultProvider: "openai", providers: {},
    clientIntegrations: { "claude-desktop": desktop },
    claudeCode: { desktopMode: "first-party", cliFirstParty: cli }, ...extra } as OcxConfig;
}
const options = () => ({ opencodexConfigDir: root, claudeConfigDir: claudeHome });
function env(): Record<string, string> | undefined {
  if (!existsSync(join(claudeHome, "settings.json"))) return undefined;
  return (JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8")) as { env?: Record<string, string> }).env;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-claude-union-"));
  claudeHome = join(root, "claude");
  oldLibrary = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "library");
});
afterEach(() => {
  if (oldLibrary === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = oldLibrary;
  removeTreeWithRetry(root);
});

const shapedProxy = "http://opencodex:token@127.0.0.1:10200";
const olderProxy = "http://opencodex:token@127.0.0.1:10000";
test.each([
  { name: "absent", settings: { kind: "absent" }, boundProxyPort: null, eligible: true, expected: "none" },
  { name: "unreadable wins over all other inputs", settings: { kind: "unreadable", path: "settings.json" }, boundProxyPort: null, eligible: false, expected: "unknown" },
  { name: "absent wins over disabled", settings: { kind: "absent" }, boundProxyPort: 10200, eligible: false, expected: "none" },
  { name: "applied on bound port", settings: { kind: "applied", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "live" },
  { name: "default HTTP port 80", settings: { kind: "applied", env: { HTTPS_PROXY: "http://opencodex:t@127.0.0.1:80", NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 80, eligible: true, expected: "live" },
  { name: "applied with no listener", settings: { kind: "applied", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: null, eligible: true, expected: "stopped" },
  { name: "no listener before ineligible", settings: { kind: "applied", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: null, eligible: false, expected: "stopped" },
  { name: "applied on bound port but ineligible", settings: { kind: "applied", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: false, expected: "disabled" },
  { name: "stale older port and ineligible", settings: { kind: "stale", env: { HTTPS_PROXY: olderProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: false, expected: "broken" },
  { name: "token drift on bound port and ineligible", settings: { kind: "stale", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: false, expected: "broken" },
  { name: "stale older port", settings: { kind: "stale", env: { HTTPS_PROXY: olderProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "broken" },
  { name: "stale matching port is still broken", settings: { kind: "stale", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "broken" },
  { name: "malformed port cannot match", settings: { kind: "stale", env: { HTTPS_PROXY: "http://opencodex:t@127.0.0.1:99999", NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "broken" },
  { name: "foreign CA with opencodex token", settings: { kind: "foreign", env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/foreign/ca.pem" } }, boundProxyPort: null, eligible: false, expected: "foreign" },
  { name: "foreign CA with tokenless loopback", settings: { kind: "foreign", env: { HTTPS_PROXY: "http://127.0.0.1:10200", NODE_EXTRA_CA_CERTS: "/foreign/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "local" },
  { name: "CA-only stale", settings: { kind: "stale", env: { NODE_EXTRA_CA_CERTS: "/ours/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "none" },
  { name: "foreign proxy URL", settings: { kind: "foreign", env: { HTTPS_PROXY: "http://proxy.corp:8080", NODE_EXTRA_CA_CERTS: "/foreign/ca.pem" } }, boundProxyPort: 10200, eligible: true, expected: "none" },
] as { name: string; settings: ClaudeInterceptSettingsState; boundProxyPort: number | null; eligible: boolean; expected: FirstPartyProxyStatus }[])(
  "$name -> $expected", ({ settings, boundProxyPort, eligible, expected }) => {
    expect(firstPartyProxyStatus({ settings, boundProxyPort, eligible })).toBe(expected);
  },
);

test("readFirstPartyProxyStatus reads temp settings without creating a proxy token", () => {
  const config = cfg(false, true);
  const tokenPath = claudeInterceptProxyTokenPath(root);
  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("none");
  expect(existsSync(tokenPath)).toBe(false);
  mkdirSync(claudeHome, { recursive: true });
  const path = join(claudeHome, "settings.json");
  writeFileSync(path, "{broken");
  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("unknown");
  expect(existsSync(tokenPath)).toBe(false);
  writeFileSync(path, JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: claudeInterceptCaCertPath(root) } }));
  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("none");
  expect(existsSync(tokenPath)).toBe(false);
  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: olderProxy, NODE_EXTRA_CA_CERTS: claudeInterceptCaCertPath(root) } }));
  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("broken");
  expect(readFirstPartyProxyStatus(config, null, options())).toBe("stopped");
  expect(existsSync(tokenPath)).toBe(false);
  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: shapedProxy, NODE_EXTRA_CA_CERTS: "/foreign/ca.pem" } }));
  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("foreign");
  expect(existsSync(tokenPath)).toBe(false);
  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:10200", NODE_EXTRA_CA_CERTS: "/foreign/ca.pem" } }));
  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("local");
  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: "http://proxy.corp:8080" } }));
  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("none");
  expect(existsSync(tokenPath)).toBe(false);
  writeFileSync(path, JSON.stringify({ env: {} }));
  expect(applyDesktopFirstParty(config, options()).ok).toBe(true);
  expect(existsSync(tokenPath)).toBe(true); // created by apply, before the read
  const tokenBefore = readFileSync(tokenPath, "utf8");
  expect(readFirstPartyProxyStatus(config, 10200, options())).toBe("live");
  expect(readFileSync(tokenPath, "utf8")).toBe(tokenBefore);
});

test.each([[false, false], [false, true], [true, false], [true, true]] as const)(
  "desired desktop=%p cli=%p uses the same owned pair iff either wants it",
  (desktop, cli) => {
    const config = cfg(desktop, cli);
    const desired = firstPartyDesired(config);
    expect(desired).toEqual({ desktop, cli });
    const result = reconcileClaudeFirstPartySettings(config, desired, options());
    expect(result.ok).toBe(true);
    expect(Boolean(env()?.NODE_EXTRA_CA_CERTS)).toBe(desktop || cli);
    if (desktop || cli) {
      expect(env()?.NODE_EXTRA_CA_CERTS).toBe(claudeInterceptCaCertPath(root));
      expect(env()?.HTTPS_PROXY).toContain("127.0.0.1:10200");
      expect(reconcileClaudeFirstPartySettings(config, desired, options())).toMatchObject({ ok: true, action: "unchanged", changed: false });
    } else {
      expect(result).toMatchObject({ ok: true, action: "unchanged", changed: false });
    }
  },
);

test("Desktop on, CLI on, Desktop off retains env; CLI off removes it", () => {
  const desktop = cfg(true, false);
  expect(reconcileClaudeFirstPartySettings(desktop, firstPartyDesired(desktop), options())).toMatchObject({ action: "applied" });
  const both = cfg(true, true);
  expect(reconcileClaudeFirstPartySettings(both, firstPartyDesired(both), options())).toMatchObject({ action: "unchanged" });
  const cli = cfg(false, true);
  expect(removeDesktopFirstParty(cli, options())).toMatchObject({ ok: true, changed: false, retainedFor: "cli" });
  expect(env()?.NODE_EXTRA_CA_CERTS).toBe(claudeInterceptCaCertPath(root));
  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options())).toMatchObject({ action: "unchanged" });
  const none = cfg(false, false);
  expect(reconcileClaudeFirstPartySettings(none, firstPartyDesired(none), options())).toMatchObject({ action: "removed", changed: true });
  expect(env()).toBeUndefined();
});

test("CLI on, Desktop on, CLI off retains env; Desktop off removes it", () => {
  const cli = cfg(false, true);
  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options())).toMatchObject({ action: "applied" });
  const both = cfg(true, true);
  expect(reconcileClaudeFirstPartySettings(both, firstPartyDesired(both), options())).toMatchObject({ action: "unchanged" });
  const desktop = cfg(true, false);
  expect(reconcileClaudeFirstPartySettings(desktop, firstPartyDesired(desktop), options())).toMatchObject({ action: "unchanged" });
  expect(env()?.NODE_EXTRA_CA_CERTS).toBe(claudeInterceptCaCertPath(root));
  const none = cfg(false, false);
  expect(removeDesktopFirstParty(none, options())).toMatchObject({ ok: true, changed: true });
  expect(env()).toBeUndefined();
});

test("foreign env is refused and preserved; unreadable settings is refused", () => {
  mkdirSync(claudeHome, { recursive: true });
  const path = join(claudeHome, "settings.json");
  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: "http://corp-proxy:3128" } }));
  const cli = cfg(false, true);
  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options())).toMatchObject({ ok: false, reason: "foreign_env" });
  expect(env()?.HTTPS_PROXY).toBe("http://corp-proxy:3128");
  writeFileSync(path, "{broken");
  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options())).toMatchObject({ ok: false, reason: "unreadable" });
  expect(readFileSync(path, "utf8")).toBe("{broken");
});

test("stale owned proxy is refreshed, while a foreign CA is never replaced", () => {
  const cli = cfg(false, true);
  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options())).toMatchObject({ action: "applied" });
  const path = join(claudeHome, "settings.json");
  const oldProxy = env()?.HTTPS_PROXY;
  const moved = cfg(false, true, { port: 10300 });
  expect(reconcileClaudeFirstPartySettings(moved, firstPartyDesired(moved), options()))
    .toMatchObject({ ok: true, action: "applied", changed: true });
  expect(env()?.HTTPS_PROXY).not.toBe(oldProxy);
  expect(env()?.HTTPS_PROXY).toContain("127.0.0.1:10400");
  writeFileSync(path, JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:8080", NODE_EXTRA_CA_CERTS: "/etc/foreign-ca.pem" } }));
  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options()))
    .toMatchObject({ ok: false, reason: "foreign_env" });
  expect(env()).toEqual({ HTTPS_PROXY: "http://127.0.0.1:8080", NODE_EXTRA_CA_CERTS: "/etc/foreign-ca.pem" });
});

test("legacy owned env infers Desktop only without CLI intent", () => {
  const legacy = cfg(true, false, { claudeCode: {} });
  expect(applyDesktopFirstParty(legacy, options()).ok).toBe(true);
  expect(observeClaudeDesktopMode(legacy, options()).ownedFirstPartySettings).toBe(true);
  expect(resolveClaudeDesktopMode(legacy, observeClaudeDesktopMode(legacy, options()))).toBe("first-party");
  const cli = cfg(true, true, { claudeCode: { cliFirstParty: true } });
  expect(observeClaudeDesktopMode(cli, options()).ownedFirstPartySettings).toBe(false);
  expect(resolveClaudeDesktopMode(cli, observeClaudeDesktopMode(cli, options()))).toBe("gateway");
  const disabledCli = cfg(true, true, { claudeCode: { cliFirstParty: true, intercept: { enabled: false } } });
  expect(observeClaudeDesktopMode(disabledCli, options()).ownedFirstPartySettings).toBe(false);
});

test("disabled intercept retains desired env; malformed persisted intent degrades off", () => {
  const cli = cfg(false, true);
  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options()).ok).toBe(true);
  const disabled = cfg(false, true, { claudeCode: { cliFirstParty: true, intercept: { enabled: false } } });
  const before = readFileSync(join(claudeHome, "settings.json"), "utf8");
  expect(reconcileClaudeFirstPartySettings(disabled, firstPartyDesired(disabled), options()))
    .toMatchObject({ ok: true, action: "unchanged", changed: false });
  expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toBe(before);
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ env: { ...env(), USER_ENV: "kept" } }));
  const none = cfg(false, false, { claudeCode: { intercept: { enabled: false } } });
  expect(reconcileClaudeFirstPartySettings(none, firstPartyDesired(none), options()))
    .toMatchObject({ ok: true, action: "removed", changed: true });
  expect(env()).toEqual({ USER_ENV: "kept" });
  expect(normalizePersistedClaudeCode({ cliFirstParty: "yes" })).toEqual({});
  expect(normalizePersistedClaudeCode({ cliFirstParty: true })).toEqual({ cliFirstParty: true });
  const base = { port: 0, defaultProvider: "openai", providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" } } };
  // passthrough schema: a malformed value parses, so a hand-edited config never takes the fallback path
  expect(configSchema.safeParse({ ...base, claudeCode: { cliFirstParty: true } }).success).toBe(true);
  expect(configSchema.safeParse({ ...base, claudeCode: { cliFirstParty: "yes" } }).success).toBe(true);
});

test("a malformed cliFirstParty in config.json loads as off and keeps the providers", () => {
  // Real load path, same temp-home pattern as tests/server/config.test.ts:56-83.
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = root;
  const base = { port: 0, defaultProvider: "openai", providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" } } };
  writeFileSync(join(root, "config.json"), JSON.stringify({ ...base, claudeCode: { cliFirstParty: "yes" } }));
  let loaded: OcxConfig;
  try { loaded = loadConfig(); } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  }
  expect(Object.keys(loaded.providers)).toContain("openai");
  expect(loaded.claudeCode?.cliFirstParty).toBeUndefined();
  expect(cliFirstPartyDesired(loaded)).toBe(false);
});

test.each([
  { name: "client role", patch: { runtimeRole: "client" as const } },
  { name: "Claude disabled", patch: { claudeCode: { cliFirstParty: true, enabled: false } } },
  { name: "intercept disabled", patch: { claudeCode: { cliFirstParty: true, intercept: { enabled: false } } } },
])("$name retains an owned env while CLI intent remains", ({ patch }) => {
  const cli = cfg(false, true);
  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli), options()).ok).toBe(true);
  const disabled = cfg(false, true, patch);
  const before = readFileSync(join(claudeHome, "settings.json"), "utf8");
  expect(reconcileClaudeFirstPartySettings(disabled, firstPartyDesired(disabled), options()))
    .toMatchObject({ ok: true, action: "unchanged", changed: false });
  expect(removeDesktopFirstParty(disabled, options()))
    .toMatchObject({ ok: true, changed: false, retainedFor: "cli" });
  expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toBe(before);
});

test("disabled Desktop intent leaves even unreadable settings untouched", () => {
  mkdirSync(claudeHome, { recursive: true });
  const path = join(claudeHome, "settings.json");
  writeFileSync(path, "{broken");
  const disabled = cfg(true, false, { claudeCode: { desktopMode: "first-party", intercept: { enabled: false } } });
  expect(firstPartyDesired(disabled)).toEqual({ desktop: true, cli: false });
  expect(reconcileClaudeFirstPartySettings(disabled, firstPartyDesired(disabled), options()))
    .toMatchObject({ ok: true, action: "unchanged", changed: false, path });
  expect(readFileSync(path, "utf8")).toBe("{broken");
});

test("remove on absent settings is unchanged; corrupt removal preserves bytes", () => {
  const none = cfg(false, false);
  expect(reconcileClaudeFirstPartySettings(none, firstPartyDesired(none), options()))
    .toMatchObject({ ok: true, action: "unchanged", changed: false });
  mkdirSync(claudeHome, { recursive: true });
  const path = join(claudeHome, "settings.json");
  writeFileSync(path, "{broken");
  expect(reconcileClaudeFirstPartySettings(none, firstPartyDesired(none), options()))
    .toMatchObject({ ok: false, reason: "unreadable" });
  expect(readFileSync(path, "utf8")).toBe("{broken");
});

test("CA preparation failure does not create settings", () => {
  const blocked = join(root, "not-a-directory");
  writeFileSync(blocked, "file");
  const cli = cfg(false, true);
  expect(reconcileClaudeFirstPartySettings(cli, firstPartyDesired(cli),
    { opencodexConfigDir: blocked, claudeConfigDir: claudeHome }))
    .toMatchObject({ ok: false, reason: "ca_unavailable" });
  expect(existsSync(join(claudeHome, "settings.json"))).toBe(false);
});
