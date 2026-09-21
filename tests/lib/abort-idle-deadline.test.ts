import { strict as assert } from "node:assert";
import {
  guardResponseBodyInactivity,
  guardDirectPassthroughBodyInactivity,
  readResponseBodyWithInactivity,
  readResponseStreamWithInactivity,
  ResponseBodyInactivityError,
} from "../../src/lib/response-body-inactivity";

import { expect, spyOn, test } from "bun:test";
import { idleDeadline } from "../../src/lib/abort";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("idleDeadline fires once after the idle window with no reset", async () => {
  let fired = 0;
  const idle = idleDeadline(30, () => { fired += 1; });
  idle.reset();
  await sleep(120);
  expect(fired).toBe(1);
  // idempotent after fire: reset/cancel are no-ops, never fires again
  idle.reset();
  await sleep(80);
  expect(fired).toBe(1);
  idle.cancel();
  expect(fired).toBe(1);
});

test("idleDeadline reset() re-arms and postpones firing", () => {
  // Keep this boundary check synchronous: real sleeps can resume after the idle window.
  // The other cases below still exercise Bun's real timers.
  type TimerHandle = ReturnType<typeof setTimeout>;
  let now = 0;
  let nextHandle = 0;
  const timers = new Map<TimerHandle, { at: number; fire: () => void }>();
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]
  ) => {
    const handle = ++nextHandle as unknown as TimerHandle;
    timers.set(handle, { at: now + delay, fire: () => callback(...args) });
    return handle;
  }) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(handle => {
    timers.delete(handle as TimerHandle);
  });
  const advanceBy = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fire();
    }
    now = target;
  };
  let fired = 0;
  let idle: ReturnType<typeof idleDeadline> | undefined;
  try {
    idle = idleDeadline(120, () => { fired += 1; });
    idle.reset();
    for (let i = 0; i < 4; i++) {
      advanceBy(40);
      idle.reset(); // total elapsed exceeds 120 ms, but each silent interval does not
    }
    expect(fired).toBe(0);
    advanceBy(119);
    expect(fired).toBe(0);
    advanceBy(1);
    expect(fired).toBe(1);
    advanceBy(240);
    expect(fired).toBe(1);
  } finally {
    try {
      idle?.cancel();
    } finally {
      clearSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  }
});

test("idleDeadline pause() disarms without retiring; reset() re-arms after pause", async () => {
  let fired = 0;
  const idle = idleDeadline(30, () => { fired += 1; });
  idle.reset();
  idle.pause();
  await sleep(100);
  expect(fired).toBe(0); // paused: no pending window
  idle.reset();
  await sleep(100);
  expect(fired).toBe(1); // re-armed after pause still works
});

test("idleDeadline cancel() is permanent", async () => {
  let fired = 0;
  const idle = idleDeadline(20, () => { fired += 1; });
  idle.reset();
  idle.cancel();
  idle.reset(); // no-op after cancel
  await sleep(80);
  expect(fired).toBe(0);
});

test("idleDeadline with idleMs <= 0 is inert (0-disable lives in the primitive)", async () => {
  let fired = 0;
  const zero = idleDeadline(0, () => { fired += 1; });
  zero.reset();
  const negative = idleDeadline(-5, () => { fired += 1; });
  negative.reset();
  await sleep(60);
  expect(fired).toBe(0);
  zero.cancel();
  negative.cancel();
});

test("idleDeadline starts disarmed: constructing without reset never fires", async () => {
  let fired = 0;
  idleDeadline(15, () => { fired += 1; });
  await sleep(60);
  expect(fired).toBe(0);
});

// Deterministic clock: advancing it never depends on a loaded runner's real sleeps.
function bodyClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fire: () => void }>();
  const disposers: Array<() => void> = [];
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const originalNow = Object.getOwnPropertyDescriptor(performance, "now");
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => {
    const id = ++next;
    timers.set(id, { at: now + ms, fire: () => fn(...args) });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => { timers.delete(id as number); }) as typeof clearTimeout;
  Object.defineProperty(performance, "now", { configurable: true, value: () => now });
  return {
    defer(fn: () => void) { disposers.push(fn); },
    get pending() { return timers.size; },
    elapse(ms: number) { now += ms; },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fire();
      }
      now = target;
    },
    restore() {
      try { for (const dispose of disposers.reverse()) dispose(); }
      finally {
        globalThis.setTimeout = originalSet;
        globalThis.clearTimeout = originalClear;
        if (originalNow) Object.defineProperty(performance, "now", originalNow);
        else Reflect.deleteProperty(performance, "now");
      }
    },
  };
}

type BodyClock = ReturnType<typeof bodyClock>;
function bodyCase(name: string, run: (clock: BodyClock) => Promise<void>) {
  test(`response body inactivity: ${name}`, async () => {
    const clock = bodyClock();
    try { await run(clock); } finally { clock.restore(); }
  });
}

function bodyFixture(clock: BodyClock, onCancel?: (reason: unknown) => void | Promise<void>) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let pulls = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const cancelled: unknown[] = [];
  const upstream = new AbortController();
  clock.defer(() => upstream.abort());
  const source = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() {
      pulls += 1;
      for (const waiter of waiters) if (pulls >= waiter.count) waiter.resolve();
    },
    cancel(reason) { cancelled.push(reason); return onCancel?.(reason); },
  }, { highWaterMark: 0 });
  return {
    source, upstream, cancelled,
    get controller() { return controller; },
    get pulls() { return pulls; },
    waitForPull(count = 1): Promise<void> {
      return pulls >= count ? Promise.resolve() : new Promise(resolve => waiters.push({ count, resolve }));
    },
    guard(timeoutMs = 100, init?: ResponseInit) {
      const guarded = guardResponseBodyInactivity(new Response(source, init), upstream.signal, timeoutMs);
      clock.defer(guarded.dispose);
      return guarded;
    },
  };
}

const bodyBytes = (text: string) => new TextEncoder().encode(text);
async function* bodyChunks(response: Response): AsyncGenerator<Uint8Array> {
  const reader = response.body!.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally { reader.releaseLock(); }
}

bodyCase("bounds headers-only silence without aborting the shared signal", async clock => {
  const f = bodyFixture(clock);
  const failure = assert.rejects(f.guard().response.text(), ResponseBodyInactivityError);
  await f.waitForPull();
  clock.advance(100);
  await failure;
  assert.equal(f.cancelled.length, 1);
  assert.equal((f.cancelled[0] as Error).name, "TimeoutError");
  assert.equal(f.source.locked, false);
  assert.equal(f.upstream.signal.aborted, false);
  assert.equal(clock.pending, 0);
});

bodyCase("does not prefetch or arm before a downstream read", async clock => {
  const f = bodyFixture(clock);
  const guard = f.guard();
  await Promise.resolve();
  clock.advance(10_000);
  assert.equal(f.pulls, 0);
  assert.equal(clock.pending, 0);
  assert.equal(f.cancelled.length, 0);
  guard.dispose();
});

bodyCase("preserves response metadata and exact chunk identity on clean EOF", async clock => {
  const f = bodyFixture(clock);
  const response = f.guard(100, { status: 206, statusText: "Partial Content", headers: { "x-test": "kept" } }).response;
  assert.equal(response.status, 206);
  assert.equal(response.statusText, "Partial Content");
  assert.equal(response.headers.get("x-test"), "kept");
  const reader = response.body!.getReader();
  const bytes = new Uint8Array([0, 1, 255, 10]);
  f.controller.enqueue(bytes);
  assert.equal((await reader.read()).value, bytes);
  f.controller.close();
  assert.equal((await reader.read()).done, true);
  assert.equal(f.cancelled.length, 0);
  assert.equal(f.source.locked, false);
  assert.equal(f.upstream.signal.aborted, false);
  assert.equal(clock.pending, 0);
});

bodyCase("does not time out a slow consumer after a single chunk", async clock => {
  const f = bodyFixture(clock);
  const reader = f.guard().response.body!.getReader();
  f.controller.enqueue(bodyBytes("first"));
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  clock.advance(10_000);
  assert.equal(clock.pending, 0);
  assert.equal(f.cancelled.length, 0);
  f.controller.enqueue(bodyBytes("second"));
  assert.equal(new TextDecoder().decode((await reader.read()).value), "second");
  f.controller.close();
  assert.equal((await reader.read()).done, true);
});

bodyCase("starts a fresh window for a mid-body pending read", async clock => {
  const f = bodyFixture(clock);
  const reader = f.guard().response.body!.getReader();
  f.controller.enqueue(bodyBytes("first"));
  await reader.read();
  clock.advance(1_000);
  const failed = assert.rejects(reader.read(), ResponseBodyInactivityError);
  await f.waitForPull();
  clock.advance(99);
  assert.equal(f.cancelled.length, 0);
  clock.advance(1);
  await failed;
  assert.equal(f.cancelled.length, 1);
});

bodyCase("empty chunks do not reset the pending-read window", async clock => {
  const f = bodyFixture(clock);
  const failure = assert.rejects(f.guard().response.text(), ResponseBodyInactivityError);
  await f.waitForPull();
  clock.advance(90);
  f.controller.enqueue(new Uint8Array());
  await f.waitForPull(2);
  clock.advance(10);
  await failure;
  assert.equal(f.cancelled.length, 1);
});

bodyCase("real bytes after empty chunks pause and then reset the window", async clock => {
  const f = bodyFixture(clock);
  const reader = f.guard().response.body!.getReader();
  const first = reader.read();
  await f.waitForPull();
  clock.advance(80);
  f.controller.enqueue(new Uint8Array());
  await f.waitForPull(2);
  f.controller.enqueue(bodyBytes("progress"));
  assert.equal(new TextDecoder().decode((await first).value), "progress");
  clock.advance(500);
  assert.equal(f.cancelled.length, 0);
  const failure = assert.rejects(reader.read(), ResponseBodyInactivityError);
  await f.waitForPull(3);
  clock.advance(100);
  await failure;
});

bodyCase("bounds a microtask-only producer of empty chunks", async clock => {
  let pulls = 0;
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { pulls += 1; clock.elapse(1); controller.enqueue(new Uint8Array()); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const guard = guardResponseBodyInactivity(new Response(source), undefined, 10);
  clock.defer(guard.dispose);
  await assert.rejects(guard.response.text(), ResponseBodyInactivityError);
  assert.equal(pulls, 10);
  assert.equal(cancelled, true);
  assert.equal(source.locked, false);
  assert.equal(clock.pending, 0);
});

// Real timers on purpose: the point is that queued macrotasks still run while the
// guard discards empty chunks, which a faked clock cannot observe.
test("a microtask-only empty producer still lets queued tasks run before the deadline", async () => {
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array()); },
  }, { highWaterMark: 0 });
  const guard = guardResponseBodyInactivity(new Response(source), undefined, 5_000);
  const started = performance.now();
  let queuedTaskAt: number | undefined;
  setTimeout(() => { queuedTaskAt = performance.now() - started; }, 0);
  const failure = guard.response.text().then(() => undefined, (error: unknown) => error);
  await sleep(50);
  expect(queuedTaskAt).toBeDefined();
  expect(queuedTaskAt!).toBeLessThan(1_000);
  guard.dispose();
  await failure;
});

bodyCase("consumer cancellation retains its reason and releases the reader", async clock => {
  const f = bodyFixture(clock);
  const guard = f.guard();
  const reason = new Error("client cancelled");
  await guard.response.body!.cancel(reason);
  guard.dispose();
  assert.deepEqual(f.cancelled, [reason]);
  assert.equal(f.source.locked, false);
  assert.equal(clock.pending, 0);
});

bodyCase("timeout does not await a never-settling cancellation hook", async clock => {
  const f = bodyFixture(clock, () => new Promise<void>(() => {}));
  const failure = assert.rejects(f.guard().response.text(), ResponseBodyInactivityError);
  await f.waitForPull();
  clock.advance(100);
  await failure;
  assert.equal(f.source.locked, false);
  assert.equal(clock.pending, 0);
});

bodyCase("consumer cancellation does not await a never-settling cancellation hook", async clock => {
  const f = bodyFixture(clock, () => new Promise<void>(() => {}));
  await f.guard().response.body!.cancel("stop");
  assert.deepEqual(f.cancelled, ["stop"]);
  assert.equal(f.source.locked, false);
});

bodyCase("absorbs cancellation rejection without replacing the timeout", async clock => {
  const f = bodyFixture(clock, () => Promise.reject(new Error("cleanup failed")));
  const failure = assert.rejects(f.guard().response.text(), ResponseBodyInactivityError);
  await f.waitForPull();
  clock.advance(100);
  await failure;
  assert.equal(f.source.locked, false);
});

bodyCase("preserves upstream read errors rather than recasting them as timeouts", async clock => {
  const f = bodyFixture(clock);
  const error = new Error("upstream reset");
  const failed = assert.rejects(f.guard().response.text(), candidate => candidate === error);
  await f.waitForPull();
  f.controller.error(error);
  await failed;
  assert.equal(f.source.locked, false);
  assert.equal(clock.pending, 0);
});

bodyCase("observes an already-aborted signal before attaching a parser", async clock => {
  const f = bodyFixture(clock);
  const reason = new DOMException("client gone", "AbortError");
  f.upstream.abort(reason);
  await assert.rejects(f.guard().response.text(), candidate => candidate === reason);
  assert.deepEqual(f.cancelled, [reason]);
  assert.equal(f.pulls, 0);
  assert.equal(clock.pending, 0);
});

bodyCase("external abort settles a locked pending read immediately", async clock => {
  const f = bodyFixture(clock);
  const reason = new Error("client gone");
  const failed = assert.rejects(f.guard().response.text(), candidate => candidate === reason);
  await f.waitForPull();
  f.upstream.abort(reason);
  await failed;
  clock.advance(500);
  assert.deepEqual(f.cancelled, [reason]);
  assert.equal(f.source.locked, false);
  assert.equal(clock.pending, 0);
});

bodyCase("external abort also works while downstream is paused", async clock => {
  const f = bodyFixture(clock);
  const reader = f.guard().response.body!.getReader();
  f.controller.enqueue(bodyBytes("one"));
  await reader.read();
  const reason = new Error("cancel between reads");
  f.upstream.abort(reason);
  await assert.rejects(reader.read(), candidate => candidate === reason);
  assert.deepEqual(f.cancelled, [reason]);
});

bodyCase("normal completion detaches the abort listener", async clock => {
  const f = bodyFixture(clock);
  const completed = f.guard().response.text();
  await f.waitForPull();
  f.controller.close();
  assert.equal(await completed, "");
  f.upstream.abort();
  clock.advance(1_000);
  assert.equal(f.cancelled.length, 0);
  assert.equal(clock.pending, 0);
});

bodyCase("explicit disposal is idempotent and releases an unread body", async clock => {
  const f = bodyFixture(clock, () => new Promise<void>(() => {}));
  const guard = f.guard();
  guard.dispose();
  guard.dispose();
  f.upstream.abort();
  assert.equal(await guard.response.text(), "");
  assert.equal(f.cancelled.length, 1);
  assert.equal(f.source.locked, false);
  assert.equal(clock.pending, 0);
});

bodyCase("buffered parser failure cleans up its body", async clock => {
  const f = bodyFixture(clock);
  const error = new Error("parser failed before reading");
  await assert.rejects(readResponseBodyWithInactivity(
    new Response(f.source), f.upstream.signal, 100, async () => { throw error; },
  ), candidate => candidate === error);
  assert.equal(f.cancelled.length, 1);
  assert.equal(f.source.locked, false);
});

bodyCase("buffered parser early return cancels its unread remainder", async clock => {
  const f = bodyFixture(clock);
  assert.equal(await readResponseBodyWithInactivity(
    new Response(f.source), f.upstream.signal, 100, async () => "early answer",
  ), "early answer");
  assert.equal(f.cancelled.length, 1);
  assert.equal(f.source.locked, false);
  assert.equal(f.upstream.signal.aborted, false);
});

bodyCase("stream parser failure cleans up even before its first read", async clock => {
  const f = bodyFixture(clock);
  const error = new Error("stream parser failed");
  const stream = readResponseStreamWithInactivity(
    new Response(f.source), f.upstream.signal, 100, async function* () { throw error; },
  );
  await assert.rejects(stream.next(), candidate => candidate === error);
  assert.equal(f.cancelled.length, 1);
  assert.equal(f.source.locked, false);
});

bodyCase("abandoning a parsed stream cleans up the original body", async clock => {
  const f = bodyFixture(clock);
  f.controller.enqueue(bodyBytes("one"));
  const events = readResponseStreamWithInactivity(new Response(f.source), f.upstream.signal, 100, bodyChunks);
  assert.equal(new TextDecoder().decode((await events.next()).value), "one");
  await events.return(undefined);
  assert.equal(f.cancelled.length, 1);
  assert.equal(f.source.locked, false);
  assert.equal(clock.pending, 0);
});

bodyCase("a headers-only continuation has its own window and leaves terminal delivery possible", async clock => {
  const upstream = new AbortController();
  clock.defer(() => upstream.abort());
  assert.equal(await readResponseBodyWithInactivity(new Response("initial"), upstream.signal, 100, r => r.text()), "initial");
  clock.advance(5_000);
  const f = bodyFixture(clock);
  const events = readResponseStreamWithInactivity(new Response(f.source), upstream.signal, 100, bodyChunks);
  const order: string[] = [];
  // A minimal enclosing relay consumes the real guarded iterator and drains a
  // terminal before request teardown. This is not the native SSE bridge fixture.
  const wire = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of events) controller.enqueue(chunk);
      } catch (error) {
        assert.ok(error instanceof ResponseBodyInactivityError);
        assert.equal(upstream.signal.aborted, false);
        controller.enqueue(bodyBytes("event: response.failed\ndata: {}\n\n"));
        order.push("terminal");
      } finally {
        controller.close();
        upstream.abort();
        order.push("teardown");
      }
    },
  });
  const received = new Response(wire).text();
  await f.waitForPull();
  clock.advance(100);
  assert.match(await received, /response.failed/);
  assert.deepEqual(order, ["terminal", "teardown"]);
  assert.equal(f.source.locked, false);
});

bodyCase("native SSE, bounded JSON and error responses retain identity without another body access", async () => {
  for (const [status, contentType] of [[200, "Text/Event-Stream"], [200, "application/json"], [429, "text/plain"]] as const) {
    const response = new Response("already owned", { status, headers: { "content-type": contentType } });
    const tagged = new WeakSet([response]);
    Object.defineProperty(response, "body", { get() { throw new Error("duplicate body access"); } });
    const guarded = guardDirectPassthroughBodyInactivity(response, undefined, 100);
    assert.equal(guarded, response);
    assert.equal(tagged.has(guarded), true);
  }
});

bodyCase("redirect bodies are bounded even with an SSE content type", async clock => {
  const f = bodyFixture(clock);
  const response = guardDirectPassthroughBodyInactivity(new Response(f.source, {
    status: 302, headers: { "content-type": "text/event-stream", location: "/next" },
  }), f.upstream.signal, 100);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/next");
  const failed = assert.rejects(response.text(), ResponseBodyInactivityError);
  await f.waitForPull();
  clock.advance(100);
  await failed;
  assert.equal(f.source.locked, false);
});

bodyCase("a plain successful passthrough body is inactivity-bounded", async clock => {
  const f = bodyFixture(clock);
  const response = guardDirectPassthroughBodyInactivity(new Response(f.source, {
    status: 200, headers: { "content-type": "text/plain" },
  }), f.upstream.signal, 100);
  assert.notEqual(response.body, null);
  const failed = assert.rejects(response.text(), ResponseBodyInactivityError);
  await f.waitForPull();
  clock.advance(100);
  await failed;
  assert.equal(f.cancelled.length, 1);
  assert.equal(f.source.locked, false);
  assert.equal(clock.pending, 0);
});

bodyCase("large deadlines do not overflow setTimeout into an immediate failure", async clock => {
  const f = bodyFixture(clock);
  const failed = assert.rejects(f.guard(3_000_000_000).response.text(), ResponseBodyInactivityError);
  await f.waitForPull();
  clock.advance(2_147_483_647);
  assert.equal(f.cancelled.length, 0);
  assert.equal(clock.pending, 1);
  clock.advance(3_000_000_000 - 2_147_483_647);
  await failed;
});

bodyCase("disabled and non-finite deadlines still preserve cancellation", async clock => {
  for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const f = bodyFixture(clock);
    const reason = new Error("cancel disabled deadline");
    const failed = assert.rejects(f.guard(ms).response.text(), candidate => candidate === reason);
    await f.waitForPull();
    clock.advance(1_000);
    assert.equal(clock.pending, 0);
    assert.equal(f.cancelled.length, 0);
    f.upstream.abort(reason);
    await failed;
  }
});

bodyCase("a bodyless response is an identity-preserving no-op", async () => {
  const response = new Response(null, { status: 204 });
  const guard = guardResponseBodyInactivity(response, undefined, 100);
  assert.equal(guard.response, response);
  guard.dispose();
  guard.dispose();
});

bodyCase("failure is published before a source cancellation can abort other readers", async clock => {
  const upstream = new AbortController();
  const source = new ReadableStream<Uint8Array>({
    cancel() { upstream.abort(new Error("synchronous teardown")); },
  });
  const guard = guardResponseBodyInactivity(new Response(source), upstream.signal, 100);
  clock.defer(guard.dispose);
  const failure = assert.rejects(guard.response.text(), ResponseBodyInactivityError);
  // Starting the guard's pull requires one microtask; the deadline itself is deterministic.
  await Promise.resolve();
  clock.advance(100);
  await failure;
  assert.equal(source.locked, false);
});
