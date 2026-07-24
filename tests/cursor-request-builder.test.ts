import { describe, expect, test } from "bun:test";
import {
  applyCursorToolBudget,
  createCursorRequest,
  CURSOR_TOOL_BYTES_LIMIT,
  CURSOR_TOOL_COUNT_LIMIT,
} from "../src/adapters/cursor/request-builder";
import { cursorMcpToolsEncodedSize } from "../src/adapters/cursor/tool-definitions";
import { parseRequest } from "../src/responses/parser";
import type { OcxParsedRequest } from "../src/types";

const base: OcxParsedRequest = {
  modelId: "cursor/auto",
  context: { messages: [] },
  stream: false,
  options: {},
};

describe("Cursor request builder", () => {
  test("normalizes cursor model prefix and never uses Responses response id as Cursor conversation id", () => {
    const request = createCursorRequest({ ...base, previousResponseId: "resp_123" });

    expect(request.modelId).toBe("default");
    // resp_* is an OpenAI Responses chain id, not a Cursor conversation id. Without a remembered
    // Cursor conversation (_cursorConversationId) we start a fresh one — never fall back to resp_*,
    // which would start an unrelated Cursor conversation and break tool-result continuation.
    expect(request.conversationId).not.toBe("resp_123");
    expect(request.conversationId.startsWith("cursor_")).toBe(true);
  });

  test("uses resolved Cursor conversation id ahead of Responses response id", () => {
    const request = createCursorRequest({
      ...base,
      previousResponseId: "resp_123",
      _cursorConversationId: "cursor_stable",
    });

    expect(request.conversationId).toBe("cursor_stable");
  });

  test("uses stable client thread identity for external store:false continuations", () => {
    const initial = createCursorRequest({
      ...base,
      modelId: "cursor/gpt-5.6-sol",
      context: { messages: [{ role: "user", content: "start", timestamp: 1 }] },
      _clientThreadId: "thread-a",
      options: { promptCacheKey: "shared-cache-key" },
    });
    const continuation = createCursorRequest({
      ...base,
      modelId: "cursor/gpt-5.6-sol",
      context: {
        messages: [{
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read_file",
          content: "result",
          isError: false,
          timestamp: 2,
        }],
      },
      _clientThreadId: "thread-a",
      options: { promptCacheKey: "shared-cache-key" },
    });

    expect(continuation.conversationId).toBe(initial.conversationId);
  });

  test("isolates client threads even when they share a prompt cache key", () => {
    const first = createCursorRequest({
      ...base,
      _clientThreadId: "thread-a",
      options: { promptCacheKey: "shared-cache-key" },
    });
    const second = createCursorRequest({
      ...base,
      _clientThreadId: "thread-b",
      options: { promptCacheKey: "shared-cache-key" },
    });

    expect(second.conversationId).not.toBe(first.conversationId);
  });

  test("native and external models do not pin conversation id from prompt_cache_key alone", () => {
    const nativeA = createCursorRequest({
      modelId: "cursor/composer-2.5",
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      stream: false,
      options: { promptCacheKey: "shared-cache-key" },
    });
    const nativeB = createCursorRequest({
      modelId: "cursor/composer-2.5",
      context: { messages: [{ role: "user", content: "hi again", timestamp: 2 }] },
      stream: false,
      options: { promptCacheKey: "shared-cache-key" },
    });
    expect(nativeA.conversationId).not.toBe(nativeB.conversationId);

    const externalA = createCursorRequest({
      modelId: "cursor/gpt-5.6-sol",
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      stream: false,
      options: { promptCacheKey: "shared-cache-key" },
    });
    const externalB = createCursorRequest({
      modelId: "cursor/gpt-5.6-sol",
      context: { messages: [{ role: "user", content: "hi again", timestamp: 2 }] },
      stream: false,
      options: { promptCacheKey: "shared-cache-key" },
    });
    expect(externalA.conversationId).not.toBe(externalB.conversationId);
  });

  test("identity scope namespaces client thread conversation ids", () => {
    const a = createCursorRequest({
      ...base,
      _clientThreadId: "thread-a",
      _cursorIdentityScope: "account-1",
    });
    const b = createCursorRequest({
      ...base,
      _clientThreadId: "thread-a",
      _cursorIdentityScope: "account-2",
    });
    expect(a.conversationId).not.toBe(b.conversationId);
  });

  test("isolated helper turns mint a fresh conversation id", () => {
    const main = createCursorRequest({
      ...base,
      _clientThreadId: "thread-a",
    });
    const helper = createCursorRequest({
      ...base,
      _clientThreadId: "thread-a",
      _cursorIsolateConversation: true,
    });
    expect(helper.conversationId).not.toBe(main.conversationId);
  });

  test("isolation wins over a remembered parent conversation id", () => {
    const helper = createCursorRequest({
      ...base,
      _clientThreadId: "thread-a",
      _cursorConversationId: "cursor_parent_remembered",
      _cursorIsolateConversation: true,
    });
    expect(helper.conversationId).not.toBe("cursor_parent_remembered");
    expect(helper.conversationId.startsWith("cursor_")).toBe(true);
  });

  test("marks Cursor context-usage boundaries for compaction epochs", () => {
    expect(createCursorRequest({ ...base, _contextCompactionBoundary: true }).contextUsageReset).toBe(true);

    const compactionRequest = createCursorRequest({ ...base, _compactionRequest: true });
    expect(compactionRequest.contextUsageReset).toBe(true);
    expect(compactionRequest.contextUsageStoreCheckpoints).toBe(false);
  });

  test("maps system, developer, user, assistant, and tool result text", () => {
    const request = createCursorRequest({
      ...base,
      context: {
        systemPrompt: ["system A", "system B"],
        messages: [
          { role: "developer", content: "dev", timestamp: 1 },
          { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 2 },
          { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 3 },
          { role: "toolResult", toolCallId: "call_1", toolName: "tool", content: "tool out", isError: false, timestamp: 4 },
        ],
      },
    });

    expect(request.system).toEqual(["system A", "system B"]);
    expect(request.messages).toEqual([
      { role: "developer", content: "dev" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "tool", content: "[tool_result]\ncall_id: call_1\nname: tool\nis_error: false\noutput:\ntool out" },
    ]);
  });

  test("uses an explicit image placeholder for unsupported image parts", () => {
    const request = createCursorRequest({
      ...base,
      context: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see" },
              { type: "image", imageUrl: "data:image/png;base64,abc", detail: "high" },
            ],
            timestamp: 1,
          },
        ],
      },
    });

    expect(request.messages[0]?.content).toContain("see");
    expect(request.messages[0]?.content).toContain("image input unsupported");
    expect(request.messages[0]?.content).toContain("high");
  });

  test("preserves Responses tools and tool choice for Cursor request context", () => {
    const tool = {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      namespace: "mcp__fs",
    };
    const request = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "use a tool", timestamp: 1 }], tools: [tool] },
      options: { toolChoice: "required" },
    });

    expect(request.tools).toEqual([tool]);
    expect(request.toolChoice).toBe("required");
  });

  test("serializes prior tool results without leaking assistant tool-call markers as text", () => {
    const request = createCursorRequest({
      ...base,
      context: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            toolNamespace: "mcp__fs",
            content: "file contents",
            isError: false,
            timestamp: 2,
          },
        ],
      },
      options: { parallelToolCalls: false },
    });

    expect(request.parallelToolCalls).toBe(false);
    expect(request.messages).toEqual([{
      role: "tool",
      content: "[tool_result]\ncall_id: call_1\nname: mcp__fs__read_file\nis_error: false\noutput:\nfile contents",
    }]);
  });

  test("preserves Responses allowed_tools and parallel_tool_calls controls from parser", () => {
    const parsed = parseRequest({
      model: "cursor/auto",
      input: "use one",
      tools: [
        { type: "function", name: "read_file", description: "Read", parameters: {} },
        { type: "function", name: "write_file", description: "Write", parameters: {} },
      ],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: "read_file" }],
      },
      parallel_tool_calls: false,
    });
    const request = createCursorRequest(parsed);

    expect(request.toolChoice).toEqual({ mode: "required", allowedTools: ["read_file"] });
    expect(request.parallelToolCalls).toBe(false);
  });

  test("uses actual protobuf size and continues after an oversized definition", () => {
    const huge = {
      name: "huge",
      namespace: "mcp__huge",
      description: "x".repeat(CURSOR_TOOL_BYTES_LIMIT + 10_000),
      parameters: { type: "object", properties: {} },
    };
    const small = {
      name: "small",
      namespace: "mcp__small",
      description: "Small tool",
      parameters: { type: "object", properties: {} },
    };
    const budget = applyCursorToolBudget([huge, small], "auto");

    expect(budget.tools.map(tool => tool.name)).toEqual(["small"]);
    expect(budget.omitted.map(tool => tool.name)).toEqual(["huge"]);
    expect(cursorMcpToolsEncodedSize(budget.tools, "auto")).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
  });

  test("hard-caps the combined catalog and prioritizes tool_search-loaded tools", () => {
    const regular = Array.from({ length: CURSOR_TOOL_COUNT_LIMIT + 5 }, (_, index) => ({
      name: `regular_${index}`,
      namespace: "mcp__regular",
      description: "Regular",
      parameters: {},
    }));
    const loaded = {
      name: "loaded_action",
      namespace: "mcp__loaded",
      description: "Loaded by tool_search",
      parameters: {},
      loadedFromToolSearch: true,
    };
    const budget = applyCursorToolBudget([...regular, loaded], "auto");

    expect(budget.tools.length).toBeLessThanOrEqual(CURSOR_TOOL_COUNT_LIMIT);
    expect(budget.tools).toContain(loaded);
    expect(cursorMcpToolsEncodedSize(budget.tools, "auto")).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
  });

  test("adds an honest recovery note only when tool_search survives", () => {
    const tools = [
      { name: "tool_search", description: "Discover", parameters: {}, toolSearch: true },
      {
        name: "huge", namespace: "mcp__huge", description: "x".repeat(CURSOR_TOOL_BYTES_LIMIT + 10_000),
        parameters: { type: "object", properties: {} },
      },
    ];
    const request = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "use tools", timestamp: 1 }], tools },
    });
    expect(request.system.join("\n")).toContain("Use tool_search");
    expect(request.system.join("\n")).toContain("prioritized on the next turn");

    const withoutSearch = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "use tools", timestamp: 1 }], tools: tools.slice(1) },
    });
    expect(withoutSearch.system.join("\n")).toContain("unavailable this turn");
    expect(withoutSearch.system.join("\n")).not.toContain("Use tool_search");
  });


  test("external Cursor tool-result continuation keeps the remembered conversation id", () => {
    const request = createCursorRequest({
      modelId: "cursor/gpt-5.6-sol",
      context: {
        messages: [
          { role: "user", content: "read a file", timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/gpt-5.6-sol",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            toolNamespace: "mcp__fs",
            content: "FILE CONTENTS HERE",
            isError: false,
            timestamp: 3,
          },
        ],
      },
      stream: false,
      options: { reasoning: "xhigh" },
      _cursorConversationId: "cursor_old_external",
    });

    expect(request.modelId).toBe("gpt-5.6-sol-xhigh");
    expect(request.conversationId).toBe("cursor_old_external");
  });

  test("native Cursor tool-result continuation keeps the remembered conversation id", () => {
    const request = createCursorRequest({
      modelId: "cursor/composer-2.5",
      context: {
        messages: [
          { role: "user", content: "read a file", timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/composer-2.5",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            toolNamespace: "mcp__fs",
            content: "FILE CONTENTS HERE",
            isError: false,
            timestamp: 3,
          },
        ],
      },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_native_stable",
    });

    expect(request.conversationId).toBe("cursor_native_stable");
  });

  test("forceFreshConversation always mints a new conversation id", () => {
    const request = createCursorRequest({
      ...base,
      _cursorConversationId: "cursor_force_me",
    }, { forceFreshConversation: true });

    expect(request.conversationId).not.toBe("cursor_force_me");
    expect(request.conversationId.startsWith("cursor_")).toBe(true);
  });
});
