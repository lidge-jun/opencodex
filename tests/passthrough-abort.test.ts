import { describe, expect, test } from "bun:test";
import { linkAbortSignal, relaySseWithHeartbeat, relayWithAbort } from "../src/server";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

describe("passthrough relayWithAbort (RC2, passthrough path)", () => {
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
