import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { bridgeToResponsesSSE } from "../src/bridge";
import { responsesSseToAnthropicSse } from "../src/claude/outbound";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";

const provider = {
  adapter: "anthropic",
  baseUrl: "https://api.kimi.com/coding",
  apiKey: "test-key",
  authMode: "key",
} as OcxProviderConfig;

const kimiCompatibleSse = [
  'event: message_start\ndata: {"type":"message_start","message":{}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"reasoning","reasoning":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"reasoning_delta","reasoning":"think"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"visible"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
  // Deliberately no usage snapshot and no newline after the terminal data line.
  'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n");

function arbitrarilyChunkedResponse(text = kimiCompatibleSse): Response {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const cuts = [3, 19, 47, 101, 173, 251, 337, 419, bytes.length];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      for (const end of cuts) {
        if (end <= offset) continue;
        controller.enqueue(bytes.slice(offset, Math.min(end, bytes.length)));
        offset = end;
        if (offset >= bytes.length) break;
      }
      controller.close();
    },
  }));
}

async function collectAdapterEvents(response: Response): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of createAnthropicAdapter(provider).parseStream(response)) events.push(event);
  return events;
}

function liveCommentResponse(intervalMs: number): { response: Response; stop: () => void } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    try { controller?.close(); } catch { /* already closed */ }
  };
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      streamController.enqueue(encoder.encode(": keepalive\n\n"));
      timer = setInterval(() => {
        try { streamController.enqueue(encoder.encode(": keepalive\n\n")); } catch { stop(); }
      }, intervalMs);
    },
    cancel: stop,
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    stop,
  };
}

describe("Anthropic-compatible reasoning stream termination (#312)", () => {
  test("comment-only stream records become adapter heartbeat events", async () => {
    const events = await collectAdapterEvents(new Response(
      ": keepalive\n\n: still-alive\n\n",
      { headers: { "content-type": "text/event-stream" } },
    ));

    expect(events.slice(0, 2)).toEqual([{ type: "heartbeat" }, { type: "heartbeat" }]);
  });

  test("comment-only live upstream does not trip the bridge stall watchdog", async () => {
    const upstream = liveCommentResponse(25);
    const stream = bridgeToResponsesSSE(
      createAnthropicAdapter(provider).parseStream(upstream.response),
      "kimi/k3",
      undefined,
      undefined,
      undefined,
      upstream.stop,
      50,
      { stallTimeoutSec: 1 },
    );
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const probeElapsed = new Promise<null>(resolve => setTimeout(() => resolve(null), 1_200));

    while (true) {
      const result = await Promise.race([reader.read(), probeElapsed]);
      if (result === null) break;
      if (result.done) break;
      if (result.value) text += decoder.decode(result.value, { stream: true });
      if (text.includes("upstream_stall_timeout")) break;
    }

    await reader.cancel();
    upstream.stop();
    expect(text).not.toContain("upstream_stall_timeout");
    expect(text).not.toContain("response.incomplete");
  });

  test("preserves reasoning and visible text, then emits done from final message_stop", async () => {
    const events = await collectAdapterEvents(arbitrarilyChunkedResponse());

    expect(events).toContainEqual({ type: "thinking_delta", thinking: "think" });
    expect(events).toContainEqual({ type: "text_delta", text: "visible" });
    expect(events.at(-1)).toEqual({ type: "done", usage: undefined });
  });

  test("Responses bridge completes instead of reporting adapter_eof", async () => {
    const responses = bridgeToResponsesSSE(
      createAnthropicAdapter(provider).parseStream(arbitrarilyChunkedResponse()),
      "kimi/k3",
      undefined,
      undefined,
      undefined,
      undefined,
      0,
    );
    const text = await new Response(responses).text();

    expect(text).toContain("response.reasoning_summary_text.delta");
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");
    expect(text).not.toContain("response.incomplete");
    expect(text).toContain("visible");
  });

  test("Claude Messages translation keeps content blocks and message_stop", async () => {
    const responses = bridgeToResponsesSSE(
      createAnthropicAdapter(provider).parseStream(arbitrarilyChunkedResponse()),
      "kimi/k3",
      undefined,
      undefined,
      undefined,
      undefined,
      0,
    );
    const anthropic = responsesSseToAnthropicSse(responses, "k3", { pingIntervalMs: 0 });
    const text = await new Response(anthropic).text();

    expect(text).toContain('"type":"thinking_delta","thinking":"think"');
    expect(text).toContain('"type":"text_delta","text":"visible"');
    expect(text).toContain("event: message_stop");
  });

  test("message_start followed by clean EOF fails closed before message_stop", async () => {
    const events = await collectAdapterEvents(arbitrarilyChunkedResponse(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n',
    ));

    expect(events.at(-1)).toEqual({
      type: "error",
      message: "upstream stream ended before message_stop — possible truncation",
    });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("compatible provider can omit message_stop after reporting max_tokens", async () => {
    const events = await collectAdapterEvents(arbitrarilyChunkedResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":3}}',
    ].join("\n\n")));

    expect(events.at(-1)).toEqual({
      type: "done",
      usage: { inputTokens: 2, outputTokens: 3 },
      stopReason: "max_tokens",
    });
    expect(events.some(event => event.type === "error")).toBe(false);
  });

  test("compatible provider EOF maps refusal to content_filter locally", async () => {
    const events = await collectAdapterEvents(arbitrarilyChunkedResponse(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}',
    ));

    expect(events.at(-1)).toEqual({
      type: "done",
      usage: undefined,
      stopReason: "content_filter",
    });
  });

  test("non-streaming compatible reasoning blocks map without hiding later text", async () => {
    const events = await createAnthropicAdapter(provider).parseResponse(new Response(JSON.stringify({
      content: [
        { type: "reasoning", reasoning: "think" },
        { type: "text", text: "visible" },
      ],
      usage: { input_tokens: 2, output_tokens: 3 },
      stop_reason: "end_turn",
    })));

    expect(events).toEqual([
      { type: "thinking_delta", thinking: "think" },
      { type: "text_delta", text: "visible" },
      { type: "done", usage: { inputTokens: 2, outputTokens: 3 }, stopReason: "end_turn" },
    ]);
  });
});
