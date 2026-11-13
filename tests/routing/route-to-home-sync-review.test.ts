import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { handleRouteToCommand } from "../../src/cli/route-to";
import { ROUTE_CLIENT_IDS } from "../../src/link/route-intent";

/**
 * Home sync paths the review found incomplete: a full route-to sync on a Home whose Aside ownership
 * cannot be named, an off-only Home decision, and a dashboard decision racing a Home apply.
 */

function scenario(body: string) {
  const home = mkdtempSync(join(tmpdir(), "ocx-home-sync-review-"));
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
      import { readRouteIntentState, routeIntentStatePath, setRouteClientIntent } from './src/routing/route-intent-state';
      import { readRouteIntentReceipt } from './src/integrations/route-intent';
      import { withLinkApply } from './src/client/link-home';
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

/** The upgraded Home of route-to-home-decisions: Aside is owned through a profile with no stable userId. */
const unresolvedHome = `
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [] });
  asideProfile(undefined);
  expect((await management(handleIntegrationRoutes, 'PUT', '/api/client-integrations/aside/profiles/0', { enabled: true })).status).toBe(200);
  expect(applyIntegration({ clientId: 'pi', config: loadConfig(), port: 18274, models: [], store, home: process.env.HOME, env: process.env }).ok).toBe(true);
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [{ id: 'lnk_0123456789abcdef', alias: 'child', direction: 'client-initiated', hostKeyFingerprint: null, tunnelPort: 19200, apiKeyId: 'key-test', createdAt: '2026-11-07T00:00:00.000Z' }] });
  const listener = createLinkListenerLifecycle({ serve: () => ({ port: 19100, stop: async () => {} }), warn: () => {} });
  listener.start({ dispatch: async () => new Response(null), maxRequestBodySize: 1024 });
  await listener.stop();
  expect(readRouteIntentState().defaults.aside).toBeUndefined();
  const read = async device => {
    const req = new Request('http://localhost/api/route-to' + (device ? '?device=' + device : ''));
    const response = await handleRouteToRoutes({ req, url: new URL(req.url), config: loadConfig(), version: 'test', deps: { readRuntimePort: () => null } });
    return { status: response.status, body: await response.json() };
  };
`;

test("a full route-to sync on unresolved Aside reports the other clients and Aside as unresolved, with the recovery warning", () => scenario(unresolvedHome + `
  const synced = await call('/api/route-to/sync', {});
  expect(synced.status).toBe(200);
  const home = synced.body.devices.find(row => row.id === 'home');
  expect(home.clients.find(row => row.client === 'aside')).toEqual({ client: 'aside', intent: 'unresolved', source: 'default', applied: null });
  expect(home.clients.find(row => row.client === 'pi')).toMatchObject({ intent: 'on', applied: 'current' });
  expect(synced.body.warnings).toHaveLength(1);
  expect(synced.body.warnings[0]).toContain('ocx route to aside on|off --device home');
  // Aside was left exactly as it was, and nothing was saved for it.
  expect(asideRouted()).toBe(true);
  expect(piRouted()).toBe(true);
  expect(readRouteIntentState().defaults.aside).toBeUndefined();
  // A status read reports the same, for the Home and for a Child inheriting the default.
  const all = await read('all');
  expect(all.status).toBe(200);
  for (const device of all.body.devices) expect(device.clients.find(row => row.client === 'aside').intent).toBe('unresolved');
  expect(all.body.warnings).toHaveLength(1);
`), SPAWN_BUDGET_MS);

test("a Home Aside decision does not resolve or capture an inherited Child default", () => scenario(unresolvedHome + `
  const decision = await call('/api/route-to', { client: 'aside', action: 'off', device: 'home' });
  expect(decision.status).toBe(200);
  expect(readRouteIntentState().defaults.aside).toBeUndefined();
  const request = () => readLinkRouteIntent(new Request('http://127.0.0.1:19100'+LINK_ROUTE_INTENT_PATH), live, 'test', 'key-test');
  expect((await request()).status).toBe(503);
  const status = await read('all');
  expect(status.body.devices.find(row => row.id === 'home').clients.find(row => row.client === 'aside').intent).toBe('off');
  expect(status.body.devices.find(row => row.id !== 'home').clients.find(row => row.client === 'aside').intent).toBe('unresolved');
  const { captureChildRouteDefaults } = await import('./src/routing/home-route-intent');
  expect(() => captureChildRouteDefaults()).toThrow();
  expect(readRouteIntentState().defaults.aside).toBeUndefined();
  setRouteClientIntent('aside', { enabled: true, accounts: ['user-child'] }, 'lnk_0123456789abcdef');
  const explicit = await request();
  expect(explicit.status).toBe(200);
  expect((await explicit.json()).clients.aside).toEqual({ enabled: true, accounts: ['user-child'] });
  await fullHomeSync();
  expect(readRouteIntentState().defaults.aside).toBeUndefined();
`), SPAWN_BUDGET_MS);

test("a Home Aside decision captures resolvable legacy ownership before applying it", () => scenario(`
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [] });
  asideProfile('user-legacy');
  expect((await management(handleIntegrationRoutes, 'PUT', '/api/client-integrations/aside/profiles/0', { enabled: true })).status).toBe(200);
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [{ id: 'lnk_0123456789abcdef', alias: 'child', direction: 'client-initiated', hostKeyFingerprint: null, tunnelPort: 19200, apiKeyId: 'key-test', createdAt: '2026-11-07T00:00:00.000Z' }] });
  expect((await call('/api/route-to', { client: 'aside', action: 'off', device: 'home' })).status).toBe(200);
  expect((await childIntent()).aside).toEqual({ enabled: true, accounts: ['user-legacy'] });
  expect(readRouteIntentState().defaults.aside).toEqual({ enabled: true, accounts: ['user-legacy'] });
`), SPAWN_BUDGET_MS);

test("an off-only Home decision completes without model discovery and keeps the receipt's served roster", () => scenario(`
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [] });
  const roster = [{ namespaced: 'fixture/fixture-model', provider: 'fixture', id: 'fixture-model' }];
  expect((await toggle('pi', true)).status).toBe(200);
  await syncHomeRouteTo(loadConfig(), 'test', false, undefined, undefined, { loadModels: async () => roster });
  expect(piRouted()).toBe(true);
  expect(readRouteIntentReceipt().models).toEqual(roster);
  setRouteClientIntent('pi', { enabled: false }, 'home');
  const outcomes = await syncHomeRouteTo(loadConfig(), 'test', false, undefined, undefined, { onlyClient: 'pi',
    loadModels: async () => { throw new Error('model discovery ran for an off-only decision'); } });
  expect(outcomes.find(row => row.client === 'pi')?.outcome).toBe('current');
  expect(piRouted()).toBe(false);
  expect(readRouteIntentReceipt().models).toEqual(roster);
`), SPAWN_BUDGET_MS);

test("a dashboard disable cannot be undone by an already projected Home sync", () => scenario(`
  expect((await toggle('pi', true)).status).toBe(200);
  expect(piRouted()).toBe(true);
  const { materializeLocalRouteIntent } = await import('./src/client/route-intent-apply');
  let projected, release;
  const reached = new Promise(resolve => { projected = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  let first = true;
  const sync = syncHomeRouteTo(loadConfig(), 'test', false, undefined, undefined, {
    loadModels: async () => [],
    materialize: async (...args) => {
      if (first) { first = false; projected(); await barrier; }
      return materializeLocalRouteIntent(...args);
    },
  });
  await reached;
  const disable = await toggle('pi', false);
  expect([200, 409]).toContain(disable.status);
  release();
  await sync;
  if (disable.status === 409) expect((await toggle('pi', false)).status).toBe(200);
  expect(readRouteIntentState().devices.home?.pi).toEqual({ enabled: false });
  expect(piRouted()).toBe(false);
`), SPAWN_BUDGET_MS);

test("identical dashboard requests join while a conflicting request is refused during Home apply", () => scenario(`
  mkdirSync(INTEGRATION_CLIENTS.dsh.detectDir({}, process.env.HOME), { recursive: true });
  expect((await toggle('dsh', true)).status).toBe(200);
  const { setIntegrationMutationFlightTestHooks } = await import('./src/server/management/integration-routes');
  const { writeFile, rm } = await import('node:fs/promises');
  let entered, release, writes = 0;
  const reached = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  setIntegrationMutationFlightTestHooks({ lockSeams: {
    writeFile: async (path, payload, options) => {
      await writeFile(path, payload, options);
      if (++writes === 1) { entered(); await barrier; }
    },
    removeFile: path => rm(path, { force: true }), now: Date.now,
    delay: async () => { throw new Error('unexpected writer contention'); }, pid: process.pid,
  } });
  try {
    const first = toggle('dsh', false);
    expect(await Promise.race([reached.then(() => 'entered'), first.then(() => 'finished')])).toBe('entered');
    const joined = toggle('dsh', false);
    const conflicting = await toggle('dsh', true);
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.code).toBe('integration_mutation_busy');
    release();
    const [a, b] = await Promise.all([first, joined]);
    expect(a.status).toBe(200);
    expect(b).toEqual(a);
    expect(store.listOperations('dsh')).toHaveLength(2);
    expect(readRouteIntentState().devices.home?.dsh).toEqual({ enabled: false });
    expect(store.readRecords().dsh).toBeUndefined();
  } finally { release(); setIntegrationMutationFlightTestHooks(null); }
`), SPAWN_BUDGET_MS);

test("large Aside profile mutations respect the Home apply lock and record the decision", () => scenario(`
  const id = 1000000000;
  mkdirSync(join(asideRoot, 'u', String(id)), { recursive: true });
  writeFileSync(join(asideRoot, 'u', String(id), 'models.json'), JSON.stringify({ preferences: { userId: 'large-user' }, providers: {} }));
  writeFileSync(join(asideRoot, 'accounts.json'), JSON.stringify({ currentAccountId: id, accounts: [{ id, userId: 'large-user' }] }));
  setRouteClientIntent('pi', { enabled: false }, 'home');
  const path = '/api/client-integrations/aside/profiles/' + id;
  const blocked = await withLinkApply(() => management(handleIntegrationRoutes, 'PUT', path, { enabled: true }));
  expect(blocked.status).toBe(409);
  const enabled = await management(handleIntegrationRoutes, 'PUT', path, { enabled: true });
  expect(enabled.status).toBe(200);
  expect(readRouteIntentState().devices.home.aside).toEqual({ enabled: true, accounts: ['large-user'] });
  const blockedRestore = await withLinkApply(() => management(handleIntegrationRoutes, 'POST', path + '/restore', { opId: enabled.body.opId }));
  expect(blockedRestore.status).toBe(409);
  const restored = await management(handleIntegrationRoutes, 'POST', path + '/restore', { opId: enabled.body.opId });
  expect(restored.status).toBe(200);
  expect(readRouteIntentState().devices.home.aside).toEqual({ enabled: false, accounts: ['large-user'] });
`), SPAWN_BUDGET_MS);

test("a refused Home toggle leaves model discovery settings untouched", () => scenario(`
  const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'new-model' }] }) });
  const config = loadConfig();
  config.providers.fixture.baseUrl = new URL('/v1', upstream.url).href;
  config.providers.fixture.liveModels = true;
  config.modelDiscovery = { newModelPolicy: 'off', knownModels: { fixture: { ids: ['fixture-model'], removed: [], updatedAt: '2026-01-01T00:00:00Z' } } };
  saveConfig(config);
  const configPath = join(process.env.OPENCODEX_HOME, 'config.json');
  const before = readFileSync(configPath, 'utf8');
  writeFileSync(routeIntentStatePath(), '{broken');
  const result = await toggle('pi', true);
  expect(result.body.code).toBe('route_intent_unavailable');
  expect(readFileSync(configPath, 'utf8')).toBe(before);
  const { loadExportModels } = await import('./src/server/management/model-rows');
  await loadExportModels(loadConfig());
  expect(readFileSync(configPath, 'utf8')).not.toBe(before);
  upstream.stop(true);
`), SPAWN_BUDGET_MS);

test("a refused Home restore leaves model discovery settings untouched", () => scenario(`
  const applied = await toggle('pi', true);
  expect(applied.status).toBe(200);
  const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'new-model' }] }) });
  const config = loadConfig();
  config.providers.fixture.baseUrl = new URL('/v1', upstream.url).href;
  config.providers.fixture.liveModels = true;
  config.modelDiscovery = { newModelPolicy: 'off', knownModels: { fixture: { ids: ['fixture-model'], removed: [], updatedAt: '2026-01-01T00:00:00Z' } } };
  saveConfig(config);
  const configPath = join(process.env.OPENCODEX_HOME, 'config.json');
  const before = readFileSync(configPath, 'utf8');
  writeFileSync(routeIntentStatePath(), '{broken');
  const result = await management(handleIntegrationRoutes, 'POST', '/api/client-integrations/restore', { opId: applied.body.opId });
  expect(result.body.code).toBe('route_intent_unavailable');
  expect(readFileSync(configPath, 'utf8')).toBe(before);
  const { loadExportModels } = await import('./src/server/management/model-rows');
  await loadExportModels(loadConfig());
  expect(readFileSync(configPath, 'utf8')).not.toBe(before);
  upstream.stop(true);
`), SPAWN_BUDGET_MS);

test("the CLI accepts an unresolved Aside row and prints the warning without failing the sync", async () => {
  const body = { schema: "ocx.route-to/1", warnings: ["Aside was left unchanged on this Home; decide it with ocx route to aside on|off --device home."],
    devices: [{ id: "home", alias: "home", clients: ROUTE_CLIENT_IDS.map(client => client === "aside"
      ? { client, intent: "unresolved", source: "default", applied: null }
      : { client, intent: "on", source: "default", applied: "current" }) }] };
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await handleRouteToCommand(["sync"], {
      readChildContext: () => null,
      findLiveProxy: async () => ({ hostname: "127.0.0.1", port: 10100, pid: 1, source: "runtime" }),
      fetchImpl: (async () => Response.json(body)) as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    expect(out.mock.calls.flat().join("\n")).toContain("aside  unresolved");
    expect(err.mock.calls.flat().join("\n")).toContain("ocx route to aside on|off --device home");
    // Only Aside can be unresolved.
    const piUnresolved = structuredClone(body);
    piUnresolved.devices[0]!.clients[ROUTE_CLIENT_IDS.indexOf("pi")] = { client: "pi", intent: "unresolved", source: "default", applied: null };
    expect(await handleRouteToCommand(["sync"], { readChildContext: () => null,
      findLiveProxy: async () => ({ hostname: "127.0.0.1", port: 10100, pid: 1, source: "runtime" }),
      fetchImpl: (async () => Response.json(piUnresolved)) as unknown as typeof fetch })).not.toBe(0);
  } finally { out.mockRestore(); err.mockRestore(); }
});
