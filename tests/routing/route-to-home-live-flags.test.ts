import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/** Captured defaults drive Children; the Home's own native switches stay authoritative for the Home. */
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
      import { readHomeRouteIntentState } from './src/routing/home-route-intent';
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
