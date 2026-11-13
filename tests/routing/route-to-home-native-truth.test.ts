import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * A Home write reports what it saved: a Home native decision is its switch, so a refused apply
 * after the switch moved still says the switch was saved. A Home with no link keeps route intent
 * untouched by native toggles and --device home native writes, and a dashboard file toggle on a
 * Home that uses route intent is recorded as the Home's decision so ocx sync keeps it.
 */
function scenario(body: string, linked = false) {
  const home = mkdtempSync(join(tmpdir(), "ocx-home-native-truth-"));
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
      import { handleNativeIntegrationRoutes } from './src/server/management/native-integration-routes';
      import { handleIntegrationRoutes } from './src/server/management/integration-routes';
      import { readLinkRouteIntent } from './src/server/index/route-intent-watch';
      import { readRouteIntentState, routeIntentStatePath } from './src/routing/route-intent-state';
      import { syncHomeRouteTo } from './src/routing/route-to-local';
      import { setPersistedConfigMutationBeforeCommitForTests } from './src/config/persisted-mutation';
      import { applyIntegration } from './src/integrations/writer';
      import { createIntegrationStateStore } from './src/integrations/store';
      import { INTEGRATION_CLIENTS } from './src/integrations/registry';
      writeFileSync(join(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR,'_meta.json'),JSON.stringify({entries:[]}));
      const local = getDefaultConfig(); local.port=18274; local.hostname='127.0.0.1';
      local.defaultProvider='fixture';local.providers={fixture:{adapter:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',allowPrivateNetwork:true,liveModels:false,models:['fixture-model']}};
      saveConfig(local);
      writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: ${linked
        ? "[{ id: 'lnk_0123456789abcdef', alias: 'child', direction: 'client-initiated', hostKeyFingerprint: null, tunnelPort: 19200, apiKeyId: 'key-test', createdAt: '2026-11-07T00:00:00.000Z' }]"
        : "[]"} });
      const live = loadConfig();
      const management = async (handler, method, path, body) => {
        const req = new Request('http://localhost'+path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const response = await handler({ req, url: new URL(req.url), config: live, version: 'test', deps: { readRuntimePort: () => null } });
        return { status: response?.status, body: await response?.json() };
      };
      const call = (path, body) => management(handleRouteToRoutes, path.endsWith('/sync') ? 'POST' : 'PUT', path, body);
      const native = (client, enabled) => management(handleNativeIntegrationRoutes, 'PUT', '/api/native-integrations/'+client, { enabled });
      const childIntent = async () => {
        const response = await readLinkRouteIntent(new Request('http://127.0.0.1:19100'+LINK_ROUTE_INTENT_PATH), live, 'test', 'key-test');
        expect(response.status).toBe(200);
        return (await response.json()).clients;
      };
      const store = createIntegrationStateStore();
      const piPath = INTEGRATION_CLIENTS.pi.configPath({}, process.env.HOME);
      mkdirSync(INTEGRATION_CLIENTS.pi.detectDir({}, process.env.HOME), { recursive: true });
      const piRouted = () => !!store.readRecords().pi && existsSync(piPath) && readFileSync(piPath, 'utf8').includes('opencodex');
      const homeSync = async () => (await syncHomeRouteTo(loadConfig(), 'test', false, undefined, undefined, { loadModels: async () => [] }))
        .find(row => row.client === 'pi');
      ${body}
    `], { cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
        CODEX_SQLITE_HOME: join(home, ".codex"), OPENCODEX_HOME: join(home, ".opencodex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"), GROK_HOME: join(home, ".grok"), XDG_CONFIG_HOME: join(home, ".config"),
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"), OCX_TEST_HOME_GUARD: "1" } });
    expect({ status: child.status, stderr: child.stderr, error: child.error?.message }).toMatchObject({ status: 0 });
  } finally { removeTreeWithRetry(home); }
}

const orphanedGrok = `
  mkdirSync(process.env.GROK_HOME, { recursive: true });
  writeFileSync(join(process.env.GROK_HOME, 'config.toml'), '# >>> opencodex managed block — do not edit (removed by \\\`ocx stop\\\`) >>>\\n[model]\\nname = "x"\\n');
`;

test.each([false, true])("a refused Home Grok off reports the switch it saved (linked %s)", linked => scenario(`
  ${orphanedGrok}
  const result = await call('/api/route-to', { client: 'grok', action: 'off', device: 'home' });
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({ code: 'route_apply_unresolved', desiredCommitted: true });
  expect(result.body.error).toStartWith("The Home's grok switch was saved, but applying it ended in conflict");
  expect(result.body.error).toContain('incomplete');
  expect(loadConfig().clientIntegrations?.grok).toBe(false);
`, linked), SPAWN_BUDGET_MS);

test("a first-party Desktop off saves nothing and says so", () => scenario(`
  const c = loadConfig(); c.claudeCode = { ...c.claudeCode, desktopMode: 'first-party' }; saveConfig(c); Object.assign(live, loadConfig());
  const result = await call('/api/route-to', { client: 'claude-desktop', action: 'off', device: 'home' });
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({ code: 'route_apply_unresolved', desiredCommitted: false });
  expect(result.body.error).toStartWith('The Home did not apply claude-desktop (conflict)');
  expect(loadConfig().clientIntegrations?.['claude-desktop']).toBeUndefined();
`), SPAWN_BUDGET_MS);

test("a native switch write that fails saves nothing and says so", () => scenario(`
  let failing = true;
  const fail = () => { if (!failing) return; setPersistedConfigMutationBeforeCommitForTests(fail); throw new Error('config storage unavailable'); };
  setPersistedConfigMutationBeforeCommitForTests(fail);
  const result = await call('/api/route-to', { client: 'codex', action: 'off', device: 'home' });
  failing = false; setPersistedConfigMutationBeforeCommitForTests(null);
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({ code: 'route_apply_unresolved', desiredCommitted: false });
  expect(result.body.error).toStartWith('The Home did not apply codex (failed)');
  expect(loadConfig().clientIntegrations?.codex).toBeUndefined();
`), SPAWN_BUDGET_MS);

test("on a Home with no link a native toggle leaves route intent alone and ocx sync keeps a dashboard integration", () => scenario(`
  mkdirSync(process.env.GROK_HOME, { recursive: true });
  writeFileSync(join(process.env.GROK_HOME, 'config.toml'), '');
  expect((await native('grok', false)).status).toBe(200);
  expect(loadConfig().clientIntegrations?.grok).toBe(false);
  expect((await call('/api/route-to', { client: 'codex', action: 'off', device: 'home' })).status).toBe(200);
  expect(existsSync(routeIntentStatePath())).toBe(false);
  // The dashboard's file toggle writes the integration without route intent.
  expect(applyIntegration({ clientId: 'pi', config: loadConfig(), port: 18274, models: [], store, home: process.env.HOME, env: process.env }).ok).toBe(true);
  expect(piRouted()).toBe(true);
  expect((await homeSync())?.outcome).toBe('current');
  expect(piRouted()).toBe(true);
  expect(existsSync(routeIntentStatePath())).toBe(false);
  // Without route intent the dashboard toggle records nothing either.
  expect((await management(handleIntegrationRoutes, 'PUT', '/api/client-integrations/pi', { enabled: false })).status).toBe(200);
  expect(piRouted()).toBe(false);
  expect(existsSync(routeIntentStatePath())).toBe(false);
`), SPAWN_BUDGET_MS);

test("an unreadable route-intent.json never blocks a native toggle on a Home with no link", () => scenario(`
  writeFileSync(routeIntentStatePath(), '{not json');
  expect((await native('codex', false)).status).toBe(200);
  expect(loadConfig().clientIntegrations?.codex).toBe(false);
  expect(readFileSync(routeIntentStatePath(), 'utf8')).toBe('{not json');
  // A route write still needs the file and refuses with the typed refusal naming it.
  const result = await call('/api/route-to', { client: 'codex', action: 'on', device: 'home' });
  expect(result.status).toBe(500);
  expect(result.body).toMatchObject({ code: 'route_intent_unavailable', desiredCommitted: false });
  expect(result.body.error).toContain(routeIntentStatePath());
  expect(result.body.error).toContain('fix or remove');
  expect(loadConfig().clientIntegrations?.codex).toBe(false);
`), SPAWN_BUDGET_MS);

test("an unreadable route-intent.json refuses native toggles and route writes on a linked Home by name", () => scenario(`
  writeFileSync(routeIntentStatePath(), '{not json');
  const toggled = await native('codex', false);
  expect(toggled.status).toBe(500);
  expect(toggled.body).toMatchObject({ reason: 'metadata_unreadable' });
  expect(toggled.body.message).toContain(routeIntentStatePath());
  expect(toggled.body.message).toContain('fix or remove');
  expect(loadConfig().clientIntegrations?.codex).toBeUndefined();
  for (const body of [{ client: 'codex', action: 'off', device: 'home' }, { client: 'pi', action: 'off' }, { client: 'pi', action: 'off', device: 'child' }]) {
    const result = await call('/api/route-to', body);
    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ code: 'route_intent_unavailable', desiredCommitted: false });
    expect(result.body.error).toContain(routeIntentStatePath());
  }
  expect(loadConfig().clientIntegrations?.codex).toBeUndefined();
  expect(readFileSync(routeIntentStatePath(), 'utf8')).toBe('{not json');
`, true), SPAWN_BUDGET_MS);

test("a dashboard file toggle on a Home that uses route intent is the Home's decision", () => scenario(`
  // A saved default turns Pi off for the Home and its Children.
  expect((await call('/api/route-to', { client: 'pi', action: 'off' })).status).toBe(200);
  expect(readRouteIntentState().defaults.pi).toEqual({ enabled: false });
  const on = await management(handleIntegrationRoutes, 'PUT', '/api/client-integrations/pi', { enabled: true });
  expect(on.status).toBe(200);
  expect(piRouted()).toBe(true);
  expect(readRouteIntentState().devices.home?.pi).toEqual({ enabled: true });
  // ocx sync applies route intent to every client and keeps the dashboard decision.
  expect((await homeSync())?.outcome).toBe('current');
  expect(piRouted()).toBe(true);
  // Children keep the default.
  expect((await childIntent()).pi).toEqual({ enabled: false });
  const off = await management(handleIntegrationRoutes, 'PUT', '/api/client-integrations/pi', { enabled: false });
  expect(off.status).toBe(200);
  expect(readRouteIntentState().devices.home?.pi).toEqual({ enabled: false });
  expect((await homeSync())?.outcome).toBe('current');
  expect(piRouted()).toBe(false);
  // An unreadable route-intent.json refuses the toggle by name before anything changes.
  writeFileSync(routeIntentStatePath(), '{not json');
  const refused = await management(handleIntegrationRoutes, 'PUT', '/api/client-integrations/pi', { enabled: true });
  expect(refused.status).toBe(500);
  expect(refused.body.code).toBe('route_intent_unavailable');
  expect(refused.body.error).toContain(routeIntentStatePath());
  expect(refused.body.error).toContain('fix or remove');
  expect(piRouted()).toBe(false);
`, true), SPAWN_BUDGET_MS);
