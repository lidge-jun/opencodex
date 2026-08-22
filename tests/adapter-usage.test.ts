import { describe, expect, test } from "bun:test";
import { anthropicToolCallId, MAX_TOOL_CALL_ID_LENGTH } from "../src/adapters/tool-call-id";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../src/adapters/anthropic";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createAnthropicAdapter = (...args: Parameters<typeof createAnthropicAdapterProduction>) =>
  withTestTranslatorBudget(createAnthropicAdapterProduction(...args));
const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));
const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

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

    expect(events).toEqual([
      { type: "reasoning_raw_delta", text: "raw thoughts" },
      { type: "text_delta", text: "answer" },
      { type: "done", usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 5, reasoningOutputTokens: 3 } },
    ]);
  });

  test("OpenAI-compatible streaming maps reasoning_content and usage details", async () => {
    const adapter = createOpenAIChatAdapter(provider);
    const response = new Response([
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"raw stream\",\"content\":\"answer\"}}]}\n\n",
      "data: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4,\"prompt_tokens_details\":{\"cached_tokens\":2},\"completion_tokens_details\":{\"reasoning_tokens\":1}}}\n\n",
      "data: [DONE]\n\n",
    ].join(""));

    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);

    expect(events).toEqual([
      { type: "reasoning_raw_delta", text: "raw stream" },
      { type: "text_delta", text: "answer" },
      { type: "done", usage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2, reasoningOutputTokens: 1 } },
    ]);
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
  /** Build one Anthropic request from a call/result history and return its parsed body. */
  async function replay(messages: any[]): Promise<{ messages: Array<{ role: string; content: any }> }> {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = await adapter.buildRequest({
      modelId: "claude-sonnet",
      context: { messages },
      stream: true,
      options: {},
    });
    return JSON.parse(request.body);
  }

  function callThenResult(callId: string, resultId = callId): any[] {
    return [
      { role: "user", content: "start", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "read_file", arguments: {} }],
        model: "claude-sonnet",
        timestamp: 0,
      },
      { role: "toolResult", toolCallId: resultId, toolName: "read_file", content: "ok", isError: false, timestamp: 0 },
      { role: "user", content: "continue", timestamp: 0 },
    ];
  }

  test("a rewritten call id keeps its result paired (#1767)", async () => {
    // requiredIds holds NORMALIZED ids. Matching the raw result id against them meant every
    // rewritten pair lost its real result to orphan text and gained a synthetic missing-result.
    const body = await replay(callThenResult("call:a"));

    const toolUse = (body.messages[1].content as any[]).find(b => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    const results = body.messages[2].content as any[];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: toolUse.id, content: "ok" });
    expect(JSON.stringify(results)).not.toContain("missing tool_result");
    expect(JSON.stringify(results)).not.toContain("tool_result without adjacent tool_use");
  });

  test("an empty id never reaches the wire", async () => {
    // `anthropicToolCallId("")` returns undefined, but the old `?? rawId` fallback restored the
    // empty string -- an id Anthropic rejects. The call becomes text instead.
    const body = await replay(callThenResult(""));

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('"id":""');
    expect(serialized).not.toContain('"tool_use_id":""');
    expect(serialized).toContain("tool_use without a usable id");
  });

  test("a rewritten id does not collide with a conforming id that already looks like it", async () => {
    // The stateless transform is not injective: `call:a` normalizes to `call_a_<hash>`, and a raw
    // id already equal to that value passes through untouched. Two sources, one wire id.
    const normalized = anthropicToolCallId("call:a")!;
    expect(normalized).not.toBe("call:a");

    const body = await replay([
      { role: "user", content: "start", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call:a", name: "first", arguments: {} },
          { type: "toolCall", id: normalized, name: "second", arguments: {} },
        ],
        model: "claude-sonnet",
        timestamp: 0,
      },
      { role: "toolResult", toolCallId: "call:a", toolName: "first", content: "one", isError: false, timestamp: 0 },
      { role: "toolResult", toolCallId: normalized, toolName: "second", content: "two", isError: false, timestamp: 0 },
      { role: "user", content: "continue", timestamp: 0 },
    ]);

    const uses = (body.messages[1].content as any[]).filter(b => b.type === "tool_use");
    expect(uses).toHaveLength(2);
    expect(uses[0].id).not.toBe(uses[1].id);

    // Each result pairs with its own call, and nothing is orphaned.
    const results = (body.messages[2].content as any[]).filter(b => b.type === "tool_result");
    expect(results.map(r => r.tool_use_id).sort()).toEqual(uses.map(u => u.id).sort());
    expect(JSON.stringify(results)).not.toContain("missing tool_result");
  });

  test("a result with no matching call does not mint a tool_use identity", async () => {
    const body = await replay(callThenResult("call_1", "call_other"));

    const uses = (body.messages[1].content as any[]).filter(b => b.type === "tool_use");
    expect(uses).toHaveLength(1);
    expect(uses[0].id).toBe("call_1");

    // The unmatched result stays text; the real call gets the synthetic missing-result block.
    const followUp = JSON.stringify(body.messages[2].content);
    expect(followUp).toContain("tool_result without adjacent tool_use");
    expect(followUp).toContain("missing tool_result");
  });

  test("an over-length id is rewritten to fit, not passed through", async () => {
    // Character-valid but too long: Anthropic rejects it, so `isConformingToolCallId` has to
    // include the length bound or reserve() would hand it back verbatim.
    const longId = "c".repeat(MAX_TOOL_CALL_ID_LENGTH + 20);
    const body = await replay(callThenResult(longId));

    const toolUse = (body.messages[1].content as any[]).find(b => b.type === "tool_use");
    expect(toolUse.id.length).toBeLessThanOrEqual(MAX_TOOL_CALL_ID_LENGTH);
    expect(toolUse.id).not.toBe(longId);

    const results = (body.messages[2].content as any[]).filter(b => b.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe(toolUse.id);
  });

  test("already-conforming pairs pass through byte-identical", async () => {
    const body = await replay(callThenResult("call_ok_1"));

    const toolUse = (body.messages[1].content as any[]).find(b => b.type === "tool_use");
    expect(toolUse.id).toBe("call_ok_1");
    const results = (body.messages[2].content as any[]).filter(b => b.type === "tool_result");
    expect(results[0].tool_use_id).toBe("call_ok_1");
  });

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

  test("reorders interleaved text after tool_use so Anthropic pairing stays valid (#620)", async () => {
    const adapter = createAnthropicAdapter({ ...provider, adapter: "anthropic" });
    const request = await adapter.buildRequest({
      modelId: "claude-sonnet",
      context: {
        messages: [
          { role: "user", content: "start", timestamp: 0 },
          {
            role: "assistant",
            content: [
              { type: "text", text: "before" },
              { type: "toolCall", id: "call_a", name: "first_tool", arguments: {} },
              { type: "text", text: "between steps" },
              { type: "toolCall", id: "call_b", name: "second_tool", arguments: {} },
            ],
            model: "claude-sonnet",
            timestamp: 0,
          },
          { role: "toolResult", toolCallId: "call_a", toolName: "first_tool", content: "one", isError: false, timestamp: 0 },
          { role: "toolResult", toolCallId: "call_b", toolName: "second_tool", content: "two", isError: false, timestamp: 0 },
        ],
      },
      stream: true,
      options: {},
    });
    const wire = JSON.parse(request.body) as { messages: Array<{ role: string; content: any }> };
    const assistant = wire.messages.find(m => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c: { type?: string }) => c.type === "tool_use"));
    expect(assistant).toBeDefined();
    const types = (assistant!.content as { type: string }[]).map(c => c.type);
    expect(types).toEqual(["text", "text", "tool_use", "tool_use"]);
    expect(wire.messages[2].role).toBe("user");
    expect(wire.messages[2].content.map((c: { tool_use_id?: string }) => c.tool_use_id)).toEqual(["call_a", "call_b"]);
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
