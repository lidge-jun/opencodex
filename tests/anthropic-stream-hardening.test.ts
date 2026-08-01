import { describe, expect, test } from "bun:test";
import { anthropicMessagesUrl, createAnthropicAdapter as createAnthropicAdapterProduction } from "../src/adapters/anthropic";
import type { AdapterEvent } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createAnthropicAdapter = (...args: Parameters<typeof createAnthropicAdapterProduction>) =>
  withTestTranslatorBudget(createAnthropicAdapterProduction(...args));

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

  // A relay that sends `""` or `"   "` is the case `??` misses: the field is present,
  // so no synthesis happened and the call went out with an id the client cannot echo
  // back. Blank must be treated as absent (#765).
  test("tool_use with a blank id synthesizes one instead of shipping it", async () => {
    for (const blank of ['""', '"   "']) {
      const response = new Response([
        "event: content_block_start\n",
        `data: {"type":"content_block_start","content_block":{"type":"tool_use","id":${blank},"name":"get_weather"}}\n\n`,
        "event: content_block_delta\n",
        'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
        "event: content_block_stop\n",
        'data: {"type":"content_block_stop"}\n\n',
        "event: message_stop\n",
        'data: {"type":"message_stop"}\n\n',
      ].join(""));
      const events = await collect(createAnthropicAdapter(provider).parseStream(response));
      const start = events.find(e => e.type === "tool_call_start");
      expect(start && "id" in start && start.id.trim()).toBeTruthy();
      expect(start && "id" in start && start.id.startsWith("toolu_")).toBe(true);
    }
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

describe("anthropic streamed tool argument validation", () => {
  test("malformed streamed tool arguments fail the turn instead of completing the call", async () => {
    // The stream forwards fragments as they arrive (the bridge turns each into a client-visible
    // frame), so a malformed payload cannot be repaired the way the non-stream path repairs it.
    // It must not end the call normally either: a client that already received `not json` would
    // be told the tool call completed. The turn errors instead; the bridge cancels the open call.
    const response = new Response([
      "event: content_block_start\n",
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_9","name":"get_weather"}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"not json"}}\n\n',
      "event: content_block_stop\n",
      'data: {"type":"content_block_stop"}\n\n',
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""));
    const events = await collect(createAnthropicAdapter(provider).parseStream(response));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "tool_call_end")).toBe(false);
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("valid streamed tool arguments still arrive as incremental deltas", async () => {
    // The bridge maps each adapter delta to response.function_call_arguments.delta, so the
    // fragments must keep flowing as they arrive rather than being withheld until block close.
    const response = new Response([
      "event: content_block_start\n",
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_10","name":"get_weather"}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"Paris\\"}"}}\n\n',
      "event: content_block_stop\n",
      'data: {"type":"content_block_stop"}\n\n',
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""));
    const events = await collect(createAnthropicAdapter(provider).parseStream(response));
    expect(events.filter(e => e.type === "tool_call_delta")).toMatchObject([
      { type: "tool_call_delta", arguments: '{"city":' },
      { type: "tool_call_delta", arguments: '"Paris"}' },
    ]);
    expect(events.some(e => e.type === "tool_call_end")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("two tool_use blocks in one message keep separate argument buffers", async () => {
    const response = new Response([
      "event: content_block_start\n",
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_a","name":"one"}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"one\\":1}"}}\n\n',
      "event: content_block_stop\n",
      'data: {"type":"content_block_stop"}\n\n',
      "event: content_block_start\n",
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_b","name":"two"}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"two\\":2}"}}\n\n',
      "event: content_block_stop\n",
      'data: {"type":"content_block_stop"}\n\n',
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""));
    const events = await collect(createAnthropicAdapter(provider).parseStream(response));
    expect(events.filter(e => e.type === "tool_call_delta")).toMatchObject([
      { type: "tool_call_delta", arguments: '{"one":1}' },
      { type: "tool_call_delta", arguments: '{"two":2}' },
    ]);
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("a tool_use block with no argument fragments is not treated as malformed", async () => {
    const response = new Response([
      "event: content_block_start\n",
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_c","name":"now"}}\n\n',
      "event: content_block_stop\n",
      'data: {"type":"content_block_stop"}\n\n',
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""));
    const events = await collect(createAnthropicAdapter(provider).parseStream(response));
    expect(events.some(e => e.type === "error")).toBe(false);
    expect(events.some(e => e.type === "tool_call_end")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });
});
