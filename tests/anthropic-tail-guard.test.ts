import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "apiKey" } as unknown as OcxProviderConfig;

function parsed(messages: OcxMessage[]): OcxParsedRequest {
  return {
    modelId: "anthropic/claude-sonnet-4.5",
    stream: false,
    options: {},
    context: { messages },
  };
}

function bodyOf(p: OcxParsedRequest): { messages: Array<{ role: string; content: unknown }> } {
  const { body } = createAnthropicAdapter(provider).buildRequest(p);
  return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as { messages: Array<{ role: string; content: unknown }> };
}

describe("anthropic tail guard", () => {
  test("appends a user continue nudge when context ends with assistant text", () => {
    const body = bodyOf(parsed([
      { role: "user", content: "start", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "partial answer" }], model: "claude", timestamp: 0 },
    ]));

    expect(body.messages.at(-1)).toEqual({ role: "user", content: "(continue)" });
  });

  test("leaves context ending with user unchanged", () => {
    const body = bodyOf(parsed([
      { role: "assistant", content: [{ type: "text", text: "answer" }], model: "claude", timestamp: 0 },
      { role: "user", content: "follow up", timestamp: 0 },
    ]));

    expect(body.messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: "follow up" },
    ]);
  });

  test("turns empty context messages into a single user continue nudge", () => {
    const body = bodyOf(parsed([]));

    expect(body.messages).toEqual([{ role: "user", content: "(continue)" }]);
  });

  test("does not append a nudge after an assistant tool call followed by a tool result", () => {
    const body = bodyOf(parsed([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "README.md" } }],
        model: "claude",
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read_file",
        content: "contents",
        isError: false,
        timestamp: 0,
      },
    ]));

    expect(body.messages).toHaveLength(2);
    expect(body.messages.at(-1)?.role).toBe("user");
    expect(JSON.stringify(body.messages.at(-1))).not.toContain("(continue)");
  });
});
