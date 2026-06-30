import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { createGoogleAdapter } from "../src/adapters/google";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

describe("adapter reasoning and usage details", () => {
  test("OpenAI-compatible non-streaming maps reasoning_content and usage details", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const events = await adapter.parseResponse?.(new Response(JSON.stringify({
      choices: [{ message: { reasoning_content: "raw thoughts", content: "answer" } }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    })));

    expect(events).toContainEqual({ type: "reasoning_raw_delta", text: "raw thoughts" });
    expect(events).toContainEqual({ type: "text_delta", text: "answer" });
    expect(events?.at(-1)).toEqual({
      type: "done",
      usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 5, reasoningOutputTokens: 3 },
    });
  });

  test("OpenAI-compatible streaming maps reasoning_content and usage details", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const response = new Response([
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"raw stream\"}}]}\n\n",
      "data: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4,\"prompt_tokens_details\":{\"cached_tokens\":2},\"completion_tokens_details\":{\"reasoning_tokens\":1}}}\n\n",
      "data: [DONE]\n\n",
    ].join(""));

    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);

    expect(events).toContainEqual({ type: "reasoning_raw_delta", text: "raw stream" });
    expect(events.at(-1)).toEqual({
      type: "done",
      usage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2, reasoningOutputTokens: 1 },
    });
  });

  test("Anthropic usage maps cache tokens only when present", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const events = await adapter.parseResponse?.(new Response(JSON.stringify({
      content: [{ type: "text", text: "answer" }],
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 6,
      },
    })));

    expect(events?.at(-1)).toEqual({
      type: "done",
      usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 10 },
    });
  });

  test("Anthropic usage does not fabricate cache tokens when absent", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const events = await adapter.parseResponse?.(new Response(JSON.stringify({
      content: [{ type: "text", text: "answer" }],
      usage: { input_tokens: 20, output_tokens: 8 },
    })));

    expect(events?.at(-1)).toEqual({
      type: "done",
      usage: { inputTokens: 20, outputTokens: 8 },
    });
  });

  test("Google usage maps cached and thoughts tokens when present", async () => {
    const adapter = createGoogleAdapter({ ...provider, adapter: "google" });
    const events = await adapter.parseResponse?.(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "answer" }] } }],
      usageMetadata: {
        promptTokenCount: 13,
        candidatesTokenCount: 5,
        cachedContentTokenCount: 3,
        thoughtsTokenCount: 2,
      },
    })));

    expect(events?.at(-1)).toEqual({
      type: "done",
      usage: { inputTokens: 13, outputTokens: 5, cachedInputTokens: 3, reasoningOutputTokens: 2 },
    });
  });
});

describe("usage and content retention (F2)", () => {
  test("openai-chat keeps content when usage and choices share one chunk", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"final"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join(""));
    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    expect(events).toContainEqual({ type: "text_delta", text: "final" });
    expect(events.at(-1)).toEqual({ type: "done", usage: { inputTokens: 3, outputTokens: 2 } });
  });

  test("openai-chat retains usage on EOF without [DONE]", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n',
    ].join(""));
    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    expect(events.at(-1)).toEqual({ type: "done", usage: { inputTokens: 5, outputTokens: 1 } });
  });

  test("anthropic stream merges message_start input usage with message_delta output usage", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const response = new Response([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ].join(""));

    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    const dones = events.filter(e => e.type === "done");
    expect(events).toContainEqual({ type: "text_delta", text: "hi" });
    expect(dones).toHaveLength(1);
    expect(dones[0]).toEqual({
      type: "done",
      usage: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 5 },
    });
  });

  test("anthropic stream emits terminal usage on EOF when message_stop is missing", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const response = new Response([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
    ].join(""));

    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    expect(events.at(-1)).toEqual({ type: "done", usage: { inputTokens: 7, outputTokens: 1 } });
  });

  test("google emits exactly one done carrying usage", async () => {
    const adapter = createGoogleAdapter({ ...provider, adapter: "google" });
    const response = new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\n\n',
    );
    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    const dones = events.filter(e => e.type === "done");
    expect(dones.length).toBe(1);
    expect(dones[0]).toEqual({ type: "done", usage: { inputTokens: 4, outputTokens: 2 } });
  });
});

describe("openai-chat tool history repair", () => {
  test("inserts a synthetic assistant tool_call before orphan tool results", () => {
    const adapter = createOpenAIChatAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "deepseek-v4",
      context: {
        messages: [{
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "codex.list_mcp_resources",
          content: '{"resources":[]}',
          isError: false,
          timestamp: 0,
        }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Record<string, unknown>[] };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "codex_list_mcp_resources", arguments: "{}" },
      }],
    });
    expect(body.messages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"resources":[]}',
    });
  });

  test("keeps paired tool results attached to the prior assistant tool_call", () => {
    const adapter = createOpenAIChatAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "deepseek-v4",
      context: {
        messages: [
          {
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "call_1",
              name: "read_file",
              arguments: { path: "README.md" },
            }],
            model: "deepseek-v4",
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
        ],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Record<string, unknown>[] };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({
      role: "assistant",
      tool_calls: [{
        id: "call_1",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
      }],
    });
    expect(body.messages[1]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });
});

describe("anthropic tool result history repair", () => {
  test("merges adjacent tool results after multiple tool uses into one user message", () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = adapter.buildRequest({
      modelId: "claude-sonnet",
      context: {
        messages: [
          { role: "user", content: "start", timestamp: 0 },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call_1", name: "first_tool", arguments: {} },
              { type: "toolCall", id: "call_2", name: "second_tool", arguments: {} },
            ],
            model: "claude-sonnet",
            timestamp: 0,
          },
          { role: "toolResult", toolCallId: "call_1", toolName: "first_tool", content: "one", isError: false, timestamp: 0 },
          { role: "toolResult", toolCallId: "call_2", toolName: "second_tool", content: "two", isError: false, timestamp: 0 },
          { role: "user", content: "continue", timestamp: 0 },
        ],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: any }> };

    expect(body.messages).toHaveLength(4);
    expect(body.messages[2].role).toBe("user");
    expect(body.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: "one" },
      { type: "tool_result", tool_use_id: "call_2", content: "two" },
    ]);
  });

  test("adds an error tool result when history is missing a tool result", () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = adapter.buildRequest({
      modelId: "claude-sonnet",
      context: {
        messages: [{
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: {} }],
          model: "claude-sonnet",
          timestamp: 0,
        }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: any }> };

    expect(body.messages[1]).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call_1",
        content: "[missing tool_result for this tool_use in history]",
        is_error: true,
      }],
    });
  });

  test("preserves orphan tool results as text instead of invalid Anthropic tool_result blocks", () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = adapter.buildRequest({
      modelId: "claude-sonnet",
      context: {
        messages: [{
          role: "toolResult",
          toolCallId: "orphan_call",
          toolName: "lost_tool",
          content: "orphan output",
          isError: false,
          timestamp: 0,
        }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: string }> };

    expect(body.messages).toEqual([{
      role: "user",
      content: "[tool_result without adjacent tool_use: lost_tool (orphan_call)]\norphan output",
    }]);
  });

  test("preserves duplicate adjacent tool results as text after the matching result", () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = adapter.buildRequest({
      modelId: "claude-sonnet",
      context: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: {} }],
            model: "claude-sonnet",
            timestamp: 0,
          },
          { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "first", isError: false, timestamp: 0 },
          { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: "duplicate", isError: false, timestamp: 0 },
        ],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: any }> };

    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "first" },
        { type: "text", text: "[tool_result without adjacent tool_use: read_file (call_1)]\nduplicate" },
      ],
    });
  });

  test("maps non-string tool result content through Anthropic content blocks", () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = adapter.buildRequest({
      modelId: "claude-sonnet",
      context: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "view_image", arguments: {} }],
            model: "claude-sonnet",
            timestamp: 0,
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "view_image",
            content: [
              { type: "text", text: "image attached" },
              { type: "image", imageUrl: "data:image/png;base64,AAAA", detail: "high" },
            ],
            isError: false,
            timestamp: 0,
          },
        ],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: any }> };

    expect(body.messages[1]).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call_1",
        content: [
          { type: "text", text: "image attached" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      }],
    });
  });
});
