import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * Home-only integration writes under route intent: a dashboard toggle, a restore and an Aside
 * profile change are the Home's decision. Children's defaults are saved before the write (also by
 * the link listener's start on an upgraded Home), and the result is recorded so ocx sync keeps it.
 */
function scenario(body: string) {
  const home = mkdtempSync(join(tmpdir(), "ocx-home-decisions-"));
  for (const dir of [".codex", ".claude", "desktop"]) mkdirSync(join(home, dir));
  try {
    const child = spawnSync(process.execPath, ["--eval", `
      import { expect } from 'bun:test';
      import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { getDefaultConfig, saveConfig, loadConfig } from './src/config';
      import { writeLinkStore } from './src/link/store';
      import { linkStorePath } from './src/link/paths';
      import { LINK_ROUTE_INTENT_PATH } from './src/link/management-routes';
      import { handleRouteToRoutes } from './src/server/management/route-to-routes';
      import { handleIntegrationRoutes } from './src/server/management/integration-routes';
      import { readLinkRouteIntent } from './src/server/index/route-intent-watch';
      import { createLinkListenerLifecycle } from './src/server/index/link-listener';
      import { captureHomeRouteDefaults } from './src/routing/home-route-capture';
      import { readRouteIntentState, routeIntentStatePath } from './src/routing/route-intent-state';
      import { syncHomeRouteTo } from './src/routing/route-to-local';
      import { applyIntegration } from './src/integrations/writer';
      import { createIntegrationStateStore } from './src/integrations/store';
      import { INTEGRATION_CLIENTS } from './src/integrations/registry';
      writeFileSync(join(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR,'_meta.json'),JSON.stringify({entries:[]}));
      const local = getDefaultConfig(); local.port=18274; local.hostname='127.0.0.1';
      local.defaultProvider='fixture';local.providers={fixture:{adapter:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',allowPrivateNetwork:true,liveModels:false,models:['fixture-model']}};
      saveConfig(local);
      writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [{ id: 'lnk_0123456789abcdef', alias: 'child', direction: 'client-initiated', hostKeyFingerprint: null, tunnelPort: 19200, apiKeyId: 'key-test', createdAt: '2026-11-07T00:00:00.000Z' }] });
      const live = loadConfig();
      const management = async (handler, method, path, body) => {
        const req = new Request('http://localhost'+path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const response = await handler({ req, url: new URL(req.url), config: loadConfig(), version: 'test', deps: { readRuntimePort: () => null } });
        return { status: response?.status, body: await response?.json() };
      };
      const call = (path, body) => management(handleRouteToRoutes, path.endsWith('/sync') ? 'POST' : 'PUT', path, body);
      const toggle = (client, enabled) => management(handleIntegrationRoutes, 'PUT', '/api/client-integrations/'+client, { enabled });
      const childIntent = async () => {
        const response = await readLinkRouteIntent(new Request('http://127.0.0.1:19100'+LINK_ROUTE_INTENT_PATH), live, 'test', 'key-test');
        expect(response.status).toBe(200);
        return (await response.json()).clients;
      };
      const store = createIntegrationStateStore();
      const piPath = INTEGRATION_CLIENTS.pi.configPath({}, process.env.HOME);
      mkdirSync(INTEGRATION_CLIENTS.pi.detectDir({}, process.env.HOME), { recursive: true });
      const piRouted = () => !!store.readRecords().pi && existsSync(piPath) && readFileSync(piPath, 'utf8').includes('opencodex');
      // The client argument only picks a report row; every call is a full Home sync.
      const homeSync = async client => (await syncHomeRouteTo(loadConfig(), 'test', false, undefined, undefined, { loadModels: async () => [] }))
        .find(row => row.client === client);
      const fullHomeSync = () => syncHomeRouteTo(loadConfig(), 'test', false, undefined, undefined, { loadModels: async () => [] });
      const asideRoot = join(process.env.HOME, '.aside');
      const asideModels = join(asideRoot, 'u', '0', 'models.json');
      const asideProfile = (userId) => {
        mkdirSync(join(asideRoot, 'u', '0'), { recursive: true });
        writeFileSync(asideModels, JSON.stringify({ preferences: { userId }, providers: { personal: { apiKey: 'fixture-personal' } } }));
        writeFileSync(join(asideRoot, 'accounts.json'), JSON.stringify({ currentAccountId: 0, accounts: [userId ? { id: 0, userId } : { id: 0 }] }));
      };
      const asideRouted = () => !!JSON.parse(readFileSync(asideModels, 'utf8')).providers.opencodex;
      ${body}
    `], { cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
        CODEX_SQLITE_HOME: join(home, ".codex"), OPENCODEX_HOME: join(home, ".opencodex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"), GROK_HOME: join(home, ".grok"), XDG_CONFIG_HOME: join(home, ".config"),
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"), OCX_TEST_HOME_GUARD: "1" } });
    expect({ status: child.status, stderr: child.stderr, error: child.error?.message }).toMatchObject({ status: 0 });
  } finally { removeTreeWithRetry(home); }
}

test("on an upgraded linked Home a dashboard toggle leaves the Children's file defaults where they were", () => scenario(`
  // Before this PR the Home saved only the four native defaults.
  expect(captureHomeRouteDefaults(undefined, { whenLinked: true })).toBe(true);
  expect(Object.keys(readRouteIntentState().defaults).sort()).toEqual(['claude', 'claude-desktop', 'codex', 'grok']);
  expect((await childIntent()).pi).toEqual({ enabled: false });
  const on = await toggle('pi', true);
  expect(on.status).toBe(200);
  expect(piRouted()).toBe(true);
  expect((await childIntent()).pi).toEqual({ enabled: false });
  expect(readRouteIntentState().defaults.pi).toEqual({ enabled: false });
  expect(readRouteIntentState().devices.home?.pi).toEqual({ enabled: true });
  expect((await homeSync('pi'))?.outcome).toBe('current');
  expect(piRouted()).toBe(true);
  expect(readRouteIntentState().defaults.pi).toEqual({ enabled: false });
  expect((await childIntent()).pi).toEqual({ enabled: false });
`), SPAWN_BUDGET_MS);

test("the link listener's start saves every default a Child inherits, file integrations included", () => scenario(`
  expect(applyIntegration({ clientId: 'pi', config: loadConfig(), port: 18274, models: [], store, home: process.env.HOME, env: process.env }).ok).toBe(true);
  expect(captureHomeRouteDefaults(undefined, { whenLinked: true })).toBe(true);
  expect(readRouteIntentState().defaults.pi).toBeUndefined();
  const listener = createLinkListenerLifecycle({ serve: () => ({ port: 19100, stop: async () => {} }), warn: () => {} });
  listener.start({ dispatch: async () => new Response(null), maxRequestBodySize: 1024 });
  expect(listener.status().state).toBe('listening');
  await listener.stop();
  expect(readRouteIntentState().defaults.pi).toEqual({ enabled: true });
  // A later Home-only toggle now cannot move the Child's default.
  expect((await toggle('pi', false)).status).toBe(200);
  expect((await childIntent()).pi).toEqual({ enabled: true });
  expect(readRouteIntentState().devices.home?.pi).toEqual({ enabled: false });
`), SPAWN_BUDGET_MS);

test("a dashboard restore is the Home's decision, so ocx sync does not reverse the undo", () => scenario(`
  expect((await call('/api/route-to', { client: 'pi', action: 'off' })).status).toBe(200);
  expect((await toggle('pi', true)).status).toBe(200);
  expect(readRouteIntentState().devices.home?.pi).toEqual({ enabled: true });
  const opId = store.listOperations('pi', 1)[0].opId;
  const restored = await management(handleIntegrationRoutes, 'POST', '/api/client-integrations/restore', { opId });
  expect(restored.status).toBe(200);
  expect(piRouted()).toBe(false);
  expect(readRouteIntentState().devices.home?.pi).toEqual({ enabled: false });
  expect((await homeSync('pi'))?.outcome).toBe('current');
  expect(piRouted()).toBe(false);
`), SPAWN_BUDGET_MS);

test("a dashboard Aside profile toggle on a Home that uses route intent survives ocx sync", () => scenario(`
  asideProfile('user-a');
  expect((await call('/api/route-to', { client: 'pi', action: 'off' })).status).toBe(200);
  expect(readRouteIntentState().defaults.aside?.enabled).toBe(false);
  const on = await management(handleIntegrationRoutes, 'PUT', '/api/client-integrations/aside/profiles/0', { enabled: true });
  expect(on.status).toBe(200);
  expect(asideRouted()).toBe(true);
  expect(readRouteIntentState().devices.home?.aside).toEqual({ enabled: true, accounts: ['user-a'] });
  expect((await homeSync('aside'))?.outcome).toBe('current');
  expect(asideRouted()).toBe(true);
  // Children keep their default.
  expect((await childIntent()).aside.enabled).toBe(false);
  const off = await management(handleIntegrationRoutes, 'PUT', '/api/client-integrations/aside/profiles/0', { enabled: false });
  expect(off.status).toBe(200);
  expect(readRouteIntentState().devices.home?.aside?.enabled).toBe(false);
  expect((await homeSync('aside'))?.outcome).toBe('current');
  expect(asideRouted()).toBe(false);
`), SPAWN_BUDGET_MS);

test("an Aside profile toggle refuses before anything changes when its decision cannot be kept", () => scenario(`
  asideProfile(undefined);
  expect((await call('/api/route-to', { client: 'pi', action: 'off' })).status).toBe(200);
  const before = readFileSync(asideModels, 'utf8');
  const unresolved = await management(handleIntegrationRoutes, 'PUT', '/api/client-integrations/aside/profiles/0', { enabled: true });
  expect(unresolved.status).toBe(409);
  expect(unresolved.body).toMatchObject({ code: 'route_intent_aside_unresolved', clientId: 'aside' });
  expect(readFileSync(asideModels, 'utf8')).toBe(before);
  expect(readRouteIntentState().devices.home?.aside).toBeUndefined();
  asideProfile('user-a');
  writeFileSync(routeIntentStatePath(), '{not json');
  const damaged = await management(handleIntegrationRoutes, 'PUT', '/api/client-integrations/aside/profiles/0', { enabled: true });
  expect(damaged.status).toBe(500);
  expect(damaged.body).toMatchObject({ code: 'route_intent_unavailable', clientId: 'aside' });
  expect(damaged.body.error).toContain(routeIntentStatePath());
  expect(asideRouted()).toBe(false);
`), SPAWN_BUDGET_MS);

test("on a Home with no link an unreadable route-intent.json neither blocks a dashboard toggle nor gets written", () => scenario(`
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [] });
  writeFileSync(routeIntentStatePath(), '{not json');
  expect((await toggle('pi', true)).status).toBe(200);
  expect(piRouted()).toBe(true);
  expect(readFileSync(routeIntentStatePath(), 'utf8')).toBe('{not json');
  expect((await toggle('pi', false)).status).toBe(200);
  expect(piRouted()).toBe(false);
  expect(readFileSync(routeIntentStatePath(), 'utf8')).toBe('{not json');
`), SPAWN_BUDGET_MS);

test("on an upgraded linked Home whose Aside profiles have no stable userId, a full Home sync leaves Aside routed and still applies the rest", () => scenario(`
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [] });
  asideProfile(undefined);
  expect((await management(handleIntegrationRoutes, 'PUT', '/api/client-integrations/aside/profiles/0', { enabled: true })).status).toBe(200);
  expect(asideRouted()).toBe(true);
  expect(applyIntegration({ clientId: 'pi', config: loadConfig(), port: 18274, models: [], store, home: process.env.HOME, env: process.env }).ok).toBe(true);
  // A link enrolled by an earlier version: no route-intent.json yet.
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [{ id: 'lnk_0123456789abcdef', alias: 'child', direction: 'client-initiated', hostKeyFingerprint: null, tunnelPort: 19200, apiKeyId: 'key-test', createdAt: '2026-11-07T00:00:00.000Z' }] });
  const listener = createLinkListenerLifecycle({ serve: () => ({ port: 19100, stop: async () => {} }), warn: () => {} });
  listener.start({ dispatch: async () => new Response(null), maxRequestBodySize: 1024 });
  await listener.stop();
  expect(readRouteIntentState().defaults.aside).toBeUndefined();
  const unresolved = [];
  const outcomes = await syncHomeRouteTo(loadConfig(), 'test', false, undefined, undefined, { loadModels: async () => [], onAsideUnresolved: message => unresolved.push(message) });
  expect(outcomes.find(row => row.client === 'aside')).toBeUndefined();
  expect(outcomes.find(row => row.client === 'pi')?.outcome).toBe('current');
  expect(asideRouted()).toBe(true);
  expect(piRouted()).toBe(true);
  expect(unresolved).toHaveLength(1);
  expect(unresolved[0]).toContain('ocx route to aside');
  expect(readRouteIntentState().defaults.aside).toBeUndefined();
`), SPAWN_BUDGET_MS);

test("an explicit Home Aside decision on unresolved ownership is saved and survives a full sync", () => scenario(`
  asideProfile(undefined);
  // An upgraded Home: Aside is already owned, before any route intent exists.
  expect(applyIntegration({ clientId: 'aside', config: loadConfig(), port: 18274, models: [], store, home: process.env.HOME, env: process.env }).ok).toBe(true);
  expect(asideRouted()).toBe(true);
  expect(applyIntegration({ clientId: 'pi', config: loadConfig(), port: 18274, models: [], store, home: process.env.HOME, env: process.env }).ok).toBe(true);
  const listener = createLinkListenerLifecycle({ serve: () => ({ port: 19100, stop: async () => {} }), warn: () => {} });
  listener.start({ dispatch: async () => new Response(null), maxRequestBodySize: 1024 });
  await listener.stop();
  expect(readRouteIntentState().defaults.aside).toBeUndefined();
  // The recovery command the sync message advertises decides only this Home.
  const off = await call('/api/route-to', { client: 'aside', action: 'off', device: 'home' });
  expect(off.status).toBe(200);
  expect(asideRouted()).toBe(false);
  expect(readRouteIntentState().defaults.aside).toBeUndefined();
  expect(readRouteIntentState().devices.home?.aside).toEqual({ enabled: false });
  const afterOff = await fullHomeSync();
  expect(afterOff.find(row => row.client === 'aside')?.outcome).toBe('current');
  expect(asideRouted()).toBe(false);
  expect(readRouteIntentState().defaults.aside).toBeUndefined();
  const on = await call('/api/route-to', { client: 'aside', action: 'on', device: 'home' });
  expect(on.status).toBe(200);
  expect(asideRouted()).toBe(true);
  expect(readRouteIntentState().defaults.aside).toBeUndefined();
  expect(readRouteIntentState().devices.home?.aside?.enabled).toBe(true);
  const afterOn = await fullHomeSync();
  expect(afterOn.find(row => row.client === 'aside')?.outcome).toBe('current');
  expect(asideRouted()).toBe(true);
  expect(readRouteIntentState().defaults.aside).toBeUndefined();
`), SPAWN_BUDGET_MS);
