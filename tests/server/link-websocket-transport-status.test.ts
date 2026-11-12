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
