import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../src/adapters/anthropic";
import { buildResponseJSON } from "../src/bridge";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createAnthropicAdapter = (...args: Parameters<typeof createAnthropicAdapterProduction>) =>
  withTestTranslatorBudget(createAnthropicAdapterProduction(...args));

const provider: OcxProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "test-key",
};

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
