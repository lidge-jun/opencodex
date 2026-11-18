import { expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);

/** Join, live with the Home's intent, then disconnect: file integrations the Child owned before linking return. */
function scenario(before: string, body: string, homePi: boolean) {
  const root = mkdtempSync(join(tmpdir(), "ocx-route-file-originals-"));
  const home = join(root, "home"); mkdirSync(home);
  try {
    const result = spawnSync(process.execPath, ["--eval", `
      import './tests/helpers/windows-acl-process-stubs';
      import { expect } from 'bun:test';
      import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
      import { join, dirname } from 'node:path';
      import { getDefaultConfig, saveConfig, loadConfig } from './src/config';
      import { connectClient, disconnectClient, syncConnectedClient } from './src/client/connect';
      import { readClientConnectionState } from './src/client/state';
      import { createIntegrationStateStore } from './src/integrations/store';
      import { INTEGRATION_CLIENTS } from './src/integrations/registry';
      import { applyIntegration } from './src/integrations/writer';
      import { setLocalRouteIntentOff } from './src/integrations/route-intent-state';
      import { ROUTE_CLIENT_IDS } from './src/link/route-intent';
      const home = process.env.HOME;
      const config = getDefaultConfig(); config.port = 18274; config.hostname = '127.0.0.1'; saveConfig(config);
      const path = INTEGRATION_CLIENTS.pi.configPath({}, home);
      mkdirSync(INTEGRATION_CLIENTS.pi.detectDir({}, home), { recursive: true }); mkdirSync(dirname(path), { recursive: true });
      const fileIntentOriginalsPath = () => join(process.env.OPENCODEX_HOME,'link','file-intent-originals.json');
      const owned = () => Boolean(createIntegrationStateStore().readRecords().pi);
      const routed = () => existsSync(path) && JSON.parse(readFileSync(path,'utf8')).providers?.opencodex !== undefined;
      const document = {version:1, home:{name:'originals-fixture',version:'1'},
        clients:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,{enabled:id==='pi'&&${homePi}}])),
        sources:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,'default']))};
      const fetchImpl = async input => {
        const url=String(input);
        if(url.endsWith('/readyz'))return Response.json({service:'opencodex',version:'1',uptime:1,pid:1,port:22001,
          status:'ready',protocol:1,minimumClientProtocol:1,managementUrl:'http://127.0.0.1:22001'});
        if(url.endsWith('/v1/catalog'))return Response.json({models:[]});
        if(url.endsWith('/route-intent'))return Response.json(document);
        if(url.endsWith('/v1/models'))return Response.json({data:[{id:'fixture/home-model'}]});
        return new Response(null,{status:404});
      };
      const deps={fetchImpl,linkHome:{fetchImpl},catalogCompatibility:{supportedEfforts:()=>new Set()},
        lifecycleLockDeps:{lockPath:join(process.env.OPENCODEX_HOME,'lifecycle.sqlite')}};
      let connectExtra = {};
      ${before}
      await connectClient({serverUrl:'http://127.0.0.1:22001',managementTransport:'direct',transport:'link',
        link:{tunnelPort:22001,linkId:'lnk_0123456789abcdef'},credential:{kind:'link',apiKeyId:'fixture-key',key:'ocx_data_'+'a'.repeat(40)},
        selectedClients:['codex','claude'],selectedClientsExplicit:false,...connectExtra},deps);
      ${body}
    `], { cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000, env: { ...process.env,
      HOME: home, USERPROFILE: home, OPENCODEX_HOME: join(home, ".opencodex"), CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"), OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"),
      XDG_CONFIG_HOME: join(home, ".config"), GROK_HOME: join(home, ".grok"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      OCX_TEST_HOME_GUARD: "1" } });
    expect(result.stderr).not.toContain("local route intent needs reconciliation");
    expect({ status: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr }).toMatchObject({ status: 0, signal: null });
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const ownedBefore = `
  expect(applyIntegration({clientId:'pi',config,port:config.port,models:[{namespaced:'standalone/model',provider:'standalone',id:'model'}],
    store:createIntegrationStateStore(),home,env:process.env}).ok).toBe(true);
  expect(owned()).toBe(true);
`;
const disconnect = `
  const linked = { owned: owned(), routed: routed(), record: existsSync(fileIntentOriginalsPath()) };
  await disconnectClient({},deps);
  console.log(JSON.stringify({ linked, state: readClientConnectionState().kind, owned: owned(), routed: routed(),
    record: existsSync(fileIntentOriginalsPath()) }));
`;

test("a pre-owned integration the Home turned off returns on disconnect", () => {
  const result = scenario(ownedBefore, disconnect, false);
  expect(result.linked).toEqual({ owned: false, routed: false, record: true });
  expect(result).toMatchObject({ state: "disconnected", owned: true, routed: true, record: false });
});

test("a pre-owned integration the Home kept on stays after disconnect", () => {
  const result = scenario(ownedBefore, disconnect, true);
  expect(result.linked).toEqual({ owned: true, routed: true, record: true });
  expect(result).toMatchObject({ state: "disconnected", owned: true, routed: true, record: false });
});

test("an integration the link created is removed on disconnect", () => {
  const result = scenario("", disconnect, true);
  expect(result.linked).toEqual({ owned: true, routed: true, record: false });
  expect(result).toMatchObject({ state: "disconnected", owned: false, routed: false, record: false });
});

test("a local opt-out of a pre-owned integration is the person's choice and survives disconnect", () => {
  const result = scenario(ownedBefore, `
    setLocalRouteIntentOff('pi', true);
    await syncConnectedClient({}, deps);
    ${disconnect}
  `, true);
  expect(result.linked).toMatchObject({ owned: false, routed: false });
  expect(result).toMatchObject({ state: "disconnected", owned: false, routed: false, record: false });
});

test("a block the person wrote while linked is kept instead of being re-applied", () => {
  const result = scenario(ownedBefore, `
    writeFileSync(path, JSON.stringify({ providers: { opencodex: { baseUrl: 'https://person.example.test' } } }));
    const mine = readFileSync(path,'utf8');
    await disconnectClient({},deps);
    console.log(JSON.stringify({ state: readClientConnectionState().kind, owned: owned(), same: readFileSync(path,'utf8') === mine }));
  `, false);
  expect(result).toEqual({ state: "disconnected", owned: false, same: true });
});

test("a corrupt route receipt refuses the next sync before a link-created integration is recorded as standalone", () => {
  const result = scenario("", `
    const receiptPath = join(process.env.OPENCODEX_HOME,'route-intent','receipt.json');
    const linked = { owned: owned(), record: existsSync(fileIntentOriginalsPath()) };
    writeFileSync(receiptPath, '{"version":1}');
    let error; try { await syncConnectedClient({}, deps); } catch (e) { error = e.message; }
    console.log(JSON.stringify({ linked, error, owned: owned(), record: existsSync(fileIntentOriginalsPath()),
      receipt: readFileSync(receiptPath,'utf8') }));
  `, true);
  // Pi was created by the link, so no standalone record exists before the receipt is damaged.
  expect(result.linked).toEqual({ owned: true, record: false });
  expect(result.error).toContain("Route intent receipt is malformed");
  expect(result.record).toBe(false);
  expect(result.owned).toBe(true);
  // The damaged receipt is preserved for repair rather than replaced by the refused sync.
  expect(result.receipt).toBe('{"version":1}');
});

test("a --no-sync link over a standalone integration disconnects and keeps it, because no route apply began", () => {
  const result = scenario(ownedBefore + "connectExtra = { noSync: true };", `
    const linked = { owned: owned(), routed: routed(), receipt: existsSync(join(process.env.OPENCODEX_HOME,'route-intent','receipt.json')) };
    let error; try { await disconnectClient({},deps); } catch (e) { error = e.message; }
    console.log(JSON.stringify({ linked, error, state: readClientConnectionState().kind, owned: owned(), routed: routed(),
      proof: existsSync(join(process.env.OPENCODEX_HOME,'route-intent','unapplied.json')) }));
  `, true);
  expect(result.linked).toEqual({ owned: true, routed: true, receipt: false });
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ state: "disconnected", owned: true, routed: true, proof: false });
});

test("once a route apply began, a lost receipt still refuses disconnect", () => {
  const result = scenario(ownedBefore + "connectExtra = { noSync: true };", `
    await syncConnectedClient({}, deps);
    const proofAfterSync = existsSync(join(process.env.OPENCODEX_HOME,'route-intent','unapplied.json'));
    rmSync(join(process.env.OPENCODEX_HOME,'route-intent','receipt.json'));
    let error; try { await disconnectClient({},deps); } catch (e) { error = e.message; }
    console.log(JSON.stringify({ proofAfterSync, error, state: readClientConnectionState().kind }));
  `, true);
  expect(result.proofAfterSync).toBe(false);
  expect(result.error).toContain("Route intent cleanup receipt is missing");
  expect(result.state).toBe("connected");
});
