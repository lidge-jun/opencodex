import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeInterceptLifecycle } from "../../src/server/index/claude-intercept-lifecycle";
import { startConnectProxy } from "../../src/claude/intercept/connect-proxy";
import { handleManagementAPI } from "../../src/server/management-api";
import { saveConfig, loadConfig } from "../../src/config";
import { flushConfigDirHardeningAndReaps } from "../../src/config/paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { initializeManagementAuthState, requireManagementAuth } from "../../src/server/management-auth";
import type { OcxConfig } from "../../src/types";

let root: string;
let previousHome: string | undefined;
let previousClaude: string | undefined;
let previousDesktop: string | undefined;
const owners: Array<ReturnType<typeof createClaudeInterceptLifecycle>> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-intercept-demand-"));
  previousHome = process.env.OPENCODEX_HOME;
  previousClaude = process.env.CLAUDE_CONFIG_DIR;
  previousDesktop = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "desktop");
  process.env.OPENCODEX_HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
});
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.stop();
  await flushConfigDirHardeningAndReaps(root);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  if (previousDesktop === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR; else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktop;
  removeTreeWithRetry(root);
});
function config(): OcxConfig {
  return { port: 10100, providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1", models: ["test"], liveModels: false } }, defaultProvider: "mock", claudeCode: { enabled: false } } as OcxConfig;
}
function owner() { const lifecycle = createClaudeInterceptLifecycle(); owners.push(lifecycle); return lifecycle; }

test("late ensure reuses dispatch ownership, serializes and stays idempotent", async () => {
  const live = config();
  const lifecycle = owner();
  let binds = 0;
  let tlsPort = 0;
  let owned = false;
  lifecycle.start({ config: live, publicPort: 10100, configDir: root,
    dispatch: async (_req, server) => { owned = lifecycle.ownsListener(server); return new Response("ok"); }, pickerPlatform: "linux",
    loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
    startProxy: async (_port, options) => { binds++; tlsPort = options.interceptPort; return startConnectProxy(0, options); },
  });
  expect(await lifecycle.ensure()).toEqual({ ok: false, reason: "disabled" });
  live.claudeCode!.enabled = true;
  live.claudeCode!.cliFirstParty = true;
  const first = lifecycle.ensure();
  expect(lifecycle.ensure()).toBe(first);
  const result = await first;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("intercept failed");
  const response = await fetch(`https://127.0.0.1:${tlsPort}/v1/messages`, { method: "POST", body: "{}",
    headers: { "User-Agent": "claude-cli/2.1.282 (external, cli)" }, tls: { rejectUnauthorized: false } });
  expect(await response.text()).toBe("ok");
  expect(owned).toBe(true);
  expect(await lifecycle.ensure()).toEqual(result);
  expect(binds).toBe(1);
});

test("stopped lifecycle refuses new work and joins a pending startup", async () => {
  const lifecycle = owner();
  const live = config(); live.claudeCode!.enabled = true;
  lifecycle.start({ config: live, publicPort: 10100, requestedPort: 0, dispatch: async () => new Response() });
  await lifecycle.stop();
  expect(await lifecycle.ensure()).toEqual({ ok: false, reason: "stopped" });
});

test("CONNECT bind EADDRINUSE records its occupied port", async () => {
  const blocker = await startConnectProxy(0, { interceptPort: 1 });
  try {
    const live = config(); live.claudeCode = { enabled: true, intercept: { port: blocker.port } };
    const lifecycle = owner();
    lifecycle.start({ config: live, publicPort: 10100, configDir: root, dispatch: async () => new Response() });
    expect(await lifecycle.ensure()).toEqual({ ok: false, reason: "port_in_use", port: blocker.port });
    expect(lifecycle.lastOutcome()).toEqual({ ok: false, reason: "port_in_use", port: blocker.port });
  } finally { await blocker.close(); }
});

test("prechecks distinguish client role and ephemeral public ports", async () => {
  for (const [runtimeRole, reason] of [["client", "client_role"], ["standalone", "ephemeral_port"]] as const) {
    const live = config(); live.runtimeRole = runtimeRole; live.claudeCode!.enabled = true;
    const lifecycle = owner();
    lifecycle.start({ config: live, publicPort: 30000, requestedPort: 0, dispatch: async () => new Response() });
    expect(await lifecycle.ensure()).toEqual({ ok: false, reason });
  }
});

test("manual start refuses hub ingress and data-plane authority before ensure", async () => {
  let calls = 0;
  const url = new URL("http://127.0.0.1:10100/api/claude-intercept/start");
  const live = config(); live.claudeCode!.enabled = true;
  for (const [principal, loopback] of [["gui-session", false], [undefined, true]] as const) {
    const response = await handleManagementAPI(new Request(url, { method: "POST", headers: { Host: url.host } }), url, live,
      { ensureClaudeIntercept: async () => { calls++; return { ok: false, reason: "failed" }; } },
      principal, undefined, { trustedLoopback: loopback });
    expect(response!.status).toBe(403);
  }
  expect(calls).toBe(0);
});

test("manual start returns the concrete disabled reason", async () => {
  const url = new URL("http://127.0.0.1:10100/api/claude-intercept/start");
  const response = await handleManagementAPI(new Request(url, { method: "POST", headers: { Host: url.host } }), url, config(), {},
    "admin-token", undefined, { trustedLoopback: true });
  expect(response!.status).toBe(409);
  expect(await response!.json()).toEqual({ ok: false, reason: "disabled" });
});


test("stop waits for an in-flight bind and closes the late listener", async () => {
  const live = config(); live.claudeCode!.enabled = true;
  const lifecycle = owner();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  lifecycle.start({ config: live, publicPort: 10100, configDir: root, pickerPlatform: "linux",
    loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
    dispatch: async () => new Response(), startProxy: async (_port, options) => {
      entered(); await gate; return startConnectProxy(0, options);
    },
  });
  await started;
  let closed = false;
  const stopping = lifecycle.stop().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(await lifecycle.ensure()).toEqual({ ok: false, reason: "stopped" });
  release(); await stopping;
  expect(closed).toBe(true);
  expect(lifecycle.lastOutcome()).toEqual({ ok: false, reason: "stopped" });
});

test("CLI first-party save starts a previously unbound pair", async () => {
  const live = config(); live.claudeCode = { enabled: false, desktopMode: "gateway", intercept: { port: 10200 } };
  const lifecycle = owner();
  let binds = 0;
  lifecycle.start({ config: live, publicPort: 10100, configDir: root, pickerPlatform: "linux",
    loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }), dispatch: async () => new Response(),
    startProxy: async (_port, options) => {
      const proxy = await startConnectProxy(0, options);
      if (binds++ === 0) { live.claudeCode!.intercept!.port = proxy.port; saveConfig(live); }
      return proxy;
    },
  });
  expect(await lifecycle.ensure()).toEqual({ ok: false, reason: "disabled" });
  live.claudeCode.enabled = true; saveConfig(live);
  const url = new URL("http://127.0.0.1:10100/api/claude-code");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT", headers: { Host: url.host, "Content-Type": "application/json" }, body: JSON.stringify({ cliFirstParty: true }),
  }), url, live, { ensureClaudeIntercept: () => lifecycle.ensure() }, "admin-token", undefined, { trustedLoopback: true });
  expect(response!.status).toBe(200);
  expect(loadConfig().claudeCode?.cliFirstParty).toBe(true);
  expect(binds).toBe(1);
});

test("remote management never starts interception; routing intent can still persist", async () => {
  for (const [path, method, body] of [
    ["/api/claude-code", "PUT", { cliFirstParty: true }],
    ["/api/claude-desktop/apply", "POST", { mode: "first-party" }],
    ["/api/claude-desktop/picker", "PUT", { enabled: true, persist: true }],
    ["/api/native-integrations/claude", "PUT", { enabled: true }],
    ["/api/native-integrations/claude-desktop", "PUT", { enabled: true }],
  ] as const) {
    for (const [principal, loopback] of [["gui-session", false], [undefined, true]] as const) {
      const live = config(); live.claudeCode!.desktopMode = "first-party"; saveConfig(live);
      let calls = 0;
      const url = new URL(`http://127.0.0.1:10100${path}`);
      const response = await handleManagementAPI(new Request(url, { method,
        headers: { Host: url.host, "Content-Type": "application/json" }, body: JSON.stringify(body),
      }), url, live, { ensureClaudeIntercept: async () => { calls++; return { ok: false, reason: "failed" }; } },
        principal, undefined, { trustedLoopback: loopback });
      if (path === "/api/native-integrations/claude") {
        expect(response!.status).toBe(200);
        expect((await response!.json()).interceptReason).toBe("intercept_start_forbidden");
        expect(loadConfig().claudeCode?.enabled).toBe(true);
      } else expect(response!.status).toBe(403);
      expect(calls).toBe(0);
      expect(loadConfig().claudeCode?.cliFirstParty).toBeUndefined();
    }
  }
});

test("a data-plane API key fails the actual management authentication gate", () => {
  const live = config(); live.apiKeys = [{ id: "data", name: "Data", key: "data-plane-only-key" }];
  const auth = initializeManagementAuthState(live);
  const req = new Request("http://127.0.0.1:10100/api/claude-intercept/start", {
    method: "POST", headers: { Authorization: "Bearer data-plane-only-key" },
  });
  expect(requireManagementAuth(req, auth, live)?.status).toBe(401);
});


test("ensure arriving during null startup joins it before starting with the live config", async () => {
  const live = config();
  const lifecycle = owner();
  let binds = 0;
  lifecycle.start({ config: live, publicPort: 10100, configDir: root, pickerPlatform: "linux",
    loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }), dispatch: async () => new Response(),
    startProxy: async (_port, options) => { binds++; return startConnectProxy(0, options); },
  });
  live.claudeCode!.enabled = true;
  const pending = lifecycle.ensure();
  expect(lifecycle.ensure()).toBe(pending);
  expect((await pending).ok).toBe(true);
  expect(binds).toBe(1);
});


test("native Claude toggle reports an intercept startup refusal", async () => {
  const live = config(); saveConfig(live);
  const url = new URL("http://127.0.0.1:10100/api/native-integrations/claude");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT", headers: { Host: url.host, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }),
  }), url, live, { ensureClaudeIntercept: async () => ({ ok: false, reason: "port_in_use" }) },
    "admin-token", undefined, { trustedLoopback: true });
  expect(response!.status).toBe(200);
  expect(await response!.json()).toMatchObject({ ok: true, desiredEnabled: true, interceptReason: "port_in_use" });
});

test("Desktop status exposes the picker bind port separately from the CONNECT port", async () => {
  const live = config(); saveConfig(live);
  const url = new URL("http://127.0.0.1:10100/api/claude-desktop/status");
  const response = await handleManagementAPI(new Request(url, { headers: { Host: url.host } }), url, live,
    { getClaudeInterceptState: () => ({ proxyPort: 10200, caCertPath: join(root, "ca.crt"), pickerProxyPort: null, pickerReason: "port_in_use", pickerFailurePort: 10300 }) },
    "admin-token", undefined, { trustedLoopback: true });
  expect(response!.status).toBe(200);
  expect((await response!.json()).firstParty).toMatchObject({ pickerReason: "port_in_use", pickerFailurePort: 10300 });
});
