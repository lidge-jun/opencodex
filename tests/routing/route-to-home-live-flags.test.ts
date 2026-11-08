import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * Captured defaults drive Children; the Home's own native switches govern the Home. A full Home
 * sync never writes them, whatever route intent or earlier native toggles recorded.
 */
function scenario(body: string) {
  const home = mkdtempSync(join(tmpdir(), "ocx-home-live-flags-"));
  for (const dir of [".codex", ".claude", "desktop"]) mkdirSync(join(home, dir));
  try {
    const child = spawnSync(process.execPath, ["--eval", `
      import { expect } from 'bun:test';
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { getDefaultConfig, saveConfig, loadConfig } from './src/config';
      import { commitClaudeCodeBlock } from './src/claude/claude-code-block';
      import { setIntegrationEnabled } from './src/codex/desired-state';
      import { handleRouteToRoutes } from './src/server/management/route-to-routes';
      import { handleNativeIntegrationRoutes } from './src/server/management/native-integration-routes';
      import { applyProtocolSettingsPatch } from './src/server/management/protocol-settings-patch';
      import { readHomeRouteIntentState } from './src/routing/home-route-intent';
      import { readRouteIntentState, setRouteClientIntent, writeRouteIntentState } from './src/routing/route-intent-state';
      const library = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
      writeFileSync(join(library,'_meta.json'),JSON.stringify({entries:[]}));
      const local = getDefaultConfig(); local.port=18274; local.hostname='127.0.0.1';
      local.defaultProvider='fixture';local.providers={fixture:{adapter:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',allowPrivateNetwork:true,liveModels:false,models:['fixture-model']}};
      saveConfig(local);
      // The server's in-memory snapshot, loaded before another process changes the switches.
      const live = loadConfig();
      const call = async (path, body) => {
        const req = new Request('http://localhost'+path, { method: path.endsWith('/sync') ? 'POST' : 'PUT',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const response = await handleRouteToRoutes({ req, url: new URL(req.url), config: live, version: 'test',
          deps: { readLinkStore: () => ({ version: 1, listenerPort: null, links: [] }) } });
        return { status: response?.status, body: await response?.json() };
      };
      // The dashboard and ocx integrations native both send this request.
      const native = async (client, enabled) => {
        const req = new Request('http://localhost/api/native-integrations/'+client, { method: 'PUT',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
        const response = await handleNativeIntegrationRoutes({ req, url: new URL(req.url), config: live, version: 'test',
          deps: { readRuntimePort: () => null } });
        return { status: response?.status, body: await response?.json() };
      };
      const meta = () => JSON.parse(readFileSync(join(library,'_meta.json'),'utf8'));
      const codexConfig = () => existsSync(join(process.env.CODEX_HOME,'config.toml')) ? readFileSync(join(process.env.CODEX_HOME,'config.toml'),'utf8') : '';
      const homeRow = (body, client) => body.devices.find(row => row.id === 'home').clients.find(row => row.client === client);
      ${body}
    `], { cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
        CODEX_SQLITE_HOME: join(home, ".codex"), OPENCODEX_HOME: join(home, ".opencodex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"), GROK_HOME: join(home, ".grok"), XDG_CONFIG_HOME: join(home, ".config"),
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"), OCX_TEST_HOME_GUARD: "1" } });
    expect({ status: child.status, stderr: child.stderr, error: child.error?.message }).toMatchObject({ status: 0 });
  } finally { removeTreeWithRetry(home); }
}

const restoreAndMessagesOff = `
  // The first route operation captures the Home defaults (Codex and Claude on).
  expect((await call('/api/route-to', { client: 'pi', action: 'off' })).status).toBe(200);
  expect(readHomeRouteIntentState(loadConfig()).defaults.codex).toEqual({ enabled: true });
  expect(readHomeRouteIntentState(loadConfig()).defaults.claude).toEqual({ enabled: true });
  // ocx restore turns Codex off; Messages off turns Claude Code off. Neither records route intent.
  expect(setIntegrationEnabled('codex', false).ok).toBe(true);
  const c = loadConfig(); commitClaudeCodeBlock(c, { ...c.claudeCode, enabled: false }); saveConfig(c);
  const before = codexConfig();
`;

test("an unrelated Home default write keeps ocx restore and Messages off", () => scenario(`
  ${restoreAndMessagesOff}
  const result = await call('/api/route-to', { client: 'opencode', action: 'on' });
  expect(result.status).toBe(200);
  expect(loadConfig().clientIntegrations?.codex).toBe(false);
  expect(loadConfig().claudeCode?.enabled).toBe(false);
  expect(codexConfig()).toBe(before);
  expect(codexConfig()).not.toContain('opencodex');
  expect(homeRow(result.body, 'codex').intent).toBe('off');
  // Clients the write did not decide keep their last proven outcome.
  expect(homeRow(result.body, 'pi').applied).toBe('current');
  // The captured defaults still drive Children.
  expect(readHomeRouteIntentState(loadConfig()).defaults.codex).toEqual({ enabled: true });
`), SPAWN_BUDGET_MS);

test("a full Home sync keeps ocx restore and Messages off", () => scenario(`
  ${restoreAndMessagesOff}
  const result = await call('/api/route-to/sync', { device: 'home' });
  expect(result.status).toBe(200);
  expect(loadConfig().clientIntegrations?.codex).toBe(false);
  expect(loadConfig().claudeCode?.enabled).toBe(false);
  expect(codexConfig()).not.toContain('opencodex');
`), SPAWN_BUDGET_MS);

test("a Home default write for Codex itself still applies to the Home", () => scenario(`
  ${restoreAndMessagesOff}
  expect((await call('/api/route-to', { client: 'codex', action: 'off' })).status).toBe(200);
  expect((await call('/api/route-to', { client: 'codex', action: 'on' })).status).toBe(200);
  expect(loadConfig().clientIntegrations?.codex).toBe(true);
  expect(loadConfig().claudeCode?.enabled).toBe(false);
`), SPAWN_BUDGET_MS);

const captureDefaults = `
  expect((await call('/api/route-to', { client: 'pi', action: 'off' })).status).toBe(200);
`;

test("a native Codex toggle does not pin the Home against a later ocx restore", () => scenario(`
  ${captureDefaults}
  expect((await native('codex', true)).status).toBe(200);
  // ocx restore turns the switch off without recording route intent.
  expect(setIntegrationEnabled('codex', false).ok).toBe(true);
  const result = await call('/api/route-to/sync', { device: 'home' });
  expect(result.status).toBe(200);
  expect(loadConfig().clientIntegrations?.codex).toBe(false);
  expect(codexConfig()).not.toContain('opencodex');
  expect(homeRow(result.body, 'codex')).toMatchObject({ intent: 'off', source: 'native' });
  expect(readRouteIntentState().devices.home).toBeUndefined();
`), SPAWN_BUDGET_MS);

test("ocx restore back after a Codex default off keeps Codex on through a full Home sync", () => scenario(`
  expect((await call('/api/route-to', { client: 'codex', action: 'off' })).status).toBe(200);
  expect(loadConfig().clientIntegrations?.codex).toBe(false);
  // ocx restore back stores ON as the absent key.
  expect(setIntegrationEnabled('codex', true).ok).toBe(true);
  expect(loadConfig().clientIntegrations?.codex).toBeUndefined();
  const result = await call('/api/route-to/sync', { device: 'home' });
  expect(result.status).toBe(200);
  expect(loadConfig().clientIntegrations?.codex).toBeUndefined();
  expect(homeRow(result.body, 'codex')).toMatchObject({ intent: 'on', source: 'native', applied: 'current' });
  expect(codexConfig()).toContain('opencodex');
  // Children still inherit the default the write chose.
  expect(readHomeRouteIntentState(loadConfig()).defaults.codex).toEqual({ enabled: false });
`), SPAWN_BUDGET_MS);

test("Messages off after a native Claude toggle survives a full Home sync", () => scenario(`
  ${captureDefaults}
  expect((await native('claude', true)).status).toBe(200);
  const c = loadConfig();
  expect(applyProtocolSettingsPatch(c, { messagesEnabled: false }).ok).toBe(true);
  saveConfig(c);
  const result = await call('/api/route-to/sync', { device: 'home' });
  expect(result.status).toBe(200);
  expect(loadConfig().claudeCode?.enabled).toBe(false);
  expect(loadConfig().apiSurfaces?.messages?.enabled).toBe(false);
  expect(homeRow(result.body, 'claude')).toMatchObject({ intent: 'off', source: 'native' });
`), SPAWN_BUDGET_MS);

test("ocx claude desktop apply after a captured Desktop default off keeps its profile through a full Home sync", () => scenario(`
  expect((await call('/api/route-to', { client: 'claude-desktop', action: 'off' })).status).toBe(200);
  expect(loadConfig().clientIntegrations?.['claude-desktop']).toBe(false);
  const { applyDesktop } = await import('./src/cli/claude-desktop');
  const applied = await applyDesktop(undefined, { kind: 'gateway', mode: 'static' }, { findLiveProxyImpl: async () => null });
  expect(applied.ok).toBe(true);
  expect(loadConfig().clientIntegrations?.['claude-desktop']).toBeUndefined();
  const appliedId = meta().appliedId;
  expect(typeof appliedId).toBe('string');
  const result = await call('/api/route-to/sync', { device: 'home' });
  expect(result.status).toBe(200);
  expect(meta().appliedId).toBe(appliedId);
  expect(homeRow(result.body, 'claude-desktop')).toMatchObject({ intent: 'on', source: 'native', applied: 'current' });
  expect(existsSync(join(library, appliedId + '.json'))).toBe(true);
  expect(loadConfig().claudeCode?.desktopMode).toBe('gateway');
  expect(loadConfig().clientIntegrations?.['claude-desktop']).toBeUndefined();
  expect(readHomeRouteIntentState(loadConfig()).defaults['claude-desktop']).toEqual({ enabled: false });
`), SPAWN_BUDGET_MS);

test("a first-party Home with a captured Desktop default off syncs without a conflict", () => scenario(`
  setRouteClientIntent('claude-desktop', { enabled: false });
  const c = loadConfig(); c.claudeCode = { ...c.claudeCode, desktopMode: 'first-party' }; saveConfig(c);
  const { syncHomeRouteTo } = await import('./src/routing/route-to-local');
  const outcomes = await syncHomeRouteTo(loadConfig(), 'test');
  // ocx sync exits 1 on any outcome other than current or not_installed.
  expect(outcomes.filter(row => row.outcome !== 'current' && row.outcome !== 'not_installed')).toEqual([]);
  expect(loadConfig().claudeCode?.desktopMode).toBe('first-party');
  expect(loadConfig().clientIntegrations?.['claude-desktop']).toBeUndefined();
`), SPAWN_BUDGET_MS);

test("a devices.home native entry from an earlier version no longer pins the Home", () => scenario(`
  writeRouteIntentState({ version: 1, defaults: { codex: { enabled: true }, claude: { enabled: true } },
    devices: { home: { codex: { enabled: true }, pi: { enabled: false } } } });
  expect(setIntegrationEnabled('codex', false).ok).toBe(true);
  const result = await call('/api/route-to/sync', { device: 'home' });
  expect(result.status).toBe(200);
  expect(loadConfig().clientIntegrations?.codex).toBe(false);
  expect(codexConfig()).not.toContain('opencodex');
  expect(homeRow(result.body, 'codex')).toMatchObject({ intent: 'off', source: 'native' });
  // The stale native entry is dropped; a non-native Home override is kept.
  expect(readRouteIntentState().devices.home).toEqual({ pi: { enabled: false } });
`), SPAWN_BUDGET_MS);

test("a Home-only native write applies through the switch and keeps no Home entry", () => scenario(`
  const off = await call('/api/route-to', { client: 'codex', action: 'off', device: 'home' });
  expect(off.status).toBe(200);
  expect(loadConfig().clientIntegrations?.codex).toBe(false);
  expect(homeRow(off.body, 'codex')).toMatchObject({ intent: 'off', source: 'native', applied: 'current' });
  expect(readRouteIntentState().devices.home).toBeUndefined();
  // This Home has no link, so the Home-only write captured nothing: a Child enrolled later
  // inherits the switch as it stands at enrollment.
  expect(readHomeRouteIntentState(loadConfig()).defaults.codex).toBeUndefined();
  // Home inherit sets the switch to the default Children inherit, the builtin until one is saved.
  const inherited = await call('/api/route-to', { client: 'codex', action: 'inherit', device: 'home' });
  expect(inherited.status).toBe(200);
  expect(loadConfig().clientIntegrations?.codex).not.toBe(false);
  expect(homeRow(inherited.body, 'codex')).toMatchObject({ intent: 'on', source: 'native' });
  expect(readRouteIntentState().devices.home).toBeUndefined();
`), SPAWN_BUDGET_MS);
