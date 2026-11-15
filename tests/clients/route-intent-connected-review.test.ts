import { expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);

function scenario(body: string, options: { noSync?: boolean; olderHome?: boolean; selectedClient?: "pi" | "droid" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocx-route-review-"));
  const home = join(root, "home"); mkdirSync(home);
  try {
    const result = spawnSync(process.execPath, ["--eval", `
      import './tests/helpers/windows-acl-process-stubs';
      import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
      import { join, dirname } from 'node:path';
      import { getDefaultConfig, saveConfig, loadConfig } from './src/config';
      import { connectClient, disconnectClient } from './src/client/connect';
      import { readClientConnectionState } from './src/client/state';
      import { readServiceApiTokenState } from './src/lib/service-secrets';
      import { createIntegrationStateStore } from './src/integrations/store';
      import { INTEGRATION_CLIENTS } from './src/integrations/registry';
      import { materializeLocalRouteIntent } from './src/client/route-intent-apply';
      import { applyConnectedRouteIntent } from './src/integrations/route-intent-connected';
      import { routeIntentStatePath, readRouteIntentReceipt, setLocalRouteIntentOff, readLocalRouteIntentOff } from './src/integrations/route-intent-state';
      import { homeRouteIntentPath, readHomeRouteIntentRecord } from './src/client/link-home';
      import { ROUTE_CLIENT_IDS } from './src/link/route-intent';
      const home = process.env.HOME;
      const config = getDefaultConfig(); config.port = 18274; config.hostname = '127.0.0.1'; saveConfig(config);
      const path = INTEGRATION_CLIENTS.pi.configPath({}, home);
      mkdirSync(dirname(path), {recursive:true});
      const document = {version:1, home:{name:'review-fixture',version:'1'},
        clients:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,{enabled:id==='pi'}])),
        sources:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,'default']))};
      const fetchImpl = async input => {
        const url=String(input);
        if(url.endsWith('/readyz'))return Response.json({service:'opencodex',version:'1',uptime:1,pid:1,port:22001,
          status:'ready',protocol:1,minimumClientProtocol:1,managementUrl:'http://127.0.0.1:22001'});
        if(url.endsWith('/v1/catalog'))return Response.json({models:[]});
        if(url.endsWith('/route-intent'))return ${options.olderHome === true} ? new Response(null,{status:404}) : Response.json(document);
        if(url.endsWith('/v1/models'))return Response.json({data:[{id:'fixture/model'}]});
        return new Response(null,{status:404});
      };
      const deps={fetchImpl,linkHome:{fetchImpl},catalogCompatibility:{supportedEfforts:()=>new Set()},
        lifecycleLockDeps:{lockPath:join(process.env.OPENCODEX_HOME,'lifecycle.sqlite')}};
      const connection=await connectClient({serverUrl:'http://127.0.0.1:22001',managementTransport:'direct',transport:'link',
        link:{tunnelPort:22001,linkId:'lnk_0123456789abcdef'},credential:{kind:'link',apiKeyId:'fixture-key',key:'ocx_data_'+'a'.repeat(40)},
        selectedClients:[${JSON.stringify(options.selectedClient ?? "pi")}],selectedClientsExplicit:true,noSync:${options.noSync === true}},deps);
      ${body}
    `], { cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000, env: { ...process.env,
      HOME: home, USERPROFILE: home, OPENCODEX_HOME: join(home, ".opencodex"), CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"), OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"),
      XDG_CONFIG_HOME: join(home, ".config"), GROK_HOME: join(home, ".grok"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      OCX_TEST_HOME_GUARD: "1" } });
    expect({ status: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr }).toMatchObject({ status: 0, signal: null });
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("disconnect restores the previously absent standalone Codex flag", () => {
  const result = scenario(`
    const during=loadConfig().clientIntegrations?.codex;
    let error; try { await disconnectClient({},deps); } catch(e) { error=e.message; }
    const after=loadConfig();
    console.log(JSON.stringify({during,error,state:readClientConnectionState().kind,
      hasCodex:Object.hasOwn(after.clientIntegrations??{},'codex')}));
  `);
  expect(result.during).toBe(false);
  expect(result.error).toBeUndefined();
  expect(result.state).toBe("disconnected");
  expect(result.hasCodex).toBe(false);
});

// The local opt-out list is the person's own choice on this machine, not a Home write.
test("disconnect keeps the Child's local route opt-outs", () => {
  const result = scenario(`
    setLocalRouteIntentOff('pi',true);
    let error; try { await disconnectClient({},deps); } catch(e) { error=e.message; }
    console.log(JSON.stringify({error,state:readClientConnectionState().kind,off:readLocalRouteIntentOff()}));
  `);
  expect(result.error).toBeUndefined();
  expect(result.state).toBe("disconnected");
  expect(result.off).toEqual(["pi"]);
});

test("review: isolated local-off fallback reads its own opt-out and previous document", () => {
  const result = scenario(`
    const statePath=join(home,'isolated-state'), store=createIntegrationStateStore(join(home,'isolated-store'));
    const isolated=structuredClone(document); isolated.home.name='isolated-proof';
    await materializeLocalRouteIntent(loadConfig(),isolated,[{namespaced:'fixture/model',provider:'fixture',id:'model'}],{statePath,store,onlyClients:['pi'],lifecycleLockDeps:deps.lifecycleLockDeps});
    setLocalRouteIntentOff('pi',true,statePath);
    const applied=await applyConnectedRouteIntent(connection,'fixture',undefined,{statePath,store,lifecycleLockDeps:deps.lifecycleLockDeps},deps.linkHome);
    console.log(JSON.stringify({present:!!applied,name:applied?.document.home.name,source:applied?.sources.pi,
      pi:applied?.outcomes.find(row=>row.client==='pi').outcome,file:JSON.parse(readFileSync(path,'utf8'))}));
  `, { noSync: true });
  expect(result).toEqual({ present: true, name: "isolated-proof", source: "local", pi: "current", file: {} });
});

test("review: aborted connected apply withdraws its prior Home confirmation", () => {
  const result = scenario(`
    const before=readHomeRouteIntentRecord(connection.link.linkId);
    let calls=0,error;
    try{await applyConnectedRouteIntent(connection,'fixture',{document,fetchedAt:new Date().toISOString(),stale:false},
      {beforeWrite:()=>{if(++calls>=2)throw new Error('fixture_abort');},lifecycleLockDeps:deps.lifecycleLockDeps},deps.linkHome);}catch(e){error=e.message;}
    console.log(JSON.stringify({before:!!before?.appliedRouteIntentDigest,error,after:!!readHomeRouteIntentRecord(connection.link.linkId)}));
  `);
  expect(result).toEqual({ before: true, error: "fixture_abort", after: false });
});

test.each([{ noSync: true }, { olderHome: true }, { noSync: true, recoverConfig: true }])("review: never-applied Pi disconnects safely (%j)", options => {
  const result = scenario(`
    const before={receipt:readRouteIntentReceipt(),file:existsSync(path)};
    let error;try{await disconnectClient({recoverConfig:${"recoverConfig" in options && options.recoverConfig === true}},deps);}catch(e){error=e.message;}
    console.log(JSON.stringify({before,error,state:readClientConnectionState().kind,token:readServiceApiTokenState().kind}));
  `, options);
  expect(result).toEqual({ before: { receipt: null, file: false }, state: "disconnected", token: "absent" });
});

for (const residue of [true, false]) test(`review: missing Droid receipt proves roster-independent absence (residue: ${residue})`, () => {
  const result = scenario(`
    const droidPath=INTEGRATION_CLIENTS.droid.configPath({},home);mkdirSync(dirname(droidPath),{recursive:true});
    const rows=${residue}?[{model:'removed-provider/removed-model',displayName:'OpenCodex: Removed model',baseUrl:'http://127.0.0.1:18274/v1',provider:'generic-chat-completion-api'}]:[{model:'personal/model',displayName:'Personal',baseUrl:'https://personal.invalid/v1'}];
    writeFileSync(droidPath,JSON.stringify({customModels:rows}));const before=readFileSync(droidPath,'utf8');
    let error;try{await disconnectClient({},deps);}catch(e){error=e.message;}
    console.log(JSON.stringify({error,unchanged:readFileSync(droidPath,'utf8')===before,state:readClientConnectionState().kind,token:readServiceApiTokenState().kind}));
  `, { noSync:true, selectedClient:"droid" });
  expect(result.unchanged).toBe(true);
  if (residue) { expect(result.error).toContain("receipt is missing");expect(result.state).toBe("connected");expect(result.token).toBe("present"); }
  else { expect(result.error).toBeUndefined();expect(result.state).toBe("disconnected");expect(result.token).toBe("absent"); }
});

test("review: unowned Pi route without receipts cannot be mistaken for never-applied", () => {
  const result = scenario(`
    writeFileSync(path,JSON.stringify({providers:{opencodex:{baseUrl:'http://127.0.0.1:18274/v1',models:[]}}}));
    const before=readFileSync(path,'utf8');
    let error;try{await disconnectClient({},deps);}catch(e){error=e.message;}
    console.log(JSON.stringify({error,state:readClientConnectionState().kind,token:readServiceApiTokenState().kind,same:readFileSync(path,'utf8')===before}));
  `, { noSync: true });
  expect(result.error).toContain("receipt is missing");
  expect(result).toMatchObject({ state: "connected", token: "present", same: true });
});

test("review: never-applied Pi disconnect preserves unrelated settings", () => {
  const result = scenario(`
    writeFileSync(path,JSON.stringify({userSetting:'keep'}));
    await disconnectClient({},deps);
    console.log(JSON.stringify({state:readClientConnectionState().kind,file:JSON.parse(readFileSync(path,'utf8'))}));
  `, { noSync: true });
  expect(result).toEqual({ state: "disconnected", file: { userSetting: "keep" } });
});

test("review: missing receipt with injected Pi state retains the connection and token", () => {
  const result = scenario(`
    unlinkSync(join(routeIntentStatePath(),'receipt.json'));
    const before=readFileSync(path,'utf8');
    let error;try{await disconnectClient({},deps);}catch(e){error=e.message;}
    console.log(JSON.stringify({error,state:readClientConnectionState().kind,token:readServiceApiTokenState().kind,same:readFileSync(path,'utf8')===before}));
  `);
  expect(result.error).toContain("receipt is missing");
  expect(result).toMatchObject({ state: "connected", token: "present", same: true });
});
