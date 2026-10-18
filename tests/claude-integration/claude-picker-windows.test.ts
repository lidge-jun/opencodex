import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { flushConfigDirHardeningAndReaps, hardenConfigDir } from "../../src/config/paths";
import { resetHardenedStateForTests, setAsyncIcaclsRunnerForTests, setPlatformForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { supportsDesktopPicker } from "../../src/claude/desktop-picker-platform";
import { inspectDesktopPickerProfile } from "../../src/claude/desktop-picker-profile";
import { createPickerRuntime, pickerDesired } from "../../src/claude/intercept/picker-runtime";
import { startPickerListener } from "../../src/claude/intercept/picker-listener";
import { claudeInterceptCaCertPath, createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { startConnectProxy } from "../../src/claude/intercept/connect-proxy";
import { isBrowserConnect } from "../../src/claude/intercept/connect-proxy";
import { pickerCaCertPath, pickerCaFingerprints } from "../../src/claude/intercept/picker-ca";
import {
  getClaudePickerController,
  getClaudePickerRuntime,
  startClaudeIntercept,
} from "../../src/claude/intercept/runtime";
import type { SecurityResult, SecurityRunner } from "../../src/claude/intercept/picker-trust";
import { filePickerCaStore, memoryPickerCaStore } from "../helpers/picker-ca-store";
import type { OcxConfig } from "../../src/types";

const roots: string[] = [];
const handles: Array<Awaited<ReturnType<typeof startClaudeIntercept>>> = [];
const priorHome = process.env.OPENCODEX_HOME;
const priorDesktop = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
const priorClaude = process.env.CLAUDE_CONFIG_DIR;

// Config reads may leave an ACL child holding a root open after intercept stop.
// Drain hardening and reaps before retrying removal; retain failures and restore env.
async function cleanupPickerWindows(remove: (dir: string) => void = removeTreeWithRetry): Promise<void> {
  const failures: unknown[] = [];
  for (const handle of handles.splice(0)) {
    try { await handle?.stop(); } catch (error) { failures.push(error); }
  }
  for (const dir of roots.splice(0)) {
    try {
      await flushConfigDirHardeningAndReaps(dir);
      remove(dir);
    } catch (error) { failures.push(error); }
  }
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = priorHome;
  if (priorDesktop === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR; else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = priorDesktop;
  if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "picker-windows cleanup failed");
}
afterEach(() => cleanupPickerWindows());

const routes = async () => ({ nativeSlugs: [], routedModels: [] });

function setup(firstParty = true) {
  const root = mkdtempSync(join(tmpdir(), "ocx-picker-win-"));
  roots.push(root);
  process.env.OPENCODEX_HOME = root;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "desktop");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  const config = {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    claudeCode: { desktopMode: firstParty ? "first-party" : "gateway", intercept: { port: 10200 } },
  } as OcxConfig;
  saveConfig(config);
  return { root, config };
}

test("Windows fixture cleanup waits for pending config-directory ACL hardening", async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const { root } = setup();
  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setAsyncIcaclsRunnerForTests(async () => {
    started();
    await blocked;
    return { success: true, exitCode: 0, timedOut: false, stdout: "" };
  });
  let cleanup: Promise<void> | undefined;
  try {
    hardenConfigDir();
    await entered;
    cleanup = cleanupPickerWindows();
    await Promise.resolve();
    expect(existsSync(root)).toBe(true);
    release();
    await cleanup;
    expect(existsSync(root)).toBe(false);
    expect(process.env.OPENCODEX_HOME).toBe(priorHome);
    expect(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR).toBe(priorDesktop);
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(priorClaude);
  } finally {
    release();
    try {
      await flushConfigDirHardeningAndReaps(root);
      await cleanup;
    } finally {
      setAsyncIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
    }
  }
});

test("Windows fixture cleanup attempts every stop and root and preserves both failures", async () => {
  const first = setup().root, second = setup().root;
  let laterStops = 0;
  const attempted: string[] = [];
  const stopError = new Error("stop failed");
  const removeError = new Error("EBUSY: resource busy or locked");
  type Handle = Awaited<ReturnType<typeof startClaudeIntercept>>;
  handles.push({ stop: async () => { throw stopError; } } as unknown as Handle);
  handles.push({ stop: async () => { laterStops++; } } as unknown as Handle);
  try {
    let failure: unknown;
    try {
      await cleanupPickerWindows(dir => {
        attempted.push(dir);
        if (dir === first) throw removeError;
        removeTreeWithRetry(dir);
      });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([stopError, removeError]);
    expect(laterStops).toBe(1);
    expect(attempted).toEqual([first, second]);
    expect(existsSync(second)).toBe(false);
    expect(process.env.OPENCODEX_HOME).toBe(priorHome);
    expect(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR).toBe(priorDesktop);
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(priorClaude);
  } finally {
    await flushConfigDirHardeningAndReaps(first);
    await flushConfigDirHardeningAndReaps(second);
    removeTreeWithRetry(first);
    removeTreeWithRetry(second);
  }
});

// Synthetic Windows trust matching src/claude/intercept/picker-trust-windows.ts.
// The runner receives powershell argv (exe resolved by the default runner, so
// argv begins with -NoLogo): inspect uses the read-only prefix plus a script
// built by buildWindowsTrustInspectScript (X509Store CurrentUser Root exact
// thumbprint lookup, OCX_PICKER_TRUST=TRUSTED with exit 0 or UNTRUSTED with
// exit 1); install uses the interactive prefix plus $store.Add with
// OCX_PICKER_TRUST=INSTALLED; removal uses $store.Remove with
// OCX_PICKER_TRUST=REMOVED. The fake answers exactly that format and never
// spawns a process or touches a real store.
function windowsTrust(state: { trusted: boolean }) {
  const calls: string[][] = [];
  const mutations: string[] = [];
  const run: SecurityRunner = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] !== "-NoLogo") throw new Error("win32 trust argv must begin with -NoLogo, got: " + String(args[0]));
    if (!args.includes("-Command")) throw new Error("win32 trust argv must include -Command");
    const script = String(args[args.length - 1] ?? "");
    if (!script.includes("OCX_PICKER_TRUST=")) throw new Error("win32 trust script must emit OCX_PICKER_TRUST=");
    if (!script.includes("X509Store")) throw new Error("win32 trust script must use X509Store");
    if (script.includes("$store.Add")) {
      state.trusted = true;
      mutations.push("add");
      return { code: 0, stdout: "OCX_PICKER_TRUST=INSTALLED\n", stderr: "" } as SecurityResult;
    }
    if (script.includes("$store.Remove")) {
      state.trusted = false;
      mutations.push("remove");
      return { code: 0, stdout: "OCX_PICKER_TRUST=REMOVED\n", stderr: "" } as SecurityResult;
    }
    if (state.trusted) {
      return { code: 0, stdout: "OCX_PICKER_TRUST=TRUSTED\n", stderr: "" } as SecurityResult;
    }
    return { code: 1, stdout: "OCX_PICKER_TRUST=UNTRUSTED\n", stderr: "" } as SecurityResult;
  };
  return { run, calls, mutations, state };
}

test("win32 is a supported picker platform with first-party desired", () => {
  expect(supportsDesktopPicker("win32")).toBe(true);
  expect(supportsDesktopPicker("darwin")).toBe(true);
  expect(supportsDesktopPicker("linux")).toBe(false);
  const firstParty = { claudeCode: { desktopMode: "first-party" } } as OcxConfig;
  expect(pickerDesired(firstParty, "first-party", "win32")).toBe(true);
  expect(pickerDesired(firstParty, "first-party", "linux")).toBe(false);
  expect(pickerDesired(firstParty, "gateway", "win32")).toBe(false);
});

test("Windows startup wires the picker proxy and controller while discarding legacy key", async () => {
  const { root, config } = setup(true);
  mkdirSync(join(root, "claude-picker"), { recursive: true });
  writeFileSync(join(root, "claude-picker", "ca.key"), "legacy-test-key");
  const trust = windowsTrust({ trusted: true });
  const fake = memoryPickerCaStore();
  let binds = 0;
  const handle = await startClaudeIntercept({
    config, configDir: root, publicPort: 10100,
    dispatch: async () => new Response(),
    loadPickerRoutes: routes,
    pickerPlatform: "win32",
    pickerCaStore: fake.store,
    pickerSecurity: trust.run,
    startProxy: async (_port, options) => { binds++; return startConnectProxy(0, options); },
  });
  handles.push(handle);
  expect(existsSync(join(root, "claude-picker", "ca.key"))).toBe(false);
  expect(binds).toBe(2);
  expect(handle?.pickerProxyPort).not.toBeNull();
  expect(getClaudePickerController()).not.toBeNull();
  expect(getClaudePickerRuntime()).not.toBeNull();
  const runtime = getClaudePickerRuntime()!;
  expect(runtime.status()).toMatchObject({ supported: true, desired: true });
  for (const call of trust.calls) {
    expect(call[0]).toBe("-NoLogo");
    expect(call).toContain("-Command");
    expect(String(call[call.length - 1])).toContain("OCX_PICKER_TRUST=");
  }
}, 30_000);

test("explicit enable on Windows activates the picker profile once trusted", async () => {
  const { root, config } = setup(true);
  const trust = windowsTrust({ trusted: false });
  const fake = memoryPickerCaStore();
  const handle = await startClaudeIntercept({
    config, configDir: root, publicPort: 10100,
    dispatch: async () => new Response(),
    loadPickerRoutes: routes,
    pickerPlatform: "win32",
    pickerCaStore: fake.store,
    pickerSecurity: trust.run,
    startProxy: async (_port, options) => startConnectProxy(0, options),
  });
  handles.push(handle);
  const controller = getClaudePickerController()!;
  const enabled = await controller.enable({ persist: false, context: "server" });
  expect(enabled.supported).toBe(true);
  expect(enabled.trust).toBe("trusted");
  expect(enabled.profile).toBe("applied");
  expect(enabled.effective).toBe(true);
  expect(trust.mutations).toContain("add");
  const inspected = inspectDesktopPickerProfile({ configDir: root, platform: "win32" });
  expect(inspected.kind).toBe("applied");
  if (inspected.kind === "applied") {
    expect(inspected.proxyUrl).toBe("http://127.0.0.1:" + String(handle?.pickerProxyPort));
  }
}, 30_000);

for (const disabledBy of ["preference", "desktop-integration", "gateway-mode"] as const) {
  test(`Windows management enable binds the dormant picker after ${disabledBy} changes`, async () => {
    const { root, config } = setup(disabledBy !== "gateway-mode");
    if (disabledBy === "preference") config.claudeCode!.intercept!.picker = false;
    if (disabledBy === "desktop-integration") config.clientIntegrations = { "claude-desktop": false };
    saveConfig(config);
    const trust = windowsTrust({ trusted: false });
    const fake = memoryPickerCaStore();
    const proxies: Array<Awaited<ReturnType<typeof startConnectProxy>>> = [];
    let failBind = false;
    const handle = await startClaudeIntercept({
      config, configDir: root, publicPort: 10100,
      dispatch: async () => new Response(), loadPickerRoutes: routes,
      pickerPlatform: "win32", pickerCaStore: fake.store, pickerSecurity: trust.run,
      startProxy: async (_port, options) => {
        if (failBind) throw Object.assign(new Error("test occupied port"), { code: "EADDRINUSE" });
        const proxy = await startConnectProxy(0, options);
        proxies.push(proxy);
        return proxy;
      },
    });
    handles.push(handle);
    expect(proxies).toHaveLength(1);
    expect(handle?.pickerProxyPort).toBeNull();
    expect(trust.calls).toEqual([]);
    expect(existsSync(pickerCaCertPath(root))).toBe(false);
    expect(await getClaudePickerController()!.status()).toMatchObject({ listenerReady: false, effective: false });
    expect(await getClaudePickerController()!.enable({ persist: false, context: "server" })).toMatchObject({ effective: false });
    expect(proxies).toHaveLength(1);
    expect(trust.calls).toEqual([]);

    config.claudeCode!.desktopMode = "first-party";
    config.clientIntegrations = { "claude-desktop": true };
    saveConfig(config);
    const url = new URL("http://127.0.0.1:10100/api/claude-desktop/picker");
    const enable = async () => handleManagementAPI(new Request(url, {
      method: "PUT", headers: { Host: url.host, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, persist: true }),
    }), url, config, {}, "admin-token", undefined, { trustedLoopback: true });
    if (disabledBy === "preference") {
      failBind = true;
      expect((await enable())?.status).toBe(409);
      expect(handle?.pickerReason).toBe("port_in_use");
      expect(handle?.pickerProxyPort).toBeNull();
      expect(trust.calls).toEqual([]);
      failBind = false;
    }
    const [response, repeated] = await Promise.all([enable(), enable()]);
    expect(response?.status).toBe(200);
    expect(repeated?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: true, picker: { effective: true, profile: "applied", trust: "trusted" } });
    expect(proxies).toHaveLength(2);
    expect(handle?.pickerProxyPort).toBe(proxies[1]!.port);
    expect(handle?.pickerReason).toBeNull();
    expect(inspectDesktopPickerProfile({ configDir: root, platform: "win32" })).toMatchObject({
      kind: "applied", proxyUrl: `http://127.0.0.1:${proxies[1]!.port}`,
    });
    expect((await enable())?.status).toBe(200);
    expect(proxies).toHaveLength(2);
    await handle!.stop();
    handles.splice(handles.indexOf(handle), 1);
    await expect(fetch(`http://127.0.0.1:${proxies[1]!.port}`)).rejects.toThrow();
  }, 30_000);
}

test("Windows reload retains fingerprint and issues no trust mutations", async () => {
  const { root, config } = setup(true);
  const storePath = join(root, "test-only-store");
  const trust = windowsTrust({ trusted: false });
  const first = await startClaudeIntercept({
    config, configDir: root, publicPort: 10100,
    dispatch: async () => new Response(),
    loadPickerRoutes: routes,
    pickerPlatform: "win32",
    pickerCaStore: filePickerCaStore(storePath),
    pickerSecurity: trust.run,
    startProxy: async (_port, options) => startConnectProxy(0, options),
  });
  handles.push(first);
  await getClaudePickerController()!.enable({ persist: false, context: "server" });
  const fingerprint = pickerCaFingerprints(readFileSync(pickerCaCertPath(root), "utf8")).sha256;
  await first.stop();
  handles.splice(0, handles.length);
  trust.mutations.splice(0, trust.mutations.length);
  trust.calls.splice(0, trust.calls.length);
  const second = await startClaudeIntercept({
    config, configDir: root, publicPort: 10100,
    dispatch: async () => new Response(),
    loadPickerRoutes: routes,
    pickerPlatform: "win32",
    pickerCaStore: filePickerCaStore(storePath),
    pickerSecurity: trust.run,
    startProxy: async (_port, options) => startConnectProxy(0, options),
  });
  handles.push(second);
  expect(pickerCaFingerprints(readFileSync(pickerCaCertPath(root), "utf8")).sha256).toBe(fingerprint);
  expect(trust.mutations).toEqual([]);
  const status = await getClaudePickerController()!.status();
  expect(status.supported).toBe(true);
}, 30_000);

test("Windows off removes picker trust and profile but keeps unrelated entries", async () => {
  const { root, config } = setup(true);
  const desktop = join(root, "desktop");
  mkdirSync(desktop, { recursive: true });
  const foreignId = "foreign-personal";
  writeFileSync(join(desktop, foreignId + ".json"), '{"foreign":true}\n');
  writeFileSync(join(desktop, "_meta.json"), JSON.stringify({ appliedId: foreignId, entries: [{ id: foreignId, name: "Personal" }] }, null, 2) + "\n");
  const trust = windowsTrust({ trusted: false });
  const fake = memoryPickerCaStore();
  const handle = await startClaudeIntercept({
    config, configDir: root, publicPort: 10100,
    dispatch: async () => new Response(),
    loadPickerRoutes: routes,
    pickerPlatform: "win32",
    pickerCaStore: fake.store,
    pickerSecurity: trust.run,
    startProxy: async (_port, options) => startConnectProxy(0, options),
  });
  handles.push(handle);
  const controller = getClaudePickerController()!;
  await controller.enable({ persist: false, context: "server" });
  expect(trust.state.trusted).toBe(true);
  const off = await controller.disable({ persist: false });
  expect(trust.state.trusted).toBe(false);
  expect(off.effective).toBe(false);
  const meta = JSON.parse(readFileSync(join(desktop, "_meta.json"), "utf8")) as { appliedId?: string; entries: Array<{ id: string; name: string }> };
  expect(meta.entries.some(e => e.id === foreignId)).toBe(true);
  expect(meta.entries.some(e => e.name === "opencodex-picker")).toBe(false);
  expect(existsSync(join(desktop, foreignId + ".json"))).toBe(true);
  expect(inspectDesktopPickerProfile({ configDir: root, platform: "win32" }).kind).not.toBe("applied");
}, 30_000);

test("Windows CONNECT chooser separates browser claude.ai from CLI api.anthropic.com", async () => {
  const { root, config } = setup(true);
  const trust = windowsTrust({ trusted: true });
  const fake = memoryPickerCaStore();
  let pickerSelect: ((host: string, port: number, req: { userAgent: string | null }) => unknown) | null = null;
  const handle = await startClaudeIntercept({
    config, configDir: root, publicPort: 10100,
    dispatch: async () => new Response(),
    loadPickerRoutes: routes,
    pickerPlatform: "win32",
    pickerCaStore: fake.store,
    pickerSecurity: trust.run,
    startProxy: async (_port, options) => {
      if (options.selectTunnel) pickerSelect = options.selectTunnel as never;
      return startConnectProxy(0, options);
    },
  });
  handles.push(handle);
  expect(pickerSelect).not.toBeNull();
  const browser = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
  const cli = { userAgent: null };
  expect(isBrowserConnect(browser)).toBe(true);
  expect(isBrowserConnect(cli)).toBe(false);
  const pick = pickerSelect!;
  expect(await pick("claude.ai", 443, browser)).toMatchObject({ kind: "intercept" });
  expect(await pick("claude.ai", 443, cli)).toMatchObject({ kind: "blind" });
  expect(await pick("api.anthropic.com", 443, cli)).toMatchObject({ kind: "intercept" });
  const browserApi = await pick("api.anthropic.com", 443, browser) as unknown;
  expect(browserApi === null || (browserApi as { kind: string }).kind === "blind").toBe(true);
}, 30_000);

function tlsViaPicker(port: number, authority: string, servername: string, caPem: string, userAgent: string | null): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const plain = connect({ host: "127.0.0.1", port }, () => {
      const ua = userAgent ? "User-Agent: " + userAgent + "\r\n" : "";
      plain.write("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n" + ua + "\r\n");
    });
    let head = "";
    const timer = setTimeout(() => { plain.destroy(); reject(new Error("CONNECT timed out")); }, 10_000);
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      const status = Number(/HTTP\/1\.1 (\d{3})/.exec(head)?.[1]);
      if (status !== 200) {
        clearTimeout(timer);
        plain.destroy();
        reject(new Error("CONNECT refused with " + status));
        return;
      }
      clearTimeout(timer);
      plain.off("data", onData);
      plain.removeAllListeners("error");
      const tls = tlsConnect({ socket: plain, servername, ca: caPem, rejectUnauthorized: true });
      tls.once("secureConnect", () => resolve(tls));
      tls.once("error", reject);
    };
    plain.on("data", onData);
    plain.once("error", err => { clearTimeout(timer); reject(err); });
  });
}

function readHttp(socket: TLSSocket, payload: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("HTTP exchange timed out")); }, 10_000);
    socket.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.once("close", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("binary");
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) { reject(new Error("HTTP response without headers")); return; }
      const status = Number(/HTTP\/1\.1 (\d{3})/.exec(raw)?.[1]);
      resolve({ status, body: Buffer.from(raw.slice(split + 4), "binary") });
    });
    socket.once("error", err => { clearTimeout(timer); reject(err); });
    socket.write(payload);
  });
}

async function httpsGet(socket: TLSSocket, host: string, path: string): Promise<{ status: number; body: Buffer }> {
  return readHttp(socket, "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\nAccept-Encoding: identity\r\n\r\n");
}

async function httpsPost(socket: TLSSocket, host: string, path: string, json: string): Promise<{ status: number; body: Buffer }> {
  return readHttp(socket,
    "POST " + path + " HTTP/1.1\r\nHost: " + host + "\r\nContent-Type: application/json\r\nContent-Length: " + String(Buffer.byteLength(json)) + "\r\nConnection: close\r\n\r\n" + json);
}

test("Windows picker carries real CONNECT+TLS end to end for browser bootstrap and CLI messages", async () => {
  const { root, config } = setup(true);
  const upstreamCa = createLocalInterceptCa();
  const upstreamLeaf = issueLocalInterceptLeaf(upstreamCa, ["claude.ai"]);
  const nativeBootstrap = { model_selector_config: [{ id: "code", models: [{ id: "claude-native", name: "Native", section: "main" }] }] };
  const upstreamSockets = new Set<import("node:net").Socket>();
  const upstream = createHttpsServer({ cert: upstreamLeaf.certPem, key: upstreamLeaf.keyPem }, (req, res) => {
    if (req.method === "GET" && (req.url === "/api/bootstrap" || req.url?.startsWith("/api/bootstrap?"))) {
      const body = Buffer.from(JSON.stringify(nativeBootstrap));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) });
      res.end(body);
      return;
    }
    if (req.method === "GET" && req.url === "/v1/other") {
      const body = Buffer.from(JSON.stringify({ native: "passthrough" }));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) });
      res.end(body);
      return;
    }
    res.writeHead(404, { "Content-Length": "0" });
    res.end();
  });
  upstream.on("secureConnection", socket => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const trust = windowsTrust({ trusted: true });
  const fake = memoryPickerCaStore();
  const routed = async () => ({ nativeSlugs: [], routedModels: [{ provider: "xai", id: "grok-test", contextWindow: 256_000 }] });
  const handle = await startClaudeIntercept({
    config, configDir: root, publicPort: 10100,
    dispatch: async req => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/messages") return Response.json({ dispatched: true });
      return new Response("unexpected", { status: 500 });
    },
    loadPickerRoutes: routed,
    pickerPlatform: "win32",
    pickerCaStore: fake.store,
    pickerSecurity: trust.run,
    createPicker: options => createPickerRuntime({
      ...options,
      readConfig: () => config,
      resolveMode: () => "first-party",
      startListener: listenerOptions => startPickerListener({
        ...listenerOptions,
        upstream: { host: "127.0.0.1", port: upstreamPort, servername: "claude.ai", ca: upstreamCa.certPem },
      }),
    }),
    startProxy: async (_port, options) => startConnectProxy(0, options),
  });
  handles.push(handle);
  try {
    await getClaudePickerController()!.enable({ persist: false, context: "server" });
    const pickerPort = handle?.pickerProxyPort!;
    expect(pickerPort).toBeGreaterThan(0);
    const browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    const pickerCa = readFileSync(pickerCaCertPath(root), "utf8");
    const bootstrapTls = await tlsViaPicker(pickerPort, "claude.ai:443", "claude.ai", pickerCa, browserUA);
    try {
      const bootstrap = await httpsGet(bootstrapTls, "claude.ai", "/api/bootstrap");
      expect(bootstrap.status).toBe(200);
      const catalog = JSON.parse(bootstrap.body.toString("utf8")) as { model_selector_config: Array<{ models: Array<{ id: string }> }> };
      const ids = catalog.model_selector_config.flatMap(surface => surface.models.map(entry => entry.id));
      expect(ids).toContain("claude-native");
      expect(ids).toContain("ocx-claude-xai--grok-test");
    } finally {
      bootstrapTls.destroy();
    }
    const otherTls = await tlsViaPicker(pickerPort, "claude.ai:443", "claude.ai", pickerCa, browserUA);
    try {
      const other = await httpsGet(otherTls, "claude.ai", "/v1/other");
      expect(other.status).toBe(200);
      expect(other.body.toString("utf8")).toBe(JSON.stringify({ native: "passthrough" }));
    } finally {
      otherTls.destroy();
    }
    const mainCa = readFileSync(claudeInterceptCaCertPath(root), "utf8");
    const cli = await tlsViaPicker(pickerPort, "api.anthropic.com:443", "api.anthropic.com", mainCa, null);
    try {
      const posted = await httpsPost(cli, "api.anthropic.com", "/v1/messages", JSON.stringify({ model: "claude-x" }));
      expect(posted.status).toBe(200);
      expect((JSON.parse(posted.body.toString("utf8")) as { dispatched: boolean }).dispatched).toBe(true);
    } finally {
      cli.destroy();
    }
  } finally {
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}, 60_000);
