import { describe, expect, test } from "bun:test";
import { fromBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { normalizeArgKeys } from "../src/adapters/cursor/arg-normalize";
import {
  appendCursorGenericToolUseHint,
  buildCursorToolDefinitions,
  cursorToolsForActivePrompt,
  buildCursorToolGuidanceSystemNote,
  CURSOR_EXEC_COMMAND_INPUT_SCHEMA,
  cursorRequestAdvertisesApplyPatch,
  cursorRequestUsesCodeMode,
  isCursorCodeModeExecTool,
  cursorToolArgNormalizeSchema,
  cursorToolInputSchema,
  cursorToolWireName,
  isGenericToolUseCountDemoPrompt,
  nonEmptyShellBridgeCommandFromArgs,
} from "../src/adapters/cursor/tool-definitions";
import type { OcxTool } from "../src/types";

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
    expect(toJson(ValueSchema, fromBinary(ValueSchema, defs[0]!.inputSchema))).toEqual(tool.parameters);
  });

  test("isolates ordinary bare client identities without renaming proxy-owned or namespaced tools", () => {
    expect(cursorToolWireName({ name: "read" })).toBe("ocx_client_read");
    expect(cursorToolWireName({ name: "ocx_client_read" })).toBe("ocx_client_ocx_client_read");
    expect(cursorToolWireName({ name: "read", namespace: "mcp__workspace" })).toBe("mcp__workspace__read");
    const bare: OcxTool = { name: "read", description: "Read", parameters: {} };
    expect(buildCursorToolDefinitions([bare], { name: "read" }).map(tool => tool.toolName))
      .toEqual(["ocx_client_read"]);
    expect(buildCursorToolDefinitions([bare], { name: "ocx_client_read" }).map(tool => tool.toolName))
      .toEqual(["ocx_client_read"]);

    for (const name of [
      "exec",
      "wait",
      "exec_command",
      "shell_command",
      "apply_patch",
      "edit_file",
      "multi_edit",
      "tool_search",
    ]) {
      expect(cursorToolWireName({ name })).toBe(name);
    }
  });

  test("prefers a semantic tool name over a generated client wire alias", () => {
    const tools: OcxTool[] = [
      { name: "read", description: "Read", parameters: {} },
      { name: "ocx_client_read", description: "Literal client-prefixed tool", parameters: {} },
    ];

    expect(buildCursorToolDefinitions(tools, { name: "ocx_client_read" }).map(tool => tool.toolName))
      .toEqual(["ocx_client_ocx_client_read"]);
    expect(buildCursorToolDefinitions(tools, { mode: "required", allowedTools: ["ocx_client_read"] }).map(tool => tool.toolName))
      .toEqual(["ocx_client_ocx_client_read"]);
    expect(buildCursorToolDefinitions(tools, { name: "read" }).map(tool => tool.toolName))
      .toEqual(["ocx_client_read"]);
  });

  test("advertises bare exec_command with compact native exec schema", () => {
    const tool: OcxTool = {
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          yield_time_ms: { type: "number" },
          max_output_chars: { type: "number" },
        },
        required: ["cmd", "yield_time_ms"],
        additionalProperties: true,
      },
    };

    expect(cursorToolWireName(tool)).toBe("exec_command");
    const defs = buildCursorToolDefinitions([tool]);

    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("exec_command");
    expect(defs[0]?.toolName).toBe("exec_command");
    expect(toJson(ValueSchema, fromBinary(ValueSchema, defs[0]!.inputSchema))).toEqual(CURSOR_EXEC_COMMAND_INPUT_SCHEMA);
  });

  test("advertises bare shell_command with the same compact native exec schema", () => {
    const tool: OcxTool = {
      name: "shell_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          yield_time_ms: { type: "number" },
          max_output_chars: { type: "number" },
        },
        required: ["cmd", "yield_time_ms"],
        additionalProperties: true,
      },
    };

    expect(cursorToolWireName(tool)).toBe("shell_command");
    const defs = buildCursorToolDefinitions([tool]);

    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("shell_command");
    expect(defs[0]?.toolName).toBe("shell_command");
    expect(toJson(ValueSchema, fromBinary(ValueSchema, defs[0]!.inputSchema))).toEqual(CURSOR_EXEC_COMMAND_INPUT_SCHEMA);
  });

  test("normalizes advertised shell_command cmd args to Responses command before Codex sees them", () => {
    // Live #399 failure: Cursor advertisement requires `cmd`, models send `cmd`, but Codex
    // shell_command validates `command` → "missing field `command`". Normalization must use the
    // Responses-side schema, not the Cursor advertisement schema.
    const tool: OcxTool = {
      name: "shell_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          workdir: { type: "string" },
        },
        required: ["command"],
      },
    };

    expect(cursorToolInputSchema(tool)).toEqual(CURSOR_EXEC_COMMAND_INPUT_SCHEMA);
    expect(normalizeArgKeys({ cmd: "git status" }, cursorToolInputSchema(tool))).toEqual({ cmd: "git status" });
    expect(normalizeArgKeys({ cmd: "git status", workdir: "C:/repo" }, cursorToolArgNormalizeSchema(tool))).toEqual({
      command: "git status",
      workdir: "C:/repo",
    });
    expect(normalizeArgKeys({ command: "git status" }, cursorToolArgNormalizeSchema(tool))).toEqual({
      command: "git status",
    });
  });

  test("preserves cmd-only exec_command schemas during Responses normalization", () => {
    const tool: OcxTool = {
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          workdir: { type: "string" },
        },
        required: ["cmd"],
      },
    };

    expect(cursorToolArgNormalizeSchema(tool)).toEqual({
      type: "object",
      properties: {
        cmd: { type: "string" },
        workdir: { type: "string" },
      },
      required: ["cmd"],
    });
    expect(normalizeArgKeys({ cmd: "git status", workdir: "C:/repo" }, cursorToolArgNormalizeSchema(tool))).toEqual({
      cmd: "git status",
      workdir: "C:/repo",
    });
  });

  test("shell bridge command validation honors the schema-required command key", () => {
    const execSchema = cursorToolArgNormalizeSchema({
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    } as OcxTool);
    expect(nonEmptyShellBridgeCommandFromArgs(JSON.stringify({ cmd: "echo hi" }), "exec_command", execSchema)).toBe("echo hi");
    expect(nonEmptyShellBridgeCommandFromArgs(JSON.stringify({ command: "echo hi" }), "exec_command", execSchema)).toBe("echo hi");
    expect(nonEmptyShellBridgeCommandFromArgs(JSON.stringify({ cmd: "", command: "echo hi" }), "exec_command", execSchema)).toBe("echo hi");
    expect(nonEmptyShellBridgeCommandFromArgs(JSON.stringify({ cmd: "exec", command: "shell" }), "exec_command", execSchema)).toBe("exec");
    expect(nonEmptyShellBridgeCommandFromArgs(JSON.stringify({}), "exec_command", execSchema)).toBeUndefined();
    expect(nonEmptyShellBridgeCommandFromArgs(JSON.stringify({ cmd: " ", command: "\t" }), "exec_command", execSchema)).toBeUndefined();

    const shellSchema = cursorToolArgNormalizeSchema({
      name: "shell_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    } as OcxTool);
    expect(nonEmptyShellBridgeCommandFromArgs(JSON.stringify({ command: "echo hi" }), "shell_command", shellSchema)).toBe("echo hi");
    expect(nonEmptyShellBridgeCommandFromArgs(JSON.stringify({ cmd: "echo hi" }), "shell_command", shellSchema)).toBe("echo hi");
    expect(nonEmptyShellBridgeCommandFromArgs(JSON.stringify({ command: "", cmd: "echo hi" }), "shell_command", shellSchema)).toBe("echo hi");
    expect(nonEmptyShellBridgeCommandFromArgs(JSON.stringify({ cmd: "exec", command: "shell" }), "shell_command", shellSchema)).toBe("shell");
    expect(nonEmptyShellBridgeCommandFromArgs(JSON.stringify({}), "shell_command", shellSchema)).toBeUndefined();
    expect(nonEmptyShellBridgeCommandFromArgs(JSON.stringify({ cmd: " ", command: "\t" }), "shell_command", shellSchema)).toBeUndefined();
  });

  test("does not alias namespaced exec_command tools", () => {
    const tool: OcxTool = {
      name: "exec_command",
      namespace: "mcp__shell",
      description: "Run remote command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    };

    expect(cursorToolWireName(tool)).toBe("mcp__shell__exec_command");
    expect(buildCursorToolDefinitions([tool]).map(def => def.toolName)).toEqual(["mcp__shell__exec_command"]);
  });

  test("detects generic tool-use count demo prompts", () => {
    const positives = [
      "Use any 10 tools",
      "actually call tools, do not just say you did",
      "아무 tool 10개 써봐",
      "도구 10개 사용해",
      "tool use demo",
    ];

    for (const prompt of positives) {
      expect(isGenericToolUseCountDemoPrompt(prompt)).toBe(true);
    }

    const negatives = [
      "Run: echo hi",
      "Tell me about tool safety policies.",
      "Read a file with the filesystem tool.",
    ];

    for (const prompt of negatives) {
      expect(isGenericToolUseCountDemoPrompt(prompt)).toBe(false);
    }
  });

  test("appends generic tool-use guidance only when bare exec_command is available", () => {
    const tools: OcxTool[] = [{ name: "exec_command", description: "Run", parameters: {} }];
    const prompt = "Use any 10 tools";

    const hinted = appendCursorGenericToolUseHint(tools, prompt);

    expect(hinted).toContain(prompt);
    expect(hinted).toContain("This turn requests 10 tool uses");
    expect(hinted).toContain("exactly 10 separate Codex shell bridge function calls/results (`shell_command` or `exec_command`)");
    expect(hinted).toContain("One shell-bridge call containing chained commands counts as 1 tool call, not 10");
    expect(hinted).toContain("one parallel tool-call batch containing all 10");
    expect(hinted).toContain("repeated Codex shell bridge calls (`shell_command` or `exec_command`)");
    expect(hinted).toContain("Codex Responses shell bridge");
    expect(hinted).toContain("external MCP server tool");
    expect(hinted).toContain("bridge may suspend");
    expect(hinted).toContain("Do not use `tool_search`, external MCP, or resource discovery");
    expect(hinted).toContain("neighboring-agent tools");
    expect(hinted).toContain("unless this turn's catalog lists those exact names");
    expect(appendCursorGenericToolUseHint(tools, hinted)).toBe(hinted);
    expect(appendCursorGenericToolUseHint(
      [{ name: "exec_command", namespace: "mcp__shell", description: "Run", parameters: {} }],
      prompt,
    )).toBe(prompt);
    expect(appendCursorGenericToolUseHint(tools, "Run: echo hi")).toBe("Run: echo hi");
    expect(appendCursorGenericToolUseHint(tools, "Use exec_command 10 times")).toBe("Use exec_command 10 times");
  });

  test("filters generic tool-count demos to the Codex native exec surface", () => {
    const tools: OcxTool[] = [
      { name: "exec_command", description: "Run", parameters: {} },
      { name: "tool_search", description: "Search tools", parameters: {} },
      { name: "list_mcp_resources", description: "List resources", parameters: {} },
    ];

    expect(cursorToolsForActivePrompt(tools, "아무 tool 10개 써봐")?.map(tool => cursorToolWireName(tool))).toEqual(["exec_command"]);
    expect(cursorToolsForActivePrompt(tools, "Use any 10 tools")?.map(tool => cursorToolWireName(tool))).toEqual(["exec_command"]);
    expect(cursorToolsForActivePrompt(tools, "Use any 10 tools including MCP resources")?.map(tool => cursorToolWireName(tool))).toEqual([
      "exec_command",
      "tool_search",
      "ocx_client_list_mcp_resources",
    ]);
  });

  test("filters generic tool-count demos when only shell_command is available", () => {
    const tools: OcxTool[] = [
      { name: "shell_command", description: "Run", parameters: {} },
      { name: "tool_search", description: "Search tools", parameters: {} },
    ];

    expect(cursorToolsForActivePrompt(tools, "Use any 10 tools")?.map(tool => cursorToolWireName(tool))).toEqual(["shell_command"]);
  });

  test("preserves unified Desktop exec for generic tool-use without inventing shell aliases", () => {
    for (const namespace of [undefined, "opencodex-responses"]) {
      const tools: OcxTool[] = [
        {
          name: "exec",
          ...(namespace ? { namespace } : {}),
          description: "Run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
        { name: "wait", ...(namespace ? { namespace } : {}), description: "Wait", parameters: {} },
        { name: "tool_search", description: "Search tools", parameters: {} },
      ];

      const visible = cursorToolsForActivePrompt(tools, "Use any 3 tools");
      expect(visible?.map(tool => tool.name)).toEqual(["exec"]);
      expect(appendCursorGenericToolUseHint(tools, "Use any 3 tools")).toBe("Use any 3 tools");
    }
  });

  test("does not erase explicit non-exec tool_choice for generic tool-count prompts", () => {
    const tools: OcxTool[] = [
      { name: "exec_command", description: "Run", parameters: {} },
      { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
    ];

    const visible = cursorToolsForActivePrompt(
      tools,
      "Use any 10 tools",
      { mode: "required", allowedTools: ["read_file"] },
    );

    expect(visible?.map(tool => cursorToolWireName(tool))).toEqual(["exec_command", "mcp__fs__read_file"]);
    expect(buildCursorToolDefinitions(visible, { mode: "required", allowedTools: ["read_file"] }).map(tool => tool.toolName)).toEqual([
      "mcp__fs__read_file",
    ]);
  });

  test("applies Responses tool_choice to advertised Cursor tool definitions", () => {
    const tools: OcxTool[] = [
      { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
      { name: "write_file", namespace: "mcp__fs", description: "Write", parameters: {} },
    ];

    expect(buildCursorToolDefinitions(tools, "none")).toEqual([]);
    expect(buildCursorToolDefinitions(tools, { name: "write_file" }).map(tool => tool.toolName)).toEqual(["mcp__fs__write_file"]);
    expect(buildCursorToolDefinitions(tools, { name: "mcp__fs__read_file" }).map(tool => tool.toolName)).toEqual(["mcp__fs__read_file"]);
    expect(buildCursorToolDefinitions(tools, { mode: "auto", allowedTools: ["write_file"] }).map(tool => tool.toolName)).toEqual(["mcp__fs__write_file"]);
    expect(buildCursorToolDefinitions(tools, { mode: "required", allowedTools: ["mcp__fs__read_file"] }).map(tool => tool.toolName)).toEqual(["mcp__fs__read_file"]);
    expect(buildCursorToolDefinitions(tools, "required").map(tool => tool.toolName)).toEqual(["mcp__fs__read_file", "mcp__fs__write_file"]);
  });

  test("builds concise Cursor tool guidance from advertised wire names", () => {
    const tools: OcxTool[] = [
      { name: "exec_command", description: "Run", parameters: {} },
      { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
    ];

    const note = buildCursorToolGuidanceSystemNote(tools);
    expect(note).toBeDefined();
    if (!note) throw new Error("Expected Cursor tool guidance note");

    expect(note).toContain("`exec_command`");
    expect(note).toContain("`mcp__fs__read_file`");
    expect(note).toContain("current tool catalog as ground truth");
    expect(note).toContain("This turn does not expose neighboring-agent tool names `Read`, `Grep`, `Glob`, `Bash`, `LS`");
    expect(note).toContain("not an external MCP server tool");
    expect(note).toContain("NEVER attempt Cursor-native Shell, Read, Grep, List");
    expect(note).toContain("`exec_command` is the ONLY shell surface");
    expect(note).toContain("never as a fallback after probing a native tool");
    expect(note).toContain("Tool-selection commentary is forbidden");
    expect(note).toContain("FIRST visible action is the bridge call itself");
    expect(note).not.toContain("such as `shell_command` / `exec_command`");
    expect(note).not.toContain("Never tell the user");
    expect(note).not.toContain("silently call");
    expect(note).toContain("prefer one response containing multiple tool calls");
    expect(note).toContain("Use MCP only for explicit discovery/resource tasks");
    expect(note).toContain("not generic tool-count demos");
    expect(note).toContain("Do not count or report a tool call unless a tool result was actually returned.");
  });

  test("builds shell_command guidance with alias and anti-false-block wording", () => {
    const note = buildCursorToolGuidanceSystemNote([{ name: "shell_command", description: "Run", parameters: {} }]);
    expect(note).toBeDefined();
    if (!note) throw new Error("Expected Cursor tool guidance note");

    expect(note).toContain("`shell_command`");
    expect(note).toContain("`shell_command` and `exec_command` are aliases of the same bridge");
    expect(note).toContain("mcp_opencodex-responses_shell_command");
    expect(note).toContain("NEVER attempt Cursor-native Shell, Read, Grep, List");
    expect(note).toContain("`shell_command` is the ONLY shell surface");
    expect(note).not.toContain("Never tell the user");
    expect(note).not.toContain("silently call");
  });

  test("adds host-shell-neutral PowerShell and one-retry-stop guidance (#604)", () => {
    const note = buildCursorToolGuidanceSystemNote([{ name: "shell_command", description: "Run", parameters: {} }]);
    expect(note).toBeDefined();
    if (!note) throw new Error("Expected Cursor tool guidance note");

    expect(note).toContain("Windows PowerShell 5.1");
    expect(note).toContain("never emit Get-Content or Get-ChildItem unless the host shell is PowerShell");
    expect(note).toContain("cd /d");
    expect(note).toContain("<<EOF");
    expect(note).toContain("if ($?)");
    expect(note).toContain("`&&`/`||` are unsupported parser errors");
    expect(note).toContain("do not treat `;` as a substitute for `&&`");
    expect(note).toContain("at most one corrected bridge attempt");
    expect(note).toContain("Get-Content");
    expect(note).toContain("`cat`/`ls`/`rg`");
    expect(note).toContain("Codex client host");
  });

  test("adds codex-native edit guidance only when apply_patch is advertised", () => {
    const tools: OcxTool[] = [
      { name: "exec_command", description: "Run", parameters: {} },
      { name: "apply_patch", description: "Patch", parameters: {}, freeform: true },
    ];

    expect(cursorRequestAdvertisesApplyPatch(tools)).toBe(true);
    const note = buildCursorToolGuidanceSystemNote(tools);
    expect(note).toContain("For file edits, use the `apply_patch` tool, not built-in file write/delete tools.");

    const noPatchNote = buildCursorToolGuidanceSystemNote([{ name: "exec_command", description: "Run", parameters: {} }]);
    expect(noPatchNote).not.toContain("built-in file write/delete tools");

    const execOnlyNote = buildCursorToolGuidanceSystemNote(tools, { name: "exec_command" });
    expect(cursorRequestAdvertisesApplyPatch(tools, { name: "exec_command" })).toBe(false);
    expect(execOnlyNote).not.toContain("built-in file write/delete tools");
  });

  test("does not forbid neighboring-agent names that are actually advertised", () => {
    const tools: OcxTool[] = [
      { name: "exec_command", description: "Run", parameters: {} },
      { name: "Glob", description: "Find files", parameters: {} },
    ];

    const note = buildCursorToolGuidanceSystemNote(tools);
    expect(note).toBeDefined();
    if (!note) throw new Error("Expected Cursor tool guidance note");

    expect(note).toContain("available tool names are exactly `exec_command`, `ocx_client_Glob`");
    expect(note).toContain("This turn does not expose neighboring-agent tool names `Read`, `Grep`, `Bash`, `LS`");
    expect(note).not.toContain("`Read`, `Grep`, `Glob`, `Bash`, `LS`");
  });

  test("treats GJC lowercase read/find/bash as covering neighboring-agent names (#1992)", () => {
    const tools: OcxTool[] = [
      { name: "exec_command", description: "Run", parameters: {} },
      { name: "read", description: "Read a file", parameters: {} },
      { name: "find", description: "Find files", parameters: {} },
      { name: "bash", description: "Run a command", parameters: {} },
    ];

    const note = buildCursorToolGuidanceSystemNote(tools);
    expect(note).toBeDefined();
    if (!note) throw new Error("Expected Cursor tool guidance note");

    expect(note).toContain("available tool names are exactly `exec_command`, `ocx_client_read`, `ocx_client_find`, `ocx_client_bash`");
    expect(note).toContain("This turn does not expose neighboring-agent tool names `Grep`, `LS`");
    expect(note).not.toContain("`Read`");
    expect(note).not.toContain("`Glob`");
    expect(note).not.toContain("`Bash`");
  });

  test("omits Cursor tool guidance when no tools are advertised", () => {
    const tools: OcxTool[] = [
      { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
      { name: "write_file", namespace: "mcp__fs", description: "Write", parameters: {} },
    ];

    expect(buildCursorToolGuidanceSystemNote(undefined)).toBeUndefined();
    expect(buildCursorToolGuidanceSystemNote([], "required")).toBeUndefined();
    expect(buildCursorToolGuidanceSystemNote(tools, "none")).toBeUndefined();
    const allowedNote = buildCursorToolGuidanceSystemNote(tools, { mode: "required", allowedTools: ["write_file"] });
    expect(allowedNote).toBeDefined();
    if (!allowedNote) throw new Error("Expected Cursor tool guidance note");

    expect(allowedNote).toContain("`mcp__fs__write_file`");
    expect(allowedNote).not.toContain("`mcp__fs__read_file`");
  });
});

describe("Cursor code mode tool guidance", () => {
  const codeModeExec = (): OcxTool => ({
    name: "exec",
    description: "Run JavaScript code to orchestrate tool calls. Nested tools are available on the global `tools` object.",
    parameters: {},
    freeform: true,
  });

  test("detects code mode only when freeform exec has no bare shell bridge", () => {
    expect(cursorRequestUsesCodeMode([codeModeExec()])).toBe(true);
    expect(isCursorCodeModeExecTool(codeModeExec())).toBe(true);

    // A non-freeform `exec` is not code mode.
    expect(cursorRequestUsesCodeMode([{ name: "exec", description: "Run", parameters: {} }])).toBe(false);
    // A bare shell bridge alongside it means the flat-catalog guidance still applies.
    expect(cursorRequestUsesCodeMode([codeModeExec(), { name: "exec_command", description: "Run", parameters: {} }])).toBe(false);
    expect(cursorRequestUsesCodeMode([{ name: "exec_command", description: "Run", parameters: {} }])).toBe(false);
    expect(cursorRequestUsesCodeMode(undefined)).toBe(false);
    // Tool choice that hides exec also hides code mode.
    expect(cursorRequestUsesCodeMode([codeModeExec(), { name: "read_file", namespace: "mcp__fs", description: "R", parameters: {} }], { name: "read_file" })).toBe(false);
  });

  test("teaches the nested-helper contract instead of a top-level shell bridge", () => {
    const note = buildCursorToolGuidanceSystemNote([codeModeExec()]);
    expect(note).toBeDefined();
    if (!note) throw new Error("Expected Cursor tool guidance note");

    expect(note).toContain("is Codex code mode");
    expect(note).toContain("V8 isolate");
    expect(note).toContain("await tools.<name>(...)");
    expect(note).toContain("await tools.exec_command({cmd: " + "\"" + "ls" + "\"" + "})");
    expect(note).toContain("text(...)");
    expect(note).toContain("There is no `require`");
    expect(note).toContain("isolate global `ALL_TOOLS`");
    expect(note).toContain("not `tools.ALL_TOOLS`");
    expect(note).toContain("absence from the top-level catalog");
    expect(note).toContain("`*** Begin Patch`");
    expect(note).toContain("`*** End Patch`");
    expect(note).toContain("no trailing `***`");
    expect(note).toContain("OpenCodex does not rewrite JavaScript inside exec");

    // The flat-catalog shell-bridge guidance must NOT appear: naming a top-level
    // `exec_command` in code mode sends the model after a tool that does not exist.
    expect(note).not.toContain("is the Codex Responses shell bridge for this turn");
    expect(note).not.toContain("mcp_opencodex-responses_shell_command");
    expect(note).not.toContain("For file read/search/listing, use");
  });

  test("does not forbid a separately listed apply_patch in code mode", () => {
    const note = buildCursorToolGuidanceSystemNote([
      codeModeExec(),
      { name: "apply_patch", description: "Apply a patch", parameters: {}, freeform: true },
    ]);
    expect(note).toBeDefined();
    if (!note) throw new Error("Expected Cursor tool guidance note");

    expect(note).toContain("is Codex code mode");
    expect(note).toContain("remains callable at the top level as usual");
    expect(note).toContain("`apply_patch`");
    expect(note).not.toContain("do not call `exec_command`, `shell_command`, or `apply_patch` at the top level here");
    expect(note).toContain("do not call `exec_command` or `shell_command` at the top level here");
  });

  test("keeps other visible top-level tools callable in code mode", () => {
    // Code mode is about how `exec` works, not a claim that the rest of the catalog is nested.
    // A turn can advertise freeform `exec` alongside ordinary top-level tools, and describing
    // those as non-top-level would make the model refuse tools it can actually call.
    const note = buildCursorToolGuidanceSystemNote([
      codeModeExec(),
      { name: "mcp__fs__read_file", description: "Read a file", parameters: {} },
    ]);
    expect(note).toBeDefined();
    if (!note) throw new Error("Expected Cursor tool guidance note");

    expect(note).toContain("is Codex code mode");
    expect(note).toContain("remains callable at the top level as usual");
    expect(note).toContain("mcp__fs__read_file");
    expect(note).not.toContain("they are not separate top-level tools");
  });

  test("keeps flat-catalog shell-bridge guidance when a bare bridge is advertised", () => {
    const note = buildCursorToolGuidanceSystemNote([{ name: "exec_command", description: "Run", parameters: {} }]);
    expect(note).toBeDefined();
    if (!note) throw new Error("Expected Cursor tool guidance note");

    expect(note).toContain("is the Codex Responses shell bridge for this turn");
    expect(note).not.toContain("is Codex code mode");
    expect(note).not.toContain("V8 isolate");
  });
});
