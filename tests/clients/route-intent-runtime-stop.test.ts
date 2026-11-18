import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempHome } from "../helpers/temp-home";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

test("runtime recycle cancels its watch and tick before replacement handoff", () => {
  const home = createTempHome("route-runtime-stop-");
  try {
    const fixture = home.path("runtime-stop.test.ts");
    writeFileSync(fixture, `
      import { test, expect, spyOn } from 'bun:test';
      test('isolated recycle', async () => {
        const { writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const configApi = await import(${JSON.stringify(repoPath("src/config.ts"))});
        const { serviceApiTokenFingerprint } = await import(${JSON.stringify(repoPath("src/lib/service-secrets.ts"))});
        const ticks = await import(${JSON.stringify(repoPath("src/integrations/route-intent-tick.ts"))});
        const watches = await import(${JSON.stringify(repoPath("src/client/route-intent-watch.ts"))});
        const reporters = await import(${JSON.stringify(repoPath("src/client/link-parity-reporter.ts"))});
        const credentials = await import(${JSON.stringify(repoPath("src/local-credentials/runtime-observation.ts"))});
        const originalWatch = watches.startRouteIntentWatch;
        const events = []; let active = false;
        const tick = spyOn(ticks, 'startRouteIntentTick').mockImplementation(() => ({
          stop() { events.push('tick-stop'); }, requestSync: async () => {} }));
        const reporter = spyOn(reporters, 'createLinkParityReporter').mockImplementation(() => ({
          start() {}, stop() { events.push('reporter-stop'); }, requestReport() {} }));
        // The local-credential observer watches directories under the config home. Left running after the
        // recycle, it keeps those directory handles open, and Windows cannot delete a watched directory.
        const observation = spyOn(credentials, 'observeLocalCredentials').mockImplementation(() => ({
          stop() { events.push('credential-observation-stop'); } }));
        const watch = spyOn(watches, 'startRouteIntentWatch').mockImplementation((connection, key, deps) => originalWatch(connection, key, {
          ...deps, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
            active = true;
            init.signal.addEventListener('abort', () => { active = false; events.push('watch-cancelled'); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
          }),
        }));
        const runtime = await import(${JSON.stringify(repoPath("src/client/runtime.ts"))});
        const probe = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(null)});
        const port = probe.port; await probe.stop(true);
        const token = 'ocx_data_'+'c'.repeat(40);
        const config = configApi.getDefaultConfig(); config.port = port; config.runtimeRole = 'client';
        config.client = {serverUrl:'http://127.0.0.1:22001',managementUrl:'http://127.0.0.1:22001',managementTransport:'direct',
          transport:'link',link:{linkId:'lnk_0123456789abcdef',tunnelPort:22001},selectedClients:[],
          tokenEnv:'OPENCODEX_API_AUTH_TOKEN',apiKeyId:'fixture-key',tokenFingerprint:serviceApiTokenFingerprint(token),
          protocolVersion:1,connectedAt:'2026-11-07T00:00:00.000Z'};
        configApi.saveConfig(config); writeFileSync(join(process.env.OPENCODEX_HOME,'service-api-token'), token);
        try {
          await runtime.startClientRuntime({block:false}, {restartSupervisor:async()=>null,
            startListener: port => ({port,stop(){events.push('listener-stop');}})});
          for(let i=0;i<100&&!active;i++)await Bun.sleep(5);
          expect(active).toBe(true);
          await runtime.recycleStandalone(serviceApiTokenFingerprint(token), {
            isDesktopSupervised:()=>false,
            spawnReplacement:async()=>{expect(active).toBe(false);events.push('replacement');},
            exitProcess:code=>events.push('exit:'+code),
          });
          expect(events.indexOf('watch-cancelled')).toBeGreaterThanOrEqual(0);
          expect(events.indexOf('tick-stop')).toBeGreaterThanOrEqual(0);
          expect(events.filter(event => event === 'credential-observation-stop')).toHaveLength(1);
          expect(events.indexOf('watch-cancelled')).toBeLessThan(events.indexOf('listener-stop'));
          expect(events.indexOf('tick-stop')).toBeLessThan(events.indexOf('listener-stop'));
          expect(events.indexOf('credential-observation-stop')).toBeLessThan(events.indexOf('replacement'));
          expect(events.at(-1)).toBe('exit:0');
        } finally { tick.mockRestore(); watch.mockRestore(); reporter.mockRestore(); observation.mockRestore(); }
      }, ${SPAWN_BUDGET_MS - 5_000});
    `);
    const child = spawnSync(process.execPath, ["test", "--preload", repoPath("tests/preload.ts"), fixture], {
      cwd: repoRoot(), timeout: SPAWN_BUDGET_MS - 5_000, encoding: "utf8",
      env: { ...process.env, HOME: home.root, USERPROFILE: home.root, OPENCODEX_HOME: home.root, CODEX_HOME: home.codexHome,
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: join(home.root, "desktop"), OCX_SERVICE: "", OCX_DESKTOP_SUPERVISED: "" },
    });
    expect({ status: child.status, stderr: child.stderr, error: child.error?.message }).toMatchObject({ status: 0 });
  } finally { home.remove(); }
}, SPAWN_BUDGET_MS);
