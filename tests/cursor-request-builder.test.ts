import { describe, expect, test } from "bun:test";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
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

  test("enforces a Cursor tool budget — keeps native tools and trims namespaces when over limit", () => {
    // Build a realistic catalog: 11 native tools + 4 namespaces totalling 340 inner tools.
    const nativeTools = Array.from({ length: 11 }, (_, i) => ({
      name: `native_${i}`,
      description: `Native tool ${i}`,
      parameters: { type: "object" as const, properties: {} },
    }));
    const namespaces = [
      { name: "ns_small", innerCount: 5 },
      { name: "ns_medium", innerCount: 30 },
      { name: "ns_large", innerCount: 89 },
      { name: "ns_huge", innerCount: 216 },
    ];
    const namespaceTools = namespaces.flatMap(ns =>
      Array.from({ length: ns.innerCount }, (_, i) => ({
        name: `tool_${i}`,
        namespace: ns.name,
        description: `${ns.name} tool ${i}`,
        parameters: { type: "object" as const, properties: {} },
      })),
    );

    const allTools = [...nativeTools, ...namespaceTools]; // 11 + 340 = 351
    const request = createCursorRequest({
      ...base,
      context: {
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: allTools,
      },
    });

    // Budget is 200 total tools. Native (11) always kept.
    // Remaining budget: 189. ns_small(5) + ns_medium(30) + ns_large(89) = 124 ≤ 189.
    // ns_huge(216) would push to 340 > 189, so it's cut.
    const kept = request.tools ?? [];
    const keptNamespaces = new Set(kept.filter(t => t.namespace).map(t => t.namespace));
    expect(keptNamespaces.has("ns_small")).toBe(true);
    expect(keptNamespaces.has("ns_medium")).toBe(true);
    expect(keptNamespaces.has("ns_large")).toBe(true);
    expect(keptNamespaces.has("ns_huge")).toBe(false);
    expect(kept.length).toBe(11 + 5 + 30 + 89); // 135
    expect(kept.length).toBeLessThanOrEqual(200);
  });

  test("does not trim when catalog is under the Cursor tool budget", () => {
    const tools = [
      { name: "exec_command", description: "Run", parameters: {} },
      { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
      { name: "write_file", namespace: "mcp__fs", description: "Write", parameters: {} },
    ];
    const request = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools },
    });
    expect(request.tools).toEqual(tools);
  });

  test("adds deferred-tools system note when namespaces are trimmed", () => {
    const nativeTools = Array.from({ length: 11 }, (_, i) => ({
      name: `native_${i}`,
      description: `Native tool ${i}`,
      parameters: { type: "object" as const, properties: {} },
    }));
    const namespaceTools = Array.from({ length: 340 }, (_, i) => ({
      name: `tool_${i}`,
      namespace: `ns_${Math.floor(i / 50)}`,
      description: `NS tool ${i}`,
      parameters: { type: "object" as const, properties: {} },
    }));
    const request = createCursorRequest({
      ...base,
      context: {
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: [...nativeTools, ...namespaceTools],
      },
    });
    const systemText = (request.system ?? []).join("\n");
    expect(systemText).toContain("tool_search");
    expect(systemText).toContain("Not all tools could be advertised");
  });

  test("does not add deferred-tools note when nothing is trimmed", () => {
    const tools = [
      { name: "exec_command", description: "Run", parameters: {} },
      { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
    ];
    const request = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools },
    });
    const systemText = (request.system ?? []).join("\n");
    expect(systemText).not.toContain("Not all tools could be advertised");
  });
});
