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

test("the first Child read saves the defaults it projects", () => scenario(`
  expect((await childIntent()).codex).toEqual({ enabled: true });
  expect(readRouteIntentState().defaults).toMatchObject({ codex: { enabled: true }, claude: { enabled: true },
    grok: { enabled: false }, 'claude-desktop': { enabled: false } });
  expect(setIntegrationEnabled('codex', false).ok).toBe(true);
  expect((await childIntent()).codex).toEqual({ enabled: true });
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
