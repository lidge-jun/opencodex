import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../src/adapters/anthropic";
import { FREE_PROVIDER_DIRECTORY } from "../src/providers/free-directory";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

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
});
