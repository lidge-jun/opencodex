import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "http://localhost:1234/v1",
  apiKey: "local",
};

function buildMessages(context: OcxParsedRequest["context"]): Array<Record<string, unknown>> {
  const request = createOpenAIChatAdapter(provider).buildRequest({
    modelId: "local-model",
    context,
    stream: false,
    options: {},
  });
  return (JSON.parse(request.body) as { messages: Array<Record<string, unknown>> }).messages;
}

describe("openai-chat system message ordering", () => {
  test("folds interleaved developer reminders into one leading system message", () => {
    const messages = buildMessages({
      systemPrompt: ["base instructions"],
      messages: [
        { role: "user", content: "hello", timestamp: 0 },
        { role: "developer", content: "first reminder", timestamp: 0 },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          model: "local-model",
          timestamp: 0,
        },
        {
          role: "developer",
          content: [{ type: "text", text: "second reminder" }],
          timestamp: 0,
        },
        { role: "user", content: "continue", timestamp: 0 },
      ],
    });

    expect(messages[0]).toEqual({
      role: "system",
      content: "base instructions\n\nfirst reminder\n\nsecond reminder",
    });
    expect(messages.slice(1).map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages.slice(1).some(message => message.role === "system")).toBe(false);
  });

  test("keeps tool calls and results adjacent when a developer reminder follows the call", () => {
    const messages = buildMessages({
      messages: [
        { role: "user", content: "inspect", timestamp: 0 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: {} }],
          model: "local-model",
          timestamp: 0,
        },
        { role: "developer", content: "remember the policy", timestamp: 0 },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read_file",
          content: "contents",
          isError: false,
          timestamp: 0,
        },
      ],
    });

    expect(messages[0]).toEqual({ role: "system", content: "remember the policy" });
    expect(messages.map(message => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });

  test("keeps developer vision content as a user-compatible message in place", () => {
    const messages = buildMessages({
      messages: [
        { role: "user", content: "before", timestamp: 0 },
        {
          role: "developer",
          content: [
            { type: "text", text: "inspect this" },
            { type: "image", imageUrl: "data:image/png;base64,AA==", detail: "low" },
          ],
          timestamp: 0,
        },
        { role: "user", content: "after", timestamp: 0 },
      ],
    });

    expect(messages.map(message => message.role)).toEqual(["user", "user", "user"]);
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "inspect this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "low" } },
      ],
    });
  });
});
