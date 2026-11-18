import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { OcxConfig } from "../../src/types";
import { createLinkWebsocketGate } from "../../src/server/index/link-websocket";
import { LINK_WS_LIMITS, setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import { requestPolicyView } from "../../src/server/auth-cors";
import { CodexWebSocketActivity, resultKeysOf } from "../../src/codex/websocket-activity";
import { createActivityHolds } from "../../src/link/ws-activity-holds";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore, type LinkStore } from "../../src/link/store";
import { pendingLinkTurnTokens, registerLinkTurnToken, releaseLinkTurnToken, type LinkTurnObserver } from "../../src/server/link-turn";
import type { WsData } from "../../src/server/ws-bridge";
import { relayHarness } from "../helpers/link-relay-harness";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { LinkWireClient, frameType } from "../helpers/link-ws-client";

// Lane T5d2: fingerprints of a running link turn's cut request and the rules that release them
// (design T4 section 5, rules (a)-(d)).

const KEY = { id: "fp-key", key: "fp-secret-0123456789", linkId: "lnk_ffffffffffffffff" };
let dir = "";
beforeEach(() => { setLinkWebsocketTransportReadyForTests(true); dir = mkdtempSync(join(tmpdir(), "ocx-link-fp-")); });
afterEach(() => { setLinkWebsocketTransportReadyForTests(false); if (dir) removeTreeWithRetry(dir); dir = ""; });

/**
 * Waits for a state of the files in one directory, never for a single file event: every wait checks its
 * condition when it starts and again on each event, so a write that landed before the wait began is still
 * seen. The watcher is armed once, before the Home starts, so it is armed long before the first write it
 * has to see (on macOS a watcher is armed asynchronously, and one armed just before the write could miss it).
 */
function watchState(directory: string): { until(condition: () => boolean): Promise<void>; close(): void } {
  const waiters = new Set<() => void>();
  const watcher: FSWatcher = watch(directory, () => { for (const check of [...waiters]) check(); });
  return {
    until(condition) {
      return new Promise<void>((resolve, reject) => {
        const check = () => {
          let met: boolean;
          try { met = condition(); } catch (error) { waiters.delete(check); reject(error); return; }
          if (met) { waiters.delete(check); resolve(); }
        };
        waiters.add(check);
        check();
      });
    },
    close() { waiters.clear(); watcher.close(); },
  };
}

function policy() {
  const config = { port: 0, apiKeys: [{ id: KEY.id, name: KEY.id, key: KEY.key, createdAt: "2026-11-12T00:00:00.000Z" }] } as OcxConfig;
  return requestPolicyView(config, "opencodex-link.invalid", { allowedKeyIds: new Set([KEY.id]) });
}

interface Turn { finish: () => void; observer: LinkTurnObserver | undefined; turnId: number; input: unknown }

/** Stands in for the shared handler: a create begins a turn and enters the pipeline with an observer. */
function pipelineHandler() {
  const turns: Turn[] = [];
  let nextId = 0;
  const handler: WebSocketHandler<WsData> = {
    open(ws) { ws.data.admissionLease?.bind(ws); },
    message(ws, raw) {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      if (frame.type !== "response.create") return;
      const turnId = ++nextId;
      const finishActivity = ws.data.responsesActivity!.beginTurn(frame.input);
      // The shared handler's turn cleanup: activity first, then the link turn's own end.
      const finish = () => { finishActivity(); ws.data.linkTurnEnded?.(turnId); };
      turns.push({ finish, observer: ws.data.linkTurnObserver?.(turnId), turnId, input: frame.input });
    },
    close(ws) { ws.data.admissionLease?.release(); },
  };
  return { handler, turns };
}

function harness() {
  const holds = createActivityHolds({ dir, linkIds: () => [KEY.linkId], limits: LINK_WS_LIMITS });
  holds.start();
  const gate = createLinkWebsocketGate({
    enabled: () => true, policy, authorized: () => true, draining: () => false, holds,
    timers: { setInterval: () => 0, clearInterval() {} },
    reserveSocket: () => ({ bind(ws: ServerWebSocket<WsData>) { ws.data.responsesActivity = new CodexWebSocketActivity(); }, release() {} }),
  });
  const pipeline = pipelineHandler();
  const handler = gate.handler(pipeline.handler);
  const open = (thread = "thread-a") => {
    let data: WsData | undefined;
    gate.upgrade(new Request("http://127.0.0.1/v1/responses", { headers: {
      upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      authorization: "Bearer " + KEY.key, "thread-id": thread,
    } }), { upgrade: (_r: Request, o: { data: WsData }) => { data = o.data; return true; } } as unknown as Server<unknown>,
    { keyId: KEY.id, linkId: KEY.linkId, fingerprint: serviceApiTokenFingerprint(KEY.key), release() {} });
    const ws = { data, readyState: 1, getBufferedAmount: () => 0, close() {} } as unknown as ServerWebSocket<WsData>;
    handler.open?.(ws);
    return {
      ws,
      create: (body: Record<string, unknown>) => { handler.message?.(ws, JSON.stringify({ type: "response.create", ...body })); return pipeline.turns.at(-1)!; },
      close: () => handler.close?.(ws, 1006, ""),
    };
  };
  return { holds, open, marks: () => holds.markCounts(KEY.linkId), count: () => holds.count(KEY.linkId) };
}

const ITEMS = [{ type: "message", role: "user", content: [{ type: "input_text", text: "build it" }] }];
const body = (turnId: string | null, items: unknown[] = ITEMS, extra: Record<string, unknown> = {}) => ({
  model: "m", input: items, ...(turnId ? { client_metadata: { turn_id: turnId } } : {}), ...extra,
});

/** A socket of thread-a whose turn u-1 was fingerprinted and then cut. */
function cut(h: ReturnType<typeof harness>) {
  const s = h.open();
  const turn = s.create(body("u-1"));
  turn.observer!.expanded(body("u-1"));
  s.close();
  expect(h.marks()).toEqual({ fingerprinted: 1, unknown: 0 });
  return h;
}

describe("capture (design 5, 11.1-8)", () => {
  test("the first hold on a link carries the fingerprint captured at expansion", () => {
    cut(harness());
  });

  test.each([
    ["closed before the turn entered the pipeline", "none"],
    ["closed during expansion", "pending"],
    ["expansion failed (continuation miss)", "failed"],
    ["canonicalization failed", "bad-items"],
    ["the cut request had no turn id", "no-turn"],
  ] as const)("%s: an unknown, operator-only mark", (_label, how) => {
    const h = harness();
    const s = h.open();
    if (how === "none") {
      s.ws.data.responsesActivity!.beginTurn("raw");
    } else {
      const turn = s.create(body("u-1"));
      if (how === "failed") turn.observer!.expansionFailed();
      if (how === "bad-items") turn.observer!.expanded(body("u-1", [{ type: "message", size: 10n }]));
      if (how === "no-turn") turn.observer!.expanded(body(null));
    }
    s.close();
    expect(h.marks()).toEqual({ fingerprinted: 0, unknown: 1 });
  });

  test("a superseded turn settling late never overwrites or clears the newer turn's capture", () => {
    const h = harness();
    const s = h.open();
    const a = s.create(body("u-a"));
    const b = s.create(body("u-b"));
    b.observer!.expanded(body("u-b"));
    a.observer!.expanded(body("u-a", [...ITEMS, { type: "message", role: "user", content: [] }]));
    a.observer!.terminal(undefined, undefined);
    a.finish();
    s.close();
    expect(h.marks()).toEqual({ fingerprinted: 1, unknown: 0 });
    // B's mark is released only by B's own request: A's turn id releases nothing.
    const later = h.open().create(body("u-a"));
    later.observer!.expanded(body("u-a"));
    later.observer!.terminal("completed", "upstream");
    expect(h.marks().fingerprinted).toBe(1);
    const own = h.open().create(body("u-b"));
    own.observer!.expanded(body("u-b"));
    own.observer!.terminal("completed", "upstream");
    expect(h.marks().fingerprinted).toBe(0);
  });

  test("a close while two busy references exist yields one mark per entry, unknown for the uncaptured one", () => {
    const h = harness();
    const s = h.open();
    s.create(body("u-a"));
    const b = s.create(body("u-b"));
    b.observer!.expanded(body("u-b"));
    s.close();
    expect(h.marks()).toEqual({ fingerprinted: 1, unknown: 1 });
  });

  test("a turn that ended without a terminal leaves no entry behind for a later close", () => {
    const h = harness();
    const s = h.open();
    // Refused inside the pipeline before expansion: no capture, no final log, but its cleanup ran.
    s.create(body("u-a")).finish();
    const b = s.create(body("u-b"));
    b.observer!.expanded(body("u-b"));
    s.close();
    expect(h.marks()).toEqual({ fingerprinted: 1, unknown: 0 });
  });

  test("a turn past its own terminal whose cleanup has not run yet is not cut work", () => {
    const h = harness();
    const s = h.open();
    const a = s.create(body("u-a"));
    a.observer!.expanded(body("u-a"));
    a.observer!.terminal("completed", "upstream");
    s.close();
    expect(h.marks()).toEqual({ fingerprinted: 0, unknown: 0 });
  });

  test("a late callback from a turn whose cleanup already ran never re-creates its entry", () => {
    const h = harness();
    const s = h.open();
    const a = s.create(body("u-a"));
    a.finish();
    const b = s.create(body("u-b"));
    b.observer!.expanded(body("u-b"));
    a.observer!.expanded(body("u-a"));
    a.observer!.expansionFailed();
    s.close();
    expect(h.marks()).toEqual({ fingerprinted: 1, unknown: 0 });
  });
});

describe("release rules (a)-(d)", () => {
  test.each([
    ["a full resend of the cut request", body("u-1"), "completed", "upstream", true],
    ["a later request of the same turn that extends it", body("u-1", [...ITEMS, { type: "function_call_output", call_id: "c", output: "x" }]), "completed", "upstream", true],
    ["the same items with keys in another order (WS delta expanded vs HTTP resend)", body("u-1", [{ content: [{ text: "build it", type: "input_text" }], role: "user", type: "message" }]), "completed", "upstream", true],
    ["another turn of the same thread", body("u-2"), "completed", "upstream", false],
    ["a second model request of the turn that does not extend the cut one", body("u-1", [{ type: "message", role: "user", content: [] }]), "completed", "upstream", false],
    ["a generate:false warmup", body("u-1", ITEMS, { generate: false }), "completed", "upstream", false],
    ["a failed retry", body("u-1"), "failed", "upstream", false],
    ["a completed terminal the proxy synthesized", body("u-1"), "completed", "synthetic", false],
    ["a completed terminal with no upstream provenance", body("u-1"), "completed", undefined, false],
    ["no turn id", body(null), "completed", "upstream", false],
  ] as const)("%s", (_label, retry, status, source, releases) => {
    const h = cut(harness());
    const turn = h.open().create(retry as Record<string, unknown>);
    turn.observer!.expanded(retry);
    turn.observer!.terminal(status, source);
    expect(h.marks().fingerprinted).toBe(releases ? 0 : 1);
  });

  test("another thread never releases it", () => {
    const h = cut(harness());
    const turn = h.open("thread-other").create(body("u-1"));
    turn.observer!.expanded(body("u-1"));
    turn.observer!.terminal("completed", "upstream");
    expect(h.marks().fingerprinted).toBe(1);
  });

  test("a resend releases only the marks it saw at expansion, never an identical mark cut after it", () => {
    const h = cut(harness());
    const resend = h.open().create(body("u-1"));
    resend.observer!.expanded(body("u-1"));
    // Another socket runs the same request of the same turn and is cut before the resend completes.
    const other = h.open();
    other.create(body("u-1")).observer!.expanded(body("u-1"));
    other.close();
    expect(h.marks().fingerprinted).toBe(2);
    resend.observer!.terminal("completed", "upstream");
    expect(h.marks().fingerprinted).toBe(1);
  });
});

describe("relayed HTTP: the turn token of an aborted request", () => {
  test("an abort while dispatch is still pending decides the observation and drops the unclaimed token", async () => {
    const decisions: boolean[] = [];
    const relay = relayHarness({ observeResponsesRequest: () => {
      const token = registerLinkTurnToken({ expanded() {}, expansionFailed() {}, terminal() {} });
      return accepted => { releaseLinkTurnToken(token); decisions.push(accepted); };
    } });
    const nonce = await relay.session("lnk_abababababababab");
    const before = pendingLinkTurnTokens();
    const abort = new AbortController();
    let reached!: () => void;
    const inside = new Promise<void>(resolve => { reached = resolve; });
    void relay.dispatch(relay.request("/v1/responses", { method: "POST", body: "{}", nonce, signal: abort.signal }), () => {
      reached();
      return new Promise<Response>(() => {}); // never settles
    }).catch(() => {});
    await inside;
    expect(pendingLinkTurnTokens()).toBe(before + 1);
    abort.abort();
    expect(decisions).toEqual([false]);
    expect(pendingLinkTurnTokens()).toBe(before);
  });
});

describe("through a real Home: a cut WebSocket turn and its HTTP resend", () => {
  const KEY_A_ID = "fp-home"; const KEY_A = "fp-home-secret-0123456789"; const LINK = "lnk_1212121212121212";
  const identity = { keyId: KEY_A_ID, linkId: LINK, fingerprint: serviceApiTokenFingerprint(KEY_A) };
  const previous = { home: process.env.OPENCODEX_HOME };
  let codexHome: IsolatedCodexHome | null = null;
  let server: { stop(force?: boolean): Promise<void> } | null = null;
  let upstream: ReturnType<typeof Bun.serve> | null = null;
  let holdsState: ReturnType<typeof watchState> | null = null;
  const clients: LinkWireClient[] = [];
  afterEach(async () => {
    // Before the directory goes: no late event may read a removed file.
    holdsState?.close(); holdsState = null;
    for (const c of clients.splice(0)) c.destroy();
    if (server) await server.stop(true);
    server = null;
    if (upstream) await upstream.stop(true);
    upstream = null;
    codexHome?.restore(); codexHome = null;
    if (previous.home === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous.home;
  });

  test.each([[200, 0], [400, 1]] as const)("an HTTP resend answered %i leaves %i fingerprinted marks", async (resendStatus, left) => {
    process.env.OPENCODEX_HOME = dir;
    codexHome = installIsolatedCodexHome("ocx-link-fp-codex-");
    writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture/fixture" }] }));
    let requests = 0;
    const turnHeaders: Array<string | null> = [];
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      await req.text();
      requests += 1;
      turnHeaders.push(req.headers.get("x-opencodex-link-turn"));
      if (requests === 1) {
        // The cut turn: it starts and never ends.
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress","output":[]}}\n\n'));
        } }), { headers: { "content-type": "text/event-stream" } });
      }
      if (resendStatus !== 200) return Response.json({ error: { type: "invalid_request_error", message: "fixture refusal" } }, { status: resendStatus });
      return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r2","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n', { headers: { "content-type": "text/event-stream" } });
    } });
    writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links: [{ id: LINK, alias: "fp", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY_A_ID, createdAt: "2026-11-12T00:00:00.000Z" }] as LinkStore["links"] });
    // links.json made the link directory; the holds file is written there.
    const holds = holdsState = watchState(join(dir, "link"));
    const { saveConfig } = await import("../../src/config");
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", websockets: true, linkResponsesWebsocket: true, codexAutoStart: false, clientIntegrations: { codex: false },
      providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:" + upstream.port + "/v1", authMode: "key", apiKey: "fixture-upstream-key", allowPrivateNetwork: true, models: ["fixture"] } },
      apiKeys: [{ id: KEY_A_ID, name: KEY_A_ID, key: KEY_A, createdAt: "2026-11-12T00:00:00.000Z" }] } as OcxConfig);
    const { startServer } = await import("../../src/server");
    server = startServer(0);
    const port = JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort as number;
    const holdsPath = join(dir, "link", "activity-holds.json");
    const marks = () => ((JSON.parse(readFileSync(holdsPath, "utf8")) as { links: Record<string, { holds: Array<{ marks?: unknown[] }> }> }).links[LINK]?.holds ?? []).reduce((sum, hold) => sum + (hold.marks?.length ?? 0), 0);
    // Each wait is for a change of state and the exact count is asserted after it: a holds file first written
    // with a wrong count, or a 200 resend that moves the count to anything but 0, fails as a mismatch; a holds
    // file never written, or a count that stays 1 after the resend, still fails at the runner's timeout. The Home
    // writes the holds file with an atomic rename.
    const holdsWritten = () => {
      try { readFileSync(holdsPath); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    };
    const request = { model: "fixture/fixture", input: ITEMS, client_metadata: { turn_id: "turn-cut" }, stream: true };

    const ws = await LinkWireClient.open(port);
    clients.push(ws);
    const session = await ws.challenge(identity);
    expect((await ws.upgrade({ nonce: session.nonce, bearer: KEY_A, headers: { "thread-id": "thread-cut" } })).status).toBe(101);
    ws.sendJson({ type: "response.create", ...request });
    expect(frameType(await ws.nextMessage())).toBe("response.created");
    ws.destroy();
    await holds.until(holdsWritten);
    expect(marks()).toBe(1);

    const http = await LinkWireClient.open(port);
    clients.push(http);
    const next = await http.challenge(identity);
    // A peer cannot supply the internal turn header: the relay removes it before setting its own.
    http.sendRequest("POST /v1/responses HTTP/1.1", { host: "127.0.0.1", "content-type": "application/json", authorization: "Bearer " + KEY_A, "x-opencodex-link-session": next.nonce, "thread-id": "thread-cut", "x-opencodex-link-turn": "peer-chosen" }, JSON.stringify(request));
    const head = await http.readHead();
    expect(head.status).toBe(resendStatus);
    // A resend answered 200 releases the fingerprinted mark; one refused leaves it, with nothing to wait for.
    if (resendStatus === 200) await holds.until(() => marks() !== 1);
    expect(marks()).toBe(left);
    // The token header never reaches the upstream, on either transport.
    expect(turnHeaders).toEqual([null, null]);
  });
});
describe("T5g: a socket's accepted turn settles only holds older than the turn (final review area b, finding 1)", () => {
  test("a hold created by another socket while this turn runs keeps its reused key", () => {
    const h = harness();
    const s = h.open();
    const input = [{ type: "function_call_output", call_id: "call-reused", output: "done" }];
    const turn = s.create({ model: "m", input });
    // While the turn runs, another socket of the same thread closes waiting for a new call with the same id.
    h.holds.add(KEY.linkId, { threadHash: h.holds.threadHash("thread-a"), pendingKeys: resultKeysOf(input), runningMarks: 0, untracked: false });
    s.ws.data.responsesActivity!.notifyAccepted(turn.input);
    expect(h.count()).toBe(1);
  });
});
describe("T5g: an unexpanded continuation is a delta, never a fingerprint (final review area b, finding 2)", () => {
  test("a turn cut on an unexpanded continuation leaves an unknown mark", () => {
    const h = harness();
    const s = h.open();
    const turn = s.create(body("u-1"));
    turn.observer!.expanded(body("u-1"), "unexpanded");
    s.close();
    expect(h.marks()).toEqual({ fingerprinted: 0, unknown: 1 });
  });

  test("an unexpanded request with the same delta never releases a fingerprinted mark", () => {
    const h = cut(harness());
    const retry = h.open().create(body("u-1"));
    retry.observer!.expanded(body("u-1"), "unexpanded");
    retry.observer!.terminal("completed", "upstream");
    expect(h.marks().fingerprinted).toBe(1);
  });
});
