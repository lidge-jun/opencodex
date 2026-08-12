import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";

const baseProvider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  authMode: "key",
};

function bodyFor(provider: OcxProviderConfig, parsed: OcxParsedRequest): Record<string, unknown> {
  const request = createOpenAIChatAdapter(provider).buildRequest(parsed) as { body: string };
  return JSON.parse(request.body) as Record<string, unknown>;
}

function assistantToolCall(id: string, name: string): OcxMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    timestamp: 0,
  };
}

test("native OpenAI defers developer guidance until pending tool results are complete", () => {
  const parsed: OcxParsedRequest = {
    modelId: "gpt-test",
    context: {
      messages: [
        { role: "user", content: "go", timestamp: 0 },
        assistantToolCall("call_1", "lookup"),
        { role: "developer", content: "after the tool", timestamp: 0 },
        { role: "toolResult", toolCallId: "call_1", toolName: "lookup", content: "ok", isError: false, timestamp: 0 },
      ],
    },
    stream: false,
    options: {},
  };

  const messages = bodyFor(baseProvider, parsed).messages as Array<Record<string, unknown>>;
  const assistantIndex = messages.findIndex((m) => m.role === "assistant");
  expect(messages[assistantIndex + 1]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  expect(messages[assistantIndex + 2]).toEqual({ role: "developer", content: "after the tool" });
});

test("native OpenAI Chat uses reasoning_effort instead of the gateway reasoning object", () => {
  const provider: OcxProviderConfig = {
    ...baseProvider,
    reasoningWireFormat: "gateway-object",
    reasoningEffortMap: { high: "high", none: "none" },
  };
  const parsed: OcxParsedRequest = {
    modelId: "gpt-test",
    context: { messages: [{ role: "user", content: "think", timestamp: 0 }] },
    stream: false,
    options: { reasoning: "high" },
  };

  const body = bodyFor(provider, parsed);
  expect(body.reasoning_effort).toBe("high");
  expect(body.reasoning).toBeUndefined();
});

test("native OpenAI Chat represents disabled reasoning with reasoning_effort none", () => {
  const provider: OcxProviderConfig = {
    ...baseProvider,
    reasoningWireFormat: "gateway-object",
    reasoningEffortMap: { none: "none" },
  };
  const parsed: OcxParsedRequest = {
    modelId: "gpt-test",
    context: { messages: [{ role: "user", content: "short", timestamp: 0 }] },
    stream: false,
    options: { reasoning: "none" },
  };

  const body = bodyFor(provider, parsed);
  expect(body.reasoning_effort).toBe("none");
  expect(body.reasoning).toBeUndefined();
});

test("non-native gateway targets keep their reasoning object", () => {
  const provider: OcxProviderConfig = {
    ...baseProvider,
    baseUrl: "https://gateway.example.test/v1",
    reasoningWireFormat: "gateway-object",
    reasoningEffortMap: { high: "adaptive" },
  };
  const parsed: OcxParsedRequest = {
    modelId: "fixture-model",
    context: { messages: [{ role: "user", content: "think", timestamp: 0 }] },
    stream: false,
    options: { reasoning: "high" },
  };

  const body = bodyFor(provider, parsed);
  expect(body.reasoning).toEqual({ enabled: true, effort: "adaptive" });
  expect(body.reasoning_effort).toBeUndefined();
});

test("paired image-only tool results retain their flattened tool-row fallback", () => {
  const parsed: OcxParsedRequest = {
    modelId: "gpt-test",
    context: {
      messages: [
        assistantToolCall("call_img", "shot"),
        {
          role: "toolResult",
          toolCallId: "call_img",
          toolName: "shot",
          content: [{ type: "image", imageUrl: "data:image/png;base64,aGVsbG8=" }],
          isError: false,
          timestamp: 0,
        },
      ],
    },
    stream: false,
    options: {},
  };

  const messages = bodyFor({ ...baseProvider, baseUrl: "https://example.test/v1" }, parsed).messages as Array<Record<string, unknown>>;
  expect(messages.find((m) => m.role === "tool")?.content).toBe("[image]");
});
