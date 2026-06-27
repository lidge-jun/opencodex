import { describe, expect, test } from "bun:test";
import { buildCursorToolDefinitions } from "../src/adapters/cursor/tool-definitions";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import { parseRequest } from "../src/responses/parser";
import type { OcxTool } from "../src/types";

const tools: OcxTool[] = [
  { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
  { name: "write_file", namespace: "mcp__fs", description: "Write", parameters: {} },
];

describe("Cursor Responses tool_choice support", () => {
  test("advertisement respects none, auto, required, forced function, and allowed_tools subset", () => {
    expect(buildCursorToolDefinitions(tools, "none")).toEqual([]);
    expect(buildCursorToolDefinitions(tools, "auto").map(tool => tool.toolName)).toEqual(["mcp__fs__read_file", "mcp__fs__write_file"]);
    expect(buildCursorToolDefinitions(tools, "required").map(tool => tool.toolName)).toEqual(["mcp__fs__read_file", "mcp__fs__write_file"]);
    expect(buildCursorToolDefinitions(tools, { name: "write_file" }).map(tool => tool.toolName)).toEqual(["mcp__fs__write_file"]);
    expect(buildCursorToolDefinitions(tools, { mode: "required", allowedTools: ["read_file"] }).map(tool => tool.toolName)).toEqual(["mcp__fs__read_file"]);
  });

  test("parser preserves parallel_tool_calls false for Cursor request enforcement", () => {
    const parsed = parseRequest({
      model: "cursor/auto",
      input: "use one tool",
      tools: tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters })),
      tool_choice: "auto",
      parallel_tool_calls: false,
    });

    expect(createCursorRequest(parsed).parallelToolCalls).toBe(false);
  });
});
