import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import {
  clearReasoningReplayCacheForTests,
  peekReasoningForCall,
} from "../src/responses/reasoning-replay-cache";
import type { AdapterEvent, OcxReasoningReplayScopeRef } from "../src/types";

/**
 * Regression for issue #950's non-streaming path: chat-completions batch
 * responses always carry `content` (often an empty string), and the adapter
 * emits that as a text_delta BEFORE tool_call_start. The bridge used to wipe
 * the pending reasoning handoff on every text_delta, so batch-born tool rounds
 * never entered the replay cache and any later continuation serialized bare →
 * upstream 400 ("The `reasoning_content` in the thinking mode must be passed
 * back to the API."). All real-world 400s on this proxy were closeReason
 * non_stream.
 */

const REASONING = "I need to inspect files before answering.";
const SCOPE: OcxReasoningReplayScopeRef = {
  clientThreadId: "thread-batch",
  current: {
    providerName: "opencode-free",
    providerDestinationIdentity: "destination:provider",
    adapterName: "openai-chat",
    modelId: "deepseek-v4-flash-free",
    credentialIdentity: "key:test",
  },
};
const GLOBAL_SCOPE: OcxReasoningReplayScopeRef = { ...SCOPE, clientThreadId: "global" };

function batchOutput(events: AdapterEvent[]): Record<string, unknown> {
  return buildResponseJSON(events, "opencode-free/deepseek-v4-flash-free", {
    replayCacheScope: SCOPE,
  });
}

async function streamFrames(
  events: AdapterEvent[],
  replayScope: OcxReasoningReplayScopeRef | null = SCOPE,
): Promise<void> {
  async function* replay(list: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
    for (const event of list) yield event;
  }
  const reader = bridgeToResponsesSSE(
    replay(events),
    "opencode-free/deepseek-v4-flash-free",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    replayScope === null ? undefined : { replayCacheScope: replayScope },
  ).getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    decoder.decode(value, { stream: true });
  }
}

const toolRoundEvents = (): AdapterEvent[] => [
  { type: "reasoning_raw_delta", text: REASONING },
  { type: "text_delta", text: "" },
  { type: "tool_call_start", id: "call_batch_1", name: "read_file" },
  { type: "tool_call_delta", arguments: '{"path":"README.md"}' },
  { type: "tool_call_end" },
  { type: "done" },
];

describe("reasoning replay survives empty text deltas (both wire modes)", () => {
  beforeEach(() => {
    clearReasoningReplayCacheForTests();
  });
  afterEach(() => {
    clearReasoningReplayCacheForTests();
  });

  test("batch: reasoning + empty content + tool call is cached for the call id", () => {
    const response = batchOutput(toolRoundEvents());
    expect(response.output.some(o => (o as Record<string, unknown>).type === "function_call")).toBe(true);
    expect(peekReasoningForCall("call_batch_1", SCOPE)).toBe(REASONING);
  });

  test("batch: an unscoped bridge never writes a global replay entry", () => {
    buildResponseJSON(toolRoundEvents(), "opencode-free/deepseek-v4-flash-free", {});
    expect(peekReasoningForCall("call_batch_1", GLOBAL_SCOPE)).toBeUndefined();
  });

  test("batch: real text between reasoning and the tool call clears the cache target", () => {
    const events = toolRoundEvents();
    events[1] = { type: "text_delta", text: "Let me look at the repo first." };
    batchOutput(events);
    expect(peekReasoningForCall("call_batch_1", SCOPE)).toBeUndefined();
  });

  test("stream: reasoning + empty content delta + tool call is cached for the call id", async () => {
    await streamFrames(toolRoundEvents());
    expect(peekReasoningForCall("call_batch_1", SCOPE)).toBe(REASONING);
  });

  test("stream: an unscoped bridge never writes a global replay entry", async () => {
    await streamFrames(toolRoundEvents(), null);
    expect(peekReasoningForCall("call_batch_1", GLOBAL_SCOPE)).toBeUndefined();
  });

  test("stream: real text between reasoning and the tool call clears the cache target", async () => {
    const events = toolRoundEvents();
    events[1] = { type: "text_delta", text: "Let me look at the repo first." };
    await streamFrames(events);
    expect(peekReasoningForCall("call_batch_1", SCOPE)).toBeUndefined();
  });
});
