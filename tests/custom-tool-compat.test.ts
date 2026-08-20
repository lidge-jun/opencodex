import { describe, expect, test } from "bun:test";
import { restoreRoutedCustomCalls, rewriteRoutedCustomToolsForUpstream } from "../src/responses/custom-tool-compat";

function convertedInputDescription(name: string): string | undefined {
  const result = rewriteRoutedCustomToolsForUpstream({
    tools: [{ type: "custom", name, description: "client tool", format: { type: "text" } }],
  }, "direct-first");
  const body = result.body as {
    tools?: Array<{
      parameters?: { properties?: { input?: { description?: string } } };
    }>;
  };
  const properties = body.tools?.[0]?.parameters?.properties;
  return properties?.[name === "exec" ? "code" : "input"]?.description;
}

describe("routed custom-tool compatibility", () => {
  test("converted exec preserves the JavaScript input contract", () => {
    const description = convertedInputDescription("exec");
    expect(description).toContain("JavaScript");
    expect(description).toContain("tools.exec_command");
    expect(description).toContain("text(...)");
    expect(description).toContain("do not provide a bare shell command");
  });

  test("other converted custom tools keep the generic raw-input contract", () => {
    expect(convertedInputDescription("review_patch")).toContain("Raw input");
    const body = { tools: [{ type: "custom", name: "review_patch", description: "client tool" }] };
    const rewritten = rewriteRoutedCustomToolsForUpstream(body, "direct-first");
    expect(rewritten.names).toEqual(new Set(["review_patch"]));
    expect((rewritten.body as { tools: Array<Record<string, unknown>> }).tools[0]).toMatchObject({
      type: "function",
      name: "review_patch",
      parameters: {
        properties: { input: { type: "string" } },
        required: ["input"],
      },
    });
  });

  test("projects exec and apply_patch onto distinct Responses function fields", () => {
    const result = rewriteRoutedCustomToolsForUpstream({
      tools: [
        { type: "custom", name: "exec", description: "exec", format: { type: "text" } },
        { type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } },
      ],
    }, "direct-first");
    const tools = (result.body as { tools: Array<{ parameters: { properties: Record<string, unknown>; required: string[] } }> }).tools;
    expect(Object.keys(tools[0].parameters.properties)).toEqual(["patch"]);
    expect(tools[0].parameters.required).toEqual(["patch"]);
    expect(Object.keys(tools[1].parameters.properties)).toEqual(["code"]);
    expect(tools[1].parameters.required).toEqual(["code"]);
  });

  test("keeps every direct tool ahead of exec without reordering tool choices", () => {
    const result = rewriteRoutedCustomToolsForUpstream({
      tools: [
        { type: "custom", name: "exec", description: "exec", format: { type: "text" } },
        { type: "function", name: "update_goal", parameters: { type: "object" } },
        { type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } },
        { type: "custom", name: "exec", description: "second exec", format: { type: "text" } },
      ],
      tool_choice: {
        type: "allowed_tools",
        mode: "auto",
        tools: [{ type: "custom", name: "exec" }, { type: "custom", name: "apply_patch" }],
      },
    }, "direct-first").body as {
      tools: Array<{ name: string }>;
      tool_choice: { tools: Array<{ name: string }> };
    };
    expect(result.tools.map(tool => tool.name)).toEqual(["update_goal", "apply_patch", "exec", "exec"]);
    expect(result.tool_choice.tools.map(tool => tool.name)).toEqual(["exec", "apply_patch"]);
  });

  test("restores projected calls and accepts legacy input replay", () => {
    const projected = restoreRoutedCustomCalls({ type: "function_call", name: "exec", id: "fc_1", arguments: '{"code":"1+1"}' }, new Set(["exec"]));
    expect(projected.value).toMatchObject({ type: "custom_tool_call", input: "1+1", id: "ctc_1" });
    const legacy = restoreRoutedCustomCalls({ type: "function_call", name: "apply_patch", id: "fc_2", arguments: '{"input":"*** Begin Patch"}' }, new Set(["apply_patch"]));
    expect(legacy.value).toMatchObject({ type: "custom_tool_call", input: "*** Begin Patch" });
    const generic = restoreRoutedCustomCalls({ type: "function_call", name: "review_patch", id: "fc_3", arguments: '{"input":"review this"}' }, new Set(["review_patch"]));
    expect(generic.value).toMatchObject({ type: "custom_tool_call", input: "review this", id: "ctc_3" });
  });

  test("projects named and allowed custom tool choices while preserving ordinary modes", () => {
    const declaration = { type: "custom", name: "exec", description: "exec", format: { type: "text" } };
    for (const toolChoice of ["auto", "required", "none"] as const) {
      const result = rewriteRoutedCustomToolsForUpstream({ tools: [declaration], tool_choice: toolChoice }, "direct-first");
      expect((result.body as { tool_choice: string }).tool_choice).toBe(toolChoice);
    }

    const named = rewriteRoutedCustomToolsForUpstream({
      tools: [declaration],
      tool_choice: { type: "custom", name: "exec" },
    }, "direct-first").body as { tool_choice: Record<string, unknown> };
    expect(named.tool_choice).toEqual({ type: "function", name: "exec" });

    const allowed = rewriteRoutedCustomToolsForUpstream({
      tools: [declaration],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [
          { type: "custom", name: "exec" },
          { type: "custom", name: "unknown_custom" },
        ],
      },
    }, "direct-first").body as { tool_choice: { tools: Array<Record<string, unknown>> } };
    expect(allowed.tool_choice.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", name: "unknown_custom" },
    ]);
  });
});
