import { expect, test, setDefaultTimeout } from "bun:test";
import { startRouteIntentTick } from "../../src/integrations/route-intent-tick";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
setDefaultTimeout(SPAWN_BUDGET_MS);

// Isolated cold runtime startup can exceed 20s under concurrent CI/worktrees; protocol deadlines and all behavioral assertions remain unchanged.
function scenario(body: string, enabledIds = ["pi"], explicitClients?: string[], servedId = "command-code/deepseek/deepseek-v4.1-flash-fast", fixture: { olderHome?: boolean; combos?: boolean; canonical?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocx-route-connected-")); const home = join(root, "home"); mkdirSync(home);
  try {
    const result = spawnSync(process.execPath, ["--eval", `
      import './tests/helpers/windows-acl-process-stubs';
      import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
      import { join, dirname } from 'node:path';
      import { getDefaultConfig, saveConfig, loadConfig, setPersistedConfigMutationBeforeCommitForTests } from './src/config';
      import { connectClient, syncConnectedClient, disconnectClient } from './src/client/connect';
      import { readServiceApiTokenState, writeServiceApiTokenFile } from './src/lib/service-secrets';
      import { readDesktopDisconnectReceipt } from './src/claude/desktop-remote-store';
      import { writeRuntimePort, removeRuntimePort } from './src/config/process-state';
      import { resolveDesktop3pAlias, generateDesktop3pModels } from './src/claude/desktop-3p';
      import { materializeLocalRouteIntent } from './src/client/route-intent-apply';
      import { readInitialRouteIntent } from './src/integrations/route-intent-initial';
      import { createIntegrationStateStore } from './src/integrations/store';
      import { routeIntentStatePath } from './src/integrations/route-intent-state';
      import { homeRouteIntentPath } from './src/client/link-home';
      import { fetchLinkHomeManagement } from './src/client/link-home';
      import { handleLinkManagementRequest } from './src/server/index/link-management';
      import { writeLinkStore } from './src/link/store';
      import { linkStorePath } from './src/link/paths';
      import { readClientConnectionState } from './src/client/state';
      import { ROUTE_CLIENT_IDS } from './src/link/route-intent';
      import { setLocalRouteIntentOff, readRouteIntentReceipt, cleanupRouteIntent } from './src/integrations/route-intent';
      import { INTEGRATION_CLIENTS } from './src/integrations/registry';
      const home = process.env.HOME;
      const local = getDefaultConfig(); local.port = 18274; local.hostname = '0.0.0.0'; saveConfig(local);
      const path = INTEGRATION_CLIENTS.pi.configPath({}, home);
      mkdirSync(INTEGRATION_CLIENTS.pi.detectDir({}, home), { recursive: true }); mkdirSync(dirname(path), { recursive: true });
      let id = ${JSON.stringify(servedId)};
      let enabled = true;
      let routeSupported = ${!fixture.olderHome}; let clientRevisions = {}; let offline=false; let offObserved=false;
      let modelsHook;
      const enabledIds = ${JSON.stringify(enabledIds)};
      if(enabledIds.includes('grok')) mkdirSync(process.env.GROK_HOME,{recursive:true});
      if(enabledIds.includes('claude')) mkdirSync(process.env.CLAUDE_CONFIG_DIR,{recursive:true});
      if(enabledIds.includes('claude-desktop')) {
        mkdirSync(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR,{recursive:true});
        writeFileSync(join(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR,'_meta.json'),JSON.stringify({entries:[]}));
      }
      const document = () => ({ version: 1, home: { name: 'fixture-home', version: '1' }, clientRevisions,
        clients: Object.fromEntries(ROUTE_CLIENT_IDS.map(client => [client, { enabled: enabledIds.includes(client) && enabled }])),
        sources: Object.fromEntries(ROUTE_CLIENT_IDS.map(client => [client, 'default'])) });
      const requests = [];
      const factsConfig={...local,combos:{'fixture-bare':{alias:'gpt-5.6',nativeAlias:true,targets:[]},'fixture-slash':{alias:'a/vendor-model',targets:[]}}};
      if(${fixture.combos === true})writeLinkStore(linkStorePath(),{version:1,listenerPort:null,links:[{id:'lnk_0123456789abcdef',alias:'fixture-home',direction:'client-initiated',hostKeyFingerprint:null,tunnelPort:22001,apiKeyId:'fixture-key',createdAt:'2026-11-07T00:00:00.000Z'}]});
      const fetchImpl = async (input, init) => {
        const url = String(input); requests.push({ method: init?.method ?? 'GET', url });
        if(offline){if(url.endsWith('/v1/models'))offObserved=JSON.parse(readFileSync(path,'utf8')).providers?.opencodex===undefined;throw new TypeError('fixture Home offline');}
        if (url.endsWith('/readyz')) return Response.json({ service:'opencodex',version:'1',uptime:1,pid:1,port:22001,
          status:'ready', protocol:1, minimumClientProtocol:1, managementUrl:'http://127.0.0.1:22001' });
        if (url.endsWith('/v1/catalog')) return Response.json({models:[]});
        if (url.endsWith('/route-intent')) return routeSupported ? Response.json(document()) : new Response(null,{status:404});
        if(url.endsWith('/route-catalog'))return handleLinkManagementRequest(new Request(url,init),new URL(url),factsConfig,{},undefined,'fixture-key');
        if (url.endsWith('/v1/models')) { await modelsHook?.(); return Response.json({data:${fixture.combos ? "[{id:'gpt-5.6',owned_by:'openai',is_combo:true},{id:'a/vendor-model',owned_by:'openai',is_combo:true}]" : `[{id,...(!id.includes('/')?{owned_by:'openai'}:{}),${fixture.canonical ? `native_id:${JSON.stringify(fixture.canonical)}` : ""}}]`}}); }
        return new Response(null,{status:404});
      };
      const deps = { fetchImpl, linkHome:{fetchImpl}, catalogCompatibility:{supportedEfforts:()=>new Set()},
        lifecycleLockDeps: {lockPath:join(process.env.OPENCODEX_HOME,'lifecycle.sqlite')} };
      const connection = await connectClient({serverUrl:'http://127.0.0.1:22001',managementTransport:'direct',transport:'link',
        link:{tunnelPort:22001,linkId:'lnk_0123456789abcdef'},credential:{kind:'link',apiKeyId:'fixture-key',key:'ocx_data_'+'a'.repeat(40)},
        selectedClients:${JSON.stringify(explicitClients ?? ["codex", "claude"])},selectedClientsExplicit:${explicitClients !== undefined}}, deps);
      ${body}
    `], { cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000, env: { ...process.env,
      HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), OPENCODEX_HOME: join(home, ".opencodex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"), OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"),
      XDG_CONFIG_HOME: join(home, ".config"), GROK_HOME: join(home, ".grok"),
      // Pi resolves an agent dir from this variable; an inherited value would point the
      // fixture at a real installed profile instead of the temp home it asserts against.
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), OCX_TEST_HOME_GUARD: "1" } });
    expect(result.stderr).not.toContain("local route intent needs reconciliation");
    expect({ status: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr }).toMatchObject({ status: 0, signal: null });
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("connect inherits non-native intent, sync refreshes exact served ids, off removes default-store owned keys", () => {
  const result = scenario(`
    const first = JSON.parse(readFileSync(path,'utf8'));
    const receipt = readRouteIntentReceipt();
    id = 'child/new-model';
    const synced = await syncConnectedClient({}, deps);
    const refreshed = readFileSync(path,'utf8');
    const edited = JSON.parse(refreshed); edited.userEdit = 'keep'; writeFileSync(path,JSON.stringify(edited));
    enabled = false; await syncConnectedClient({}, deps);
    console.log(JSON.stringify({selected:connection.selectedClients,first,refreshed,after:JSON.parse(readFileSync(path,'utf8')),
      receiptOutcome:receipt.outcomes.find(row=>row.client==='pi'),allReads:requests.every(row=>row.method==='GET'),syncSelected:synced.connection.selectedClients}));
  `);
  expect(result.selected).toEqual(["pi"]);
  expect(JSON.stringify(result.first)).toContain("18274");
  expect(JSON.stringify(result.first)).toContain("command-code/deepseek/deepseek-v4.1-flash-fast");
  expect(result.refreshed).toContain("child/new-model");
  expect(result.refreshed).not.toContain("deepseek");
  expect(result.after).toEqual({ userEdit: "keep" });
  expect(result.allReads).toBe(true);
  expect(result.receiptOutcome.outcome).toBe("current");
});

test("a connection replaced during model fetch stops route writes and withdraws the old receipt digest", () => {
  const result = scenario(`
    const before=readFileSync(path,'utf8');
    modelsHook=()=>{const changed=loadConfig();delete changed.client;changed.runtimeRole='standalone';saveConfig(changed);};
    let error;try{await syncConnectedClient({},deps);}catch(e){error=e.message;}
    console.log(JSON.stringify({error,same:readFileSync(path,'utf8')===before,digest:readRouteIntentReceipt().appliedRouteIntentDigest,state:readClientConnectionState().kind}));
  `);
  expect(result).toEqual({ error: "client_connection_changed", same: true, digest: null, state: "disconnected" });
});

test("native Child adapters materialize Grok and Desktop locally and keep the Claude launcher gate", () => {
  const result = scenario(`
    const receipt=readRouteIntentReceipt();
    const desktop=receipt.outcomes.find(row=>row.client==='claude-desktop');
    console.log(JSON.stringify({selected:connection.selectedClients,
      outcomes:receipt.outcomes.filter(row=>['claude','grok','claude-desktop'].includes(row.client)),
      desktop:JSON.parse(readFileSync(desktop.target,'utf8')),grok:readFileSync(join(process.env.GROK_HOME,'config.toml'),'utf8'),
      claudeEnabled:loadConfig().claudeCode?.enabled!==false}));
  `, ["claude", "grok", "claude-desktop"]);
  expect(result.selected).toEqual(["claude", "claude-desktop", "grok"]);
  expect(result.outcomes.map((row: { outcome: string }) => row.outcome)).toEqual(["current", "current", "current"]);
  expect(result.desktop.inferenceGatewayBaseUrl).toBe("http://127.0.0.1:18274");
  expect(result.desktop.inferenceGatewayApiKey).toBe("opencodex-loopback");
  expect(result.grok).toContain("18274");
  expect(result.grok).toContain("command-code/deepseek/deepseek-v4.1-flash-fast");
  expect(result.claudeEnabled).toBe(true);
});

test("runtime reconciliation waits for each sync, refreshes every tick, and stops without rearming", async () => {
  const scheduled: Array<{ callback: () => void; ms: number }> = [];
  let release!: () => void; let calls = 0;
  const controller = startRouteIntentTick({ transport: "link", link: { linkId: "lnk_0123456789abcdef", tunnelPort: 22001 } } as never, {
    sync: () => { calls += 1; return new Promise<void>(resolve => { release = resolve; }); },
    setTimer: (callback, ms) => { const next = { callback, ms }; scheduled.push(next); return next; }, clearTimer: () => {},
  });
  expect(scheduled.shift()!.ms).toBe(2_000);
  // Recreate the timer callback through the normal start API for an independent tick.
  controller.stop();
  const tick = startRouteIntentTick({ transport: "link", link: { linkId: "lnk_0123456789abcdef", tunnelPort: 22001 } } as never, {
    sync: () => { calls += 1; return new Promise<void>(resolve => { release = resolve; }); },
    setTimer: (callback, ms) => { const next = { callback, ms }; scheduled.push(next); return next; }, clearTimer: () => {},
  });
  scheduled.shift()!.callback(); expect(calls).toBe(1); expect(scheduled).toHaveLength(0);
  release(); await Promise.resolve(); await Promise.resolve();
  expect(scheduled[0]!.ms).toBe(60_000);
  scheduled.shift()!.callback(); expect(calls).toBe(2);
  tick.stop(); release(); await Promise.resolve(); await Promise.resolve();
  expect(scheduled).toHaveLength(0);
});
test("watcher sync requests coalesce with a running periodic sync", async () => {
  const queue: Array<{ callback: () => void; ms: number }> = [];
  let calls = 0; let release!: () => void;
  const tick = startRouteIntentTick({ transport: "link", link: { linkId: "lnk_0123456789abcdef", tunnelPort: 22001 } } as never, {
    sync: () => { calls += 1; return new Promise<void>(resolve => { release = resolve; }); },
    setTimer: (callback, ms) => { const timer = { callback, ms }; queue.push(timer); return timer; },
    clearTimer: timer => { const i = queue.indexOf(timer as typeof queue[number]); if (i >= 0) queue.splice(i, 1); },
  });
  queue.shift()!.callback();
  const first = tick.requestSync(); const second = tick.requestSync();
  expect(calls).toBe(1); expect(queue).toHaveLength(0);
  release(); await Promise.resolve(); await Promise.resolve();
  expect(calls).toBe(2); expect(queue).toHaveLength(0);
  release(); await Promise.all([first, second]);
  expect(queue).toHaveLength(1); expect(queue[0]!.ms).toBe(60_000);
  tick.stop(); expect(queue).toHaveLength(0);
});

test("local off persists across sync and inherits after clear; one-shot overwrite does not survive the next sync", () => {
  const result = scenario(`
    setLocalRouteIntentOff('pi',true); const off = await syncConnectedClient({},deps);
    const offReceipt=readRouteIntentReceipt(); const offFile=JSON.parse(readFileSync(path,'utf8'));
    setLocalRouteIntentOff('pi',false); await syncConnectedClient({},deps);
    writeFileSync(path,JSON.stringify({providers:{opencodex:{baseUrl:'https://foreign.example.test',models:[]}}}));
    const conflict = await syncConnectedClient({},deps);
    const overwritten = await syncConnectedClient({overwriteConflict:true},deps);
    writeFileSync(path,JSON.stringify({providers:{opencodex:{baseUrl:'https://foreign.example.test',models:[]}}}));
    const again = await syncConnectedClient({},deps);
    console.log(JSON.stringify({off:off.connection.selectedClients,offFile,source:offReceipt.sources.pi,outcome:offReceipt.outcomes.find(row=>row.client==='pi'),
      conflict:conflict.routeIntent.outcomes.find(row=>row.client==='pi').outcome,overwritten:overwritten.routeIntent.outcomes.find(row=>row.client==='pi').outcome,
      again:again.routeIntent.outcomes.find(row=>row.client==='pi').outcome}));
  `);
  expect(result.off).toEqual([]);
  expect(result.offFile).toEqual({});
  expect(result.source).toBe("local");
  expect(result.outcome.source).toBe("local");
  expect([result.conflict, result.overwritten, result.again]).toEqual(["conflict", "current", "conflict"]);
});

test("explicit provisioning selection survives ticks/defaults, and Home inherit revision clears only that client", () => {
  const result = scenario(`
    const initial=readRouteIntentReceipt().outcomes.find(row=>row.client==='pi');
    enabled=false;
    const kept=await syncConnectedClient({},deps);
    clientRevisions={pi:1};
    const inherited=await syncConnectedClient({},deps);
    const final=readRouteIntentReceipt().outcomes.find(row=>row.client==='pi');
    console.log(JSON.stringify({initial:initial.initialIntent,revision:initial.initialRevision,kept:kept.connection.selectedClients,
      inherited:inherited.connection.selectedClients,initialCleared:final.initialIntent===undefined,after:JSON.parse(readFileSync(path,'utf8'))}));
  `, ["pi"], ["pi"]);
  expect(result).toEqual({ initial: { enabled: true }, revision: 0, kept: ["pi"], inherited: [], initialCleared: true, after: {} });
});

test("local opt-out still removes owned routing and selection when Home has no route document", () => {
  const result = scenario(`
    routeSupported=false;setLocalRouteIntentOff('pi',true);
    const synced=await syncConnectedClient({},deps);
    console.log(JSON.stringify({selected:synced.connection.selectedClients,after:JSON.parse(readFileSync(path,'utf8')),
      outcome:readRouteIntentReceipt().outcomes.find(row=>row.client==='pi').outcome}));
  `);
  expect(result).toEqual({ selected: [], after: {}, outcome: "current" });
});

test("runtime/config port disagreement refuses before rewriting a client", () => {
  const result = scenario(`
    const before=readFileSync(path,'utf8');writeRuntimePort({pid:process.pid,port:18275});
    let error;try{await syncConnectedClient({},deps);}catch(e){error=e.message;}
    removeRuntimePort(process.pid);
    console.log(JSON.stringify({same:before===readFileSync(path,'utf8'),error}));
  `);
  expect(result.same).toBe(true); expect(result.error).toContain("client_runtime_changed");
});

test("Claude off prunes marker-owned agent definitions and preserves user-authored definitions", () => {
  const result = scenario(`
    const agents=join(process.env.CLAUDE_CONFIG_DIR,'agents');mkdirSync(agents,{recursive:true});
    writeFileSync(join(agents,'ocx-owned.md'),'generated-by: opencodex');writeFileSync(join(agents,'ocx-personal.md'),'user authored');
    enabled=false;const synced=await syncConnectedClient({},deps);
    console.log(JSON.stringify({owned:existsSync(join(agents,'ocx-owned.md')),personal:readFileSync(join(agents,'ocx-personal.md'),'utf8'),
      outcome:synced.routeIntent.outcomes.find(row=>row.client==='claude').outcome}));
  `, ["claude"]);
  expect(result).toEqual({ owned: false, personal: "user authored", outcome: "current" });
});

test("bare native model stays a native Desktop model rather than an opencodex provider alias", () => {
  const result = scenario(`
    const target=readRouteIntentReceipt().outcomes.find(row=>row.client==='claude-desktop').target;
    const desktop=JSON.parse(readFileSync(target,'utf8'));
    console.log(JSON.stringify({desktop,routes:desktop.inferenceModels.map(row=>resolveDesktop3pAlias(row.name))}));
  `, ["claude-desktop"], undefined, "gpt-5.6");
  expect(JSON.stringify(result.desktop)).not.toContain("opencodex/gpt");
  expect(result.routes).toEqual(["native/gpt-5.6"]);
});

test("disconnect cleans file routes before removing the service token and preserves later user fields", () => {
  const result = scenario(`
    const edited=JSON.parse(readFileSync(path,'utf8'));edited.userEdit='survive';writeFileSync(path,JSON.stringify(edited));
    await disconnectClient({},deps);
    console.log(JSON.stringify({after:JSON.parse(readFileSync(path,'utf8')),state:readClientConnectionState().kind,token:readServiceApiTokenState().kind,
      common:readRouteIntentReceipt(),homeReceipt:existsSync(homeRouteIntentPath())}));
  `);
  expect(result).toEqual({ after: { userEdit: "survive" }, state: "disconnected", token: "absent", common: null, homeReceipt: false });
});

test("a present corrupt route receipt refuses actual disconnect instead of silently skipping Pi cleanup", () => {
  const result = scenario(`
    const before=readFileSync(path,'utf8');writeFileSync(join(routeIntentStatePath(),'receipt.json'),'null');
    let error;try{await disconnectClient({},deps);}catch(e){error=e.message;}
    console.log(JSON.stringify({error,same:before===readFileSync(path,'utf8'),state:readClientConnectionState().kind,token:readServiceApiTokenState().kind,
      phase:readDesktopDisconnectReceipt().value.phase}));
  `);
  expect(result.same).toBe(true); expect(result.state).toBe("connected"); expect(result.token).toBe("present");
  expect(result.phase).toBe("prepared"); expect(result.error).toContain("receipt is malformed");
});

test("explicit recovery snapshots only the owned edited block, removes it, and preserves sibling edits", () => {
  const result = scenario(`
    const changed=JSON.parse(readFileSync(path,'utf8'));changed.providers.opencodex.baseUrl='https://foreign.example.test';changed.userEdit='survive';writeFileSync(path,JSON.stringify(changed));
    let refused=false;try{await disconnectClient({},deps);}catch{refused=true;}
    try { await disconnectClient({recoverConfig:true},deps); } catch (error) { throw new Error(JSON.stringify(readRouteIntentReceipt()?.outcomes.filter(row=>row.outcome==='conflict'||row.outcome==='failed'))); }
    const store=createIntegrationStateStore();const overwritten=store.listOperations('pi').find(entry=>entry.kind==='overwrite');
    const snapshot=overwritten?store.readSnapshot(overwritten):null;
    console.log(JSON.stringify({refused,after:JSON.parse(readFileSync(path,'utf8')),token:readServiceApiTokenState().kind,
      snapshot:snapshot?.kind==='stored'?JSON.parse(snapshot.text):null}));
  `);
  expect(result.refused).toBe(true); expect(result.after).toEqual({ userEdit: "survive" }); expect(result.token).toBe("absent");
  expect(result.snapshot.userEdit).toBe("survive"); expect(result.snapshot.providers.opencodex.baseUrl).toBe("https://foreign.example.test");
});

test("a cleanup conflict retains the connection, credential and pending disconnect evidence", () => {
  const result = scenario(`
    const changed=JSON.parse(readFileSync(path,'utf8'));changed.providers.opencodex.baseUrl='https://foreign.example.test';writeFileSync(path,JSON.stringify(changed));
    const before=readFileSync(path,'utf8');let error;try{await disconnectClient({},deps);}catch(e){error=e.message;}
    console.log(JSON.stringify({error,same:before===readFileSync(path,'utf8'),state:readClientConnectionState().kind,token:readServiceApiTokenState().kind,
      phase:readDesktopDisconnectReceipt().value.phase}));
  `);
  expect(result.same).toBe(true); expect(result.state).toBe("connected"); expect(result.token).toBe("present");
  expect(result.phase).toBe("prepared"); expect(result.error).toContain("cleanup was partial");
});

test("combo aliases decode against the independently generated Home registry, even with owned_by openai", () => {
  const result = scenario(`
    const target=readRouteIntentReceipt().outcomes.find(row=>row.client==='claude-desktop').target;
    const child=JSON.parse(readFileSync(target,'utf8')).inferenceModels;
    const homeRegistry=generateDesktop3pModels([],[{provider:'combo',id:'fixture-bare'},{provider:'combo',id:'fixture-slash'}]);
    let unsafeSent=0;let refused=false;try{await fetchLinkHomeManagement(connection,'fixture','/api/models',{}, {fetchImpl:async()=>{unsafeSent++;return Response.json([]);}});}catch{refused=true;}
    const badUrl=new URL('http://127.0.0.1:22001/v1/link-management/api/models');
    const denied=await handleLinkManagementRequest(new Request(badUrl),badUrl,factsConfig,{},undefined,'fixture-key');
    const factsUrl=new URL('http://127.0.0.1:22001/v1/link-management/route-catalog');
    const facts=await (await handleLinkManagementRequest(new Request(factsUrl),factsUrl,factsConfig,{},undefined,'fixture-key')).json();
    const unauth=await handleLinkManagementRequest(new Request(factsUrl),factsUrl,factsConfig,{});
    const post=await handleLinkManagementRequest(new Request(factsUrl,{method:'POST'}),factsUrl,factsConfig,{},undefined,'fixture-key');
    console.log(JSON.stringify({routes:child.map(row=>resolveDesktop3pAlias(row.name)),same:child.every(row=>homeRegistry.some(expected=>expected.name===row.name)),refused,unsafeSent,denied:denied.status,
      facts,unauth:unauth.status,post:post.status,factsOnly:requests.filter(row=>row.url.includes('route-catalog')).every(row=>row.method==='GET'),modelsApi:requests.some(row=>row.url.includes('/api/models'))}));
  `, ["claude-desktop"], undefined, "gpt-5.6", { combos: true });
  expect(result.same).toBe(true); expect(result.routes).toEqual(["combo/fixture-bare", "combo/fixture-slash"]);
  expect(result.refused).toBe(true); expect(result.unsafeSent).toBe(0); expect(result.denied).toBe(404);
  expect(result.factsOnly).toBe(true); expect(result.modelsApi).toBe(false);
  expect(result.unauth).toBe(403); expect(result.post).toBe(404);
  expect(result.facts).toEqual({ version: 1, combos: [{ publicId: "gpt-5.6", comboId: "fixture-bare" }, { publicId: "a/vendor-model", comboId: "fixture-slash" }] });
});

test.each([
  { canonical: "a/vendor-model", expected: "a/vendor-model", native: false },
  { canonical: "gpt-5.6", expected: "native/gpt-5.6", native: true },
])("promoted public aliases preserve file ids and Desktop canonical routing: %s", fixture => {
  const result = scenario(`
    const target=readRouteIntentReceipt().outcomes.find(row=>row.client==='claude-desktop').target;
    const child=JSON.parse(readFileSync(target,'utf8')).inferenceModels;
    const homeRegistry=generateDesktop3pModels(${fixture.native ? "['gpt-5.6'],[]" : "[],[{provider:'a',id:'vendor-model'}]"});
    console.log(JSON.stringify({file:JSON.parse(readFileSync(path,'utf8')),routes:child.map(row=>resolveDesktop3pAlias(row.name)),
      same:child.every(row=>homeRegistry.some(expected=>expected.name===row.name))}));
  `, ["pi", "claude-desktop"], undefined, "public-alias", { canonical: fixture.canonical });
  expect(result.same).toBe(true);
  expect(result.routes).toEqual([fixture.expected]);
  expect(JSON.stringify(result.file)).toContain("public-alias");
});

test("cached Home intent cannot block local off while catalog discovery is offline", () => {
  const result = scenario(`
    setLocalRouteIntentOff('pi',true);offline=true;
    const synced=await syncConnectedClient({},deps);const receipt=readRouteIntentReceipt();
    console.log(JSON.stringify({offObserved,pi:receipt.outcomes.find(row=>row.client==='pi').outcome,
      desktop:receipt.outcomes.find(row=>row.client==='claude-desktop').outcome,pending:receipt.catalogPending,stale:synced.stale,digest:receipt.appliedRouteIntentDigest}));
  `, ["pi", "claude-desktop"]);
  expect(result).toEqual({ offObserved: true, pi: "current", desktop: "stale", pending: true, stale: true, digest: null });
});

test("explicit local sync reports deferred when Home is offline even with cached all-off receipts", () => {
  const result = scenario(`
    const {syncLocalRouteTo}=await import('./src/routing/route-to-local');
    offline=true;
    const status=await syncLocalRouteTo({connection,linkId:connection.link.linkId,homePhrase:'fixture Home'},false,
      {sync:options=>syncConnectedClient(options,deps)});
    console.log(JSON.stringify({deferred:status.deferred,allCurrent:status.devices[0].clients.every(row=>row.applied==='current')}));
  `, []);
  expect(result).toEqual({ deferred: { reason: "intent_or_catalog_pending", clients: [] }, allCurrent: true });
});

test("older Home enrollment stores explicit initial choices and applies them after a revision-zero upgrade", () => {
  const result = scenario(`
    const initial=readInitialRouteIntent(connection.link.linkId);
    routeSupported=true;enabled=false;
    const synced=await syncConnectedClient({},deps);
    console.log(JSON.stringify({initial:initial.pi,selected:synced.connection.selectedClients,pi:readRouteIntentReceipt().outcomes.find(row=>row.client==='pi').outcome}));
  `, ["pi"], ["pi"], undefined, { olderHome: true });
  expect(result).toEqual({ initial: { enabled: true, revision: 0 }, selected: ["pi"], pi: "current" });
});

test("a local-only opt-out never invents an applied Home receipt for an unsupported Home", () => {
  const result = scenario(`
    routeSupported=false;setLocalRouteIntentOff('pi',true);
    await syncConnectedClient({},deps);
    console.log(JSON.stringify({local:readRouteIntentReceipt().catalogPending,home:existsSync(homeRouteIntentPath()),
      file:JSON.parse(readFileSync(path,'utf8'))}));
  `);
  expect(result).toEqual({ local: true, home: false, file: {} });
});

test("disconnect resumes after token removal without rerunning completed generic cleanup", () => {
  const result = scenario(`
    // Fail the first config commit after the token is gone; earlier commits (the standalone
    // native restore) proceed, so the fault lands exactly where the test name says.
    const afterTokenRemoval=()=>{
      if(readServiceApiTokenState().kind==='present'){setPersistedConfigMutationBeforeCommitForTests(afterTokenRemoval);return;}
      throw new Error('fixture after token removal');
    };
    setPersistedConfigMutationBeforeCommitForTests(afterTokenRemoval);
    let failed=false;try{await disconnectClient({},deps);}catch{failed=true;}
    const token=readServiceApiTokenState().kind;
    // No phase editing: the retry must resume from whatever the failed run persisted. Forcing
    // token_removed here would hide a receipt left at catalog_settled after the token is gone,
    // which a user's real retry would fail on with client_token_changed.
    await disconnectClient({},deps);
    console.log(JSON.stringify({failed,token,state:readClientConnectionState().kind,common:readRouteIntentReceipt()}));
  `);
  expect(result).toEqual({ failed: true, token: "absent", state: "disconnected", common: null });
});

test("ordinary Hub disconnect preserves an unrelated Home common receipt and its owned integration", () => {
  const result = scenario(`
    const homeDoc=document();const models=readRouteIntentReceipt().models;
    await disconnectClient({},deps);
    await materializeLocalRouteIntent(loadConfig(),homeDoc,models,{lifecycleLockDeps:deps.lifecycleLockDeps});
    const before=readFileSync(join(routeIntentStatePath(),'receipt.json'),'utf8');const beforePi=readFileSync(path,'utf8');
    const key='ocx_data_'+'b'.repeat(40);const token=writeServiceApiTokenFile(key);
    const hub=loadConfig();hub.runtimeRole='client';hub.client={serverUrl:'https://hub.example.test',managementUrl:'https://hub.example.test',managementTransport:'direct',
      apiKeyId:'fixture-hub',connectedAt:'2026-11-07T01:00:00.000Z',selectedClients:['claude'],tokenEnv:'OPENCODEX_API_AUTH_TOKEN',tokenFingerprint:token.fingerprint,protocolVersion:1,priorCatalog:''};saveConfig(hub);
    await disconnectClient({},deps);
    console.log(JSON.stringify({state:readClientConnectionState().kind,same:before===readFileSync(join(routeIntentStatePath(),'receipt.json'),'utf8'),samePi:beforePi===readFileSync(path,'utf8')}));
  `);
  expect(result).toEqual({ state: "disconnected", same: true, samePi: true });
});

test("older Home Link disconnect preserves a valid unbound standalone receipt and owned Pi", () => {
  const result = scenario(`
    const homeDoc=document();const models=readRouteIntentReceipt().models;
    await disconnectClient({},deps);
    await materializeLocalRouteIntent(loadConfig(),homeDoc,models,{lifecycleLockDeps:deps.lifecycleLockDeps});
    const before=readFileSync(join(routeIntentStatePath(),'receipt.json'),'utf8');const beforePi=readFileSync(path,'utf8');
    routeSupported=false;
    await connectClient({serverUrl:'http://127.0.0.1:22001',managementTransport:'direct',transport:'link',
      link:{tunnelPort:22001,linkId:'lnk_abcdef0123456789'},credential:{kind:'link',apiKeyId:'fixture-old-home',key:'ocx_data_'+'c'.repeat(40)},
      selectedClients:['claude'],noSync:true},deps);
    await disconnectClient({},deps);
    console.log(JSON.stringify({state:readClientConnectionState().kind,same:before===readFileSync(join(routeIntentStatePath(),'receipt.json'),'utf8'),samePi:beforePi===readFileSync(path,'utf8')}));
  `);
  expect(result).toEqual({ state: "disconnected", same: true, samePi: true });
});
