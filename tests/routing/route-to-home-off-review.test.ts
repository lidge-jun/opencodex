import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { syncHomeRouteTo } from "../../src/routing/route-to-local";
import { setRouteClientIntent } from "../../src/routing/route-intent-state";
import { initializeHomeRouteIntentDefaults } from "../../src/routing/home-route-intent";
import { materializeRouteIntent, readRouteIntentReceipt } from "../../src/integrations/route-intent";
import { applyIntegration } from "../../src/integrations/writer";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { mkdirSync, readFileSync } from "node:fs";
import type { OcxConfig } from "../../src/types";
let home: TempHome;
beforeEach(() => { home = createTempHome("home-off-review-"); });
afterEach(() => home.remove());

test("enabling an unrelated integration never turns default-on native clients off", async () => {
  const config = { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig;
  initializeHomeRouteIntentDefaults(config, "test", "opencode");
  setRouteClientIntent("opencode", { enabled: true });
  const nativeCalls: Array<{ client: string; enabled: boolean }> = [];
  await syncHomeRouteTo(config, "test", false, undefined, undefined, {
    loadModels: async () => [],
    materialize: async (snapshot, document, models, options) => materializeRouteIntent({
      config: snapshot, document, models, ...options,
      home: home.path("local"), env: {}, store: createIntegrationStateStore(),
      applyNative: async (client, intent) => {
        nativeCalls.push({ client, enabled: intent.enabled });
        return { client, outcome: "current" };
      },
    }),
  });
  expect(nativeCalls).toContainEqual({ client: "grok", enabled: true });
  expect(nativeCalls).toContainEqual({ client: "claude-desktop", enabled: true });
  expect(nativeCalls.some(call => ["grok", "claude-desktop"].includes(call.client) && !call.enabled)).toBe(false);
});

test.each([false, true])("Home off restores before discovery fails or stalls (failure %s)", async fail => {
  const config = { port: 18274, hostname: "127.0.0.1", providers: {} } as OcxConfig;
  const localHome = home.path("local");
  const store = createIntegrationStateStore();
  const spec = INTEGRATION_CLIENTS.pi;
  mkdirSync(spec.detectDir({}, localHome), { recursive: true });
  const path = spec.configPath({}, localHome);
  expect(applyIntegration({ clientId: "pi", config, port: config.port, models: [], store, home: localHome, env: {} }).ok).toBe(true);
  expect(readFileSync(path, "utf8")).toContain("opencodex");
  setRouteClientIntent("pi", { enabled: false });
  const enabledCalls: string[] = [];
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const pending = syncHomeRouteTo(config, "test", false, undefined, undefined, {
    materialize: async (config, document, models, options) => materializeRouteIntent({ config, document, models, ...options,
      home: localHome, env: {}, store, applyNative: async (client, intent) => { if (intent.enabled) enabledCalls.push(client); return { client, outcome: "current" }; } }),
    loadModels: async () => { started(); await waiting; if (fail) throw new Error("fixture discovery failure"); return []; },
  });
  await entered;
  // Discovery is still blocked here; only off intents may have touched configuration.
  const blocked = { content: readFileSync(path, "utf8"), enabled: [...enabledCalls],
    piOutcome: readRouteIntentReceipt()?.outcomes.find(row => row.client === "pi")?.outcome };
  release();
  if (fail) await expect(pending).rejects.toThrow("fixture discovery failure");
  else { await pending; expect(enabledCalls).toContain("codex"); }
  expect(blocked.content).not.toContain("opencodex");
  expect(blocked.enabled).toEqual([]);
  expect(blocked.piOutcome).toBe("current");
});
