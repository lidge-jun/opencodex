import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createTempHome } from "../helpers/temp-home";
import { repoRoot } from "../helpers/repo-root";

test.each([true, false])("Home-local Claude off preserves shared Messages exposure (%s)", enabled => {
  const home = createTempHome("route-claude-surface-");
  try {
    const script = `
      import { mkdirSync } from 'node:fs';
      import { join } from 'node:path';
      import { getDefaultConfig, saveConfig, loadConfig } from './src/config';
      import { materializeLocalRouteIntent } from './src/client/route-intent-apply';
      import { ROUTE_CLIENT_IDS } from './src/link/route-intent';
      import { resolveApiSurfaceSettings } from './src/protocols/settings';
      const config = getDefaultConfig(); config.port = 18274; config.claudeCode = { enabled:true };
      if (!${enabled}) config.apiSurfaces = {messages:{enabled:false}};
      saveConfig(config); mkdirSync(process.env.CLAUDE_CONFIG_DIR,{recursive:true});
      const document = {version:1,home:{name:'fixture-home',version:'1'},
        clients:Object.fromEntries(ROUTE_CLIENT_IDS.map(client=>[client,{enabled:false}])),
        sources:Object.fromEntries(ROUTE_CLIENT_IDS.map(client=>[client,'default']))};
      const receipt=await materializeLocalRouteIntent(config,document,[]);
      console.log(JSON.stringify({local:loadConfig().claudeCode.enabled,
        messages:resolveApiSurfaceSettings(loadConfig()).messages.enabled,
        live:resolveApiSurfaceSettings(config).messages.enabled,
        outcome:receipt.outcomes.find(row=>row.client==='claude').outcome}));
    `;
    const result = spawnSync(process.execPath, ["--eval", script], { cwd: repoRoot(), encoding: "utf8", timeout: 20_000,
      env: { ...process.env, HOME: home.root, USERPROFILE: home.root, OPENCODEX_HOME: home.configDir, CODEX_HOME: home.codexHome,
        CLAUDE_CONFIG_DIR: home.path(".claude"), OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: home.path("desktop"),
        XDG_CONFIG_HOME: home.path(".config"), GROK_HOME: home.path(".grok"), OCX_TEST_HOME_GUARD: "1" } });
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({ local: false, messages: enabled, live: enabled, outcome: "current" });
  } finally { home.remove(); }
});
