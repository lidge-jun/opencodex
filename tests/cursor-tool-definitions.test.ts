import { describe, expect, test } from "bun:test";
import { buildCursorToolDefinitions, cursorToolWireName } from "../src/adapters/cursor/tool-definitions";
import type { OcxTool } from "../src/types";

const decoder = new TextDecoder();

describe("Cursor tool definitions", () => {
  test("converts Responses tools to Cursor request context definitions", () => {
    const tool: OcxTool = {
      name: "read_file",
      namespace: "mcp__fs",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      strict: true,
    };

    expect(cursorToolWireName(tool)).toBe("mcp__fs__read_file");
    const defs = buildCursorToolDefinitions([tool]);

    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("mcp__fs__read_file");
    expect(defs[0]?.toolName).toBe("mcp__fs__read_file");
    expect(defs[0]?.providerIdentifier).toBe("opencodex-responses");
    expect(defs[0]?.description).toBe("Read a file");
    expect(JSON.parse(decoder.decode(defs[0]?.inputSchema))).toEqual(tool.parameters);
  });

  test("applies Responses tool_choice to advertised Cursor tool definitions", () => {
    const tools: OcxTool[] = [
      { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
      { name: "write_file", namespace: "mcp__fs", description: "Write", parameters: {} },
    ];

    expect(buildCursorToolDefinitions(tools, "none")).toEqual([]);
    expect(buildCursorToolDefinitions(tools, { name: "write_file" }).map(tool => tool.toolName)).toEqual(["mcp__fs__write_file"]);
    expect(buildCursorToolDefinitions(tools, { name: "mcp__fs__read_file" }).map(tool => tool.toolName)).toEqual(["mcp__fs__read_file"]);
    expect(buildCursorToolDefinitions(tools, "required").map(tool => tool.toolName)).toEqual(["mcp__fs__read_file", "mcp__fs__write_file"]);
  });
});
