import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { OcxConfig } from "../../src/types";
import { createLinkWebsocketGate, type LinkWebsocketGateDeps } from "../../src/server/index/link-websocket";
import { setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import { requestPolicyView } from "../../src/server/auth-cors";
import { CodexWebSocketActivity } from "../../src/codex/websocket-activity";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { attachLinkTransport, type LinkStatusDto } from "../../src/link/status-projection";
import type { WsData } from "../../src/server/ws-bridge";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore, type LinkStore } from "../../src/link/store";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { LinkWireClient } from "../helpers/link-ws-client";

// Lane T5e2: the live link WebSocket counters of design 9.3, in memory and display only.

const KEY = { id: "tc-key", key: "tc-secret-0123456789", linkId: "lnk_5656565656565656" };
beforeEach(() => { setLinkWebsocketTransportReadyForTests(true); });
afterEach(() => { setLinkWebsocketTransportReadyForTests(false); });

function policy() {
  const config = { port: 0, apiKeys: [{ id: KEY.id, name: KEY.id, key: KEY.key, createdAt: "2026-11-12T00:00:00.000Z" }] } as OcxConfig;
  return requestPolicyView(config, "opencodex-link.invalid", { allowedKeyIds: new Set([KEY.id]) });
}

function harness(overrides: Partial<LinkWebsocketGateDeps> = {}) {
  let draining = false;
  const gate = createLinkWebsocketGate({
    enabled: () => true, policy, authorized: () => true, draining: () => draining,
    timers: { setInterval: () => 0, clearInterval() {} },
    reserveSocket: () => ({ bind(ws: ServerWebSocket<WsData>) { ws.data.responsesActivity = new CodexWebSocketActivity(); }, release() {} }),
    ...overrides,
  });
  const base: WebSocketHandler<WsData> = { open(ws) { ws.data.admissionLease?.bind(ws); }, message() {}, close(ws) { ws.data.admissionLease?.release(); } };
  const handler = gate.handler(base);
  const upgrade = (bearer = KEY.key) => {
    let data: WsData | undefined;
    const outcome = gate.upgrade(new Request("http://127.0.0.1/v1/responses", { headers: {
      upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      authorization: "Bearer " + bearer, "thread-id": "thread-tc",
    } }), { upgrade: (_r: Request, o: { data: WsData }) => { data = o.data; return true; } } as unknown as Server<unknown>,
    { keyId: KEY.id, linkId: KEY.linkId, fingerprint: serviceApiTokenFingerprint(KEY.key), release() {} });
    if (!data) return { outcome, ws: null };
    const ws = { data, readyState: 1, getBufferedAmount: () => 0, close() {} } as unknown as ServerWebSocket<WsData>;
    handler.open?.(ws);
    return { outcome, ws };
  };
  return { gate, handler, upgrade, drain: () => { draining = true; }, counters: () => gate.transport(KEY.linkId) };
}

describe("gate counters", () => {
  test("an admitted upgrade, its open socket, and a client close", () => {
    const h = harness();
    expect(h.counters()).toEqual({ open: 0, upgrades: 0, refused: {}, closes: {} });
    const { ws } = h.upgrade();
    expect(h.counters()).toEqual({ open: 1, upgrades: 1, refused: {}, closes: {} });
    h.handler.close?.(ws!, 1000, "");
    expect(h.counters()).toEqual({ open: 0, upgrades: 1, refused: {}, closes: { client: 1 } });
  });

  test("a dropped connection and a revocation count by their own reasons", () => {
    const h = harness();
    const a = h.upgrade().ws!;
    h.handler.close?.(a, 1006, "");
    const b = h.upgrade().ws!;
    expect(h.gate.closeLink(KEY.linkId)).toBe(1);
    h.handler.close?.(b, 4401, "link revoked");
    expect(h.counters().closes).toEqual({ dropped: 1, revoked: 1 });
  });

  test("refusals count by reason and admit nothing", () => {
    const h = harness({ limits: { perLinkSockets: 1 } });
    expect(h.upgrade("wrong-secret-0123456789").ws).toBeNull();
    h.upgrade();
    expect(h.upgrade().ws).toBeNull();
    h.drain();
    expect(h.upgrade().ws).toBeNull();
    expect(h.counters()).toEqual({ open: 1, upgrades: 1, refused: { unauthorized: 1, cap: 1, draining: 1 }, closes: {} });
    const memory = harness({ limits: { memoryBudgetBytes: 1, socketReservationBytes: 2 } });
    expect(memory.upgrade().ws).toBeNull();
    expect(memory.counters().refused).toEqual({ memory: 1 });
  });

  test("with the switch off nothing is handled and nothing is counted", () => {
    const h = harness({ enabled: () => false });
    expect(h.upgrade().outcome).toEqual({ handled: false });
    expect(h.counters()).toEqual({ open: 0, upgrades: 0, refused: {}, closes: {} });
  });

  test("forget(linkId) drops a removed link's counters", () => {
    const h = harness();
    h.upgrade();
    h.gate.forgetTransport(KEY.linkId);
    expect(h.counters()).toMatchObject({ upgrades: 0, refused: {}, closes: {} });
  });
});

describe("status projection (?transport=1)", () => {
  const dto = (): LinkStatusDto => ({ role: "home", listener: { state: "listening", port: 1 }, child: null,
    links: [{ id: KEY.linkId, alias: "a", direction: "client-initiated", state: "connected", since: "2026-11-12T00:00:00.000Z", reason: null, tunnelPort: 2222 }] } as unknown as LinkStatusDto);

  test("each row gets ws with the live counters and the hold count", () => {
    const out = attachLinkTransport(dto(), () => ({ open: 2, upgrades: 3, refused: { cap: 1 }, closes: { idle: 1 } }), () => 1);
    expect((out.links[0] as unknown as { ws: unknown }).ws).toEqual({ open: 2, upgrades: 3, refused: { cap: 1 }, closes: { idle: 1 }, holds: 1 });
  });

  test("a Home without counters reports zeros, never an absent block", () => {
    const out = attachLinkTransport(dto(), () => null, () => 0);
    expect((out.links[0] as unknown as { ws: unknown }).ws).toEqual({ open: 0, upgrades: 0, refused: {}, closes: {}, holds: 0 });
  });
});
describe("through a real Home's management routes (T5e2-R1-01, -02)", () => {
  const KEY_ID = "tc-home"; const SECRET = "tc-home-secret-0123456789"; const LINK = "lnk_7878787878787878";
  const previous = { home: process.env.OPENCODEX_HOME };
  let dir = "";
  let codexHome: IsolatedCodexHome | null = null;
  let server: Server<unknown> | null = null;
  const clients: LinkWireClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    if (server) await server.stop(true);
    server = null;
    codexHome?.restore(); codexHome = null;
    if (previous.home === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous.home;
    if (dir) removeTreeWithRetry(dir);
    dir = "";
  });

  test("status shows the held link and its socket counters, and the clear really clears", async () => {
    dir = mkdtempSync(join(tmpdir(), "ocx-link-ws-status-home-"));
    process.env.OPENCODEX_HOME = dir;
    codexHome = installIsolatedCodexHome("ocx-link-ws-status-codex-");
    writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [] }));
    writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links: [{ id: LINK, alias: "tc", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY_ID, createdAt: "2026-11-12T00:00:00.000Z" }] as LinkStore["links"] });
    // The last run died with the feature on: the next start holds every link (unknown, crash) until the operator clears it.
    mkdirSync(join(dir, "link"), { recursive: true });
    writeFileSync(join(dir, "link", "ws-run-state.json"), '{"version":1,"state":"running"}');
    const { saveConfig } = await import("../../src/config");
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", websockets: true, linkResponsesWebsocket: true, codexAutoStart: false, clientIntegrations: { codex: false },
      providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:9/v1", authMode: "key", apiKey: "fixture-upstream-key", allowPrivateNetwork: true, models: ["fixture"] } },
      apiKeys: [{ id: KEY_ID, name: KEY_ID, key: SECRET, createdAt: "2026-11-12T00:00:00.000Z" }] } as OcxConfig);
    const { startServer } = await import("../../src/server");
    server = startServer(0) as unknown as Server<unknown>;
    const admin = readFileSync(join(dir, "admin-api-token"), "utf8").trim();
    const api = (path: string, init: RequestInit = {}) => fetch(new URL(path, server!.url), { ...init, headers: { "content-type": "application/json", "x-opencodex-api-key": admin, ...(init.headers ?? {}) } });
    const row = async () => ((await (await api("/api/link/status?children=1&transport=1")).json()) as { links: Array<{ child?: { holds?: unknown }; ws?: { holds: number; upgrades: number; open: number } }> }).links[0]!;

    const before = await row();
    expect(before.child?.holds).toEqual({ holds: [], unknown: "crash" });
    expect(before.ws).toMatchObject({ holds: 1, upgrades: 0, open: 0 });

    const port = JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort as number;
    const ws = await LinkWireClient.open(port);
    clients.push(ws);
    const session = await ws.challenge({ keyId: KEY_ID, linkId: LINK, fingerprint: serviceApiTokenFingerprint(SECRET) });
    expect((await ws.upgrade({ nonce: session.nonce, bearer: SECRET, headers: { "thread-id": "thread-tc" } })).status).toBe(101);
    expect((await row()).ws).toMatchObject({ upgrades: 1, open: 1 });

    const cleared = await api("/api/link/children/activity/clear", { method: "POST", body: JSON.stringify({ linkId: LINK }) });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ linkId: LINK, cleared: { holds: [], unknown: "crash" } });
    const after = await row();
    expect(after.child).not.toHaveProperty("holds");
    expect(after.ws?.holds).toBe(0);
  });

  test("the traffic book counts relayed HTTP requests and none of a link WebSocket's turn (#3023 counters unchanged)", async () => {
    dir = mkdtempSync(join(tmpdir(), "ocx-link-ws-traffic-home-"));
    process.env.OPENCODEX_HOME = dir;
    codexHome = installIsolatedCodexHome("ocx-link-ws-traffic-codex-");
    writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [] }));
    writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links: [{ id: LINK, alias: "tc", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY_ID, createdAt: "2026-11-12T00:00:00.000Z" }] as LinkStore["links"] });
    const { saveConfig } = await import("../../src/config");
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", websockets: true, linkResponsesWebsocket: true, codexAutoStart: false, clientIntegrations: { codex: false },
      providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:9/v1", authMode: "key", apiKey: "fixture-upstream-key", allowPrivateNetwork: true, models: ["fixture"] } },
      apiKeys: [{ id: KEY_ID, name: KEY_ID, key: SECRET, createdAt: "2026-11-12T00:00:00.000Z" }] } as OcxConfig);
    const { startServer } = await import("../../src/server");
    server = startServer(0) as unknown as Server<unknown>;
    const admin = readFileSync(join(dir, "admin-api-token"), "utf8").trim();
    type TrafficRow = { traffic?: { requests: number; toHomeBytes: number; fromHomeBytes: number; toHomeUncounted: number }; ws?: { upgrades: number } };
    const row = async () => ((await (await fetch(new URL("/api/link/status?transport=1&traffic=1", server!.url), { headers: { "x-opencodex-api-key": admin } })).json()) as { links: TrafficRow[] }).links[0]!;
    const port = JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort as number;
    const fingerprint = serviceApiTokenFingerprint(SECRET);

    // One full turn over a link WebSocket (the upstream refuses, so the turn ends in an error frame).
    const ws = await LinkWireClient.open(port);
    clients.push(ws);
    const session = await ws.challenge({ keyId: KEY_ID, linkId: LINK, fingerprint });
    expect((await ws.upgrade({ nonce: session.nonce, bearer: SECRET })).status).toBe(101);
    ws.sendJson({ type: "response.create", model: "fixture/fixture", input: [{ role: "user", content: [{ type: "input_text", text: "count me not" }] }] });
    const seen = await ws.until(message => message.type === "text" && ["error", "response.failed", "response.completed", "response.incomplete"].includes(String((JSON.parse(message.data) as { type?: unknown }).type)));
    expect(seen.at(-1)?.type).toBe("text");
    const afterSocket = await row();
    expect(afterSocket.ws?.upgrades).toBe(1);
    expect(afterSocket.traffic).toMatchObject({ requests: 0, toHomeBytes: 0, fromHomeBytes: 0, toHomeUncounted: 0 });

    // Control: a relayed HTTP request on the same link is counted, so the zero above is not an unwired book.
    const http = await LinkWireClient.open(port);
    clients.push(http);
    const relay = await http.challenge({ keyId: KEY_ID, linkId: LINK, fingerprint });
    const body = JSON.stringify({ model: "fixture/fixture", input: "count me", stream: false });
    http.sendRequest("POST /v1/responses HTTP/1.1", { host: "127.0.0.1", "content-type": "application/json", authorization: "Bearer " + SECRET, "x-opencodex-link-session": relay.nonce }, body);
    await http.readHead();
    expect((await row()).traffic).toMatchObject({ requests: 1, toHomeBytes: Buffer.byteLength(body) });
  });

});
