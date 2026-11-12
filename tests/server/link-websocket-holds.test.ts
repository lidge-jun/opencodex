import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { OcxConfig } from "../../src/types";
import { createLinkWebsocketGate } from "../../src/server/index/link-websocket";
import { setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import { createLinkListenerLifecycle } from "../../src/server/index/link-listener";
import { requestPolicyView } from "../../src/server/auth-cors";
import { CodexWebSocketActivity } from "../../src/codex/websocket-activity";
import { createActivityHolds } from "../../src/link/ws-activity-holds";
import { createLinkActivity } from "../../src/link/child-activity";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import type { LinkStore } from "../../src/link/store";
import type { WsData } from "../../src/server/ws-bridge";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { LinkWireClient } from "../helpers/link-ws-client";

// Lane T5d1: link WebSocket closes that leave durable activity holds, and their release (design T4 5).

const KEY = { id: "hold-key", key: "hold-secret-0123456789", linkId: "lnk_eeeeeeeeeeeeeeee" };
let dir = "";
const previousHome = process.env.OPENCODEX_HOME;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  setLinkWebsocketTransportReadyForTests(true);
  dir = mkdtempSync(join(tmpdir(), "ocx-link-ws-holds-"));
  process.env.OPENCODEX_HOME = dir;
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  setLinkWebsocketTransportReadyForTests(false);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (dir) removeTreeWithRetry(dir);
  dir = "";
});

function policy() {
  const config = { port: 0, apiKeys: [{ id: KEY.id, name: KEY.id, key: KEY.key, createdAt: "2026-11-12T00:00:00.000Z" }] } as OcxConfig;
  return requestPolicyView(config, "opencodex-link.invalid", { allowedKeyIds: new Set([KEY.id]) });
}

function upgradeRequest(thread: string | null): Request {
  return new Request("http://127.0.0.1/v1/responses", { headers: {
    upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    authorization: "Bearer " + KEY.key, ...(thread ? { "thread-id": thread } : {}),
  } });
}

function turnHandler() {
  const finishes: Array<() => void> = [];
  const handler: WebSocketHandler<WsData> = {
    open(ws) { ws.data.admissionLease?.bind(ws); },
    message(ws, raw) {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      if (frame.type === "response.create") finishes.push(ws.data.responsesActivity!.beginTurn(frame.input));
    },
    close(ws) { ws.data.admissionLease?.release(); },
  };
  return { handler, finishes };
}

function harness(options: { armFails?: boolean } = {}) {
  const holds = createActivityHolds({ dir, linkIds: () => [KEY.linkId], ...(options.armFails ? { writeHooks: { beforeRename() { throw new Error("EROFS"); } } } : {}) });
  holds.start();
  const book = createLinkActivity({ held: linkId => holds.count(linkId) });
  const gate = createLinkWebsocketGate({
    enabled: () => true, policy, authorized: () => true, draining: () => false, activity: book, holds,
    timers: { setInterval: () => 0, clearInterval() {} },
    reserveSocket: () => ({ bind(ws: ServerWebSocket<WsData>) { ws.data.responsesActivity = new CodexWebSocketActivity(); }, release() {} }),
  });
  const base = turnHandler();
  const handler = gate.handler(base.handler);
  const open = (thread: string | null = "thread-a") => {
    let data: WsData | undefined;
    const outcome = gate.upgrade(upgradeRequest(thread), { upgrade: (_r: Request, o: { data: WsData }) => { data = o.data; return true; } } as unknown as Server<unknown>,
      { keyId: KEY.id, linkId: KEY.linkId, fingerprint: serviceApiTokenFingerprint(KEY.key), release() {} });
    if (!data) return { outcome };
    const ws = { data, readyState: 1, getBufferedAmount: () => 0, close() {} } as unknown as ServerWebSocket<WsData>;
    handler.open?.(ws);
    return { outcome, ws, send: (frame: unknown) => handler.message?.(ws, JSON.stringify(frame)), close: () => handler.close?.(ws, 1006, "") };
  };
  return { holds, book, gate, base, open, inFlight: () => book.snapshot(KEY.linkId, Date.now()).inFlight };
}

const create = (input: unknown = "go") => ({ type: "response.create", model: "m", input });
const toolCall = (callId: string) => JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_" + callId, call_id: callId, name: "shell", arguments: "{}" } });
const result = (callId: string) => [{ type: "function_call_output", call_id: callId, output: "ok" }];

describe("holds from link socket closes (11.1-8)", () => {
  test("a close during a turn leaves a hold that keeps the link in flight; an idle close leaves none", () => {
    const h = harness();
    const idle = h.open()!;
    idle.close!();
    expect(h.holds.count(KEY.linkId)).toBe(0);
    const busy = h.open()!;
    busy.send!(create());
    busy.close!();
    expect(h.holds.describe(KEY.linkId).holds).toBe(1);
    expect(h.inFlight()).toBe(1);
  });

  test("a revoked socket leaves no hold", () => {
    const h = harness();
    const s = h.open()!;
    s.send!(create());
    expect(h.gate.closeLink(KEY.linkId)).toBe(1);
    s.close!();
    expect(h.holds.count(KEY.linkId)).toBe(0);
  });

  test("a socket closed with a tool pending is released when the same thread returns the result on another socket", () => {
    const h = harness();
    const first = h.open("thread-a")!;
    first.send!(create());
    first.ws!.data.responsesActivity!.observePayload(toolCall("call_1"));
    h.base.finishes[0]!();
    first.close!();
    expect(h.inFlight()).toBe(1);
    const sibling = h.open("thread-b")!;
    sibling.send!(create(result("call_1")));
    expect(h.holds.count(KEY.linkId)).toBe(1);
    const same = h.open("thread-a")!;
    same.send!(create(result("call_1")));
    expect(h.holds.count(KEY.linkId)).toBe(0);
  });

  test("a socket without a thread id leaves an operator-only hold", () => {
    const h = harness();
    const s = h.open(null)!;
    s.send!(create());
    s.ws!.data.responsesActivity!.observePayload(toolCall("call_1"));
    h.base.finishes[0]!();
    s.close!();
    const other = h.open(null)!;
    other.send!(create(result("call_1")));
    expect(h.holds.count(KEY.linkId)).toBe(1);
  });

  test("a fence that cannot be written refuses link upgrades", () => {
    const h = harness({ armFails: true });
    const attempt = h.open();
    expect(attempt.outcome.handled).toBe(true);
    expect((attempt.outcome as { response: Response }).response.status).toBe(426);
  });
});

describe("release over HTTP through the real listener", () => {
  test("a relayed POST on the same own thread that returns the pending result releases the hold", async () => {
    const store: LinkStore = { version: 1, listenerPort: null, links: [{ id: KEY.linkId, alias: "holds", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY.id, createdAt: "2026-11-12T00:00:00.000Z" }] as LinkStore["links"] };
    const current = { value: store };
    let finish: (() => void) | undefined;
    const seen: { message?: () => void; closed?: () => void; posted?: () => void } = {};
    const base: WebSocketHandler<WsData> = {
      open(ws) { ws.data.admissionLease?.bind(ws); },
      message(ws) {
        finish = ws.data.responsesActivity!.beginTurn("go");
        ws.data.responsesActivity!.observePayload(toolCall("call_9"));
        seen.message?.();
      },
      close(ws) { ws.data.admissionLease?.release(); seen.closed?.(); },
    };
    const lifecycle = createLinkListenerLifecycle<WsData>({
      storePath: join(dir, "link", "links.json"), readStore: () => current.value, writeStore: (_p, next) => { current.value = next; }, warn: () => {},
    });
    lifecycle.start({
      maxRequestBodySize: 1 << 20,
      // Like the Responses handler, read the whole request before answering.
      dispatch: async req => { await req.text(); seen.posted?.(); return new Response("{}", { status: 200 }); },
      keyFingerprints: () => [serviceApiTokenFingerprint(KEY.key)],
      responsesWebsocket: { handler: base, enabled: () => true, policy },
    });
    cleanups.push(() => lifecycle.stop());
    const port = lifecycle.status().port!;
    const identity = { keyId: KEY.id, linkId: KEY.linkId, fingerprint: serviceApiTokenFingerprint(KEY.key) };
    const ws = await LinkWireClient.open(port);
    const { nonce } = await ws.challenge(identity);
    expect((await ws.upgrade({ nonce, bearer: KEY.key, headers: { "thread-id": "thread-h" } })).status).toBe(101);
    const delivered = new Promise<void>(resolve => { seen.message = resolve; });
    ws.sendText("{}");
    await delivered;
    finish!();
    const closed = new Promise<void>(resolve => { seen.closed = resolve; });
    ws.destroy();
    await closed;
    expect(lifecycle.linkActivity(KEY.linkId, Date.now()).inFlight).toBe(1);

    const http = await LinkWireClient.open(port);
    const second = await http.challenge(identity);
    http.sendRequest("POST /v1/responses HTTP/1.1", { host: "127.0.0.1", "content-type": "application/json", authorization: "Bearer " + KEY.key, "x-opencodex-link-session": second.nonce, "thread-id": "thread-h" },
      JSON.stringify({ model: "m", input: result("call_9") }));
    expect((await http.readHead()).status).toBe(200);
    // The observation registered before dispatch, so it is in the set by the time the answer arrives.
    await lifecycle.activityHoldsSettled();
    http.destroy();
    expect(lifecycle.linkActivity(KEY.linkId, Date.now()).inFlight).toBe(0);
  });
});

