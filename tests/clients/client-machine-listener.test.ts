import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startMachineListener } from "../../src/client/machine-listener";
import { writeHubCredential } from "../../src/client/hub-session";
import { handleMachineApi } from "../../src/client/machine-api";
import { serveGuiFile } from "../../src/server/gui-static";
import type { OcxClientConnectionConfig, OcxConfig } from "../../src/types";
import type { ManagementAuthState } from "../../src/server/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { replaceServiceApiTokenFile, serviceApiTokenFingerprint, writeServiceApiTokenFile } from "../../src/lib/service-secrets";
import type { ClientLinkSupervisorStatus } from "../../src/client/link-tunnel";
import * as clientState from "../../src/client/state";

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
  test("refuses dashboard workspace reads and prompts before any Hub call", async () => {
    let upstreamCalls = 0;
    const server = startMachineListener(0, {
      state: connection("relay"), managementAuthState: authState(),
      fetchImpl: (async () => { upstreamCalls++; return Response.json({ unexpected: true }); }) as typeof fetch,
    });
    servers.push(server);
    const local = await guiHeaders(server, true);
    const headers = {
      Origin: local.get("Origin")!,
      "X-OpenCodex-Machine-Session": local.get("X-OpenCodex-API-Key")!,
      "X-OpenCodex-Machine-GUI-Origin": local.get("X-OpenCodex-GUI-Origin")!,
      "X-OpenCodex-Machine-CSRF-Token": local.get("X-OpenCodex-CSRF-Token")!,
      "X-OpenCodex-API-Key": "ocx_session_hub",
    };
    const prefix = "/api/machine/hub-relay/api/remote-workspace/sessions";
    expect((await fetch(new URL(prefix, server.url), { headers })).status).toBe(404);
    expect((await fetch(new URL(prefix + "/fixture/prompt", server.url), {
      method: "POST", headers, body: JSON.stringify({ prompt: "Fixture turn" }),
    })).status).toBe(404);
    expect(upstreamCalls).toBe(0);
  });

  test("binds IPv4 loopback and default-denies shared/data-plane routes", async () => {
    const server = startMachineListener(0, { state: connection(), managementAuthState: authState() });
    servers.push(server);
    expect(server.hostname).toBe("127.0.0.1");
    expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
    expect((await fetch(new URL("/readyz", server.url))).status).toBe(200);
    expect((await fetch(new URL("/opencodex-session", server.url))).headers.get("content-type")).toContain("text/html");
    // Data plane, GUI routes and unknown machine paths stay local 404s.
    for (const path of [
      "/v1/responses", "/v1/models", "/v1/catalog", "/lab", "/oauth/callback", "/api/machine/unknown",
    ]) {
      const response = await fetch(new URL(path, server.url), { method: path === "/v1/responses" ? "POST" : "GET" });
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe("not_found");
    }
    // Bare management paths require local authority. Direct transport has no GUI relay.
    for (const path of ["/api/config", "/api/usage", "/api/oauth/providers", "/api/machine/hub-relay/api/config"]) {
      expect({ path, status: (await fetch(new URL(path, server.url))).status }).toEqual({ path, status: path.startsWith("/api/machine/") ? 404 : 401 });
    }
    // A known machine endpoint with an unsupported method now reaches the
    // authenticated method restriction instead of collapsing to a bare 404.
    expect((await fetch(new URL("/api/machine/status", server.url), { method: "POST" })).status).toBe(401);
  });

  test("allows GUI-session reads but refuses mutations from a credentialless bootstrap", async () => {
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
    expect((await fetch(statusUrl, { method: "HEAD", headers: safeHeaders })).status).toBe(200);
    const body = await status.json();
    expect(body).toMatchObject({ mode: "client", connected: true, apiKeyId: "client-key-a", managementTransport: "direct" });
    expect(body).not.toHaveProperty("relayTargetCheck");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("tokenFingerprint");
    expect(serialized).not.toContain("a".repeat(64));

    const syncUrl = new URL("/api/machine/sync", server.url);
    expect((await fetch(syncUrl, { method: "POST", headers: safeHeaders, body: "{}" })).status).toBe(401);
    expect(syncCalls).toBe(0);
    const mutationHeaders = await guiHeaders(server, true);
    expect((await fetch(syncUrl, { method: "POST", headers: mutationHeaders, body: "{}" })).status).toBe(403);
    expect((await fetch(new URL("/api/machine/shim", server.url), {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ action: "uninstall" }),
    })).status).toBe(403);
    expect((await fetch(statusUrl, { method: "POST", headers: mutationHeaders, body: "{}" })).status).toBe(403);
    expect(syncCalls).toBe(0);
  });

  test("hub relay status advertises expected-target-v1", async () => {
    const server = startMachineListener(0, {
      state: connection("relay"),
      managementAuthState: authState(),
    });
    servers.push(server);
    const status = await fetch(new URL("/api/machine/status", server.url), { headers: await guiHeaders(server) });
    expect(status.status).toBe(200);
    const body = await status.json() as { relayTargetCheck?: string };
    expect(body.relayTargetCheck).toBe("expected-target-v1");
  });

  test("does not let a bootstrapped GUI session disconnect or recycle the machine", async () => {
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
        scheduleStandaloneRecycle: tokenFingerprint => {
          recycled = disconnected && tokenFingerprint === connection().tokenFingerprint;
        },
      },
    });
    servers.push(server);
    const response = await fetch(new URL("/api/machine/disconnect", server.url), {
      method: "POST",
      headers: await guiHeaders(server, true),
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(disconnected).toBe(false);
    expect(recycled).toBe(false);
  });

  test("machine api disconnect recycles through the injected schedule and skips it on failure", async () => {
    const recycled: string[] = [];
    const state = connection();
    const url = new URL("/api/machine/disconnect", "https://client.example.test");
    const request = (): Request => new Request(url, { method: "POST", body: JSON.stringify({}) });
    const deps = {
      sync: async () => ({ catalogWritten: false, cacheSynced: true, injected: true, stale: false }),
      disconnect: async () => ({ restored: true, tokenRemoved: true, catalogRemoved: true, apiKeyId: state.apiKeyId }),
      scheduleStandaloneRecycle: (tokenFingerprint: string) => { recycled.push(tokenFingerprint); },
    };

    const okResponse = await handleMachineApi(request(), url, state, deps);
    expect(okResponse?.status).toBe(202);
    expect(recycled).toEqual([state.tokenFingerprint]);

    recycled.length = 0;
    const failedResponse = await handleMachineApi(request(), url, state, {
      ...deps,
      disconnect: async () => { throw new Error("disconnect failed"); },
    });
    expect(failedResponse?.status).toBe(409);
    expect(recycled).toEqual([]);
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

describe("client machine listener in link mode", () => {
  const LINK_KEY = `ocx_data_${"e".repeat(40)}`;
  const TUNNEL_PORT = 23456;
  const linkConnection = (fingerprint = serviceApiTokenFingerprint(LINK_KEY)): OcxClientConnectionConfig => ({
    serverUrl: `http://127.0.0.1:${TUNNEL_PORT}`,
    managementUrl: `http://127.0.0.1:${TUNNEL_PORT}`,
    managementTransport: "direct",
    transport: "link",
    link: { tunnelPort: TUNNEL_PORT, linkId: `lnk_${"b".repeat(16)}` },
    selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "link-key-1",
    tokenFingerprint: fingerprint,
    protocolVersion: 1,
    connectedAt: "2026-09-26T00:00:00.000Z",
  });
  const writeKey = () => writeFileSync(join(root, "service-api-token"), `${LINK_KEY}\n`, { mode: 0o600 });

  test("readiness reports durable connection divergence even when the tunnel is ready", async () => {
    const state = linkConnection();
    const save = (client: unknown, runtimeRole: string | undefined = "client") => {
      writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, providers: {}, runtimeRole, client }));
    };
    save(state);
    const server = startMachineListener(0, {
      state, managementAuthState: authState(), linkReadiness: () => ({ ready: true }),
    });
    servers.push(server);
    expect((await fetch(new URL("/readyz", server.url))).status).toBe(200);
    const headers = await guiHeaders(server);
    expect((await fetch(new URL("/api/machine/status", server.url), { headers })).status).toBe(200);
    for (const next of [undefined, { ...state, link: { ...state.link!, linkId: `lnk_${"c".repeat(16)}` } },
      { ...state, connectedAt: "2026-09-27T00:00:00.000Z" }]) {
      save(next, next ? "client" : undefined);
      const response = await fetch(new URL("/readyz", server.url));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "pending", link: { state: "unavailable", reason: "client_state_changed" } });
      for (const path of ["/api/machine/status", "/api/machine/clients", "/api/link/status"]) {
        const status = await fetch(new URL(path, server.url), { headers });
        expect(status.status).toBe(503);
        expect(await status.json()).toEqual({ error: "client_state_changed" });
      }
    }
  });

  test("readiness rechecks durable ownership after an in-flight tunnel probe", async () => {
    const state = linkConnection();
    writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, providers: {}, runtimeRole: "client", client: state }));
    let resolveProbe!: () => void;
    let notifyProbe!: () => void;
    const started = new Promise<void>(resolve => { notifyProbe = resolve; });
    const pending = new Promise<void>(resolve => { resolveProbe = resolve; });
    const server = startMachineListener(0, {
      state, managementAuthState: authState(), linkReadiness: async () => { notifyProbe(); await pending; return { ready: true }; },
    });
    servers.push(server);
    const reads = spyOn(clientState, "readClientConnectionState");
    try {
      const responsePromise = fetch(new URL("/readyz", server.url));
      await started;
      writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, providers: {} }));
      resolveProbe();
      const response = await responsePromise;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ link: { state: "unavailable", reason: "client_state_changed" } });
      expect(reads).toHaveBeenCalledTimes(1);
    } finally { resolveProbe(); reads.mockRestore(); }
  });

  test("durable state is read once per readiness and never for unrelated machine routes", async () => {
    const state = linkConnection();
    writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, providers: {}, runtimeRole: "client", client: state }));
    const server = startMachineListener(0, { state, managementAuthState: authState(), linkReadiness: () => ({ ready: true }) });
    servers.push(server);
    const headers = await guiHeaders(server);
    const reads = spyOn(clientState, "readClientConnectionState");
    try {
      expect((await fetch(new URL("/readyz", server.url))).status).toBe(200);
      expect(reads).toHaveBeenCalledTimes(1);
      reads.mockClear();
      expect((await fetch(new URL("/api/machine/not-a-route", server.url), { headers })).status).toBe(404);
      expect(reads).not.toHaveBeenCalled();
      expect((await fetch(new URL("/api/machine/status", server.url), { headers })).status).toBe(200);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally { reads.mockRestore(); }
  });

  function linkListener(options: {
    fingerprint?: string;
    linkStatus?: () => ClientLinkSupervisorStatus;
    serve?: (options: Parameters<typeof Bun.serve>[0]) => Server<unknown>;
    reply?: () => Response;
  } = {}) {
    const upstream: Request[] = [];
    writeFileSync(join(root, "config.json"), JSON.stringify({
      port: 0, providers: {}, runtimeRole: "client", client: linkConnection(options.fingerprint),
    }));
    const server = startMachineListener(0, {
      state: linkConnection(options.fingerprint),
      managementAuthState: authState(),
      linkTunnel: { connected: () => ({ kind: "match" }), pending: () => false, waitForConnected: async () => true },
      fetchImpl: (async (input, init) => {
        upstream.push(new Request(String(input), init));
        return options.reply?.() ?? Response.json({ relayed: true });
      }) as typeof fetch,
      readSidecar: () => ({
        linkId: `lnk_${"b".repeat(16)}`, alias: "home-mac", hubHostKeyFingerprint: `SHA256:${"a".repeat(43)}`,
        peerListenerPort: 45678, tunnelPort: TUNNEL_PORT,
      }),
      ...(options.linkStatus ? { linkStatus: options.linkStatus } : {}),
      ...(options.serve ? { serve: options.serve } : {}),
    });
    servers.push(server);
    return { server, upstream };
  }

  test("refuses a non-loopback Host or a foreign Origin before any upstream fetch", async () => {
    writeKey();
    const { server, upstream } = linkListener();
    const url = new URL("/v1/responses", server.url);
    const post = (headers: Record<string, string>) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" });
    const rebinding = await post({ Host: "evil.example" });
    expect(rebinding.status).toBe(403);
    const crossSite = await post({ Origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    expect(upstream).toHaveLength(0);
    for (const refused of [rebinding, crossSite]) expect(await refused.text()).not.toContain(LINK_KEY);
    const allowed = await post({ Origin: `http://127.0.0.1:${server.port}` });
    expect(allowed.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.headers.get("authorization")).toBe(`Bearer ${LINK_KEY}`);
  });

  test("answers a Responses WebSocket upgrade with 426 so Codex falls back to HTTP", async () => {
    writeKey();
    const { server, upstream } = linkListener();
    const response = await fetch(new URL("/v1/responses", server.url), {
      headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" },
    });
    expect(response.status).toBe(426);
    expect(JSON.stringify(await response.json())).toContain("upgrade_required");
    expect(upstream).toHaveLength(0);
  });

  test("answers /readyz locally instead of relaying it to the Home", async () => {
    writeKey();
    const { server, upstream } = linkListener();
    const response = await fetch(new URL("/readyz", server.url));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ role: "client", status: "ready", pid: process.pid });
    expect(upstream).toHaveLength(0);
  });

  test("refuses to relay without the committed link key", async () => {
    writeKey();
    const { server, upstream } = linkListener({ fingerprint: "f".repeat(64) });
    const response = await fetch(new URL("/v1/responses", server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toEqual({ error: "link_credential_unavailable" });
    expect(upstream).toHaveLength(0);
  });

  test("keeps the standalone idle limit and data-plane body limit on its socket", () => {
    writeKey();
    let captured: Parameters<typeof Bun.serve>[0] | undefined;
    linkListener({ serve: options => { captured = options; return Bun.serve(options); } });
    expect((captured as { idleTimeout?: number }).idleTimeout).toBe(255);
    expect((captured as { maxRequestBodySize?: number }).maxRequestBodySize).toBe(256 * 1024 * 1024);
  });

  test("a relayed stream survives a quiet stretch longer than the listener's idle limit", async () => {
    writeKey();
    const encoder = new TextEncoder();
    // Bun sweeps idle sockets every 4 s, so idleTimeout 1 cuts a socket within 4 s of its last
    // byte. A 5 s gap between two SSE events stands in for a long reasoning pause at 255 s.
    const { server, upstream } = linkListener({
      serve: options => Bun.serve({ ...options, idleTimeout: 1 } as Parameters<typeof Bun.serve>[0]),
      reply: () => new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("data: first\n\n"));
          await Bun.sleep(5_000);
          controller.enqueue(encoder.encode("data: last\n\n"));
          controller.close();
        },
      }), { headers: { "Content-Type": "text/event-stream" } }),
    });
    const response = await fetch(new URL("/v1/responses", server.url), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: first\n\ndata: last\n\n");
    expect(upstream).toHaveLength(1);
  }, 15_000);

  test("hub transport keeps its management-relay socket bounds", () => {
    let captured: Parameters<typeof Bun.serve>[0] | undefined;
    servers.push(startMachineListener(0, {
      state: connection(), managementAuthState: authState(),
      serve: options => { captured = options; return Bun.serve(options); },
    }));
    expect((captured as { idleTimeout?: number }).idleTimeout).toBeUndefined();
    expect((captured as { maxRequestBodySize?: number }).maxRequestBodySize).toBe(4 * 1024 * 1024);
  });

  test("serves the Child's own link status to a GUI session and nothing else", async () => {
    writeKey();
    const { server } = linkListener({
      linkStatus: () => ({ kind: "tunnel", linkId: `lnk_${"b".repeat(16)}`, state: { kind: "connected", since: Date.parse("2026-09-26T01:00:00.000Z") }, pid: 4242 }),
    });
    const url = new URL("/api/link/status", server.url);
    expect((await fetch(url)).status).toBe(401);
    const headers = await guiHeaders(server);
    const status = await fetch(url, { headers });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      role: "child",
      listener: { state: "off", port: null },
      links: [],
      child: { alias: "home-mac", state: "connected", since: "2026-09-26T01:00:00.000Z", reason: null },
      joinAvailable: false,
    });
    expect((await fetch(url, { method: "POST", headers: await guiHeaders(server, true), body: "{}" })).status).toBe(404);

    const machine = await fetch(new URL("/api/machine/status", server.url), { headers });
    const body = await machine.json() as {
      machineBase: string; sharedBase: string; sharedServerOrigin: string; managementTransport: string; relayTargetCheck?: string; link?: unknown;
    };
    // #6957: the dashboard's shared plane is this listener's relay base, read-only, to the Home.
    expect(body.sharedBase).toBe(`${body.machineBase}/api/machine/hub-relay`);
    expect(body.managementTransport).toBe("relay");
    // Link mode is read-only; it does not advertise a mutation target check.
    expect(body).not.toHaveProperty("relayTargetCheck");
    expect(body.link).toEqual({ linkId: `lnk_${"b".repeat(16)}`, home: "home-mac", readOnly: true });
    expect(body.sharedServerOrigin).toBe(body.machineBase);
    expect(body.machineBase).toBe(`http://127.0.0.1:${server.port}`);
  });

  test("relays an allowlisted dashboard read to the Home with the link key and no browser credential", async () => {
    writeKey();
    const { server, upstream } = linkListener({ reply: () => Response.json([{ name: "home-provider" }]) });
    const url = new URL("/api/machine/hub-relay/api/providers", server.url);
    expect((await fetch(url)).status).toBe(401);
    expect(upstream).toHaveLength(0);

    const headers = await guiHeaders(server);
    headers.set("Cookie", "browser=1");
    const relayed = await fetch(url, { headers });
    expect(relayed.status).toBe(200);
    expect(await relayed.json()).toEqual([{ name: "home-provider" }]);
    expect(upstream).toHaveLength(1);
    const sent = upstream[0]!;
    expect(sent.url).toBe(`http://127.0.0.1:${TUNNEL_PORT}/v1/link-management/api/providers`);
    expect(sent.method).toBe("GET");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${LINK_KEY}`);
    for (const name of ["x-opencodex-api-key", "x-opencodex-gui-origin", "cookie", "origin"]) {
      expect({ name, value: sent.headers.get(name) }).toEqual({ name, value: null });
    }
  });

  test("refuses every change and every unlisted read with the Child refusal, before any request", async () => {
    writeKey();
    const { server, upstream } = linkListener();
    const cases: Array<[string, string]> = [
      ["PUT", "/api/machine/hub-relay/api/settings"],
      ["POST", "/api/machine/hub-relay/api/providers"],
      ["GET", "/api/machine/hub-relay/api/logs"],
      ["GET", "/api/machine/hub-relay/api/provider-quotas?refresh=1"],
      ["GET", "/api/machine/hub-relay/api/oauth/accounts?provider=anthropic&quota=1"],
      ["GET", "/api/machine/hub-relay/api/models"],
      ["GET", "/api/machine/hub-relay/api/diagnostics/project-config"],
    ];
    for (const [method, path] of cases) {
      const response = await fetch(new URL(path, server.url), {
        method, headers: await guiHeaders(server, method !== "GET"), ...(method === "GET" ? {} : { body: "{}" }),
      });
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 });
      const body = await response.json() as { error: string; code: string };
      expect(body.code).toBe("link_child_read_only");
      expect(body.error).toContain("Remote Link Child managed by Home home-mac");
      expect(body.error).toContain(`lnk_${"b".repeat(16)}`);
      expect(body.error).toContain("No request was sent.");
      expect(body.error).not.toContain("relay transport");
    }
    expect(upstream).toHaveLength(0);
  });

  test("bootstraps the shared plane with this listener's own session and never relays the data-plane prefix", async () => {
    writeKey();
    const { server, upstream } = linkListener();
    const bootstrap = await fetch(new URL("/api/machine/hub-relay/opencodex-session", server.url));
    expect(bootstrap.status).toBe(200);
    expect(meta(await bootstrap.text(), "opencodex-session-token")).toStartWith("ocx_session_");
    // An unauthenticated local caller cannot reach the Home's management reads through the
    // Child's data-plane ingress: that path relays only the data-plane table.
    const direct = await fetch(new URL("/v1/link-management/api/providers", server.url));
    expect(direct.status).toBe(404);
    expect(upstream).toHaveLength(0);
  });

  test("a hub-transport client has no link status route", async () => {
    const server = startMachineListener(0, { state: connection(), managementAuthState: authState() });
    servers.push(server);
    expect((await fetch(new URL("/api/link/status", server.url), { headers: await guiHeaders(server) })).status).toBe(404);
    expect((await fetch(new URL("/api/link/diagnostics", server.url), { headers: await guiHeaders(server) })).status).toBe(404);
  });

  test("a link Child serves its own sanitized diagnostics to a dashboard session, read-only", async () => {
    mkdirSync(join(root, "link"), { recursive: true });
    const file = join(root, "link", "diagnostics.jsonl");
    const content = JSON.stringify({ event: "tunnel_transition", outcome: "network", previousState: "connected", state: "reconnecting", attempt: 1, tunnelPort: 43110, timestamp: 7, alias: "\u001b[2Jhome-mac" }) + "\n";
    writeFileSync(file, content);
    const { server, upstream } = linkListener();
    const url = new URL("/api/link/diagnostics?limit=5", server.url);
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: await guiHeaders(server) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema: "ocx.link.diagnostics/1",
      files: [{ name: "diagnostics.jsonl.1", state: "absent", truncated: false }, { name: "diagnostics.jsonl", state: "read", truncated: false }],
      matched: 1,
      skipped: 0,
      records: [{ event: "tunnel_transition", outcome: "network", state: "reconnecting", previousState: "connected", attempt: 1, tunnelPort: 43110, timestamp: 7 }],
    });
    expect((await fetch(url, { method: "POST", headers: await guiHeaders(server, true), body: "{}" })).status).toBe(404);
    expect(readFileSync(file, "utf8")).toBe(content);
    // Served locally: the Child's own evidence, never relayed to the Home.
    expect(upstream).toHaveLength(0);
  });

});

describe("hub client management relay", () => {
  const storedHubSession = {
    kind: "relay" as const,
    token: `ocx_hub_relay_${"s".repeat(43)}`,
  };

  test.each([
    ["unauthenticated account read", "GET", "/api/codex-auth/accounts"],
    ["unauthenticated mutation", "POST", "/api/config"],
  ])("refuses an %s before hub credential use", async (_name, method, path) => {
    writeHubCredential(storedHubSession, connection());
    let upstreamCalls = 0;
    const server = startMachineListener(0, {
      state: connection(), managementAuthState: authState(),
      fetchImpl: (async () => {
        upstreamCalls++;
        return Response.json({ unexpected: true });
      }) as typeof fetch,
    });
    servers.push(server);
    const response = await fetch(new URL(path, server.url), { method });
    expect({ status: response.status, upstreamCalls }).toEqual({ status: 401, upstreamCalls: 0 });
  });

  test("a machine GUI session alone cannot use the stored hub credential", async () => {
    let upstreamCalls = 0;
    const server = startMachineListener(0, {
      state: connection("relay"), managementAuthState: authState(),
      fetchImpl: (async () => {
        upstreamCalls++;
        return Response.json({ unexpected: true });
      }) as typeof fetch,
    });
    servers.push(server);
    const local = await guiHeaders(server);
    writeHubCredential(storedHubSession, connection("relay"));
    const headers = {
      "X-OpenCodex-Machine-Session": local.get("X-OpenCodex-API-Key")!,
      "X-OpenCodex-Machine-GUI-Origin": local.get("X-OpenCodex-GUI-Origin")!,
    };
    const response = await fetch(new URL("/api/machine/hub-relay/api/usage", server.url), { headers });
    expect({ status: response.status, upstreamCalls }).toEqual({ status: 401, upstreamCalls: 0 });
  });

  test.each([
    ["/api/usage", "hub", 200, 1],
    ["/api/quota-pool", "hub", 200, 1],
    ["/opencodex-session", "local", 401, 0],
  ] as const)("keeps caller and local admin credentials separate at %s (%s)", async (path, authority, status, calls) => {
    const auth = authState();
    if (!auth.available) throw new Error("fixture auth unavailable");
    const rawToken = authority === "local" ? auth.token : `ocx_admin_${"h".repeat(43)}`;
    const forwarded: Array<string | null> = [];
    const server = startMachineListener(0, {
      state: connection("relay"), managementAuthState: auth,
      fetchImpl: (async (_input, init) => {
        forwarded.push(new Headers(init?.headers).get("x-opencodex-api-key"));
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    servers.push(server);
    const local = await guiHeaders(server);
    const response = await fetch(new URL(`/api/machine/hub-relay${path}`, server.url), {
      headers: {
        "X-OpenCodex-Machine-Session": local.get("X-OpenCodex-API-Key")!,
        "X-OpenCodex-Machine-GUI-Origin": local.get("X-OpenCodex-GUI-Origin")!,
        "X-OpenCodex-API-Key": rawToken,
      },
    });
    expect({ status: response.status, calls: forwarded.length }).toEqual({ status, calls });
    if (calls) expect(forwarded).toEqual([rawToken]);
  });

  test("only the caller's two CSRF-bound sessions can sign out on the Hub", async () => {
    const { loadConfig, saveConfig } = await import("../../src/config");
    const { startServer } = await import("../../src/server");
    const hubAuth = authState();
    if (!hubAuth.available) throw new Error("fixture auth unavailable");
    let hubOrigin = "";
    let upstreamCalls = 0;
    const machine = startMachineListener(0, {
      state: connection("relay"), managementAuthState: authState(),
      fetchImpl: (async (input, init) => {
        upstreamCalls++;
        const target = new URL(String(input));
        return fetch(hubOrigin + target.pathname + target.search, init);
      }) as typeof fetch,
    });
    servers.push(machine);
    const browserOrigin = machine.url.origin;
    saveConfig({
      ...loadConfig(), runtimeRole: "hub", corsAllowOrigins: [browserOrigin],
      apiKeys: [{ id: "fixture-enrolled", name: "fixture-enrolled", key: "fixture-data-key", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    const hub = startServer(0, { managementAuthState: hubAuth });
    try {
      hubOrigin = new URL(`http://127.0.0.1:${hub.port}`).origin;
      const token = "ocx_session_hub_logout_fixture";
      hubAuth.sessions.set(token, {
        serverOrigin: hubOrigin, browserOrigin, csrfToken: "hub-logout-csrf",
        expiresAt: Date.now() + 60_000, issuance: "loopback",
      });
      const local = await guiHeaders(machine, true);
      const headers = {
        Origin: browserOrigin,
        "X-OpenCodex-Machine-Session": local.get("X-OpenCodex-API-Key")!,
        "X-OpenCodex-Machine-GUI-Origin": local.get("X-OpenCodex-GUI-Origin")!,
        "X-OpenCodex-Machine-CSRF-Token": local.get("X-OpenCodex-CSRF-Token")!,
        "X-OpenCodex-API-Key": token,
        "X-OpenCodex-GUI-Origin": browserOrigin,
        "X-OpenCodex-CSRF-Token": "hub-logout-csrf",
      };
      const path = "/api/session/logout";
      const logout = (overrides: Partial<typeof headers> = {}, relayPath = "/api/machine/hub-relay" + path) =>
        fetch(new URL(relayPath, machine.url), { method: "POST", headers: { ...headers, ...overrides } });
      const wrongMachineCsrf = await logout({ "X-OpenCodex-Machine-CSRF-Token": "wrong" });
      const leaseLogout = await logout({ "X-OpenCodex-API-Key": storedHubSession.token });
      const bareLogout = await logout({}, path);
      expect(upstreamCalls).toBe(0);
      const wrongHubCsrf = await logout({ "X-OpenCodex-CSRF-Token": "wrong" });
      expect(hubAuth.sessions.has(token)).toBe(true);
      const response = await logout();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(hubAuth.sessions.has(token)).toBe(false);
      expect([wrongMachineCsrf.status, leaseLogout.status, bareLogout.status, wrongHubCsrf.status]).toEqual([401, 401, 404, 401]);
      expect((await fetch(hubOrigin + "/api/provider-quotas", {
        headers: { "X-OpenCodex-API-Key": token, "X-OpenCodex-GUI-Origin": browserOrigin },
      })).status).toBe(401);
    } finally {
      await hub.stop(true);
    }
  });

  test.each([false, true])("blocks client stop without forwarding (prefixed: %s)", async prefixed => {
    const auth = authState();
    if (!auth.available) throw new Error("fixture auth unavailable");
    let upstreamCalls = 0;
    const server = startMachineListener(0, {
      state: connection("relay"), managementAuthState: auth,
      fetchImpl: (async () => {
        upstreamCalls++;
        return Response.json({ unexpected: true });
      }) as typeof fetch,
    });
    servers.push(server);
    const local = await guiHeaders(server, true);
    writeHubCredential(storedHubSession, connection("relay"));
    const headers: Record<string, string> = prefixed ? {
      Origin: local.get("Origin")!,
      "X-OpenCodex-Machine-Session": local.get("X-OpenCodex-API-Key")!,
      "X-OpenCodex-Machine-GUI-Origin": local.get("X-OpenCodex-GUI-Origin")!,
      "X-OpenCodex-Machine-CSRF-Token": local.get("X-OpenCodex-CSRF-Token")!,
      "X-OpenCodex-API-Key": storedHubSession.token,
    } : { "X-OpenCodex-API-Key": auth.token };
    const prefix = prefixed ? "/api/machine/hub-relay" : "";
    const cases = [
      ["POST", "/api/stop"], ["POST", "/api/Stop"], ["POST", "/Api/STOP"],
      ["POST", "/api//stop"], ["POST", "/api/stop/"], ["POST", "/api/%73top"],
      ["POST", "/api/st%6fp"], ["POST", "/api/%2fstop"], ["POST", "/api/%2573top"],
      ["GET", "/api/codex-auth/Accounts"], ["GET", "/api/codex-auth//accounts"],
      ["GET", "/api/codex-auth/accounts/"], ["GET", "/api/codex-auth/%61ccounts"],
      ["GET", "/api/codex-auth/accounts?unknown=1"],
      ["GET", "/api/oauth/accounts?provider=openai&provider=anthropic"],
      ["GET", "/api/usage?%72efresh=1"],
    ];
    const observed = [];
    for (const [method, path] of cases) {
      const response = await fetch(new URL(prefix + path, server.url), { method, headers });
      observed.push([path, response.status, upstreamCalls]);
    }
    expect(observed).toEqual(cases.map(([, path]) => [path, 404, 0]));
  });

  test.each([
    ["Host", "unexpected.example.test", false],
    ["Origin", "https://unexpected.example.test", false],
    ["Host", "unexpected.example.test", true],
    ["Origin", "https://unexpected.example.test", true],
  ] as const)("rejects a foreign %s (%s, prefixed: %j)", async (header, value, prefixed) => {
    const auth = authState();
    if (!auth.available) throw new Error("fixture auth unavailable");
    let upstreamCalls = 0;
    const server = startMachineListener(0, {
      state: connection("relay"), managementAuthState: auth,
      fetchImpl: (async () => {
        upstreamCalls++;
        return Response.json({ unexpected: true });
      }) as typeof fetch,
    });
    servers.push(server);
    const local = await guiHeaders(server);
    writeHubCredential(storedHubSession, connection());
    const credentials: Record<string, string> = prefixed ? {
      "X-OpenCodex-Machine-Session": local.get("X-OpenCodex-API-Key")!,
      "X-OpenCodex-Machine-GUI-Origin": local.get("X-OpenCodex-GUI-Origin")!,
      "X-OpenCodex-API-Key": storedHubSession.token,
    } : { "X-OpenCodex-API-Key": auth.token };
    const headers = new Headers(credentials);
    if (prefixed && header === "Origin") headers.delete("X-OpenCodex-Machine-Session");
    headers.set(header, value);
    const path = prefixed ? "/api/machine/hub-relay/api/usage" : "/api/usage";
    const response = await fetch(new URL(path, server.url), { headers });
    expect({ status: response.status, upstreamCalls }).toEqual({ status: 403, upstreamCalls: 0 });
  });

  test.each([
    ["POST", "/api/config"],
    ["GET", "/api/config"],
    ["GET", "/api/codex-auth/accounts?refresh=1"],
  ])("reserves the stored session for allowlisted reads (%s %s)", async (method, path) => {
    const auth = authState();
    if (!auth.available) throw new Error("fixture auth unavailable");
    const owner = connection();
    writeHubCredential(storedHubSession, owner);
    let upstreamCalls = 0;
    const server = startMachineListener(0, {
      state: owner, managementAuthState: auth,
      fetchImpl: (async () => {
        upstreamCalls++;
        return Response.json({ unexpected: true });
      }) as typeof fetch,
    });
    servers.push(server);
    const response = await fetch(new URL(path, server.url), {
      method, headers: { "X-OpenCodex-API-Key": auth.token },
    });
    expect({ status: response.status, upstreamCalls }).toEqual({ status: 404, upstreamCalls: 0 });
  });

  test("relays an admin-authenticated account read and answers machine routes locally", async () => {
    const enrolled = writeServiceApiTokenFile(`ocx_data_${"d".repeat(40)}`);
    const owner = { ...connection(), tokenFingerprint: enrolled.fingerprint };
    const publish = (client: OcxClientConnectionConfig) =>
      writeFileSync(join(root, "config.json"), JSON.stringify({ port: 10100, providers: {}, runtimeRole: "client", client }));
    publish(owner);
    writeHubCredential(storedHubSession, owner);
    const auth = authState();
    if (!auth.available) throw new Error("fixture auth unavailable");
    const sent: Array<{ url: string; apiKey: string | null }> = [];
    const server = startMachineListener(0, {
      state: owner, managementAuthState: auth,
      fetchImpl: (async (input, init) => {
        sent.push({ url: String(input), apiKey: new Headers(init?.headers).get("x-opencodex-api-key") });
        return Response.json({ accounts: [{ id: "chatgpt-1" }] });
      }) as typeof fetch,
    });
    servers.push(server);
    const relayed = await fetch(new URL("/api/codex-auth/accounts", server.url), {
      headers: { "X-OpenCodex-API-Key": auth.token },
    });
    expect(relayed.status).toBe(200);
    expect(await relayed.json()).toEqual({ accounts: [{ id: "chatgpt-1" }] });
    expect(sent).toEqual([{ url: "https://hub.example.test/api/hub-relay/read/api/codex-auth/accounts", apiKey: storedHubSession.token }]);

    const replacement = replaceServiceApiTokenFile(`ocx_data_${"e".repeat(40)}`);
    const rotated = { ...owner, tokenFingerprint: replacement.fingerprint };
    const rotatedCredential = { ...storedHubSession, token: `ocx_hub_relay_${"b".repeat(43)}` };
    publish(rotated);
    writeHubCredential(rotatedCredential, rotated);
    const afterRotation = await fetch(new URL("/api/codex-auth/accounts", server.url), {
      headers: { "X-OpenCodex-API-Key": auth.token },
    });
    expect(afterRotation.status).toBe(200);
    expect(sent.at(-1)?.apiKey).toBe(rotatedCredential.token);

    sent.length = 0;
    expect((await fetch(new URL("/api/machine/status", server.url), { headers: await guiHeaders(server) })).status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});
