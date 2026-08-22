import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { createRegisteredAdapter } from "../src/adapters/registry";
import {
  stripClinePassDeepSeekV4ToolReplayNarration,
} from "../src/adapters/cline-pass-deepseek-v4-tool-replay";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const TARGET_MODELS = [
  "cline-pass/deepseek-v4-flash",
  "cline-pass/deepseek-v4-pro",
] as const;

const provider = {
  adapter: "openai-chat",
  baseUrl: "https://api.cline.bot/api/v1",
  authMode: "key",
  apiKey: "test-key",
} satisfies OcxProviderConfig;

function parsedWithHybridToolTurn(modelId: string): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    options: {},
    context: {
      tools: [{
        name: "exec",
        description: "Execute a command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should inspect the repository first." },
            { type: "text", text: "Let me run that now." },
            {
              type: "toolCall",
              id: "call_exec_1",
              name: "exec",
              arguments: { command: "git status --short" },
            },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_exec_1",
          toolName: "exec",
          content: "clean",
          isError: false,
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "The repository is clean." }],
          timestamp: 3,
        },
        {
          role: "user",
          content: "Continue.",
          timestamp: 4,
        },
      ],
    },
  };
}

function incoming() {
  return {
    headers: new Headers(),
    translatorBudget: createTestTranslatorBudget(),
  };
}

async function outboundMessages(modelId: string): Promise<Array<Record<string, unknown>>> {
  const adapter = createRegisteredAdapter(provider);
  const request = await adapter.buildRequest(parsedWithHybridToolTurn(modelId), incoming());
  const body = JSON.parse(request.body) as { messages?: Array<Record<string, unknown>> };
  return body.messages ?? [];
}

describe("ClinePass DeepSeek V4 tool-call history replay", () => {
  test.each(TARGET_MODELS)("strips historical assistant narration for %s while preserving the tool call", async modelId => {
    const messages = await outboundMessages(modelId);
    const toolTurn = messages.find(message => Array.isArray(message.tool_calls));

    expect(toolTurn).toBeDefined();
    expect(toolTurn?.content).toBe("");
    expect(toolTurn?.tool_calls).toEqual([{
      id: "call_exec_1",
      type: "function",
      function: {
        name: "exec",
        arguments: JSON.stringify({ command: "git status --short" }),
      },
    }]);

    const toolResult = messages.find(message => message.role === "tool");
    expect(toolResult?.tool_call_id).toBe("call_exec_1");
    expect(toolResult?.content).toBe("clean");

    const finalAssistant = messages.find(message => message.role === "assistant" && message.content === "The repository is clean.");
    expect(finalAssistant).toBeDefined();
  });

  test("leaves non-target OpenAI-chat requests byte-identical", async () => {
    const parsed = parsedWithHybridToolTurn("cline-pass/not-deepseek-v4");
    const plainRequest = await createOpenAIChatAdapter(provider).buildRequest(parsed, incoming());
    const wrappedRequest = await createRegisteredAdapter(provider).buildRequest(parsed, incoming());

    expect(wrappedRequest.body).toBe(plainRequest.body);
  });

  test("keeps reasoning metadata when stripping a target tool turn", () => {
    const input = JSON.stringify({
      messages: [{
        role: "assistant",
        content: "Let me call the tool.",
        reasoning_content: "private reasoning",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "exec", arguments: "{}" },
        }],
      }],
    });

    const output = stripClinePassDeepSeekV4ToolReplayNarration(
      input,
      "cline-pass/deepseek-v4-flash",
    );
    const body = JSON.parse(output) as { messages: Array<Record<string, unknown>> };

    expect(body.messages[0]?.content).toBe("");
    expect(body.messages[0]?.reasoning_content).toBe("private reasoning");
    expect(body.messages[0]?.tool_calls).toEqual([{
      id: "call_1",
      type: "function",
      function: { name: "exec", arguments: "{}" },
    }]);
  });
});
