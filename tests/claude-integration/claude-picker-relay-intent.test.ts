import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { applyDesktopPickerProfile, inspectDesktopPickerProfile } from "../../src/claude/desktop-picker-profile";
import { startConnectProxy, type ConnectProxyOptions } from "../../src/claude/intercept/connect-proxy";
import type { PickerRuntime } from "../../src/claude/intercept/picker-runtime";
import { getClaudePickerRuntime, startClaudeIntercept } from "../../src/claude/intercept/runtime";
import type { OcxConfig } from "../../src/types";
import { memoryPickerCaStore } from "../helpers/picker-ca-store";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { isolateClientLifecycleLock } from "../helpers/client-lifecycle-lock";

const envKeys = ["OPENCODEX_HOME", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] as const;
let previous: Array<string | undefined>;
let root: string;
let lifecycleLock: ReturnType<typeof isolateClientLifecycleLock>;
let config: OcxConfig;
let handle: Awaited<ReturnType<typeof startClaudeIntercept>>;
let upstream: Server | undefined;
const binds: Array<{ requested: number; port: number; options: ConnectProxyOptions }> = [];

beforeEach(() => {
  previous = envKeys.map(key => process.env[key]);
  root = mkdtempSync(join(tmpdir(), "ocx-picker-relay-intent-"));
  lifecycleLock = isolateClientLifecycleLock(root);
  process.env.OPENCODEX_HOME = root;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "desktop");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  config = {
    port: 10100, providers: {}, defaultProvider: "openai",
    claudeCode: { desktopMode: "first-party", intercept: { picker: true } },
  } as OcxConfig;
  binds.length = 0;
});

afterEach(async () => {
  try {
    await handle?.stop();
    if (upstream) await new Promise<void>((resolve, reject) => upstream!.close(error => error ? reject(error) : resolve()));
  } finally {
    lifecycleLock.restore();
    handle = null;
    upstream = undefined;
    envKeys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    removeTreeWithRetry(root);
  }
});

async function start(platform: NodeJS.Platform = "win32", recovery = false) {
  saveConfig(config);
  handle = await startClaudeIntercept({
    config, configDir: root, publicPort: 10100, pickerPlatform: platform,
    dispatch: async () => new Response("unused"),
    loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
    pickerCaStore: recovery ? () => { throw new Error("picker_ca_store_unavailable"); } : memoryPickerCaStore().store,
    pickerSecurity: async () => { throw new Error("unexpected trust operation"); },
    createPicker: () => ({
      start: async () => {}, stop: async () => {}, selectTunnel: () => ({ kind: "blind" }),
    }) as unknown as PickerRuntime,
    // Exercise the real CONNECT handlers without probing or reserving a fixed port.
    startProxy: async (requested, options) => {
      const proxy = await startConnectProxy(0, {
        ...options, dialUpstream: (_host, port) => connect({ host: "127.0.0.1", port }),
      });
      binds.push({ requested, port: proxy.port, options });
      return proxy;
    },
  });
  expect(handle).not.toBeNull();
}

async function connectStatus(proxyPort: number, targetPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: proxyPort });
    let head = "";
    socket.setTimeout(2000, () => socket.destroy(new Error("CONNECT timed out")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`CONNECT relay-test.invalid:${targetPort} HTTP/1.1\r\nHost: relay-test.invalid:${targetPort}\r\n\r\n`));
    socket.on("data", bytes => {
      head += bytes.toString();
      if (head.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(head.split("\r\n")[0]!);
      }
    });
  });
}

async function expectRelayBound() {
  expect(binds).toHaveLength(2);
  expect(handle?.pickerProxyPort).toBe(binds[1]!.port);
  expect(binds[0]!.options.authToken).toBeFunction();
  expect(binds[1]!.options.authToken).toBeUndefined();
  upstream = createServer(socket => socket.on("data", bytes => socket.write(bytes)));
  await new Promise<void>(resolve => upstream!.listen(0, "127.0.0.1", resolve));
  const targetPort = (upstream.address() as { port: number }).port;
  expect(await connectStatus(binds[0]!.port, targetPort)).toContain("407");
  expect(await connectStatus(binds[1]!.port, targetPort)).toContain("200");
}

for (const disabledBy of ["preference", "desktop-integration", "gateway-mode"] as const) {
  test(`Windows with ${disabledBy} off binds no picker relay`, async () => {
    if (disabledBy === "preference") config.claudeCode!.intercept!.picker = false;
    if (disabledBy === "desktop-integration") config.clientIntegrations = { "claude-desktop": false };
    if (disabledBy === "gateway-mode") config.claudeCode!.desktopMode = "gateway";
    await start();
    expect(binds).toHaveLength(1);
    expect(handle?.pickerProxyPort).toBeNull();
    expect(getClaudePickerRuntime()).toBeNull();
    expect(await connectStatus(binds[0]!.port, 9)).toContain("407");
  });
}

test("Windows with picker intent on binds the picker relay", async () => {
  await start();
  expect(getClaudePickerRuntime()).not.toBeNull();
  await expectRelayBound();
});

// Applying the fixture takes the real lifecycle lock and hardens files with Windows
// identity/ACL subprocesses. Match the existing picker restart tests' native-I/O budget.
test("Windows selected profile retains blind recovery with picker and Desktop intent off", { timeout: 30_000 }, async () => {
  config.claudeCode!.intercept!.picker = false;
  config.clientIntegrations = { "claude-desktop": false };
  const library = join(root, "desktop");
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, "_meta.json"), JSON.stringify({
    appliedId: "personal", entries: [{ id: "personal", name: "Personal" }],
  }));
  writeFileSync(join(library, "personal.json"), "{}\n");
  expect(applyDesktopPickerProfile({ configDir: root, platform: "win32", proxyPort: 32123 })).toMatchObject({ ok: true });
  const selected = inspectDesktopPickerProfile({ configDir: root, platform: "win32" });
  expect(selected.kind).toBe("applied");
  const statePath = join(root, "claude-picker", "profile-state.json");
  const stateBefore = readFileSync(statePath, "utf8");
  await start("win32", true);
  expect(getClaudePickerRuntime()).toBeNull();
  expect(handle?.pickerReason).toBe("failed");
  expect(binds[1]!.requested).toBe(32123);
  expect(await binds[1]!.options.selectTunnel!("claude.ai", 443, { userAgent: "Mozilla/5.0" })).toEqual({ kind: "blind" });
  expect(await binds[1]!.options.selectTunnel!("api.anthropic.com", 443, { userAgent: null })).toEqual({ kind: "blind" });
  await expectRelayBound();
  expect(inspectDesktopPickerProfile({ configDir: root, platform: "win32" })).toEqual(selected);
  expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
});

test("macOS retains its existing dormant picker relay with picker intent off", async () => {
  config.claudeCode!.intercept!.picker = false;
  await start("darwin");
  await expectRelayBound();
});
