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

/**
 * A Home body the test drives: every read the relay makes of it is a pull the test can wait for, and the test answers
 * with a chunk or a failure. Records whether the relay cancelled it.
 */
function drivenHome(contentType: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let pulls = 0;
  let cancelled = false;
  let waiters: Array<{ count: number; resolve: () => void }> = [];
  const body = new ReadableStream<Uint8Array>({
    start(started) { controller = started; },
    pull() {
      pulls += 1;
      const due = waiters.filter(waiter => pulls >= waiter.count);
      waiters = waiters.filter(waiter => pulls < waiter.count);
      for (const waiter of due) waiter.resolve();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return {
    fetchImpl: (async () => new Response(body, { headers: { "content-type": contentType } })) as unknown as typeof fetch,
    send: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    fail: (error: Error) => controller.error(error),
    /** Settles once the relay has started its `count`th read of the Home body. */
    pulled: (count: number) => new Promise<void>(resolve => { if (pulls >= count) resolve(); else waiters.push({ count, resolve }); }),
    pulls: () => pulls,
    cancelled: () => cancelled,
  };
}

function relayedFrom(home: ReturnType<typeof drivenHome>, options: { signal?: AbortSignal; clock?: LinkRelayClock } = {}): Promise<Response> {
  return relayLinkDataRequest(new Request("http://127.0.0.1:10100/v1/responses",
    { method: "POST", body: "{}", headers: { "content-type": "application/json" }, ...(options.signal ? { signal: options.signal } : {}) }),
  target, { tunnel, fetchImpl: home.fetchImpl, ...(options.clock ? { clock: options.clock, sseIdleTimeoutMs: IDLE_MS } : {}) });
}

const IDLE_MS = 777;

/**
 * A clock that never fires, used to see the SSE relay queue a chunk: it re-arms its idle timer in the same synchronous
 * step in which it queues each chunk it read from the Home, so after its `n`th arm (one at start, one per chunk) that
 * chunk is in the relay's queue.
 */
function armingClock() {
  let arms = 0;
  let waiters: Array<{ count: number; resolve: () => void }> = [];
  const clock: LinkRelayClock = {
    setTimeout: ((_callback: () => void, ms: number) => {
      if (ms === IDLE_MS) {
        arms += 1;
        const due = waiters.filter(waiter => arms >= waiter.count);
        waiters = waiters.filter(waiter => arms < waiter.count);
        for (const waiter of due) waiter.resolve();
      }
      return arms;
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
  };
  const armed = (count: number) => new Promise<void>(resolve => { if (arms >= count) resolve(); else waiters.push({ count, resolve }); });
  return { clock, armed };
}

const text = (chunk: ReadableStreamReadResult<Uint8Array>): string => new TextDecoder().decode(chunk.value);

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

/**
 * Records every event. `nextFalse()` settles on the first false after it is called, and `reached(n)` once `n` events
 * have been recorded: the milestones each case waits for.
 */
function recordWaits() {
  const events: boolean[] = [];
  let waiters: Array<() => void> = [];
  let counted: Array<{ count: number; resolve: () => void }> = [];
  setLinkChildRelayWaitObserverForTests(waiting => {
    events.push(waiting);
    if (!waiting) { const settled = waiters; waiters = []; for (const settle of settled) settle(); }
    const due = counted.filter(waiter => events.length >= waiter.count);
    counted = counted.filter(waiter => events.length < waiter.count);
    for (const waiter of due) waiter.resolve();
  });
  const nextFalse = (): Promise<void> => new Promise(resolve => { waiters.push(resolve); });
  const reached = (count: number): Promise<void> => new Promise(resolve => {
    if (events.length >= count) resolve(); else counted.push({ count, resolve });
  });
  return { events, nextFalse, reached };
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

  test("a reader that cancels while the relay waits ends the wait and cancels the Home body", async () => {
    const { events } = recordWaits();
    const home = drivenHome("application/json");
    const response = await relayedFrom(home);
    const reader = response.body!.getReader();
    const first = reader.read();
    await home.pulled(1);
    home.send("one");
    expect(text(await first)).toBe("one");
    expect(events).toEqual([true]);
    await reader.cancel();
    expect(events).toEqual([true, false]);
    expect(home.cancelled()).toBe(true);
  });

  for (const contentType of ["application/json", "text/event-stream"]) {
    test("a " + contentType + " Home body that fails after one chunk, while the relay reads it, ends the wait", async () => {
      const { events, nextFalse } = recordWaits();
      const home = drivenHome(contentType);
      const reader = (await relayedFrom(home)).body!.getReader();
      const first = reader.read();
      await home.pulled(1);
      home.send("one");
      expect(text(await first)).toBe("one");
      expect(events).toEqual([true]);
      // The relay reads one chunk ahead: it is reading the Home again while the reader holds "one".
      await home.pulled(2);
      const relayEnded = nextFalse();
      home.fail(new Error("home failed"));
      await relayEnded;
      expect(events).toEqual([true, false]);
      expect(await reader.read().then(() => "read", () => "failed")).toBe("failed");
      expect(events).toEqual([true, false]);
    });
  }

  test("a Home failure the relay has not read yet keeps it waiting while it holds a read-ahead chunk", async () => {
    const { events, reached } = recordWaits();
    const home = drivenHome("text/event-stream");
    const { clock, armed } = armingClock();
    const reader = (await relayedFrom(home, { clock })).body!.getReader();
    const first = reader.read();
    await home.pulled(1);
    home.send("one");
    expect(text(await first)).toBe("one");
    await home.pulled(2);
    home.send("two");
    // Third arm (start, "one", "two"): "two" is in the relay's queue, which is full, so it has not read the Home again
    // and cannot see a failure.
    await armed(3);
    expect(home.pulls()).toBe(2);
    home.fail(new Error("home failed"));
    // It still holds "two" and hands it over (false, then true). Handing it over frees its queue, so its read-ahead
    // reads the Home, meets the failure and ends the relay (false) without the reader asking again.
    expect(text(await reader.read())).toBe("two");
    await reached(4);
    expect(events).toEqual([true, false, true, false]);
    expect(await reader.read().then(() => "read", () => "failed")).toBe("failed");
    expect(events).toEqual([true, false, true, false]);
  });

  test("a caller abort while the relay holds a queued chunk ends the wait for good", async () => {
    const { events, nextFalse } = recordWaits();
    const home = drivenHome("text/event-stream");
    const { clock, armed } = armingClock();
    const caller = new AbortController();
    const reader = (await relayedFrom(home, { signal: caller.signal, clock })).body!.getReader();
    const first = reader.read();
    await home.pulled(1);
    home.send("one");
    expect(text(await first)).toBe("one");
    await home.pulled(2);
    // The Home sends a second chunk, then nothing; after the third arm the relay holds it queued, reading nothing.
    home.send("two");
    await armed(3);
    expect(home.pulls()).toBe(2);
    expect(events).toEqual([true]);
    const relayEnded = nextFalse();
    caller.abort();
    await relayEnded;
    expect(events).toEqual([true, false]);
    expect(home.cancelled()).toBe(true);
    // Whatever the reader still gets, the ended relay is never reported as waiting again.
    await reader.read().catch(() => undefined);
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
    let calls = 0;
    setLinkChildRelayWaitObserverForTests(() => { calls += 1; throw new Error("observer failed"); });
    const response = await relayed(["one", "two"], "text/event-stream");
    expect(await response.text()).toBe("onetwo");
    expect(calls).toBeGreaterThan(0);
  });
});
