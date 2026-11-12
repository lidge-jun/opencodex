import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { pumpResponsesSseToWebSocket, type WsData } from "../../src/server/ws-bridge";
import { BoundedSseFrameBuffer } from "../../src/server/sse-frame-buffer";
import { LINK_WS_LIMITS, setLinkPumpTimerForTests } from "../../src/server/index/link-websocket-limits";
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
