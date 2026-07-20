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
    // Build a catalog that exceeds the 330 count budget: 11 native + 4 namespaces = 351 tools.
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

    // Budget is 330 total tools. Native (11) always kept.
    // Remaining budget: 319. ns_small(5) + ns_medium(30) + ns_large(89) + ns_huge(216) = 340 > 319.
    // ns_small + ns_medium + ns_large = 124 ≤ 319. ns_huge(216) would push to 343 > 319, so it's cut.
    const kept = request.tools ?? [];
    const keptNamespaces = new Set(kept.filter(t => t.namespace).map(t => t.namespace));
    expect(keptNamespaces.has("ns_small")).toBe(true);
    expect(keptNamespaces.has("ns_medium")).toBe(true);
    expect(keptNamespaces.has("ns_large")).toBe(true);
    expect(keptNamespaces.has("ns_huge")).toBe(false);
    expect(kept.length).toBe(11 + 5 + 30 + 89); // 135
    expect(kept.length).toBeLessThanOrEqual(330);
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
    // Include tool_search so the deferred note references it
    const toolSearch = {
      name: "tool_search",
      description: "Search for tools",
      parameters: { type: "object" as const, properties: {} },
    };
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
        tools: [...nativeTools, toolSearch, ...namespaceTools],
      },
    });
    const systemText = (request.system ?? []).join("\n");
    expect(systemText).toContain("tool_search");
    expect(systemText).toContain("abbreviated schemas");
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
    expect(systemText).not.toContain("abbreviated schemas");
  });

  // --- Review-finding tests (PR #192 round 2) ---

  test("preserves toolChoice-targeted tools even when their namespace is trimmed", () => {
    const nativeTools = Array.from({ length: 11 }, (_, i) => ({
      name: `native_${i}`,
      description: `Native tool ${i}`,
      parameters: { type: "object" as const, properties: {} },
    }));
    // One huge namespace that will be trimmed
    const hugeNs = Array.from({ length: 250 }, (_, i) => ({
      name: `huge_${i}`,
      namespace: "ns_huge",
      description: `Huge tool ${i}`,
      parameters: { type: "object" as const, properties: {} },
    }));
    // The specific tool we force via toolChoice
    const forcedTool = {
      name: "critical_action",
      namespace: "ns_huge",
      description: "Must survive",
      parameters: { type: "object" as const, properties: {} },
    };
    const request = createCursorRequest({
      ...base,
      context: {
        messages: [{ role: "user", content: "do it", timestamp: 1 }],
        tools: [...nativeTools, ...hugeNs, forcedTool],
      },
      options: { toolChoice: { name: "ns_huge__critical_action" } },
    });
    const kept = request.tools ?? [];
    const hasForced = kept.some(t => t.name === "critical_action" && t.namespace === "ns_huge");
    expect(hasForced).toBe(true);
  });

  test("does not suggest tool_search when it is not in the kept catalog", () => {
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
    // No tool_search in the catalog at all
    const request = createCursorRequest({
      ...base,
      context: {
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: [...nativeTools, ...namespaceTools],
      },
    });
    const systemText = (request.system ?? []).join("\n");
    expect(systemText).toContain("abbreviated schemas");
    expect(systemText).not.toContain("tool_search");
  });

  test("caps oversized bare-function catalogs at the budget", () => {
    // 350 native (non-namespace) tools — exceeds 330 count budget
    const tools = Array.from({ length: 350 }, (_, i) => ({
      name: `func_${i}`,
      description: `Function tool ${i}`,
      parameters: { type: "object" as const, properties: {} },
    }));
    const request = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools },
    });
    const kept = request.tools ?? [];
    expect(kept.length).toBeLessThanOrEqual(330);
    const systemText = (request.system ?? []).join("\n");
    expect(systemText).toContain("abbreviated schemas");
  });

  test("keeps previously-used tools from trimmed namespaces across turns", () => {
    const nativeTools = Array.from({ length: 11 }, (_, i) => ({
      name: `native_${i}`,
      description: `Native tool ${i}`,
      parameters: { type: "object" as const, properties: {} },
    }));
    // Huge namespace that will be trimmed
    const hugeNs = Array.from({ length: 250 }, (_, i) => ({
      name: `huge_${i}`,
      namespace: "ns_huge",
      description: `Huge tool ${i}`,
      parameters: { type: "object" as const, properties: {} },
    }));
    // A tool that was loaded via tool_search in a prior turn
    const searchedTool = {
      name: "special_action",
      namespace: "ns_huge",
      description: "Previously loaded",
      parameters: { type: "object" as const, properties: {} },
    };
    const request = createCursorRequest({
      ...base,
      context: {
        messages: [
          { role: "user", content: "use it", timestamp: 1 },
          // Prior tool result referencing the searched tool
          {
            role: "toolResult",
            toolCallId: "call_prev",
            toolName: "special_action",
            toolNamespace: "ns_huge",
            content: "result from previous turn",
            isError: false,
            timestamp: 2,
          },
        ],
        tools: [...nativeTools, ...hugeNs, searchedTool],
      },
    });
    const kept = request.tools ?? [];
    const hasSearched = kept.some(t => t.name === "special_action" && t.namespace === "ns_huge");
    expect(hasSearched).toBe(true);
  });

  // --- Hybrid budget tests (probe-verified 2026-07-21) ---

  test("stubs schemas for tools beyond byte budget while keeping all under count budget", () => {
    // 300 tools with large schemas — should exceed byte budget but not count budget (330).
    const largeSchema = {
      type: "object" as const,
      properties: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`param_${i}`, { type: "string", description: `Parameter ${i} with a long description to inflate the schema size significantly` }]),
      ),
      required: Array.from({ length: 5 }, (_, i) => `param_${i}`),
    };
    const tools = Array.from({ length: 300 }, (_, i) => ({
      name: `big_tool_${i}`,
      namespace: "ns_big",
      description: `Big tool ${i}`,
      parameters: largeSchema,
    }));
    const request = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools },
    });
    // All 300 tools should survive (under 330 count budget).
    expect(request.tools?.length).toBe(300);
    // Some tools should have stubbed schemas (byte budget exceeded).
    expect(request.stubbedToolNames).toBeDefined();
    expect(request.stubbedToolNames!.size).toBeGreaterThan(0);
    expect(request.stubbedToolNames!.size).toBeLessThan(300);
  });

  test("does not stub schemas when catalog fits within byte budget", () => {
    const tools = Array.from({ length: 50 }, (_, i) => ({
      name: `small_tool_${i}`,
      description: `Small tool ${i}`,
      parameters: { type: "object" as const, properties: { x: { type: "string" } } },
    }));
    const request = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools },
    });
    expect(request.tools?.length).toBe(50);
    expect(request.stubbedToolNames).toBeUndefined();
  });

  test("injects text catalog for stubbed tools into system prompt", () => {
    const largeSchema = {
      type: "object" as const,
      properties: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`param_${i}`, { type: "string", description: `Parameter ${i} with a long description to inflate the schema size significantly` }]),
      ),
      required: Array.from({ length: 5 }, (_, i) => `param_${i}`),
    };
    const tools = Array.from({ length: 300 }, (_, i) => ({
      name: `big_tool_${i}`,
      namespace: "ns_big",
      description: `Big tool ${i}`,
      parameters: largeSchema,
    }));
    const request = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools },
    });
    const systemText = (request.system ?? []).join("\n");
    expect(systemText).toContain("Tool schema catalog");
    expect(systemText).toContain("big_tool_");
    expect(systemText).toContain("param_0: string*");
  });

  test("keeps all tools when catalog is between old and new count budget", () => {
    // 250 tools with tiny schemas — would have been trimmed at old 200 budget,
    // but should all survive at 330 count budget with no stubbing needed.
    const tools = Array.from({ length: 250 }, (_, i) => ({
      name: `tool_${i}`,
      namespace: "ns_a",
      description: `Tool ${i}`,
      parameters: { type: "object" as const, properties: {} },
    }));
    const request = createCursorRequest({
      ...base,
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools },
    });
    expect(request.tools?.length).toBe(250);
    expect(request.stubbedToolNames).toBeUndefined();
  });
});
