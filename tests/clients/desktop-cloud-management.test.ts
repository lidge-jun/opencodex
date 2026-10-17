import { expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTempHome } from "../helpers/temp-home";
import { cloudFixture } from "../helpers/cloud-network-fixture";
import { cloudTestProxy } from "../helpers/cloud-network-proxy";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { startCloudNetwork } from "../../src/chatgpt/cloud-network/runtime";
import { cloudHelperRequest } from "../../src/chatgpt/cloud-network/helper-client";
import { handleChatgptNetworkRoutes } from "../../src/server/management/chatgpt-network-routes";
import { handleChatgptNetworkCommand } from "../../src/cli/chatgpt-network-command";
import { createChatgptCloudNetworkLifecycle } from "../../src/server/index/chatgpt-cloud-network-lifecycle";
import { CLOUD_HOST, CloudNetworkError } from "../../src/chatgpt/cloud-network/contract";
import type { ManagementContext } from "../../src/server/management/context";

test("management refuses nonlocal/data-plane callers before config or runtime mutation", async () => {
  const save = mock(() => { throw new Error("unexpected save"); });
  for (const principal of [undefined, "api-key", "gui-session", "admin-token"] as const) {
    const ctx = { req: new Request("http://localhost/api/chatgpt-network/enable", { method: "POST" }), url: new URL("http://localhost/api/chatgpt-network/enable"),
      trustedLoopbackIngress: principal !== "admin-token" && principal !== "gui-session", principal,
      config: {}, deps: { saveConfigPreservingClaudeCode: save } } as unknown as ManagementContext;
    expect((await handleChatgptNetworkRoutes(ctx))?.status).toBe(403);
  }
  expect(save).not.toHaveBeenCalled();
});

test("persistence failure leaves the live config unchanged and never starts transport", async () => {
  const home = createTempHome("ocn-route-");
  const start = mock(async () => { throw new Error("unexpected transport"); });
  const config = { providers: {}, defaultProvider: "openai", chatgptDesktop: { cloudNetwork: false, appServerShim: true } };
  const lifecycle = createChatgptCloudNetworkLifecycle({ platform: "darwin", start }); lifecycle.start(config);
  try {
    const ctx = { req: new Request("http://localhost/api/chatgpt-network/enable", { method: "POST" }), url: new URL("http://localhost/api/chatgpt-network/enable"),
      trustedLoopbackIngress: true, principal: "admin-token", config,
      deps: { platform: "darwin", linkListener: () => ({ cloudNetwork: () => lifecycle }), saveConfigPreservingClaudeCode: () => { throw new Error("disk"); } } } as unknown as ManagementContext;
    expect((await handleChatgptNetworkRoutes(ctx))?.status).toBe(409);
    expect(config.chatgptDesktop).toEqual({ cloudNetwork: false, appServerShim: true });
    expect(start).not.toHaveBeenCalled();
  } finally { await lifecycle.stop(); home.remove(); }
});

test.skipIf(process.platform === "win32")("real startServer + formal CLI persists live toggles and owns awaited teardown", async () => {
  const home = createTempHome("ocn-server-");
  const f = cloudFixture(), helper = await f.startHelper(), proxy = await cloudTestProxy();
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "OPENCODEX_ADMIN_AUTH_TOKEN", "OPENCODEX_API_AUTH_TOKEN", "OCX_DISABLE_UPDATE_CHECK"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "test-cloud-admin";
  process.env.OPENCODEX_API_AUTH_TOKEN = "test-cloud-data";
  process.env.OCX_DISABLE_UPDATE_CHECK = "1";
  let server: ReturnType<typeof startServer> | undefined;
  let starts = 0;
  try {
    saveConfig({ port: 0, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai", codexAutoStart: false,
      claudeCode: { enabled: false, intercept: { enabled: false } }, proxy: `http://127.0.0.1:${proxy.port}`,
      chatgptDesktop: { cloudNetwork: false, appServerShim: false } });
    const deps = { managementApi: { platform: "darwin" as const }, cloudNetwork: { platform: "darwin" as const,
      start: async () => { starts++; return startCloudNetwork({ helperSocket: f.socketPath, listenPort: 0 }); },
      recover: async () => { const reply = await cloudHelperRequest("recover", f.socketPath); if (!reply.ok) throw new Error(reply.error); } } };
    server = startServer(0, deps);
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const auth = { authorization: "Bearer test-cloud-admin" };
    const state = async () => (await (await fetch(`${baseUrl}/api/chatgpt-network/status`, { headers: auth })).json()).network;
    expect((await state()).state).toBe("disabled"); expect(starts).toBe(0);
    const forbidden = await fetch(`${baseUrl}/api/chatgpt-network/enable`, { method: "POST", headers: { authorization: "Bearer test-cloud-data" } });
    expect(forbidden.status).toBe(401); expect(starts).toBe(0);
    expect(await handleChatgptNetworkCommand(["enable"], "darwin", { baseUrl })).toBe(0);
    expect((await state()).state).toBe("active"); expect(starts).toBe(1);
    expect(f.read()).toContain(CLOUD_HOST);
    expect(JSON.parse(readFileSync(home.path("config.json"), "utf8")).chatgptDesktop).toEqual({ cloudNetwork: true, appServerShim: false });
    const failedRecovery = spyOn(f.mapping, "recover").mockImplementation(() => { throw new CloudNetworkError("resolver_flush_failed"); });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await handleChatgptNetworkCommand(["disable"], "darwin", { baseUrl })).toBe(1);
        expect((await state()).state).toBe("unavailable");
        expect(f.read()).toContain(CLOUD_HOST);
      }
      expect(JSON.parse(readFileSync(home.path("config.json"), "utf8")).chatgptDesktop.cloudNetwork).toBe(false);
    } finally { failedRecovery.mockRestore(); }
    expect(await handleChatgptNetworkCommand(["disable"], "darwin", { baseUrl })).toBe(0);
    expect((await state()).state).toBe("disabled"); expect(f.read()).not.toContain(CLOUD_HOST);
    expect(await handleChatgptNetworkCommand(["enable"], "darwin", { baseUrl })).toBe(0);
    await server.stop(true); server = undefined;
    expect(f.read()).not.toContain(CLOUD_HOST);
    // Saved intent starts the same integration on the next OpenCodex runtime, without any CLI helper.
    server = startServer(0, deps);
    for (let i = 0; i < 100 && !f.read().includes(CLOUD_HOST); i++) await Bun.sleep(10);
    expect(f.read()).toContain(CLOUD_HOST); expect(starts).toBe(3);
    await server.stop(true); server = undefined;
    expect(f.read()).not.toContain(CLOUD_HOST);
  } finally {
    if (server) await server.stop(true);
    await helper.stop(); await proxy.stop(); f.cleanup();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    home.remove();
  }
}, 20_000);
