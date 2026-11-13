import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * Once a Link connection commits, a lifecycle lock another operation holds (or a connection it
 * already changed) must leave the route apply to the next sync. Enrollment rollback at that point
 * restored Codex routing and deleted nothing it could prove was its own, while the committed
 * connection stayed behind.
 */
function scenario() {
  const home = mkdtempSync(join(tmpdir(), "ocx-route-connect-post-commit-"));
  mkdirSync(join(home, ".codex"));
  try {
    const child = spawnSync(process.execPath, ["--eval", `
      import { Database } from 'bun:sqlite';
      import { writeFileSync, readFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { getDefaultConfig, saveConfig, loadConfig } from './src/config';
      import { connectClient } from './src/client/connect';
      import { readClientConnectionState } from './src/client/state';
      import { readServiceApiTokenState } from './src/lib/service-secrets';
      import { ROUTE_CLIENT_IDS } from './src/link/route-intent';
      const configPath = join(process.env.CODEX_HOME, 'config.toml');
      writeFileSync(configPath, 'model = "user-model"\\n');
      const local = getDefaultConfig(); local.port = 18274; saveConfig(local);
      const fetchImpl = async input => {
        const url = String(input);
        if(url.endsWith('/readyz')) return Response.json({service:'opencodex',version:'1',uptime:1,pid:1,port:22001,
          status:'ready',protocol:1,minimumClientProtocol:1,managementUrl:'http://127.0.0.1:22001'});
        if(url.endsWith('/v1/catalog')) return Response.json({models:[]});
        if(url.endsWith('/route-intent')) return Response.json({version:1,home:{name:'fixture-home',version:'1'},
          clients:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,{enabled:id==='codex'}])),
          sources:Object.fromEntries(ROUTE_CLIENT_IDS.map(id=>[id,'default']))});
        if(url.endsWith('/codex-settings')) return Response.json({version:1,home:{name:'fixture-home',version:'1'},
          settings:{fastMode:false,multiAgentMode:null,webSearchSidecarEnabled:false,subagentDefaults:null}});
        if(url.endsWith('/v1/models')) return Response.json({data:[]});
        return new Response(null,{status:404});
      };
      const lockPath = join(process.env.OPENCODEX_HOME,'lifecycle.sqlite');
      let holder, held = false;
      // The first clock read after the commit is the Home settings record; it runs outside the
      // lifecycle lock, so another operation can take that lock here.
      const now = () => {
        if (!held && readClientConnectionState().kind === 'connected') {
          holder = new Database(lockPath); holder.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE'); held = true;
        }
        return new Date();
      };
      const deps = {fetchImpl,linkHome:{fetchImpl},catalogCompatibility:{supportedEfforts:()=>new Set()},lifecycleLockDeps:{lockPath},now};
      let error;
      try {
        await connectClient({serverUrl:'http://127.0.0.1:22001',managementTransport:'direct',transport:'link',
          link:{tunnelPort:22001,linkId:'lnk_0123456789abcdef'},
          credential:{kind:'link',apiKeyId:'fixture-key',key:'ocx_data_'+'a'.repeat(40)},selectedClients:['codex']}, deps);
      } catch (e) { error = e.message; }
      finally { if (holder) { holder.exec('ROLLBACK'); holder.close(); } }
      console.log(JSON.stringify({error,held,state:readClientConnectionState().kind,token:readServiceApiTokenState().kind,
        routed:readFileSync(configPath,'utf8').includes('openai_base_url = "http://127.0.0.1:18274/v1"'),
        journal:existsSync(join(process.env.CODEX_HOME,'opencodex-journal.json'))}));
    `], {
      cwd: repoRoot(), encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
        CODEX_SQLITE_HOME: join(home, ".codex"), OPENCODEX_HOME: join(home, ".opencodex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"), GROK_HOME: join(home, ".grok"),
        XDG_CONFIG_HOME: join(home, ".config"), OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home, "desktop"),
        PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), OCX_TEST_HOME_GUARD: "1" },
    });
    expect({ status: child.status, stderr: child.stderr, error: child.error?.message }).toMatchObject({ status: 0 });
    return { ...JSON.parse(child.stdout.trim().split("\n").at(-1)!), stderr: child.stderr };
  } finally { removeTreeWithRetry(home); }
}

test("lifecycle lock contention after the commit keeps the enrollment and leaves route apply to the next sync", () => {
  const result = scenario();
  expect(result.held).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.state).toBe("connected");
  expect(result.token).toBe("present");
  // Codex routing the committed connection depends on stays in place.
  expect(result.routed).toBe(true);
  expect(result.journal).toBe(true);
  expect(result.stderr).toContain("local route intent needs reconciliation");
}, SPAWN_BUDGET_MS);
