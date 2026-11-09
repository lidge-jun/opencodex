import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

function offlineScenario(body: string) {
  const home = mkdtempSync(join(tmpdir(), "ocx-offline-mode-switch-"));
  for (const dir of [".codex", ".claude", "desktop"]) mkdirSync(join(home, dir));
  try {
    const result = spawnSync(process.execPath, ["--eval", `
      import {expect,spyOn} from 'bun:test';
      import {readFileSync,writeFileSync,existsSync} from 'node:fs';
      import {join} from 'node:path';
      import {spawnSync} from 'node:child_process';
      import {getDefaultConfig,saveConfig,loadConfig} from './src/config';
      import {materializeLocalRouteIntent} from './src/client/route-intent-apply';
      import {ROUTE_CLIENT_IDS} from './src/link/route-intent';
      import {applyDesktop} from './src/cli/claude-desktop';
      import * as desktop from './src/claude/desktop-3p';
      import {getClaudePickerController} from './src/claude/intercept/runtime';
      import {withClientLifecycle,withClientLifecycleSync} from './src/client/lifecycle-lock';
      const root=process.env.HOME, library=process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
      const lockDeps={lockPath:join(root,'lifecycle.sqlite')};
      const deps={lifecycleLockDeps:lockDeps,findLiveProxyImpl:async()=>null};
      const config=getDefaultConfig();config.port=18274;config.hostname='127.0.0.1';config.defaultProvider='fixture';
      config.providers={fixture:{adapter:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',allowPrivateNetwork:true,liveModels:false,models:['fixture-model']}};
      config.claudeCode={...config.claudeCode,desktopMode:'gateway',intercept:{enabled:true}};saveConfig(config);
      writeFileSync(join(library,'_meta.json'),JSON.stringify({entries:[]}));
      const document={version:1,home:{name:'fixture',version:'1'},
        clients:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,{enabled:id==='claude-desktop'}])),
        sources:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,'default']))};
      const models=[{namespaced:'fixture/claude-sonnet-4-6',provider:'fixture',id:'claude-sonnet-4-6'}];
      const options={onlyClients:['claude-desktop'],lifecycleLockDeps:lockDeps};
      const initial=await materializeLocalRouteIntent(loadConfig(),document,models,options);
      expect(initial.outcomes.find(row=>row.client==='claude-desktop').outcome).toBe('current');
      const selected=()=>{
        const meta=JSON.parse(readFileSync(join(library,'_meta.json'),'utf8'));
        return meta.appliedId?{path:join(library,meta.appliedId+'.json'),value:JSON.parse(readFileSync(join(library,meta.appliedId+'.json'),'utf8'))}:null;
      };
      expect(selected().value.inferenceProvider).toBe('gateway');
      expect(getClaudePickerController()).toBeNull();
      ${body}
    `], { cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
        CODEX_SQLITE_HOME: join(home, ".codex"), OPENCODEX_HOME: join(home, ".opencodex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"), GROK_HOME: join(home, ".grok"), XDG_CONFIG_HOME: join(home, ".config"),
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"), OCX_TEST_HOME_GUARD: "1" } });
    expect({ status: result.status, stderr: result.stderr, error: result.error?.message }).toMatchObject({ status: 0 });
  } finally { removeTreeWithRetry(home); }
}

test("offline CLI first-party switch excludes a separate-process materializer after gateway removal", () => offlineScenario(`
  let contender,removed=false;
  const remove=desktop.removeDesktop3pStandardPivot;
  spyOn(desktop,'removeDesktop3pStandardPivot').mockImplementation(options=>{
    const result=remove({...options,lifecycleLockDeps:lockDeps});
    expect(result.ok).toBe(true);removed=true;
    expect(selected()?.value.inferenceProvider).not.toBe('gateway');
    // Real competing materialization in another process: this is exactly the former
    // await gap between the remover's return and saveDesktopMode's admission.
    const code=
      "import {loadConfig} from './src/config';"+
      "import {materializeLocalRouteIntent} from './src/client/route-intent-apply';"+
      "try { const result=await materializeLocalRouteIntent(loadConfig(),"+JSON.stringify(document)+","+JSON.stringify(models)+","+JSON.stringify({...options,onlyClients:['claude-desktop'],lifecycleLockDeps:lockDeps})+");console.log(JSON.stringify({row:result.outcomes.find(row=>row.client==='claude-desktop')})); }"+
      "catch(error){console.log(JSON.stringify({error:error.message}));}";
    const child=spawnSync(process.execPath,['--eval',code],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:10000});
    expect({status:child.status,stderr:child.stderr}).toMatchObject({status:0});
    contender=JSON.parse(child.stdout.trim().split('\\n').at(-1));
    return result;
  });
  const applied=await applyDesktop(undefined,{kind:'first-party'},deps);
  expect(removed).toBe(true);expect(applied.ok).toBe(true);expect(applied.warning).toBeUndefined();
  expect(loadConfig().claudeCode.desktopMode).toBe('first-party');
  expect(selected()?.value.inferenceProvider).not.toBe('gateway');
  expect(contender.error).toBe('client_lifecycle_busy');
  const settings=JSON.parse(readFileSync(join(root,'.claude','settings.json'),'utf8'));
  expect(settings.env.HTTPS_PROXY).toContain('127.0.0.1');
  const retry=await materializeLocalRouteIntent(loadConfig(),document,models,options);
  // First-party already routes Desktop: the enabled intent is current and writes no gateway.
  expect(retry.outcomes.find(row=>row.client==='claude-desktop').outcome).toBe('current');
  expect(selected()?.value.inferenceProvider).not.toBe('gateway');
`), SPAWN_BUDGET_MS);

test("offline CLI rolls back first-party settings when gateway retirement refuses", () => offlineScenario(`
  const file=selected();
  const before=readFileSync(file.path,'utf8');
  const settingsPath=join(root,'.claude','settings.json');
  writeFileSync(settingsPath,JSON.stringify({theme:'keep',env:{USER_CHOICE:'keep'}}));
  spyOn(desktop,'removeDesktop3pStandardPivot').mockReturnValue({ok:false,changed:false,kind:'unsafe',libraryPath:library,reason:'fixture_refusal'});
  const result=await applyDesktop(undefined,{kind:'first-party'},deps);
  expect(result.ok).toBe(false);expect(result.reason).toContain('gateway_profile_active');
  expect(result.applied).toBe(false);expect(result.saved).toBe(false);
  expect(readFileSync(file.path,'utf8')).toBe(before);
  expect(JSON.parse(readFileSync(settingsPath,'utf8'))).toEqual({theme:'keep',env:{USER_CHOICE:'keep'}});
  expect(loadConfig().claudeCode.desktopMode).toBe('gateway');
  expect(withClientLifecycleSync(()=>true,lockDeps)).toBe(true);
`), SPAWN_BUDGET_MS);

test("offline CLI retains first-party mode after a completed pivot with incomplete cleanup", () => offlineScenario(`
  const remove=desktop.removeDesktop3pStandardPivot;
  spyOn(desktop,'removeDesktop3pStandardPivot').mockImplementation(options=>remove({...options,unlink:()=>{throw new Error('fixture_unlink_failure')}}));
  const result=await applyDesktop(undefined,{kind:'first-party'},deps);
  expect(result).toMatchObject({ok:false,reason:'gateway_cleanup_incomplete',applied:true,saved:true});
  expect(loadConfig().claudeCode.desktopMode).toBe('first-party');
  expect(selected()?.value.inferenceProvider).not.toBe('gateway');
  expect(JSON.parse(readFileSync(join(root,'.claude','settings.json'),'utf8')).env.HTTPS_PROXY).toContain('127.0.0.1');
  expect(withClientLifecycleSync(()=>true,lockDeps)).toBe(true);
`), SPAWN_BUDGET_MS);

test("offline CLI reports an incomplete conditional rollback and preserves a newer user env", () => offlineScenario(`
  const before=readFileSync(selected().path,'utf8');
  const settingsPath=join(root,'.claude','settings.json');
  spyOn(desktop,'removeDesktop3pStandardPivot').mockImplementation(()=>{
    writeFileSync(settingsPath,JSON.stringify({env:{HTTPS_PROXY:'http://new-user.example.test:3128'},theme:'new-choice'}));
    return {ok:false,changed:false,kind:'unsafe',libraryPath:library,reason:'fixture_refusal'};
  });
  const result=await applyDesktop(undefined,{kind:'first-party'},deps);
  expect(result.ok).toBe(false);expect(result.warning).toContain('rollback did not complete');
  expect(readFileSync(selected().path,'utf8')).toBe(before);
  expect(JSON.parse(readFileSync(settingsPath,'utf8'))).toEqual({env:{HTTPS_PROXY:'http://new-user.example.test:3128'},theme:'new-choice'});
  expect(loadConfig().claudeCode.desktopMode).toBe('gateway');
`), SPAWN_BUDGET_MS);

test("offline CLI preserves foreign first-party settings and releases its lease on refusal", () => offlineScenario(`
  const before=readFileSync(selected().path,'utf8');
  const settingsPath=join(root,'.claude','settings.json');
  const settings=JSON.stringify({env:{HTTPS_PROXY:'http://foreign.example.test:3128'},theme:'keep'});
  writeFileSync(settingsPath,settings);
  const result=await applyDesktop(undefined,{kind:'first-party'},deps);
  expect(result).toMatchObject({ok:false,reason:'foreign_env',applied:false});
  expect(readFileSync(settingsPath,'utf8')).toBe(settings);
  expect(readFileSync(selected().path,'utf8')).toBe(before);
  expect(loadConfig().claudeCode.desktopMode).toBe('gateway');
  expect(withClientLifecycleSync(()=>true,lockDeps)).toBe(true);
`), SPAWN_BUDGET_MS);

test("offline CLI cannot begin a mode switch while another lifecycle lease is active", () => offlineScenario(`
  const before=readFileSync(selected().path,'utf8');
  const result=await withClientLifecycle(()=>applyDesktop(undefined,{kind:'first-party'},deps),lockDeps);
  expect(result).toMatchObject({ok:false,reason:'client_lifecycle_busy'});
  expect(readFileSync(selected().path,'utf8')).toBe(before);
  expect(existsSync(join(root,'.claude','settings.json'))).toBe(false);
  expect(loadConfig().claudeCode.desktopMode).toBe('gateway');
`), SPAWN_BUDGET_MS);

test("Desktop remover refuses forged and expired lifecycle leases", () => offlineScenario(`
  const before=readFileSync(selected().path,'utf8');
  const expired=withClientLifecycleSync(held=>held,lockDeps);
  for(const held of [{},expired]){
    const result=desktop.removeDesktop3pStandardPivot({replaceWhileEnabled:true,lifecycleLockDeps:lockDeps,lifecycleHeld:held,
      appliedFingerprint:loadConfig().claudeCode.desktopProfile.appliedFingerprint});
    expect(result).toMatchObject({ok:false,changed:false,kind:'write_failed'});
    expect(readFileSync(selected().path,'utf8')).toBe(before);
  }
`), SPAWN_BUDGET_MS);
