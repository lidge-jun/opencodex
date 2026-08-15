import { describe, expect, test } from "bun:test";
import {
  EMPTY_COMPLETION_MAX_BUFFERED_BYTES,
  EMPTY_COMPLETION_MAX_BUFFERED_EVENTS,
  guardEmptyCompletionEventStream,
} from "../src/server/responses/empty-completion-guard";
import type { AdapterEvent } from "../src/types";

async function collect(source: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function eventsOf(...items: AdapterEvent[]): AsyncIterable<AdapterEvent> {
  return (async function* () { yield* items; })();
}

describe("empty-completion guard hardening", () => {
  test("usage keeps the retry's absolute context checkpoint without summing it", async () => {
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "done", usage: { inputTokens: 10, outputTokens: 0, contextTotalTokens: 1_000 } },
      ),
      continuation: () => eventsOf(
        { type: "text_delta", text: "answer" },
        { type: "done", usage: { inputTokens: 12, outputTokens: 2, contextTotalTokens: 1_014 } },
      ),
    }));

    expect(events.at(-1)).toMatchObject({
      type: "done",
      usage: { inputTokens: 22, outputTokens: 2, totalTokens: 24, contextTotalTokens: 1_014 },
    });
  });

  test("inherited Object prototype stop-reason names do not bypass retry", async () => {
    for (const stopReason of ["constructor", "toString"]) {
      let continuations = 0;
      await collect(guardEmptyCompletionEventStream({
        firstEvents: eventsOf({ type: "done", stopReason }),
        continuation: () => {
          continuations += 1;
          return eventsOf({ type: "text_delta", text: "ok" }, { type: "done" });
        },
      }));
      expect(continuations).toBe(1);
    }
  });

  test("buffered reasoning emits liveness heartbeats until content is released", async () => {
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "thinking_delta", thinking: "one" },
        { type: "reasoning_raw_delta", text: "two" },
        { type: "text_delta", text: "answer" },
        { type: "done" },
      ),
      continuation: () => eventsOf(),
    }));

    expect(events.map(event => event.type)).toEqual([
      "heartbeat",
      "heartbeat",
      "thinking_delta",
      "reasoning_raw_delta",
      "text_delta",
      "done",
    ]);
  });

  test("event-count overflow releases the prefix and disables retry for the turn", async () => {
    let continuations = 0;
    const reasoning = Array.from({ length: EMPTY_COMPLETION_MAX_BUFFERED_EVENTS + 1 }, (_, index) => ({
      type: "thinking_delta" as const,
      thinking: `r${index}`,
    }));
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(...reasoning, { type: "done" }),
      continuation: () => {
        continuations += 1;
        return eventsOf();
      },
    }));

    expect(continuations).toBe(0);
    expect(events.filter(event => event.type === "thinking_delta")).toHaveLength(reasoning.length);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("byte overflow remains bounded across the retry attempt", async () => {
    let continuations = 0;
    const firstBytes = "a".repeat(Math.floor(EMPTY_COMPLETION_MAX_BUFFERED_BYTES / 2));
    const retryBytes = "b".repeat(Math.floor(EMPTY_COMPLETION_MAX_BUFFERED_BYTES / 2) + 1_024);
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "thinking_delta", thinking: firstBytes },
        { type: "done", usage: { inputTokens: 3, outputTokens: 0 } },
      ),
      continuation: () => {
        continuations += 1;
        return eventsOf(
          { type: "reasoning_raw_delta", text: retryBytes },
          { type: "done", usage: { inputTokens: 4, outputTokens: 0 } },
        );
      },
    }));

    expect(continuations).toBe(1);
    expect(events.filter(event => event.type === "thinking_delta")).toHaveLength(1);
    expect(events.filter(event => event.type === "reasoning_raw_delta")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 },
    });
  });

  test("post-retry errors and incompletes after content keep usage from both attempts", async () => {
    const retryTerminal = async (terminal: AdapterEvent) => collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf({ type: "done", usage: { inputTokens: 5, outputTokens: 0 } }),
      continuation: () => eventsOf(
        { type: "text_delta", text: "partial" },
        terminal,
      ),
    }));

    const error = await retryTerminal({
      type: "error",
      status: 499,
      message: "client closed",
      usage: { inputTokens: 7, outputTokens: 2 },
    });
    expect(error.at(-1)).toMatchObject({
      type: "error",
      status: 499,
      usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
    });

    const incomplete = await retryTerminal({
      type: "incomplete",
      reason: "upstream_stall_timeout",
      usage: { inputTokens: 9, outputTokens: 3 },
    });
    expect(incomplete.at(-1)).toMatchObject({
      type: "incomplete",
      usage: { inputTokens: 14, outputTokens: 3, totalTokens: 17 },
    });
  });
});
