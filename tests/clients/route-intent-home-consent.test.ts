import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/** A Home Desktop or Grok switch no write is deciding may refresh owned state, never create it. */
function scenario(body: string) {
  const home = mkdtempSync(join(tmpdir(), "ocx-home-consent-"));
  for (const dir of [".codex", ".claude", "desktop"]) mkdirSync(join(home, dir));
  try {
    const child = spawnSync(process.execPath, ["--eval", `
      import { expect } from 'bun:test';
      import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
      import { join } from 'node:path';
      import { getDefaultConfig, saveConfig, loadConfig } from './src/config';
      import { materializeLocalRouteIntent } from './src/client/route-intent-apply';
      import { projectHomeRouteIntent } from './src/link/route-intent';
      import { readHomeRouteIntentState } from './src/routing/home-route-intent';
      import { setRouteClientIntent } from './src/routing/route-intent-state';
      const root = process.env.HOME;
      const library = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
      const lockDeps = {lockPath:join(root,'lifecycle.sqlite')};
      const modelsA = [{namespaced:'fixture/claude-sonnet-4-6',provider:'fixture',id:'claude-sonnet-4-6'}];
      const modelsB = [...modelsA, {namespaced:'fixture/claude-opus-4-6',provider:'fixture',id:'claude-opus-4-6'}];
      const local = getDefaultConfig(); local.port=18274; local.hostname='127.0.0.1';
      local.defaultProvider='fixture';local.providers={fixture:{adapter:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',allowPrivateNetwork:true,liveModels:false,models:['fixture-model']}};
      delete local.clientIntegrations;
      saveConfig(local);
      writeFileSync(join(library,'_meta.json'),JSON.stringify({entries:[],custom:'keep'}));
      const homeDocument = (decidedClient) => projectHomeRouteIntent(loadConfig(),'1','home',readHomeRouteIntentState(loadConfig()),{decidedClient});
      async function reconcile(client, models=modelsA, document=homeDocument(), decidedClient) {
        const receipt=await materializeLocalRouteIntent(loadConfig(),document,models,{onlyClients:[client],lifecycleLockDeps:lockDeps,decidedClient});
        return receipt.outcomes.find(row=>row.client===client);
      }
      const meta = () => JSON.parse(readFileSync(join(library,'_meta.json'),'utf8'));
      ${body}
    `], { cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
        CODEX_SQLITE_HOME: join(home, ".codex"), OPENCODEX_HOME: join(home, ".opencodex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"), GROK_HOME: join(home, ".grok"), XDG_CONFIG_HOME: join(home, ".config"),
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"), OCX_TEST_HOME_GUARD: "1" } });
    expect({ status: child.status, stderr: child.stderr, error: child.error?.message }).toMatchObject({ status: 0 });
  } finally { removeTreeWithRetry(home); }
}

test("implicit Home Desktop intent never creates a gateway profile", () => scenario(`
  const document = homeDocument();
  expect(document.clients['claude-desktop'].enabled).toBe(true);
  expect(document.sources['claude-desktop']).toBe('native');
  const before = readFileSync(join(library,'_meta.json'),'utf8');
  expect((await reconcile('claude-desktop')).outcome).toBe('current');
  expect(readFileSync(join(library,'_meta.json'),'utf8')).toBe(before);
  expect(loadConfig().claudeCode?.desktopMode).toBeUndefined();
  expect(loadConfig().claudeCode?.desktopProfile?.appliedFingerprint).toBeUndefined();
  expect(loadConfig().clientIntegrations?.['claude-desktop']).toBeUndefined();
`), SPAWN_BUDGET_MS);

test("implicit Home Desktop intent refreshes an owned gateway profile", () => scenario(`
  setRouteClientIntent('claude-desktop',{enabled:true});
  expect((await reconcile('claude-desktop', modelsA, homeDocument('claude-desktop'), 'claude-desktop')).outcome).toBe('current');
  const appliedId = meta().appliedId;
  expect(typeof appliedId).toBe('string');
  expect((await reconcile('claude-desktop', modelsB)).outcome).toBe('current');
  expect(meta().appliedId).toBe(appliedId);
  expect(readFileSync(join(library, appliedId+'.json'),'utf8')).toContain('Claude Opus 4 6');
`), SPAWN_BUDGET_MS);

test("only a Home write deciding Desktop creates the gateway profile", () => scenario(`
  setRouteClientIntent('claude-desktop',{enabled:true});
  // A default alone (a sync, or a write for another client) leaves the switch's startup scope.
  expect((await reconcile('claude-desktop')).outcome).toBe('current');
  expect(meta().appliedId).toBeUndefined();
  expect((await reconcile('claude-desktop', modelsA, homeDocument('claude-desktop'), 'claude-desktop')).outcome).toBe('current');
  expect(typeof meta().appliedId).toBe('string');
  expect(loadConfig().claudeCode?.desktopMode).toBe('gateway');
`), SPAWN_BUDGET_MS);

test("implicit Home Desktop intent reports a changed owned profile as a conflict", () => scenario(`
  setRouteClientIntent('claude-desktop',{enabled:true});
  expect((await reconcile('claude-desktop', modelsA, homeDocument('claude-desktop'), 'claude-desktop')).outcome).toBe('current');
  const profile = join(library, meta().appliedId+'.json');
  const edited = JSON.parse(readFileSync(profile,'utf8')); edited.inferenceGatewayBaseUrl = 'http://127.0.0.1:1'; writeFileSync(profile, JSON.stringify(edited));
  const before = readFileSync(profile,'utf8');
  for (const overwriteConflict of [false, true]) {
    const receipt = await materializeLocalRouteIntent(loadConfig(), homeDocument(), modelsB, { onlyClients:['claude-desktop'], lifecycleLockDeps:lockDeps, overwriteConflict });
    expect(receipt.outcomes.find(row=>row.client==='claude-desktop').outcome).toBe('conflict');
  }
  expect(readFileSync(profile,'utf8')).toBe(before);
`), SPAWN_BUDGET_MS);

test("a full Home sync leaves a Desktop library OpenCodex never owned as current", () => scenario(`
  // Unset Home switch, read as on: a refresh-only row over libraries with no OpenCodex ownership.
  const uuid = '0f8b7c1e-4d3a-4b2c-9e1f-2a3b4c5d6e7f';
  for (const metadata of [JSON.stringify({ appliedId: uuid, entries: [{ id: uuid, name: 'Work' }] }), '{not json',
    JSON.stringify({ appliedId: '../escape', entries: [] })]) {
    writeFileSync(join(library,'_meta.json'), metadata);
    const receipt = await materializeLocalRouteIntent(loadConfig(), homeDocument(), modelsA, { lifecycleLockDeps:lockDeps });
    const row = receipt.outcomes.find(entry=>entry.client==='claude-desktop');
    expect(row.outcome).toBe('current');
    expect(row.message ?? '').not.toContain('--overwrite-conflict');
    expect(readFileSync(join(library,'_meta.json'),'utf8')).toBe(metadata);
    expect(existsSync(join(library, uuid+'.json'))).toBe(false);
  }
`), SPAWN_BUDGET_MS);

test("an owned Desktop profile whose file is gone stays a refresh-only conflict", () => scenario(`
  setRouteClientIntent('claude-desktop',{enabled:true});
  expect((await reconcile('claude-desktop', modelsA, homeDocument('claude-desktop'), 'claude-desktop')).outcome).toBe('current');
  rmSync(join(library, meta().appliedId+'.json'));
  expect((await reconcile('claude-desktop', modelsB)).outcome).toBe('conflict');
`), SPAWN_BUDGET_MS);

test("implicit Home Grok intent matches the startup gate on a gated hub", () => scenario(`
  const c=loadConfig(); c.runtimeRole='hub'; saveConfig(c);
  mkdirSync(process.env.GROK_HOME,{recursive:true});
  expect(homeDocument().sources.grok).toBe('native');
  expect((await reconcile('grok')).outcome).toBe('current');
  expect(existsSync(join(process.env.GROK_HOME,'config.toml'))).toBe(false);
`), SPAWN_BUDGET_MS);
