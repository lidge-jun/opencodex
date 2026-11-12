import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { OcxConfig } from "../../src/types";
import { createLinkWebsocketGate } from "../../src/server/index/link-websocket";
import { LINK_WS_LIMITS, setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import { requestPolicyView } from "../../src/server/auth-cors";
import { CodexWebSocketActivity } from "../../src/codex/websocket-activity";
import { codexWebSocketAdmissionMetrics, tryReserveCodexWebSocket } from "../../src/codex/websocket-registry";
import { createLinkActivity, isLinkIdle } from "../../src/link/child-activity";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import type { AdmissionReservation } from "../../src/lib/admission";
import type { WsData } from "../../src/server/ws-bridge";

// Lane T5b: the switch-off drain of design 2.5, the idle and age closes of 6.5, link-only reclaim
// (6.4) and link socket activity (section 5, first part). Clocks and timers are injected.

const KEY = { id: "drain-key", key: "drain-secret-0123456789", linkId: "lnk_dddddddddddddddd" };
const MINUTE = 60_000;

beforeEach(() => setLinkWebsocketTransportReadyForTests(true));
afterEach(() => setLinkWebsocketTransportReadyForTests(false));

function policy() {
  const config = { port: 0, apiKeys: [{ id: KEY.id, name: KEY.id, key: KEY.key, createdAt: "2026-11-12T00:00:00.000Z" }] } as OcxConfig;
  return requestPolicyView(config, "opencodex-link.invalid", { allowedKeyIds: new Set([KEY.id]) });
}

function upgradeRequest(): Request {
  return new Request("http://127.0.0.1/v1/responses", { headers: {
    upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    authorization: "Bearer " + KEY.key,
  } });
}

/** The shared handler's bookkeeping: a create starts a turn the test finishes by hand. */
function turnHandler() {
  const delivered: string[] = [];
  const finishes: Array<() => void> = [];
  let cancels = 0;
  const handler: WebSocketHandler<WsData> = {
    open(ws) { ws.data.admissionLease?.bind(ws); },
    message(ws, raw) {
      delivered.push(String(raw));
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      if (frame.type !== "response.create") return;
      ws.data.cancel?.();
      ws.data.cancel = () => { cancels += 1; };
      finishes.push(ws.data.responsesActivity!.beginTurn(frame.input));
    },
    close(ws) { ws.data.admissionLease?.release(); },
  };
  return { handler, delivered, finishes, cancels: () => cancels };
}

function harness(options: { reserveSocket?: () => AdmissionReservation<ServerWebSocket<WsData>> | null } = {}) {
  let now = 1_000_000;
  let on = true;
  const book = createLinkActivity({ now: () => now });
  const sweeps: Array<() => void> = [];
  const gate = createLinkWebsocketGate({
    enabled: () => on,
    policy,
    authorized: () => true,
    draining: () => false,
    now: () => now,
    activity: book,
    timers: { setInterval(callback) { sweeps.push(callback); return callback; }, clearInterval() {} },
    reserveSocket: options.reserveSocket ?? (() => ({
      bind(ws: ServerWebSocket<WsData>) { ws.data.responsesActivity = new CodexWebSocketActivity(); },
      release() {},
    })),
  });
  const base = turnHandler();
  const handler = gate.handler(base.handler);
  const open = () => {
    let data: WsData | undefined;
    const outcome = gate.upgrade(upgradeRequest(), { upgrade: (_req: Request, o: { data: WsData }) => { data = o.data; return true; } } as unknown as Server<unknown>,
      { keyId: KEY.id, linkId: KEY.linkId, fingerprint: serviceApiTokenFingerprint(KEY.key), release() {} });
    expect(outcome).toEqual({ handled: true, response: undefined });
    const closes: Array<[number, string]> = [];
    const ws = { data, readyState: 1, getBufferedAmount: () => 0, close(code: number, reason: string) { closes.push([code, reason]); } } as unknown as ServerWebSocket<WsData>;
    handler.open?.(ws);
    const send = (frame: Record<string, unknown>) => handler.message?.(ws, JSON.stringify(frame));
    return { ws, closes, send, activity: () => ws.data.responsesActivity! };
  };
  return {
    gate, base, handler, book, open,
    advance(ms: number) { now += ms; },
    switchOff() { on = false; },
    sweep() { for (const run of sweeps) run(); },
    now: () => now,
  };
}

const create = (input: unknown = "hello") => ({ type: "response.create", model: "m", input });
const toolCall = (callId: string) => JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_" + callId, call_id: callId, name: "shell", arguments: "{}" } });
const toolResult = (callId: string) => [{ type: "function_call_output", call_id: callId, output: "done" }];

describe("CodexWebSocketActivity additions (design 2.5, 5)", () => {
  test("returnsPending is read-only and true only for an input that returns a pending result", () => {
    const activity = new CodexWebSocketActivity();
    const finish = activity.beginTurn("start");
    activity.observePayload(toolCall("call_a"));
    finish();
    expect(activity.returnsPending(toolResult("call_b"))).toBe(false);
    expect(activity.returnsPending("plain text")).toBe(false);
    expect(activity.returnsPending(toolResult("call_a"))).toBe(true);
    expect(activity.returnsPending(toolResult("call_a"))).toBe(true);
    expect(activity.idle).toBe(false);
    expect(activity.running).toBe(false);
  });

  test("onChange fires on turn start and end, a new wait, a returned result and closing", () => {
    const activity = new CodexWebSocketActivity();
    const seen: string[] = [];
    activity.onChange(() => seen.push((activity.running ? "running" : "stopped") + "/" + (activity.idle ? "idle" : "busy")));
    const finish = activity.beginTurn("start");
    activity.observePayload(toolCall("call_a"));
    finish();
    activity.beginTurn(toolResult("call_a"))();
    activity.closing = true;
    expect(seen).toEqual(["running/busy", "running/busy", "stopped/busy", "running/busy", "stopped/idle", "stopped/busy"]);
  });
});

describe("switch-off drain (design 2.5, 11.1-5)", () => {
  test("a create that returns a pending result, with no turn running, is admitted", () => {
    const h = harness();
    const s = h.open();
    s.send(create());
    s.activity().observePayload(toolCall("call_a"));
    h.base.finishes[0]!();
    h.switchOff();
    h.sweep();
    expect(s.closes).toEqual([]);
    s.send(create(toolResult("call_a")));
    expect(h.base.delivered).toHaveLength(2);
    expect(s.closes).toEqual([]);
  });

  test("a create during a running turn is not admitted, does not cancel it, and the socket closes after it", () => {
    const h = harness();
    const s = h.open();
    s.send(create());
    h.switchOff();
    s.send(create("second"));
    expect(h.base.delivered).toHaveLength(1);
    expect(h.base.cancels()).toBe(0);
    expect(s.closes).toEqual([]);
    h.base.finishes[0]!();
    expect(s.closes).toEqual([[1000, "link websocket disabled"]]);
    s.send(create("late"));
    expect(h.base.delivered).toHaveLength(1);
  });

  test("a new conversation, or a socket with untracked results, is fenced and not admitted", () => {
    const fresh = harness();
    const a = fresh.open();
    fresh.switchOff();
    a.send(create("new conversation"));
    expect(fresh.base.delivered).toHaveLength(0);
    expect(a.closes).toEqual([[1000, "link websocket disabled"]]);

    const untracked = harness();
    const b = untracked.open();
    b.send(create());
    b.activity().observePayload(JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_x", name: "shell", arguments: "{}" } }));
    untracked.base.finishes[0]!();
    untracked.switchOff();
    b.send(create(toolResult("anything")));
    expect(untracked.base.delivered).toHaveLength(1);
    expect(b.closes).toEqual([[1000, "link websocket disabled"]]);
  });

  test("at the 60-minute deadline a streaming turn finishes and nothing more is admitted", () => {
    const h = harness();
    const s = h.open();
    s.send(create());
    s.activity().observePayload(toolCall("call_a"));
    h.switchOff();
    h.sweep();
    h.advance(LINK_WS_LIMITS.drainDeadlineMs);
    h.sweep();
    expect(s.closes).toEqual([]);
    expect(h.base.cancels()).toBe(0);
    h.base.finishes[0]!();
    expect(s.closes).toEqual([[1000, "link websocket disabled"]]);
    s.send(create(toolResult("call_a")));
    expect(h.base.delivered).toHaveLength(1);
  });

  test("after the deadline a waiting socket is fenced instead of admitted", () => {
    const h = harness();
    const s = h.open();
    s.send(create());
    s.activity().observePayload(toolCall("call_a"));
    h.base.finishes[0]!();
    h.switchOff();
    h.sweep();
    h.advance(LINK_WS_LIMITS.drainDeadlineMs);
    s.send(create(toolResult("call_a")));
    expect(h.base.delivered).toHaveLength(1);
    expect(s.closes).toEqual([[1000, "link websocket disabled"]]);
  });

  test("a frame racing the fence is not admitted", () => {
    const h = harness();
    const s = h.open();
    h.switchOff();
    h.sweep();
    expect(s.closes).toEqual([[1000, "link websocket disabled"]]);
    s.send(create(toolResult("call_a")));
    expect(h.base.delivered).toHaveLength(0);
  });
});

describe("idle and age (design 6.5)", () => {
  test("an idle link socket closes after 10 minutes; a busy one never does", () => {
    const h = harness();
    const idle = h.open();
    const busy = h.open();
    busy.send(create());
    h.advance(LINK_WS_LIMITS.idleCloseMs - 1);
    h.sweep();
    expect(idle.closes).toEqual([]);
    h.advance(1);
    h.sweep();
    expect(idle.closes).toEqual([[1000, "link websocket idle"]]);
    h.advance(10 * LINK_WS_LIMITS.idleCloseMs);
    h.sweep();
    expect(busy.closes).toEqual([]);
  });

  test("a socket older than 60 minutes closes at its next idle moment, never while busy", () => {
    const h = harness();
    const s = h.open();
    s.send(create());
    h.advance(LINK_WS_LIMITS.maxAgeMs + MINUTE);
    h.sweep();
    expect(s.closes).toEqual([]);
    h.base.finishes[0]!();
    expect(s.closes).toEqual([[1000, "link websocket reauthenticate"]]);
  });
});

describe("link socket activity (design 5, 11.1-8 first bullet)", () => {
  test("a link socket counts in flight during a turn and while a tool result is pending, and idles after", () => {
    const h = harness();
    const s = h.open();
    expect(h.book.snapshot(KEY.linkId, h.now()).inFlight).toBe(0);
    s.send(create());
    expect(h.book.snapshot(KEY.linkId, h.now()).inFlight).toBe(1);
    s.activity().observePayload(toolCall("call_a"));
    h.base.finishes[0]!();
    expect(h.book.snapshot(KEY.linkId, h.now()).inFlight).toBe(1);
    h.advance(MINUTE);
    s.send(create(toolResult("call_a")));
    h.base.finishes[1]!();
    const snapshot = h.book.snapshot(KEY.linkId, h.now());
    expect(snapshot).toMatchObject({ inFlight: 0, lastDataEndAt: h.now() });
    expect(isLinkIdle(snapshot, h.now() + 10 * MINUTE)).toBe(true);
  });

  test("closing a socket ends its count", () => {
    const h = harness();
    const s = h.open();
    s.send(create());
    expect(h.book.snapshot(KEY.linkId, h.now()).inFlight).toBe(1);
    h.handler.close?.(s.ws, 1006, "");
    expect(h.book.snapshot(KEY.linkId, h.now()).inFlight).toBe(0);
  });
});

describe("link-only reclaim (design 6.4)", () => {
  test("a full gate lets a link upgrade reclaim an idle link socket, never a local one", () => {
    const before = codexWebSocketAdmissionMetrics().active;
    const leases: Array<AdmissionReservation<ServerWebSocket<WsData>>> = [];
    const closed: string[] = [];
    try {
      let index = 0;
      for (;;) {
        const lease = tryReserveCodexWebSocket({ reclaim: false });
        if (!lease) break;
        const name = (index === 5 ? "link-" : "local-") + index++;
        const data: WsData = name.startsWith("link-") ? { link: { linkId: KEY.linkId, keyId: KEY.id, fingerprint: "", fenced: false, leases: { closed() {} } } } : {};
        lease.bind({ data, readyState: 1, getBufferedAmount: () => 0, close: () => { closed.push(name); } } as unknown as ServerWebSocket<WsData>);
        leases.push(lease);
      }
      expect(tryReserveCodexWebSocket({ reclaim: "link" })).toBeNull();
      expect(closed).toEqual(["link-5"]);
    } finally {
      for (const lease of leases) lease.release();
    }
    expect(codexWebSocketAdmissionMetrics().active).toBe(before);
  });
});

