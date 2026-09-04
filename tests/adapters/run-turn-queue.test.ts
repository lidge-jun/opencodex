import { describe, expect, test } from "bun:test";
import { COALESCE_MAX_CHUNK_LENGTH, createAdapterEventQueue, PREFLIGHT_HEARTBEAT_RETAIN_LIMIT, preflightAdapterEvents } from "../../src/adapters/run-turn-queue";
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
