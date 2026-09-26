import { describe, expect, test } from "bun:test";
import {
  COALESCE_MAX_CHUNK_LENGTH,
  createAdapterEventQueue,
  DEFAULT_MAX_BACKLOG_CODE_UNITS,
  DEFAULT_MAX_EVENT_CODE_UNITS,
  PREFLIGHT_HEARTBEAT_RETAIN_LIMIT,
  preflightAdapterEvents,
  retainedEventCodeUnits,
} from "../../src/adapters/run-turn-queue";
import type { AdapterEvent } from "../../src/types";

const text = (value: string): AdapterEvent => ({ type: "text_delta", text: value });
const phasedText = (value: string, phase: "final" | "commentary"): AdapterEvent => ({ type: "text_delta", text: value, phase });
const thinking = (value: string): AdapterEvent => ({ type: "thinking_delta", thinking: value });
const toolStart = (id: string): AdapterEvent => ({ type: "tool_call_start", id, name: "probe" });
const heartbeat: AdapterEvent = { type: "heartbeat" };
const done: AdapterEvent = { type: "done" };

async function* events(values: readonly AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of values) yield event;
}

async function collect(source: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const result: AdapterEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}

describe("run-turn adapter event queue", () => {
  test("collect preserves push order after close", async () => {
    const queue = createAdapterEventQueue();

    queue.push(toolStart("a"));
    queue.push(toolStart("b"));
    queue.close();

    expect(await queue.collect()).toEqual([toolStart("a"), toolStart("b")]);
  });

  test("stream wakes a pending reader when an event is pushed", async () => {
    const queue = createAdapterEventQueue();
    const iterator = queue.stream()[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.push(text("ready"));
    queue.close();

    expect(await pending).toEqual({ done: false, value: text("ready") });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  test("close is idempotent and wakes pending readers", async () => {
    const queue = createAdapterEventQueue();
    const iterator = queue.stream()[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.close();
    queue.close();

    expect(await pending).toEqual({ done: true, value: undefined });
  });

  test("push after close is ignored", async () => {
    const queue = createAdapterEventQueue();

    queue.close();
    queue.push(text("ignored"));

    expect(await queue.collect()).toEqual([]);
  });

  test("non-coalescible event flood preserves the 1024-event queue abort cap", async () => {
    let backlogExceeded = 0;
    const queue = createAdapterEventQueue({
      onBacklogExceeded: () => { backlogExceeded += 1; },
    });

    for (let i = 0; i <= 1_024; i++) queue.push(toolStart(String(i)));
    queue.push(toolStart("ignored after overflow"));

    const collected = await queue.collect();
    expect(backlogExceeded).toBe(1);
    expect(collected).toHaveLength(1_025);
    expect(collected.slice(0, 1_024)).toEqual(
      Array.from({ length: 1_024 }, (_, i) => toolStart(String(i))),
    );
    expect(collected.at(-1)).toEqual({
      type: "error",
      message: "consumer stalled: adapter event backlog exceeded — turn aborted",
    });
  });

  test("adjacent same-phase text deltas coalesce into one buffered item instead of overflowing", async () => {
    let backlogExceeded = 0;
    const queue = createAdapterEventQueue({
      onBacklogExceeded: () => { backlogExceeded += 1; },
    });

    for (let i = 0; i < 5_000; i++) queue.push(text(String(i % 10)));
    queue.close();

    const collected = await queue.collect();
    expect(backlogExceeded).toBe(0);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual(text(Array.from({ length: 5_000 }, (_, i) => String(i % 10)).join("")));
  });

  test("adjacent thinking deltas coalesce with exact concatenation", async () => {
    let backlogExceeded = 0;
    const queue = createAdapterEventQueue({
      onBacklogExceeded: () => { backlogExceeded += 1; },
    });

    for (let i = 0; i < 5_000; i++) queue.push(thinking(String(i % 10)));
    queue.close();

    const collected = await queue.collect();
    expect(backlogExceeded).toBe(0);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual(thinking(Array.from({ length: 5_000 }, (_, i) => String(i % 10)).join("")));
  });

  test("coalescing splits past the combined-length threshold and preserves concatenation", async () => {
    const queue = createAdapterEventQueue();
    const chunk = "x".repeat(Math.floor(COALESCE_MAX_CHUNK_LENGTH / 3) + 1);

    for (let i = 0; i < 4; i++) queue.push(text(chunk));
    queue.close();

    const collected = await queue.collect();
    expect(collected.length).toBeGreaterThan(1);
    for (const event of collected) {
      expect(event.type).toBe("text_delta");
      if (event.type === "text_delta") {
        expect(event.text.length).toBeLessThanOrEqual(COALESCE_MAX_CHUNK_LENGTH);
      }
    }
    const joined = collected.map(event => (event.type === "text_delta" ? event.text : "")).join("");
    expect(joined).toBe(chunk.repeat(4));
  });

  test("consecutive heartbeats collapse to one buffered heartbeat", async () => {
    const queue = createAdapterEventQueue();

    for (let i = 0; i < 50; i++) queue.push(heartbeat);
    queue.close();

    // Collapsing also means preflight may replay one buffered heartbeat where
    // it previously replayed up to its retain limit; heartbeats carry no
    // metadata, so cardinality is unobservable downstream.
    expect(await queue.collect()).toEqual([heartbeat]);
  });

  test("heartbeat coalescing latches a later replay-unsafe marker", async () => {
    const queue = createAdapterEventQueue();

    queue.push(heartbeat);
    queue.push({ type: "heartbeat", replayUnsafe: true });
    queue.close();

    expect(await queue.collect()).toEqual([{ type: "heartbeat", replayUnsafe: true }]);
  });

  test("heartbeat coalescing does not clear an existing replay-unsafe marker", async () => {
    const queue = createAdapterEventQueue();

    queue.push({ type: "heartbeat", replayUnsafe: true });
    queue.push(heartbeat);
    queue.close();

    expect(await queue.collect()).toEqual([{ type: "heartbeat", replayUnsafe: true }]);
  });

  test("a tool event breaks text coalescing on both sides", async () => {
    const queue = createAdapterEventQueue();

    queue.push(text("a"));
    queue.push(text("b"));
    queue.push(toolStart("t1"));
    queue.push(text("c"));
    queue.push(text("d"));
    queue.close();

    expect(await queue.collect()).toEqual([text("ab"), toolStart("t1"), text("cd")]);
  });

  test("phase transitions never merge, including explicit-to-omitted", async () => {
    const queue = createAdapterEventQueue();

    queue.push(phasedText("f1", "final"));
    queue.push(phasedText("f2", "final"));
    queue.push(phasedText("c1", "commentary"));
    queue.push(text("bare1"));
    queue.push(text("bare2"));
    queue.close();

    expect(await queue.collect()).toEqual([
      phasedText("f1f2", "final"),
      phasedText("c1", "commentary"),
      text("bare1bare2"),
    ]);
  });

  test("empty-string deltas merge without corrupting concatenation", async () => {
    const queue = createAdapterEventQueue();

    queue.push(text(""));
    queue.push(text("a"));
    queue.push(text(""));
    queue.push(text("b"));
    queue.close();

    expect(await queue.collect()).toEqual([text("ab")]);
  });

  test("coalescing never rewrites an event handed directly to a waiting reader", async () => {
    const queue = createAdapterEventQueue();
    const iterator = queue.stream()[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.push(text("direct"));
    queue.push(text("buffered1"));
    queue.push(text("buffered2"));
    queue.close();

    expect(await pending).toEqual({ done: false, value: text("direct") });
    expect(await iterator.next()).toEqual({ done: false, value: text("buffered1buffered2") });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  test("coalescing replaces the tail with a fresh object instead of mutating pushed events", async () => {
    const queue = createAdapterEventQueue();
    const first: AdapterEvent = { type: "text_delta", text: "a" };
    const second: AdapterEvent = { type: "text_delta", text: "b" };

    queue.push(first);
    queue.push(second);
    queue.close();

    expect(first).toEqual({ type: "text_delta", text: "a" });
    expect(second).toEqual({ type: "text_delta", text: "b" });
    expect(await queue.collect()).toEqual([text("ab")]);
  });

  test("does not count direct handoff to an active consumer toward the backlog cap", async () => {
    let backlogExceeded = 0;
    const queue = createAdapterEventQueue({
      onBacklogExceeded: () => { backlogExceeded += 1; },
    });
    const iterator = queue.stream()[Symbol.asyncIterator]();
    const received: AdapterEvent[] = [];

    for (let i = 0; i < 2_000; i++) {
      const pending = iterator.next();
      queue.push(text(String(i)));
      const result = await pending;
      expect(result.done).toBe(false);
      if (!result.done) received.push(result.value);
    }
    queue.close();

    expect(backlogExceeded).toBe(0);
    expect(received).toEqual(Array.from({ length: 2_000 }, (_, i) => text(String(i))));
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });
});

describe("run-turn adapter event preflight", () => {
  test("a cooldown heartbeat commits preflight while preserving later output", async () => {
    const ready: AdapterEvent = { type: "heartbeat", preflightReady: true };
    const values = [ready, text("resumed"), done];

    const preflight = await preflightAdapterEvents(events(values));

    expect(preflight.error).toBeUndefined();
    expect(preflight.replayUnsafe).toBe(false);
    expect(await collect(preflight.stream)).toEqual(values);
  });

  test("buffered preflight continues past a cooldown heartbeat to the first refusal", async () => {
    const ready: AdapterEvent = { type: "heartbeat", preflightReady: true };
    const error: AdapterEvent = { type: "error", status: 429, message: "rate limited" };

    const preflight = await preflightAdapterEvents(events([ready, error]), undefined, { honorReady: false });

    expect(preflight.error).toEqual(error);
    expect(preflight.ready).toBeUndefined();
    expect(await collect(preflight.stream)).toEqual([ready, error]);
  });

  test("queued heartbeat coalescing retains the cooldown preflight signal", async () => {
    const queue = createAdapterEventQueue();
    queue.push(heartbeat);
    queue.push({ type: "heartbeat", preflightReady: true });
    queue.push(text("resumed"));
    queue.close();

    const preflight = await preflightAdapterEvents(queue.stream());

    expect(await collect(preflight.stream)).toEqual([
      { type: "heartbeat", preflightReady: true },
      text("resumed"),
    ]);
  });

  test("10,000 leading heartbeats retain only the bounded tail and still complete", async () => {
    const values = [...Array.from({ length: 10_000 }, () => heartbeat), done];
    const preflight = await preflightAdapterEvents(events(values));
    const replayed = await collect(preflight.stream);
    expect(replayed).toHaveLength(PREFLIGHT_HEARTBEAT_RETAIN_LIMIT + 1);
    expect(replayed.slice(0, -1).every(event => event.type === "heartbeat")).toBe(true);
    expect(replayed.at(-1)).toEqual(done);
  });

  test("heartbeat then error reports pre-commit failure without duplicate replay", async () => {
    const error: AdapterEvent = { type: "error", message: "missing credential" };
    const preflight = await preflightAdapterEvents(events([heartbeat, error]));
    expect(preflight.error).toEqual(error);
    expect(preflight.empty).toBe(false);
    expect(await collect(preflight.stream)).toEqual([heartbeat, error]);
  });

  test("replay-unsafe state survives heartbeat buffer eviction", async () => {
    const unsafeHeartbeat: AdapterEvent = { type: "heartbeat", replayUnsafe: true };
    const error: AdapterEvent = { type: "error", message: "rate limited" };
    const values = [
      unsafeHeartbeat,
      ...Array.from({ length: PREFLIGHT_HEARTBEAT_RETAIN_LIMIT + 1 }, () => heartbeat),
      error,
    ];
    const preflight = await preflightAdapterEvents(events(values));
    expect(preflight.replayUnsafe).toBe(true);
    const repeated = await preflightAdapterEvents(preflight.stream);
    expect(repeated.replayUnsafe).toBe(true);
    expect(await collect(repeated.stream)).toEqual([
      ...Array.from({ length: PREFLIGHT_HEARTBEAT_RETAIN_LIMIT }, () => unsafeHeartbeat),
      error,
    ]);
  });

  test("heartbeat text done commits and replays the full order once", async () => {
    const values = [heartbeat, text("once"), done];
    const preflight = await preflightAdapterEvents(events(values));
    expect(preflight.error).toBeUndefined();
    expect(preflight.empty).toBe(false);
    expect(await collect(preflight.stream)).toEqual(values);
  });

  test("heartbeat text error stays committed and replays each event once", async () => {
    const error: AdapterEvent = { type: "error", message: "late failure" };
    const values = [heartbeat, text("once"), error];
    const preflight = await preflightAdapterEvents(events(values));
    expect(preflight.error).toBeUndefined();
    expect(preflight.empty).toBe(false);
    expect(await collect(preflight.stream)).toEqual(values);
  });

  test("timeout transfers the pending next read to replay exactly once", async () => {
    const pending = Promise.withResolvers<IteratorResult<AdapterEvent>>();
    let nextCalls = 0;
    const source: AsyncIterable<AdapterEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            nextCalls++;
            if (nextCalls === 1) return Promise.resolve({ done: false, value: heartbeat });
            if (nextCalls === 2) return pending.promise;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
    const preflightPromise = preflightAdapterEvents(source, undefined, { maxWaitMs: 20 });
    let guard: ReturnType<typeof setTimeout> | undefined;
    const preflight = await Promise.race([
      preflightPromise,
      new Promise<null>(resolve => { guard = setTimeout(() => resolve(null), 500); }),
    ]);
    if (guard !== undefined) clearTimeout(guard);
    if (preflight === null) {
      pending.resolve({ done: false, value: text("late") });
      await preflightPromise;
    }
    expect(preflight).not.toBeNull();
    if (preflight === null) return;

    expect(preflight.timedOut).toBe(true);
    expect(nextCalls).toBe(2);
    pending.resolve({ done: false, value: text("late") });
    expect(await collect(preflight.stream)).toEqual([heartbeat, text("late")]);
    expect(nextCalls).toBe(3);
  });

  test("an expired preflight wait is timed out, not empty, without reading ahead", async () => {
    let nextCalls = 0;
    const source: AsyncIterable<AdapterEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            nextCalls++;
            return Promise.resolve(nextCalls === 1
              ? { done: false, value: text("resume") }
              : { done: true, value: undefined });
          },
        };
      },
    };
    const preflight = await preflightAdapterEvents(source, undefined, { maxWaitMs: 0 });
    expect(preflight.timedOut).toBe(true);
    expect(preflight.empty).toBe(false);
    expect(nextCalls).toBe(0);
    expect(await collect(preflight.stream)).toEqual([text("resume")]);
    expect(nextCalls).toBe(2);
  });

  test("first-event classifier replaces only the first meaningful event", async () => {
    const values: AdapterEvent[] = [
      heartbeat,
      { type: "tool_call_start", id: "call_stale", name: "stale_tool" },
      text("must not run"),
    ];
    const classified: Extract<AdapterEvent, { type: "error" }> = {
      type: "error",
      status: 502,
      message: "undeclared tool",
    };
    const preflight = await preflightAdapterEvents(events(values), event =>
      event.type === "tool_call_start" ? classified : undefined);
    expect(preflight.error).toEqual(classified);
    expect(preflight.empty).toBe(false);
    expect(await collect(preflight.stream)).toEqual([heartbeat, classified]);
  });

  test("first-event classifier cannot replace after a replay-unsafe heartbeat", async () => {
    const tool: AdapterEvent = { type: "tool_call_start", id: "call_stale", name: "stale_tool" };
    const values: AdapterEvent[] = [{ type: "heartbeat", replayUnsafe: true }, tool];
    const preflight = await preflightAdapterEvents(events(values), () => ({
      type: "error",
      status: 502,
      message: "must not replace",
    }));
    expect(preflight.error).toBeUndefined();
    expect(preflight.replayUnsafe).toBe(true);
    expect(await collect(preflight.stream)).toEqual(values);
  });

  test("immediate done is a commit", async () => {
    const preflight = await preflightAdapterEvents(events([done]));
    expect(preflight.error).toBeUndefined();
    expect(preflight.empty).toBe(false);
    expect(await collect(preflight.stream)).toEqual([done]);
  });

  test("empty close is an empty pre-commit failure", async () => {
    const preflight = await preflightAdapterEvents(events([]));
    expect(preflight.error).toBeUndefined();
    expect(preflight.empty).toBe(true);
    expect(await collect(preflight.stream)).toEqual([]);
  });

  test("leading error cancels the source iterator", async () => {
    let cancelled = 0;
    async function* source(): AsyncGenerator<AdapterEvent> {
      try {
        yield { type: "error", message: "stop" };
        yield text("must not run");
      } finally {
        cancelled += 1;
      }
    }
    const preflight = await preflightAdapterEvents(source());
    expect(preflight.error?.message).toBe("stop");
    expect(cancelled).toBe(1);
    expect(await collect(preflight.stream)).toEqual([{ type: "error", message: "stop" }]);
    expect(cancelled).toBe(1);
  });
});

describe("run-turn adapter event queue retained-payload budgets", () => {
  const BACKLOG_EXCEEDED = "consumer stalled: adapter event backlog exceeded — turn aborted";
  const EVENT_TOO_LARGE = "adapter event exceeds the single-event retained-string budget — turn aborted";

  test("a stalled consumer is bounded by retained payload, not by the event count alone", async () => {
    let backlogExceeded = 0;
    const queue = createAdapterEventQueue({
      maxBacklogCodeUnits: 8,
      maxEventCodeUnits: 8,
      onBacklogExceeded: () => { backlogExceeded += 1; },
    });

    // Each event on its own is within the per-event budget, so only the
    // aggregate can be what refuses the second one.
    expect(retainedEventCodeUnits(toolStart("0"))).toBeLessThanOrEqual(8);
    queue.push(toolStart("0"));
    queue.push(toolStart("1"));

    expect(backlogExceeded).toBe(1);
    expect(await queue.collect()).toEqual([
      toolStart("0"),
      { type: "error", message: BACKLOG_EXCEEDED },
    ]);
    expect(queue.retainedCodeUnits()).toBe(0);
  });

  test("one oversized event is refused with its own cause even into an empty queue", async () => {
    let backlogExceeded = 0;
    const queue = createAdapterEventQueue({
      maxEventCodeUnits: 8,
      onBacklogExceeded: () => { backlogExceeded += 1; },
    });

    // The aggregate has its whole default budget free; this refusal is about
    // the single event, and it has to say so rather than blame the consumer.
    queue.push(text("x".repeat(9)));

    expect(backlogExceeded).toBe(1);
    expect(await queue.collect()).toEqual([{ type: "error", message: EVENT_TOO_LARGE }]);
    expect(queue.retainedCodeUnits()).toBe(0);
  });

  test("accumulated coalescing is charged by retained growth, not once per merged delta", async () => {
    let backlogExceeded = 0;
    const queue = createAdapterEventQueue({
      maxBacklogCodeUnits: 16,
      onBacklogExceeded: () => { backlogExceeded += 1; },
    });

    // Three 2-character deltas sharing one 10-character phase. Retained growth
    // is 12 then +2 then +2; charging each whole event instead would bill 36
    // and abort a turn holding sixteen code units.
    queue.push(phasedText("ab", "commentary"));
    queue.push(phasedText("cd", "commentary"));
    queue.push(phasedText("ef", "commentary"));

    expect(backlogExceeded).toBe(0);
    expect(queue.retainedCodeUnits()).toBe(16);
    queue.close();
    expect(await queue.collect()).toEqual([phasedText("abcdef", "commentary")]);
    expect(queue.retainedCodeUnits()).toBe(0);
  });

  test("an event handed straight to a waiting consumer is never charged or capped", async () => {
    let backlogExceeded = 0;
    const queue = createAdapterEventQueue({
      maxBacklogCodeUnits: 4,
      maxEventCodeUnits: 4,
      onBacklogExceeded: () => { backlogExceeded += 1; },
    });
    const iterator = queue.stream()[Symbol.asyncIterator]();

    const pending = iterator.next();
    queue.push(text("x".repeat(1_000)));

    // The queue never held it, so neither budget has anything to say about it:
    // both govern retained payload, and refusing this would abort a turn over
    // memory the queue does not own.
    expect(await pending).toEqual({ done: false, value: text("x".repeat(1_000)) });
    expect(backlogExceeded).toBe(0);
    expect(queue.retainedCodeUnits()).toBe(0);
    queue.close();
  });

  test("a long synchronous burst well past one mebibyte still completes", async () => {
    let backlogExceeded = 0;
    const queue = createAdapterEventQueue({
      onBacklogExceeded: () => { backlogExceeded += 1; },
    });

    // A synchronous producer legally fills the queue before its consumer is
    // scheduled — the image loop does this with over a million one-character
    // deltas, which coalesce into more than a mebibyte of retained text. A
    // retained budget sized near that burst aborts healthy turns, so the
    // default has to sit well above it.
    const chunk = "x".repeat(64);
    for (let i = 0; i < 20_000; i++) queue.push(text(chunk));
    queue.close();

    const collected = await queue.collect();
    expect(backlogExceeded).toBe(0);
    expect(collected.map(event => (event.type === "text_delta" ? event.text.length : 0))
      .reduce((sum, length) => sum + length, 0)).toBe(20_000 * 64);
    expect(collected.every(event => event.type === "text_delta")).toBe(true);
    expect(queue.retainedCodeUnits()).toBe(0);
  });

  test("draining after an abort releases exactly what was charged", async () => {
    const queue = createAdapterEventQueue({ maxBacklogCodeUnits: 8, maxEventCodeUnits: 8 });

    queue.push(toolStart("0"));
    expect(queue.retainedCodeUnits()).toBeGreaterThan(0);
    queue.push(toolStart("1"));

    // The terminal record is admitted past the budget it reports, and is then
    // charged and released like any other item, so the counter lands on zero
    // rather than on the size of an explanation nobody paid for.
    const iterator = queue.stream()[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: toolStart("0") });
    expect(await iterator.next()).toEqual({ done: false, value: { type: "error", message: BACKLOG_EXCEEDED } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(queue.retainedCodeUnits()).toBe(0);
  });

  test("a cancel race leaves nothing charged behind", async () => {
    const queue = createAdapterEventQueue({ maxBacklogCodeUnits: 64 });
    const iterator = queue.stream()[Symbol.asyncIterator]();

    queue.push(text("abcd"));
    queue.push(thinking("wxyz"));
    expect(await iterator.next()).toEqual({ done: false, value: text("abcd") });

    // The consumer walks away mid-stream and the turn is closed underneath it.
    await iterator.return?.();
    queue.close();
    queue.push(text("after close"));

    // What is still queued is still charged — and nothing more, so a second
    // drain returns the counter to zero without a phantom balance.
    expect(queue.retainedCodeUnits()).toBe(4);
    expect(await queue.collect()).toEqual([thinking("wxyz")]);
    expect(queue.retainedCodeUnits()).toBe(0);
  });

  test("the retention measure counts payload strings and skips the discriminant", () => {
    expect(retainedEventCodeUnits(text("abcd"))).toBe(4);
    expect(retainedEventCodeUnits(heartbeat)).toBe(0);
    expect(retainedEventCodeUnits(phasedText("ab", "commentary"))).toBe(12);
    // A malformed adapter emission has to become a terminal event, not a
    // TypeError thrown out of push() with the queue half-updated.
    expect(retainedEventCodeUnits(null as unknown as AdapterEvent)).toBe(0);
    expect(retainedEventCodeUnits("oops" as unknown as AdapterEvent)).toBe(0);
    // Nested provider-shaped payload is counted; a cycle terminates.
    const cyclic: Record<string, unknown> = { owner: "abc" };
    cyclic.self = cyclic;
    expect(retainedEventCodeUnits({ type: "done", providerState: cyclic } as unknown as AdapterEvent)).toBe(3);
  });

  test("both budgets must be positive safe integers", () => {
    const invalid = [Number.NaN, Number.POSITIVE_INFINITY, 0, -4, 2.5, Number.MAX_SAFE_INTEGER + 1];
    for (const value of invalid) {
      expect(() => createAdapterEventQueue({ maxBacklogCodeUnits: value }))
        .toThrow("maxBacklogCodeUnits must be a positive safe integer");
      expect(() => createAdapterEventQueue({ maxEventCodeUnits: value }))
        .toThrow("maxEventCodeUnits must be a positive safe integer");
    }
    expect(DEFAULT_MAX_EVENT_CODE_UNITS).toBeLessThan(DEFAULT_MAX_BACKLOG_CODE_UNITS);
  });
});
