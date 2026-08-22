import { describe, expect, test } from "bun:test";
import {
  EMPTY_COMPLETION_RETRY_ENV,
  EMPTY_COMPLETION_RETRY_FAILED_CODE,
  emptyCompletionRetryEnabled,
  guardEmptyCompletionEventStream,
  isContentEvent,
} from "../src/server/responses/empty-completion-guard";
import type { AdapterEvent } from "../src/types";

function collect(source: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  return (async () => {
    for await (const event of source) events.push(event);
    return events;
  })();
}

function eventsOf(...items: AdapterEvent[]): AsyncIterable<AdapterEvent> {
  return (async function* () { yield* items; })();
}

function withoutHeartbeats(events: AdapterEvent[]): AdapterEvent[] {
  return events.filter(event => event.type !== "heartbeat");
}

describe("empty-completion guard content classification", () => {
  test("output text is content", () => {
    expect(isContentEvent({ type: "text_delta", text: "hello" })).toBe(true);
  });

  test("tool calls are content", () => {
    expect(isContentEvent({ type: "tool_call_start", id: "c1", name: "run" })).toBe(true);
    expect(isContentEvent({ type: "tool_call_delta", arguments: "{}" })).toBe(true);
    expect(isContentEvent({ type: "tool_call_end" })).toBe(true);
    expect(isContentEvent({ type: "web_search_call_begin", id: "w1" })).toBe(true);
    expect(isContentEvent({ type: "web_search_call_end", id: "w1", queries: [] })).toBe(true);
  });

  test("reasoning alone is NOT content", () => {
    expect(isContentEvent({ type: "thinking_delta", thinking: "let me think" })).toBe(false);
    expect(isContentEvent({ type: "thinking_signature", signature: "sig" })).toBe(false);
    expect(isContentEvent({ type: "redacted_thinking", data: "blob" })).toBe(false);
    expect(isContentEvent({ type: "reasoning_raw_delta", text: "raw" })).toBe(false);
  });

  test("empty text deltas are not content", () => {
    expect(isContentEvent({ type: "text_delta", text: "" })).toBe(false);
  });

  test("heartbeats and internal boundaries are not content", () => {
    expect(isContentEvent({ type: "heartbeat" })).toBe(false);
    expect(isContentEvent({ type: "assistant_boundary" })).toBe(false);
  });
});

describe("empty-completion guard kill switch", () => {
  test("requires top-level config opt-in and lets OCX_EMPTY_COMPLETION_RETRY=0 disable it", () => {
    expect(emptyCompletionRetryEnabled({}, {})).toBe(false);
    expect(emptyCompletionRetryEnabled({}, { [EMPTY_COMPLETION_RETRY_ENV]: "1" })).toBe(false);
    expect(emptyCompletionRetryEnabled({ emptyCompletionRetry: true }, {})).toBe(true);
    expect(emptyCompletionRetryEnabled(
      { emptyCompletionRetry: true },
      { [EMPTY_COMPLETION_RETRY_ENV]: "0" },
    )).toBe(false);
  });
});

describe("empty-completion guard retry", () => {
  test("buffers pre-content events and releases them on first content", async () => {
    let continuations = 0;
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "thinking_delta", thinking: "thinking..." },
        { type: "text_delta", text: "answer" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 2 } },
      ),
      continuation: () => {
        continuations += 1;
        return eventsOf();
      },
    }));

    expect(continuations).toBe(0);
    expect(withoutHeartbeats(events)).toEqual([
      { type: "thinking_delta", thinking: "thinking..." },
      { type: "text_delta", text: "answer" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 2 } },
    ]);
  });

  test("a reasoning-only terminal turn is retried once and the identical-turn retry succeeds", async () => {
    let continuations = 0;
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "thinking_delta", thinking: "first attempt" },
        { type: "reasoning_raw_delta", text: "raw" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 0 } },
      ),
      continuation: () => {
        continuations += 1;
        return eventsOf(
          { type: "thinking_delta", thinking: "second attempt" },
          { type: "text_delta", text: "finally an answer" },
          { type: "done", usage: { inputTokens: 20, outputTokens: 5 } },
        );
      },
    }));

    expect(continuations).toBe(1);
    // The first attempt's buffered reasoning is released in order, then the
    // retry's reasoning, then the content, then the merged-usage terminal.
    expect(withoutHeartbeats(events)).toEqual([
      { type: "thinking_delta", thinking: "first attempt" },
      { type: "reasoning_raw_delta", text: "raw" },
      { type: "thinking_delta", thinking: "second attempt" },
      { type: "text_delta", text: "finally an answer" },
      { type: "done", usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 } },
    ]);
  });

  test("usage is merged across attempts", async () => {
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "thinking_delta", thinking: "..." },
        { type: "done", usage: { inputTokens: 100, outputTokens: 0, cachedInputTokens: 40 } },
      ),
      continuation: () => eventsOf(
        { type: "tool_call_start", id: "c1", name: "run" },
        { type: "tool_call_delta", arguments: "{}" },
        { type: "tool_call_end" },
        { type: "done", usage: { inputTokens: 200, outputTokens: 30, reasoningOutputTokens: 12 } },
      ),
    }));

    const done = events.at(-1) as Extract<AdapterEvent, { type: "done" }>;
    expect(done.usage).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      totalTokens: 330,
      cachedInputTokens: 40,
      reasoningOutputTokens: 12,
    });
  });

  test("both attempts empty surfaces empty_completion_retry_failed", async () => {
    let continuations = 0;
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "thinking_delta", thinking: "first" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 0 } },
      ),
      continuation: () => {
        continuations += 1;
        return eventsOf(
          { type: "thinking_delta", thinking: "second" },
          { type: "done", usage: { inputTokens: 12, outputTokens: 0 } },
        );
      },
    }));

    expect(continuations).toBe(1);
    const meaningful = withoutHeartbeats(events);
    expect(meaningful).toHaveLength(1);
    expect(meaningful[0]).toMatchObject({
      type: "error",
      status: 502,
      errorType: "upstream_error",
      code: EMPTY_COMPLETION_RETRY_FAILED_CODE,
      usage: { inputTokens: 22, outputTokens: 0, totalTokens: 22 },
    });
    // The silent completed event never reaches the client.
    expect(meaningful.some(event => event.type === "done")).toBe(false);
  });

  test("a failed retry surfaces empty_completion_retry_failed", async () => {
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "thinking_delta", thinking: "first" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 0 } },
      ),
      continuation: () => eventsOf(
        { type: "error", status: 502, message: "upstream died", usage: { inputTokens: 8, outputTokens: 0 } },
      ),
    }));

    const meaningful = withoutHeartbeats(events);
    expect(meaningful).toHaveLength(1);
    expect(meaningful[0]).toMatchObject({
      type: "error",
      status: 502,
      errorType: "upstream_error",
      code: EMPTY_COMPLETION_RETRY_FAILED_CODE,
      usage: { inputTokens: 18, outputTokens: 0, totalTokens: 18 },
    });
  });

  test("a continuation that throws surfaces empty_completion_retry_failed", async () => {
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf({ type: "done" }),
      continuation: () => {
        throw new Error("continuation exploded");
      },
    }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      code: EMPTY_COMPLETION_RETRY_FAILED_CODE,
    });
  });

  test("max_tokens completions pass through without retrying", async () => {
    let continuations = 0;
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "thinking_delta", thinking: "..." },
        { type: "done", stopReason: "max_tokens", usage: { inputTokens: 5, outputTokens: 1 } },
      ),
      continuation: () => {
        continuations += 1;
        return eventsOf();
      },
    }));

    expect(continuations).toBe(0);
    expect(withoutHeartbeats(events)).toEqual([
      { type: "thinking_delta", thinking: "..." },
      { type: "done", stopReason: "max_tokens", usage: { inputTokens: 5, outputTokens: 1 } },
    ]);
  });

  test("a tool-call-only turn is content and is not retried", async () => {
    let continuations = 0;
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "tool_call_start", id: "c1", name: "exec_command" },
        { type: "tool_call_delta", arguments: "{}" },
        { type: "tool_call_end" },
        { type: "done" },
      ),
      continuation: () => {
        continuations += 1;
        return eventsOf();
      },
    }));

    expect(continuations).toBe(0);
    expect(events.map(event => event.type)).toEqual([
      "tool_call_start", "tool_call_delta", "tool_call_end", "done",
    ]);
  });

  test("first-attempt errors and incompletes pass through untouched", async () => {
    let continuations = 0;
    const incomplete = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "thinking_delta", thinking: "..." },
        { type: "incomplete", reason: "content_filter", retryable: false },
      ),
      continuation: () => {
        continuations += 1;
        return eventsOf();
      },
    }));
    expect(continuations).toBe(0);
    expect(withoutHeartbeats(incomplete)).toEqual([
      { type: "thinking_delta", thinking: "..." },
      { type: "incomplete", reason: "content_filter", retryable: false },
    ]);

    const error = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "error", status: 401, message: "bad key" },
      ),
      continuation: () => {
        continuations += 1;
        return eventsOf();
      },
    }));
    expect(continuations).toBe(0);
    expect(error).toEqual([{ type: "error", status: 401, message: "bad key" }]);
  });

  test("maxRetries 0 (kill-switch behavior) surfaces the failure immediately", async () => {
    let continuations = 0;
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "thinking_delta", thinking: "..." },
        { type: "done" },
      ),
      maxRetries: 0,
      continuation: () => {
        continuations += 1;
        return eventsOf();
      },
    }));

    expect(continuations).toBe(0);
    const meaningful = withoutHeartbeats(events);
    expect(meaningful).toHaveLength(1);
    expect(meaningful[0]).toMatchObject({ type: "error", code: EMPTY_COMPLETION_RETRY_FAILED_CODE });
  });

  test("heartbeats pass through immediately even before content", async () => {
    let continuations = 0;
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf(
        { type: "heartbeat" },
        { type: "thinking_delta", thinking: "..." },
        { type: "done" },
      ),
      continuation: () => {
        continuations += 1;
        return eventsOf({ type: "text_delta", text: "ok" }, { type: "done" });
      },
    }));

    expect(continuations).toBe(1);
    expect(events.map(event => event.type)).toEqual([
      "heartbeat", "heartbeat", "thinking_delta", "text_delta", "done",
    ]);
  });

  test("a truncated first source (no terminal) releases held events and ends", async () => {
    let continuations = 0;
    const events = await collect(guardEmptyCompletionEventStream({
      firstEvents: eventsOf({ type: "thinking_delta", thinking: "..." }),
      continuation: () => {
        continuations += 1;
        return eventsOf();
      },
    }));

    expect(continuations).toBe(0);
    expect(withoutHeartbeats(events)).toEqual([{ type: "thinking_delta", thinking: "..." }]);
  });
});
