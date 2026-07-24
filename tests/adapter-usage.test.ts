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

  test("OpenAI-compatible non-OpenAI providers receive the tool catalog nudge", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const request = await adapter.buildRequest({
      modelId: "kimi-k2.7-code",
      context: {
        messages: [{ role: "user", content: "run a command" }],
        tools: [{ name: "exec_command", description: "Run", parameters: { type: "object" } }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: string }> };

    expect(body.messages[0]).toMatchObject({ role: "system" });
    expect(body.messages[0].content).toContain("Tool contract: use the current tool catalog as ground truth.");
    expect(body.messages[0].content).toContain("Valid tool names for this turn are exactly `exec_command`.");
  });

  test("OpenAI-compatible OpenAI hosts do not receive the non-OpenAI nudge", async () => {
    const adapter = createOpenAIChatAdapter({ ...provider, baseUrl: "https://api.openai.com/v1" });
    const request = await adapter.buildRequest({
      modelId: "gpt-5.5",
      context: {
        messages: [{ role: "user", content: "run a command" }],
        tools: [{ name: "exec_command", description: "Run", parameters: { type: "object" } }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: string }> };

    expect(body.messages[0]).toMatchObject({ role: "user", content: "run a command" });
    expect(JSON.stringify(body.messages)).not.toContain("Tool contract: use the current tool catalog as ground truth.");
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
      usage: {
        // canonical convention: inputTokens is inclusive of cache read + write
        inputTokens: 30,
        outputTokens: 8,
        cachedInputTokens: 4,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 6,
      },
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

  test("Anthropic API-key requests mark system prompt as cacheable", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic", baseUrl: "https://api.anthropic.com" });
    const request = await adapter.buildRequest({
      modelId: "claude-opus-4-1",
      context: {
        systemPrompt: ["stable project instructions"],
        messages: [{ role: "user", content: "hi" }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { system: unknown; messages: Array<{ content: unknown }>; cache_control?: unknown };

    // Native Anthropic gets top-level automatic caching plus stable explicit breakpoints.
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.system).toEqual([{
      type: "text",
      text: "stable project instructions",
      cache_control: { type: "ephemeral" },
    }]);
    // The moving final user block is handled by top-level automatic caching.
    expect(body.messages[0].content).toBe("hi");
  });

  test("Anthropic OAuth requests keep Claude identity first and cache user system prompt", async () => {
    const adapter = createAnthropicAdapter({
      ...provider,
      adapter: "anthropic",
      authMode: "oauth",
      baseUrl: "https://api.anthropic.com",
    });
    const request = await adapter.buildRequest({
      modelId: "claude-opus-4-1",
      context: {
        systemPrompt: ["stable project instructions"],
        messages: [{ role: "user", content: "hi" }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { system: Record<string, unknown>[]; cache_control?: unknown };

    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[0]).toMatchObject({ type: "text" });
    expect(body.system[0].cache_control).toBeUndefined();
    // The last system block (user system prompt) gets the cache breakpoint.
    expect(body.system[1]).toEqual({
      type: "text",
      text: "stable project instructions",
      cache_control: { type: "ephemeral" },
    });
  });

  test("Anthropic requests mark the final tool definition as cacheable", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic", baseUrl: "https://api.anthropic.com" });
    const request = await adapter.buildRequest({
      modelId: "claude-opus-4-1",
      context: {
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            namespace: "codex",
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
          {
            namespace: "codex",
            name: "write_file",
            description: "Write a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as { tools: Record<string, unknown>[]; cache_control?: unknown; system?: Array<Record<string, unknown>>; messages: Array<{ content: unknown }> };

    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.system?.[0]?.text).toContain("Valid tool names for this turn are exactly `codex__read_file`, `codex__write_file`.");
    expect(body.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral" });
    // Native automatic caching consumes the final-turn slot, so the last user block stays plain.
    expect(body.messages[0].content).toBe("hi");
  });

  test("Anthropic native automatic caching reserves one explicit breakpoint slot", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic", baseUrl: "https://api.anthropic.com" });
    const request = await adapter.buildRequest({
      modelId: "claude-opus-4-1",
      context: {
        systemPrompt: ["stable project instructions"],
        messages: [
          { role: "user", content: "previous turn" },
          { role: "user", content: "current turn" },
        ],
        tools: [{
          namespace: "codex",
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(request.body) as {
      cache_control?: unknown;
      tools: Array<Record<string, unknown>>;
      system?: Array<Record<string, unknown>>;
      messages: Array<{ content: unknown }>;
    };

    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "previous turn", cache_control: { type: "ephemeral" } },
    ]);
    expect(body.messages[1].content).toBe("current turn");
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
      usage: {
        // canonical convention: inputTokens is inclusive of cache read + write
        inputTokens: 25,
        outputTokens: 4,
        cachedInputTokens: 3,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
      },
    });
  });

  test("anthropic stream fails closed on EOF when message_stop and stop_reason are missing", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const response = new Response([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
    ].join(""));

    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "upstream stream ended before message_stop — possible truncation",
    });
    expect(events.some(event => event.type === "done")).toBe(false);
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
  test("inserts a synthetic assistant tool_call before orphan tool results", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const request = await adapter.buildRequest({
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
      content: "",
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

  test("keeps paired tool results attached to the prior assistant tool_call", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const request = await adapter.buildRequest({
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
  test("merges adjacent tool results after multiple tool uses into one user message", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = await adapter.buildRequest({
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
      { type: "tool_result", tool_use_id: "call_2", content: "two", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("adds an error tool result when history is missing a tool result", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = await adapter.buildRequest({
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
        cache_control: { type: "ephemeral" },
      }],
    });
  });

  test("preserves orphan tool results as text instead of invalid Anthropic tool_result blocks", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = await adapter.buildRequest({
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
      content: [{
        type: "text",
        text: "[tool_result without adjacent tool_use: lost_tool (orphan_call)]\norphan output",
        cache_control: { type: "ephemeral" },
      }],
    }]);
  });

  test("preserves duplicate adjacent tool results as text after the matching result", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = await adapter.buildRequest({
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
        { type: "text", text: "[tool_result without adjacent tool_use: read_file (call_1)]\nduplicate", cache_control: { type: "ephemeral" } },
      ],
    });
  });

  test("maps non-string tool result content through Anthropic content blocks", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = await adapter.buildRequest({
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
              { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", detail: "high" },
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
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } },
        ],
        cache_control: { type: "ephemeral" },
      }],
    });
  });
});
