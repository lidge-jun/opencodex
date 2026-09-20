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
  test("keeps interleaved developer reminders in their original slots", () => {
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
      content: "base instructions",
    });
    expect(messages.map(message => message.role))
      .toEqual(["system", "user", "developer", "assistant", "developer", "user"]);
    expect(messages[2]).toEqual({ role: "developer", content: "first reminder" });
    expect(messages[4]).toEqual({ role: "developer", content: "second reminder" });
  });

  test("defers a reminder past a pending tool result instead of hoisting it", () => {
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

    // The reminder arrived while call_1 was open. Emitting it there would break tool-call
    // adjacency, so it is released immediately after the result rather than moved to the front.
    expect(messages.map(message => message.role)).toEqual(["user", "assistant", "tool", "developer"]);
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(messages[3]).toEqual({ role: "developer", content: "remember the policy" });
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

describe("chronological in-conversation system messages", () => {
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
    expect(first.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user", "assistant", "developer"]);
    expect(first.messages[0].content).not.toContain("Synthetic reminder A.");
    expect(first.messages.at(-1)).toEqual({ role: "developer", content: "Synthetic reminder A." });
    expect(next.messages.at(-1)).toEqual({ role: "developer", content: "Synthetic reminder B." });
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
    expect(body.messages[callIndex + 2]).toEqual({ role: "developer", content: "Reminder during pending tool." });
  });

  test.each([
    "https://opencode.ai/zen/go/v1/",
    "https://opencode.ai:443/zen/go/v1",
  ])("keeps the reminder last on the canonical OpenCode Go destination %s", baseUrl => {
    expect(build(history, { ...ocg, baseUrl }).messages.at(-1).role).toBe("developer");
  });

  test.each([
    "https://opencode.ai.example.invalid/zen/go/v1",
    "https://opencode.ai/zen/v1",
    "https://opencode.ai:444/zen/go/v1",
    "http://opencode.ai/zen/go/v1",
    "http://localhost:1234/v1",
  ])("keeps the same chronological placement on other destinations: %s", baseUrl => {
    const messages = build(history, { ...ocg, baseUrl }).messages;
    expect(messages[0].content).not.toContain("Synthetic reminder A.");
    expect(messages.map((message: { role: string }) => message.role))
      .toEqual(["system", "user", "assistant", "developer"]);
    expect(messages.at(-1)).toEqual({ role: "developer", content: "Synthetic reminder A." });
  });

  test("placement no longer depends on the model either", () => {
    const messages = build(history, ocg, "kimi-k3").messages;
    expect(messages[0].content).not.toContain("Synthetic reminder A.");
    expect(messages.at(-1)).toEqual({ role: "developer", content: "Synthetic reminder A." });
  });

  test("the native OpenAI wire is unchanged", () => {
    const messages = build(history, { ...ocg, baseUrl: "https://api.openai.com/v1" }).messages;
    expect(messages[0].content).not.toContain("Synthetic reminder A.");
    expect(messages.at(-1)).toEqual({ role: "developer", content: "Synthetic reminder A." });
  });

  test("a destination that rejects the role folds it in place", () => {
    const messages = build(history, { ...ocg, foldDeveloperRoleToSystem: true }).messages;
    expect(messages.map((message: { role: string }) => message.role))
      .toEqual(["system", "user", "assistant", "system"]);
    expect(messages[0].content).not.toContain("Synthetic reminder A.");
    expect(messages.at(-1)).toEqual({ role: "system", content: "Synthetic reminder A." });
  });

  test("drops a non-text timeline message instead of emitting an empty system message", () => {
    const context = {
      messages: [
        { role: "user", content: "Inspect the synthetic project.", timestamp: 0 },
        { role: "developer", content: [{ type: "video", videoUrl: "data:video/mp4;base64,AA==" }], timestamp: 0 },
      ],
    } as unknown as OcxParsedRequest["context"];
    const request = (target: OcxProviderConfig) => JSON.parse(createOpenAIChatAdapter(target).buildRequest({
      modelId: model,
      context,
      stream: false,
      options: {},
    } as unknown as Parameters<ReturnType<typeof createOpenAIChatAdapter>["buildRequest"]>[0]).body) as {
      messages: Array<Record<string, unknown>>;
    };

    // The generic serializer drops this message, so the chronological exception
    // must not introduce a content-free system message on the OCG route.
    expect(request(ocg).messages).toEqual([{ role: "user", content: "Inspect the synthetic project." }]);
    expect(request({ ...ocg, baseUrl: "http://localhost:1234/v1" }).messages)
      .toEqual([{ role: "user", content: "Inspect the synthetic project." }]);
  });
});
