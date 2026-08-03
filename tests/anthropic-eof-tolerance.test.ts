import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../src/adapters/anthropic";
import { FREE_PROVIDER_DIRECTORY } from "../src/providers/free-directory";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "./helpers/translator-budget";

/**
 * #658: AgentRouter's Anthropic-compatible endpoint can close the stream before
 * `content_block_stop`, `message_delta`, and `message_stop`. The default adapter treats
 * that EOF as a fatal truncation; with `anthropicEofTolerance` enabled it may complete
 * only when visible text was received or an open tool call has complete JSON-object
 * arguments. These tests pin the wire behavior; no request reaches agentrouter.org.
 */

const createAnthropicAdapter = (...args: Parameters<typeof createAnthropicAdapterProduction>) =>
  withTestTranslatorBudget(createAnthropicAdapterProduction(...args));

function providerFor(extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "anthropic",
    baseUrl: "https://agentrouter.org",
    apiKey: "test-key",
    authMode: "key",
    ...extra,
  } as OcxProviderConfig;
}

const strict = providerFor();
const tolerant = providerFor({ anthropicEofTolerance: true });

const TRUNCATION = "upstream stream ended before message_stop — possible truncation";

function sseResponse(events: string[]): Response {
  return new Response(events.join("\n\n"), { headers: { "content-type": "text/event-stream" } });
}

async function collect(provider: OcxProviderConfig, events: string[]): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const event of createAnthropicAdapter(provider).parseStream(sseResponse(events))) out.push(event);
  return out;
}

const textEof = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"visible"}}',
];

function toolEof(partialJson: string, id = "toolu_1"): string[] {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{}}',
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "get_weather" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: partialJson } })}`,
  ];
}

describe("AgentRouter Anthropic EOF tolerance (#658)", () => {
  test("text EOF completes when anthropicEofTolerance is enabled", async () => {
    const events = await collect(tolerant, textEof);

    expect(events).toContainEqual({ type: "text_delta", text: "visible" });
    expect(events.at(-1)).toEqual({ type: "done", usage: { inputTokens: 2, outputTokens: 0 } });
    expect(events.some(event => event.type === "error")).toBe(false);
  });

  test("the same EOF without the capability stays a truncation error", async () => {
    const events = await collect(strict, textEof);

    expect(events.at(-1)).toEqual({ type: "error", message: TRUNCATION });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("a complete tool call at EOF closes and completes", async () => {
    const events = await collect(tolerant, toolEof('{"value":42}'));

    expect(events).toContainEqual({ type: "tool_call_start", id: "toolu_1", name: "get_weather" });
    expect(events).toContainEqual({ type: "tool_call_delta", arguments: '{"value":42}' });
    expect(events.at(-1)).toEqual({ type: "done", usage: undefined });
    expect(events.some(event => event.type === "error")).toBe(false);
  });

  test("an incomplete tool call at EOF remains a truncation error", async () => {
    const events = await collect(tolerant, toolEof('{"value":'));

    expect(events.at(-1)).toEqual({ type: "error", message: TRUNCATION });
    expect(events.some(event => event.type === "done" || event.type === "tool_call_end")).toBe(false);
  });

  test("EOF before any usable content remains a truncation error", async () => {
    const events = await collect(tolerant, [
      'event: message_start\ndata: {"type":"message_start","message":{}}',
    ]);

    expect(events.at(-1)).toEqual({ type: "error", message: TRUNCATION });
  });

  test("a missing tool_use id gets a stable synthesized id on the tolerant path", async () => {
    const events = await collect(tolerant, toolEof('{"value":42}', ""));
    const start = events.find(event => event.type === "tool_call_start");

    expect(start?.type).toBe("tool_call_start");
    expect((start as { id: string }).id).toMatch(/^toolu_[0-9a-f]{24}$/);
    expect(events.at(-1)).toEqual({ type: "done", usage: undefined });
  });

  test("non-stream concatenated tool input keeps the last valid object when enabled", async () => {
    const payload = JSON.stringify({
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: '{}{"value":42}' }],
    });

    const tolerantEvents = await createAnthropicAdapter(tolerant).parseResponse(new Response(payload));
    expect(tolerantEvents).toContainEqual({ type: "tool_call_delta", arguments: '{"value":42}' });

    const strictEvents = await createAnthropicAdapter(strict).parseResponse(new Response(payload));
    expect(strictEvents).toContainEqual({ type: "tool_call_delta", arguments: "{}" });
  });

  test("the AgentRouter directory row declares the EOF tolerance capability", () => {
    const row = FREE_PROVIDER_DIRECTORY.find(provider => provider.id === "agentrouter");
    expect(row?.anthropicEofTolerance).toBe(true);
  });

  test("an empty text delta at EOF stays a truncation error even when tolerant", async () => {
    // Review finding: `sawVisibleText` must require non-empty text, or a cut-off turn
    // surfaces as a successful empty answer.
    const events = await collect(tolerant, [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}',
    ]);

    expect(events.at(-1)).toEqual({ type: "error", message: TRUNCATION });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("a budget overflow is the single terminal event on the tolerant path", async () => {
    // Review finding: after the translation_buffer_limit error the generator must return,
    // not fall through to EOF tolerance and append tool_call_end/done behind the error.
    const adapter = createAnthropicAdapter(tolerant);
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(
      sseResponse(toolEof('{"value":42}', "toolu_1").concat([
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ',"extra":true' } })}`,
      ])),
      createTestTranslatorBudget({ maxCallArgumentBytes: 16 }),
    )) {
      events.push(event);
    }

    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    expect((terminal as { code?: string }).code).toBe("translation_buffer_limit");
    const firstError = events.findIndex(event => event.type === "error");
    expect(events.slice(firstError + 1).some(event => event.type === "done" || event.type === "tool_call_end")).toBe(false);
  });

  test("repair never materializes a brace index over hostile input", async () => {
    // Review finding: the repair scan must stay backward and candidate-bounded. 4 MiB of
    // unmatched opens would have built two O(n) offset arrays in the original helper; the
    // result must still be the plain fallback.
    const hostile = "{".repeat(4 * 1024 * 1024);
    const payload = JSON.stringify({
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: hostile }],
    });

    const started = Date.now();
    const events = await createAnthropicAdapter(tolerant).parseResponse(new Response(payload));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(events).toContainEqual({ type: "tool_call_delta", arguments: "{}" });
  });

  test("repair declines input above the byte cap", async () => {
    const oversized = `{"pad":"${"x".repeat(1024 * 1024 + 8)}`; // > 1 MiB, unparseable
    const payload = JSON.stringify({
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: oversized }],
    });

    const events = await createAnthropicAdapter(tolerant).parseResponse(new Response(payload));
    expect(events).toContainEqual({ type: "tool_call_delta", arguments: "{}" });
  });

  test("the repair cap measures UTF-8 bytes, not UTF-16 code units", async () => {
    // 600k 2-byte characters: 1.2 MB on the wire but only 600k code units, which a
    // `string.length` check would wrongly admit into the parse attempts.
    const oversized = `{${"é".repeat(600_000)}`;
    const payload = JSON.stringify({
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: oversized }],
    });

    const events = await createAnthropicAdapter(tolerant).parseResponse(new Response(payload));
    expect(events).toContainEqual({ type: "tool_call_delta", arguments: "{}" });
  });

  test("malformed surrogate pairs count as separate U+FFFD replacements against the cap", async () => {
    // 200k high-surrogate pairs: 400k code units, but every lone surrogate encodes as its
    // own 3-byte U+FFFD — 1.2 MB over the wire, which a pair-skipping count would admit.
    const oversized = `${"\ud800\ud800".repeat(200_000)}{"ok":true}`;
    const payload = JSON.stringify({
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: oversized }],
    });

    const events = await createAnthropicAdapter(tolerant).parseResponse(new Response(payload));
    expect(events).toContainEqual({ type: "tool_call_delta", arguments: "{}" });
  });
});
