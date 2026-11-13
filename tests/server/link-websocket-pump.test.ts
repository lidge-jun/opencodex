import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { pumpResponsesSseToWebSocket, sendResponseToWebSocket, type WsData } from "../../src/server/ws-bridge";
import { BoundedSseFrameBuffer, MAX_CLIENT_SSE_FRAME_BYTES } from "../../src/server/sse-frame-buffer";
import { LINK_WS_LIMITS, setLinkPumpTimerForTests, setLinkRelayWaitObserverForTests } from "../../src/server/index/link-websocket-limits";
import { chunkedResponse, relayHarness } from "../helpers/link-relay-harness";
import { createLinkWebsocketGate } from "../../src/server/index/link-websocket";

// Lane T5c: the link-only bounded pump of design 6.2. A link socket waits for Bun's drain after any
// send that leaves more than the send threshold buffered, before the next event of the same chunk,
// and feeds the SSE framer at most one slice of an upstream chunk at a time. Local sockets keep the
// existing behaviour. The socket is a fake whose buffer only empties when the test says so.

const MiB = 1024 * 1024;
const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

function event(index: number, bytes: number): string {
  const filler = "x".repeat(bytes);
  return "event: response.output_text.delta\ndata: " + JSON.stringify({ type: "response.output_text.delta", index, delta: filler }) + "\n\n";
}

const COMPLETED = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n';

function oneChunk(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) { controller.close(); return; }
      sent = true;
      controller.enqueue(bytes);
    },
  }, { highWaterMark: 0 });
}

/** A socket that never drains on its own: buffered bytes only go down when the test drains it. */
function stalledSocket(link: boolean) {
  let buffered = 0;
  let peak = 0;
  const sent: string[] = [];
  let onSend: (() => void) | undefined;
  const data: WsData = link
    ? { link: { linkId: "lnk_cccccccccccccccc", keyId: "k", fingerprint: "", fenced: false, leases: { closed() {} } } }
    : {};
  const ws = {
    data,
    readyState: 1,
    send(payload: string) {
      buffered += Buffer.byteLength(payload);
      peak = Math.max(peak, buffered);
      sent.push(payload);
      onSend?.();
      return buffered > 0 ? -1 : 1;
    },
    getBufferedAmount: () => buffered,
    close() {},
  } as unknown as ServerWebSocket<WsData>;
  return {
    ws, sent,
    peak: () => peak,
    buffered: () => buffered,
    nextSend: () => new Promise<void>(resolve => { onSend = resolve; }),
    drain() { buffered = 0; data.link?.drained?.(); },
    setBuffered(bytes: number) { buffered = bytes; },
  };
}

describe("link-only bounded pump (design 6.2, 11.1-9)", () => {
  test("a coalesced chunk of near-4 MiB events to a stalled link reader keeps the buffer at or below 5 MiB and drops nothing", async () => {
    const count = 6;
    const size = Math.floor(3.5 * MiB);
    const text = Array.from({ length: count }, (_, index) => event(index, size)).join("") + COMPLETED;
    const socket = stalledSocket(true);
    const pump = pumpResponsesSseToWebSocket(socket.ws, oneChunk(text));
    for (let index = 0; index < count; index += 1) {
      if (socket.sent.length <= index) await socket.nextSend();
      expect(socket.sent).toHaveLength(index + 1);
      expect(socket.buffered()).toBeLessThanOrEqual(LINK_WS_LIMITS.sendThresholdBytes + 4 * MiB);
      socket.drain();
    }
    await pump;
    expect(socket.sent).toHaveLength(count + 1);
    expect(socket.peak()).toBeLessThanOrEqual(5 * MiB);
    expect(socket.sent.slice(0, count).map(payload => (JSON.parse(payload) as { index: number }).index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("a link socket feeds the framer at most one 256 KiB slice of a chunk at a time; a local socket feeds the whole chunk (characterization)", async () => {
    const feeds: number[] = [];
    const original = BoundedSseFrameBuffer.prototype.feed;
    const spy = spyOn(BoundedSseFrameBuffer.prototype, "feed").mockImplementation(function (this: BoundedSseFrameBuffer, chunk: Uint8Array) {
      feeds.push(chunk.byteLength);
      return original.call(this, chunk);
    });
    restores.push(() => spy.mockRestore());
    const text = Array.from({ length: 8 }, (_, index) => event(index, 100 * 1024)).join("") + COMPLETED;
    const total = Buffer.byteLength(text);
    expect(total).toBeGreaterThan(LINK_WS_LIMITS.framerSliceBytes * 2);

    const link = stalledSocket(true);
    const linkPump = pumpResponsesSseToWebSocket(link.ws, oneChunk(text));
    while (true) {
      const settled = await Promise.race([linkPump.then(() => true), link.nextSend().then(() => false)]);
      link.drain();
      if (settled) break;
    }
    expect(Math.max(...feeds)).toBeLessThanOrEqual(LINK_WS_LIMITS.framerSliceBytes);
    expect(feeds.reduce((sum, size) => sum + size, 0)).toBe(total);
    expect(link.sent).toHaveLength(9);

    feeds.length = 0;
    const local = stalledSocket(false);
    await pumpResponsesSseToWebSocket(local.ws, oneChunk(text));
    expect(feeds).toEqual([total]);
    expect(local.sent).toHaveLength(9);
  });

  test("a closed or cancelled link socket stops waiting for a drain", async () => {
    const text = Array.from({ length: 3 }, (_, index) => event(index, 2 * MiB)).join("") + COMPLETED;
    const socket = stalledSocket(true);
    const pump = pumpResponsesSseToWebSocket(socket.ws, oneChunk(text));
    await socket.nextSend();
    socket.ws.data.cancel?.();
    await pump;
    expect(socket.sent.map(payload => (JSON.parse(payload) as { type: string }).type)).toEqual(["response.output_text.delta"]);
  });
});


describe("link handler wiring of the drain signal", () => {
  test("Bun's drain and close callbacks wake a waiting link pump", () => {
    const gate = createLinkWebsocketGate({ enabled: () => true, policy: () => ({}) as never, authorized: () => true, timers: { setInterval: () => 0, clearInterval() {} } });
    const handler = gate.handler({ open() {}, message() {}, close() {} });
    let wakes = 0;
    const data: WsData = { link: { linkId: "lnk_cccccccccccccccc", keyId: "k", fingerprint: "", fenced: false, leases: { closed() {} }, drained: () => { wakes += 1; } } };
    const ws = { data, readyState: 1, close() {} } as unknown as ServerWebSocket<WsData>;
    handler.drain?.(ws);
    expect(wakes).toBe(1);
    handler.close?.(ws, 1006, "");
    expect(wakes).toBe(2);
  });
});

describe("link pump stall bound", () => {
  test("a link socket that never drains is closed with 1011 after sendStallMs and the pump stops", async () => {
    const fired: Array<{ callback: () => void; ms: number }> = [];
    setLinkPumpTimerForTests({ start(callback, ms) { const entry = { callback, ms }; fired.push(entry); return entry; }, stop() {} });
    restores.push(() => setLinkPumpTimerForTests(null));
    const text = Array.from({ length: 3 }, (_, index) => event(index, 2 * MiB)).join("") + COMPLETED;
    const socket = stalledSocket(true);
    const closes: number[] = [];
    (socket.ws as unknown as { close: (code: number) => void }).close = code => { closes.push(code); };
    const pump = pumpResponsesSseToWebSocket(socket.ws, oneChunk(text));
    await socket.nextSend();
    await Promise.resolve();
    expect(fired.map(entry => entry.ms)).toEqual([LINK_WS_LIMITS.sendStallMs]);
    fired[0]!.callback();
    await expect(pump).rejects.toThrow();
    expect(closes).toEqual([1011]);
    expect(socket.sent).toHaveLength(1);
  });
});

describe("drain callbacks above the threshold (T5c-R1-01)", () => {
  test("a drain that leaves more than the threshold buffered does not release the next event", async () => {
    const text = Array.from({ length: 2 }, (_, index) => event(index, Math.floor(3.5 * MiB))).join("") + COMPLETED;
    const socket = stalledSocket(true);
    const pump = pumpResponsesSseToWebSocket(socket.ws, oneChunk(text));
    await socket.nextSend();
    expect(socket.sent).toHaveLength(1);
    // Bun says "ready for more" while 2 MiB is still queued: the pump must keep waiting.
    socket.setBuffered(2 * MiB);
    socket.ws.data.link!.drained!();
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.sent).toHaveLength(1);
    expect(socket.ws.data.link!.drained).toBeDefined();
    const next = socket.nextSend();
    socket.drain();
    await next;
    expect(socket.sent).toHaveLength(2);
    socket.drain();
    await pump;
    expect(socket.peak()).toBeLessThanOrEqual(5 * MiB);
  });
});
describe("T5g: synthesized JSON events are paced like SSE events on a link socket (final review area b, finding 4)", () => {
  test("a bounded JSON response to a stalled link reader keeps the buffer bounded and delivers every frame and the terminal", async () => {
    const socket = stalledSocket(true);
    const item = (index: number) => ({ type: "message", id: "m" + index, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "x".repeat(1.2 * MiB), annotations: [] }] });
    const response = Response.json({ id: "r", status: "completed", output: [item(0), item(1), item(2)] });
    let terminal: string | undefined;
    const pump = sendResponseToWebSocket(socket.ws, response, () => true, { onTerminal: status => { terminal = status; } });
    let finished = false;
    void pump.then(() => { finished = true; });
    while (!finished) {
      await Promise.race([socket.nextSend(), pump]);
      socket.drain();
    }
    await pump;
    // The terminal repeats the output (about 3.6 MiB); nothing else may sit beside it in the buffer.
    expect(socket.peak()).toBeLessThanOrEqual(LINK_WS_LIMITS.sendThresholdBytes + 5 * MiB);
    expect(JSON.parse(socket.sent.at(-1)!).type).toBe("response.completed");
    expect(terminal).toBe("completed");
  });

  test("a local socket keeps the synchronous JSON delivery (unchanged)", async () => {
    const socket = stalledSocket(false);
    await sendResponseToWebSocket(socket.ws, Response.json({ id: "r", status: "completed", output: [] }), () => true, {});
    expect(socket.sent.length).toBeGreaterThan(0);
    expect(JSON.parse(socket.sent.at(-1)!).type).toBe("response.completed");
  });
});
describe("T5g: a stalled link reader of a JSON response closes 1011 like the SSE pump", () => {
  test("the stall deadline closes the socket and stops delivery", async () => {
    const fired: Array<{ callback: () => void; ms: number }> = [];
    setLinkPumpTimerForTests({ start(callback, ms) { const entry = { callback, ms }; fired.push(entry); return entry; }, stop() {} });
    restores.push(() => setLinkPumpTimerForTests(null));
    const socket = stalledSocket(true);
    const closes: number[] = [];
    (socket.ws as unknown as { close: (code: number) => void }).close = code => { closes.push(code); };
    const item = (index: number) => ({ type: "message", id: "m" + index, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "x".repeat(2 * MiB), annotations: [] }] });
    let terminal: string | undefined;
    const pump = sendResponseToWebSocket(socket.ws, Response.json({ id: "r", status: "completed", output: [item(0), item(1)] }), () => true,
      { onTerminal: status => { terminal = status; } });
    while (fired.length === 0) await socket.nextSend();
    expect(fired.map(entry => entry.ms)).toEqual([LINK_WS_LIMITS.sendStallMs]);
    const sentBefore = socket.sent.length;
    fired[0]!.callback();
    await expect(pump).rejects.toThrow();
    expect(closes).toEqual([1011]);
    expect(socket.sent).toHaveLength(sentBefore);
    expect(terminal).toBeUndefined();
  });
});

describe("T5g-R1: a synthesized JSON response on a link socket ends with its turn and stays within the client frame limit", () => {
  const item = (index: number, bytes: number) => ({ type: "message", id: "m" + index, role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "x".repeat(bytes), annotations: [] }] });
  const macrotask = () => new Promise<void>(resolve => setImmediate(resolve));

  test("a superseded turn's drain wait ends at once and its stall deadline never closes the socket", async () => {
    const fired: Array<{ callback: () => void; ms: number }> = [];
    const stopped: unknown[] = [];
    setLinkPumpTimerForTests({ start(callback, ms) { const entry = { callback, ms }; fired.push(entry); return entry; }, stop(entry) { stopped.push(entry); } });
    restores.push(() => setLinkPumpTimerForTests(null));
    const socket = stalledSocket(true);
    const closes: number[] = [];
    (socket.ws as unknown as { close: (code: number) => void }).close = code => { closes.push(code); };
    let current = true;
    let terminal: string | undefined;
    const pump = sendResponseToWebSocket(socket.ws, Response.json({ id: "r", status: "completed", output: [item(0, 2 * MiB), item(1, 2 * MiB)] }),
      () => current, { onTerminal: status => { terminal = status; } });
    while (fired.length === 0) await socket.nextSend();
    const sentBefore = socket.sent.length;
    // The shared handler supersedes turn A: it calls the socket's cancel and starts turn B.
    current = false;
    expect(socket.ws.data.cancel).toBeDefined();
    socket.ws.data.cancel?.();
    await macrotask();
    let settled = false;
    void pump.then(() => { settled = true; }, () => { settled = true; });
    await macrotask();
    expect(settled).toBe(true);
    expect(stopped).toContain(fired[0]);
    // Even a deadline that fires late (a timer the platform could not stop) leaves turn B's socket open.
    fired[0]!.callback();
    await pump;
    expect(closes).toEqual([]);
    expect(socket.sent).toHaveLength(sentBefore);
    expect(terminal).toBeUndefined();
  });

  test("an individual event over the client frame limit is never sent: the turn ends incomplete with a 502 error frame", async () => {
    const socket = stalledSocket(true);
    let terminal: string | undefined;
    const pump = sendResponseToWebSocket(socket.ws, Response.json({ id: "r", status: "completed", output: [item(0, 5 * MiB)] }), () => true,
      { onTerminal: status => { terminal = status; } });
    let finished = false;
    void pump.then(() => { finished = true; });
    while (!finished) { await Promise.race([socket.nextSend(), pump]); socket.drain(); }
    await pump;
    expect(socket.sent.every(payload => Buffer.byteLength(payload) <= MAX_CLIENT_SSE_FRAME_BYTES)).toBe(true);
    const last = JSON.parse(socket.sent.at(-1)!) as { type: string; status?: number };
    expect([last.type, last.status]).toEqual(["error", 502]);
    expect(socket.sent.some(payload => (JSON.parse(payload) as { type: string }).type === "response.completed")).toBe(false);
    expect(terminal).toBe("incomplete");
  });

  test("a terminal that repeats more output than the limit is never sent: the earlier items arrive, then the 502", async () => {
    const socket = stalledSocket(true);
    let terminal: string | undefined;
    const pump = sendResponseToWebSocket(socket.ws, Response.json({ id: "r", status: "completed", output: [item(0, 1.5 * MiB), item(1, 1.5 * MiB), item(2, 1.5 * MiB)] }),
      () => true, { onTerminal: status => { terminal = status; } });
    let finished = false;
    void pump.then(() => { finished = true; });
    while (!finished) { await Promise.race([socket.nextSend(), pump]); socket.drain(); }
    await pump;
    expect(socket.sent.every(payload => Buffer.byteLength(payload) <= MAX_CLIENT_SSE_FRAME_BYTES)).toBe(true);
    const types = socket.sent.map(payload => (JSON.parse(payload) as { type: string }).type);
    expect(types.filter(type => type === "response.output_item.done")).toHaveLength(3);
    expect(types.at(-1)).toBe("error");
    expect(types).not.toContain("response.completed");
    expect(terminal).toBe("incomplete");
  });
});


describe("the HTTP link relay reports when it waits for its reader (#8600)", () => {
  afterEach(() => setLinkRelayWaitObserverForTests(null));

  test("waiting from each chunk it hands over until its reader asks again, and never after the body ends", async () => {
    const events: boolean[] = [];
    setLinkRelayWaitObserverForTests(waiting => events.push(waiting));
    const h = relayHarness();
    const nonce = await h.session("lnk_aaaaaaaaaaaaaaaa");
    const response = await h.dispatch(h.request("/v1/responses", { method: "POST", nonce, body: "{}" }), async () => chunkedResponse(["a", "b"]));
    const reader = response.body!.getReader();
    expect(events).toEqual([]);
    expect((await reader.read()).done).toBe(false);
    expect(events).toEqual([true]);
    expect((await reader.read()).done).toBe(false);
    expect(events).toEqual([true, false, true]);
    expect((await reader.read()).done).toBe(true);
    expect(events).toEqual([true, false, true, false]);
  });

  test("a cancelled reader ends the wait", async () => {
    const events: boolean[] = [];
    setLinkRelayWaitObserverForTests(waiting => events.push(waiting));
    const h = relayHarness();
    const nonce = await h.session("lnk_aaaaaaaaaaaaaaaa");
    const response = await h.dispatch(h.request("/v1/responses", { method: "POST", nonce, body: "{}" }), async () => chunkedResponse(["a", "b"]));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(events).toEqual([true, false]);
  });

  test("without an observer the relay delivers its body as before", async () => {
    const h = relayHarness();
    const nonce = await h.session("lnk_aaaaaaaaaaaaaaaa");
    const response = await h.dispatch(h.request("/v1/responses", { method: "POST", nonce, body: "{}" }), async () => chunkedResponse(["a"]));
    expect(await response.text()).toBe("a");
  });
});

