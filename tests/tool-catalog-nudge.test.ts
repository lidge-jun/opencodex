import { describe, expect, test } from "bun:test";
import {
  buildNonOpenAIToolCatalogNudgeForTools,
  buildNonOpenAIToolCatalogNudgeFromNames,
  shouldInjectNonOpenAIToolCatalogNudge,
} from "../src/adapters/tool-catalog-nudge";
import type { OcxTool } from "../src/types";

describe("non-OpenAI tool catalog nudge", () => {
  test("builds a compact catalog-grounding note from wire names", () => {
    const note = buildNonOpenAIToolCatalogNudgeFromNames(["exec_command", "mcp__fs__read_file"]);

    expect(note).toContain("current tool catalog as ground truth");
    expect(note).toContain("Valid tool names for this turn are exactly `exec_command`, `mcp__fs__read_file`");
    expect(note).toContain("These listed names are the complete top-level tool-call surface for this turn");
    expect(note).toContain("do not invent, translate, or rename tools");
    expect(note).toContain("Names mentioned only in instructions, tool descriptions, argument descriptions, or nested helper APIs are not additional top-level tools");
    expect(note).toContain("call the listed parent tool and use those helpers only inside that tool's input");
    expect(note).toContain("Count a tool call only after its tool result returns");
  });

  test("does not forbid neighboring tool names that are actually listed", () => {
    const note = buildNonOpenAIToolCatalogNudgeFromNames(["exec_command", "Glob"]);

    expect(note).toContain("`exec_command`, `Glob`");
    expect(note).toContain("`Read`, `Grep`, `Bash`, `LS`");
    expect(note).not.toContain("`Read`, `Grep`, `Glob`, `Bash`, `LS`");
  });

  // Codex owns apply_patch; it is not a neighboring harness's tool. Under code mode it is only
  // reachable as a nested `tools.apply_patch(...)` helper inside the exec tool description, so a
  // flat catalog check cannot see it — and forbidding it drove routed models to python heredocs.
  test("never forbids apply_patch, even when the flat catalog omits it", () => {
    const note = buildNonOpenAIToolCatalogNudgeFromNames(["exec", "wait", "request_user_input"]);

    expect(note).not.toContain("apply_patch");
    expect(note).toContain("`Read`, `Grep`, `Glob`, `Bash`, `LS`");
  });

  test("never forbids apply_patch through the tool-object entry point either", () => {
    const tools: OcxTool[] = [
      {
        name: "exec",
        description: "Run JavaScript. declare const tools: { apply_patch(input: string): Promise<unknown>; };",
        parameters: {},
      },
    ];

    expect(buildNonOpenAIToolCatalogNudgeForTools(tools)).not.toContain("apply_patch");
  });

  const codeModeExec = (): OcxTool => ({
    name: "exec",
    freeform: true,
    description: "Run JavaScript in a V8 isolate.",
    parameters: {},
  } as OcxTool);

  test("defines nested helper names as non-callable unless separately listed", () => {
    const note = buildNonOpenAIToolCatalogNudgeForTools([
      codeModeExec(),
      { name: "wait", parameters: {} } as OcxTool,
      { name: "request_user_input", parameters: {} } as OcxTool,
    ]);

    expect(note).toContain("Valid tool names for this turn are exactly `exec`, `wait`, `request_user_input`");
    expect(note).toContain("complete top-level tool-call surface");
    expect(note).toContain("nested helper APIs are not additional top-level tools");
    expect(note).toContain("`exec` is Codex code mode");
    expect(note).toContain("await tools.<name>(...)");
    expect(note).toContain("await tools.codex_app__list_threads({})");
    expect(note).toContain("isolate global `ALL_TOOLS`, not `tools.ALL_TOOLS`");
    expect(note).toContain("Do not skip an available nested helper");
    expect(note).not.toContain("call the listed parent tool and use those helpers only inside that tool's input");
    expect(note).not.toContain("apply_patch");
  });

  test("keeps the generic nested-helper parent-tool rule when exec is not listed", () => {
    const note = buildNonOpenAIToolCatalogNudgeFromNames(["exec_command", "mcp__fs__read_file"]);

    expect(note).toContain("call the listed parent tool and use those helpers only inside that tool's input");
    expect(note).not.toContain("is Codex code mode");
    expect(note).not.toContain("tools.ALL_TOOLS");
  });

  test("detects a wire-renamed exec as code mode", () => {
    const note = buildNonOpenAIToolCatalogNudgeForTools(
      [codeModeExec(), { name: "wait", parameters: {} } as OcxTool],
      undefined,
      tool => `cx_${tool.name}`,
    );

    expect(note).toContain("`cx_exec` is Codex code mode");
    expect(note).toContain("from `cx_exec`'s description is not absence");
    expect(note).toContain("isolate global `ALL_TOOLS`, not `tools.ALL_TOOLS`");
  });

  // The three cases the #1895 review named. Code mode is a semantic shape, not the name `exec`:
  // a structured `exec` runs a shell string, and `exec` beside a visible shell bridge is the
  // flat-catalog shape. Telling either of those turns that `exec` takes JavaScript and that
  // shell is nested-only is actively wrong — the model then sends the wrong arguments or
  // avoids a legitimate top-level execution tool.
  test("a structured tool named exec is NOT code mode", () => {
    const note = buildNonOpenAIToolCatalogNudgeForTools([
      { name: "exec", freeform: false, parameters: {} } as OcxTool,
      { name: "mcp__fs__read_file", parameters: {} } as OcxTool,
    ]);

    expect(note).not.toContain("is Codex code mode");
    expect(note).not.toContain("tools.ALL_TOOLS");
    expect(note).toContain("call the listed parent tool and use those helpers only inside that tool's input");
  });

  test("freeform exec beside a visible shell bridge is NOT code mode", () => {
    for (const bridge of ["exec_command", "shell_command"]) {
      const note = buildNonOpenAIToolCatalogNudgeForTools([
        codeModeExec(),
        { name: bridge, parameters: {} } as OcxTool,
      ]);

      expect(note).not.toContain("is Codex code mode");
      expect(note).toContain("call the listed parent tool and use those helpers only inside that tool's input");
    }
  });

  test("a transformed freeform exec still receives code-mode guidance", () => {
    const note = buildNonOpenAIToolCatalogNudgeForTools(
      [codeModeExec()],
      undefined,
      tool => `custom_${tool.name}`,
    );

    expect(note).toContain("`custom_exec` is Codex code mode");
  });

  // "Bare" means un-namespaced. An MCP server can advertise its own `exec_command` — docker,
  // k8s and ssh servers plausibly do — and that is not Codex's shell bridge. Letting it cancel
  // code mode silently strips the guidance from a genuine code-mode turn, which is how the
  // Cursor original (`isBareCodexShellBridgeTool`) has always read it.
  test("a namespaced MCP shell tool does not cancel code mode", () => {
    for (const name of ["exec_command", "shell_command"]) {
      const note = buildNonOpenAIToolCatalogNudgeForTools([
        codeModeExec(),
        { namespace: "mcp__docker", name, parameters: {} } as OcxTool,
      ]);

      expect(note).toContain("is Codex code mode");
    }
  });

  test("a namespaced freeform exec is not Codex's own code-mode tool", () => {
    const note = buildNonOpenAIToolCatalogNudgeForTools([
      { namespace: "mcp__sandbox", name: "exec", freeform: true, parameters: {} } as OcxTool,
    ]);

    expect(note).not.toContain("is Codex code mode");
    expect(note).toContain("call the listed parent tool and use those helpers only inside that tool's input");
  });

  // `advertised` holds WIRE names. A provider that rewrites them (Claude OAuth `custom_`,
  // Anthropic compat `cx_`) must not have every neighbor name declared unavailable while the
  // catalog plainly lists the prefixed form.
  test("resolves neighbor names through the catalog's wire transform", () => {
    const note = buildNonOpenAIToolCatalogNudgeFromNames(
      ["cx_Read", "cx_Bash", "cx_shell"],
      name => `cx_${name}`,
    );

    expect(note).toContain("`Grep`, `Glob`, `LS`");
    expect(note).not.toContain("`Read`");
    expect(note).not.toContain("`Bash`");
  });

  test("threads the wire transform from the tool-object entry point", () => {
    const tools: OcxTool[] = [
      { name: "Read", description: "read", parameters: {} },
      { name: "shell", description: "run", parameters: {} },
    ];

    const note = buildNonOpenAIToolCatalogNudgeForTools(tools, undefined, tool => `custom_${tool.name}`);

    expect(note).toContain("`custom_Read`, `custom_shell`");
    expect(note).toContain("`Grep`, `Glob`, `Bash`, `LS`");
    expect(note).not.toContain("`Read`, `Grep`");
  });

  test("applies tool_choice before listing valid names", () => {
    const tools: OcxTool[] = [
      { name: "exec_command", description: "Run", parameters: {} },
      { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
    ];

    const note = buildNonOpenAIToolCatalogNudgeForTools(tools, { mode: "required", allowedTools: ["mcp__fs__read_file"] });

    expect(note).toContain("`mcp__fs__read_file`");
    expect(note).not.toContain("`exec_command`,");
  });

  test("keeps a uniquely named namespace tool visible when allowed_tools uses its bare name", () => {
    const tools: OcxTool[] = [
      { name: "exec", namespace: "functions", description: "Run", parameters: {} },
      { name: "read_file", namespace: "mcp__fs", description: "Read", parameters: {} },
    ];

    const note = buildNonOpenAIToolCatalogNudgeForTools(tools, { mode: "required", allowedTools: ["exec"] });

    expect(note).toContain("`functions__exec`");
    expect(note).not.toContain("`mcp__fs__read_file`");
  });

  test("skips OpenAI and ChatGPT hosts", () => {
    expect(shouldInjectNonOpenAIToolCatalogNudge({ baseUrl: "https://api.openai.com/v1" })).toBe(false);
    expect(shouldInjectNonOpenAIToolCatalogNudge({ baseUrl: "https://chatgpt.com/backend-api/codex" })).toBe(false);
    expect(shouldInjectNonOpenAIToolCatalogNudge({ baseUrl: "https://api.kimi.com/coding/v1" })).toBe(true);
  });
});
