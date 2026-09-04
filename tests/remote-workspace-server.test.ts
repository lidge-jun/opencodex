import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RemoteWorkspaceHub,
  connectRemoteWorkspaceAgent,
  generateRemoteControlIdentityKeyPair,
  pairRemoteWorkspaceDevice,
  type RemoteWorkspaceDeviceState,
  type RemoteWorkspaceDeviceStateStore,
  type RemoteWorkspaceHubState,
  type RemoteWorkspaceHubStateStore,
  type RemoteWorkspaceSessionService,
} from "../src/remote-control";
import { startServer } from "../src/server";
import { findAvailablePort } from "../src/server/ports";
import type { ManagementAuthState } from "../src/server/management-auth";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

class HubStore implements RemoteWorkspaceHubStateStore {
  state: RemoteWorkspaceHubState | null = null;
  load() { return this.state ? structuredClone(this.state) : null; }
  save(state: RemoteWorkspaceHubState) { this.state = structuredClone(state); }
}

class DeviceStore implements RemoteWorkspaceDeviceStateStore {
  state: RemoteWorkspaceDeviceState | null = null;
  load() { return this.state ? structuredClone(this.state) : null; }
  save(state: RemoteWorkspaceDeviceState) { this.state = structuredClone(state); }
}

const previous = {
  home: process.env.HOME,
  ocx: process.env.OPENCODEX_HOME,
  codex: process.env.CODEX_HOME,
};
let root = "";
let ocxHome = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-remote-server-"));
  const home = join(root, "home");
  const ocx = join(root, "ocx");
  const codex = join(root, "codex");
  mkdirSync(home);
  mkdirSync(ocx);
  mkdirSync(codex);
  process.env.HOME = home;
  process.env.OPENCODEX_HOME = ocx;
  process.env.CODEX_HOME = codex;
  ocxHome = ocx;
});

afterEach(() => {
  for (const [key, value] of [
    ["HOME", previous.home],
    ["OPENCODEX_HOME", previous.ocx],
    ["CODEX_HOME", previous.codex],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) removeTreeWithRetry(root);
  root = "";
  ocxHome = "";
});

function writeTestConfig(value: OcxConfig): void {
  // This integration needs startServer's real load path, but must never call the production
  // persistence helper. The repository test wrapper places this direct fixture write under an
  // isolated OPENCODEX_HOME, and the protected real home remains outside the process namespace.
  writeFileSync(join(ocxHome, "config.json"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    runtimeRole: "hub",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["test-model"],
      },
    },
    subagentModels: [],
    claudeCode: { enabled: false },
    codexAutoStart: false,
  };
}

function managementAuth(): ManagementAuthState {
  return {
    available: true,
    token: "ocx_admin_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno",
    source: "environment",
    sessions: new Map(),
    pairingGrants: new Map(),
  };
}

describe("Remote Workspace hub HTTP and WebSocket integration", () => {
  test("pairs an OCX-only executor and carries encrypted file work over its outbound socket", async () => {
    const workspace = join(root, "computer-2-project");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "marker.txt"), "from-computer-2");
    writeTestConfig(config());
    const hub = new RemoteWorkspaceHub(new HubStore());
    const server = startServer(0, {
      managementAuthState: managementAuth(),
      managementApi: { remoteWorkspaceHub: hub },
    });
    const deviceStore = new DeviceStore();
    let handle: ReturnType<typeof connectRemoteWorkspaceAgent> | null = null;
    try {
      const grant = hub.createPairingGrant();
      const state = await pairRemoteWorkspaceDevice({
        hubUrl: server.url.toString(),
        pairingCode: grant.code,
        name: "Computer 2",
        devicePlatform: "linux-x64",
        roots: [{ path: workspace, label: "Project" }],
        store: deviceStore,
      });
      handle = connectRemoteWorkspaceAgent({ state, commandRunner: null });
      await handle.connected;
      expect(hub.listDevices()[0]).toMatchObject({
        id: state.deviceId,
        online: true,
        name: "Computer 2",
        capabilities: ["workspace.read", "workspace.write"],
      });

      const connection = hub.connection(state.deviceId);
      if (!connection) throw new Error("paired executor did not attach to the hub");
      const sessionId = crypto.randomUUID();
      const transport = await connection.openSession({
        sessionId,
        rootId: state.roots[0]!.id,
        profile: "claude",
      });
      const result = await transport.invoke({
        requestId: crypto.randomUUID(),
        sessionId,
        executorDeviceId: state.deviceId,
        rootId: state.roots[0]!.id,
        tool: "read_file",
        arguments: { path: "marker.txt" },
      });
      expect(result).toMatchObject({ ok: true, value: { content: "from-computer-2" } });
      await connection.closeSession(sessionId);
    } finally {
      handle?.stop();
      if (handle) await handle.closed;
      await server.stop(true);
    }
  }, 15_000);

  test("refuses browser-origin pairing requests", async () => {
    writeTestConfig(config());
    const hub = new RemoteWorkspaceHub(new HubStore());
    const server = startServer(0, {
      managementAuthState: managementAuth(),
      managementApi: { remoteWorkspaceHub: hub },
    });
    try {
      const response = await fetch(new URL("/remote-workspace/pair", server.url), {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(403);
    } finally {
      await server.stop(true);
    }
  });

  test("rate-limits repeated pairing guesses before parsing more bodies and recovers after expiry", async () => {
    writeTestConfig(config());
    let now = Date.parse("2026-09-04T00:00:00.000Z");
    const hub = new RemoteWorkspaceHub(new HubStore(), () => now);
    const server = startServer(0, {
      managementAuthState: managementAuth(),
      managementApi: { remoteWorkspaceHub: hub },
    });
    const identity = generateRemoteControlIdentityKeyPair();
    const body = {
      code: "AAAA-BBBB-CCCC",
      name: "Computer 2",
      platform: "linux-x64",
      publicKey: identity.publicKey,
      roots: [{ id: crypto.randomUUID(), label: "Project" }],
    };
    try {
      for (let attempt = 1; attempt < 10; attempt += 1) {
        const response = await fetch(new URL("/remote-workspace/pair", server.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // None of these caller-controlled identities may choose a public-listener bucket.
            "x-forwarded-for": `192.0.2.${attempt}`,
            "cf-connecting-ip": `198.51.100.${attempt}`,
            "tailscale-user-login": `spoof-${attempt}@example.test`,
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(401);
      }
      const limited = await fetch(new URL("/remote-workspace/pair", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.250",
          "cf-connecting-ip": "203.0.113.251",
          "tailscale-user-login": "last-spoof@example.test",
        },
        body: JSON.stringify(body),
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("600");
      expect(limited.headers.get("cache-control")).toBe("no-store");
      expect(await limited.json()).toEqual({
        error: "Remote Workspace pairing is temporarily rate limited.",
      });

      const blockedBeforeParse = await fetch(new URL("/remote-workspace/pair", server.url), {
        method: "POST",
        body: "not-json",
      });
      expect(blockedBeforeParse.status).toBe(429);

      now += 10 * 60_000 + 1;
      const grant = hub.createPairingGrant();
      const paired = await fetch(new URL("/remote-workspace/pair", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, code: grant.code }),
      });
      expect(paired.status).toBe(201);
    } finally {
      await server.stop(true);
    }
  });

  test("does not let management-ingress callers rotate Tailscale headers around the peer bucket", async () => {
    const managementPort = await findAvailablePort(0, "127.0.0.1");
    writeTestConfig({
      ...config(),
      hub: {
        managementPublicOrigin: "https://hub.example.test",
        managementIngress: { enabled: true, port: managementPort },
      },
    });
    const hub = new RemoteWorkspaceHub(new HubStore());
    const server = startServer(0, {
      managementAuthState: managementAuth(),
      managementApi: { remoteWorkspaceHub: hub },
    });
    const body = JSON.stringify({
      code: "AAAA-BBBB-CCCC",
      name: "Computer 2",
      platform: "linux-x64",
      publicKey: generateRemoteControlIdentityKeyPair().publicKey,
      roots: [{ id: crypto.randomUUID(), label: "Project" }],
    });
    const attempt = async (identity: string): Promise<Response> => await fetch(
      `http://127.0.0.1:${managementPort}/remote-workspace/pair`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "tailscale-user-login": identity,
        },
        body,
      },
    );
    try {
      for (let count = 1; count < 10; count += 1) {
        expect((await attempt(`rotated-${count}@example.test`)).status).toBe(401);
      }
      expect((await attempt("another-identity@example.test")).status).toBe(429);
    } finally {
      await server.stop(true);
    }
  });

  test("stops Remote Workspace runtimes when the Hub listener stops", async () => {
    writeTestConfig(config());
    const hub = new RemoteWorkspaceHub(new HubStore());
    let stopCalls = 0;
    const sessions = {
      async shutdown() { stopCalls += 1; },
    } as unknown as RemoteWorkspaceSessionService;
    const server = startServer(0, {
      managementAuthState: managementAuth(),
      managementApi: { remoteWorkspaceHub: hub, remoteWorkspaceSessions: sessions },
    });
    await server.stop(true);
    expect(stopCalls).toBe(1);
  });

  test("accepts a paired Executor through the loopback management-ingress WebSocket exception", async () => {
    const managementPort = await findAvailablePort(0, "127.0.0.1");
    writeTestConfig({
      ...config(),
      hub: {
        managementPublicOrigin: "https://hub.example.test",
        managementIngress: { enabled: true, port: managementPort },
      },
    });
    const hub = new RemoteWorkspaceHub(new HubStore());
    const server = startServer(0, {
      managementAuthState: managementAuth(),
      managementApi: { remoteWorkspaceHub: hub },
    });
    const workspace = join(root, "management-ingress-executor");
    mkdirSync(workspace);
    let handle: ReturnType<typeof connectRemoteWorkspaceAgent> | null = null;
    try {
      const grant = hub.createPairingGrant();
      const state = await pairRemoteWorkspaceDevice({
        hubUrl: `http://127.0.0.1:${managementPort}`,
        pairingCode: grant.code,
        roots: [{ path: workspace }],
        store: new DeviceStore(),
      });
      handle = connectRemoteWorkspaceAgent({ state, commandRunner: null });
      await handle.connected;
      expect(hub.listDevices()[0]).toMatchObject({ online: true, capabilities: ["workspace.read", "workspace.write"] });
    } finally {
      handle?.stop();
      if (handle) await handle.closed;
      await server.stop(true);
    }
  }, 15_000);
});
