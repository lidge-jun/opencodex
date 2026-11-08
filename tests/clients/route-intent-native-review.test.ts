import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

function scenario(body: string) {
  const home = mkdtempSync(join(tmpdir(), "ocx-native-review-"));
  for (const dir of [".codex", ".claude", "desktop"]) mkdirSync(join(home, dir));
  try {
    const child = spawnSync(process.execPath, ["--eval", `
      import { expect, spyOn } from 'bun:test';
      import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
      import { join } from 'node:path';
      import { getDefaultConfig, saveConfig, loadConfig, getConfigDir } from './src/config';
      import { materializeLocalRouteIntent } from './src/client/route-intent-apply';
      import { ROUTE_CLIENT_IDS } from './src/link/route-intent';
      import { serviceApiTokenFingerprint, writeServiceApiTokenFile, replaceServiceApiTokenFile } from './src/lib/service-secrets';
      import { withClientLifecycleSync } from './src/client/lifecycle-lock';
      import * as desktop from './src/claude/desktop-3p';
      import { applyRemoteDesktopStore, inspectRemoteDesktopStore } from './src/claude/desktop-remote-store';
      import { allowCodexProviderRouting, previewCodexProviderConsent } from './src/codex/provider-routing';
      const root = process.env.HOME;
      const library = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
      const configPath = join(process.env.CODEX_HOME, 'config.toml');
      const token = 'ocx_data_native_review_fixture';
      const owner = { serverUrl:'http://127.0.0.1:22001', apiKeyId:'fixture-key', connectedAt:'2026-11-07T00:00:00.000Z' };
      const models = [{namespaced:'fixture/claude-sonnet-4-6',provider:'fixture',id:'claude-sonnet-4-6'}];
      const lockDeps = {lockPath:join(root,'lifecycle.sqlite')};
      const local = getDefaultConfig(); local.port=18274; local.hostname='127.0.0.1';
      local.defaultProvider='fixture';local.providers={fixture:{adapter:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',allowPrivateNetwork:true,liveModels:false,models:['fixture-model']}};
      saveConfig(local);
      expect(loadConfig().port).toBe(18274);
      writeFileSync(join(library,'_meta.json'),JSON.stringify({entries:[],custom:'keep'}));
      const document = enabled => ({version:1,home:{name:'fixture',version:'1'},
        clients:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,{enabled:id==='claude-desktop'&&enabled}])),
        sources:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,'default']))});
      async function reconcile(enabled=true, options={}) {
        const receipt=await materializeLocalRouteIntent(loadConfig(),document(enabled),models,
          {onlyClients:['claude-desktop'], lifecycleLockDeps:lockDeps,...options});
        return receipt.outcomes.find(row=>row.client==='claude-desktop');
      }
      function connect() {
        const c=loadConfig();c.runtimeRole='client';c.client={...owner,transport:'link',link:{tunnelPort:22001,linkId:'lnk_0123456789abcdef'},
          managementUrl:owner.serverUrl,managementTransport:'direct',selectedClients:['claude-desktop'],tokenEnv:'OPENCODEX_API_AUTH_TOKEN',
          tokenFingerprint:serviceApiTokenFingerprint(token),protocolVersion:1};saveConfig(c);writeServiceApiTokenFile(token);
      }
      const selected = () => {
        const meta=JSON.parse(readFileSync(join(library,'_meta.json'),'utf8'));
        return meta.appliedId ? {path:join(library,meta.appliedId+'.json'),value:JSON.parse(readFileSync(join(library,meta.appliedId+'.json'),'utf8'))}:null;
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

test("Desktop off refuses first-party routing without changing its intent or files", () => scenario(`
  const c=loadConfig(); delete c.clientIntegrations;
  c.claudeCode={...c.claudeCode,desktopMode:'first-party'};saveConfig(c);
  const before=readFileSync(join(library,'_meta.json'),'utf8');
  const result=await reconcile(false);
  expect(result.outcome).toBe('conflict');
  expect(result.message).toContain('ocx integrations native claude-desktop off');
  expect(loadConfig().clientIntegrations?.['claude-desktop']).toBeUndefined();
  expect(loadConfig().claudeCode.desktopMode).toBe('first-party');
  expect(readFileSync(join(library,'_meta.json'),'utf8')).toBe(before);
`), SPAWN_BUDGET_MS);

test("unrelated Home routing change preserves default-on Grok and first-party Desktop", () => scenario(`
  const {injectGrokConfig}=await import('./src/grok/inject');
  const {syncHomeRouteTo}=await import('./src/routing/route-to-local');
  const {initializeHomeRouteIntentDefaults,readHomeRouteIntentState}=await import('./src/routing/home-route-intent');
  const {setRouteClientIntent}=await import('./src/routing/route-intent-state');
  const {projectHomeRouteIntent}=await import('./src/link/route-intent');
  const current=loadConfig(); delete current.clientIntegrations;
  current.claudeCode={...current.claudeCode,desktopMode:'first-party'}; saveConfig(current);
  mkdirSync(process.env.GROK_HOME,{recursive:true});
  expect(injectGrokConfig(18274,[{id:'fixture/old'}],{grokHome:process.env.GROK_HOME,hostname:'127.0.0.1'}).ok).toBe(true);
  const grokPath=join(process.env.GROK_HOME,'config.toml');
  const desktopBefore=readFileSync(join(library,'_meta.json'),'utf8');
  const localConfig=loadConfig();
  initializeHomeRouteIntentDefaults(localConfig,'1','opencode');
  setRouteClientIntent('opencode',{enabled:true});
  const outcomes=await syncHomeRouteTo(localConfig,'1',false,undefined,undefined,{
    loadModels:async()=>models,
    materialize:async (config,doc,rows,opts)=>materializeLocalRouteIntent(config,doc,rows,{
      ...opts, onlyClients: opts.onlyClients ? opts.onlyClients.filter(x=>x==='grok'||x==='claude-desktop') : ['grok','claude-desktop'],
      lifecycleLockDeps:lockDeps,
    }),
  });
  expect(readFileSync(grokPath,'utf8')).toContain('opencodex');
  expect(readFileSync(join(library,'_meta.json'),'utf8')).toBe(desktopBefore);
  expect(loadConfig().claudeCode.desktopMode).toBe('first-party');
  expect(loadConfig().clientIntegrations?.grok).toBeUndefined();
  expect(loadConfig().clientIntegrations?.['claude-desktop']).toBeUndefined();
  const child=projectHomeRouteIntent(localConfig,'1','lnk_0123456789abcdef',readHomeRouteIntentState(localConfig));
  expect(child.clients.grok.enabled).toBe(false);
  expect(child.clients['claude-desktop'].enabled).toBe(false);
  // First-party Desktop already routes through OpenCodex: enabled intent is satisfied, so Home sync stays green.
  expect(outcomes.find(row=>row.client==='claude-desktop').outcome).toBe('current');
`), SPAWN_BUDGET_MS);

for (const evidence of ["marker", "settings"]) {
  test(`connected Desktop inherited enable preserves first-party ${evidence}`, () => scenario(`
    connect();
    const c=loadConfig();
    if (${JSON.stringify(evidence)}==='marker') {c.claudeCode={...c.claudeCode,desktopMode:'first-party'};saveConfig(c);}
    else writeFileSync(join(root,'.claude','settings.json'),JSON.stringify({env:{HTTPS_PROXY:'http://127.0.0.1:18275',NODE_EXTRA_CA_CERTS:join(getConfigDir(),'claude-intercept','ca.pem')}}));
    const before=readFileSync(join(library,'_meta.json'),'utf8');
    const settingsPath=join(root,'.claude','settings.json');
    const settings=existsSync(settingsPath)?readFileSync(settingsPath,'utf8'):null;
    expect((await reconcile()).outcome).toBe('current');
    expect((await reconcile(true,{overwriteConflict:true,overwriteClient:'claude-desktop'})).outcome).toBe('current');
    const off=await reconcile(false);
    expect(off.outcome).toBe('conflict');
    expect(off.message).toContain('ocx claude desktop apply --gateway');
    expect(readFileSync(join(library,'_meta.json'),'utf8')).toBe(before);
    if(settings!==null)expect(readFileSync(settingsPath,'utf8')).toBe(settings);
    expect(existsSync(join(getConfigDir(),'desktop-remote','state.json'))).toBe(false);
  `), SPAWN_BUDGET_MS);
}

test("connected Desktop off restores the remote-owned loopback profile without a standalone fingerprint", () => scenario(`
  connect();expect((await reconcile()).outcome).toBe('current');
  expect(selected().value.inferenceGatewayBaseUrl).toBe('http://127.0.0.1:18274');
  expect(loadConfig().claudeCode?.desktopProfile?.appliedFingerprint).toBeUndefined();
  expect((await reconcile(false)).outcome).toBe('current');
  expect(selected()?.value.inferenceProvider).not.toBe('gateway');
`), SPAWN_BUDGET_MS);

test("connected Desktop off refuses a drifted remote projection", () => scenario(`
  connect();expect((await reconcile()).outcome).toBe('current');
  const file=selected();file.value.inferenceGatewayBaseUrl='https://edited.example.test';writeFileSync(file.path,JSON.stringify(file.value));
  const before=readFileSync(file.path,'utf8');
  expect((await reconcile(false)).outcome).toBe('conflict');
  expect(readFileSync(file.path,'utf8')).toBe(before);
`), SPAWN_BUDGET_MS);

test("Desktop explicit overwrite snapshots edited owned fields and consent is operation scoped", () => scenario(`
  connect();expect((await reconcile()).outcome).toBe('current');
  const file=selected();file.value.inferenceGatewayBaseUrl='https://edited.example.test';file.value.unrelated='keep';
  writeFileSync(file.path,JSON.stringify(file.value));
  expect((await reconcile()).outcome).toBe('conflict');
  expect((await reconcile(true,{overwriteConflict:true,overwriteClient:'pi'})).outcome).toBe('conflict');
  expect((await reconcile(true,{overwriteConflict:true,overwriteClient:'claude-desktop'})).outcome).toBe('current');
  expect(selected().value.inferenceGatewayBaseUrl).toBe('http://127.0.0.1:18274');
  expect(selected().value.unrelated).toBe('keep');
  const snapshots=join(getConfigDir(),'desktop-remote','overwrites');
  expect(readdirSync(snapshots).map(name=>JSON.parse(readFileSync(join(snapshots,name),'utf8')))).toContainEqual(file.value);
  const snapshotCount=readdirSync(snapshots).length;
  writeFileSync(file.path,JSON.stringify(file.value));
  expect((await reconcile(true,{overwriteConflict:true,overwriteClient:'claude-desktop'})).outcome).toBe('current');
  expect(readdirSync(snapshots)).toHaveLength(snapshotCount);
  file.value.inferenceGatewayBaseUrl='https://edited-again.example.test';writeFileSync(file.path,JSON.stringify(file.value));
  expect((await reconcile()).outcome).toBe('conflict');
`), SPAWN_BUDGET_MS);

for (const obstruction of ["renamed", "unselected", "pending", "snapshot", "token", "owner"]) {
  test(`Desktop overwrite retains safety checks: ${obstruction}`, () => scenario(`
    connect();expect((await reconcile()).outcome).toBe('current');
    const file=selected();file.value.inferenceGatewayBaseUrl='https://edited.example.test';writeFileSync(file.path,JSON.stringify(file.value));
    const store=join(getConfigDir(),'desktop-remote');
    const metaPath=join(library,'_meta.json'), statePath=join(store,'state.json');
    const meta=JSON.parse(readFileSync(metaPath,'utf8'));
    if(${JSON.stringify(obstruction)}==='renamed'){meta.entries[0].name='foreign';writeFileSync(metaPath,JSON.stringify(meta));}
    if(${JSON.stringify(obstruction)}==='unselected'){delete meta.appliedId;writeFileSync(metaPath,JSON.stringify(meta));}
    if(${JSON.stringify(obstruction)}==='pending'){
      const state=JSON.parse(readFileSync(statePath,'utf8'));
      state.pending={kind:'rotate',before:state.lastProjectionHash,after:state.lastProjectionHash,
        beforeSelection:meta.appliedId,afterSelection:meta.appliedId,tokenFingerprint:state.tokenFingerprint};
      writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
    }
    if(${JSON.stringify(obstruction)}==='snapshot'){
      mkdirSync(join(root,'foreign-snapshots'));symlinkSync(join(root,'foreign-snapshots'),join(store,'overwrites'));
    }
    if(${JSON.stringify(obstruction)}==='token')replaceServiceApiTokenFile('ocx_data_changed_fixture');
    const before=readFileSync(file.path,'utf8');
    const result=withClientLifecycleSync(held=>applyRemoteDesktopStore(held,{
      owner:${JSON.stringify(obstruction)}==='owner'?{...owner,apiKeyId:'foreign-key'}:owner,
      expectedTokenFingerprint:serviceApiTokenFingerprint(token),baseUrl:'http://127.0.0.1:18274',apiKey:'opencodex-loopback',
      mode:'static',models:[{name:'claude-sonnet-4-6-20260217',labelOverride:'Fixture',anthropicFamilyTier:'sonnet'}],
      localListener:true,overwriteConflict:true}),lockDeps);
    expect(result).toMatchObject({ok:false,reason:${JSON.stringify(obstruction)}==='snapshot'?'unsafe':'conflict'});
    expect(readFileSync(file.path,'utf8')).toBe(before);
    if(${JSON.stringify(obstruction)}==='snapshot')expect(readdirSync(join(root,'foreign-snapshots'))).toEqual([]);
  `), SPAWN_BUDGET_MS);
}

test("Home gateway file and marker stay inside the existing picker transition", () => scenario(`
  const runtime=await import('./src/claude/intercept/runtime');
  let inside=false,transitions=0;
  spyOn(runtime,'getClaudePickerController').mockReturnValue({transition:async work=>{
    transitions++;inside=true;
    try {const row=await work({});expect(loadConfig().claudeCode.desktopMode).toBe('gateway');return row;}
    finally{inside=false;}
  }});
  const writer=desktop.writeDesktop3pConfig;
  spyOn(desktop,'writeDesktop3pConfig').mockImplementation((...args)=>{
    expect(inside).toBe(true);
    expect(()=>withClientLifecycleSync(()=>{},lockDeps)).toThrow('client_lifecycle_busy');
    return writer(...args);
  });
  expect((await reconcile()).outcome).toBe('current');expect(transitions).toBe(1);
  expect(loadConfig().claudeCode.desktopProfile.appliedFingerprint).toBeDefined();
`), SPAWN_BUDGET_MS);

test("Home gateway writer refusal leaves the mode and fingerprint unchanged", () => scenario(`
  const before=loadConfig().claudeCode;
  spyOn(desktop,'writeDesktop3pConfig').mockReturnValue({written:false,path:library,reason:'fixture_refusal'});
  const row=await reconcile();expect(row.outcome).toBe('failed');expect(row.message).toBe('fixture_refusal');
  expect(loadConfig().claudeCode).toEqual(before);expect(selected()).toBeNull();
`), SPAWN_BUDGET_MS);

test("Desktop writer refuses forged and expired lifecycle leases", () => scenario(`
  const expired=withClientLifecycleSync(held=>held,lockDeps);
  for(const held of [{},expired]){
    const result=desktop.writeDesktop3pConfig(18274,[],[{provider:'fixture',id:'claude-sonnet-4-6'}],
      undefined,'static',undefined,undefined,lockDeps,undefined,held);
    expect(result.written).toBe(false);expect(result.reason).toBe('desktop_lifecycle_busy_or_unsafe');
    expect(selected()).toBeNull();
  }
`), SPAWN_BUDGET_MS);

test("gateway marker admission refuses a newer first-party mode inside its config transaction", () => scenario(`
  const {persistCommittedDesktopGateway}=await import('./src/claude/desktop-gateway-state');
  const {observeClaudeDesktopMode,resolveClaudeDesktopMode}=await import('./src/claude/desktop-first-party');
  const stale=loadConfig();
  const latest=loadConfig();latest.claudeCode={...latest.claudeCode,desktopMode:'first-party'};saveConfig(latest);
  const result=persistCommittedDesktopGateway(stale,stale.claudeCode?.desktopProfile,'fixture-fingerprint',
    current=>resolveClaudeDesktopMode(current,observeClaudeDesktopMode(current))!=='first-party');
  expect(result).toEqual({ok:false,reason:'conflict'});
  expect(loadConfig().claudeCode.desktopMode).toBe('first-party');
  expect(loadConfig().claudeCode.desktopProfile?.appliedFingerprint).toBeUndefined();
`), SPAWN_BUDGET_MS);

for (const approved of [false, true]) {
  test(`Codex external provider routing approval is respected: ${approved}`, () => scenario(`
    const source='model_provider = "external"\\n[model_providers.external]\\nname = "Fixture"\\nbase_url = "https://api.example.test/v1"\\nwire_api = "responses"\\nrequires_openai_auth = true\\nsupports_websockets = true\\n';
    writeFileSync(configPath,source);
    if(${approved})allowCodexProviderRouting('external',previewCodexProviderConsent('external'));
    const doc=document(false);doc.clients.codex.enabled=true;
    const result=await materializeLocalRouteIntent(loadConfig(),doc,models,{onlyClients:['codex'],lifecycleLockDeps:lockDeps});
    expect(result.outcomes.find(row=>row.client==='codex').outcome).toBe(${approved}?'current':'conflict');
    const after=readFileSync(configPath,'utf8');
    if(${approved}){expect(after).toContain('http://127.0.0.1:18274/v1');expect(after).toContain('model_provider = "external"');expect(after).toContain('supports_websockets = true');}
    else expect(after).toBe(source);
  `), SPAWN_BUDGET_MS);
}

test("Home stale gateway apply rechecks first-party mode at write admission", () => scenario(`
  const c=loadConfig();c.claudeCode={...c.claudeCode,desktopMode:'gateway'};saveConfig(c);
  let inspected=false,switched=false;
  const original=desktop.inspectDesktop3pConfigLibrary;
  spyOn(desktop,'inspectDesktop3pConfigLibrary').mockImplementation((...args)=>{inspected=true;return original(...args)});
  const row=await reconcile(true,{beforeWrite:()=>{
    if(inspected&&!switched){switched=true;const c=loadConfig();c.claudeCode={...c.claudeCode,desktopMode:'first-party'};saveConfig(c);}
  }});
  // The admission recheck sees first-party: enabled intent is satisfied without writing a gateway.
  expect(switched).toBe(true);expect(row.outcome).toBe('current');
  expect(loadConfig().claudeCode.desktopMode).toBe('first-party');
  expect(selected()?.value.inferenceProvider).not.toBe('gateway');
`), SPAWN_BUDGET_MS);
