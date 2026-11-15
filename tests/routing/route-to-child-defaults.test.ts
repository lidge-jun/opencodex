import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * Children inherit the Home's native switches as they stood when route intent began. Home-only
 * writers (ocx restore, Messages off, the Claude toggle, Claude Desktop apply) change the Home's
 * switch and never what a linked Child projects, before or after defaults were first saved.
 */
function scenario(body: string) {
  const home = mkdtempSync(join(tmpdir(), "ocx-child-defaults-"));
  for (const dir of [".codex", ".claude", "desktop"]) mkdirSync(join(home, dir));
  try {
    const child = spawnSync(process.execPath, ["--eval", `
      import { expect } from 'bun:test';
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { getDefaultConfig, saveConfig, loadConfig } from './src/config';
      import { setIntegrationEnabled } from './src/codex/desired-state';
      import { setHomeIntegrationEnabled } from './src/routing/home-route-capture';
      import { writeLinkStore } from './src/link/store';
      import { linkStorePath } from './src/link/paths';
      import { LINK_ROUTE_INTENT_PATH } from './src/link/management-routes';
      import { handleRouteToRoutes } from './src/server/management/route-to-routes';
      import { handleRouteToCommand } from './src/cli/route-to';
      import { handleProtocolRoutes } from './src/server/management/protocol-routes';
      import { handleAgentSettingsRoutes } from './src/server/management/agent-settings-routes';
      import { readLinkRouteIntent } from './src/server/index/route-intent-watch';
      import { createLinkListenerLifecycle } from './src/server/index/link-listener';
      import { readRouteIntentState, routeIntentStatePath } from './src/routing/route-intent-state';
      import { setPersistedConfigMutationBeforeCommitForTests } from './src/config/persisted-mutation';
      import { dispatchCommand } from './src/cli/dispatch';
      writeFileSync(join(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR,'_meta.json'),JSON.stringify({entries:[]}));
      const local = getDefaultConfig(); local.port=18274; local.hostname='127.0.0.1';
      local.defaultProvider='fixture';local.providers={fixture:{adapter:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',allowPrivateNetwork:true,liveModels:false,models:['fixture-model']}};
      saveConfig(local);
      writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [{ id: 'lnk_0123456789abcdef', alias: 'child', direction: 'client-initiated',
        hostKeyFingerprint: null, tunnelPort: 19200, apiKeyId: 'key-test', createdAt: '2026-11-07T00:00:00.000Z' }] });
      const live = loadConfig();
      const management = async (handler, method, path, body) => {
        const req = new Request('http://localhost'+path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const response = await handler({ req, url: new URL(req.url), config: live, version: 'test', deps: {}, syncClaudeAgentDefsBestEffort: async () => {} });
        return { status: response?.status, body: await response?.json() };
      };
      const call = (path, body) => management(handleRouteToRoutes, path.endsWith('/sync') ? 'POST' : 'PUT', path, body);
      // What the Child reads over its link: the Home's route intent for that device.
      const childIntent = async () => {
        const response = await readLinkRouteIntent(new Request('http://127.0.0.1:19100'+LINK_ROUTE_INTENT_PATH), live, 'test', 'key-test');
        expect(response.status).toBe(200);
        return (await response.json()).clients;
      };
      // ocx route to ... as the operator runs it against this Home's management API.
      const cli = async argv => {
        const errors = [], log = console.log, error = console.error;
        console.log = () => {}; console.error = (...args) => errors.push(args.join(' '));
        try {
          const code = await handleRouteToCommand(argv, { readChildContext: () => null,
            findLiveProxy: async () => ({ hostname: '127.0.0.1', port: 18274, pid: 1, source: 'runtime' }),
            fetchImpl: async (input, init) => { const req = new Request(String(input), init);
              return await handleRouteToRoutes({ req, url: new URL(req.url), config: live, version: 'test', deps: {} }); } });
          return { code, errors: errors.join(' | ') };
        } finally { console.log = log; console.error = error; }
      };
      ${body}
    `], { cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
        CODEX_SQLITE_HOME: join(home, ".codex"), OPENCODEX_HOME: join(home, ".opencodex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"), GROK_HOME: join(home, ".grok"), XDG_CONFIG_HOME: join(home, ".config"),
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"), OCX_TEST_HOME_GUARD: "1" } });
    expect({ status: child.status, stderr: child.stderr, error: child.error?.message }).toMatchObject({ status: 0 });
  } finally { removeTreeWithRetry(home); }
}

test("ocx restore on an upgraded linked Home with no saved route intent keeps Children on Codex", () => scenario(`
  expect(existsSync(routeIntentStatePath())).toBe(false);
  // ocx restore writes the switch through this.
  expect(setHomeIntegrationEnabled('codex', false).ok).toBe(true);
  expect(loadConfig().clientIntegrations?.codex).toBe(false);
  expect((await childIntent()).codex).toEqual({ enabled: true });
  // A later initialization captures nothing from the Home-only change.
  expect((await call('/api/route-to', { client: 'pi', action: 'off' })).status).toBe(200);
  expect(readRouteIntentState().defaults.codex).toEqual({ enabled: true });
  expect((await childIntent()).codex).toEqual({ enabled: true });
`), SPAWN_BUDGET_MS);

test("Messages off on a linked Home leaves Children on Claude Code", () => scenario(`
  const patched = await management(handleProtocolRoutes, 'PATCH', '/api/protocols/settings', { messagesEnabled: false });
  expect(patched.status).toBe(200);
  expect(loadConfig().claudeCode?.enabled).toBe(false);
  expect((await childIntent()).claude).toEqual({ enabled: true });
  expect((await call('/api/route-to', { client: 'pi', action: 'off' })).status).toBe(200);
  expect(readRouteIntentState().defaults.claude).toEqual({ enabled: true });
`), SPAWN_BUDGET_MS);

test("the Claude toggle on a linked Home leaves Children on Claude Code", () => scenario(`
  const toggled = await management(handleAgentSettingsRoutes, 'PUT', '/api/claude-code', { enabled: false });
  expect(toggled.status).toBe(200);
  expect(loadConfig().claudeCode?.enabled).toBe(false);
  expect((await childIntent()).claude).toEqual({ enabled: true });
`), SPAWN_BUDGET_MS);

test("Claude Desktop on the Home never enables it on Children", () => scenario(`
  // Defaults are first saved by an unrelated route write, with Desktop unset on the Home.
  expect((await call('/api/route-to', { client: 'pi', action: 'off' })).status).toBe(200);
  const { applyDesktop } = await import('./src/cli/claude-desktop');
  expect((await applyDesktop(undefined, { kind: 'gateway', mode: 'static' }, { findLiveProxyImpl: async () => null })).ok).toBe(true);
  expect((await childIntent())['claude-desktop']).toEqual({ enabled: false });
  // Any writer that stores an explicit on for the Home's own switch.
  const c = loadConfig(); c.clientIntegrations = { ...c.clientIntegrations, 'claude-desktop': true }; saveConfig(c);
  expect((await childIntent())['claude-desktop']).toEqual({ enabled: false });
  // The Home decides Desktop for itself; it takes over the profile the CLI apply wrote above.
  const homeOn = await call('/api/route-to', { client: 'claude-desktop', action: 'on', device: 'home', overwriteConflict: true });
  expect(homeOn.body.error).toBeUndefined();
  expect(homeOn.status).toBe(200);
  expect((await call('/api/route-to', { client: 'opencode', action: 'off' })).status).toBe(200);
  expect(readRouteIntentState().defaults['claude-desktop']).toEqual({ enabled: false });
  expect((await childIntent())['claude-desktop']).toEqual({ enabled: false });
`), SPAWN_BUDGET_MS);

test("Child reads write nothing; enrollment saves the defaults they project", () => scenario(`
  const { seedRouteDeviceClients } = await import('./src/routing/home-route-intent');
  // The link route-intent read and the route-to status rows are pure reads.
  expect((await childIntent()).codex).toEqual({ enabled: true });
  const status = await management(handleRouteToRoutes, 'GET', '/api/route-to?device=all');
  expect(status.status).toBe(200);
  expect(existsSync(routeIntentStatePath())).toBe(false);
  // Enrollment seeds the new Child before its first read, freezing the switches as they stand.
  expect(setIntegrationEnabled('codex', false).ok).toBe(true);
  seedRouteDeviceClients(loadConfig(), 'test', 'lnk_0123456789abcdef', undefined, ['lnk_0123456789abcdef']);
  expect(readRouteIntentState().defaults).toMatchObject({ codex: { enabled: false }, claude: { enabled: true },
    grok: { enabled: false }, 'claude-desktop': { enabled: false } });
  expect(setIntegrationEnabled('codex', true).ok).toBe(true);
  expect((await childIntent()).codex).toEqual({ enabled: false });
`), SPAWN_BUDGET_MS);

test("the link listener saves the defaults from the Home's switches before it serves", () => scenario(`
  // Restored before this version ran: the switch at migration is what Children inherit.
  expect(setIntegrationEnabled('codex', false).ok).toBe(true);
  writeFileSync(routeIntentStatePath(), JSON.stringify({ version: 1, defaults: {}, devices: {} }));
  const seen = [];
  const lifecycle = createLinkListenerLifecycle({ warn: () => {}, serve: () => {
    seen.push(readRouteIntentState().defaults.codex);
    throw new Error('fixture listener stops here');
  } });
  lifecycle.start({ maxRequestBodySize: 1024, dispatch: async () => new Response('') });
  expect(seen).toEqual([{ enabled: false }]);
  await lifecycle.stop();
  expect(setIntegrationEnabled('codex', true).ok).toBe(true);
  expect((await childIntent()).codex).toEqual({ enabled: false });
`), SPAWN_BUDGET_MS);

const firstPartyHome = `
  const c = loadConfig(); c.claudeCode = { ...c.claudeCode, desktopMode: 'first-party' }; saveConfig(c); Object.assign(live, loadConfig());
`;

test("turning Desktop off on a first-party Home fails and names the mode switch", () => scenario(`
  ${firstPartyHome}
  for (const argv of [['claude-desktop', 'off'], ['claude-desktop', 'off', '--device', 'home']]) {
    const result = await cli(argv);
    expect(result.code).not.toBe(0);
    expect(result.errors).toContain('ocx integrations native claude-desktop off');
    const response = await call('/api/route-to', { client: 'claude-desktop', action: 'off', ...(argv.length > 2 ? { device: 'home' } : {}) });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('ocx integrations native claude-desktop off');
    expect(response.body.devices.find(row => row.id === 'home').clients.find(row => row.client === 'claude-desktop').applied).toBe('conflict');
  }
  expect(loadConfig().claudeCode?.desktopMode).toBe('first-party');
`), SPAWN_BUDGET_MS);

test("a decided Home write whose native switch write throws fails", () => scenario(`
  // Every native switch write in this apply fails; the hook disarms itself after each call.
  let failing = true;
  const fail = () => { if (!failing) return; setPersistedConfigMutationBeforeCommitForTests(fail); throw new Error('config storage unavailable'); };
  setPersistedConfigMutationBeforeCommitForTests(fail);
  const result = await cli(['codex', 'off', '--device', 'home']);
  failing = false; setPersistedConfigMutationBeforeCommitForTests(null);
  expect(result.code).not.toBe(0);
  expect(result.errors).toContain('did not apply codex (failed)');
  expect(loadConfig().clientIntegrations?.codex).toBeUndefined();
`), SPAWN_BUDGET_MS);

test("an unreadable route-intent.json refuses every Home-only switch writer with a typed refusal", () => scenario(`
  writeFileSync(routeIntentStatePath(), '{not json');
  const refused = setHomeIntegrationEnabled('codex', false);
  expect(refused).toMatchObject({ ok: false, reason: 'unavailable', retryable: false });
  expect(refused.message).toContain(routeIntentStatePath());
  expect(refused.message).toContain('fix or remove');
  expect(loadConfig().clientIntegrations?.codex).toBeUndefined();
  // ocx restore --json still prints exactly one complete envelope and exits nonzero.
  const out = [], log = console.log, error = console.error;
  console.log = (...args) => out.push(args.join(' ')); console.error = () => {};
  let code;
  try { code = await dispatchCommand({ kind: 'run', command: 'restore', args: ['restore', '--json'] }, { args: ['restore', '--json'] }); }
  finally { console.log = log; console.error = error; }
  expect(code).toBe(1);
  expect(out.length).toBe(1);
  const envelope = JSON.parse(out[0]);
  expect(envelope.success).toBe(false);
  expect(envelope.message).toContain(routeIntentStatePath());
  expect(envelope.artifacts.config.state).toBe('skipped');
  const { applyDesktop } = await import('./src/cli/claude-desktop');
  const desktop = await applyDesktop(undefined, { kind: 'gateway', mode: 'static' }, { findLiveProxyImpl: async () => null });
  expect(desktop.ok).toBe(false);
  expect(desktop.reason).toContain(routeIntentStatePath());
  const patched = await management(handleProtocolRoutes, 'PATCH', '/api/protocols/settings', { messagesEnabled: false });
  expect(patched.status).toBe(500);
  expect(patched.body.error.code).toBe('route_intent_unavailable');
  expect(patched.body.error.message).toContain(routeIntentStatePath());
  const toggled = await management(handleAgentSettingsRoutes, 'PUT', '/api/claude-code', { enabled: false });
  expect(toggled.status).toBe(500);
  expect(toggled.body.code).toBe('route_intent_unavailable');
  expect(toggled.body.error).toContain(routeIntentStatePath());
  // Nothing moved: what Children inherit after the repair is still the switches as they were.
  expect(loadConfig().clientIntegrations?.codex).toBeUndefined();
  expect(loadConfig().clientIntegrations?.['claude-desktop']).toBeUndefined();
  expect(loadConfig().claudeCode?.enabled).not.toBe(false);
  expect(live.claudeCode?.enabled).not.toBe(false);
`), SPAWN_BUDGET_MS);

test("unlinked Homes in the same end state give a later-enrolled Child the same defaults", () => scenario(`
  const { rmSync } = await import('node:fs');
  const { handleNativeIntegrationRoutes } = await import('./src/server/management/native-integration-routes');
  const { seedRouteDeviceClients } = await import('./src/routing/home-route-intent');
  const link = { id: 'lnk_0123456789abcdef', alias: 'child', direction: 'client-initiated', hostKeyFingerprint: null, tunnelPort: 19200, apiKeyId: 'key-test', createdAt: '2026-11-07T00:00:00.000Z' };
  const inherited = [];
  // Each Home-only way to turn Codex off on a Home with no link yet.
  for (const turnOff of [
    async () => expect((await management(handleNativeIntegrationRoutes, 'PUT', '/api/native-integrations/codex', { enabled: false })).status).toBe(200),
    async () => expect(setHomeIntegrationEnabled('codex', false).ok).toBe(true),
    async () => expect((await call('/api/route-to', { client: 'codex', action: 'off', device: 'home' })).status).toBe(200),
  ]) {
    writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [] });
    rmSync(routeIntentStatePath(), { force: true });
    const c = loadConfig(); c.clientIntegrations = {}; saveConfig(c); Object.assign(live, loadConfig());
    await turnOff();
    expect(loadConfig().clientIntegrations?.codex).toBe(false);
    expect(readRouteIntentState().defaults.codex).toBeUndefined();
    // Enrollment adds the link, then provisioning seeds the new Child's route intent.
    writeLinkStore(linkStorePath(), { version: 1, listenerPort: 19100, links: [link] });
    seedRouteDeviceClients(loadConfig(), 'test', link.id, undefined, [link.id]);
    inherited.push((await childIntent()).codex);
  }
  // The switches as they stood at enrollment, whichever writer moved them.
  expect(inherited).toEqual([{ enabled: false }, { enabled: false }, { enabled: false }]);
`), SPAWN_BUDGET_MS);
