import { expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);
function scenario(body: string) {
  const root = mkdtempSync(join(tmpdir(), "ocx-connect-recovery-"));
  const home = join(root, "home"); mkdirSync(home);
  try {
    const result = spawnSync(process.execPath, ["--eval", body], {
      cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: "",
        OPENCODEX_HOME: join(home, ".opencodex"), CODEX_HOME: join(home, ".codex"),
        XDG_CONFIG_HOME: join(home, ".config"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
        GROK_HOME: join(home, ".grok"), OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"),
        OCX_TEST_HOME_GUARD: "1" },
    });
    expect({ status: result.status, stderr: result.stderr, error: result.error?.message }).toMatchObject({ status: 0 });
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const cliSetup = `
  import { mock } from 'bun:test';
  import { Readable } from 'node:stream';
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  const calls = [], lines = [], errors = [];
  mock.module('./src/client/connect', () => ({ connectClient: async options => {
    calls.push({ selected: options.selectedClients, explicit: options.selectedClientsExplicit });
    return { serverUrl:'http://127.0.0.1:22001', apiKeyId:'fixture', selectedClients:[] };
  }, disconnectClient:async()=>{}, revokeConnectedClientKey:async()=>{}, rotateConnectedClientKey:async()=>{} }));
  const { handleConnectCommand } = await import('./src/cli/connect');
  const output = console.log; console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  const credential = JSON.stringify({ apiKeyId:'fixture', key:'ocx_data_'+'a'.repeat(40) });
`;

test("Hub rejects generic clients before reading a credential or attempting connect", () => {
  const result = scenario(cliSetup + `
    let reads=0;
    const input = new Readable({ read() { reads++; this.push('fixture\\n'); this.push(null); } });
    const code = await handleConnectCommand(['http://127.0.0.1:22001','--admin-token-stdin','--clients','pi'], { stdinImpl:input });
    output(JSON.stringify({code,reads,calls,errors}));
  `);
  expect(result.code).toBe(2);
  expect(result.reads).toBe(0);
  expect(result.calls).toEqual([]);
  expect(result.errors.join(" ")).toContain("codex and claude");
});

test("Link accepts generic clients and completion uses the effective connection selection", () => {
  const result = scenario(cliSetup + `
    mkdirSync(process.env.CODEX_HOME,{recursive:true});
    const { DEFAULT_CATALOG_PATH } = await import('./src/codex/paths');
    writeFileSync(DEFAULT_CATALOG_PATH, JSON.stringify({ models:[{slug:'fixture', supported_reasoning_levels:[{effort:'max'}]}] }));
    const code = await handleConnectCommand(['--link','--key-stdin','--tunnel-port','22001','--link-id','lnk_0123456789abcdef','--clients','codex,pi','--no-sync'], {
      stdinImpl:Readable.from([credential]), catalogProbeDeps:{supportedEfforts:()=>new Set(['high'])},
    });
    output(JSON.stringify({code,calls,lines,errors}));
  `);
  expect(result.code).toBe(0);
  expect(result.calls).toEqual([{ selected: ["codex", "pi"], explicit: true }]);
  expect(result.lines.some((line: string) => line.startsWith("Connected to"))).toBe(true);
  expect(result.lines.some((line: string) => line.startsWith("Codex autostart shim:"))).toBe(false);
});

const realSetup = `
  import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
  import { join } from 'node:path';
  import { getDefaultConfig, saveConfig, setPersistedConfigMutationBeforeCommitForTests } from './src/config';
  import { connectClient } from './src/client/connect';
  import { readClientConnectionState } from './src/client/state';
  import { readServiceApiTokenState } from './src/lib/service-secrets';
  import { readInitialRouteIntent } from './src/integrations/route-intent-initial';
  import { routeIntentStatePath } from './src/integrations/route-intent-state';
  import { DEFAULT_CATALOG_PATH } from './src/codex/paths';
  const linkId='lnk_0123456789abcdef';
  saveConfig(getDefaultConfig()); mkdirSync(process.env.CODEX_HOME,{recursive:true});
  const prior='{"models":[{"slug":"prior"}]}'; writeFileSync(DEFAULT_CATALOG_PATH,prior);
  const fetchImpl=async input=> String(input).endsWith('/readyz')
    ? Response.json({service:'opencodex',version:'1',uptime:1,pid:1,port:22001,status:'ready',protocol:1,minimumClientProtocol:1,managementUrl:'http://127.0.0.1:22001'})
    : String(input).endsWith('/v1/catalog') ? Response.json({models:[]}) : new Response(null,{status:404});
  const deps={fetchImpl,linkHome:{fetchImpl},catalogCompatibility:{supportedEfforts:()=>new Set()},lifecycleLockDeps:{lockPath:join(process.env.OPENCODEX_HOME,'lifecycle.sqlite')}};
  const options={serverUrl:'http://127.0.0.1:22001',managementTransport:'direct',transport:'link',link:{tunnelPort:22001,linkId},
    credential:{kind:'link',apiKeyId:'fixture',key:'ocx_data_'+'a'.repeat(40)},selectedClients:['pi'],selectedClientsExplicit:true,noSync:true};
`;

test("initial-selection write refusal rolls back token and catalog without committing the connection", () => {
  const result = scenario(realSetup + `
    mkdirSync(routeIntentStatePath(),{recursive:true});
    mkdirSync(join(routeIntentStatePath(),'initial-'+linkId+'.json'));
    let error; try { await connectClient(options,deps); } catch(e) { error=e.message; }
    console.log(JSON.stringify({error,state:readClientConnectionState().kind,token:readServiceApiTokenState().kind,
      catalog:readFileSync(DEFAULT_CATALOG_PATH,'utf8'),pending:existsSync(join(process.env.OPENCODEX_HOME,'client-connect-pending'))}));
  `);
  expect(result.error).toBeTruthy();
  expect(result.state).toBe("disconnected");
  expect(result.token).toBe("absent");
  expect(result.catalog).toBe('{"models":[{"slug":"prior"}]}');
  expect(result.pending).toBe(false);
});

test("config commit refusal withdraws the newly recorded initial selection and rolls back enrollment", () => {
  const result = scenario(realSetup + `
    setPersistedConfigMutationBeforeCommitForTests(()=>{throw new Error('fixture commit refused');});
    let error; try { await connectClient(options,deps); } catch(e) { error=e.message; }
    console.log(JSON.stringify({error,state:readClientConnectionState().kind,token:readServiceApiTokenState().kind,
      initial:readInitialRouteIntent(linkId),catalog:readFileSync(DEFAULT_CATALOG_PATH,'utf8')}));
  `);
  expect(result.error).toContain("fixture commit refused");
  expect(result.state).toBe("disconnected");
  expect(result.token).toBe("absent");
  expect(result.initial).toEqual({});
  expect(result.catalog).toBe('{"models":[{"slug":"prior"}]}');
});

test.each(["older", "current"])("join preserves explicit local selections with a %s Home", homeVersion => {
  const result = scenario(realSetup + `
    const { joinHome } = await import('./src/client/link-join');
    const commands=[]; let restarts=0;
    const result=await joinHome({
      runner:{run:async argv=>{
        const command=argv.at(-1); commands.push(command);
        if (${JSON.stringify(homeVersion)}==='older' && command.includes('--clients'))
          return {code:2,stdout:'',stderr:'Error: Unexpected argument(s): --clients pi\\nUsage: ocx link issue'};
        return {code:0,stdout:JSON.stringify({linkId,apiKeyId:'fixture',key:options.credential.key,listenerPort:23001}),stderr:''};
      },spawnTunnel:()=>{throw new Error('unexpected real tunnel');}},
      knownHostsFile:join(process.env.OPENCODEX_HOME,'known-hosts'),confirmedHost:{alias:'home',fingerprint:'SHA256:fixture',probedAt:1},
      now:()=>1,choosePort:async()=>22001,hostname:()=> 'child',
      readSidecar:()=>null,writeState:()=>{},clearState:()=>{},
      spawnTunnel:()=>({pid:123,exited:new Promise(()=>{}),stop:async()=>{}}),scanListenPids:()=>({ok:true,pids:[123]}),
      fetchImpl:async(input,init)=>String(input).endsWith('/readyz') && !new Headers(init?.headers).has('x-opencodex-api-key')
        ? new Response(null,{status:401}) : fetchImpl(input,init),
      selectedClients:['pi'],connectDeps:deps,connect:(options,deps)=>connectClient({...options,noSync:true},deps),
      scheduleRestart:()=>{restarts++;},
    },{alias:'home'});
    console.log(JSON.stringify({result,commands,restarts,selection:readClientConnectionState().value.selectedClients,
      initial:readInitialRouteIntent(linkId),token:readServiceApiTokenState().kind}));
  `);
  expect(result.commands).toHaveLength(homeVersion === "older" ? 2 : 1);
  expect(result.commands[0]).toContain("--clients");
  if (homeVersion === "older") expect(result.commands[1]).not.toContain("--clients");
  expect(result.selection).toEqual(["pi"]);
  expect(result.initial).toEqual({ codex: { enabled: false, revision: 0 }, claude: { enabled: false, revision: 0 }, pi: { enabled: true, revision: 0 } });
  expect(result.restarts).toBe(1);
  expect(result.token).toBe("present");
});

test.each([
  { code: 1, stdout: "", stderr: "Unexpected argument(s): --clients pi" },
  { code: 2, stdout: "", stderr: "Unexpected argument(s): --alias child" },
  { code: 2, stdout: "possible issue receipt", stderr: "Unexpected argument(s): --clients pi" },
])("join never retries an ambiguous or unrelated issue failure: %j", failure => {
  const result = scenario(`
    import { joinHome } from './src/client/link-join';
    let calls=0,error;
    try { await joinHome({
      runner:{run:async()=>{calls++;return ${JSON.stringify(failure)};},spawnTunnel:()=>{throw new Error('unexpected tunnel');}},
      knownHostsFile:process.env.HOME+'/known-hosts',confirmedHost:{alias:'home',fingerprint:'SHA256:fixture',probedAt:1},
      now:()=>1,choosePort:async()=>22001,hostname:()=> 'child',readSidecar:()=>null,selectedClients:['pi'],scheduleRestart:()=>{},
    },{alias:'home'}); } catch(e) {error=e.message;}
    console.log(JSON.stringify({calls,error}));
  `);
  expect(result).toEqual({ calls: 1, error: "join_issue_failed" });
});
