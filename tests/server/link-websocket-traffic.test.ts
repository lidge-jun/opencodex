import { describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { OcxConfig } from "../../src/types";
import { createLinkWebsocketGate } from "../../src/server/index/link-websocket";
import { requestPolicyView } from "../../src/server/auth-cors";
import { createLinkTrafficBook, type LinkTrafficBook } from "../../src/link/traffic";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { sendTextFrame, type WsData } from "../../src/server/ws-bridge";

// The Home counts a link socket in its per-link traffic book as the Child does (structure/remote-link.md, lane T6): one
// request per socket, message payload bytes each way, without framing, handshake or control frames, complete when a
// close frame ended it.

const KEY = { id: "traffic-key", key: "traffic-secret-0123456789", linkId: "lnk_cccccccccccccccc" };

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

/** A link socket opened through the gate, with a fake Bun socket whose send answers what the test says. */
function linkSocket(traffic: LinkTrafficBook, sendResult: () => number = () => 1) {
  const received: string[] = [];
  const base: WebSocketHandler<WsData> = { open() {}, message(_ws, raw) { received.push(String(raw)); }, close() {} };
  const gate = createLinkWebsocketGate({
    enabled: () => true, policy, authorized: () => true, draining: () => false, traffic,
    timers: { setInterval: () => 0, clearInterval() {} },
    reserveSocket: () => ({ bind() {}, release() {} }),
  });
  const handler = gate.handler(base);
  let data: WsData | undefined;
  gate.upgrade(upgradeRequest(), { upgrade: (_req: Request, options: { data: WsData }) => { data = options.data; return true; } } as unknown as Server<unknown>,
    { keyId: KEY.id, linkId: KEY.linkId, fingerprint: serviceApiTokenFingerprint(KEY.key), release() {} });
  const ws = { data: data!, readyState: 1, send: () => sendResult(), getBufferedAmount: () => 0, close() {} } as unknown as ServerWebSocket<WsData>;
  return {
    ws, received,
    open: () => handler.open?.(ws),
    message: (raw: string | Buffer) => handler.message?.(ws, raw),
    close: (code: number) => handler.close?.(ws, code, ""),
  };
}

describe("the Home's traffic book counts a link socket", () => {
  test("one request, payload bytes each way, complete when a close ended it", () => {
    const traffic = createLinkTrafficBook("content-length");
    const socket = linkSocket(traffic);
    socket.open();
    expect(traffic.snapshot(KEY.linkId)).toMatchObject({ requests: 1, toHomeBytes: 0, fromHomeBytes: 0, incomplete: 0 });
    socket.message('{"type":"response.create","input":"héllo"}');
    socket.message(Buffer.from("raw"));
    sendTextFrame(socket.ws, '{"type":"response.created"}');
    sendTextFrame(socket.ws, "ünïcode");
    socket.close(1000);
    expect(traffic.snapshot(KEY.linkId)).toMatchObject({
      requests: 1, incomplete: 0,
      toHomeBytes: Buffer.byteLength('{"type":"response.create","input":"héllo"}') + 3,
      fromHomeBytes: Buffer.byteLength('{"type":"response.created"}') + Buffer.byteLength("ünïcode"),
    });
  });

  test("a socket dropped without a close is incomplete", () => {
    const traffic = createLinkTrafficBook("content-length");
    const socket = linkSocket(traffic);
    socket.open();
    socket.close(1006);
    expect(traffic.snapshot(KEY.linkId)).toMatchObject({ requests: 1, incomplete: 1 });
  });

  test("a message Bun dropped is not counted; one Bun queued under backpressure is", () => {
    const traffic = createLinkTrafficBook("content-length");
    let result = 0;
    const socket = linkSocket(traffic, () => result);
    socket.open();
    expect(() => sendTextFrame(socket.ws, "dropped")).toThrow();
    result = -1;
    sendTextFrame(socket.ws, "queued");
    expect(traffic.snapshot(KEY.linkId).fromHomeBytes).toBe(Buffer.byteLength("queued"));
  });

  test("a refused or failed upgrade counts nothing", () => {
    const traffic = createLinkTrafficBook("content-length");
    // calls: how often the gate reached server.upgrade (0 for the refusal, 1 for the failed upgrade).
    const cases = [{ authorized: false, upgraded: true, status: 401, calls: 0 }, { authorized: true, upgraded: false, status: 426, calls: 1 }];
    for (const { authorized, upgraded, status, calls } of cases) {
      let reached = 0;
      const gate = createLinkWebsocketGate({
        enabled: () => true, policy, authorized: () => authorized, draining: () => false, traffic,
        timers: { setInterval: () => 0, clearInterval() {} },
        reserveSocket: () => ({ bind() {}, release() {} }),
      });
      const outcome = gate.upgrade(upgradeRequest(), { upgrade: () => { reached += 1; return upgraded; } } as unknown as Server<unknown>,
        { keyId: KEY.id, linkId: KEY.linkId, fingerprint: serviceApiTokenFingerprint(KEY.key), release() {} });
      expect(outcome.handled && outcome.response?.status).toBe(status);
      expect(reached).toBe(calls);
    }
    expect(traffic.snapshot(KEY.linkId)).toMatchObject({ requests: 0, incomplete: 0, toHomeBytes: 0, fromHomeBytes: 0 });
  });

  test("a local socket is never counted", () => {
    const traffic = createLinkTrafficBook("content-length");
    const ws = { data: {} as WsData, readyState: 1, send: () => 1 } as unknown as ServerWebSocket<WsData>;
    sendTextFrame(ws, "local");
    expect(traffic.snapshot(KEY.linkId)).toMatchObject({ requests: 0, fromHomeBytes: 0 });
  });
});
