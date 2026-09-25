import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../../src/bridge";
import {
  chatCompletionsErrorResponse,
  collectChatCompletion,
  isChatCompletionsStreamError,
  responsesSseToChatCompletionsSse,
} from "../../src/chat/outbound";
import { encodeChatCompletionSse, foldChatCompletion } from "../../src/protocols/encoders/chat";
import type { AdapterEvent } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

/**
 * PF-09 golden parity: one AdapterEvent sequence through (a) the Responses bridge plus the
 * Responses-to-Chat converter and (b) the direct Chat encoder must reach the client as the same
 * frames. Only the completion id and the creation second are normalized.
 */

interface ToolOptions {
  hideThinkingSummary?: boolean;
  declaredToolNames?: Set<string>;
  freeformToolNames?: Set<string>;
  toolParameterSchemas?: Map<string, Record<string, unknown>>;
}

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

function legacyChatStream(events: AdapterEvent[], options: ToolOptions = {}) {
  const translatorBudget = createTestTranslatorBudget();
  const responses = bridgeToResponsesSSE(
    replay(events), "internal/model", undefined, options.freeformToolNames, undefined, undefined, 2_000,
    {
      translatorBudget,
      ...(options.hideThinkingSummary ? { hideThinkingSummary: true } : {}),
      ...(options.declaredToolNames ? { declaredToolNames: options.declaredToolNames } : {}),
      ...(options.toolParameterSchemas ? { toolParameterSchemas: options.toolParameterSchemas } : {}),
      // The Chat inbound wire never enforces the declared catalog (#4735).
      enforceDeclaredToolNames: false,
    },
  );
  return { stream: responsesSseToChatCompletionsSse(responses, "client-model", { translatorBudget }), translatorBudget };
}

function directOptions(options: ToolOptions = {}) {
  return {
    model: "client-model",
    translatorBudget: createTestTranslatorBudget(),
    ...(options.hideThinkingSummary ? { hideThinkingSummary: true } : {}),
    ...(options.declaredToolNames ? { declaredToolNames: options.declaredToolNames } : {}),
    ...(options.freeformToolNames ? { freeformToolNames: options.freeformToolNames } : {}),
    ...(options.toolParameterSchemas ? { toolParameterSchemas: options.toolParameterSchemas } : {}),
  };
}

/** Comment-only SSE blocks are keepalive frames: compared like any other frame, never dropped. */
function normalizeFrames(text: string): unknown[] {
  return text.split("\n\n").filter(block => block.trim().length > 0).map(block => {
    const lines = block.split("\n");
    if (lines.every(line => line.startsWith(":"))) return { keepalive: lines.join("\n") };
    const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("");
    if (data === "[DONE]") return "[DONE]";
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if ("id" in parsed) parsed.id = "ID";
    if ("created" in parsed) parsed.created = 0;
    return parsed;
  });
}

async function expectStreamParity(events: AdapterEvent[], options: ToolOptions = {}): Promise<unknown[]> {
  const legacy = normalizeFrames(await new Response(legacyChatStream(events, options).stream).text());
  const direct = normalizeFrames(await new Response(encodeChatCompletionSse(replay(events), directOptions(options))).text());
  expect(direct).toEqual(legacy);
  return direct;
}

/** The Chat ingress's non-stream mapping over the legacy collector. */
async function legacyFold(events: AdapterEvent[], options: ToolOptions = {}): Promise<Response> {
  const { stream, translatorBudget } = legacyChatStream(events, options);
  try {
    const completion = await collectChatCompletion(stream, "client-model", translatorBudget);
    return new Response(JSON.stringify(completion), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    if (isChatCompletionsStreamError(err)) return chatCompletionsErrorResponse(err.status, err.message, err.type, err.code);
    return chatCompletionsErrorResponse(502, err instanceof Error ? err.message : String(err), "server_error");
  }
}

async function normalizedJson(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = await response.json() as Record<string, unknown>;
  if ("id" in body) body.id = "ID";
  if ("created" in body) body.created = 0;
  return { status: response.status, body };
}

async function expectFoldParity(events: AdapterEvent[], options: ToolOptions = {}) {
  const legacy = await normalizedJson(await legacyFold(events, options));
  const direct = await normalizedJson(await foldChatCompletion(replay(events), directOptions(options)));
  expect(direct).toEqual(legacy);
  return direct;
}

const usage = {
  inputTokens: 120, outputTokens: 30, cachedInputTokens: 40, cacheCreationInputTokens: 8, reasoningOutputTokens: 6,
};

const SCENARIOS: Record<string, { events: AdapterEvent[]; options?: ToolOptions }> = {
  "text with usage": {
    events: [
      { type: "text_delta", text: "Hello" },
      { type: "heartbeat" },
      { type: "text_delta", text: ", world" },
      { type: "done", usage },
    ],
  },
  "citation markers are stripped across delta boundaries": {
    events: [
      { type: "text_delta", text: "See citeturn1" },
      { type: "text_delta", text: "view0 for details" },
      { type: "done" },
    ],
  },
  "tool call with streamed arguments": {
    events: [
      { type: "text_delta", text: "Checking." },
      { type: "tool_call_start", id: "call_1", name: "lookup" },
      { type: "tool_call_delta", arguments: "{\"q\":" },
      { type: "tool_call_delta", arguments: "\"weather\"}" },
      { type: "tool_call_end" },
      { type: "done", usage },
    ],
  },
  "parallel tool calls keep stable indexes": {
    events: [
      { type: "tool_call_start", id: "call_a", name: "alpha" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "call_b", name: "beta" },
      { type: "tool_call_delta", arguments: "{\"x\":1}" },
      { type: "tool_call_end" },
      { type: "done" },
    ],
  },
  "no-argument tool call serializes as {}": {
    events: [
      { type: "tool_call_start", id: "call_empty", name: "list_apps" },
      { type: "tool_call_end" },
      { type: "done" },
    ],
  },
  "integral float arguments are repaired against the schema": {
    events: [
      { type: "tool_call_start", id: "call_int", name: "sleep" },
      { type: "tool_call_delta", arguments: "{\"ms\":120000.0}" },
      { type: "tool_call_end" },
      { type: "done" },
    ],
    options: {
      toolParameterSchemas: new Map([["sleep", { type: "object", properties: { ms: { type: "integer" } } }]]),
    },
  },
  "summary and raw reasoning become reasoning_content": {
    events: [
      { type: "thinking_delta", thinking: "Think " },
      { type: "thinking_delta", thinking: "harder." },
      { type: "thinking_signature", signature: "sig-1" },
      { type: "reasoning_raw_delta", text: "raw notes" },
      { type: "text_delta", text: "Answer" },
      { type: "done" },
    ],
  },
  "hidden thinking produces no reasoning_content": {
    events: [
      { type: "thinking_delta", thinking: "secret" },
      { type: "thinking_signature", signature: "sig-2" },
      { type: "reasoning_raw_delta", text: "hidden raw" },
      { type: "text_delta", text: "Visible" },
      { type: "done" },
    ],
    options: { hideThinkingSummary: true },
  },
  "freeform tool calls have no Chat representation": {
    events: [
      { type: "tool_call_start", id: "call_patch", name: "apply_patch" },
      { type: "tool_call_delta", arguments: "*** Begin Patch\n*** End Patch" },
      { type: "tool_call_end" },
      { type: "done" },
    ],
    options: { freeformToolNames: new Set(["apply_patch"]) },
  },
  "length stop finishes with length": {
    events: [
      { type: "text_delta", text: "cut" },
      { type: "done", stopReason: "max_tokens", usage },
    ],
  },
  "content filter incomplete finishes with content_filter": {
    events: [
      { type: "text_delta", text: "partial" },
      { type: "incomplete", reason: "content_filter", usage },
    ],
  },
  "other incomplete reasons fail without [DONE]": {
    events: [
      { type: "text_delta", text: "partial" },
      { type: "incomplete", reason: "upstream_disconnect", message: "socket reset" },
    ],
  },
  "mid-stream error frame": {
    events: [
      { type: "text_delta", text: "partial" },
      { type: "error", message: "rate limited by provider", status: 429, errorType: "rate_limit_error" },
    ],
  },
  "error before any output": {
    events: [
      { type: "error", message: "invalid api key", status: 401 },
    ],
  },
  "cyber policy error keeps its code": {
    events: [
      { type: "error", message: "blocked", status: 400, code: "cyber_policy" },
    ],
  },
  "translation buffer overflow": {
    events: [
      { type: "text_delta", text: "x" },
      { type: "error", message: "too big", code: "translation_buffer_limit" },
    ],
  },
  "malformed tool arguments fail the turn": {
    events: [
      { type: "tool_call_start", id: "call_bad", name: "lookup" },
      { type: "tool_call_delta", arguments: "{\"q\":" },
      { type: "tool_call_end" },
      { type: "done" },
    ],
  },
  "open tool call at an error is delivered incomplete": {
    events: [
      { type: "tool_call_start", id: "call_open", name: "lookup" },
      { type: "tool_call_delta", arguments: "{\"q\":1}" },
      { type: "error", message: "upstream exploded", status: 502 },
    ],
  },
  "adapter EOF without a terminal": {
    events: [
      { type: "text_delta", text: "dangling" },
    ],
  },
  "web search activity is invisible to Chat": {
    events: [
      { type: "web_search_call_begin", id: "ws1" },
      { type: "web_search_call_end", id: "ws1", queries: ["bun"], sources: [{ url: "https://bun.sh", title: "Bun" }] },
      { type: "text_delta", text: "Found it" },
      { type: "done" },
    ],
  },
  "assistant boundary splits messages": {
    events: [
      { type: "text_delta", text: "first" },
      { type: "assistant_boundary" },
      { type: "text_delta", text: "second" },
      { type: "done", endTurn: false },
    ],
  },
};

describe("direct Chat encoder matches bridge + converter (stream)", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      await expectStreamParity(scenario.events, scenario.options);
    });
  }

  test("frame shape: one role frame, stable tool index, usage on the finish chunk", async () => {
    const frames = await expectStreamParity(SCENARIOS["tool call with streamed arguments"]!.events);
    const roles = frames.filter(frame => JSON.stringify(frame).includes("\"role\":\"assistant\""));
    expect(roles).toHaveLength(1);
    // Frames carrying a tool-call delta; the finish chunk only names `tool_calls` as its reason.
    const toolFrames = frames.filter(frame => JSON.stringify(frame).includes("\"tool_calls\":["));
    expect(toolFrames).toHaveLength(1);
    expect(JSON.stringify(toolFrames[0])).toContain("\"arguments\":\"{\\\"q\\\":\\\"weather\\\"}\"");
    const finish = frames.at(-2) as { choices: { finish_reason: string }[]; usage: Record<string, unknown> };
    expect(finish.choices[0]!.finish_reason).toBe("tool_calls");
    expect(finish.usage.prompt_tokens).toBe(120);
    expect(frames.at(-1)).toBe("[DONE]");
  });

  test("a failure ends with an error frame and no [DONE]", async () => {
    const frames = await expectStreamParity(SCENARIOS["mid-stream error frame"]!.events);
    expect(frames).not.toContain("[DONE]");
    expect(frames.at(-1)).toHaveProperty("error");
  });
});

describe("direct Chat fold matches bridge + collector (non-stream)", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      await expectFoldParity(scenario.events, scenario.options);
    });
  }

  test("status mapping: a length stop is a 200 completion, a stream failure is an error status", async () => {
    const length = await expectFoldParity(SCENARIOS["length stop finishes with length"]!.events);
    expect(length.status).toBe(200);
    expect((length.body.choices as { finish_reason: string }[])[0]!.finish_reason).toBe("length");
    expect((await expectFoldParity(SCENARIOS["mid-stream error frame"]!.events)).status).toBeGreaterThanOrEqual(400);
  });
});

describe("direct Chat encoder stream lifecycle", () => {
  test("client cancel stops the upstream once and never reports a terminal", async () => {
    let stopped = 0;
    let terminals = 0;
    let cancelled = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    async function* slow(): AsyncGenerator<AdapterEvent> {
      yield { type: "text_delta", text: "first" };
      await gate;
      yield { type: "done" };
    }
    const stream = encodeChatCompletionSse(slow(), {
      ...directOptions(),
      hooks: {
        stopUpstream: () => { stopped++; },
        afterTerminal: () => { terminals++; },
        onClientCancel: () => { cancelled++; },
      },
    });
    const reader = stream.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    release?.();
    expect(stopped).toBe(1);
    expect(cancelled).toBe(1);
    expect(terminals).toBe(0);
  });

  test("hooks: first output once, completed response flagged, terminal once", async () => {
    const seen: string[] = [];
    await new Response(encodeChatCompletionSse(replay(SCENARIOS["text with usage"]!.events), {
      ...directOptions(),
      hooks: {
        onFirstOutput: () => { seen.push("first"); },
        beforeTerminal: terminal => { seen.push(`before:${terminal.status}:${terminal.completedResponse}:${terminal.reportUsage}`); },
        afterTerminal: terminal => { seen.push(`after:${terminal.status}`); },
        stopUpstream: () => { seen.push("stop"); },
      },
    })).text();
    expect(seen).toEqual(["first", "before:completed:true:true", "after:completed", "stop"]);
  });

  test("stall watchdog fails the turn like the bridge", async () => {
    const ticks: (() => void)[] = [];
    const timers = {
      setInterval: (handler: () => void) => { ticks.push(handler); return ticks.length - 1; },
      clearInterval: () => {},
    };
    async function* hang(): AsyncGenerator<AdapterEvent> {
      yield { type: "text_delta", text: "waiting" };
      await new Promise(() => {});
    }
    const legacyBudget = createTestTranslatorBudget();
    const legacy = responsesSseToChatCompletionsSse(
      bridgeToResponsesSSE(hang(), "internal/model", undefined, undefined, undefined, undefined, 1_000, {
        translatorBudget: legacyBudget, stallTimeoutSec: 2, enforceDeclaredToolNames: false, timers,
      }),
      "client-model",
      { translatorBudget: legacyBudget },
    );
    const legacyText = new Response(legacy).text();
    await Bun.sleep(5);
    for (let i = 0; i < 3; i++) for (const tick of ticks) tick();
    const legacyFrames = normalizeFrames(await legacyText);

    ticks.length = 0;
    const direct = encodeChatCompletionSse(hang(), { ...directOptions(), heartbeatMs: 1_000, stallTimeoutSec: 2, timers });
    const directText = new Response(direct).text();
    await Bun.sleep(5);
    for (let i = 0; i < 3; i++) for (const tick of ticks) tick();
    const directFrames = normalizeFrames(await directText);

    expect(directFrames).toEqual(legacyFrames);
    expect(JSON.stringify(directFrames.at(-1))).toContain("upstream_stall_timeout");
  });

  test("wire-silence heartbeats reach the client as the converter's SSE comments", async () => {
    // Only the beat timer is driven; relayed/first-output hooks must ignore the keepalives.
    const ticks: (() => void)[] = [];
    const timers = {
      setInterval: (handler: () => void) => { ticks.push(handler); return ticks.length - 1; },
      clearInterval: () => {},
    };
    const run = async (encode: (events: AsyncGenerator<AdapterEvent>) => ReadableStream<Uint8Array>) => {
      ticks.length = 0;
      let release: (() => void) | undefined;
      const gate = new Promise<void>(resolve => { release = resolve; });
      async function* quiet(): AsyncGenerator<AdapterEvent> {
        yield { type: "text_delta", text: "thinking" };
        await gate;
        yield { type: "text_delta", text: " done" };
        yield { type: "done", usage };
      }
      const text = new Response(encode(quiet())).text();
      await Bun.sleep(5);
      for (let i = 0; i < 3; i++) for (const tick of ticks) tick();
      release?.();
      return normalizeFrames(await text);
    };
    const legacy = await run(events => {
      const translatorBudget = createTestTranslatorBudget();
      return responsesSseToChatCompletionsSse(
        bridgeToResponsesSSE(events, "internal/model", undefined, undefined, undefined, undefined, 1_000, {
          translatorBudget, enforceDeclaredToolNames: false, timers,
        }),
        "client-model",
        { translatorBudget },
      );
    });
    const relayed: unknown[] = [];
    let firstOutputs = 0;
    const direct = await run(events => encodeChatCompletionSse(events, {
      ...directOptions(), heartbeatMs: 1_000, timers,
      hooks: { onRelayed: observation => { relayed.push(observation); }, onFirstOutput: () => { firstOutputs++; } },
    }));

    expect(direct).toEqual(legacy);
    const keepalives = direct.filter(frame => typeof frame === "object" && frame !== null && "keepalive" in frame);
    expect(keepalives).toEqual([{ keepalive: ": opencodex heartbeat" }, { keepalive: ": opencodex heartbeat" }]);
    expect(relayed).toHaveLength(direct.length - keepalives.length);
    expect(firstOutputs).toBe(1);
  });
});
