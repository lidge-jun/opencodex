import { expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);
function scenario(mutation: string) {
  const root = mkdtempSync(join(tmpdir(), "ocx-parity-withdrawal-"));
  const home = join(root, "home"); mkdirSync(home);
  try {
    const result = spawnSync(process.execPath, ["--eval", `
      import { writeFileSync, unlinkSync } from 'node:fs';
      import { join } from 'node:path';
      import { getDefaultConfig, saveConfig } from './src/config';
      import { createLinkParityReporter } from './src/client/link-parity-reporter';
      import { createLinkChildParityStore, parseLinkChildParityReport } from './src/link/child-parity';
      import { projectHomeRouteIntent, ROUTE_CLIENT_IDS, routeIntentDigest } from './src/link/route-intent';
      import { homeRouteIntentReceipt, writeHomeRouteIntentRecord, readHomeRouteIntentRecord, clearHomeRouteIntentRecord, sendLinkChildParityReport } from './src/client/link-home';
      import { writeRouteIntentReceipt, readRouteIntentReceiptStrict, routeIntentStatePath, setLocalRouteIntentOff } from './src/integrations/route-intent-state';
      import { applyConnectedRouteIntent } from './src/integrations/route-intent-connected';
      saveConfig(getDefaultConfig());
      const linkId='lnk_0123456789abcdef', at='2026-11-07T00:00:00.000Z';
      const connection={transport:'link',apiKeyId:'fixture',link:{linkId,tunnelPort:22001}};
      const document=projectHomeRouteIntent(getDefaultConfig(),'fixture');
      const outcomes=ROUTE_CLIENT_IDS.map(client=>({client,outcome:'current'}));
      const receipt={version:1,linkId,document,clients:document.clients,sources:document.sources,
        selectedClients:ROUTE_CLIENT_IDS.filter(id=>document.clients[id].enabled),outcomes,
        appliedRouteIntentDigest:routeIntentDigest(document),appliedAt:at};
      writeRouteIntentReceipt(receipt);
      writeHomeRouteIntentRecord(homeRouteIntentReceipt(linkId,document,at,at,outcomes,null));
      const store=createLinkChildParityStore(()=>Date.parse(at)), sent=[];
      let pending;
      const reporter=createLinkParityReporter({connection,runtimeStartedAt:at,linkKey:()=> 'fixture-key',readRecord:()=>null,
        send:(connection,key,report)=>sendLinkChildParityReport(connection,key,report,{fetchImpl:async(_input,init)=>{
          const raw=JSON.parse(String(init.body));sent.push(raw);
          const parsed=parseLinkChildParityReport(raw);if(!parsed)throw new Error('invalid reporter payload');
          store.record(parsed,new Set([linkId]));return new Response(null,{status:204});
        }}),setTimer:callback=>{pending=callback;return callback;},clearTimer:()=>{pending=undefined;}});
      const fire=async()=>{const callback=pending;pending=undefined;callback();for(let i=0;i<40;i++)await Promise.resolve();};
      try {
        reporter.start();await fire();const before=store.get(linkId);
        ${mutation}
        await fire();
        console.log(JSON.stringify({before,after:store.get(linkId),last:sent.at(-1),homeMissing:readHomeRouteIntentRecord(linkId)===null}));
      } finally {reporter.stop();}
    `], { cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
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

test.each([
  ["local-off invalidates the common receipt", `setLocalRouteIntentOff('codex',true);`],
  ["current local-off differs from the common receipt", `writeFileSync(join(routeIntentStatePath(),'local-off.json'),JSON.stringify({version:1,clients:['codex']}));`],
  ["common receipt is missing", `unlinkSync(join(routeIntentStatePath(),'receipt.json'));`],
  ["common receipt is malformed", `writeFileSync(join(routeIntentStatePath(),'receipt.json'),'{');`],
  ["local-off is malformed", `writeFileSync(join(routeIntentStatePath(),'local-off.json'),'{');`],
  ["common receipt belongs to another link", `writeRouteIntentReceipt({...receipt,linkId:'lnk_aaaaaaaaaaaaaaaa'});`],
  ["common receipt describes a different intent", `writeRouteIntentReceipt({...receipt,document:{...document,clients:{...document.clients,pi:{enabled:true}}}});`],
  ["common receipt still awaits catalog", `writeRouteIntentReceipt({...receipt,catalogPending:true});`],
  ["Home receipt is missing", `clearHomeRouteIntentRecord();`],
])("reporter withdraws Home parity when %s", (_name, mutation) => {
  const result = scenario(mutation!);
  expect(result.before.appliedRouteIntentDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.last.appliedRouteIntentDigest).toBeNull();
  expect(result.last.routeClientOutcomes).toEqual([]);
  expect(result.after).toMatchObject({ appliedRouteIntentDigest: null, routeClientOutcomes: [] });
});

test("an aborted connected materialization withdraws Home proof through the actual reporter", () => {
  const result = scenario(`
    let writes=0,error;
    try {await applyConnectedRouteIntent(connection,'fixture-key',{document,fetchedAt:at,stale:false},{
      beforeWrite:()=>{if(++writes===2)throw new Error('fixture apply aborted');},
      lifecycleLockDeps:{lockPath:join(process.env.OPENCODEX_HOME,'lifecycle.sqlite')},
    });}catch(e){error=e.message;}
    if(error!=='fixture apply aborted')throw new Error('abort fixture failed: '+error);
    if(readRouteIntentReceiptStrict().appliedRouteIntentDigest!==receipt.appliedRouteIntentDigest)throw new Error('fixture must retain prior common receipt');
  `);
  expect(result.before.appliedRouteIntentDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.homeMissing).toBe(true);
  expect(result.last.appliedRouteIntentDigest).toBeNull();
  expect(result.last.routeClientOutcomes).toEqual([]);
  expect(result.after).toMatchObject({ appliedRouteIntentDigest: null, routeClientOutcomes: [] });
});
