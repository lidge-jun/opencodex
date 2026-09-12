import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { anthropicToResponsesBody } from "../../../src/claude/inbound";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

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

describe("OpenCode Go DeepSeek chronological system messages", () => {
  const model = "deepseek-v4.1-flash";
  const ocg: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://opencode.ai/zen/go/v1",
    preserveReasoningContentModels: [model],
  };
  const history = [
    { role: "user", content: "Inspect the synthetic project." },
    { role: "assistant", content: "First result." },
    { role: "system", content: "Synthetic reminder A." },
  ];
  function build(messages: unknown[], target = ocg, modelId = model, stabilize = false) {
    const parsed = parseRequest(anthropicToResponsesBody({
      model: modelId,
      system: "Stable project instructions.",
      max_tokens: 100,
      stream: true,
      messages,
      tools: [{
        name: "read_file",
        description: "Read a synthetic file.",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      }],
    }, { stabilizePromptCache: stabilize }));
    return JSON.parse(createOpenAIChatAdapter(target).buildRequest(parsed).body);
  }

  test.each([false, true])("appending a reminder preserves the serialized history prefix (stabilize=%s)", stabilize => {
    const first = build(history, ocg, model, stabilize);
    const next = build([
      ...history,
      { role: "assistant", content: "Second result." },
      { role: "user", content: "Continue." },
      { role: "system", content: "Synthetic reminder B." },
    ], ocg, model, stabilize);
    expect(JSON.stringify(next.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));
    expect(first.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user", "assistant", "system"]);
    expect(first.messages[0].content).not.toContain("Synthetic reminder A.");
    expect(first.messages.at(-1)).toEqual({ role: "system", content: "Synthetic reminder A." });
    expect(next.messages.at(-1)).toEqual({ role: "system", content: "Synthetic reminder B." });
    expect(next.tools).toEqual(first.tools);
    expect(next.model).toBe(model);
    expect(next.stream).toBe(true);
  });

  test("defers reminders until pending tool results have arrived without losing reasoning", () => {
    const body = build([
      { role: "user", content: "Read the fixture." },
      { role: "assistant", content: [{ type: "tool_use", id: "call_fixture", name: "read_file", input: {} }] },
      { role: "system", content: "Reminder during pending tool." },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_fixture", content: "Fixture result." }] },
    ]);
    const callIndex = body.messages.findIndex((message: { tool_calls?: unknown }) => message.tool_calls);
    expect(callIndex).toBeGreaterThan(0);
    expect(body.messages[callIndex].reasoning_content).toBe(" ");
    expect(body.messages[callIndex + 1]).toMatchObject({ role: "tool", tool_call_id: "call_fixture", content: "Fixture result." });
    expect(body.messages[callIndex + 2]).toEqual({ role: "system", content: "Reminder during pending tool." });
  });

  test.each([
    "https://opencode.ai/zen/go/v1/",
    "https://opencode.ai:443/zen/go/v1",
  ])("matches the canonical destination %s", baseUrl => {
    expect(build(history, { ...ocg, baseUrl }).messages.at(-1).role).toBe("system");
  });

  test.each([
    "https://opencode.ai.example.invalid/zen/go/v1",
    "https://opencode.ai/zen/v1",
    "https://opencode.ai:444/zen/go/v1",
    "http://opencode.ai/zen/go/v1",
    "http://localhost:1234/v1",
  ])("retains generic hoisting for other destinations: %s", baseUrl => {
    const messages = build(history, { ...ocg, baseUrl }).messages;
    expect(messages[0].content).toContain("Synthetic reminder A.");
    expect(messages.map((message: { role: string }) => message.role)).toEqual(["system", "user", "assistant"]);
  });

  test("retains generic hoisting for other OCG models", () => {
    expect(build(history, ocg, "kimi-k3").messages[0].content).toContain("Synthetic reminder A.");
  });

  test("retains native OpenAI developer roles", () => {
    const messages = build(history, { ...ocg, baseUrl: "https://api.openai.com/v1" }).messages;
    expect(messages[0].content).not.toContain("Synthetic reminder A.");
    expect(messages.at(-1)).toEqual({ role: "developer", content: "Synthetic reminder A." });
  });
});
