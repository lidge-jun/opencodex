import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

// Fresh modules bind every Codex path to this disposable home, including journal restoration.
function scenario(body: string, initialCodex?: boolean | "absent") {
  const home = mkdtempSync(join(tmpdir(), "ocx-route-codex-transition-"));
  mkdirSync(join(home, ".codex"));
  try {
    const child = spawnSync(process.execPath, ["--eval", `
      import './tests/helpers/windows-acl-process-stubs';
      import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
      import { join } from 'node:path';
      import { getDefaultConfig, saveConfig, loadConfig } from './src/config';
      import { connectClient, syncConnectedClient, disconnectClient } from './src/client/connect';
      import { readClientConnectionState } from './src/client/state';
      import { ROUTE_CLIENT_IDS } from './src/link/route-intent';
      import { setLocalRouteIntentOff } from './src/integrations/route-intent';
      import { acquireConfigWriteLock, releaseConfigWriteLock } from './src/codex/config-write-lock';
      import { journalOwner } from './src/codex/journal';
      import { readHomeCodexSettingsRecord } from './src/client/link-home';
      import { linkChildParityReport } from './src/client/link-parity-reporter';
      import { readRouteIntentReceipt } from './src/integrations/route-intent';
      const home = process.env.HOME;
      const configPath = join(process.env.CODEX_HOME, 'config.toml');
      const journalPath = join(process.env.CODEX_HOME, 'opencodex-journal.json');
      const piPath = join(home, '.pi', 'agent', 'models.json');
      const original = 'model = "user-model"\\n';
      writeFileSync(configPath, original);
      mkdirSync(join(home, '.pi', 'agent'), {recursive:true});
      const local = getDefaultConfig(); local.port = 18274;
      if (${initialCodex === "absent"}) { if (local.clientIntegrations) delete local.clientIntegrations.codex; }
      else if (${typeof initialCodex === "boolean"}) local.clientIntegrations = {...local.clientIntegrations, codex:${JSON.stringify(initialCodex === true)}};
      saveConfig(local);
      const rawNativeBefore = JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME,'config.json'),'utf8'));
      let codexEnabled = true, modelId = 'fixture/first', settingsAvailable = false;
      const document = () => ({version:1, home:{name:'fixture-home',version:'1'},
        clients:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,{enabled:id==='pi'||id==='codex'&&codexEnabled}])),
        sources:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,'default']))});
      const fetchImpl = async input => {
        const url = String(input);
        if(url.endsWith('/readyz')) return Response.json({service:'opencodex',version:'1',uptime:1,pid:1,port:22001,
          status:'ready',protocol:1,minimumClientProtocol:1,managementUrl:'http://127.0.0.1:22001'});
        if(url.endsWith('/v1/catalog')) return Response.json({models:[]});
        if(url.endsWith('/route-intent')) return Response.json(document());
        if(url.endsWith('/codex-settings') && settingsAvailable) return Response.json({version:1,home:{name:'fixture-home',version:'1'},
          settings:{fastMode:true,multiAgentMode:null,webSearchSidecarEnabled:false,subagentDefaults:null}});
        if(url.endsWith('/v1/models')) return Response.json({data:[{id:modelId}]});
        return new Response(null,{status:404});
      };
      const deps = {fetchImpl,linkHome:{fetchImpl},catalogCompatibility:{supportedEfforts:()=>new Set()},
        lifecycleLockDeps:{lockPath:join(process.env.OPENCODEX_HOME,'lifecycle.sqlite')}};
      const connection = await connectClient({serverUrl:'http://127.0.0.1:22001',managementTransport:'direct',transport:'link',
        link:{tunnelPort:22001,linkId:'lnk_0123456789abcdef'},
        credential:{kind:'link',apiKeyId:'fixture-key',key:'ocx_data_'+'a'.repeat(40)},selectedClients:['codex','claude']},deps);
      ${body}
    `], {
      cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
        CODEX_SQLITE_HOME: join(home, ".codex"), OPENCODEX_HOME: join(home, ".opencodex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"), GROK_HOME: join(home, ".grok"),
        XDG_CONFIG_HOME: join(home, ".config"), OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"),
        OCX_TEST_HOME_GUARD: "1" },
    });
    expect({ status: child.status, stderr: child.stderr, error: child.error?.message }).toMatchObject({ status: 0 });
    expect(child.stderr).not.toContain("local route intent needs reconciliation");
    return JSON.parse(child.stdout.trim().split("\n").at(-1)!);
  } finally { removeTreeWithRetry(home); }
}

test("external Codex provider withdraws the same-digest apply record while other routes sync", () => {
  const result = scenario(`
    settingsAvailable=true;
    const first=await syncConnectedClient({},deps);
    const prior=readHomeCodexSettingsRecord(connection.link.linkId);
    const external='model_provider = "outside"\\n[model_providers.outside]\\nbase_url = "https://example.test/v1"\\n';
    writeFileSync(configPath,external);
    modelId='fixture/second';
    const synced=await syncConnectedClient({},deps);
    const record=readHomeCodexSettingsRecord(connection.link.linkId);
    const report=linkChildParityReport(connection,'2026-10-21T00:00:00.000Z',record,1);
    const receipt=readRouteIntentReceipt();
    console.log(JSON.stringify({firstInjected:first.injected,prior,config:readFileSync(configPath,'utf8'),external,
      injected:synced.injected,appliedRecord:synced.appliedRecord,record,report,
      codex:receipt.outcomes.find(row=>row.client==='codex'),pi:receipt.outcomes.find(row=>row.client==='pi'),
      piModels:readFileSync(piPath,'utf8')}));
  `);
  expect(result.firstInjected).toBe(true);
  expect(result.prior.document.settings.fastMode).toBe(true);
  expect(result.config).toBe(result.external);
  expect(result.injected).toBe(false);
  expect(result.appliedRecord).toBeUndefined();
  expect(result.record).toBeNull();
  expect(result.report.appliedCodexSettingsDigest).toBeNull();
  expect(result.report.lastApplyAt).toBeNull();
  expect(result.codex.outcome).toBe('conflict');
  expect(result.pi.outcome).toBe('current');
  expect(result.piModels).toContain('fixture/second');
}, SPAWN_BUDGET_MS);

for (const initial of ["absent", false, true] as const) {
  test(`disconnect restores native Codex intent after repeated Home sync (initial: ${String(initial)})`, () => {
    const result = scenario(`
      codexEnabled=false; await syncConnectedClient({},deps);
      codexEnabled=true; await syncConnectedClient({},deps);
      let error; try { await disconnectClient({},deps); } catch(e) { error=e.message; }
      const raw=JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME,'config.json'),'utf8'));
      console.log(JSON.stringify({error,state:readClientConnectionState().kind,
        hasCodex:Object.hasOwn(raw.clientIntegrations??{},'codex'),value:raw.clientIntegrations?.codex}));
    `, initial);
    expect(result.error).toBeUndefined();
    expect(result.state).toBe("disconnected");
    expect(result.hasCodex).toBe(initial !== "absent");
    if (initial !== "absent") expect(result.value).toBe(initial);
  }, SPAWN_BUDGET_MS);
}

// A value the route-intent writer did not publish is the person's own edit: disconnect keeps it.
test("disconnect retains the user's edit to native Codex intent after Home sync", () => {
  const result = scenario(`
    codexEnabled=false; await syncConnectedClient({},deps);
    const edited=loadConfig(); edited.clientIntegrations={...edited.clientIntegrations,codex:true}; saveConfig(edited);
    let error; try { await disconnectClient({},deps); } catch(e) { error=e.message; }
    const raw=JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME,'config.json'),'utf8'));
    console.log(JSON.stringify({error,state:readClientConnectionState().kind,value:raw.clientIntegrations?.codex}));
  `, "absent");
  expect(result.error).toBeUndefined();
  expect(result.state).toBe("disconnected");
  expect(result.value).toBe(true);
}, SPAWN_BUDGET_MS);

test("disconnect restores native Claude, Desktop, Grok and Messages field presence", () => {
  const result = scenario(`
    await syncConnectedClient({},deps);
    let error; try { await disconnectClient({},deps); } catch(e) { error=e.message; }
    const after=JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME,'config.json'),'utf8'));
    const fields = raw => ({
      grok: Object.hasOwn(raw.clientIntegrations??{},'grok') ? raw.clientIntegrations.grok : 'absent',
      desktop: Object.hasOwn(raw.clientIntegrations??{},'claude-desktop') ? raw.clientIntegrations['claude-desktop'] : 'absent',
      claude: Object.hasOwn(raw.claudeCode??{},'enabled') ? raw.claudeCode.enabled : 'absent',
      sentinel: Object.hasOwn(raw.claudeCode??{},'authModeMigratedAt') ? raw.claudeCode.authModeMigratedAt : 'absent',
      messages: Object.hasOwn(raw.apiSurfaces??{},'messages') ? raw.apiSurfaces.messages : 'absent',
    });
    console.log(JSON.stringify({error,state:readClientConnectionState().kind,before:fields(rawNativeBefore),after:fields(after)}));
  `);
  expect(result.error).toBeUndefined();
  expect(result.state).toBe("disconnected");
  expect(result.after).toEqual(result.before);
}, SPAWN_BUDGET_MS);

for (const damage of ["malformed", "invalid_owner", "missing"] as const) {
  test(`unknown Codex cleanup evidence retains credentials after failed off: ${damage}`, () => {
    const result = scenario(`
      const injected=readFileSync(configPath,'utf8');
      const lock=await acquireConfigWriteLock(configPath,{timeoutMs:0});
      if(!lock.ok)throw new Error('fixture lock acquisition failed');
      codexEnabled=false;
      try{await syncConnectedClient({},deps);}finally{releaseConfigWriteLock(lock.handle);}
      if(${JSON.stringify(damage)}==='malformed')writeFileSync(journalPath,'{malformed');
      else if(${JSON.stringify(damage)}==='missing')unlinkSync(journalPath);
      else {const journal=JSON.parse(readFileSync(journalPath,'utf8'));journal.owner={kind:'unknown'};writeFileSync(journalPath,JSON.stringify(journal));}
      let error;try{await disconnectClient({},deps);}catch(e){error=e.message;}
      console.log(JSON.stringify({error,injected,after:readFileSync(configPath,'utf8'),journal:existsSync(journalPath),
        token:existsSync(join(process.env.OPENCODEX_HOME,'service-api-token')),state:readClientConnectionState().kind}));
    `);
    expect(result.error).toMatch(/disconnect refused: Codex/);
    expect(result.after).toBe(result.injected);
    expect(result.journal).toBe(damage !== "missing");
    expect(result.token).toBe(true);
    expect(result.state).toBe("connected");
  }, SPAWN_BUDGET_MS);
}

test("Home Codex off then on reenables durable intent before injection and refreshes sibling clients", () => {
  const result = scenario(`
    codexEnabled=false;
    const off=await syncConnectedClient({},deps);
    const disabled=loadConfig().clientIntegrations.codex;
    const restored=readFileSync(configPath,'utf8');
    codexEnabled=true;modelId='fixture/second';
    let synced,error;
    try{synced=await syncConnectedClient({},deps);}catch(e){error=e.message;}
    console.log(JSON.stringify({error,disabled,restored,original,selectedOff:off.connection.selectedClients,
      enabled:loadConfig().clientIntegrations.codex,injected:synced?.injected,selected:synced?.connection.selectedClients,
      after:readFileSync(configPath,'utf8'),owner:journalOwner(),pi:readFileSync(piPath,'utf8'),
      outcomes:synced?.routeIntent?.outcomes.filter(row=>['codex','pi'].includes(row.client))}));
  `);
  expect(result.disabled).toBe(false);
  expect(result.restored).toBe(result.original);
  expect(result.selectedOff).toEqual(["pi"]);
  expect(result.error).toBeUndefined();
  expect(result.enabled).toBe(true);
  expect(result.injected).toBe(true);
  expect(result.selected).toEqual(["codex", "pi"]);
  expect(result.after).toContain('openai_base_url = "http://127.0.0.1:18274/v1"');
  expect(result.owner).toEqual({ kind: "client", apiKeyId: "fixture-key" });
  expect(result.pi).toContain("fixture/second");
  expect(result.outcomes.map((row: { outcome: string }) => row.outcome)).toEqual(["current", "current"]);
}, SPAWN_BUDGET_MS);

test("local Codex off remains disabled when Home turns Codex on", () => {
  const result = scenario(`
    codexEnabled=false;await syncConnectedClient({},deps);
    setLocalRouteIntentOff('codex',true);
    codexEnabled=true;modelId='fixture/local-off';
    const synced=await syncConnectedClient({},deps);
    console.log(JSON.stringify({enabled:loadConfig().clientIntegrations.codex,injected:synced.injected,
      selected:synced.connection.selectedClients,after:readFileSync(configPath,'utf8'),original,
      journal:existsSync(journalPath),pi:readFileSync(piPath,'utf8')}));
  `);
  expect(result.enabled).toBe(false);
  expect(result.injected).toBe(false);
  expect(result.selected).toEqual(["pi"]);
  expect(result.after).toBe(result.original);
  expect(result.journal).toBe(false);
  expect(result.pi).toContain("fixture/local-off");
}, SPAWN_BUDGET_MS);

for (const foreign of [false, true]) {
  test(`failed Codex off retains cleanup ownership on disconnect (foreign journal: ${foreign})`, () => {
    const result = scenario(`
      const injected=readFileSync(configPath,'utf8');
      const lock=await acquireConfigWriteLock(configPath,{timeoutMs:0});
      if(!lock.ok)throw new Error('fixture lock acquisition failed');
      codexEnabled=false;
      let off;
      try{off=await syncConnectedClient({},deps);}finally{releaseConfigWriteLock(lock.handle);}
      const retained=existsSync(journalPath),before=readFileSync(configPath,'utf8'),disabled=loadConfig().clientIntegrations?.codex;
      if(${foreign}){const journal=JSON.parse(readFileSync(journalPath,'utf8'));journal.owner={kind:'client',apiKeyId:'foreign-key'};writeFileSync(journalPath,JSON.stringify(journal));}
      let disconnected,error;try{disconnected=await disconnectClient({},deps);}catch(e){error=e.message;}
      console.log(JSON.stringify({injected,before,retained,offOutcome:off.routeIntent.outcomes.find(row=>row.client==='codex'),
        selected:off.connection.selectedClients,disabled,codexAfter:loadConfig().clientIntegrations?.codex??'absent',error,disconnected,
        after:readFileSync(configPath,'utf8'),original,journal:existsSync(journalPath),
        token:existsSync(join(process.env.OPENCODEX_HOME,'service-api-token')),state:readClientConnectionState().kind}));
    `);
    expect(result.offOutcome.outcome).toBe("failed");
    expect(result.offOutcome.message).toContain("another opencodex process");
    expect(result.disabled).toBe(false);
    expect(result.selected).toEqual(["pi"]);
    expect(result.retained).toBe(true);
    expect(result.before).toBe(result.injected);
    if (foreign) {
      expect(result.error).toContain("journal ownership conflicts");
      expect(result.codexAfter).toBe(false);
      expect(result.after).toBe(result.injected);
      expect(result.journal).toBe(true);
      expect(result.token).toBe(true);
      expect(result.state).toBe("connected");
    } else {
      expect(result.error).toBeUndefined();
      expect(result.disconnected.restored).toBe(true);
      // The standalone flag was absent before the Home's off displaced it.
      expect(result.codexAfter).toBe("absent");
      expect(result.after).toBe(result.original);
      expect(result.journal).toBe(false);
      expect(result.token).toBe(false);
      expect(result.state).toBe("disconnected");
    }
  }, SPAWN_BUDGET_MS);
}
