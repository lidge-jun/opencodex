import { afterEach, describe, expect, test } from "bun:test";
import { relayLinkDataRequest, type LinkRelayClock, type LinkTunnelGate } from "../../src/client/link-relay";
import { linkChildRelayWaitObserver, setLinkChildRelayWaitObserverForTests } from "../../src/client/link-websocket-limits";

// The Child's HTTP relay tells a test when a relayed response waits for its reader after handing it a chunk,
// and when it stops waiting: the counterpart of the Home's setLinkRelayWaitObserverForTests, for the Child's
// memory acceptance (design 6.3), to see the relay hold a stalled reader.

const target = { tunnelPort: 12000, admissionKey: "ocx_data_" + "w".repeat(40) };
const tunnel: LinkTunnelGate = { connected: () => ({ kind: "match" }), pending: () => false, waitForConnected: async () => true };

afterEach(() => setLinkChildRelayWaitObserverForTests(null));

function upstream(chunks: string[], contentType: string): typeof fetch {
  return (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": contentType } })) as unknown as typeof fetch;
}

async function relayed(chunks: string[], contentType: string): Promise<Response> {
  return await relayLinkDataRequest(new Request("http://127.0.0.1:10100/v1/responses", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
    target, { tunnel, fetchImpl: upstream(chunks, contentType) });
}

/** A Home that sends one chunk and then nothing, until the relay cancels it. */
function stalledUpstream(contentType: string): typeof fetch {
  return (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("one")); },
  }), { headers: { "content-type": contentType } })) as unknown as typeof fetch;
}

/** Timers the test fires by hand: the relay's SSE idle limit runs only when the test says so. */
function manualClock() {
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const clock: LinkRelayClock = {
    setTimeout: ((callback: () => void, ms: number) => { timers.set(next, { callback, ms }); return next++; }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout,
  };
  const fire = (ms: number): void => {
    const armed = [...timers.entries()].filter(([, timer]) => timer.ms === ms);
    expect(armed).toHaveLength(1);
    timers.delete(armed[0]![0]);
    armed[0]![1].callback();
  };
  return { clock, fire };
}

/** Records every event; `nextFalse()` settles on the first false after it is called, the milestone each case waits for. */
function recordWaits() {
  const events: boolean[] = [];
  let waiters: Array<() => void> = [];
  setLinkChildRelayWaitObserverForTests(waiting => {
    events.push(waiting);
    if (!waiting) { const settled = waiters; waiters = []; for (const settle of settled) settle(); }
  });
  const nextFalse = (): Promise<void> => new Promise(resolve => { waiters.push(resolve); });
  return { events, nextFalse };
}

describe("the Child relay's test-only wait observer", () => {
  test("no observer is set by default", () => {
    expect(linkChildRelayWaitObserver()).toBeNull();
  });

  for (const contentType of ["application/json", "text/event-stream"]) {
    test("a " + contentType + " response waits from each chunk handed over until its reader asks again or the relay ends", async () => {
      const { events, nextFalse } = recordWaits();
      // The test sends each chunk and the end itself, so every event follows from one step it took.
      let home!: ReadableStreamDefaultController<Uint8Array>;
      const upstreamBody = new ReadableStream<Uint8Array>({ start(controller) { home = controller; } });
      const response = await relayLinkDataRequest(new Request("http://127.0.0.1:10100/v1/responses",
        { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
      target, { tunnel, fetchImpl: (async () => new Response(upstreamBody, { headers: { "content-type": contentType } })) as unknown as typeof fetch });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const first = reader.read();
      home.enqueue(new TextEncoder().encode("one"));
      expect(decoder.decode((await first).value)).toBe("one");
      // The reader holds the first chunk and has not asked again: the relay waits for it.
      expect(events).toEqual([true]);
      const second = reader.read();
      home.enqueue(new TextEncoder().encode("two"));
      expect(decoder.decode((await second).value)).toBe("two");
      expect(events).toEqual([true, false, true]);
      // The Home's body ends while the reader holds the last chunk: the relay has finished and holds nothing.
      const relayEnded = nextFalse();
      home.close();
      await relayEnded;
      expect(events).toEqual([true, false, true, false]);
      expect((await reader.read()).done).toBe(true);
      expect(events).toEqual([true, false, true, false]);
    });
  }

  test("a reader that cancels while the relay waits ends the wait", async () => {
    const events: boolean[] = [];
    setLinkChildRelayWaitObserverForTests(waiting => events.push(waiting));
    const response = await relayed(["one", "two"], "application/json");
    const reader = response.body!.getReader();
    await reader.read();
    expect(events).toEqual([true]);
    await reader.cancel();
    expect(events).toEqual([true, false]);
  });

  // The relay can end underneath a reader that holds a chunk and never asks again: a dead relay is not a waiting one.
  for (const contentType of ["application/json", "text/event-stream"]) {
    test("a caller abort while the reader holds a " + contentType + " chunk ends the wait", async () => {
      const { events, nextFalse } = recordWaits();
      const caller = new AbortController();
      const response = await relayLinkDataRequest(new Request("http://127.0.0.1:10100/v1/responses",
        { method: "POST", body: "{}", headers: { "content-type": "application/json" }, signal: caller.signal }),
      target, { tunnel, fetchImpl: stalledUpstream(contentType) });
      const reader = response.body!.getReader();
      await reader.read();
      expect(events).toEqual([true]);
      const relayEnded = nextFalse();
      caller.abort();
      await relayEnded;
      expect(events).toEqual([true, false]);
      // Nothing the reader does afterwards reports the ended relay as waiting again.
      await reader.read().catch(() => undefined);
      expect(events).toEqual([true, false]);
    });
  }

  test("the SSE idle limit firing while the reader holds a chunk ends the wait", async () => {
    const { events, nextFalse } = recordWaits();
    const { clock, fire } = manualClock();
    const response = await relayLinkDataRequest(new Request("http://127.0.0.1:10100/v1/responses",
      { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
    target, { tunnel, fetchImpl: stalledUpstream("text/event-stream"), clock, sseIdleTimeoutMs: 777 });
    const reader = response.body!.getReader();
    await reader.read();
    expect(events).toEqual([true]);
    const relayEnded = nextFalse();
    fire(777);
    await relayEnded;
    expect(events).toEqual([true, false]);
    await reader.read().catch(() => undefined);
    expect(events).toEqual([true, false]);
  });

  test("an observer that throws never breaks the relay", async () => {
    setLinkChildRelayWaitObserverForTests(() => { throw new Error("observer failed"); });
    const response = await relayed(["one", "two"], "text/event-stream");
    expect(await response.text()).toBe("onetwo");
  });
});
