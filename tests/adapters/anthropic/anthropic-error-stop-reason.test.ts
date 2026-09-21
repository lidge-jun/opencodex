import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../../../src/adapters/anthropic";
import { buildResponseJSON } from "../../../src/bridge";
import type { AdapterEvent, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const createAnthropicAdapter = (...args: Parameters<typeof createAnthropicAdapterProduction>) =>
  withTestTranslatorBudget(createAnthropicAdapterProduction(...args));

const provider: OcxProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "test-key",
};

describe("Anthropic usage numeric boundary", () => {
  test("preserves empty usage and absent usage as distinct states", async () => {
    for (const usage of [{}, undefined]) {
      const events = await createAnthropicAdapter(provider).parseResponse!(Response.json({
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", ...(usage ? { usage } : {}),
      })) as AdapterEvent[];
      const done = events.find(event => event.type === "done");
      expect(done && "usage" in done ? done.usage : undefined)
        .toEqual(usage ? { inputTokens: 0, outputTokens: 0 } : undefined);
    }
  });

  test("preserves inclusive cache input and cumulative streaming output", async () => {
    const frames = [
      { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
    const events: AdapterEvent[] = [];
    for await (const event of createAnthropicAdapter(provider).parseStream(new Response(frames))) events.push(event);
    const done = events.find(event => event.type === "done");
    expect(done && "usage" in done ? done.usage : undefined).toEqual({
      inputTokens: 15, outputTokens: 4, cachedInputTokens: 3, cacheReadInputTokens: 3, cacheCreationInputTokens: 2,
    });
  });

  test.each(["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])(
    "does not emit malformed %s as reported usage", async key => {
      for (const invalid of ["\x1b[2J", "42", null, -1, true, {}, []]) {
        const response = Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 4, [key]: invalid } });
        const events = await createAnthropicAdapter(provider).parseResponse!(response) as AdapterEvent[];
        const done = events.find(event => event.type === "done");
        expect(done).toBeDefined();
        expect(done && "usage" in done ? done.usage : undefined).toBeUndefined();
      }
    },
  );

  test("rejects an overflowing inclusive input total", async () => {
    const response = Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      usage: { input_tokens: Number.MAX_VALUE, cache_read_input_tokens: Number.MAX_VALUE, output_tokens: 4 } });
    const events = await createAnthropicAdapter(provider).parseResponse!(response) as AdapterEvent[];
    const done = events.find(event => event.type === "done");
    expect(done && "usage" in done ? done.usage : undefined).toBeUndefined();
  });

  test("streaming rejects a malformed cumulative update without changing content", async () => {
    const frames = [
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: "\x1b[2J" } },
      { type: "message_stop" },
    ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
    const events: AdapterEvent[] = [];
    for await (const event of createAnthropicAdapter(provider).parseStream(new Response(frames))) events.push(event);
    const done = events.find(event => event.type === "done");
    expect(done).toBeDefined();
    expect(done && "usage" in done ? done.usage : undefined).toBeUndefined();
    expect(JSON.stringify(buildResponseJSON(events, "anthropic/claude-test"))).toContain("ok");
  });
});

/**
 * These drive the REAL adapter parsers. An earlier version of this suite constructed the
 * downstream error event by hand, so it stayed green while the adapter itself still emitted a
 * clean `done` — the gap an audit caught.
 */
describe("an upstream error stop_reason is a failure, not a stop", () => {
  test("buffered: stop_reason error yields an error event carrying usage", async () => {
    const adapter = createAnthropicAdapter(provider);
    const body = JSON.stringify({
      content: [{ type: "text", text: "partial" }],
      stop_reason: "error",
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    const events = await adapter.parseResponse!(new Response(body, { status: 200 })) as AdapterEvent[];

    const error = events.find(e => e.type === "error") as { usage?: { inputTokens?: number } } | undefined;
    expect(error).toBeDefined();
    expect(events.some(e => e.type === "done")).toBe(false);
    // A failed turn still consumed tokens; dropping usage makes it look free in accounting.
    expect(error?.usage?.inputTokens).toBe(10);
  });

  test("streaming: stop_reason error yields an error event carrying usage", async () => {
    const adapter = createAnthropicAdapter(provider);
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"error"},"usage":{"output_tokens":4}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const events: AdapterEvent[] = [];
    for await (const e of adapter.parseStream(new Response(frames, {
      status: 200, headers: { "content-type": "text/event-stream" },
    }))) events.push(e);

    const error = events.find(e => e.type === "error") as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined;
    expect(error).toBeDefined();
    expect(events.some(e => e.type === "done")).toBe(false);
    // Assert the usage this test is named for: without it the title was a claim the test
    // never checked, and removing usage would have kept it green.
    expect(error?.usage?.inputTokens).toBe(10);
    expect(error?.usage?.outputTokens).toBe(4);
  });

  test("streaming EOF without message_stop also fails, and keeps usage", async () => {
    // A compatible provider may close after message_delta without message_stop. That branch
    // bypasses emitDone entirely, so it needs its own check — an audit found it still
    // reporting success while the two other terminal paths were fixed.
    const adapter = createAnthropicAdapter(provider);
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"error"},"usage":{"output_tokens":4}}\n\n',
      // no message_stop: the stream just ends
    ].join('');
    const events: AdapterEvent[] = [];
    for await (const e of adapter.parseStream(new Response(frames, {
      status: 200, headers: { "content-type": "text/event-stream" },
    }))) events.push(e);

    const error = events.find(e => e.type === "error") as { usage?: { inputTokens?: number } } | undefined;
    expect(error).toBeDefined();
    expect(events.some(e => e.type === "done")).toBe(false);
    expect(error?.usage?.inputTokens).toBe(10);

    const json = buildResponseJSON(events, "anthropic/claude-opus-5", { compaction: true });
    expect(json.status).toBe("failed");
    expect((json.output as { type: string }[]).some(o => o.type === "compaction")).toBe(false);
  });

  test("a turn that failed upstream installs no compaction history", async () => {
    const adapter = createAnthropicAdapter(provider);
    const body = JSON.stringify({
      content: [{ type: "text", text: "half a summary" }],
      stop_reason: "error",
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    const events = await adapter.parseResponse!(new Response(body, { status: 200 })) as AdapterEvent[];
    const json = buildResponseJSON(events, "anthropic/claude-opus-5", { compaction: true });

    expect(json.status).toBe("failed");
    expect((json.output as { type: string }[]).some(o => o.type === "compaction")).toBe(false);
  });

  test("an ordinary stop_reason still completes normally", async () => {
    const adapter = createAnthropicAdapter(provider);
    const body = JSON.stringify({
      content: [{ type: "text", text: "a whole answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    const events = await adapter.parseResponse!(new Response(body, { status: 200 })) as AdapterEvent[];

    expect(events.some(e => e.type === "done")).toBe(true);
    expect(events.some(e => e.type === "error")).toBe(false);
  });
});

/**
 * A content-filter terminal used to leave the adapter as `done` with stopReason
 * `content_filter`. The bridge then emitted `response.incomplete` without
 * `retryable`, and Codex retried the same refusal five times (#4312).
 */
describe("an upstream content_filter stop_reason is a non-retryable incomplete", () => {
  const filteredStops = ["refusal", "content_filter"] as const;

  function streamFrames(stopReason: string, includeMessageStop: boolean): string {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"},"usage":{"output_tokens":4}}\n\n`,
    ];
    if (includeMessageStop) frames.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    return frames.join("");
  }

  async function collectStream(frames: string): Promise<AdapterEvent[]> {
    const events: AdapterEvent[] = [];
    for await (const e of createAnthropicAdapter(provider).parseStream(new Response(frames, {
      status: 200, headers: { "content-type": "text/event-stream" },
    }))) events.push(e);
    return events;
  }

  function expectFilteredIncomplete(events: AdapterEvent[], stopReason: string): void {
    expect(events.filter(e => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "partial" }]);
    const terminals = events.filter(e => e.type === "done" || e.type === "error" || e.type === "incomplete");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      type: "incomplete",
      reason: "content_filter",
      retryable: false,
      message: `upstream ended the turn with stop_reason "${stopReason}"`,
      usage: { inputTokens: 10, outputTokens: 4 },
    });
  }

  test.each(filteredStops)("streaming: stop_reason %s yields one incomplete with retryable false", async (stopReason) => {
    expectFilteredIncomplete(await collectStream(streamFrames(stopReason, true)), stopReason);
  });

  test.each(filteredStops)("streaming EOF without message_stop: stop_reason %s stays non-retryable", async (stopReason) => {
    // Compatible providers may close after message_delta. That branch bypasses emitDone,
    // so a missing check here would still emit `done` and Codex would retry.
    expectFilteredIncomplete(await collectStream(streamFrames(stopReason, false)), stopReason);
  });

  test.each(filteredStops)("buffered: stop_reason %s yields one incomplete with retryable false", async (stopReason) => {
    const events = await createAnthropicAdapter(provider).parseResponse!(new Response(JSON.stringify({
      content: [{ type: "text", text: "partial" }],
      stop_reason: stopReason,
      usage: { input_tokens: 10, output_tokens: 4 },
    }), { status: 200 })) as AdapterEvent[];
    expectFilteredIncomplete(events, stopReason);
  });

  test("streaming: max_tokens still completes as done", async () => {
    const events = await collectStream(streamFrames("max_tokens", true));
    expect(events.filter(e => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "partial" }]);
    expect(events.filter(e => e.type === "incomplete" || e.type === "error")).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens" });
  });
});
