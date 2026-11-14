import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

// Run the real enrollment and injector with every native path bound to a disposable home.
function scenario(setup = "", testRunner = false, after = "") {
  const home = mkdtempSync(join(tmpdir(), "ocx-route-codex-connect-disabled-"));
  mkdirSync(join(home, ".codex"));
  try {
    const script = `
      import './tests/helpers/windows-acl-process-stubs';
      import { writeFileSync, readFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { getDefaultConfig, saveConfig, loadConfig } from './src/config';
      import { connectClient } from './src/client/connect';
      import { readClientConnectionState } from './src/client/state';
      import { readServiceApiTokenState, replaceServiceApiTokenFile } from './src/lib/service-secrets';
      import { ROUTE_CLIENT_IDS } from './src/link/route-intent';
      import { setLocalRouteIntentOff, readRouteIntentReceipt } from './src/integrations/route-intent';
      import { acquireConfigWriteLock, releaseConfigWriteLock } from './src/codex/config-write-lock';
      import { journalOwner } from './src/codex/journal';
      import { readHomeCodexSettingsRecord } from './src/client/link-home';
      const configPath = join(process.env.CODEX_HOME, 'config.toml');
      const original = 'model = "user-model"\\n';
      writeFileSync(configPath, original);
      const local = getDefaultConfig();
      local.port = 18274; local.fastMode = false;
      local.clientIntegrations = {...local.clientIntegrations, codex:false}; saveConfig(local);
      const requests = [];
      let homeIntentAvailable = true;
      const fetchImpl = async input => {
        const url = String(input); requests.push(url);
        if(url.endsWith('/readyz')) return Response.json({service:'opencodex',version:'1',uptime:1,pid:1,port:22001,
          status:'ready',protocol:1,minimumClientProtocol:1,managementUrl:'http://127.0.0.1:22001'});
        if(url.endsWith('/v1/catalog')) return Response.json({models:[]});
        if(url.endsWith('/route-intent') && homeIntentAvailable) return Response.json({version:1,home:{name:'fixture-home',version:'1'},
          clients:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,{enabled:id==='codex'}])),
          sources:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,'default']))});
        if(url.endsWith('/codex-settings')) return Response.json({version:1,home:{name:'fixture-home',version:'1'},
          settings:{fastMode:true,multiAgentMode:null,webSearchSidecarEnabled:false,subagentDefaults:null}});
        if(url.endsWith('/v1/models')) return Response.json({data:[]});
        return new Response(null,{status:404});
      };
      const deps = {fetchImpl,linkHome:{fetchImpl},catalogCompatibility:{supportedEfforts:()=>new Set()},
        lifecycleLockDeps:{lockPath:join(process.env.OPENCODEX_HOME,'lifecycle.sqlite')}};
      const options = {serverUrl:'http://127.0.0.1:22001',managementTransport:'direct',transport:'link',
        link:{tunnelPort:22001,linkId:'lnk_0123456789abcdef'},
        credential:{kind:'link',apiKeyId:'fixture-key',key:'ocx_data_'+'a'.repeat(40)},selectedClients:['codex']};
      let cleanup = () => {}, observedEnabled, observedInjected;
      ${setup}
      const before=readFileSync(configPath,'utf8');
      let connection, error;
      try {connection=await connectClient(options,deps);} catch(e) {error=e.message;} finally {cleanup();}
      let afterError, tokenAfterFailure; ${after}
      console.log(JSON.stringify({error,selected:connection?.selectedClients,enabled:loadConfig().clientIntegrations.codex,
        fastMode:loadConfig().fastMode,after:existsSync(configPath)?readFileSync(configPath,'utf8'):null,before,original,owner:journalOwner(),
        journal:existsSync(join(process.env.CODEX_HOME,'opencodex-journal.json')),
        token:readServiceApiTokenState().kind,state:readClientConnectionState().kind,
        settings:readHomeCodexSettingsRecord(options.link.linkId),receipt:readRouteIntentReceipt(),requests,observedEnabled,observedInjected,
        afterError,tokenAfterFailure,pending:existsSync(join(process.env.OPENCODEX_HOME,'client-connect-pending'))}));
    `;
    let args = ["--eval", script];
    if (testRunner) {
      const fixturePath = join(home, "post-publication.test.ts");
      const resolved = script.replace(/(from |import )'(\.\/(?:src|tests)\/[^']+)'/g,
        (_match, keyword: string, relative: string) => `${keyword}${JSON.stringify(join(repoRoot(), relative))}`);
      const start = resolved.indexOf("      const configPath =");
      writeFileSync(fixturePath, `import { test } from "bun:test";\n${resolved.slice(0, start)}\n`
        + `test("isolated enrollment", async () => {\n${resolved.slice(start)}\n}, ${SPAWN_BUDGET_MS - 5_000});\n`);
      args = ["test", "--preload", join(repoRoot(), "tests/preload.ts"), fixturePath];
    }
    const child = spawnSync(process.execPath, args, {
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

test("post-publication failure rolls back the disabled flag before removing enrollment authority", () => {
  const result = scenario(`
    const {spyOn}=await import('bun:test');
    const registries=await import(${JSON.stringify(join(repoRoot(), "src/config/derived-registries.ts"))});
    const refresh=registries.refreshConfigDerivedRegistries;
    let failed=false;
    const failure=spyOn(registries,'refreshConfigDerivedRegistries').mockImplementation(config=>{
      if(!failed && config.clientIntegrations?.codex===true){
        failed=true;observedEnabled=JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME,'config.json'),'utf8')).clientIntegrations.codex;
        throw new Error('fixture post-publication bookkeeping failure');
      }
      return refresh(config);
    });
    cleanup=()=>failure.mockRestore();
  `, true);
  expect(result.error).toContain("Config was published");
  expect(result.observedEnabled).toBe(true);
  expect(result.enabled).toBe(false);
  expect(result.after).toBe(result.original);
  expect(result.journal).toBe(false);
  expect(result.token).toBe("absent");
  expect(result.state).toBe("disconnected");
}, SPAWN_BUDGET_MS);

test("fresh Link connect lets Home Codex on override a disabled standalone flag", () => {
  const result = scenario();
  expect(result.error).toBeUndefined();
  expect(result.selected).toEqual(["codex"]);
  expect(result.state).toBe("connected");
  expect(result.enabled).toBe(true);
  expect(result.after).toContain('openai_base_url = "http://127.0.0.1:18274/v1"');
  expect(result.after).toContain("fast_mode = true");
  expect(result.fastMode).toBe(false);
  expect(result.owner).toEqual({ kind: "client", apiKeyId: "fixture-key" });
  expect(result.settings.document.settings.fastMode).toBe(true);
  expect(result.receipt.outcomes.find((row: { client: string }) => row.client === "codex").outcome).toBe("current");
}, SPAWN_BUDGET_MS);

for (const initiallyEnabled of [false, true]) {
  test(`failed enrollment restores initial Codex intent and preserves disjoint edits (initial: ${initiallyEnabled})`, () => {
    const result = scenario(`
      local.clientIntegrations.codex=${initiallyEnabled}; saveConfig(local);
      deps.now = () => {
        observedEnabled=loadConfig().clientIntegrations.codex;
        observedInjected=readFileSync(configPath,'utf8').includes('openai_base_url');
        const latest=loadConfig(); latest.fastMode=true; saveConfig(latest);
        throw new Error('fixture enrollment commit failed');
      };
    `);
    expect(result.error).toBe("fixture enrollment commit failed");
    expect(result.observedEnabled).toBe(true);
    expect(result.observedInjected).toBe(true);
    expect(result.enabled).toBe(initiallyEnabled);
    expect(result.fastMode).toBe(true);
    expect(result.after).toBe(result.original);
    expect(result.journal).toBe(false);
    expect(result.token).toBe("absent");
    expect(result.state).toBe("disconnected");
    expect(result.settings).toBeNull();
  }, SPAWN_BUDGET_MS);
}

test("failed enrollment preserves a later user edit to the temporary Codex intent", () => {
  const result = scenario(`
    deps.now=()=>{
      observedEnabled=loadConfig().clientIntegrations.codex;
      const edited=loadConfig(); edited.clientIntegrations={...edited.clientIntegrations,grok:true};
      delete edited.clientIntegrations.codex; saveConfig(edited);
      throw new Error('fixture enrollment commit failed');
    };
  `);
  expect(result.error).toContain("fixture enrollment commit failed");
  expect(result.observedEnabled).toBe(true);
  expect(result.enabled).toBeUndefined();
}, SPAWN_BUDGET_MS);

test("fresh Link connect with local Codex off preserves the disabled flag without injection", () => {
  const result = scenario("setLocalRouteIntentOff('codex',true);");
  expect(result.error).toBeUndefined();
  expect(result.selected).toEqual([]);
  expect(result.enabled).toBe(false);
  expect(result.after).toBe(result.original);
  expect(result.journal).toBe(false);
  expect(result.settings).toBeNull();
  expect(result.requests.some((url: string) => url.endsWith('/codex-settings'))).toBe(false);
}, SPAWN_BUDGET_MS);

test("fresh Link connect with no-sync leaves standalone Codex disabled and untouched", () => {
  const result = scenario("options.noSync=true;");
  expect(result.error).toBeUndefined();
  expect(result.selected).toEqual(["codex"]);
  expect(result.state).toBe("connected");
  expect(result.enabled).toBe(false);
  expect(result.after).toBe(result.original);
  expect(result.journal).toBe(false);
  expect(result.settings).toBeNull();
  expect(result.receipt).toBeNull();
}, SPAWN_BUDGET_MS);

test("a refused Codex injection fails enrollment and rolls back its temporary enable", () => {
  const result = scenario(`
    const lock=await acquireConfigWriteLock(configPath,{timeoutMs:0});
    if(!lock.ok)throw new Error('fixture lock acquisition failed');
    cleanup=()=>releaseConfigWriteLock(lock.handle);
  `);
  expect(result.error).toContain("another opencodex process");
  expect(result.enabled).toBe(false);
  expect(result.after).toBe(result.original);
  expect(result.journal).toBe(false);
  expect(result.token).toBe("absent");
  expect(result.state).toBe("disconnected");
  expect(result.settings).toBeNull();
}, SPAWN_BUDGET_MS);

test("without effective Home intent a disabled standalone Codex still refuses injection", () => {
  const result = scenario("homeIntentAvailable=false;");
  expect(result.error).toContain("Codex integration is OFF");
  expect(result.enabled).toBe(false);
  expect(result.after).toBe(result.original);
  expect(result.token).toBe("absent");
  expect(result.state).toBe("disconnected");
}, SPAWN_BUDGET_MS);

test("uncommitted Codex routing still fails enrollment and rolls back the temporary Home enable", () => {
  const result = scenario(`writeFileSync(configPath,'openai_base_url = "https://user.invalid/v1"\\n');`);
  expect(result.error).toBe("Codex routing target was not committed");
  expect(result.enabled).toBe(false);
  expect(result.after).toBe(result.before);
  expect(result.journal).toBe(false);
  expect(result.token).toBe("absent");
  expect(result.state).toBe("disconnected");
}, SPAWN_BUDGET_MS);

test("an aborted enrollment restores the standalone flag under the rollback ownership fence", () => {
  const result = scenario(`
    const controller=new AbortController(); deps.signal=controller.signal;
    deps.now=()=>{observedEnabled=loadConfig().clientIntegrations.codex;controller.abort();throw new Error('fixture aborted');};
  `);
  expect(result.error).toBe("fixture aborted");
  expect(result.observedEnabled).toBe(true);
  expect(result.enabled).toBe(false);
  expect(result.after).toBe(result.original);
  expect(result.journal).toBe(false);
  expect(result.token).toBe("absent");
  expect(result.state).toBe("disconnected");
}, SPAWN_BUDGET_MS);

test("changed enrollment credentials fence the early enable before Codex writes", () => {
  const result = scenario(`
    deps.linkHome.fetchImpl=async input=>{
      const response=await fetchImpl(input);
      if(String(input).endsWith('/codex-settings'))replaceServiceApiTokenFile('ocx_data_'+'b'.repeat(40));
      return response;
    };
  `);
  expect(result.error).toContain("client_token_changed");
  expect(result.enabled).toBe(false);
  expect(result.after).toBe(result.original);
  expect(result.journal).toBe(false);
  expect(result.token).toBe("present");
  expect(result.state).toBe("disconnected");
}, SPAWN_BUDGET_MS);

test("a local opt-out arriving with Home settings fences the early Codex enable", () => {
  const result = scenario(`
    deps.linkHome.fetchImpl=async input=>{
      const response=await fetchImpl(input);
      if(String(input).endsWith('/codex-settings'))setLocalRouteIntentOff('codex',true);
      return response;
    };
  `);
  expect(result.error).toContain("Codex route intent or runtime changed");
  expect(result.enabled).toBe(false);
  expect(result.after).toBe(result.original);
  expect(result.journal).toBe(false);
  expect(result.token).toBe("absent");
  expect(result.state).toBe("disconnected");
}, SPAWN_BUDGET_MS);

test("a failed native restore keeps the enrollment token, and ocx disconnect finishes the rollback", () => {
  const result = scenario(`
    deps.now = () => {
      // The write-ahead record is unreadable, so the rollback cannot restore the standalone switch.
      writeFileSync(join(process.env.OPENCODEX_HOME,'link','native-intent-originals.json'), '{');
      throw new Error('fixture enrollment commit failed');
    };
  `, false, `
    tokenAfterFailure = readServiceApiTokenState().kind;
    const recordPath = join(process.env.OPENCODEX_HOME,'link','native-intent-originals.json');
    const { disconnectClient } = await import('./src/client/connect');
    try { await disconnectClient({}, deps); } catch (e) { afterError = e.message; }
    if (!afterError?.includes(recordPath)) throw new Error('disconnect did not name the record: ' + afterError);
    writeFileSync(recordPath, JSON.stringify({ version: 1, fields: { codex: { original: false, published: true } } }));
    afterError = undefined;
    try { await disconnectClient({}, deps); } catch (e) { afterError = e.message; }
  `);
  expect(result.error).toContain("fixture enrollment commit failed");
  expect(result.error).toContain("native-intent-originals.json");
  expect(result.tokenAfterFailure).toBe("present");
  expect(result.afterError).toBeUndefined();
  expect(result.enabled).toBe(false);
  expect(result.token).toBe("absent");
  expect(result.pending).toBe(false);
  expect(result.state).toBe("disconnected");
}, SPAWN_BUDGET_MS);
