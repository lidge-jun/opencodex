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

  test("malformed baseUrl throws without echoing the URL", () => {
    const sensitive = "https://user:secret@example.test/v1?token=abc";
    expect(() => anthropicMessagesUrl(sensitive)).toThrow("anthropic provider has malformed baseUrl");
    try {
      anthropicMessagesUrl(sensitive);
    } catch (err) {
      expect(String(err)).not.toContain("secret");
      expect(String(err)).not.toContain("token=abc");
    }
  });

  test.each([
    "https://example.test/v1?tenant=a",
    "https://example.test/v1#frag",
    "https://example.test/v1/messages?stream=1",
  ] as const)("rejects search/hash in %s", (input) => {
    expect(() => anthropicMessagesUrl(input)).toThrow("anthropic provider has malformed baseUrl");
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

  test("EOF after message_delta stop_reason completes without message_stop", async () => {
    const response = new Response([
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      "event: message_delta\n",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    ].join(""));
    const events = await collect(createAnthropicAdapter(provider).parseStream(response));
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
    expect(events.some(e => e.type === "error")).toBe(false);
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

  test("whitespace tool_use id is treated as missing", async () => {
    const response = new Response([
      "event: content_block_start\n",
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"   ","name":"get_weather"}}\n\n',
      "event: content_block_stop\n",
      'data: {"type":"content_block_stop"}\n\n',
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""));
    const events = await collect(createAnthropicAdapter(provider).parseStream(response));
    const start = events.find(e => e.type === "tool_call_start");
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

  test("whitespace tool_use id synthesizes in non-stream response", async () => {
    const adapter = createAnthropicAdapter(provider);
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      content: [{ type: "tool_use", id: "  ", name: "get_weather", input: {} }],
      stop_reason: "tool_use",
    })));
    const start = events.find(e => e.type === "tool_call_start");
    expect(start && "id" in start && start.id.startsWith("toolu_")).toBe(true);
  });
});
