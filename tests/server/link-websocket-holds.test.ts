import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { OcxConfig } from "../../src/types";
import { createLinkWebsocketGate } from "../../src/server/index/link-websocket";
import { LINK_WS_LIMITS, setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import { createLinkListenerLifecycle } from "../../src/server/index/link-listener";
import { requestPolicyView } from "../../src/server/auth-cors";
import { CodexWebSocketActivity } from "../../src/codex/websocket-activity";
import { createActivityHolds } from "../../src/link/ws-activity-holds";
import { createLinkActivity } from "../../src/link/child-activity";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import type { LinkStore } from "../../src/link/store";
import type { WsData } from "../../src/server/ws-bridge";
import * as requestDecompress from "../../src/server/request-decompress";
import { createInboundBodyBudget } from "../../src/server/inbound-body-budget";
import { withRaisedInboundBodyAdmission } from "../../src/server/inbound-body-admission";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { LinkWireClient } from "../helpers/link-ws-client";
import { chunkedResponse, relayHarness } from "../helpers/link-relay-harness";
import type { LinkActivity } from "../../src/link/child-activity";
import type { LinkTrafficBook } from "../../src/link/traffic";
import { linkTurnPacesReads, observeLinkTurnExpansion } from "../../src/server/link-turn";

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

const refuseAdmission = { value: false };

function turnHandler() {
  const finishes: Array<() => void> = [];
  const handler: WebSocketHandler<WsData> = {
    open(ws) { ws.data.admissionLease?.bind(ws); },
    message(ws, raw) {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      // Like the shared handler: a warmup or a refused admission never begins a turn, and an admitted
      // turn whose pipeline answered ok is reported as accepted (websocket-handler.ts notifyAccepted).
      if (frame.type !== "response.create" || frame.generate === false || refuseAdmission.value) return;
      finishes.push(ws.data.responsesActivity!.beginTurn(frame.input));
      ws.data.responsesActivity!.notifyAccepted(frame.input);
    },
    close(ws) { ws.data.admissionLease?.release(); },
  };
  return { handler, finishes };
}

function harness(options: { armFails?: boolean } = {}) {
  const holds = createActivityHolds({ dir, linkIds: () => [KEY.linkId], limits: LINK_WS_LIMITS, ...(options.armFails ? { writeHooks: { beforeRename() { throw new Error("EROFS"); } } } : {}) });
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

  test("a warmup or a create refused admission releases nothing; an admitted create on the same thread does (T5d1-R2-02)", () => {
    const h = harness();
    const first = h.open("thread-w")!;
    first.send!(create());
    first.ws!.data.responsesActivity!.observePayload(toolCall("call_w"));
    h.base.finishes[0]!();
    first.close!();
    const next = h.open("thread-w")!;
    next.send!({ ...create(result("call_w")), generate: false });
    expect(h.holds.count(KEY.linkId)).toBe(1);
    refuseAdmission.value = true;
    try { next.send!(create(result("call_w"))); } finally { refuseAdmission.value = false; }
    expect(h.holds.count(KEY.linkId)).toBe(1);
    next.send!(create(result("call_w")));
    expect(h.holds.count(KEY.linkId)).toBe(0);
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
  test("a relayed POST that the handler refuses after reading its body releases nothing (T5d1-R1-03)", async () => {
    const store: LinkStore = { version: 1, listenerPort: null, links: [{ id: KEY.linkId, alias: "holds", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY.id, createdAt: "2026-11-12T00:00:00.000Z" }] as LinkStore["links"] };
    const current = { value: store };
    let finish: (() => void) | undefined;
    const seen: { message?: () => void; closed?: () => void } = {};
    let status = 400;
    const base: WebSocketHandler<WsData> = {
      open(ws) { ws.data.admissionLease?.bind(ws); },
      message(ws) { finish = ws.data.responsesActivity!.beginTurn("go"); ws.data.responsesActivity!.observePayload(toolCall("call_7")); seen.message?.(); },
      close(ws) { ws.data.admissionLease?.release(); seen.closed?.(); },
    };
    const lifecycle = createLinkListenerLifecycle<WsData>({ storePath: join(dir, "link", "links.json"), readStore: () => current.value, writeStore: (_p, next) => { current.value = next; }, warn: () => {} });
    lifecycle.start({
      maxRequestBodySize: 1 << 20,
      dispatch: async req => { await req.text(); return new Response("{}", { status }); },
      keyFingerprints: () => [serviceApiTokenFingerprint(KEY.key)],
      responsesWebsocket: { handler: base, enabled: () => true, policy },
    });
    cleanups.push(() => lifecycle.stop());
    const port = lifecycle.status().port!;
    const identity = { keyId: KEY.id, linkId: KEY.linkId, fingerprint: serviceApiTokenFingerprint(KEY.key) };
    const ws = await LinkWireClient.open(port);
    const { nonce } = await ws.challenge(identity);
    expect((await ws.upgrade({ nonce, bearer: KEY.key, headers: { "thread-id": "thread-r" } })).status).toBe(101);
    const delivered = new Promise<void>(resolve => { seen.message = resolve; });
    ws.sendText("{}");
    await delivered;
    finish!();
    const closed = new Promise<void>(resolve => { seen.closed = resolve; });
    ws.destroy();
    await closed;
    const post = async () => {
      const http = await LinkWireClient.open(port);
      const session = await http.challenge(identity);
      http.sendRequest("POST /v1/responses HTTP/1.1", { host: "127.0.0.1", "content-type": "application/json", authorization: "Bearer " + KEY.key, "x-opencodex-link-session": session.nonce, "thread-id": "thread-r" },
        JSON.stringify({ model: "m", input: result("call_7") }));
      const head = await http.readHead();
      await lifecycle.activityHoldsSettled();
      http.destroy();
      return head.status;
    };
    expect(await post()).toBe(400);
    expect(lifecycle.linkActivity(KEY.linkId, Date.now()).inFlight).toBe(1);
    status = 200;
    expect(await post()).toBe(200);
    expect(lifecycle.linkActivity(KEY.linkId, Date.now()).inFlight).toBe(0);
  });

  test("a relayed POST whose body the Child sent zstd-coded (#8594) releases the hold like a plain one", async () => {
    const store: LinkStore = { version: 1, listenerPort: null, links: [{ id: KEY.linkId, alias: "holds", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY.id, createdAt: "2026-11-12T00:00:00.000Z" }] as LinkStore["links"] };
    const current = { value: store };
    let finish: (() => void) | undefined;
    const seen: { message?: () => void; closed?: () => void } = {};
    const base: WebSocketHandler<WsData> = {
      open(ws) { ws.data.admissionLease?.bind(ws); },
      message(ws) { finish = ws.data.responsesActivity!.beginTurn("go"); ws.data.responsesActivity!.observePayload(toolCall("call_z")); seen.message?.(); },
      close(ws) { ws.data.admissionLease?.release(); seen.closed?.(); },
    };
    const lifecycle = createLinkListenerLifecycle<WsData>({ storePath: join(dir, "link", "links.json"), readStore: () => current.value, writeStore: (_p, next) => { current.value = next; }, warn: () => {} });
    lifecycle.start({
      maxRequestBodySize: 1 << 20,
      dispatch: async req => { await req.arrayBuffer(); return new Response("{}", { status: 200 }); },
      keyFingerprints: () => [serviceApiTokenFingerprint(KEY.key)],
      responsesWebsocket: { handler: base, enabled: () => true, policy },
    });
    cleanups.push(() => lifecycle.stop());
    const port = lifecycle.status().port!;
    const identity = { keyId: KEY.id, linkId: KEY.linkId, fingerprint: serviceApiTokenFingerprint(KEY.key) };
    const ws = await LinkWireClient.open(port);
    const { nonce } = await ws.challenge(identity);
    expect((await ws.upgrade({ nonce, bearer: KEY.key, headers: { "thread-id": "thread-z" } })).status).toBe(101);
    const delivered = new Promise<void>(resolve => { seen.message = resolve; });
    ws.sendText("{}");
    await delivered;
    finish!();
    const closed = new Promise<void>(resolve => { seen.closed = resolve; });
    ws.destroy();
    await closed;
    expect(lifecycle.linkActivity(KEY.linkId, Date.now()).inFlight).toBe(1);

    const http = await LinkWireClient.open(port);
    const session = await http.challenge(identity);
    const coded = Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify({ model: "m", input: result("call_z") })));
    http.sendRequest("POST /v1/responses HTTP/1.1", { host: "127.0.0.1", "content-type": "application/json", "content-encoding": "zstd", authorization: "Bearer " + KEY.key, "x-opencodex-link-session": session.nonce, "thread-id": "thread-z" }, coded);
    expect((await http.readHead()).status).toBe(200);
    await lifecycle.activityHoldsSettled();
    http.destroy();
    expect(lifecycle.linkActivity(KEY.linkId, Date.now()).inFlight).toBe(0);
  });

  // #8608: the copy is decoded only after the handler accepted the request, under the listener's resolved inbound limit.
  async function heldLink(thread: string, callId: string, maxRequestBodySize: number, dispatch: (req: Request) => Promise<Response>) {
    const store: LinkStore = { version: 1, listenerPort: null, links: [{ id: KEY.linkId, alias: "holds", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY.id, createdAt: "2026-11-12T00:00:00.000Z" }] as LinkStore["links"] };
    const current = { value: store };
    let finish: (() => void) | undefined;
    const seen: { message?: () => void; closed?: () => void } = {};
    const base: WebSocketHandler<WsData> = {
      open(ws) { ws.data.admissionLease?.bind(ws); },
      message(ws) { finish = ws.data.responsesActivity!.beginTurn("go"); ws.data.responsesActivity!.observePayload(toolCall(callId)); seen.message?.(); },
      close(ws) { ws.data.admissionLease?.release(); seen.closed?.(); },
    };
    const lifecycle = createLinkListenerLifecycle<WsData>({ storePath: join(dir, "link", "links.json"), readStore: () => current.value, writeStore: (_p, next) => { current.value = next; }, warn: () => {} });
    lifecycle.start({ maxRequestBodySize, dispatch, keyFingerprints: () => [serviceApiTokenFingerprint(KEY.key)], responsesWebsocket: { handler: base, enabled: () => true, policy } });
    cleanups.push(() => lifecycle.stop());
    const port = lifecycle.status().port!;
    const identity = { keyId: KEY.id, linkId: KEY.linkId, fingerprint: serviceApiTokenFingerprint(KEY.key) };
    const ws = await LinkWireClient.open(port);
    const { nonce } = await ws.challenge(identity);
    expect((await ws.upgrade({ nonce, bearer: KEY.key, headers: { "thread-id": thread } })).status).toBe(101);
    const delivered = new Promise<void>(resolve => { seen.message = resolve; });
    ws.sendText("{}");
    await delivered;
    finish!();
    const closed = new Promise<void>(resolve => { seen.closed = resolve; });
    ws.destroy();
    await closed;
    expect(lifecycle.linkActivity(KEY.linkId, Date.now()).inFlight).toBe(1);
    const postZstd = async (body: Uint8Array) => {
      const http = await LinkWireClient.open(port);
      const session = await http.challenge(identity);
      http.sendRequest("POST /v1/responses HTTP/1.1", { host: "127.0.0.1", "content-type": "application/json", "content-encoding": "zstd", authorization: "Bearer " + KEY.key, "x-opencodex-link-session": session.nonce, "thread-id": thread }, body);
      const head = await http.readHead();
      await lifecycle.activityHoldsSettled();
      http.destroy();
      return head.status;
    };
    return { lifecycle, postZstd, port, identity };
  }

  test("a relayed POST that the inbound body budget refuses never decodes the copy (#8608)", async () => {
    // The handler admits through the real inbound body budget, which another request already fills: an encoded body
    // reserves 8 MiB, the budget has none left, and the refusal cancels the handler's half unread with a 503. The upload
    // has fully arrived by then, as it does while a request waits in the budget's queue (read here through a clone first).
    const budget = createInboundBodyBudget(8 << 20);
    const occupied = await budget.acquire(8 << 20, new AbortController().signal);
    let worked = false;
    const { lifecycle, postZstd } = await heldLink("thread-b", "call_b", 1 << 20, async req => {
      await req.clone().arrayBuffer();
      return withRaisedInboundBodyAdmission(req, "/v1/responses", undefined,
        async () => { worked = true; await req.arrayBuffer(); return new Response("{}", { status: 200 }); }, undefined, { budget, maxWaitMs: 0 });
    });
    const decode = spyOn(requestDecompress, "decodeRequestBody");
    try {
      expect(await postZstd(Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify({ model: "m", input: result("call_b") }))))).toBe(503);
      expect(decode).not.toHaveBeenCalled();
    } finally { decode.mockRestore(); }
    expect(worked).toBe(false);
    expect(lifecycle.linkActivity(KEY.linkId, Date.now()).inFlight).toBe(1);
    occupied!.release();
  });

  test("an accepted relayed POST whose copy decodes past the resolved inbound limit releases nothing (#8608)", async () => {
    // The listener's resolved limit is 1 MiB; the body decodes to about 2 MiB, under the 8 MiB ratio floor, so only the limit refuses it.
    const { lifecycle, postZstd } = await heldLink("thread-l", "call_l", 1 << 20, async req => { await req.arrayBuffer(); return new Response("{}", { status: 200 }); });
    const large = JSON.stringify({ model: "m", input: result("call_l"), padding: "x".repeat(2 << 20) });
    expect(await postZstd(Bun.zstdCompressSync(new TextEncoder().encode(large)))).toBe(200);
    expect(lifecycle.linkActivity(KEY.linkId, Date.now()).inFlight).toBe(1);
    // Under the limit, the same accepted request releases the hold.
    expect(await postZstd(Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify({ model: "m", input: result("call_l") }))))).toBe(200);
    expect(lifecycle.linkActivity(KEY.linkId, Date.now()).inFlight).toBe(0);
  });

  test("a relayed POST aborted before its headers never decodes its copy, and the copy is cancelled (#8613 review)", async () => {
    let bodyRead!: () => void;
    const read = new Promise<void>(resolve => { bodyRead = resolve; });
    let abortSeen!: () => void;
    const aborted = new Promise<void>(resolve => { abortSeen = resolve; });
    const { lifecycle, port, identity } = await heldLink("thread-x", "call_x", 1 << 20, async req => {
      await req.arrayBuffer();
      bodyRead();
      // The Child goes away before the handler answers.
      await new Promise<void>(resolve => { if (req.signal.aborted) resolve(); else req.signal.addEventListener("abort", () => resolve(), { once: true }); });
      abortSeen();
      return new Response("{}", { status: 200 });
    });
    const originalClone = Request.prototype.clone;
    const copies: Request[] = [];
    const clone = spyOn(Request.prototype, "clone").mockImplementation(function (this: Request) { const copy = originalClone.call(this); copies.push(copy); return copy; });
    const decode = spyOn(requestDecompress, "decodeRequestBody");
    try {
      const http = await LinkWireClient.open(port);
      const session = await http.challenge(identity);
      http.sendRequest("POST /v1/responses HTTP/1.1", { host: "127.0.0.1", "content-type": "application/json", "content-encoding": "zstd", authorization: "Bearer " + KEY.key, "x-opencodex-link-session": session.nonce, "thread-id": "thread-x" },
        Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify({ model: "m", input: result("call_x") }))));
      await read;
      http.destroy();
      await aborted;
      await lifecycle.activityHoldsSettled();
      expect(decode).not.toHaveBeenCalled();
      expect(copies).toHaveLength(1);
      // The copy was consumed without a decode: the refusal cancelled it, so it holds no bytes for anyone to read.
      expect(copies[0]!.bodyUsed).toBe(true);
    } finally { clone.mockRestore(); decode.mockRestore(); }
    expect(lifecycle.linkActivity(KEY.linkId, Date.now()).inFlight).toBe(1);
  });
});

describe("a relayed POST whose traffic accounting throws (#8613 review)", () => {
  test("decides its body observation (not accepted) and releases its lease", async () => {
    const decisions: boolean[] = [];
    let ended = 0;
    const h = relayHarness({
      activity: { begin: () => () => { ended += 1; } } as unknown as LinkActivity,
      traffic: { begin: () => { throw new Error("traffic book failed"); } } as unknown as LinkTrafficBook,
      observeResponsesRequest: () => accepted => { decisions.push(accepted); },
    });
    const nonce = await h.session(KEY.linkId);
    const req = h.request("/v1/responses", { method: "POST", nonce, headers: { "content-type": "application/json" }, body: "{}" });
    await expect(h.dispatch(req, async () => new Response("{}"))).rejects.toThrow("traffic book failed");
    expect(decisions).toEqual([false]);
    expect(ended).toBe(1);
  });
  test("returns its lease on the body paths too when ending the flow throws: a body read to its end and a cancelled body", async () => {
    for (const how of ["read", "cancel"] as const) {
      let ended = 0;
      const flow = { toHome() {}, uncounted() {}, fromHome() {}, end() { throw new Error("end failed"); } };
      const h = relayHarness({
        activity: { begin: () => () => { ended += 1; } } as unknown as LinkActivity,
        traffic: { begin: () => flow } as unknown as LinkTrafficBook,
      });
      const nonce = await h.session(KEY.linkId);
      const req = h.request("/v1/responses", { method: "POST", nonce, headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" });
      const response = await h.dispatch(req, async () => chunkedResponse(["a", "b"]));
      if (how === "read") expect(await response.text()).toBe("ab");
      else { const reader = response.body!.getReader(); await reader.read(); await reader.cancel(); }
      expect({ how, ended }).toEqual({ how, ended: 1 });
    }
  });

  test("returns its lease for a body-less answer when ending the flow throws", async () => {
    let ended = 0;
    const flow = { toHome() {}, uncounted() {}, fromHome() {}, end() { throw new Error("end failed"); } };
    const h = relayHarness({
      activity: { begin: () => () => { ended += 1; } } as unknown as LinkActivity,
      traffic: { begin: () => flow } as unknown as LinkTrafficBook,
    });
    const nonce = await h.session(KEY.linkId);
    const req = h.request("/v1/responses", { method: "POST", nonce, headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" });
    expect((await h.dispatch(req, async () => new Response(null, { status: 204 }))).status).toBe(204);
    expect(ended).toBe(1);
  });

  test("returns its lease even when ending the broken flow throws too, before and after dispatch", async () => {
    for (const where of ["before", "after"] as const) {
      const decisions: boolean[] = [];
      let ended = 0;
      const flow = { toHome() { if (where === "before") throw new Error("count failed"); }, uncounted() {}, fromHome() {}, end() { throw new Error("end failed"); } };
      const h = relayHarness({
        activity: { begin: () => () => { ended += 1; } } as unknown as LinkActivity,
        traffic: { begin: () => flow } as unknown as LinkTrafficBook,
        observeResponsesRequest: () => accepted => { decisions.push(accepted); },
      });
      const nonce = await h.session(KEY.linkId);
      const req = h.request("/v1/responses", { method: "POST", nonce, headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" });
      await expect(h.dispatch(req, async () => { throw new Error("dispatch failed"); })).rejects.toThrow(where === "before" ? "count failed" : "dispatch failed");
      expect({ where, decisions, ended }).toEqual({ where, decisions: [false], ended: 1 });
    }
  });

});

describe("paced reads on the relay (#8601)", () => {
  test.each([[true, true], [false, false]] as const)("with the feature on=%p, a relayed POST's turn paces its reads: %p", async (on, expected) => {
    const store: LinkStore = { version: 1, listenerPort: null, links: [{ id: KEY.linkId, alias: "paced", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY.id, createdAt: "2026-11-12T00:00:00.000Z" }] as LinkStore["links"] };
    const seen: boolean[] = [];
    const lifecycle = createLinkListenerLifecycle<WsData>({ storePath: join(dir, "link", "links.json"), readStore: () => store, writeStore: () => {}, warn: () => {} });
    lifecycle.start({
      maxRequestBodySize: 1 << 20,
      // What preparation does with the relay's turn token: claim the observer for this request's log context.
      dispatch: async req => { const logCtx = {}; observeLinkTurnExpansion(undefined, req, logCtx, {}); seen.push(linkTurnPacesReads(logCtx)); await req.text(); return new Response("{}"); },
      keyFingerprints: () => [serviceApiTokenFingerprint(KEY.key)],
      responsesWebsocket: { handler: turnHandler().handler, enabled: () => on, policy },
    });
    cleanups.push(() => lifecycle.stop());
    const http = await LinkWireClient.open(lifecycle.status().port!);
    const session = await http.challenge({ keyId: KEY.id, linkId: KEY.linkId, fingerprint: serviceApiTokenFingerprint(KEY.key) });
    http.sendRequest("POST /v1/responses HTTP/1.1", { host: "127.0.0.1", "content-type": "application/json", authorization: "Bearer " + KEY.key, "x-opencodex-link-session": session.nonce }, JSON.stringify({ model: "m", input: "go" }));
    expect((await http.readHead()).status).toBe(200);
    http.destroy();
    expect(seen).toEqual([expected]);
  });

  test("a link socket's turn observer paces its reads", () => {
    const s = harness().open();
    expect(s.ws!.data.linkTurnObserver?.(1).pacedReads).toBe(true);
  });
});
