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
  foldSequentialStructuredEdits,
  mapCursorProtobufServerMessage,
  mapSyntheticMcpExecToToolEvents,
  sanitizeCodexApplyPatch,
  sanitizeEmittedApplyPatchArgs,
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
  cursorToolsForActivePrompt,
  isCursorSyntheticStructuredEditTool,
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
    expect(tools.every(isCursorSyntheticStructuredEditTool)).toBe(true);
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

  test("derives structured-edit provenance after the final prompt filter", () => {
    const catalog = [
      execCommandTool(),
      ...cursorStructuredEditTools([applyPatchTool()], "auto"),
    ];
    const filtered = cursorToolsForActivePrompt(catalog, "Use exactly 2 tools for this demo", "auto");
    const names = (filtered ?? [])
      .filter(isCursorSyntheticStructuredEditTool)
      .map(tool => tool.name);

    expect(filtered?.map(tool => tool.name)).toEqual(["exec_command"]);
    expect(names).toEqual([]);
  });

  test("guidance note tells the model to prefer the structured edit tools", () => {
    const note = buildCursorToolGuidanceSystemNote([applyPatchTool(), ...cursorStructuredEditTools([applyPatchTool()])], "auto");
    expect(note).toContain("prefer the structured edit tools");
    expect(note).toContain("`edit_file`");
    expect(note).toContain("`multi_edit`");
    expect(note).toContain("never emit patch-like plain text as tool arguments");
    expect(note).toContain("exact leading whitespace");
    expect(note).toContain("never git-style");
    expect(note).not.toContain("rejects ambiguous hunks");
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

  test("structured edit tool text does not claim unique-hunk rejection", () => {
    const tools = cursorStructuredEditTools([applyPatchTool()], "auto");
    for (const tool of tools) {
      expect(tool.description).toContain("exact leading whitespace");
      expect(tool.description).toContain("first match");
      expect(tool.description).not.toContain("rejects ambiguous hunks");
    }
    expect(tools[0]?.description).toContain("Add File");
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

  test("folds a dependent multi_edit into one original-file hunk (#1388 L4)", () => {
    const args = JSON.stringify({
      file_path: "git.nix",
      edits: [
        { old_string: '        editor = "nvim";', new_string: '        editor = "hx";' },
        {
          old_string: '        editor = "hx";\n      };',
          new_string: '        editor = "hx";\n        excludesfile = "~/.gitignore";\n      };',
        },
      ],
    });
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, args)).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: git.nix",
        "@@",
        '-        editor = "nvim";',
        "-      };",
        '+        editor = "hx";',
        '+        excludesfile = "~/.gitignore";',
        "+      };",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("foldSequentialStructuredEdits keeps independent pairs", () => {
    expect(foldSequentialStructuredEdits([
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ])).toEqual([
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ]);
  });

  test("does not fold a later old_string that is only a substring of an earlier new_string (B8)", () => {
    expect(foldSequentialStructuredEdits([
      { old_string: "x = 1", new_string: "x = hello world" },
      { old_string: "hello world", new_string: "hello earth" },
    ])).toEqual([
      { old_string: "x = 1", new_string: "x = hello world" },
      { old_string: "hello world", new_string: "hello earth" },
    ]);
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, JSON.stringify({
      file_path: "f.txt",
      edits: [
        { old_string: "x = 1", new_string: "x = hello world" },
        { old_string: "hello world", new_string: "hello earth" },
      ],
    }))).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: f.txt",
        "@@",
        "-x = 1",
        "+x = hello world",
        "@@",
        "-hello world",
        "+hello earth",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("does not fold when an earlier new_string is only a substring of a later old_string", () => {
    expect(foldSequentialStructuredEdits([
      { old_string: "alpha", new_string: "a" },
      { old_string: "apple", new_string: "pear" },
    ])).toEqual([
      { old_string: "alpha", new_string: "a" },
      { old_string: "apple", new_string: "pear" },
    ]);
  });

  test("still folds an exact sequential hop one→two→three", () => {
    expect(foldSequentialStructuredEdits([
      { old_string: "one", new_string: "two" },
      { old_string: "two", new_string: "three" },
      { old_string: "three", new_string: "four" },
    ])).toEqual([{ old_string: "one", new_string: "four" }]);
  });

  test("still folds a later old_string that contains an earlier new_string as whole lines (L4)", () => {
    expect(foldSequentialStructuredEdits([
      { old_string: '        editor = "nvim";', new_string: '        editor = "hx";' },
      {
        old_string: '        editor = "hx";\n      };',
        new_string: '        editor = "hx";\n        excludesfile = "~/.gitignore";\n      };',
      },
    ])).toEqual([{
      old_string: '        editor = "nvim";\n      };',
      new_string: '        editor = "hx";\n        excludesfile = "~/.gitignore";\n      };',
    }]);
  });

  test("converts edit_file with empty old_string into Add File (R6)", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "hello.txt", old_string: "", new_string: "hello world\n" }),
    )).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Add File: hello.txt",
        "+hello world",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("copies old_string leading whitespace onto a flush-left new_string of the same line count", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({
        file_path: "math.py",
        old_string: "    return a - b",
        new_string: "return a + b",
      }),
    )).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: math.py",
        "@@",
        "-    return a - b",
        "+    return a + b",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("folds a later edit that tweaks a whole line inside an earlier replacement", () => {
    expect(foldSequentialStructuredEdits([
      { old_string: "foo\nbar", new_string: "foo\nbaz\nqux" },
      { old_string: "baz", new_string: "BAZ" },
    ])).toEqual([{ old_string: "foo\nbar", new_string: "foo\nBAZ\nqux" }]);
  });

  test("copies a leading tab onto a flush-left new_string", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "t.nix", old_string: "\tname = nvim", new_string: "name = hx" }),
    )).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: t.nix",
        "@@",
        "-\tname = nvim",
        "+\tname = hx",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("does not copy indent when the replacement changes line count", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({
        file_path: "a.ts",
        old_string: "    foo",
        new_string: "foo\nbar",
      }),
    )).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-    foo",
        "+foo",
        "+bar",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("does not invent indent when new_string already has leading whitespace", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({
        file_path: "git.nix",
        old_string: '        editor = "nvim";',
        new_string: '        editor = "hx";',
      }),
    )).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: git.nix",
        "@@",
        '-        editor = "nvim";',
        '+        editor = "hx";',
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("sanitizeCodexApplyPatch rewrites git-style hunk headers and missing envelopes", () => {
    expect(sanitizeCodexApplyPatch([
      "*** Begin Patch",
      "*** Update File: git.nix",
      "@@ -3,7 +3,7 @@",
      '-        editor = "nvim";',
      '+        editor = "hx";',
      "*** End Patch",
    ].join("\n"))).toContain("\n@@\n");
    expect(sanitizeCodexApplyPatch([
      "*** Update File: git.nix",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n")).startsWith("*** Begin Patch")).toBe(true);
    const alreadyValid = [
      "*** Begin Patch",
      "*** Update File: git.nix",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
      "",
    ].join("\n");
    expect(sanitizeCodexApplyPatch(alreadyValid)).toBe(alreadyValid.replace(/\n+$/, ""));
    expect(sanitizeCodexApplyPatch(alreadyValid).split("*** End Patch").length).toBe(2);
  });

  test("does not wrap a hunk that has no file operation (OFF_L8)", () => {
    const hunkOnly = sanitizeCodexApplyPatch(["@@", "-old", "+new"].join("\n"));
    expect(hunkOnly.startsWith("*** Begin Patch")).toBe(false);
    expect(hunkOnly).toBe(["@@", "-old", "+new"].join("\n"));
  });

  test("strips a git unified-diff preamble and infers Update File from +++ b/", () => {
    expect(sanitizeCodexApplyPatch([
      "diff --git a/git.nix b/git.nix",
      "--- a/git.nix",
      "+++ b/git.nix",
      "@@ -3,7 +3,7 @@",
      '-        editor = "nvim";',
      '+        editor = "hx";',
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Update File: git.nix",
      "@@",
      '-        editor = "nvim";',
      '+        editor = "hx";',
      "*** End Patch",
    ].join("\n"));
  });

  test("keeps a CR that is already in old_string and does not invent one on new_string", () => {
    // Codex 0.147 strips CR from patch lines on apply, so copying CR onto new_string is a no-op.
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({
        file_path: "crlf.txt",
        old_string: "beta\r\n",
        new_string: "BETA\n",
      }),
    )).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: crlf.txt",
        "@@",
        "-beta\r",
        "+BETA",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("rejects multi_edit edits that share the same old_string after line normalization", () => {
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, JSON.stringify({
      file_path: "a.txt",
      edits: [
        { old_string: "editor = nvim", new_string: "editor = hx" },
        { old_string: "editor = nvim\n", new_string: "editor = vim" },
      ],
    }))?.error).toContain("same old_string");
  });

  test("rejects multi_edit hunks whose old_string is a whole-line subset of another (overlapping first-match)", () => {
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, JSON.stringify({
      file_path: "a.txt",
      edits: [
        { old_string: "line1\nline2", new_string: "LINE1\nLINE2" },
        { old_string: "line2", new_string: "x" },
      ],
    }))?.error).toContain("overlap");
  });

  test("converts multi_edit empty old_string into Add File", () => {
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, JSON.stringify({
      file_path: "hello.txt",
      edits: [{ old_string: "", new_string: "hello world\n" }],
    }))).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Add File: hello.txt",
        "+hello world",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("folds a later tweak into a multi_edit Add File", () => {
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, JSON.stringify({
      file_path: "hello.txt",
      edits: [
        { old_string: "", new_string: "hello" },
        { old_string: "hello", new_string: "hello world" },
      ],
    }))).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Add File: hello.txt",
        "+hello world",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("rejects multi_edit that mixes Add File with an independent Update hunk", () => {
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, JSON.stringify({
      file_path: "hello.txt",
      edits: [
        { old_string: "", new_string: "hello" },
        { old_string: "other", new_string: "OTHER" },
      ],
    }))?.error).toContain("Add File");
  });

  test("normalizes file_path whitespace, ./ prefix, and Windows slashes", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "  ./src\\foo.ts  ", old_string: "a", new_string: "b" }),
    )).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: src/foo.ts",
        "@@",
        "-a",
        "+b",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("infers Add File from a git new-file preamble", () => {
    expect(sanitizeCodexApplyPatch([
      "diff --git a/hello.txt b/hello.txt",
      "new file mode 100644",
      "index 0000000..3b18e51",
      "--- /dev/null",
      "+++ b/hello.txt",
      "@@ -0,0 +1 @@",
      "+hello world",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Add File: hello.txt",
      "+hello world",
      "*** End Patch",
    ].join("\n"));
  });

  test("infers Delete File from a git deleted-file preamble", () => {
    expect(sanitizeCodexApplyPatch([
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index 3b18e51..0000000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-delete me",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Delete File: gone.txt",
      "*** End Patch",
    ].join("\n"));
  });

  test("infers Update File + Move to from a git rename", () => {
    expect(sanitizeCodexApplyPatch([
      "diff --git a/old.txt b/new.txt",
      "similarity index 80%",
      "rename from old.txt",
      "rename to new.txt",
      "--- a/old.txt",
      "+++ b/new.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n"));
  });

  test("splits a multi-file git diff into one Codex file operation per path", () => {
    expect(sanitizeCodexApplyPatch([
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-old",
      "+new",
      "*** Update File: b.txt",
      "@@",
      "-x",
      "+y",
      "*** End Patch",
    ].join("\n"));
  });

  test("strips git no-newline markers and old/new mode lines", () => {
    expect(sanitizeCodexApplyPatch([
      "diff --git a/a.txt b/a.txt",
      "old mode 100644",
      "new mode 100755",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n"));
  });

  test("unquotes a git path with spaces", () => {
    expect(sanitizeCodexApplyPatch([
      'diff --git "a/my file.txt" "b/my file.txt"',
      '--- "a/my file.txt"',
      '+++ "b/my file.txt"',
      "@@ -1 +1 @@",
      "-hello",
      "+HELLO",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Update File: my file.txt",
      "@@",
      "-hello",
      "+HELLO",
      "*** End Patch",
    ].join("\n"));
  });

  test("strips a trailing CR from CRLF-encoded git patch lines", () => {
    const lf = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    expect(sanitizeCodexApplyPatch(["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-old", "+new"].join("\r\n"))).toBe(sanitizeCodexApplyPatch(lf));
  });

  test("does not invent an Update File for a git binary diff", () => {
    const binary = [
      "diff --git a/x.bin b/x.bin",
      "index 111..222",
      "Binary files a/x.bin and b/x.bin differ",
    ].join("\n");
    expect(sanitizeCodexApplyPatch(binary)).toBe(binary);
    expect(sanitizeCodexApplyPatch(binary).startsWith("*** Begin Patch")).toBe(false);
  });

  test("does not drop a binary file from a mixed git diff", () => {
    const mixed = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/x.bin b/x.bin",
      "Binary files a/x.bin and b/x.bin differ",
    ].join("\n");
    expect(sanitizeCodexApplyPatch(mixed)).toBe(mixed);
  });

  test("does not treat a git copy as a Move (source must stay)", () => {
    const copy = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "copy from old.txt",
      "copy to new.txt",
    ].join("\n");
    // A 100% copy has no hunk bytes. Inventing Move would delete the source;
    // inventing an empty Add File would not copy contents. Leave the original.
    expect(sanitizeCodexApplyPatch(copy)).toBe(copy);
  });

  test("keeps unified-diff context lines on an Update File", () => {
    expect(sanitizeCodexApplyPatch([
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      " also",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " keep",
      "-old",
      "+new",
      " also",
      "*** End Patch",
    ].join("\n"));
  });

  test("does not invent an empty Update File for a mode-only git diff", () => {
    const modeOnly = [
      "diff --git a/a.txt b/a.txt",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    expect(sanitizeCodexApplyPatch(modeOnly)).toBe(modeOnly);
  });

  test("does not invent an empty Update hunk for a 100% git rename", () => {
    const rename = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
    ].join("\n");
    // Codex 0.147 rejects "Update file hunk ... is empty". A 100% rename has no
    // bytes we can put in a hunk, so leave the original git text alone.
    expect(sanitizeCodexApplyPatch(rename)).toBe(rename);
  });

  test("rejects a file_path that normalizes to empty", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "./", old_string: "a", new_string: "b" }),
    )?.error).toContain("file_path");
  });

  test("rejects a file_path that contains a newline or NUL", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "foo\nbar.ts", old_string: "a", new_string: "b" }),
    )?.error).toContain("file_path");
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "foo\u0000bar.ts", old_string: "a", new_string: "b" }),
    )?.error).toContain("file_path");
  });

  test("infers Update File from a unified diff that has no diff --git line", () => {
    expect(sanitizeCodexApplyPatch([
      "--- a/git.nix",
      "+++ b/git.nix",
      "@@ -3,7 +3,7 @@",
      '-        editor = "nvim";',
      '+        editor = "hx";',
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Update File: git.nix",
      "@@",
      '-        editor = "nvim";',
      '+        editor = "hx";',
      "*** End Patch",
    ].join("\n"));
  });

  test("infers Add File from --- /dev/null without diff --git", () => {
    expect(sanitizeCodexApplyPatch([
      "--- /dev/null",
      "+++ b/hello.txt",
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Add File: hello.txt",
      "+hello",
      "*** End Patch",
    ].join("\n"));
  });

  test("splits two unified diffs that have no diff --git lines", () => {
    expect(sanitizeCodexApplyPatch([
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-old",
      "+new",
      "*** Update File: b.txt",
      "@@",
      "-x",
      "+y",
      "*** End Patch",
    ].join("\n"));
  });

  test("strips markdown fences and leading/trailing prose from a Codex patch", () => {
    expect(sanitizeCodexApplyPatch([
      "Sure, here is the patch:",
      "```diff",
      "*** Begin Patch",
      "*** Update File: git.nix",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
      "```",
      "Hope that helps!",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Update File: git.nix",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n"));
  });

  test("rewrites a hunk header that omits the trailing @@", () => {
    expect(sanitizeCodexApplyPatch([
      "*** Begin Patch",
      "*** Update File: git.nix",
      "@@ -1,3 +1,3",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n"))).toContain("\n@@\n");
  });

  test("does not re-wrap an empty Update File (Codex rejects empty hunks)", () => {
    const empty = ["*** Begin Patch", "*** Update File: foo.txt", "*** End Patch"].join("\n");
    expect(sanitizeCodexApplyPatch(empty)).toBe(empty);
  });

  test("drops @@ after Add File (every Add File line must be a + line)", () => {
    expect(sanitizeCodexApplyPatch([
      "*** Begin Patch",
      "*** Add File: hello.txt",
      "@@",
      "+hello",
      "*** End Patch",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Add File: hello.txt",
      "+hello",
      "*** End Patch",
    ].join("\n"));
  });

  test("normalizes ./ and Windows slashes on an existing Codex file header", () => {
    expect(sanitizeCodexApplyPatch([
      "*** Begin Patch",
      "*** Update File: ./src\\foo.ts",
      "@@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Update File: src/foo.ts",
      "@@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n"));
  });

  test("accepts file and contents aliases on edit_file", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file: "a.ts", old_string: "a", new_string: "b" }),
    )).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-a",
        "+b",
        "*** End Patch",
      ].join("\n"),
    });
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "hello.txt", old_string: "", contents: "hello" }),
    )).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Add File: hello.txt",
        "+hello",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("rejects a file_path that contains a CR (header injection)", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "foo\r*** Delete File: secrets.env", old_string: "a", new_string: "b" }),
    )?.error).toContain("file_path");
  });

  test("rejects replace_all because apply_patch first-matches only", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "a.ts", old_string: "x", new_string: "y", replace_all: true }),
    )?.error).toContain("replace_all");
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, JSON.stringify({
      file_path: "a.ts",
      edits: [{ old_string: "x", new_string: "y", replace_all: true }],
    }))?.error).toContain("replace_all");
  });

  test("sanitizeEmittedApplyPatchArgs rewrites a patch key onto input", () => {
    const raw = JSON.stringify({
      patch: [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    });
    expect(JSON.parse(sanitizeEmittedApplyPatchArgs(raw))).toEqual({
      input: [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("canonicalizes lowercase Codex file-op headers", () => {
    expect(sanitizeCodexApplyPatch([
      "*** begin patch",
      "*** update file: git.nix",
      "@@",
      "-old",
      "+new",
      "*** end patch",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Update File: git.nix",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n"));
  });

  test("accepts *** Update File path without a colon", () => {
    expect(sanitizeCodexApplyPatch([
      "*** Update File a.txt",
      "@@",
      "-old",
      "+new",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n"));
  });

  test("prefixes unprefixed Add File body lines with +", () => {
    expect(sanitizeCodexApplyPatch([
      "*** Begin Patch",
      "*** Add File: hello.txt",
      "hello world",
      "second line",
      "*** End Patch",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Add File: hello.txt",
      "+hello world",
      "+second line",
      "*** End Patch",
    ].join("\n"));
  });

  test("infers Add File from +++ b/ with only added lines and no --- a/", () => {
    expect(sanitizeCodexApplyPatch([
      "+++ b/hello.txt",
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n"))).toBe([
      "*** Begin Patch",
      "*** Add File: hello.txt",
      "+hello",
      "*** End Patch",
    ].join("\n"));
  });

  test("joins array old_string/new_string into a replacement", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "a.ts", old_string: ["line1", "line2"], new_string: ["line1", "changed"] }),
    )).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-line1",
        "-line2",
        "+line1",
        "+changed",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("parses a JSON-string edits array on multi_edit", () => {
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, JSON.stringify({
      file_path: "a.ts",
      edits: JSON.stringify([{ old_string: "a", new_string: "b" }]),
    }))).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-a",
        "+b",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("parses double-encoded structured edit arguments", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify(JSON.stringify({ file_path: "a.ts", old_string: "a", new_string: "b" })),
    )).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-a",
        "+b",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("accepts before/after and search/replace aliases", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "a.ts", before: "a", after: "b" }),
    )).toEqual(expect.objectContaining({ patch: expect.stringContaining("+b") }));
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "a.ts", search: "a", replace: "b" }),
    )).toEqual(expect.objectContaining({ patch: expect.stringContaining("+b") }));
  });

  test("does not treat from/to as a text replacement (rename-shaped args)", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "a.ts", from: "old.ts", to: "new.ts" }),
    )?.error).toContain("old_string");
  });

  test("does not treat a bare delete flag as Delete File", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "gone.txt", delete: true }),
    )?.error).toBeTruthy();
  });

  test("converts delete_file: true into Delete File", () => {
    expect(translateStructuredEditCall(
      CURSOR_EDIT_FILE_TOOL,
      JSON.stringify({ file_path: "gone.txt", delete_file: true }),
    )).toEqual({
      patch: [
        "*** Begin Patch",
        "*** Delete File: gone.txt",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("sanitizes apply_patch input when it is an array of lines", () => {
    expect(JSON.parse(sanitizeEmittedApplyPatchArgs(JSON.stringify({
      input: ["*** Begin Patch", "*** Update File: a.txt", "@@ -1 +1 @@", "-old", "+new", "*** End Patch"],
    })))).toEqual({
      input: [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("sanitizes a raw unified diff that has no @@ or Begin Patch", () => {
    expect(JSON.parse(sanitizeEmittedApplyPatchArgs([
      "--- a/a.txt",
      "+++ b/a.txt",
      "-old",
      "+new",
    ].join("\n")))).toEqual({
      input: [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("unwraps a nested JSON input string", () => {
    expect(JSON.parse(sanitizeEmittedApplyPatchArgs(JSON.stringify({
      input: JSON.stringify({
        input: ["*** Begin Patch", "*** Update File: a.txt", "@@", "-old", "+new", "*** End Patch"].join("\n"),
      }),
    })))).toEqual({
      input: [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("rejects overlapping multi_edit when the shorter old_string comes first", () => {
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, JSON.stringify({
      file_path: "a.txt",
      edits: [
        { old_string: "line2", new_string: "x" },
        { old_string: "line1\nline2", new_string: "LINE1\nLINE2" },
      ],
    }))?.error).toContain("overlap");
  });

  test("sanitizeEmittedApplyPatchArgs rewrites a JSON git new-file payload", () => {
    const raw = JSON.stringify({
      input: [
        "diff --git a/hello.txt b/hello.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/hello.txt",
        "@@ -0,0 +1 @@",
        "+hello world",
      ].join("\n"),
    });
    expect(JSON.parse(sanitizeEmittedApplyPatchArgs(raw))).toEqual({
      input: [
        "*** Begin Patch",
        "*** Add File: hello.txt",
        "+hello world",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test("rejects malformed structured edit calls instead of relaying invalid patch text", () => {
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, "not json")?.error).toBeTruthy();
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, JSON.stringify({ file_path: "src/f.ts" }))?.error).toBeTruthy();
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, JSON.stringify({ file_path: "", old_string: "a", new_string: "b" }))?.error).toBeTruthy();
    expect(translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, JSON.stringify({ file_path: "src/f.ts", old_string: "", new_string: "" }))?.error).toBeTruthy();
    expect(translateStructuredEditCall(CURSOR_MULTI_EDIT_TOOL, JSON.stringify({
      file_path: "src/f.ts",
      edits: [{ old_string: "", new_string: "b" }],
    }))).toEqual(expect.objectContaining({ patch: expect.stringContaining("*** Add File: src/f.ts") }));
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

  test("intentional full dedent is not rejected as a no-op", () => {
    const args = JSON.stringify({
      file_path: "src/indent.ts",
      old_string: "    return value",
      new_string: "return value",
    });
    const result = translateStructuredEditCall(CURSOR_EDIT_FILE_TOOL, args);
    expect(result).toHaveProperty("patch");
    expect(result).not.toHaveProperty("error");
    expect((result as { patch: string }).patch).toContain("-    return value");
    expect((result as { patch: string }).patch).toContain("+return value");
  });
});

describe("cursor protobuf event translation", () => {
  test("emits a structured edit_file call as an apply_patch custom tool call", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: [CURSOR_EDIT_FILE_TOOL, "apply_patch"],
      // We advertised the synthetic edit tool on this request, so conversion is ours to do.
      syntheticStructuredEditToolNames: [CURSOR_EDIT_FILE_TOOL],
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

  test("sanitizes a freeform apply_patch git-style header before Codex sees it (#1388 L3)", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: ["apply_patch"],
      toolSchemas: new Map([["apply_patch", { type: "object", properties: { input: { type: "string" } } }]]),
      cursorToolNameMap: new Map([["apply_patch", "apply_patch"]]),
    });
    const toolCall = mcpToolCall("apply_patch", {
      input: [
        "*** Begin Patch",
        "*** Update File: git.nix",
        "@@ -3,7 +3,7 @@",
        '-        editor = "nvim";',
        '+        editor = "hx";',
        "*** End Patch",
      ].join("\n"),
    });
    const events = mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_p", modelCallId: "model_p", toolCall }),
    }), state);
    expect(events[0]).toEqual({ type: "tool_call_start", id: "call_p", name: "apply_patch" });
    expect(events[1]).toEqual({
      type: "tool_call_delta",
      arguments: expect.stringContaining("\\n@@\\n"),
    });
    expect(JSON.stringify(events)).not.toContain("@@ -3,7 +3,7 @@");
  });

  test("emits empty-old_string edit_file as apply_patch Add File", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: [CURSOR_EDIT_FILE_TOOL, "apply_patch"],
      syntheticStructuredEditToolNames: [CURSOR_EDIT_FILE_TOOL],
      toolSchemas: new Map([[CURSOR_EDIT_FILE_TOOL, CURSOR_EDIT_FILE_INPUT_SCHEMA]]),
      cursorToolNameMap: new Map([[CURSOR_EDIT_FILE_TOOL, CURSOR_EDIT_FILE_TOOL]]),
    });
    const toolCall = mcpToolCall(CURSOR_EDIT_FILE_TOOL, {
      file_path: "hello.txt",
      old_string: "",
      new_string: "hello world\n",
    });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_add", modelCallId: "model_add", toolCall }),
    }), state)).toEqual([
      { type: "tool_call_start", id: "call_add", name: "apply_patch" },
      {
        type: "tool_call_delta",
        arguments: JSON.stringify({
          input: ["*** Begin Patch", "*** Add File: hello.txt", "+hello world", "*** End Patch"].join("\n"),
        }),
      },
      { type: "tool_call_end", id: "call_add" },
    ]);
  });

  test("surfaces a malformed structured edit as recoverable text instead of failing the turn (#1388 L6/L7)", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: [CURSOR_EDIT_FILE_TOOL],
      syntheticStructuredEditToolNames: [CURSOR_EDIT_FILE_TOOL],
      toolSchemas: new Map([[CURSOR_EDIT_FILE_TOOL, CURSOR_EDIT_FILE_INPUT_SCHEMA]]),
      cursorToolNameMap: new Map([[CURSOR_EDIT_FILE_TOOL, CURSOR_EDIT_FILE_TOOL]]),
    });
    const toolCall = mcpToolCall(CURSOR_EDIT_FILE_TOOL, { file_path: "src/a.ts" });
    expect(mapCursorProtobufServerMessage(interaction({
      case: "toolCallCompleted",
      value: create(ToolCallCompletedUpdateSchema, { callId: "call_1", modelCallId: "model_1", toolCall }),
    }), state))?.toEqual([
      { type: "text", text: expect.stringContaining("was not converted to apply_patch") },
    ]);
  });

  test("stateless native-exec path passes edit_file through untranslated (no provenance)", () => {
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
    // The stateless branch carries no request state, so it has no record of whether WE
    // advertised `edit_file` on this request. Converting on the name alone would rewrite a
    // client or MCP tool of the same name into an apply_patch it never asked for (#1036
    // review), so this path relays the call untouched. The live transport always seeds
    // state, so real traffic still converts — see the stateful tests above.
    const events = mapSyntheticMcpExecToToolEvents(args, "fallback");
    expect(events[0]).toEqual({ type: "tool_call_start", id: "call_2", name: CURSOR_EDIT_FILE_TOOL });
    expect(JSON.stringify(events)).not.toContain("*** Begin Patch");
    expect(events.at(-1)).toEqual({ type: "tool_call_end", id: "call_2" });
  });

  test("a client tool named edit_file is not hijacked when we advertised nothing (#1036 review)", () => {
    // The collision the name-only gate allowed: an MCP server exposing `edit_file`. State exists
    // (so this is the live shape), but syntheticStructuredEditToolNames is absent because we
    // advertised no synthetic tools on this request.
    const state = createCursorProtobufEventState({
      clientToolNames: [CURSOR_EDIT_FILE_TOOL],
      toolSchemas: new Map([[CURSOR_EDIT_FILE_TOOL, CURSOR_EDIT_FILE_INPUT_SCHEMA]]),
      cursorToolNameMap: new Map([[CURSOR_EDIT_FILE_TOOL, CURSOR_EDIT_FILE_TOOL]]),
    });
    const args = create(McpArgsSchema, {
      name: CURSOR_EDIT_FILE_TOOL,
      toolName: CURSOR_EDIT_FILE_TOOL,
      toolCallId: "call_collision",
      providerIdentifier: "opencodex-responses",
      args: {
        file_path: encoder.encode(JSON.stringify("src/client-owned.ts")),
        old_string: encoder.encode(JSON.stringify("x")),
        new_string: encoder.encode(JSON.stringify("y")),
      },
    });

    const events = mapSyntheticMcpExecToToolEvents(args, "call_collision", { state });

    expect(JSON.stringify(events)).not.toContain("*** Begin Patch");
    expect(JSON.stringify(events)).not.toContain("was not converted to apply_patch");
    expect(JSON.stringify(events)).toContain(CURSOR_EDIT_FILE_TOOL);
  });

  test("native-exec mcpArgs path (planMcpArgsHandling) emits the translated apply_patch call", () => {
    const state = createCursorProtobufEventState({
      clientToolNames: [CURSOR_EDIT_FILE_TOOL, "apply_patch"],
      // We advertised the synthetic edit tool on this request, so conversion is ours to do.
      syntheticStructuredEditToolNames: [CURSOR_EDIT_FILE_TOOL],
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
      syntheticStructuredEditToolNames: [CURSOR_MULTI_EDIT_TOOL],
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
