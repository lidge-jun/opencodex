import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../../src/bridge";
import {
  anthropicErrorResponse,
  collectAnthropicMessage,
  responsesSseToAnthropicSse,
} from "../../src/claude/outbound";
import { isTranslatorBudgetExceededError } from "../../src/lib/translator-budget";
import { encodeAnthropicMessageSse, foldAnthropicMessage } from "../../src/protocols/encoders/messages";
import type { AdapterEvent } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

/**
 * PF-09 golden parity: one AdapterEvent sequence through (a) the Responses bridge plus the
 * Responses-to-Anthropic converter and (b) the direct Messages encoder must reach the client as
 * the same events. Only the message id and the server-side search ids are normalized.
 */

interface ToolOptions {
  hideThinkingSummary?: boolean;
  toolParameterSchemas?: Map<string, Record<string, unknown>>;
}

const INPUT_FLOOR = 42;

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

function legacyMessagesStream(events: AdapterEvent[], options: ToolOptions = {}) {
  const translatorBudget = createTestTranslatorBudget();
  const responses = bridgeToResponsesSSE(
    replay(events), "internal/model", undefined, undefined, undefined, undefined, 2_000,
    {
      translatorBudget,
      ...(options.hideThinkingSummary ? { hideThinkingSummary: true } : {}),
      ...(options.toolParameterSchemas ? { toolParameterSchemas: options.toolParameterSchemas } : {}),
      // The Anthropic inbound wire never enforces the declared catalog (#4735).
      enforceDeclaredToolNames: false,
    },
  );
  return {
    stream: responsesSseToAnthropicSse(responses, "client-model", {
      translatorBudget, inputTokenFloor: INPUT_FLOOR, pingIntervalMs: 0,
    }),
    translatorBudget,
  };
}

function directOptions(options: ToolOptions = {}) {
  return {
    model: "client-model",
    inputTokenFloor: INPUT_FLOOR,
    translatorBudget: createTestTranslatorBudget(),
    ...(options.hideThinkingSummary ? { hideThinkingSummary: true } : {}),
    ...(options.toolParameterSchemas ? { toolParameterSchemas: options.toolParameterSchemas } : {}),
  };
}

/** Replace generated ids with stable placeholders, numbered by first appearance. */
function normalizeIds(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") {
    if (/^(ws|msg)_[0-9a-f]{32}$/.test(value)) {
      if (!ids.has(value)) ids.set(value, `${value.slice(0, value.indexOf("_"))}#${ids.size}`);
      return ids.get(value);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(entry => normalizeIds(entry, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeIds(entry, ids)]));
  }
  return value;
}

/** Comment-only SSE blocks are keepalive frames: compared like any other frame, never dropped. */
function normalizeEvents(text: string): unknown[] {
  const ids = new Map<string, string>();
  return text.split("\n\n").filter(block => block.trim().length > 0).map(block => {
    const lines = block.split("\n");
    if (lines.every(line => line.startsWith(":"))) return { keepalive: lines.join("\n") };
    const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("");
    return { event, data: normalizeIds(JSON.parse(data), ids) };
  });
}

async function expectStreamParity(events: AdapterEvent[], options: ToolOptions = {}): Promise<{ event?: string; data: any }[]> {
  const legacy = normalizeEvents(await new Response(legacyMessagesStream(events, options).stream).text());
  const direct = normalizeEvents(await new Response(encodeAnthropicMessageSse(replay(events), directOptions(options))).text());
  expect(direct).toEqual(legacy);
  return direct as { event?: string; data: any }[];
}

/** The Messages ingress's non-stream mapping over the legacy collector. */
async function legacyFold(events: AdapterEvent[], options: ToolOptions = {}): Promise<Response> {
  const { stream, translatorBudget } = legacyMessagesStream(events, options);
  let message: Record<string, unknown>;
  try {
    message = await collectAnthropicMessage(stream, "client-model", translatorBudget);
  } catch (error) {
    if (isTranslatorBudgetExceededError(error)) return anthropicErrorResponse(413, error.message, "request_too_large", error.code);
    return anthropicErrorResponse(502, error instanceof Error ? error.message : String(error), "api_error");
  }
  const isError = message.type === "error";
  const translatedError = isError && typeof message.error === "object"
    ? (message as { error: { code?: unknown; message?: unknown } }).error
    : undefined;
  if (translatedError?.code === "translation_buffer_limit") {
    return anthropicErrorResponse(
      413,
      typeof translatedError.message === "string" ? translatedError.message : "upstream translation buffer exceeded the safe limit",
      "request_too_large",
      "translation_buffer_limit",
    );
  }
  return new Response(JSON.stringify(message), { status: isError ? 502 : 200, headers: { "Content-Type": "application/json" } });
}

async function expectFoldParity(events: AdapterEvent[], options: ToolOptions = {}) {
  const normalize = async (response: Response) => ({
    status: response.status,
    body: normalizeIds(await response.json(), new Map()) as Record<string, any>,
  });
  const legacy = await normalize(await legacyFold(events, options));
  const direct = await normalize(await foldAnthropicMessage(replay(events), directOptions(options)));
  expect(direct).toEqual(legacy);
  return direct;
}

const usage = {
  inputTokens: 120, outputTokens: 30, cachedInputTokens: 40, cacheCreationInputTokens: 8, reasoningOutputTokens: 6,
};

const SCENARIOS: Record<string, { events: AdapterEvent[]; options?: ToolOptions }> = {
  "text with cache-aware usage": {
    events: [
      { type: "text_delta", text: "Hello" },
      { type: "heartbeat" },
      { type: "text_delta", text: ", world" },
      { type: "done", usage },
    ],
  },
  "tool call streams input_json_delta": {
    events: [
      { type: "text_delta", text: "Checking." },
      { type: "tool_call_start", id: "toolu_1", name: "lookup" },
      { type: "tool_call_delta", arguments: "{\"q\":" },
      { type: "tool_call_delta", arguments: "\"weather\"}" },
      { type: "tool_call_end" },
      { type: "done", usage },
    ],
  },
  "no-argument tool call": {
    events: [
      { type: "tool_call_start", id: "toolu_empty", name: "list_apps" },
      { type: "tool_call_end" },
      { type: "done" },
    ],
  },
  "parallel tool calls get their own blocks": {
    events: [
      { type: "tool_call_start", id: "toolu_a", name: "alpha" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "toolu_b", name: "beta" },
      { type: "tool_call_delta", arguments: "{\"x\":1.0}" },
      { type: "tool_call_end" },
      { type: "done" },
    ],
    options: { toolParameterSchemas: new Map([["beta", { type: "object", properties: { x: { type: "integer" } } }]]) },
  },
  "WebSearch client tool input is buffered and sanitized": {
    events: [
      { type: "tool_call_start", id: "toolu_ws", name: "WebSearch" },
      { type: "tool_call_delta", arguments: "{\"query\":\"bun\",\"allowed_domains\":[]," },
      { type: "tool_call_delta", arguments: "\"blocked_domains\":[\"a.com\"]}" },
      { type: "tool_call_end" },
      { type: "done" },
    ],
  },
  "signed thinking block precedes the answer": {
    events: [
      { type: "thinking_delta", thinking: "Think " },
      { type: "thinking_delta", thinking: "harder." },
      { type: "thinking_signature", signature: "sig-1" },
      { type: "text_delta", text: "Answer" },
      { type: "done" },
    ],
  },
  "raw reasoning gets the ocxr1 fallback signature": {
    events: [
      { type: "reasoning_raw_delta", text: "raw notes" },
      { type: "tool_call_start", id: "toolu_r", name: "lookup" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done" },
    ],
  },
  "redacted thinking is its own block": {
    events: [
      { type: "thinking_delta", thinking: "visible" },
      { type: "redacted_thinking", data: "opaque-blob" },
      { type: "text_delta", text: "After" },
      { type: "done" },
    ],
  },
  "hidden thinking still returns its signature": {
    events: [
      { type: "thinking_delta", thinking: "secret" },
      { type: "thinking_signature", signature: "sig-2" },
      { type: "text_delta", text: "Visible" },
      { type: "done" },
    ],
    options: { hideThinkingSummary: true },
  },
  "server-side web search pair": {
    events: [
      { type: "web_search_call_begin", id: "ws1" },
      { type: "web_search_call_end", id: "ws1", queries: ["bun"], sources: [{ url: "https://bun.sh", title: "Bun" }] },
      { type: "text_delta", text: "Found it" },
      { type: "done", usage },
    ],
  },
  "failed server-side search": {
    events: [
      { type: "web_search_call_begin", id: "ws2" },
      { type: "web_search_call_end", id: "ws2", queries: ["a", "b"], status: "failed" },
      { type: "done" },
    ],
  },
  "length stop becomes max_tokens": {
    events: [
      { type: "text_delta", text: "cut" },
      { type: "done", stopReason: "max_tokens", usage },
    ],
  },
  "content filter becomes refusal": {
    events: [
      { type: "text_delta", text: "partial" },
      { type: "incomplete", reason: "content_filter", usage },
    ],
  },
  "other incomplete reasons are a retryable overload": {
    events: [
      { type: "text_delta", text: "partial" },
      { type: "incomplete", reason: "upstream_disconnect" },
    ],
  },
  "turn ended without a final answer": {
    events: [
      { type: "text_delta", text: "commentary" },
      { type: "done", endTurn: false },
    ],
  },
  "error before output has no message_start": {
    events: [
      { type: "error", message: "invalid api key", status: 401 },
    ],
  },
  "mid-stream error closes the open block first": {
    events: [
      { type: "text_delta", text: "partial" },
      { type: "error", message: "rate limited by provider", status: 429, errorType: "rate_limit_error" },
    ],
  },
  "translation buffer overflow": {
    events: [
      { type: "text_delta", text: "x" },
      { type: "error", message: "too big", code: "translation_buffer_limit" },
    ],
  },
  "malformed tool arguments": {
    events: [
      { type: "tool_call_start", id: "toolu_bad", name: "lookup" },
      { type: "tool_call_delta", arguments: "{\"q\":" },
      { type: "tool_call_end" },
      { type: "done" },
    ],
  },
  "adapter EOF without a terminal": {
    events: [
      { type: "text_delta", text: "dangling" },
    ],
  },
};

describe("direct Messages encoder matches bridge + converter (stream)", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      await expectStreamParity(scenario.events, scenario.options);
    });
  }

  test("frame shape: message_start with the input floor, then ping, message_stop last", async () => {
    const frames = await expectStreamParity(SCENARIOS["tool call streams input_json_delta"]!.events);
    expect(frames[0]!.event).toBe("message_start");
    expect(frames[0]!.data.message.usage).toEqual({ input_tokens: INPUT_FLOOR, output_tokens: 0 });
    expect(frames[1]!.event).toBe("ping");
    expect(frames.at(-2)!.data.delta.stop_reason).toBe("tool_use");
    expect(frames.at(-1)!.event).toBe("message_stop");
  });

  test("an initial failure is an error stream without message_start", async () => {
    const frames = await expectStreamParity(SCENARIOS["error before output has no message_start"]!.events);
    expect(frames.map(frame => frame.event)).toEqual(["error"]);
  });
});

describe("direct Messages fold matches bridge + collector (non-stream)", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      await expectFoldParity(scenario.events, scenario.options);
    });
  }

  test("status mapping: overflow is 413, a stream error is 502", async () => {
    expect((await expectFoldParity(SCENARIOS["translation buffer overflow"]!.events)).status).toBe(413);
    expect((await expectFoldParity(SCENARIOS["adapter EOF without a terminal"]!.events)).status).toBe(502);
  });
});

describe("direct Messages encoder stream lifecycle", () => {
  test("wire-silence heartbeats reach the client as the converter's pings", async () => {
    // Only the 1 s beat is driven (not the 20 s keepalive); relayed/first-output hooks must
    // ignore the pings.
    const beats: (() => void)[] = [];
    const timers = {
      setInterval: (handler: () => void, ms: number) => { if (ms === 1_000) beats.push(handler); return beats.length; },
      clearInterval: () => {},
    };
    const run = async (encode: (events: AsyncGenerator<AdapterEvent>) => ReadableStream<Uint8Array>) => {
      beats.length = 0;
      let release: (() => void) | undefined;
      const gate = new Promise<void>(resolve => { release = resolve; });
      async function* quiet(): AsyncGenerator<AdapterEvent> {
        yield { type: "text_delta", text: "thinking" };
        await gate;
        yield { type: "text_delta", text: " done" };
        yield { type: "done" };
      }
      const text = new Response(encode(quiet())).text();
      await Bun.sleep(5);
      for (let i = 0; i < 3; i++) for (const beat of beats) beat();
      release?.();
      return normalizeEvents(await text) as { event?: string }[];
    };
    const legacy = await run(events => {
      const translatorBudget = createTestTranslatorBudget();
      return responsesSseToAnthropicSse(
        bridgeToResponsesSSE(events, "internal/model", undefined, undefined, undefined, undefined, 1_000, {
          translatorBudget, enforceDeclaredToolNames: false, timers,
        }),
        "client-model",
        { translatorBudget, inputTokenFloor: INPUT_FLOOR, pingIntervalMs: 0 },
      );
    });
    const relayed: unknown[] = [];
    let firstOutputs = 0;
    const direct = await run(events => encodeAnthropicMessageSse(events, {
      ...directOptions(), heartbeatMs: 1_000, timers,
      hooks: { onRelayed: observation => { relayed.push(observation); }, onFirstOutput: () => { firstOutputs++; } },
    }));

    expect(direct).toEqual(legacy);
    // message_start's own ping, then one per silent beat after the first clears wire activity.
    const pings = direct.filter(frame => frame.event === "ping");
    expect(pings).toHaveLength(3);
    expect(relayed).toHaveLength(direct.length - 2);
    expect(firstOutputs).toBe(1);
  });
});
