import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { OcxConfig } from "../../src/types";
import type { LinkStore } from "../../src/link/store";
import { createLinkListenerLifecycle } from "../../src/server/index/link-listener";
import { createLinkWebsocketGate, LinkUpgradeLeases, type LinkSessionGrant } from "../../src/server/index/link-websocket";
import { LINK_WS_LIMITS } from "../../src/server/index/link-websocket-limits";
import { setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import { requestPolicyView } from "../../src/server/auth-cors";
import { codexWebSocketAdmissionMetrics, tryReserveCodexWebSocket } from "../../src/codex/websocket-registry";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import type { AdmissionReservation } from "../../src/lib/admission";
import type { WsData } from "../../src/server/ws-bridge";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { LinkWireClient } from "../helpers/link-ws-client";
import { createLinkRelaySessions } from "../../src/server/index/link-relay-sessions";
import { LINK_RELAY_AUTH_PATH, LINK_RELAY_AUTH_VERSION, linkRelayProof } from "../../src/link/relay-auth";

// Lane T5a, gate level: the lease state machine of design 2.3 row by row, the caps and budget of
// 6.3/6.4, the sweep on an injected timer, and the same-task fence of the revocation hook.

const KEYS = ["gate-key-1", "gate-key-2", "gate-key-3", "gate-key-4"].map((id, index) => ({
  id, key: "gate-secret-" + index + "-0123456789", linkId: "lnk_" + String(index + 1).repeat(16),
}));
const FIRST = KEYS[0]!;

const previousHome = process.env.OPENCODEX_HOME;
let tempHome = "";
const clients: LinkWireClient[] = [];
const stops: Array<() => Promise<void>> = [];

beforeEach(() => {
  setLinkWebsocketTransportReadyForTests(true);
  tempHome = mkdtempSync(join(tmpdir(), "ocx-link-ws-gate-"));
  process.env.OPENCODEX_HOME = tempHome;
});

afterEach(async () => {
  setLinkWebsocketTransportReadyForTests(false);
  for (const client of clients.splice(0)) client.destroy();
  for (const stop of stops.splice(0)) await stop();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (tempHome) removeTreeWithRetry(tempHome);
  tempHome = "";
});

function config(): OcxConfig {
  return { port: 0, apiKeys: KEYS.map(entry => ({ id: entry.id, name: entry.id, key: entry.key, createdAt: "2026-11-12T00:00:00.000Z" })) } as OcxConfig;
}

function policy() {
  return requestPolicyView(config(), "opencodex-link.invalid", { allowedKeyIds: new Set(KEYS.map(entry => entry.id)) });
}

function store(): LinkStore {
  return {
    version: 1, listenerPort: null,
    links: KEYS.map(entry => ({
      id: entry.linkId, alias: "gate-" + entry.id, direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop",
      tunnelPort: 2222, apiKeyId: entry.id, createdAt: "2026-11-12T00:00:00.000Z",
    })) as LinkStore["links"],
  };
}

/** A manual interval: the test fires the sweep itself and sees what was scheduled. */
function manualTimers() {
  const scheduled: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  return {
    scheduled,
    timers: {
      setInterval(callback: () => void, ms: number) { const entry = { callback, ms, cleared: false }; scheduled.push(entry); return entry; },
      clearInterval(handle: unknown) { (handle as { cleared: boolean }).cleared = true; },
    },
    fire() { for (const entry of scheduled) if (!entry.cleared) entry.callback(); },
    active() { return scheduled.filter(entry => !entry.cleared).length; },
  };
}

/** The shared handler's socket bookkeeping without a turn pipeline; records what reached it. */
function baseHandler() {
  const delivered: string[] = [];
  const handler: WebSocketHandler<WsData> = {
    open(ws) { ws.data.admissionLease?.bind(ws); },
    message(_ws, raw) { delivered.push(String(raw)); },
    close(ws) { ws.data.admissionLease?.release(); ws.data.admissionLease = undefined; },
  };
  return { handler, delivered };
}

async function startListener(options: {
  on?: () => boolean;
  fingerprints?: (keyId: string) => readonly string[];
  limits?: Partial<typeof LINK_WS_LIMITS>;
  reserveSocket?: () => AdmissionReservation<ServerWebSocket<WsData>> | null;
  base?: WebSocketHandler<WsData>;
} = {}) {
  const current = { value: store() };
  const clock = manualTimers();
  const base = baseHandler();
  const lifecycle = createLinkListenerLifecycle<WsData>({
    storePath: join(tempHome, "links.json"),
    readStore: () => current.value,
    writeStore: (_path, next) => { current.value = next; },
    warn: () => {},
    websocket: { timers: clock.timers, ...(options.limits ? { limits: options.limits } : {}), ...(options.reserveSocket ? { reserveSocket: options.reserveSocket } : {}) },
  });
  lifecycle.start({
    maxRequestBodySize: 1024 * 1024,
    dispatch: async () => new Response(null, { status: 404 }),
    keyFingerprints: options.fingerprints ?? (keyId => {
      const entry = KEYS.find(candidate => candidate.id === keyId);
      return entry ? [serviceApiTokenFingerprint(entry.key)] : [];
    }),
    responsesWebsocket: { handler: options.base ?? base.handler, enabled: options.on ?? (() => true), policy },
  });
  stops.push(() => lifecycle.stop());
  const port = lifecycle.status().port!;
  expect(port).toBeGreaterThan(0);
  return { lifecycle, port, clock, base, current };
}

async function connectAs(port: number, entry = FIRST): Promise<{ wire: LinkWireClient; status: number }> {
  const wire = await LinkWireClient.open(port);
  clients.push(wire);
  const { nonce } = await wire.challenge({ keyId: entry.id, linkId: entry.linkId, fingerprint: serviceApiTokenFingerprint(entry.key) });
  const head = await wire.upgrade({ nonce, bearer: entry.key });
  return { wire, status: head.status };
}

function upgradeRequest(init: { signal?: AbortSignal; bearer?: string } = {}): Request {
  return new Request("http://127.0.0.1/v1/responses", {
    ...(init.signal ? { signal: init.signal } : {}),
    headers: {
      upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      authorization: "Bearer " + (init.bearer ?? FIRST.key),
    },
  });
}

/** Counts every release, so "exactly once" is an assertion rather than an assumption. */
function countedGrant(): { grant: LinkSessionGrant; released: () => number } {
  let count = 0;
  return {
    grant: { keyId: FIRST.id, linkId: FIRST.linkId, fingerprint: serviceApiTokenFingerprint(FIRST.key), release: () => { count += 1; } },
    released: () => count,
  };
}

function countedSocketLease(onReserve?: () => void) {
  let releases = 0;
  let reserved = 0;
  const reserve = (): AdmissionReservation<ServerWebSocket<WsData>> => {
    reserved += 1;
    onReserve?.();
    return { bind() {}, release() { releases += 1; } };
  };
  return { reserve, releases: () => releases, reserved: () => reserved };
}

function unitGate(overrides: Partial<Parameters<typeof createLinkWebsocketGate>[0]> = {}) {
  return createLinkWebsocketGate({
    enabled: () => true,
    policy,
    authorized: identity => identity.fingerprint === serviceApiTokenFingerprint(KEYS.find(entry => entry.id === identity.keyId)?.key ?? ""),
    draining: () => false,
    timers: manualTimers().timers,
    ...overrides,
  });
}

const fakeServer = (upgrade: (req: Request, options: { data: WsData }) => boolean) => ({ upgrade }) as unknown as Server<unknown>;

describe("link upgrade lease state machine (design 2.3, 11.1-7)", () => {
  test("off or a wrong shape leaves the request on today's path and takes no lease", () => {
    const off = countedGrant();
    expect(unitGate({ enabled: () => false }).upgrade(upgradeRequest(), fakeServer(() => true), off.grant)).toEqual({ handled: false });
    expect(off.released()).toBe(0);
    const shape = countedGrant();
    const post = new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { upgrade: "websocket" } });
    expect(unitGate().upgrade(post, fakeServer(() => true), shape.grant)).toEqual({ handled: false });
    expect(shape.released()).toBe(0);
  });

  test.each([
    ["aborted before admission", { abort: "before" }, 426],
    ["draining", { draining: true }, 503],
    ["credential is another key", { bearer: KEYS[1]!.key }, 401],
    ["authorization check fails", { authorized: false }, 401],
    ["memory budget refuses", { memory: true }, 426],
    ["socket gate refuses", { noSocket: true }, 426],
    ["aborted after the leases", { abort: "after" }, 426],
    ["upgrade returns false", { upgrade: "false" }, 426],
    ["upgrade throws", { upgrade: "throw" }, 426],
  ] as const)("%s: refused, every lease released exactly once", (_label, scenario: Record<string, unknown>, status) => {
    const session = countedGrant();
    const controller = new AbortController();
    if (scenario.abort === "before") controller.abort();
    const socket = countedSocketLease(() => { if (scenario.abort === "after") controller.abort(); });
    const gate = unitGate({
      ...(scenario.draining ? { draining: () => true } : {}),
      ...(scenario.authorized === false ? { authorized: () => false } : {}),
      ...(scenario.memory ? { limits: { memoryBudgetBytes: LINK_WS_LIMITS.socketReservationBytes - 1 } } : {}),
      reserveSocket: scenario.noSocket ? () => null : socket.reserve,
    });
    const server = fakeServer(() => {
      if (scenario.upgrade === "throw") throw new Error("upgrade failed");
      return scenario.upgrade !== "false";
    });
    const outcome = gate.upgrade(upgradeRequest({ signal: controller.signal, bearer: (scenario.bearer as string | undefined) ?? FIRST.key }), server, session.grant);
    expect(outcome.handled).toBe(true);
    expect((outcome as { response: Response }).response.status).toBe(status);
    expect(session.released()).toBe(1);
    expect(socket.releases()).toBe(socket.reserved());
    expect(gate.snapshot()).toEqual({ open: 0, admitted: 0, reservedBytes: 0, sweeping: false });
  });

  test("upgraded: later abort, Response or throw events change nothing; the close callback releases once", () => {
    const session = countedGrant();
    const socket = countedSocketLease();
    const gate = unitGate({ reserveSocket: socket.reserve });
    let data: WsData | undefined;
    const outcome = gate.upgrade(upgradeRequest(), fakeServer((_req, options) => { data = options.data; return true; }), session.grant);
    expect(outcome).toEqual({ handled: true, response: undefined });
    expect(data?.link?.fingerprint).toBe(serviceApiTokenFingerprint(FIRST.key));
    expect(data?.nativeControlDisabled).toBe(true);
    const leases = (data!.link!.leases as LinkUpgradeLeases);
    expect(leases.state).toBe("upgraded");
    leases.release();
    expect(session.released()).toBe(0);
    expect(gate.snapshot().admitted).toBe(1);
    leases.closed();
    leases.closed();
    expect(session.released()).toBe(1);
    expect(socket.releases()).toBe(1);
    expect(gate.snapshot()).toEqual({ open: 0, admitted: 0, reservedBytes: 0, sweeping: false });
  });

  test("a close before open releases the leases once and leaves no sweep behind", () => {
    const session = countedGrant();
    const gate = unitGate({ reserveSocket: countedSocketLease().reserve });
    let data: WsData | undefined;
    gate.upgrade(upgradeRequest(), fakeServer((_req, options) => { data = options.data; return true; }), session.grant);
    const handler = gate.handler(baseHandler().handler);
    const ws = { data, close() {}, readyState: 3 } as unknown as ServerWebSocket<WsData>;
    handler.close?.(ws, 1006, "");
    expect(session.released()).toBe(1);
    expect(gate.snapshot()).toEqual({ open: 0, admitted: 0, reservedBytes: 0, sweeping: false });
  });

  test.each([
    ["last-link close()", "all"],
    ["the link's revoke hook", "link"],
  ] as const)("%s between a successful upgrade and open() still closes the socket when it opens (R1-01)", (_label, which) => {
    const session = countedGrant();
    const gate = unitGate({ reserveSocket: countedSocketLease().reserve });
    let data: WsData | undefined;
    gate.upgrade(upgradeRequest(), fakeServer((_req, options) => { data = options.data; return true; }), session.grant);
    if (which === "all") expect(gate.closeAll()).toBe(1); else expect(gate.closeLink(FIRST.linkId)).toBe(1);
    const base = baseHandler();
    const handler = gate.handler(base.handler);
    const closes: number[] = [];
    const ws = { data, close(code: number) { closes.push(code); }, readyState: 1 } as unknown as ServerWebSocket<WsData>;
    handler.open?.(ws);
    expect(closes).toEqual([4401]);
    handler.message?.(ws, "late frame");
    expect(base.delivered).toEqual([]);
    handler.close?.(ws, 4401, "link revoked");
    expect(session.released()).toBe(1);
    expect(gate.snapshot()).toEqual({ open: 0, admitted: 0, reservedBytes: 0, sweeping: false });
  });

  test("a revocation fences the socket in the same task: a frame already queued never reaches the shared handler", () => {
    const gate = unitGate({ reserveSocket: countedSocketLease().reserve });
    let data: WsData | undefined;
    gate.upgrade(upgradeRequest(), fakeServer((_req, options) => { data = options.data; return true; }), countedGrant().grant);
    const base = baseHandler();
    const handler = gate.handler(base.handler);
    const closes: number[] = [];
    let cancelled = 0;
    data!.cancel = () => { cancelled += 1; };
    const ws = { data, close(code: number) { closes.push(code); }, readyState: 1 } as unknown as ServerWebSocket<WsData>;
    handler.open?.(ws);
    handler.message?.(ws, "first");
    expect(gate.closeLink(FIRST.linkId)).toBe(1);
    handler.message?.(ws, "after revoke");
    expect(base.delivered).toEqual(["first"]);
    expect(closes).toEqual([4401]);
    expect(cancelled).toBe(1);
  });
});

describe("link socket limits (design 6.3, 6.4, 11.1-9)", () => {
  test("the 9th socket on one link and the 25th overall get 426", async () => {
    const { port } = await startListener();
    for (let i = 0; i < LINK_WS_LIMITS.perLinkSockets; i += 1) expect((await connectAs(port, FIRST)).status).toBe(101);
    const ninth = await connectAs(port, FIRST);
    expect(ninth.status).toBe(426);
    for (const entry of KEYS.slice(1, 3)) {
      for (let i = 0; i < LINK_WS_LIMITS.perLinkSockets; i += 1) expect((await connectAs(port, entry)).status).toBe(101);
    }
    expect(LINK_WS_LIMITS.totalSockets).toBe(3 * LINK_WS_LIMITS.perLinkSockets);
    expect((await connectAs(port, KEYS[3]!)).status).toBe(426);
  });

  test("a refused memory reservation refuses the upgrade", async () => {
    const { port } = await startListener({ limits: { memoryBudgetBytes: LINK_WS_LIMITS.socketReservationBytes } });
    expect((await connectAs(port)).status).toBe(101);
    expect((await connectAs(port)).status).toBe(426);
  });

  test("a link upgrade never evicts a local idle socket; a local upgrade still reclaims as today", async () => {
    const before = codexWebSocketAdmissionMetrics().active;
    const leases: Array<AdmissionReservation<ServerWebSocket<WsData>>> = [];
    const closed: string[] = [];
    try {
      let index = 0;
      for (;;) {
        const lease = tryReserveCodexWebSocket({ reclaim: false });
        if (!lease) break;
        const name = "local-" + index++;
        lease.bind({ data: {}, readyState: 1, getBufferedAmount: () => 0, close: () => { closed.push(name); } } as unknown as ServerWebSocket<WsData>);
        leases.push(lease);
      }
      const { port } = await startListener();
      expect((await connectAs(port)).status).toBe(426);
      expect(closed).toEqual([]);
      // Characterization: the local path keeps today's LRU reclaim of an idle socket.
      expect(tryReserveCodexWebSocket()).toBeNull();
      expect(closed).toEqual(["local-0"]);
    } finally {
      for (const lease of leases) lease.release();
    }
    expect(codexWebSocketAdmissionMetrics().active).toBe(before);
  });
});

describe("link socket sweep and revocation (design 2.4, 11.1-4)", () => {
  test("rotation expiry on an injected clock closes the socket with 4401 at the next 30 s sweep", async () => {
    let now = 1_000;
    const expiresAt = 2_000;
    const { port, clock } = await startListener({ fingerprints: keyId => (keyId === FIRST.id && now < expiresAt ? [serviceApiTokenFingerprint(FIRST.key)] : []) });
    const { wire, status } = await connectAs(port);
    expect(status).toBe(101);
    expect(clock.scheduled.map(entry => entry.ms)).toEqual([LINK_WS_LIMITS.sweepIntervalMs]);
    expect(LINK_WS_LIMITS.sweepIntervalMs).toBe(30_000);
    now = expiresAt;
    clock.fire();
    expect(await wire.nextMessage()).toMatchObject({ type: "close", code: 4401 });
  });

  test("the sweep exists only while link sockets exist", async () => {
    const { port, clock, lifecycle } = await startListener();
    expect(clock.active()).toBe(0);
    const { wire } = await connectAs(port);
    expect(clock.active()).toBe(1);
    expect(lifecycle.closeLinkSockets(FIRST.linkId)).toBe(1);
    expect(await wire.nextMessage()).toMatchObject({ type: "close", code: 4401 });
    wire.destroy();
    await lifecycle.close();
    expect(clock.active()).toBe(0);
  });

  test("switching the feature off closes an idle socket at the next sweep", async () => {
    let on = true;
    const { port, clock } = await startListener({ on: () => on });
    const { wire } = await connectAs(port);
    on = false;
    clock.fire();
    expect(await wire.nextMessage()).toMatchObject({ type: "close", code: 1000 });
  });

  test("an upgrade on a session reserved before last-link close() is refused, and close() resolves", async () => {
    const { port, lifecycle } = await startListener();
    const wire = await LinkWireClient.open(port);
    clients.push(wire);
    const { nonce } = await wire.challenge({ keyId: FIRST.id, linkId: FIRST.linkId, fingerprint: serviceApiTokenFingerprint(FIRST.key) });
    const closing = lifecycle.close();
    const head = await wire.upgrade({ nonce, bearer: FIRST.key });
    expect(head.status).not.toBe(101);
    await closing;
    expect(lifecycle.status().state).toBe("off");
  });

  test("through the real listener, a busy link socket counts in linkActivity, and a close with a tool pending keeps it there as a hold (T5b-R1-01, T5d1)", async () => {
    const seen: { message?: () => void; closed?: () => void } = {};
    let finish: (() => void) | undefined;
    let socketActivity: import("../../src/codex/websocket-activity").CodexWebSocketActivity | undefined;
    const handler: WebSocketHandler<WsData> = {
      open(ws) { ws.data.admissionLease?.bind(ws); },
      message(ws) { socketActivity = ws.data.responsesActivity; finish = socketActivity!.beginTurn("start"); seen.message?.(); },
      close(ws) { ws.data.admissionLease?.release(); seen.closed?.(); },
    };
    const { port, lifecycle } = await startListener({ base: handler });
    const { wire } = await connectAs(port);
    const linkId = FIRST.linkId;
    expect(lifecycle.linkActivity(linkId, Date.now()).inFlight).toBe(0);
    const delivered = new Promise<void>(resolve => { seen.message = resolve; });
    wire.sendText("{}");
    await delivered;
    expect(lifecycle.linkActivity(linkId, Date.now()).inFlight).toBe(1);
    socketActivity!.observePayload(JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell", arguments: "{}" } }));
    finish!();
    expect(lifecycle.linkActivity(linkId, Date.now()).inFlight).toBe(1);
    const closed = new Promise<void>(resolve => { seen.closed = resolve; });
    wire.destroy();
    await closed;
    // The socket's own count ended (tests/server/link-websocket-drain.test.ts covers that alone); the
    // pending tool result left a durable hold, so the link stays in flight for the restart gates.
    expect(lifecycle.linkActivity(linkId, Date.now()).inFlight).toBe(1);
  });

  test("a removed link refuses the next frame before the shared handler sees it", async () => {
    const { port, current, base } = await startListener();
    const { wire } = await connectAs(port);
    current.value = { ...current.value, links: current.value.links.filter(entry => entry.id !== FIRST.linkId) };
    wire.sendText("{}");
    expect(await wire.nextMessage()).toMatchObject({ type: "close", code: 4401 });
    expect(base.delivered).toEqual([]);
  });
});

describe("relay-auth answer while the link WebSocket is off (characterization)", () => {
  test("the verified 204 is identical to a relay book without any WebSocket option", async () => {
    const fingerprint = serviceApiTokenFingerprint(FIRST.key);
    const nonce = "a".repeat(64);
    const challenge = () => {
      const url = new URL("http://127.0.0.1" + LINK_RELAY_AUTH_PATH);
      url.searchParams.set("version", LINK_RELAY_AUTH_VERSION);
      url.searchParams.set("key", FIRST.id);
      url.searchParams.set("link", FIRST.linkId);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("proof", linkRelayProof(fingerprint, "caller", FIRST.id, FIRST.linkId, nonce)!);
      return new Request(url);
    };
    const peerServer = { requestIP: () => ({ address: "127.0.0.1", port: 40000, family: "IPv4" }) } as unknown as Server<unknown>;
    const unreachable = async () => new Response(null, { status: 500 });
    const today = createLinkRelaySessions({ fingerprints: () => [fingerprint], reservationMs: 1 });
    const off = createLinkRelaySessions({
      fingerprints: () => [fingerprint], reservationMs: 1,
      upgrade: () => ({ handled: false }), websocketAdvertised: () => false,
    });
    const a = await today.dispatch(challenge(), peerServer, unreachable);
    const b = await off.dispatch(challenge(), peerServer, unreachable);
    expect(b.status).toBe(a.status);
    expect([...b.headers.entries()]).toEqual([...a.headers.entries()]);
    expect(await b.text()).toBe(await a.text());
    today.abortReservations();
    off.abortReservations();
  });
});


