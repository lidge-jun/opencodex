import { describe, expect, test } from "bun:test";
import { linkAbortSignal, relaySseWithHeartbeat, relayWithAbort } from "../src/server";

const root = new URL("../", import.meta.url);

async function readSource(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
}

describe("passthrough relayWithAbort (RC2, passthrough path)", () => {
  test("native passthrough SSE keeps win32 on the pure native relay (Bun#32111)", async () => {
    const source = await readSource("src/server/index.ts");
    const sseBranch = source.slice(
      source.indexOf("if (isEventStream && upstreamResponse.body)"),
      source.indexOf("const body = relayWithAbort(upstreamResponse.body, upstream);"),
    );
    const logWrapper = source.slice(
      source.indexOf("function responseWithDeferredRequestLog"),
      source.indexOf("export function relaySseWithHeartbeat"),
    );

    expect(sseBranch).toContain("upstreamResponse.body.tee()");
    // win32 must receive the tee'd body untouched — no JS pull wrapper (Bun#32111 segfault).
    expect(sseBranch).toContain('process.platform === "win32"');
    expect(sseBranch).toContain("? nativeBody");
    // Elsewhere the failed-tail relay converts mid-stream resets into a clean response.failed.
    expect(sseBranch).toContain("relaySseWithFailedTail(nativeBody, upstream)");
    expect(sseBranch).toContain("new Response(clientBody");
    expect(sseBranch).toContain("markNativePassthroughSseResponse");
    expect(sseBranch).not.toContain("relaySseWithHeartbeat(");
    expect(sseBranch).not.toContain("trackStreamLifetime(");
    expect(logWrapper.indexOf("isNativePassthroughSseResponse(response)")).toBeGreaterThanOrEqual(0);
    expect(logWrapper.indexOf("isNativePassthroughSseResponse(response)")).toBeLessThan(logWrapper.indexOf("trackSseForRequestLog("));
  });

  test("CASE B: relays body bytes verbatim and completes cleanly without aborting", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const relayed = relayWithAbort(streamFromChunks([enc.encode("event: a\n"), enc.encode("data: 1\n\n")]), ac)!;
    const reader = relayed.getReader();
    const dec = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    expect(text).toBe("event: a\ndata: 1\n\n");
    expect(ac.signal.aborted).toBe(false); // no spurious abort on normal completion
  });

  test("CASE A: client cancel aborts the upstream fetch", async () => {
    const ac = new AbortController();
    // An upstream that never produces — models a stalled connection the client gives up on.
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
    const relayed = relayWithAbort(body, ac)!;
    const reader = relayed.getReader();
    const pending = reader.read(); // stays pending (no data upstream)
    await reader.cancel();         // client disconnects
    expect(ac.signal.aborted).toBe(true);
    await pending.catch(() => {});
  });

  test("a null upstream body relays as null", () => {
    const ac = new AbortController();
    expect(relayWithAbort(null, ac)).toBeNull();
    expect(ac.signal.aborted).toBe(false);
  });

  test("SSE passthrough emits heartbeat comments while upstream is silent", async () => {
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
    const relayed = relaySseWithHeartbeat(body, ac, 5)!;
    const reader = relayed.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("heartbeat timeout")), 200)),
    ]);

    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe(": opencodex keepalive\n\n");

    await reader.cancel("client gone");
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBe("client gone");
  });

  test("SSE passthrough lifecycle callbacks run once on EOF and cancel", async () => {
    const enc = new TextEncoder();
    const lifecycle: string[] = [];
    const completed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n'),
    ]), new AbortController(), 15_000, undefined, {
      onStart: () => lifecycle.push("complete-start"),
      onDone: () => lifecycle.push("complete-done"),
    })!;

    await readAll(completed);
    expect(lifecycle).toEqual(["complete-start", "complete-done"]);

    const cancelAc = new AbortController();
    const cancelledLifecycle: string[] = [];
    const pendingBody = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
    const cancelled = relaySseWithHeartbeat(pendingBody, cancelAc, 15_000, undefined, {
      onStart: () => cancelledLifecycle.push("cancel-start"),
      onDone: () => cancelledLifecycle.push("cancel-done"),
    })!;
    const reader = cancelled.getReader();
    const pending = reader.read();
    await reader.cancel("client gone");

    expect(cancelAc.signal.aborted).toBe(true);
    expect(cancelledLifecycle).toEqual(["cancel-start", "cancel-done"]);
    await pending.catch(() => {});
  });

  test("SSE passthrough reports failed terminal payloads", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n'),
    ]), ac, 15_000, status => terminals.push(status))!;

    expect(await readAll(relayed)).toContain("response.failed");
    expect(terminals).toEqual(["failed"]);
  });

  test("SSE passthrough reports incomplete on EOF before a terminal payload", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode('event: response.created\ndata: {"type":"response.created"}\n\n'),
    ]), ac, 15_000, status => terminals.push(status))!;

    await readAll(relayed);
    expect(terminals).toEqual(["incomplete"]);
  });

  test("SSE passthrough does not report terminal status on client cancel", async () => {
    const ac = new AbortController();
    const terminals: string[] = [];
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
    const relayed = relaySseWithHeartbeat(body, ac, 15_000, status => terminals.push(status))!;
    const reader = relayed.getReader();
    const pending = reader.read();
    await reader.cancel("client gone");

    expect(ac.signal.aborted).toBe(true);
    expect(terminals).toEqual([]);
    await pending.catch(() => {});
  });

  test("SSE passthrough reports CRLF and multiline terminal payloads", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode('event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":{"id":"r1"}}\r\n\r\n'),
    ]), ac, 15_000, status => terminals.push(status))!;

    await readAll(relayed);
    expect(terminals).toEqual(["completed"]);
  });

  test("SSE passthrough reports split terminal frames", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode('event: response.completed\ndata: {"type":"response.'),
      enc.encode('completed","response":{"id":"r1"}}\n\n'),
    ]), ac, 15_000, status => terminals.push(status))!;

    await readAll(relayed);
    expect(terminals).toEqual(["completed"]);
  });

  test("SSE passthrough treats DONE without a terminal as incomplete", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode("data: [DONE]\n\n"),
    ]), ac, 15_000, status => terminals.push(status))!;

    await readAll(relayed);
    expect(terminals).toEqual(["incomplete"]);
  });

  test("SSE passthrough treats invalid JSON without a terminal as incomplete", async () => {
    const enc = new TextEncoder();
    const ac = new AbortController();
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(streamFromChunks([
      enc.encode("data: {not-json}\n\n"),
    ]), ac, 15_000, status => terminals.push(status))!;

    await readAll(relayed);
    expect(terminals).toEqual(["incomplete"]);
  });

  test("turn-level abort signal aborts the upstream fetch before headers arrive", () => {
    const upstream = new AbortController();
    const turn = new AbortController();
    linkAbortSignal(upstream, turn.signal);
    expect(upstream.signal.aborted).toBe(false);
    turn.abort("replacement turn");
    expect(upstream.signal.aborted).toBe(true);
    expect(upstream.signal.reason).toBe("replacement turn");
  });
});
