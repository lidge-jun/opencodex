import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { applyIntegration } from "../../src/integrations/writer";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { projectHomeRouteIntent } from "../../src/link/route-intent";
import { initializeHomeRouteIntentDefaults, readHomeRouteIntentState, seedRouteDeviceClients } from "../../src/routing/home-route-intent";
import { readRouteIntentState, recordHomeNativeDecision, routeIntentStatePath, setRouteClientIntent, writeRouteIntentState } from "../../src/routing/route-intent-state";
import { integrationEnabled } from "../../src/codex/desired-state";
import { getDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import { persistNativeRouteIntent } from "../../src/client/route-intent-apply";
import type { OcxConfig } from "../../src/types";

let home: TempHome;
beforeEach(() => { home = createTempHome("route-upgrade-"); });
afterEach(() => home.remove());

test.each([undefined, false, true])("unrelated Home changes preserve existing native intent when flags are %s", flag => {
  const config = { port: 18274, hostname: "127.0.0.1", providers: {},
    ...(flag === undefined ? {} : { clientIntegrations: { grok: flag, "claude-desktop": flag } }),
  } as OcxConfig;
  const expected = { grok: integrationEnabled(config, "grok"), desktop: integrationEnabled(config, "claude-desktop") };
  const before = projectHomeRouteIntent(config, "1", "home", readHomeRouteIntentState(config));
  expect(before.clients.grok.enabled).toBe(expected.grok);
  expect(before.clients["claude-desktop"].enabled).toBe(expected.desktop);
  initializeHomeRouteIntentDefaults(config, "1", "opencode");
  setRouteClientIntent("opencode", { enabled: true });
  const after = projectHomeRouteIntent(config, "1", "home", readHomeRouteIntentState(config));
  expect(after.clients.grok.enabled).toBe(expected.grok);
  expect(after.clients["claude-desktop"].enabled).toBe(expected.desktop);
  expect(after.clients.opencode.enabled).toBe(true);
  if (flag === undefined) {
    const child = projectHomeRouteIntent(config, "1", "lnk_0123456789abcdef", readHomeRouteIntentState(config));
    expect(child.clients.grok.enabled).toBe(false);
    expect(child.clients["claude-desktop"].enabled).toBe(false);
  }
});

test("the Home's own Grok switch governs the Home; defaults govern Children and a decided Home write", () => {
  const config = { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig;
  initializeHomeRouteIntentDefaults(config, "1", "opencode");
  const homeIntent = (decided?: "grok", decidedIntent?: { enabled: boolean }) => projectHomeRouteIntent(config, "1", "home", readHomeRouteIntentState(config),
    { decidedClient: decided, ...(decidedIntent ? { decidedIntent } : {}) }).clients.grok.enabled;
  const childIntent = () => projectHomeRouteIntent(config, "1", "lnk_0123456789abcdef", readHomeRouteIntentState(config)).clients.grok.enabled;
  expect(homeIntent()).toBe(true);
  setRouteClientIntent("grok", { enabled: false });
  // The absent switch is on; only the write deciding Grok applies the default to the Home.
  expect(homeIntent()).toBe(true);
  expect(homeIntent("grok")).toBe(false);
  expect(childIntent()).toBe(false);
  config.clientIntegrations = { grok: false };
  expect(homeIntent()).toBe(false);
  // A Home-only decision carries its own value, whatever the default.
  expect(homeIntent("grok", { enabled: true })).toBe(true);
  config.clientIntegrations = { grok: true };
  expect(homeIntent()).toBe(true);
  expect(childIntent()).toBe(false);
  expect(projectHomeRouteIntent(config, "1", "home", readHomeRouteIntentState(config)).sources.grok).toBe("native");
});

test.each(["grok", "claude-desktop"] as const)("the first capture saves the off Child builtin for %s and a Home decision records no Home entry", client => {
  const config = { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig;
  initializeHomeRouteIntentDefaults(config, "1", "opencode");
  // Grok and Desktop are never captured on, whatever the Home's switch says.
  expect(readRouteIntentState().defaults[client]).toEqual({ enabled: false });
  recordHomeNativeDecision(client);
  // The switch the decision wrote; a later capture must not spread it to Children.
  config.clientIntegrations = { [client]: true };
  initializeHomeRouteIntentDefaults(config, "1");
  const state = readHomeRouteIntentState(config);
  expect(state.defaults[client]).toEqual({ enabled: false });
  expect(state.devices.home).toBeUndefined();
  expect(projectHomeRouteIntent(config, "1", "home", state).clients[client].enabled).toBe(true);
  expect(projectHomeRouteIntent(config, "1", "home", state, { decidedClient: client }).clients[client].enabled).toBe(false);
  expect(projectHomeRouteIntent(config, "1", "lnk_0123456789abcdef", state).clients[client].enabled).toBe(false);
});

test.each(["codex", "claude", "grok", "claude-desktop"] as const)("route intent refuses a devices.home entry for native %s and drops an old one", client => {
  const config = { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig;
  expect(() => setRouteClientIntent(client, { enabled: false }, "home")).toThrow();
  writeRouteIntentState({ version: 1, defaults: {}, devices: { home: { [client]: { enabled: false }, pi: { enabled: true } } } });
  // An old entry never decides the Home: an absent switch is on.
  expect(projectHomeRouteIntent(config, "1", "home", readHomeRouteIntentState(config)).clients[client].enabled).toBe(true);
  initializeHomeRouteIntentDefaults(config, "1");
  expect(readRouteIntentState().devices.home).toEqual({ pi: { enabled: true } });
});

test.each(["grok", "claude-desktop"] as const)("a no-op enable does not invent a persisted %s flag", client => {
  const config = getDefaultConfig();
  delete config.clientIntegrations;
  saveConfig(config);
  const snapshot = loadConfig();
  expect(snapshot.clientIntegrations?.[client]).toBeUndefined();
  persistNativeRouteIntent(client, true, () => {}, snapshot, false);
  expect(snapshot.clientIntegrations?.[client]).toBeUndefined();
  expect(loadConfig().clientIntegrations?.[client]).toBeUndefined();
});

test("an enrollment without a client selection inherits current and later Home defaults", () => {
  const config = { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig;
  const id = "lnk_0123456789abcdef";
  setRouteClientIntent("codex", { enabled: false });
  setRouteClientIntent("claude", { enabled: false });
  seedRouteDeviceClients(config, "1", id);
  let state = readHomeRouteIntentState(config);
  expect(state.devices[id]).toBeUndefined();
  expect(projectHomeRouteIntent(config, "1", id, state).clients.codex.enabled).toBe(false);
  expect(projectHomeRouteIntent(config, "1", id, state).clients.claude.enabled).toBe(false);
  setRouteClientIntent("codex", { enabled: true });
  state = readHomeRouteIntentState(config);
  expect(projectHomeRouteIntent(config, "1", id, state).clients.codex.enabled).toBe(true);
});

test("an explicit enrollment selection remains a device override", () => {
  const config = { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig;
  const id = "lnk_0123456789abcdef";
  setRouteClientIntent("codex", { enabled: false });
  seedRouteDeviceClients(config, "1", id, ["codex"]);
  const state = readHomeRouteIntentState(config);
  expect(projectHomeRouteIntent(config, "1", id, state).clients.codex.enabled).toBe(true);
  expect(projectHomeRouteIntent(config, "1", id, state).clients.claude.enabled).toBe(false);
});

test("a passive Home read preserves old owned intent; local overrides cannot rewrite migrated defaults", () => {
  const config = { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig;
  const spec = INTEGRATION_CLIENTS.pi;
  const deviceHome = home.path("device");
  const path = spec.configPath({}, deviceHome);
  mkdirSync(spec.detectDir({}, deviceHome), { recursive: true }); mkdirSync(dirname(path), { recursive: true });
  const store = createIntegrationStateStore();
  expect(applyIntegration({ clientId: "pi", config, port: config.port, models: [], home: deviceHome, env: {}, store }).ok).toBe(true);
  const inherited = readHomeRouteIntentState(config);
  expect(projectHomeRouteIntent(config, "1", undefined, inherited).clients.pi.enabled).toBe(true);
  expect(existsSync(routeIntentStatePath())).toBe(false);
  initializeHomeRouteIntentDefaults(config, "1");
  recordHomeNativeDecision("codex");
  const localMaterializedConfig = { ...config, clientIntegrations: { codex: false } };
  const state = readHomeRouteIntentState(localMaterializedConfig);
  expect(projectHomeRouteIntent(localMaterializedConfig, "1", "home", state).clients.codex.enabled).toBe(false);
  expect(projectHomeRouteIntent(localMaterializedConfig, "1", "lnk_0123456789abcdef", state).clients.codex.enabled).toBe(true);
  setRouteClientIntent("pi", { enabled: false });
  expect(projectHomeRouteIntent(config, "1", undefined, readHomeRouteIntentState(config)).clients.pi.enabled).toBe(false);
});

test("an unowned file never becomes a Home routing decision", () => {
  const spec = INTEGRATION_CLIENTS.pi;
  const deviceHome = home.path("device");
  const path = spec.configPath({}, deviceHome); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ providers: { opencodex: { baseUrl: "https://foreign.example.test" } } }));
  const config = { port: 18274, providers: {} } as OcxConfig;
  expect(projectHomeRouteIntent(config, "1", undefined, readHomeRouteIntentState(config)).clients.pi.enabled).toBe(false);
});
