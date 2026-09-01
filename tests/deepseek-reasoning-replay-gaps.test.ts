import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { buildResponseJSON } from "../src/bridge";
import { parseRequest } from "../src/responses/parser";
import {
  clearReasoningReplayCacheForTests,
  peekReasoningForCall as peekReasoningForCallRaw,
  rememberReasoningForCall as rememberReasoningForCallRaw,
} from "../src/responses/reasoning-replay-cache";
import { routeModel } from "../src/router";
import type {
  AdapterEvent,
  OcxConfig,
  OcxParsedRequest,
  OcxReasoningReplayScopeRef,
} from "../src/types";

/**
 * Regression coverage for opencodex issue #950: OpenCode Go DeepSeek V4 Flash
 * intermittently drops `reasoning_content` on tool-call continuations and the
 * upstream rejects the request with HTTP 400 ("The `reasoning_content` in the
 * thinking mode must be passed back to the API").
 *
 * The invariant: for every assistant message that contains `tool_calls`, the
 * openai-chat adapter must serialize a non-empty `reasoning_content` when the
 * provider originally returned one for that turn.
 *
 * Each test exercises one transformation path that used to break the
 * invariant; all four were red against the pre-fix code.
 */

const MODEL = "opencode-go/deepseek-v4-flash";
const REASONING = "I need to inspect files before answering.";
function replayScope(
  clientThreadId = "test-thread",
  overrides: Partial<NonNullable<OcxReasoningReplayScopeRef["current"]>> = {},
): OcxReasoningReplayScopeRef {
  return {
    clientThreadId,
    current: {
      providerName: "opencode-go",
      providerDestinationIdentity: "destination:opencode-zen-go",
      adapterName: "openai-chat",
      modelId: "deepseek-v4-flash",
      credentialIdentity: "key:test",
      ...overrides,
    },
  };
}
const REPLAY_SCOPE = replayScope();
const rememberReasoningForCall = (callId: string, text: string, scope = REPLAY_SCOPE): void =>
  rememberReasoningForCallRaw(callId, text, scope);
const peekReasoningForCall = (callId: string, scope = REPLAY_SCOPE): string | undefined =>
  peekReasoningForCallRaw(callId, scope);

function configFor(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "key",
        models: ["deepseek-v4-flash"],
      },
    },
  };
}

function wireFor(
  input: unknown[],
  scope: OcxReasoningReplayScopeRef | null = REPLAY_SCOPE,
): { messages: Array<Record<string, unknown>> } {
  const parsed = parseRequest({ model: MODEL, input, stream: true });
  if (scope !== null) {
    parsed._clientThreadId = scope.clientThreadId;
    parsed._reasoningReplayScope = scope;
  }
  const route = routeModel(configFor(), parsed.modelId);
  parsed.modelId = route.modelId;
  const req = createOpenAIChatAdapter(route.provider).buildRequest(parsed as OcxParsedRequest);
  return JSON.parse(req.body as string) as { messages: Array<Record<string, unknown>> };
}

const userMessage = () => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "inspect the repo" }],
});

const reasoningItem = () => ({
  type: "reasoning",
  id: "rs_1",
  summary: [],
  content: [{ type: "reasoning_text", text: REASONING }],
});

const functionCallItem = () => ({
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "read_file",
  arguments: '{"path":"README.md"}',
});

const functionCallOutputItem = () => ({
  type: "function_call_output",
  call_id: "call_1",
  output: "contents",
});

function toolCallAssistant(messages: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return messages.find(m => m.role === "assistant" && Array.isArray(m.tool_calls));
}

describe("issue #950 — tool-call reasoning replay invariant (openai-chat wire)", () => {
  beforeEach(() => {
    clearReasoningReplayCacheForTests();
  });
  afterEach(() => {
    clearReasoningReplayCacheForTests();
  });

  test("CONTROL: canonical full-history tool round keeps reasoning_content", () => {
    const { messages } = wireFor([userMessage(), reasoningItem(), functionCallItem(), functionCallOutputItem()]);
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBe(REASONING);
  });

  test("GAP A: reasoning item arriving AFTER its function_call is attached to its turn", () => {
    // Reconstructed histories (resume/retry/synthetic) may order the reasoning
    // item after the call it belongs to. The parser used to clear the pending
    // buffer at function_call_output and serialize the turn bare.
    const { messages } = wireFor([userMessage(), functionCallItem(), reasoningItem(), functionCallOutputItem()]);
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBe(REASONING);
  });

  test("GAP B: tool round surviving compaction without its reasoning sibling is re-attached from the replay cache", () => {
    // Mid-turn/remote compaction drops all Reasoning items while the open tool
    // round (function_call + output) can survive in the in-flight input. The
    // bridge recorded the reasoning under the call id on the original turn.
    rememberReasoningForCall("call_1", REASONING);
    const { messages } = wireFor([
      userMessage(),
      { type: "compaction", encrypted_content: "ocx1:c3VtbWFyeQ==" },
      functionCallItem(),
      functionCallOutputItem(),
    ]);
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBe(REASONING);
  });

  test("GAP C: orphan tool result (lost assistant turn) is repaired WITH the recorded reasoning", () => {
    // When previous_response_id expansion misses or history loses the assistant
    // turn, the adapter's orphan repair synthesizes an assistant tool_call; it
    // must carry the reasoning recorded for that call id — and keep carrying it
    // on a retry of the same continuation (peek is non-destructive).
    rememberReasoningForCall("call_1", REASONING);
    const first = toolCallAssistant(wireFor([userMessage(), functionCallOutputItem()]).messages);
    const retry = toolCallAssistant(wireFor([userMessage(), functionCallOutputItem()]).messages);
    expect(first).toBeDefined();
    expect(first!["reasoning_content"]).toBe(REASONING);
    expect(retry).toBeDefined();
    expect(retry!["reasoning_content"]).toBe(REASONING);
  });

  test("cross-request replay isolates threads and rejects an unscoped producer/consumer pair", () => {
    const threadA = replayScope("thread-a");
    const threadB = replayScope("thread-b");
    rememberReasoningForCallRaw("call_1", "thread alpha reasoning", threadA);
    rememberReasoningForCallRaw("call_1", "thread beta reasoning", threadB);
    const unscopedProducer: AdapterEvent[] = [
      { type: "reasoning_raw_delta", text: "unrelated private reasoning" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done" },
    ];
    buildResponseJSON(unscopedProducer, "routed/model", {});
    const input = [
      userMessage(),
      { type: "compaction", encrypted_content: "ocx1:c3VtbWFyeQ==" },
      functionCallItem(),
      functionCallOutputItem(),
    ];
    const alpha = toolCallAssistant(wireFor(input, threadA).messages);
    const beta = toolCallAssistant(wireFor(input, threadB).messages);
    const unscoped = toolCallAssistant(wireFor(input, null).messages);
    expect(alpha?.reasoning_content).toBe("thread alpha reasoning");
    expect(beta?.reasoning_content).toBe("thread beta reasoning");
    expect(unscoped?.reasoning_content).toBe(" ");
  });

  test("GAP D (issue #1193): replay cache MISS on the main assistant path injects a placeholder", () => {
    // The replay cache is bounded (64 entries / 256 KiB / 1 h TTL) and always
    // misses on long sessions. DeepSeek thinking mode rejects ANY tool_call
    // assistant message without reasoning_content (HTTP 400), so a cache miss
    // must degrade to a minimal placeholder instead of a bare continuation.
    const { messages } = wireFor([
      userMessage(),
      { type: "compaction", encrypted_content: "ocx1:c3VtbWFyeQ==" },
      functionCallItem(),
      functionCallOutputItem(),
    ]);
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBe(" ");
  });

  test("GAP E (issue #1193): replay cache MISS on the orphan-repair path injects a placeholder", () => {
    // Same invariant for the synthesized orphan tool_call: with nothing
    // recorded under the call id, repair still must not emit a bare
    // continuation a thinking-mode provider will 400 on.
    const { messages } = wireFor([userMessage(), functionCallOutputItem()]);
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBe(" ");
  });

  test("negative control: models outside preserveReasoningContentModels never get a placeholder", () => {
    // The placeholder fallback is scoped to thinking-mode providers; other
    // models keep the previous bare-continuation behavior. Use a custom
    // provider so no registry preset seeds a preserve list.
    const parsed = parseRequest({ model: "custom-chat/plain-model", input: [userMessage(), functionCallOutputItem()], stream: true });
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "custom-chat",
      providers: {
        "custom-chat": {
          adapter: "openai-chat",
          baseUrl: "https://example.invalid/v1",
          apiKey: "key",
          models: ["plain-model"],
        },
      },
    };
    const route = routeModel(config, parsed.modelId);
    parsed.modelId = route.modelId;
    const req = createOpenAIChatAdapter(route.provider).buildRequest(parsed as OcxParsedRequest);
    const { messages } = JSON.parse(req.body as string) as { messages: Array<Record<string, unknown>> };
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBeUndefined();
  });

  test("P2 guard: preserve-listed providers with toggleable thinking opt out of the placeholder (MiniMax)", () => {
    // MiniMax-M3 low effort maps to thinking disabled, so a legitimate tool
    // round can carry no reasoning; the registry seeds
    // requiresReasoningPlaceholderModels: [] for minimax so a cache miss never
    // fabricates one (chatgpt-codex-connector P2 on #1205). Real recorded
    // reasoning still replays via preserveReasoningContentModels.
    const minimaxWire = (input: unknown[]) => {
      const parsed = parseRequest({ model: "minimax/MiniMax-M3", input, stream: true });
      const minimaxReplayScope = replayScope("test-thread-minimax", {
        providerName: "minimax",
        providerDestinationIdentity: "destination:minimax",
        modelId: "MiniMax-M3",
      });
      parsed._clientThreadId = minimaxReplayScope.clientThreadId;
      parsed._reasoningReplayScope = minimaxReplayScope;
      const config: OcxConfig = {
        port: 10100,
        defaultProvider: "minimax",
        providers: {
          minimax: {
            adapter: "openai-chat",
            baseUrl: "https://api.minimax.io/v1",
            apiKey: "key",
          },
        },
      };
      const route = routeModel(config, parsed.modelId);
      parsed.modelId = route.modelId;
      const req = createOpenAIChatAdapter(route.provider).buildRequest(parsed as OcxParsedRequest);
      return {
        wire: JSON.parse(req.body as string) as { messages: Array<Record<string, unknown>> },
        replayScope: minimaxReplayScope,
      };
    };
    // Cache miss on the orphan-repair path: no fabricated placeholder.
    const missResult = minimaxWire([userMessage(), functionCallOutputItem()]);
    const miss = toolCallAssistant(missResult.wire.messages);
    expect(miss).toBeDefined();
    expect(miss!["reasoning_content"]).toBeUndefined();
    // Cache hit on the same path: the recorded reasoning still replays.
    rememberReasoningForCall("call_1", REASONING, missResult.replayScope);
    const hit = toolCallAssistant(minimaxWire([userMessage(), functionCallOutputItem()]).wire.messages);
    expect(hit).toBeDefined();
    expect(hit!["reasoning_content"]).toBeUndefined();
    expect(hit!["reasoning_details"]).toEqual([
      {
        type: "reasoning.text",
        id: "reasoning-text-1",
        format: "MiniMax-response-v1",
        index: 0,
        text: REASONING,
      },
    ]);
  });

  test("P2 guard: a requires-only custom model never gets a placeholder on the orphan path", () => {
    // requiresReasoningPlaceholderModels narrows which preserve-listed models
    // get a fabricated placeholder. A custom entry listing a model ONLY in the
    // requires list (not in preserveReasoningContentModels) must behave like
    // the main-assistant path, which never serializes reasoning_content for
    // non-preserve models: the synthesized orphan tool_call stays bare
    // (chatgpt-codex-connector P2 on #1205).
    const parsed = parseRequest({ model: "custom-chat/plain-model", input: [userMessage(), functionCallOutputItem()], stream: true });
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "custom-chat",
      providers: {
        "custom-chat": {
          adapter: "openai-chat",
          baseUrl: "https://example.invalid/v1",
          apiKey: "key",
          models: ["plain-model"],
          requiresReasoningPlaceholderModels: ["plain-model"],
        },
      },
    };
    const route = routeModel(config, parsed.modelId);
    parsed.modelId = route.modelId;
    const req = createOpenAIChatAdapter(route.provider).buildRequest(parsed as OcxParsedRequest);
    const { messages } = JSON.parse(req.body as string) as { messages: Array<Record<string, unknown>> };
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBeUndefined();
  });

  test("documented non-bug: opaque encrypted-only reasoning degrades to the placeholder, not invented plaintext", () => {
    // Native (non-ocxr1) encrypted reasoning has no readable text; the parser
    // deliberately degrades instead of inventing replayable plaintext. On a
    // thinking-mode provider the fallback now attaches the minimal placeholder
    // (issue #1193) rather than replaying anything, so the continuation stays
    // valid without fabricating reasoning text.
    const { messages } = wireFor([
      userMessage(),
      { type: "reasoning", id: "rs_1", encrypted_content: "some-opaque-blob" },
      functionCallItem(),
      functionCallOutputItem(),
    ]);
    const assistant = toolCallAssistant(messages);
    expect(assistant).toBeDefined();
    expect(assistant!["reasoning_content"]).toBe(" ");
  });
});

describe("issue #950 — reasoning replay cache bounds", () => {
  beforeEach(() => {
    clearReasoningReplayCacheForTests();
  });
  afterEach(() => {
    clearReasoningReplayCacheForTests();
  });

  test("recorded reasoning is readable under the same call id and does not leak across ids", () => {
    rememberReasoningForCall("call_a", "alpha reasoning");
    rememberReasoningForCall("call_b", "beta reasoning");
    expect(peekReasoningForCall("call_a")).toBe("alpha reasoning");
    expect(peekReasoningForCall("call_b")).toBe("beta reasoning");
    expect(peekReasoningForCall("call_c")).toBeUndefined();
  });

  test("conversation scopes isolate entries with the same call id", () => {
    const threadA = replayScope("thread-a");
    const threadB = replayScope("thread-b");
    rememberReasoningForCall("call_1", "thread alpha reasoning", threadA);
    rememberReasoningForCall("call_1", "thread beta reasoning", threadB);
    expect(peekReasoningForCall("call_1", threadA)).toBe("thread alpha reasoning");
    expect(peekReasoningForCall("call_1", threadB)).toBe("thread beta reasoning");
    // An unscoped read must not see either scoped entry.
    expect(peekReasoningForCallRaw("call_1")).toBeUndefined();
  });

  test("unscoped entries are rejected instead of sharing a process-wide namespace", () => {
    rememberReasoningForCallRaw("call_collision", "private reasoning");
    expect(peekReasoningForCallRaw("call_collision")).toBeUndefined();
    expect(peekReasoningForCallRaw(
      "call_collision",
      "global" as unknown as OcxReasoningReplayScopeRef,
    )).toBeUndefined();
  });

  test("entries expire after the TTL", () => {
    let clock = 1_000;
    clearReasoningReplayCacheForTests(() => clock);
    rememberReasoningForCall("call_ttl", "stale reasoning");
    expect(peekReasoningForCall("call_ttl")).toBe("stale reasoning");
    clock += 60 * 60 * 1000 + 1;
    expect(peekReasoningForCall("call_ttl")).toBeUndefined();
    clearReasoningReplayCacheForTests();
  });

  test("expired entries are swept on the next remember without a peek", () => {
    let clock = 1_000;
    clearReasoningReplayCacheForTests(() => clock);
    rememberReasoningForCall("call_stale", "old reasoning");
    clock += 60 * 60 * 1000 + 1;
    rememberReasoningForCall("call_fresh", "new reasoning");
    expect(peekReasoningForCall("call_stale")).toBeUndefined();
    expect(peekReasoningForCall("call_fresh")).toBe("new reasoning");
    clearReasoningReplayCacheForTests();
  });

  test("older entries are evicted when the entry cap is exceeded", () => {
    for (let i = 0; i < 70; i++) rememberReasoningForCall(`call_${i}`, `reasoning ${i}`);
    const oldest = peekReasoningForCall("call_0");
    // Exactly 70 - 64 = 6 entries must be evicted: call_5 is the last evicted
    // entry and call_6 must survive — proving MAX_ENTRIES is 64, not larger.
    expect(oldest).toBeUndefined();
    expect(peekReasoningForCall("call_5")).toBeUndefined();
    expect(peekReasoningForCall("call_6")).toBe("reasoning 6");
    expect(peekReasoningForCall("call_63")).toBe("reasoning 63");
    expect(peekReasoningForCall("call_69")).toBe("reasoning 69");
  });

  test("oldest valid entries are evicted when their combined size exceeds 256 KiB", () => {
    const chunk = "x".repeat(65 * 1024);
    for (let i = 0; i < 4; i++) rememberReasoningForCall(`call_bytes_${i}`, chunk);
    // 4 x 65 KiB = 260 KiB > 256 KiB: exactly the oldest entry is evicted.
    expect(peekReasoningForCall("call_bytes_0")).toBeUndefined();
    expect(peekReasoningForCall("call_bytes_1")).toBe(chunk);
    expect(peekReasoningForCall("call_bytes_3")).toBe(chunk);
  });

  test("empty and oversized entries are ignored", () => {
    rememberReasoningForCall("", "no id");
    rememberReasoningForCall("call_empty", "");
    expect(peekReasoningForCall("call_empty")).toBeUndefined();
    const huge = "x".repeat(300 * 1024);
    rememberReasoningForCall("call_huge", huge);
    expect(peekReasoningForCall("call_huge")).toBeUndefined();
  });
});
