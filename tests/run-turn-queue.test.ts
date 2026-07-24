import { describe, expect, test } from "bun:test";
import { createAdapterEventQueue, preflightAdapterEvents } from "../src/adapters/run-turn-queue";
import type { AdapterEvent } from "../src/types";

const text = (value: string): AdapterEvent => ({ type: "text_delta", text: value });
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

    queue.push(text("a"));
    queue.push(text("b"));
    queue.close();

    expect(await queue.collect()).toEqual([text("a"), text("b")]);
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

  test("aborts and closes with a terminal error when the default backlog cap is exceeded", async () => {
    let backlogExceeded = 0;
    const queue = createAdapterEventQueue({
      onBacklogExceeded: () => { backlogExceeded += 1; },
    });

    for (let i = 0; i <= 1_024; i++) queue.push(text(String(i)));
    queue.push(text("ignored after overflow"));

    const collected = await queue.collect();
    expect(backlogExceeded).toBe(1);
    expect(collected).toHaveLength(1_025);
    expect(collected.slice(0, 1_024)).toEqual(
      Array.from({ length: 1_024 }, (_, i) => text(String(i))),
    );
    expect(collected.at(-1)).toEqual({
      type: "error",
      message: "consumer backlog exceeded — turn aborted",
    });
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
