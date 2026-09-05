import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "apiKey" } as unknown as OcxProviderConfig;

function parsed(messages: OcxMessage[]): OcxParsedRequest {
  return {
    modelId: "anthropic/claude-sonnet-4.5",
    stream: false,
    options: {},
    context: { messages },
  };
}

async function bodyOf(p: OcxParsedRequest): Promise<{ messages: Array<{ role: string; content: unknown }> }> {
  const { body } = await createAnthropicAdapter(provider).buildRequest(p);
  return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as { messages: Array<{ role: string; content: unknown }> };
}

describe("anthropic empty content block guard", () => {
  test("user message with empty string content is replaced with placeholder", async () => {
    const body = await bodyOf(parsed([
      { role: "user", content: "", timestamp: 0 },
    ]));
    const msg = body.messages[0] as { role: string; content: string };
    expect(msg.content).toBe("(empty)");
  });

  test("user message with empty text part is filtered out", async () => {
    const body = await bodyOf(parsed([
      { role: "user", content: [{ type: "text", text: "" }], timestamp: 0 },
    ]));
    const msg = body.messages[0] as { role: string; content: string };
    // Empty part filtered -> falls back to placeholder string
    expect(msg.content).toBe("(empty)");
  });

  test("user message with mixed empty and non-empty parts keeps only non-empty", async () => {
    const body = await bodyOf(parsed([
      { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "hello" }], timestamp: 0 },
    ]));
    const msg = body.messages[0] as { role: string; content: Array<{ type: string; text: string }> };
    expect(msg.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("assistant message with empty text part is dropped silently", async () => {
    const body = await bodyOf(parsed([
      { role: "user", content: "start", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "visible" }], model: "claude", timestamp: 0 },
    ]));
    const assistantMsg = body.messages.find(m => (m as { role: string }).role === "assistant") as { content: Array<{ type: string; text?: string }> };
    expect(assistantMsg.content).toEqual([{ type: "text", text: "visible" }]);
  });

  test("tool result with empty string content gets a placeholder", async () => {
    const body = await bodyOf(parsed([
      { role: "user", content: "start", timestamp: 0 },
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "run", arguments: {} }], model: "claude", timestamp: 0 },
      { role: "toolResult", toolCallId: "tc1", toolName: "run", content: "", isError: false, timestamp: 0 },
    ]));
    const toolResultMsg = body.messages.find(m => {
      const content = (m as { content?: unknown[] }).content;
      return Array.isArray(content) && content.some((c: { type?: string }) => c.type === "tool_result");
    }) as { content: Array<{ type: string; content?: string }> };
    const toolResult = toolResultMsg.content.find((c: { type: string }) => c.type === "tool_result") as { content: string };
    expect(toolResult.content).toBe("(empty tool output)");
  });
});
