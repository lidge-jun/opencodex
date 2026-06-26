import { describe, expect, test } from "bun:test";
import { createAdapterEventQueue } from "../src/adapters/run-turn-queue";
import type { AdapterEvent } from "../src/types";

const text = (value: string): AdapterEvent => ({ type: "text_delta", text: value });

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
});
