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
  test("normalizes cursor model prefix and preserves previous response id", () => {
    const request = createCursorRequest({ ...base, previousResponseId: "resp_123" });

    expect(request.modelId).toBe("auto");
    expect(request.conversationId).toBe("resp_123");
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

  test("serializes prior tool calls and tool results with pairing metadata", () => {
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
    expect(request.messages[0]).toEqual({
      role: "assistant",
      content: "[tool_call]\nid: call_1\nname: mcp__fs__read_file\narguments: {\"path\":\"a.txt\"}",
    });
    expect(request.messages[1]).toEqual({
      role: "tool",
      content: "[tool_result]\ncall_id: call_1\nname: mcp__fs__read_file\nis_error: false\noutput:\nfile contents",
    });
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
});
