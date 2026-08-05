import { create } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import type { OcxTool } from "../src/types";
import {
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  McpToolCallSchema,
  PartialToolCallUpdateSchema,
  ToolCallCompletedUpdateSchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import {
  createCursorProtobufEventState,
  mapCursorProtobufServerMessage,
  mapSyntheticMcpExecToToolEvents,
  translateStructuredEditCall,
} from "../src/adapters/cursor/protobuf-events";
import { planMcpArgsHandling } from "../src/adapters/cursor/live-transport";
import {
  applyCursorToolBudget,
} from "../src/adapters/cursor/request-builder";
import {
  buildCursorToolGuidanceSystemNote,
  CURSOR_EDIT_FILE_INPUT_SCHEMA,
  CURSOR_EDIT_FILE_TOOL,
  CURSOR_MULTI_EDIT_INPUT_SCHEMA,
  CURSOR_MULTI_EDIT_TOOL,
  cursorStructuredEditTools,
} from "../src/adapters/cursor/tool-definitions";

const encoder = new TextEncoder();

function applyPatchTool(): OcxTool {
  return {
    name: "apply_patch",
    description: "Edit files with a freeform patch.",
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
    freeform: true,
  };
}

function execCommandTool(): OcxTool {
  return {
    name: "exec_command",
    description: "Run a shell command.",
    parameters: {
      type: "object",
      properties: { cmd: { type: "string" } },
      required: ["cmd"],
    },
  };
}

function interaction(message: Parameters<typeof create<typeof InteractionUpdateSchema>>[1]["message"]) {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, { message }),
    },
  });
}

function mcpToolCall(toolName: string, args: Record<string, unknown>) {
  const encoded: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(args)) encoded[key] = encoder.encode(JSON.stringify(value));
  return create(ToolCallSchema, {
    tool: {
      case: "mcpToolCall",
      value: create(McpToolCallSchema, {
        args: create(McpArgsSchema, {
          name: toolName,
          toolName,
          toolCallId: "call_1",
          providerIdentifier: "opencodex-responses",
          args: encoded,
        }),
      }),
    },
  });
}

describe("cursor structured edit tools (#1017)", () => {
  test("advertises edit_file and multi_edit alongside a bare freeform apply_patch", () => {
    const tools = cursorStructuredEditTools([applyPatchTool()], "auto");
    expect(tools.map(tool => tool.name)).toEqual([CURSOR_EDIT_FILE_TOOL, CURSOR_MULTI_EDIT_TOOL]);
    expect(tools[0]?.parameters).toEqual(CURSOR_EDIT_FILE_INPUT_SCHEMA);
    expect(tools[1]?.parameters).toEqual(CURSOR_MULTI_EDIT_INPUT_SCHEMA);
  });

  test("does not widen a forced or allow-listed tool choice", () => {
    const catalog = [applyPatchTool()];
    expect(cursorStructuredEditTools(catalog, { name: "apply_patch" })).toEqual([]);
    expect(cursorStructuredEditTools(catalog, { allowedTools: ["apply_patch"] })).toEqual([]);
  });

  test("does not advertise structured edit tools without an advertised freeform apply_patch", () => {
    expect(cursorStructuredEditTools([execCommandTool()], "auto")).toEqual([]);
    expect(cursorStructuredEditTools(undefined, "auto")).toEqual([]);
    // Namespaced apply_patch is a remote MCP tool, not the Codex freeform tool.
    expect(cursorStructuredEditTools([{ ...applyPatchTool(), namespace: "mcp__fs" }], "auto")).toEqual([]);
  });

  test("does not shadow a bare client tool that already uses a structured edit name", () => {
    const catalog = [applyPatchTool(), { ...applyPatchTool(), name: CURSOR_EDIT_FILE_TOOL, freeform: undefined }];
    const tools = cursorStructuredEditTools(catalog, "auto");
    expect(tools.map(tool => tool.name)).toEqual([CURSOR_MULTI_EDIT_TOOL]);
  });

  test("cursor tool budget keeps the structured edit tools with apply_patch", () => {
    const result = applyCursorToolBudget([applyPatchTool(), execCommandTool()], "auto");
    const names = result.tools.map(tool => tool.name);
    expect(names).toContain("apply_patch");
    expect(names).toContain(CURSOR_EDIT_FILE_TOOL);
    expect(names).toContain(CURSOR_MULTI_EDIT_TOOL);
    expect(result.omitted).toEqual([]);
  });

  test("cursor tool budget omits structured edit tools when apply_patch is forced", () => {
    const result = applyCursorToolBudget([applyPatchTool()], { name: "apply_patch" });
    expect(result.tools.map(tool => tool.name)).toEqual(["apply_patch"]);
  });

  test("guidance note tells the model to prefer the structured edit tools", () => {
    const note = buildCursorToolGuidanceSystemNote([applyPatchTool(), ...cursorStructuredEditTools([applyPatchTool()])], "auto");
    expect(note).toContain("prefer the structured edit tools");
    expect(note).toContain("`edit_file`");
    expect(note).toContain("`multi_edit`");
    expect(note).toContain("never emit patch-like plain text as tool arguments");
  });

  test("guidance note keeps the apply_patch-only guidance without structured tools", () => {
    const note = buildCursorToolGuidanceSystemNote([applyPatchTool()], "auto");
    expect(note).toContain("For file edits, use the `apply_patch` tool");
  });
});

describe("translateStructuredEditCall", () => {
  test("converts a single edit_file replacement into a valid apply_patch payload", () => {
    const args = JSON.stringify({ file_path: "src/a.ts", old_string: "old", new_string: "new" });
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, args)).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("converts multi-line replacements into one hunk with -/+ prefixed lines", () => {
    const args = JSON.stringify({
      file_path: "src/b.ts",
      old_string: "line1\nline2",
      new_string: "line1\nchanged\nline2",
    });
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, args)).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: src/b.ts",
        "@@",
        "-line1",
        "-line2",
        "+line1",
        "+changed",
        "+line2",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("accepts Cursor-style argument aliases", () => {
    const args = JSON.stringify({ path: "src/c.ts", oldtext: "a", newtext: "b" });
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, args)).toEqual(
      expect.objectContaining({ patch: expect.stringContaining("*** Update File: src/c.ts") }),
    );
    const camel = JSON.stringify({ filePath: "src/c.ts", oldString: "a", newString: "b" });
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, camel)).toEqual(
      expect.objectContaining({ patch: expect.stringContaining("*** Update File: src/c.ts") }),
    );
  });

  test("converts an empty new_string into a deletion hunk", () => {
    const args = JSON.stringify({ file_path: "src/d.ts", old_string: "dead", new_string: "" });
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, args)).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: src/d.ts",
        "@@",
        "-dead",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("converts multi_edit into one apply_patch payload with one hunk per edit", () => {
    const args = JSON.stringify({
      file_path: "src/e.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    });
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, args)).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: src/e.ts",
        "@@",
        "-a",
        "+b",
        "@@",
        "-c",
        "+d",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("rejects malformed structured edit calls instead of relaying invalid patch text", () => {
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, "not json")?.error).toBeTruthy();
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, JSON.stringify({ file_path: "src/f.ts" }))?.error).toBeTruthy();
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, JSON.stringify({ file_path: "", old_string: "a", new_string: "b" }))?.error).toBeTruthy();
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, JSON.stringify({ file_path: "src/f.ts", old_string: "", new_string: "b" }))?.error).toBeTruthy();
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, JSON.stringify({ file_path: "src/f.ts", edits: [] }))?.error).toBeTruthy();
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, JSON.stringify({ file_path: "src/f.ts", edits: [{ old_string: "a" }] }))?.error).toBeTruthy();
    expect(translateStructuredEditCall("exec_command", JSON.stringify({ cmd: "echo hi" }))).toBeUndefined();
  });

  test("rejects a trailing-newline-only edit as a silent no-op", () => {
    // old_string normalizes to the same lines as new_string; line-based patch cannot express "add a final newline".
    const args = JSON.stringify({ file_path: "src/nl.ts", old_string: "export {};\n", new_string: "export {};" });
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, args)).toEqual({
      error: "structured edit old_string and new_string are identical after line normalization; the replacement is a no-op and was dropped",
    });
  });

  test("rejects identical old/new as a no-op", () => {
    const args = JSON.stringify({ file_path: "src/same.ts", old_string: "x", new_string: "x" });
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, args)).toEqual({
      error: "structured edit old_string and new_string are identical after line normalization; the replacement is a no-op and was dropped",
    });
  });
});

describe("cursor protobuf event translation", () => {
  test("emits a structured edit_file call as an apply_patch custom tool call", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: [CURSOR_EDIT_FILE_TOOL, "apply_patch"],
      toolSchemas: new Map([[CURSOR_EDIT_FILE_TOOL, CURSOR_EDIT_FILE_INPUT_SCHEMA]]),
      cursorToolNameMap: new Map([[CURSOR_EDIT_FILE_TOOL, CURSOR_EDIT_FILE_TOOL]]),
    });
    const toolCall = mcpToolCall(CURSOR_EDIT_FILE_TOOL, { file_path: "src/a.ts", old_string: "old", new_string: "new" });

    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallStarted",
      value: create(ToolCallStartedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([]);
    expect(mapCursorProtobufServerMessage(interaction({
      case: "partialToolCall",
      value: create(PartialToolCallUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall, argsTextDelta: "{\"file_path\":\"src/a.ts\",\"old_string\":\"old\",\"new_string\":\"new\"}" }),
    }), state)).toEqual([]);
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "apply_patch" },
      {
        type: "tool_call_delta",
        arguments: JSON.stringify({
          input: [
            "*** Begin Patch",
            "*** Update File: src/a.ts",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
          ].join("\n"),
        }),
      },
      { type: "tool_call_end", id: "call_1" },
    ]);
  });

  test("drops a malformed structured edit call with a clear error instead of relaying it", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: [CURSOR_EDIT_FILE_TOOL],
      toolSchemas: new Map([[CURSOR_EDIT_FILE_TOOL, CURSOR_EDIT_FILE_INPUT_SCHEMA]]),
      cursorToolNameMap: new Map([[CURSOR_EDIT_FILE_TOOL, CURSOR_EDIT_FILE_TOOL]]),
    });
    const toolCall = mcpToolCall(CURSOR_EDIT_FILE_TOOL, { file_path: "src/a.ts" });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state))?.toEqual([
      { type: "error", message: expect.stringContaining("was not converted to apply_patch") },
    ]);
  });

  test("stateless native-exec path converts edit_file the same way", () => {
    const args = create(McpArgsSchema, {
      name: CURSOR_EDIT_FILE_TOOL,
      toolName: CURSOR_EDIT_FILE_TOOL,
      toolCallId: "call_2",
      providerIdentifier: "opencodex-responses",
      args: {
        file_path: encoder.encode(JSON.stringify("src/g.ts")),
        old_string: encoder.encode(JSON.stringify("x")),
        new_string: encoder.encode(JSON.stringify("y")),
      },
    });
    expect(mapSyntheticMcpExecToToolEvents(args, "fallback")).toEqual([
      { type: "tool_call_start", id: "call_2", name: "apply_patch" },
      {
        type: "tool_call_delta",
        arguments: JSON.stringify({
          input: [
            "*** Begin Patch",
            "*** Update File: src/g.ts",
            "@@",
            "-x",
            "+y",
            "*** End Patch",
          ].join("\n"),
        }),
      },
      { type: "tool_call_end", id: "call_2" },
    ]);
  });

  test("native-exec mcpArgs path (planMcpArgsHandling) emits the translated apply_patch call", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: [CURSOR_EDIT_FILE_TOOL, "apply_patch"],
      toolSchemas: new Map([[CURSOR_EDIT_FILE_TOOL, CURSOR_EDIT_FILE_INPUT_SCHEMA]]),
      cursorToolNameMap: new Map([[CURSOR_EDIT_FILE_TOOL, CURSOR_EDIT_FILE_TOOL]]),
    });
    const execMsg = create(ExecServerMessageSchema, {
      id: 7,
      execId: "exec_7",
      message: {
        case: "mcpArgs",
        value: create(McpArgsSchema, {
          name: CURSOR_EDIT_FILE_TOOL,
          toolName: CURSOR_EDIT_FILE_TOOL,
          toolCallId: "call_3",
          providerIdentifier: "opencodex-responses",
          args: {
            file_path: encoder.encode(JSON.stringify("src/h.ts")),
            old_string: encoder.encode(JSON.stringify("before")),
            new_string: encoder.encode(JSON.stringify("after")),
          },
        }),
      },
    });
    const plan = planMcpArgsHandling(execMsg, state);
    expect(plan.handledByResponsesBridge).toBe(true);
    expect(plan.cancelCursorRun).toBe(false);
    expect(plan.events).toEqual([
      { type: "tool_call_start", id: "call_3", name: "apply_patch" },
      {
        type: "tool_call_delta",
        arguments: JSON.stringify({
          input: [
            "*** Begin Patch",
            "*** Update File: src/h.ts",
            "@@",
            "-before",
            "+after",
            "*** End Patch",
          ].join("\n"),
        }),
      },
      { type: "tool_call_end", id: "call_3" },
    ]);
  });

  test("translates a non-identity wire-name mapping (Cursor display name -> Codex tool name) for multi_edit", () => {
    // Cursor advertises the Responses tool as `mcp_opencodex-responses_multi_edit`; the adapter must
    // map that display name back to the advertised `multi_edit` before translating (#399 pattern).
    const state = createCursorProtobufEventState({
      clientToolNames: [CURSOR_MULTI_EDIT_TOOL, "apply_patch"],
      toolSchemas: new Map([[CURSOR_MULTI_EDIT_TOOL, CURSOR_MULTI_EDIT_INPUT_SCHEMA]]),
      cursorToolNameMap: new Map([[CURSOR_MULTI_EDIT_TOOL, CURSOR_MULTI_EDIT_TOOL]]),
    });
    const toolCall = mcpToolCall(`mcp_opencodex-responses_${CURSOR_MULTI_EDIT_TOOL}`, {
      file_path: "src/multi.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_4", modelCallId: "model_4", toolCall }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_4", name: "apply_patch" },
      {
        type: "tool_call_delta",
        arguments: JSON.stringify({
          input: [
            "*** Begin Patch",
            "*** Update File: src/multi.ts",
            "@@",
            "-a",
            "+b",
            "@@",
            "-c",
            "+d",
            "*** End Patch",
          ].join("\n"),
        }),
      },
      { type: "tool_call_end", id: "call_4" },
    ]);
  });
});
