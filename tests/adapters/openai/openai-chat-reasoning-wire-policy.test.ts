import { describe, expect, test } from "bun:test";
import {
  buildOpenAIChatPassthroughRequest,
  createOpenAIChatAdapter,
} from "../../../src/adapters/openai-chat";
import { chatCompletionsToResponsesBody } from "../../../src/chat/inbound";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxProviderConfig } from "../../../src/types";

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://gateway.example.test/v1",
  apiKey: "sk-test",
  authMode: "key",
  reasoningWireFormat: "gateway-object",
  omitReasoningEffortWithToolsModels: ["reasoning-policy-model"],
};
const modelId = provider.omitReasoningEffortWithToolsModels![0]!;

const input: Record<string, unknown> = {
  model: modelId,
  messages: [{ role: "user", content: "What is the weather?" }],
  reasoning_effort: "none",
};
const tool: Record<string, unknown> = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
};
const inputWithTool: Record<string, unknown> = { ...input, tools: [tool] };

function finalBodies(rawInput: Record<string, unknown>): Record<"translated" | "native", Record<string, unknown>> {
  const parsed = parseRequest(chatCompletionsToResponsesBody(rawInput));
  const translated = createOpenAIChatAdapter(provider).buildRequest(parsed);
  const native = buildOpenAIChatPassthroughRequest(provider, rawInput, modelId, false);

  return {
    translated: JSON.parse(translated.body) as Record<string, unknown>,
    native: JSON.parse(native.body) as Record<string, unknown>,
  };
}

describe("OpenAI Chat reasoning wire policy parity", () => {
  test("plain reasoning disable uses the gateway object on both final wires", () => {
    const bodies = finalBodies(input);
    const projection = Object.fromEntries(Object.entries(bodies).map(([builder, body]) => [
      builder,
      {
        reasoning: body.reasoning,
        hasReasoningEffort: Object.hasOwn(body, "reasoning_effort"),
      },
    ]));

    expect(projection).toEqual({
      translated: { reasoning: { enabled: false }, hasReasoningEffort: false },
      native: { reasoning: { enabled: false }, hasReasoningEffort: false },
    });
  });

  test("a function tool survives while both final wires omit all reasoning fields", () => {
    const bodies = finalBodies(inputWithTool);
    const projection = Object.fromEntries(Object.entries(bodies).map(([builder, body]) => [
      builder,
      {
        tools: body.tools,
        hasReasoning: Object.hasOwn(body, "reasoning"),
        hasReasoningEffort: Object.hasOwn(body, "reasoning_effort"),
      },
    ]));

    expect(projection).toEqual({
      translated: { tools: [tool], hasReasoning: false, hasReasoningEffort: false },
      native: { tools: [tool], hasReasoning: false, hasReasoningEffort: false },
    });
  });
});
