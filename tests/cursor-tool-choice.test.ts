import { describe, expect, test } from "bun:test";
import { buildCursorToolDefinitions } from "../src/adapters/cursor/tool-definitions";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import { parseRequest } from "../src/responses/parser";
import type { OcxTool } from "../src/types";

const tools: OcxTool[] = [
  { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
  { name: "write_file", namespace: "mcp__fs", description: "Write", parameters: {} },
];

const shellBridgeTools: OcxTool[] = [
  { name: "shell_command", description: "Run", parameters: {} },
  { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
];

describe("Cursor Responses tool_choice support", () => {
  test("advertisement respects none, auto, required, forced function, and allowed_tools subset", () => {
    expect(buildCursorToolDefinitions(tools, "none")).toEqual([]);
    expect(buildCursorToolDefinitions(tools, "auto").map(tool => tool.toolName)).toEqual(["mcp__fs__read_file", "mcp__fs__write_file"]);
    expect(buildCursorToolDefinitions(tools, "required").map(tool => tool.toolName)).toEqual(["mcp__fs__read_file", "mcp__fs__write_file"]);
    expect(buildCursorToolDefinitions(tools, { name: "write_file" }).map(tool => tool.toolName)).toEqual(["mcp__fs__write_file"]);
    expect(buildCursorToolDefinitions(tools, { mode: "required", allowedTools: ["read_file"] }).map(tool => tool.toolName)).toEqual(["mcp__fs__read_file"]);
  });

  test("treats shell_command and exec_command as aliases for forced tool_choice", () => {
    expect(buildCursorToolDefinitions(shellBridgeTools, { name: "exec_command" }).map(tool => tool.toolName)).toEqual(["shell_command"]);
    expect(buildCursorToolDefinitions(shellBridgeTools, { name: "shell_command" }).map(tool => tool.toolName)).toEqual(["shell_command"]);
  });

  test("treats shell_command and exec_command as aliases for allowed_tools", () => {
    expect(buildCursorToolDefinitions(shellBridgeTools, { mode: "required", allowedTools: ["exec_command"] }).map(tool => tool.toolName)).toEqual(["shell_command"]);
    expect(buildCursorToolDefinitions(shellBridgeTools, { mode: "required", allowedTools: ["shell_command"] }).map(tool => tool.toolName)).toEqual(["shell_command"]);
  });

  test("forced exec_command does not select a namespaced remote exec_command beside the bare bridge", () => {
    const toolsWithRemote: OcxTool[] = [
      { name: "shell_command", description: "Run", parameters: {} },
      { name: "exec_command", namespace: "mcp__remote", description: "Remote exec", parameters: {} },
    ];
    expect(buildCursorToolDefinitions(toolsWithRemote, { name: "exec_command" }).map(tool => tool.toolName)).toEqual(["shell_command"]);
    expect(buildCursorToolDefinitions(toolsWithRemote, { mode: "required", allowedTools: ["shell_command"] }).map(tool => tool.toolName)).toEqual(["shell_command"]);
    // Wire-name choice still selects the namespaced tool intentionally.
    expect(buildCursorToolDefinitions(toolsWithRemote, { name: "mcp__remote__exec_command" }).map(tool => tool.toolName)).toEqual(["mcp__remote__exec_command"]);
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
