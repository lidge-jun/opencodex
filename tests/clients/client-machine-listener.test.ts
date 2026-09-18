import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startMachineListener } from "../../src/client/machine-listener";
import { serveGuiFile } from "../../src/server/gui-static";
import type { OcxClientConnectionConfig, OcxConfig } from "../../src/types";
import { RemoteWorkspaceSessionService } from "../../src/remote-control/workspace-sessions";
import type { RemoteWorkspaceHub } from "../../src/remote-control/workspace-hub";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementAuthState } from "../../src/server/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

let root = "";
let previousHome: string | undefined;
const servers: Server<unknown>[] = [];

const connection = (transport: "direct" | "relay" = "direct"): OcxClientConnectionConfig => ({
  serverUrl: "https://hub.example.test",
  managementUrl: "https://hub.example.test",
  managementTransport: transport,
  selectedClients: ["codex"],
  tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
  apiKeyId: "client-key-a",
  tokenFingerprint: "a".repeat(64),
  protocolVersion: 1,
  connectedAt: "2026-08-28T00:00:00.000Z",
  catalogSyncedAt: "2026-08-28T00:01:00.000Z",
});

function authState(): ManagementAuthState {
  return {
    available: true,
    token: `ocx_admin_${"a".repeat(43)}`,
    source: "environment",
    sessions: new Map(),
    pairingGrants: new Map(),
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-machine-listener-"));
  process.env.OPENCODEX_HOME = root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify({
    port: 0,
    hostname: "0.0.0.0",
    providers: {},
    defaultProvider: "openai",
  }));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (root) removeTreeWithRetry(root);
});

function meta(html: string, name: string): string {
  const match = new RegExp(`<meta name="${name}" content="([^"]+)"`).exec(html);
  if (!match?.[1]) throw new Error(`missing ${name}`);
  return match[1];
}

async function guiHeaders(server: Server<unknown>, mutation = false): Promise<Headers> {
  const bootstrap = await fetch(new URL("/opencodex-session", server.url));
  const html = await bootstrap.text();
  const headers = new Headers({
    "X-OpenCodex-API-Key": meta(html, "opencodex-session-token"),
    "X-OpenCodex-GUI-Origin": meta(html, "opencodex-session-origin"),
  });
  if (mutation) {
    headers.set("Origin", meta(html, "opencodex-session-origin"));
    headers.set("X-OpenCodex-CSRF-Token", meta(html, "opencodex-session-csrf"));
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

describe("client machine listener", () => {
  test("relayed workspace prompt acknowledges acceptance before the model turn completes", async () => {
    const oldEnabled = process.env.OCX_REMOTE_WORKSPACE_ENABLED;
    process.env.OCX_REMOTE_WORKSPACE_ENABLED = "1";
    const deviceId = "11111111-1111-4111-8111-111111111111";
    const rootId = "22222222-2222-4222-8222-222222222222";
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    let completed = false;
    let observeCompletion = false;
    let terminal!: () => void;
    const settled = new Promise<void>(resolve => { terminal = resolve; });
    const hub = {
      listDevices: () => [{ id: deviceId, name: "Executor", roots: [{ id: rootId, label: "Project" }], capabilities: ["workspace.read"], online: true }],
      connection: () => ({
        capabilities: () => ["workspace.read"],
        openSession: async () => ({ isOnline: () => true, invoke: async () => ({ ok: true, value: null }) }),
        closeSession: async () => {},
      }),
    } as unknown as RemoteWorkspaceHub;
    const sessions = new RemoteWorkspaceSessionService(hub, [{
      profile: "codex", available: async () => ({ available: true }),
      start: async () => ({ threadId: "relay-thread", prompt: async () => { await held; completed = true; }, stop: async () => { finish(); } }),
    }], Date.now, {
      load: () => null,
      save: state => { if (observeCompletion && state.sessions.some(session => session.status === "ready")) terminal(); },
    });
    const hubConfig = { port: 0, hostname: "0.0.0.0", runtimeRole: "hub", hub: { managementPublicOrigin: "https://hub.example.test" }, defaultProvider: "none", providers: {} } as OcxConfig;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const created = await sessions.create({ profile: "codex", deviceId, rootId });
      observeCompletion = true;
      const server = startMachineListener(0, {
        state: connection("relay"), managementAuthState: authState(),
        fetchImpl: (async (input, init) => {
          const request = new Request(String(input), init);
          request.headers.set("Host", new URL(request.url).host);
          return await handleManagementAPI(request, new URL(request.url), hubConfig, {
            remoteWorkspaceHub: hub, remoteWorkspaceSessions: sessions,
          }, "gui-session") ?? new Response(null, { status: 404 });
        }) as typeof fetch,
      });
      servers.push(server);
      const local = await guiHeaders(server, true);
      hubConfig.corsAllowOrigins = [local.get("Origin")!];
      const headers = new Headers({
        Origin: local.get("Origin")!, "Content-Type": "application/json",
        "X-OpenCodex-Machine-Session": local.get("X-OpenCodex-API-Key")!,
        "X-OpenCodex-Machine-GUI-Origin": local.get("X-OpenCodex-GUI-Origin")!,
        "X-OpenCodex-Machine-CSRF-Token": local.get("X-OpenCodex-CSRF-Token")!,
        "X-OpenCodex-API-Key": "ocx_session_hub",
        "X-OpenCodex-GUI-Origin": local.get("X-OpenCodex-GUI-Origin")!,
        "X-OpenCodex-CSRF-Token": "fixture-hub-csrf",
      });
      const prefix = "/api/machine/hub-relay/api/remote-workspace/sessions";
      const acknowledged = await Promise.race([
        fetch(new URL(`${prefix}/${created.id}/prompt`, server.url), { method: "POST", headers, body: JSON.stringify({ prompt: "Held turn" }) }),
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("relay waited for model completion")), 5_000); }),
      ]);
      expect(acknowledged.status).toBe(202);
      const accepted = await acknowledged.json() as { id: string; status: string; events: Array<{ sequence: number }> };
      expect(accepted.id).toBe(created.id);
      expect(accepted.status).toBe("running");
      expect(completed).toBe(false);
      const cursor = accepted.events.at(-1)!.sequence;
      finish();
      await settled;
      const poll = await fetch(new URL(prefix, server.url), { headers });
      const state = await poll.json() as { sessions: Array<{ status: string; events: Array<{ sequence: number }> }> };
      expect(state.sessions[0]!.status).toBe("ready");
      expect(state.sessions[0]!.events.at(-1)!.sequence).toBeGreaterThan(cursor);
    } finally {
      clearTimeout(deadline);
      finish();
      await sessions.stopAll();
      if (oldEnabled === undefined) delete process.env.OCX_REMOTE_WORKSPACE_ENABLED;
      else process.env.OCX_REMOTE_WORKSPACE_ENABLED = oldEnabled;
    }
  }, 15_000);

  test("binds IPv4 loopback and default-denies shared/data-plane routes", async () => {
    const server = startMachineListener(0, { state: connection(), managementAuthState: authState() });
    servers.push(server);
    expect(server.hostname).toBe("127.0.0.1");
    expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
    expect((await fetch(new URL("/readyz", server.url))).status).toBe(200);
    expect((await fetch(new URL("/opencodex-session", server.url))).headers.get("content-type")).toContain("text/html");
    for (const path of [
      "/v1/responses", "/v1/models", "/v1/catalog", "/api/config", "/api/usage",
      "/api/oauth/providers", "/lab", "/oauth/callback", "/api/machine/unknown",
    ]) {
      const response = await fetch(new URL(path, server.url), { method: path === "/v1/responses" ? "POST" : "GET" });
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe("not_found");
    }
    expect((await fetch(new URL("/api/machine/hub-relay/api/config", server.url))).status).toBe(404);
    expect((await fetch(new URL("/api/machine/status", server.url), { method: "POST" })).status).toBe(404);
  });

  test("requires a GUI session for safe reads and Origin plus CSRF for mutations", async () => {
    let syncCalls = 0;
    const server = startMachineListener(0, {
      state: connection(),
      managementAuthState: authState(),
      machineApi: {
        sync: async () => { syncCalls += 1; return { catalogWritten: false, cacheSynced: true, injected: true, stale: false }; },
      },
    });
    servers.push(server);
    const statusUrl = new URL("/api/machine/status", server.url);
    expect((await fetch(statusUrl)).status).toBe(401);
    expect((await fetch(statusUrl, { headers: { "X-OpenCodex-API-Key": `ocx_admin_${"a".repeat(43)}` } })).status).toBe(401);

    const safeHeaders = await guiHeaders(server);
    const status = await fetch(statusUrl, { headers: safeHeaders });
    expect(status.status).toBe(200);
    const body = await status.json();
    expect(body).toMatchObject({ mode: "client", connected: true, apiKeyId: "client-key-a", managementTransport: "direct" });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("tokenFingerprint");
    expect(serialized).not.toContain("a".repeat(64));

    const syncUrl = new URL("/api/machine/sync", server.url);
    expect((await fetch(syncUrl, { method: "POST", headers: safeHeaders, body: "{}" })).status).toBe(401);
    expect(syncCalls).toBe(0);
    const mutationHeaders = await guiHeaders(server, true);
    expect((await fetch(syncUrl, { method: "POST", headers: mutationHeaders, body: "{}" })).status).toBe(200);
    expect(syncCalls).toBe(1);
  });

  test("disconnect commits before 202 and schedules standalone recycle while the hub is offline", async () => {
    let disconnected = false;
    let recycled = false;
    const server = startMachineListener(0, {
      state: connection(),
      managementAuthState: authState(),
      machineApi: {
        disconnect: async () => {
          disconnected = true;
          return { restored: true, tokenRemoved: true, catalogRemoved: true, apiKeyId: "client-key-a" };
        },
        scheduleStandaloneRecycle: () => { recycled = disconnected; },
      },
    });
    servers.push(server);
    const response = await fetch(new URL("/api/machine/disconnect", server.url), {
      method: "POST",
      headers: await guiHeaders(server, true),
      body: "{}",
    });
    expect(response.status).toBe(202);
    expect(disconnected).toBe(true);
    expect(recycled).toBe(true);
  });

  test("refuses startup without matching durable connected state", () => {
    expect(() => startMachineListener(0, { managementAuthState: authState() })).toThrow(/requires connected client state/);
  });
});

describe("the served document states the client role", () => {
  // The GUI decides whether a machine plane exists from this tag alone
  // (gui/src/api-targets.ts `isConnectedRuntime` / `discoverApiTargets`). A missing tag is
  // not cosmetic: discovery returns standalone targets immediately and never queries
  // /api/machine/status, so a connected client renders as a plain install — no hub usage
  // scope, no "this machine" panel, no connected-client list.
  //
  // Asserted against `serveGuiFile` directly rather than over HTTP, because the listener
  // falls through to a JSON payload when `gui/dist` is absent, and a checkout without a
  // GUI build would make an HTTP-level assertion pass vacuously.
  test("the client dashboard document carries the role tag", () => {
    const dist = mkdtempSync(join(tmpdir(), "ocx-gui-dist-"));
    try {
      writeFileSync(join(dist, "index.html"), "<!doctype html><html><head></head><body></body></html>");
      const response = serveGuiFile("/", dist, undefined, "client");
      expect(response).not.toBeNull();
      return response!.text().then(html => {
        expect(meta(html, "opencodex-runtime-role")).toBe("client");
      });
    } finally {
      removeTreeWithRetry(dist);
    }
  });

  test("the listener asks for the client role rather than leaving it undefined", () => {
    // Source-level, deliberately: the call is what carries the role, and the HTTP path
    // cannot show it in a checkout with no GUI build. Reading the file keeps the
    // assertion honest in both cases.
    const source = readFileSync(
      repoPath("src", "client", "machine-listener.ts"),
      "utf8",
    );
    const call = /serveGuiFile\(([^)]*)\)/.exec(source);
    expect(call, "machine-listener no longer calls serveGuiFile").not.toBeNull();
    expect(call![1]).toContain('"client"');
  });
});
