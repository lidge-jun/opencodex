import { describe, expect, test } from "bun:test";
import { chatCompletionsToResponsesBody, ChatCompletionsRequestError } from "../../src/chat/inbound";
import { parseRequest } from "../../src/responses/parser";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";

/**
 * #5211 case 1. A Chat Completions caller narrows the catalogue with
 * `tool_choice.allowed_tools`, and the translated path used to let that object fall past every
 * branch of `toolChoiceToResponses`: the request kept its full tool list, carried no tool choice
 * at all, and still answered 200. Asserting on the translated body alone would not catch a
 * later regression on the way out, so each case here follows the value into the request the
 * adapter actually sends.
 */

const CHAT_TOOLS = [
  { type: "function", function: { name: "tool_a", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "tool_b", parameters: { type: "object", properties: {} } } },
];

function chatBody(toolChoice: unknown): Record<string, unknown> {
  return {
    model: "mock/test-model",
    messages: [{ role: "user", content: "Call only tool_b." }],
    tools: CHAT_TOOLS,
    tool_choice: toolChoice,
  };
}

function outboundBody(toolChoice: unknown): Record<string, unknown> {
  const translated = chatCompletionsToResponsesBody(chatBody(toolChoice));
  const parsed = parseRequest(translated as never);
  const adapter = createOpenAIChatAdapter({
    adapter: "openai-chat",
    baseUrl: "https://gateway.example.internal/v1",
    apiKey: "k",
  });
  return JSON.parse(adapter.buildRequest(parsed as never).body) as Record<string, unknown>;
}

function outboundToolNames(body: Record<string, unknown>): string[] {
  return (body.tools as Array<{ function?: { name?: string } }>).map(tool => tool.function?.name ?? "");
}

describe("chat tool_choice allowed_tools reaches the outbound request", () => {
  test("a single-tool subset narrows the tools the upstream is offered", () => {
    const body = outboundBody({
      type: "allowed_tools",
      allowed_tools: { mode: "required", tools: [{ type: "function", function: { name: "tool_b" } }] },
    });
    expect(outboundToolNames(body)).toEqual(["tool_b"]);
    expect(body.tool_choice).toBe("required");
  });

  test("a larger subset keeps every allowed tool and drops the rest", () => {
    const body = outboundBody({
      type: "allowed_tools",
      allowed_tools: {
        mode: "auto",
        tools: [
          { type: "function", function: { name: "tool_a" } },
          { type: "function", function: { name: "tool_b" } },
        ],
      },
    });
    expect(outboundToolNames(body).sort()).toEqual(["tool_a", "tool_b"]);
    expect(body.tool_choice).toBe("auto");
  });

  test("the flat entry spelling and a flat choice object are both accepted", () => {
    const nested = chatCompletionsToResponsesBody(chatBody({
      type: "allowed_tools",
      allowed_tools: { mode: "required", tools: [{ type: "function", name: "tool_a" }] },
    }));
    const flat = chatCompletionsToResponsesBody(chatBody({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "tool_a" }],
    }));
    expect(nested.tool_choice)
      .toEqual({ type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "tool_a" }] });
    expect(flat.tool_choice).toEqual(nested.tool_choice);
  });

  test("mode defaults to auto and hosted entries are named by their type", () => {
    const translated = chatCompletionsToResponsesBody(chatBody({
      type: "allowed_tools",
      allowed_tools: { tools: [{ type: "web_search" }] },
    }));
    expect(translated.tool_choice)
      .toEqual({ type: "allowed_tools", mode: "auto", tools: [{ type: "web_search" }] });
  });

  test("an unnameable entry is refused rather than quietly widening the subset", () => {
    expect(() => chatCompletionsToResponsesBody(chatBody({
      type: "allowed_tools",
      allowed_tools: { mode: "required", tools: [{ type: "function", function: {} }] },
    }))).toThrow(ChatCompletionsRequestError);
    expect(() => chatCompletionsToResponsesBody(chatBody({
      type: "allowed_tools",
      allowed_tools: { mode: "required", tools: [] },
    }))).toThrow(ChatCompletionsRequestError);
  });

  test("a selector kind nobody can evaluate is refused", () => {
    expect(() => chatCompletionsToResponsesBody(chatBody({
      type: "allowed_tools",
      allowed_tools: { mode: "required", tools: [{ type: "mcp", name: "tool_a" }] },
    }))).toThrow(/unsupported tool_choice.allowed_tools.tools entry type/);
  });

  test("the existing named and string choices are unchanged", () => {
    expect(chatCompletionsToResponsesBody(chatBody("required")).tool_choice).toBe("required");
    expect(chatCompletionsToResponsesBody(chatBody({ type: "function", function: { name: "tool_a" } })).tool_choice)
      .toEqual({ type: "function", name: "tool_a" });
  });
});
