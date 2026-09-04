import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { handleManagementAPI } from "../src/server/management-api";
import {
  RemoteWorkspaceHub,
  generateRemoteControlIdentityKeyPair,
  type RemoteWorkspaceHubState,
  type RemoteWorkspaceHubStateStore,
  type RemoteWorkspaceSessionService,
} from "../src/remote-control";
import type { OcxConfig } from "../src/types";

class MemoryStore implements RemoteWorkspaceHubStateStore {
  state: RemoteWorkspaceHubState | null = null;
  load() { return this.state ? structuredClone(this.state) : null; }
  save(state: RemoteWorkspaceHubState) { this.state = structuredClone(state); }
}

const hubConfig = {
  port: 10100,
  runtimeRole: "hub",
  defaultProvider: "none",
  providers: {},
} as OcxConfig;

async function call(
  config: OcxConfig,
  hub: RemoteWorkspaceHub,
  method: string,
  path: string,
  principal: "admin-token" | "gui-session" = "gui-session",
  body?: unknown,
  sessions: RemoteWorkspaceSessionService = emptySessions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const req = new Request(url, {
    method,
    headers: { host: "127.0.0.1:10100", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleManagementAPI(req, url, config, {
    remoteWorkspaceHub: hub,
    remoteWorkspaceSessions: sessions,
  }, principal);
  if (!response) throw new Error("Remote Workspace management route was not mounted");
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const emptySessions = {
  async availability() {
    return {
      codex: { available: true, version: "test" },
      claude: { available: false, reason: "not installed" },
      pi: { available: false, reason: "not installed" },
    };
  },
  list: () => [],
} as unknown as RemoteWorkspaceSessionService;

describe("Remote Workspace management routes", () => {
  test("lists devices and requires a GUI consent session to create enrollment grants", async () => {
    const hub = new RemoteWorkspaceHub(new MemoryStore());
    const initial = await call(hubConfig, hub, "GET", "/api/remote-workspace", "admin-token");
    expect(initial).toEqual({
      status: 200,
      body: {
        available: true,
        devices: [],
        runtimes: {
          codex: { available: true, version: "test" },
          claude: { available: false, reason: "not installed" },
          pi: { available: false, reason: "not installed" },
        },
        sessions: [],
      },
    });
    const denied = await call(hubConfig, hub, "POST", "/api/remote-workspace/pairing", "admin-token");
    expect(denied.status).toBe(403);
    const created = await call(hubConfig, hub, "POST", "/api/remote-workspace/pairing");
    expect(created.status).toBe(201);
    expect(created.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(Date.parse(String(created.body.expiresAt))).toBeGreaterThan(Date.now());
  });

  test("revokes only the selected paired computer", async () => {
    const hub = new RemoteWorkspaceHub(new MemoryStore());
    const grant = hub.createPairingGrant();
    const paired = hub.pairDevice({
      code: grant.code,
      name: "Computer 2",
      platform: "linux-x64",
      publicKey: generateRemoteControlIdentityKeyPair().publicKey,
      roots: [{ id: randomUUID(), label: "Project" }],
    });
    const denied = await call(
      hubConfig,
      hub,
      "DELETE",
      `/api/remote-workspace/devices/${paired.device.id}`,
      "admin-token",
    );
    expect(denied.status).toBe(403);
    const revoked = await call(hubConfig, hub, "DELETE", `/api/remote-workspace/devices/${paired.device.id}`);
    expect(revoked).toEqual({ status: 200, body: { ok: true } });
    expect(hub.listDevices()).toEqual([]);
  });

  test("reports that a standalone proxy is not a Remote Workspace hub", async () => {
    const hub = new RemoteWorkspaceHub(new MemoryStore());
    const config = { ...hubConfig, runtimeRole: "standalone" as const };
    const result = await call(config, hub, "GET", "/api/remote-workspace");
    expect(result.status).toBe(409);
    expect(result.body.available).toBe(false);
  });

  test("requires a GUI session for session mutations and routes the selected target", async () => {
    const hub = new RemoteWorkspaceHub(new MemoryStore());
    const sessionId = randomUUID();
    const calls: unknown[] = [];
    const summary = {
      id: sessionId,
      profile: "codex" as const,
      accessMode: "read-only" as const,
      deviceId: randomUUID(),
      deviceName: "Computer 2",
      rootId: randomUUID(),
      rootLabel: "Project",
      capabilities: ["workspace.read", "workspace.write", "workspace.exec"] as const,
      tools: ["list_directory", "read_file", "write_file", "exec"] as const,
      threadId: "thread-1",
      resumable: true,
      status: "ready" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      events: [],
    };
    const sessions = {
      availability: emptySessions.availability.bind(emptySessions),
      list: () => [summary],
      async create(input: unknown) { calls.push(["create", input]); return summary; },
      async prompt(id: string, prompt: unknown) { calls.push(["prompt", id, prompt]); return summary; },
      async stop(id: string) { calls.push(["stop", id]); return true; },
    } as unknown as RemoteWorkspaceSessionService;

    const denied = await call(
      hubConfig,
      hub,
      "POST",
      "/api/remote-workspace/sessions",
      "admin-token",
      { profile: "codex", deviceId: summary.deviceId, rootId: summary.rootId },
      sessions,
    );
    expect(denied.status).toBe(403);
    const created = await call(
      hubConfig,
      hub,
      "POST",
      "/api/remote-workspace/sessions",
      "gui-session",
      { profile: "codex", deviceId: summary.deviceId, rootId: summary.rootId },
      sessions,
    );
    expect(created.status).toBe(201);
    const prompted = await call(
      hubConfig,
      hub,
      "POST",
      `/api/remote-workspace/sessions/${sessionId}/prompt`,
      "gui-session",
      { prompt: "Run on Computer 2" },
      sessions,
    );
    expect(prompted.status).toBe(200);
    const stopped = await call(
      hubConfig,
      hub,
      "DELETE",
      `/api/remote-workspace/sessions/${sessionId}`,
      "gui-session",
      undefined,
      sessions,
    );
    expect(stopped.status).toBe(200);
    expect(calls).toEqual([
      ["create", { profile: "codex", deviceId: summary.deviceId, rootId: summary.rootId, accessMode: "read-only" }],
      ["prompt", sessionId, "Run on Computer 2"],
      ["stop", sessionId],
    ]);
  });
});
