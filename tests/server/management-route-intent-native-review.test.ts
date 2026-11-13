import { expect, test } from "bun:test";
import { createTempHome } from "../helpers/temp-home";
import { repoPath } from "../helpers/repo-root";

test("legacy dashboard toggles durably decide Home intent without changing Child defaults", async () => {
  const home = createTempHome("native-route-review-");
  try {
    const script = `
      const { getDefaultConfig, loadConfig, saveConfig } = await import(${JSON.stringify(repoPath("src/config.ts"))});
      const { handleNativeIntegrationRoutes } = await import(${JSON.stringify(repoPath("src/server/management/native-integration-routes.ts"))});
      const { readHomeRouteIntentState, initializeHomeRouteIntentDefaults } = await import(${JSON.stringify(repoPath("src/routing/home-route-intent.ts"))});
      const { projectHomeRouteIntent } = await import(${JSON.stringify(repoPath("src/link/route-intent.ts"))});
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const config = getDefaultConfig();
      config.port = 18274;
      config.claudeCode = { enabled: true };
      config.clientIntegrations = { codex: true, grok: true, "claude-desktop": true };
      saveConfig(config);
      initializeHomeRouteIntentDefaults(config, "test");
      mkdirSync(process.env.GROK_HOME, { recursive: true });
      writeFileSync(process.env.GROK_HOME + "/config.toml", "# fixture\\n");
      const result = [];
      for (const client of ["claude", "codex", "grok", "claude-desktop"]) {
        const req = new Request("http://localhost/api/native-integrations/" + client, { method: "PUT", body: JSON.stringify({ enabled: false }) });
        const response = await handleNativeIntegrationRoutes({ req, url: new URL(req.url), config, version: "test", deps: {} });
        const body = await response.json();
        const state = readHomeRouteIntentState(config);
        // The Home reads its durable switch (route-to status does the same); Children read defaults.
        result.push({ client, status: response.status, desired: body.desiredEnabled,
          home: projectHomeRouteIntent(loadConfig(), "test", "home", state).clients[client].enabled,
          child: projectHomeRouteIntent(config, "test", "lnk_0123456789abcdef", state).clients[client].enabled,
          homeEntry: state.devices.home?.[client] ?? null });
      }
      const { withLinkApply } = await import(${JSON.stringify(repoPath("src/client/link-home.ts"))});
      const before = JSON.stringify(readHomeRouteIntentState(config));
      const request = () => new Request("http://localhost/api/native-integrations/claude", { method: "PUT", body: JSON.stringify({ enabled: true }) });
      const req = request();
      const denied = await handleNativeIntegrationRoutes({ req, url: new URL(req.url), config: { ...config, runtimeRole: "client" }, version: "test", deps: {} });
      const busy = await withLinkApply(async () => {
        const req = request();
        return handleNativeIntegrationRoutes({ req, url: new URL(req.url), config, version: "test", deps: {} });
      });
      console.log("RECEIPT=" + JSON.stringify({ rows: result, denied: denied.status, busy: busy.status, unchanged: before === JSON.stringify(readHomeRouteIntentState(config)) }));
    `;
    const proc = Bun.spawn([process.execPath, "--eval", script], { env: { ...process.env, HOME: home.root,
      USERPROFILE: home.root, APPDATA: home.path("appdata"), LOCALAPPDATA: home.path("localappdata"), XDG_CONFIG_HOME: home.path("xdg"),
      CLAUDE_USER_DATA_DIR: home.path("claude-user-data"), OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: home.path("desktop-config"),
      OPENCODEX_HOME: home.root, CODEX_HOME: home.codexHome, CLAUDE_CONFIG_DIR: home.path(".claude"), GROK_HOME: home.path(".grok"), ASIDE_HOME: home.path(".aside") }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const result = JSON.parse(stdout.split("RECEIPT=")[1]!.trim());
    expect(result).toMatchObject({ denied: 403, busy: 409, unchanged: true });
    expect(result.rows).toHaveLength(4);
    for (const row of result.rows) {
      // A 500 after saving the OFF switch (for example a Grok cleanup failure) would still satisfy
      // every desired/home/child projection below, so the success status itself has to be asserted.
      expect(row.status).toBe(200);
      expect(row.desired).toBe(false);
      expect(row.home).toBe(false);
      // Captured once from the switches: Codex and Claude Code on; Grok and Desktop are never captured on.
      expect(row.child).toBe(row.client === "codex" || row.client === "claude");
      expect(row.homeEntry).toBeNull();
    }
  } finally { home.remove(); }
});
