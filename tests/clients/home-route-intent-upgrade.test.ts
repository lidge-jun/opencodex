import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { applyIntegration } from "../../src/integrations/writer";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { projectHomeRouteIntent } from "../../src/link/route-intent";
import { initializeHomeRouteIntentDefaults, readHomeRouteIntentState, seedRouteDeviceClients } from "../../src/routing/home-route-intent";
import { clearRouteClientIntent, routeIntentStatePath, setRouteClientIntent } from "../../src/routing/route-intent-state";
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

test("a later explicit default supersedes migrated Home intent but not a user Home override", () => {
  const config = { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig;
  initializeHomeRouteIntentDefaults(config, "1", "opencode");
  const homeIntent = () => projectHomeRouteIntent(config, "1", "home", readHomeRouteIntentState(config)).clients.grok.enabled;
  expect(homeIntent()).toBe(true);
  setRouteClientIntent("grok", { enabled: false });
  expect(homeIntent()).toBe(false);
  setRouteClientIntent("grok", { enabled: true }, "home");
  setRouteClientIntent("grok", { enabled: false });
  expect(homeIntent()).toBe(true);
  config.clientIntegrations = { grok: true };
  clearRouteClientIntent("grok", "home");
  expect(homeIntent()).toBe(false);
  expect(projectHomeRouteIntent(config, "1", "lnk_0123456789abcdef", readHomeRouteIntentState(config)).clients.grok.enabled).toBe(false);
});

test.each(["grok", "claude-desktop"] as const)("clearing a first Home %s override restores the off Child builtin", client => {
  const config = { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig;
  initializeHomeRouteIntentDefaults(config, "1", "opencode");
  setRouteClientIntent(client, { enabled: true }, "home");
  config.clientIntegrations = { [client]: true };
  clearRouteClientIntent(client, "home");
  const state = readHomeRouteIntentState(config);
  expect(projectHomeRouteIntent(config, "1", "home", state).clients[client].enabled).toBe(false);
  expect(projectHomeRouteIntent(config, "1", "lnk_0123456789abcdef", state).clients[client].enabled).toBe(false);
});

test.each(["grok", "claude-desktop"] as const)("a no-op enable does not invent a persisted %s flag", client => {
  const config = getDefaultConfig();
  delete config.clientIntegrations;
  saveConfig(config);
  const snapshot = loadConfig();
  expect(snapshot.clientIntegrations?.[client]).toBeUndefined();
  persistNativeRouteIntent(client, true, () => {}, snapshot);
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
  setRouteClientIntent("codex", { enabled: false }, "home");
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
