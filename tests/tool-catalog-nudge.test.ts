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
    expect(note).toContain("do not invent, translate, or rename tools");
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

  test("skips OpenAI and ChatGPT hosts", () => {
    expect(shouldInjectNonOpenAIToolCatalogNudge({ baseUrl: "https://api.openai.com/v1" })).toBe(false);
    expect(shouldInjectNonOpenAIToolCatalogNudge({ baseUrl: "https://chatgpt.com/backend-api/codex" })).toBe(false);
    expect(shouldInjectNonOpenAIToolCatalogNudge({ baseUrl: "https://api.kimi.com/coding/v1" })).toBe(true);
  });
});
