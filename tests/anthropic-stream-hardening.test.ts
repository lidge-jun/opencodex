import { describe, expect, test } from "bun:test";
import { anthropicMessagesUrl, createAnthropicAdapter } from "../src/adapters/anthropic";
import type { AdapterEvent } from "../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://example.test", apiKey: "key" };

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("anthropicMessagesUrl", () => {
  test.each([
    ["https://example.test", "https://example.test/v1/messages"],
    ["https://example.test/", "https://example.test/v1/messages"],
    ["https://example.test/v1", "https://example.test/v1/messages"],
    ["https://example.test/v1/", "https://example.test/v1/messages"],
    ["https://example.test/v1/messages", "https://example.test/v1/messages"],
    ["https://example.test/v1/messages/", "https://example.test/v1/messages"],
  ] as const)("normalizes %s", (input, expected) => {
    expect(anthropicMessagesUrl(input)).toBe(expected);
  });
});

describe("anthropic stream hardening", () => {
  test("EOF after content without message_stop fails closed", async () => {
    const response = new Response([
      "event: content_block_start\n",
      'data: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
    ].join(""));
    const events = await collect(createAnthropicAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("input_json_delta outside tool_use is ignored", async () => {
    const response = new Response([
      "event: content_block_start\n",
      'data: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}\n\n',
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""));
    const events = await collect(createAnthropicAdapter(provider).parseStream(response));
    expect(events.some(e => e.type === "tool_call_delta")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("tool_use without id synthesizes a toolu_ id", async () => {
    const response = new Response([
      "event: content_block_start\n",
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"get_weather"}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      "event: content_block_stop\n",
      'data: {"type":"content_block_stop"}\n\n',
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""));
    const events = await collect(createAnthropicAdapter(provider).parseStream(response));
    const start = events.find(e => e.type === "tool_call_start");
    expect(start).toMatchObject({ type: "tool_call_start", name: "get_weather" });
    expect(start && "id" in start && start.id.startsWith("toolu_")).toBe(true);
  });

  test("empty EOF without content still errors", async () => {
    const response = new Response("");
    const events = await collect(createAnthropicAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });
});

describe("anthropic non-stream tool_use input", () => {
  test("parses string tool_use.input", async () => {
    const adapter = createAnthropicAdapter(provider);
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: "{\"city\":\"Paris\"}" }],
      stop_reason: "tool_use",
    })));
    expect(events.find(e => e.type === "tool_call_delta")).toMatchObject({
      type: "tool_call_delta",
      arguments: "{\"city\":\"Paris\"}",
    });
    expect(events.at(-1)?.type).toBe("done");
  });

  test("unparseable string tool_use.input degrades to {} instead of double-encoding", async () => {
    // Re-encoding the raw text as a JSON string produces `"not json at all"` where the tool
    // contract requires an object -- that is the double-encoding half of #765. `{}` is still
    // wrong input, but it fails in the tool's own argument validation rather than as a type error.
    const adapter = createAnthropicAdapter(provider);
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      content: [{ type: "tool_use", id: "toolu_2", name: "get_weather", input: "not json at all" }],
      stop_reason: "tool_use",
    })));
    expect(events.find(e => e.type === "tool_call_delta")).toMatchObject({
      type: "tool_call_delta",
      arguments: "{}",
    });
  });

  test("EOF after message_delta.stop_reason settles instead of erroring", async () => {
    // The other two EOF tests assert the pre-existing error path and never send a stop reason,
    // so they stay green with this fallback reverted -- they do not test the change they shipped
    // with. This drives the fallback itself: a stream that reported why it stopped but never
    // sent message_stop.
    const response = new Response([
      "event: content_block_start\n",
      'data: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      "event: message_delta\n",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ].join(""));
    const events = await collect(createAnthropicAdapter(provider).parseStream(response));
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
    expect(events.some(e => e.type === "error")).toBe(false);
  });
});
