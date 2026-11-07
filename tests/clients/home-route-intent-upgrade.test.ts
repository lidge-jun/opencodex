import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { applyIntegration } from "../../src/integrations/writer";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { projectHomeRouteIntent } from "../../src/link/route-intent";
import { initializeHomeRouteIntentDefaults, readHomeRouteIntentState } from "../../src/routing/home-route-intent";
import { routeIntentStatePath, setRouteClientIntent } from "../../src/routing/route-intent-state";
import type { OcxConfig } from "../../src/types";

let home: TempHome;
beforeEach(() => { home = createTempHome("route-upgrade-"); });
afterEach(() => home.remove());

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
