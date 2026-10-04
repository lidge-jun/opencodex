import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleRemoteWorkspaceHubCommand as hubCommand } from "../../src/cli/remote-workspace-hub";
import { runRemoteWorkspaceCommand } from "../../src/cli/remote-workspace";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const realFetch = globalThis.fetch;
const PRIVATE = "unpublished-fixture-value";
const runtimeRows = { codex: { available: true, version: "fixture" }, claude: { available: false, reason: "not installed" }, pi: { available: false } };
const device = { id: "device-a", name: "Fixture", platform: "linux", capabilities: ["workspace.read"],
  roots: [{ id: "root-a", label: "Project", path: PRIVATE }], online: false, createdAt: "2026-01-01T00:00:00Z", lastSeenAt: null, credential: PRIVATE };
const session = { id: "session-a", profile: "codex", accessMode: "read-only", deviceId: "device-a", deviceName: "Fixture",
  rootId: "root-a", rootLabel: "Project", capabilities: ["workspace.read"], tools: ["read_file"], threadId: null,
  resumable: false, status: "ready", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  events: [{ sequence: 0, at: "2026-01-01T00:00:00Z", type: "status", text: "Ready", token: PRIVATE }], token: PRIVATE };
const full = { available: true, devices: [device], runtimes: runtimeRows, sessions: [session], secret: PRIVATE };
let home: TempHome;
let output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-cli-workspace-hub-");
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unowned network forbidden"); });
});
afterEach(() => { network.mockRestore(); output.mockRestore(); errors.mockRestore(); home.remove(); });
function fixture(body: unknown = full, statusCode = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let probes = 0;
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => { probes++; return { hostname: "127.0.0.1", port: 18499, pid: 1, source: "runtime" }; },
    fetchImpl: (async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json(body, { status: statusCode });
    }) as typeof fetch,
  };
  return { calls, deps, probes: () => probes };
}
function jsonOutput() { expect(output.mock.calls).toHaveLength(1); return JSON.parse(String(output.mock.calls[0]![0])); }
function printed() { return [...output.mock.calls, ...errors.mock.calls].flat().join("\n"); }

describe("Hub observations stay separate from the executor", () => {
  for (const [verb, path, body] of [
    ["status", "/api/remote-workspace", full],
    ["runtimes", "/api/remote-workspace/runtimes", { runtimes: runtimeRows, secret: PRIVATE }],
    ["sessions", "/api/remote-workspace/sessions", { sessions: [session], secret: PRIVATE }],
  ] as const) {
    test(`${verb} makes one fixed read and projects public fields`, async () => {
      const f = fixture(body);
      const store = { load: () => { throw new Error("Executor store must not load"); }, save: () => { throw new Error("Executor store must not save"); } };
      expect(await runRemoteWorkspaceCommand(["hub", verb, "--json"], { ...f.deps, store })).toBe(0);
      expect(f.calls).toHaveLength(1);
      expect(f.probes()).toBe(1);
      expect(new URL(f.calls[0]!.url).pathname).toBe(path);
      expect(f.calls[0]!.init?.method ?? "GET").toBe("GET");
      expect(f.calls[0]!.init?.body).toBeUndefined();
      expect(f.calls[0]!.init?.redirect).toBe("error");
      expect(printed()).not.toContain(PRIVATE);
      expect(errors.mock.calls).toHaveLength(0);
      const result = jsonOutput();
      if (verb === "runtimes") expect(result).toEqual({ runtimes: runtimeRows });
      if (verb === "sessions") {
        expect(result.sessions[0].events).toEqual([{ sequence: 0, at: "2026-01-01T00:00:00Z", type: "status", text: "Ready" }]);
        expect(result.sessions[0].threadId).toBeNull();
      }
      if (verb === "status") expect(result.devices[0].roots).toEqual([{ id: "root-a", label: "Project" }]);
    });
  }
  test("available empty state has a next action and succeeds", async () => {
    expect(await hubCommand([], fixture({ ...full, devices: [], sessions: [] }).deps)).toBe(0);
    expect(printed()).toContain("No paired devices");
    expect(printed()).toContain("Hub dashboard");
  });
  test("empty sessions are not an unavailable Hub", async () => {
    expect(await hubCommand(["sessions"], fixture({ sessions: [] }).deps)).toBe(0);
    expect(printed()).toContain("No Remote Workspace sessions");
  });
  test("terminal output escapes device control characters", async () => {
    expect(await hubCommand(["status"], fixture({ ...full, devices: [{ ...device, name: "Name\u001b[31m" }] }).deps)).toBe(0);
    expect(printed()).not.toContain("\u001b");
  });
  for (const args of [["pair"], ["sessions", "--yes"], ["status", "extra"], ["--json", "--json"], ["runtimes", "--profile", "codex"]]) {
    test(`invalid Hub invocation refuses before discovery: ${args.join(" ")}`, async () => {
      const f = fixture();
      expect(await hubCommand(args, f.deps)).toBe(2);
      expect(f.probes()).toBe(0);
      expect(f.calls).toHaveLength(0);
    });
  }
  for (const body of [null, { runtimes: [] }, { runtimes: { codex: { available: true } } }, { runtimes: { ...runtimeRows, pi: { available: "false" } } }]) {
    test(`malformed runtime shape is not successful: ${JSON.stringify(body)}`, async () => {
      expect(await hubCommand(["runtimes", "--json"], fixture(body).deps)).toBe(1);
      expect(output.mock.calls).toHaveLength(0);
    });
  }
  test("unknown session status or tool cannot be presented as a valid session", async () => {
    expect(await hubCommand(["sessions", "--json"], fixture({ sessions: [{ ...session, tools: ["arbitrary-command"] }] }).deps)).toBe(1);
    expect(output.mock.calls).toHaveLength(0);
  });
  for (const verb of ["status", "runtimes", "sessions"]) {
    test(`${verb} recognizes outer-dispatch unavailable HTTP200`, async () => {
      const f = fixture({ available: false, reason: PRIVATE, devices: [], runtimes: {}, sessions: [] });
      expect(await hubCommand([verb, "--json"], f.deps)).toBe(1);
      expect(jsonOutput()).toMatchObject({ available: false, runtimes: {}, devices: [], sessions: [] });
      expect(printed()).toContain("OCX_REMOTE_WORKSPACE_ENABLED=1");
      expect(printed()).not.toContain(PRIVATE);
    });
  }
  for (const code of [401, 404, 409, 503]) {
    test(`HTTP${code} stays nonzero without exposing backend errors`, async () => {
      expect(await hubCommand(["status", "--json"], fixture({ error: PRIVATE }, code).deps)).toBe(code === 404 ? 4 : code === 409 ? 5 : 1);
      expect(output.mock.calls).toHaveLength(0);
      expect(printed()).not.toContain(PRIVATE);
    });
  }
  test("client-role and stopped targets cannot fall through to HTTP", async () => {
    const f = fixture();
    expect(await hubCommand([], { ...f.deps, findLiveProxy: async () => null })).toBe(1);
    expect(await hubCommand([], { ...f.deps, findLiveProxy: async () => ({ port: 18499, hostname: "127.0.0.1", pid: 1, source: "runtime", role: "client" }) })).toBe(1);
    expect(f.calls).toHaveLength(0);
  });
  test("actual fetch refuses a redirect without reaching the second owned endpoint", async () => {
    let secondRequests = 0;
    const second = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { secondRequests++; return Response.json(full); } });
    const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(second.url.href, 307); } });
    try {
      expect(await hubCommand(["status", "--json"], { baseUrl: first.url.href, fetchImpl: realFetch })).toBe(1);
      expect(secondRequests).toBe(0);
      expect(output.mock.calls).toHaveLength(0);
    } finally { await first.stop(true); await second.stop(true); }
  });
});

test("actual outer management owner returns available and disabled observations without executor effects", async () => {
  const { handleManagementAPI } = await import("../../src/server/management-api");
  const { RemoteWorkspaceHub } = await import("../../src/remote-control/workspace-hub");
  const { RemoteWorkspaceSessionService } = await import("../../src/remote-control/workspace-sessions");
  const hub = new RemoteWorkspaceHub({ load: () => null, save: () => {} });
  const sessions = new RemoteWorkspaceSessionService(hub, []);
  const oldEnabled = process.env.OCX_REMOTE_WORKSPACE_ENABLED;
  process.env.OCX_REMOTE_WORKSPACE_ENABLED = "1";
  try {
    for (const runtimeRole of ["hub", "standalone"] as const) for (const verb of ["status", "runtimes", "sessions"] as const) {
      output.mockClear();
      const config = { port: 18499, runtimeRole, defaultProvider: "none", providers: {} };
      const fetchImpl: typeof fetch = (async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers); headers.set("host", url.host);
        const response = await handleManagementAPI(new Request(url, { ...init, headers }), url, config,
          { remoteWorkspaceHub: hub, remoteWorkspaceSessions: sessions }, "admin-token");
        if (!response) throw new Error("Expected real management response");
        return response;
      }) as typeof fetch;
      expect(await hubCommand([verb, "--json"], { baseUrl: "http://127.0.0.1:18499", fetchImpl })).toBe(runtimeRole === "hub" ? 0 : 1);
      const result = jsonOutput();
      if (runtimeRole === "standalone" || verb === "status") {
        expect(result.available).toBe(runtimeRole === "hub");
        expect(result.devices).toEqual([]);
      }
      if (runtimeRole === "standalone" || verb !== "runtimes") expect(result.sessions).toEqual([]);
      if (runtimeRole === "hub" && verb !== "sessions") expect(Object.keys(result.runtimes)).toEqual(["codex", "claude", "pi"]);
    }
  } finally {
    await sessions.shutdown(); hub.closeAllConnections();
    if (oldEnabled === undefined) delete process.env.OCX_REMOTE_WORKSPACE_ENABLED;
    else process.env.OCX_REMOTE_WORKSPACE_ENABLED = oldEnabled;
  }
});
