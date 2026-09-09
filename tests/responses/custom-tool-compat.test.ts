import { describe, expect, test } from "bun:test";
import { hasUnmappedRoutedCustomToolOutput, rewriteRoutedCustomToolsForUpstream } from "../../src/responses/custom-tool-compat";

function convertedInputDescription(name: string): string | undefined {
  const result = rewriteRoutedCustomToolsForUpstream({
    tools: [{ type: "custom", name, description: "client tool", format: { type: "text" } }],
  });
  const body = result.body as {
    tools?: Array<{
      parameters?: { properties?: { input?: { description?: string } } };
    }>;
  };
  return body.tools?.[0]?.parameters?.properties?.input?.description;
}

describe("routed custom-tool compatibility", () => {
  test("requires replay for ambiguous delta results without guessing their native or lowered type", () => {
    const exec = { type: "custom", name: "exec", description: "Run JavaScript" };
    const patch = { type: "custom", name: "apply_patch", description: "Apply a patch" };
    const result = { type: "custom_tool_call_output", call_id: "call_sample", output: "done" };
    const body = { tools: [exec, patch], input: [result] };
    expect(hasUnmappedRoutedCustomToolOutput(body)).toBe(true);
    expect(body.input).toEqual([result]);
    // A native patch result with its known call remains native, even with exec declared.
    const knownPatch = { ...body, input: [
      { type: "custom_tool_call", name: "apply_patch", call_id: "call_sample", input: "patch" }, result,
    ] };
    expect(hasUnmappedRoutedCustomToolOutput(knownPatch)).toBe(false);
    expect((rewriteRoutedCustomToolsForUpstream(knownPatch).body as typeof knownPatch).input[1]).toEqual(result);
    // A complete lowered call/result pair can use the existing lossless conversion.
    const knownExec = { ...body, input: [
      { type: "custom_tool_call", name: "exec", call_id: "call_sample", input: "text(1)" }, result,
    ] };
    expect(hasUnmappedRoutedCustomToolOutput(knownExec)).toBe(false);
    expect((rewriteRoutedCustomToolsForUpstream(knownExec).body as typeof knownExec).input[1]!.type).toBe("function_call_output");
  });

  test("preserves native-only continuations and follows explicit custom-tool lowering", () => {
    const result = { type: "custom_tool_call_output", call_id: "call_sample", output: "done" };
    const patchOnly = { tools: [{ type: "custom", name: "apply_patch" }], input: [result] };
    expect(hasUnmappedRoutedCustomToolOutput(patchOnly)).toBe(false);
    expect(hasUnmappedRoutedCustomToolOutput(patchOnly, true)).toBe(false);
    expect(hasUnmappedRoutedCustomToolOutput(patchOnly, false)).toBe(true);
    expect(hasUnmappedRoutedCustomToolOutput({ input: [result] })).toBe(false);
    expect(hasUnmappedRoutedCustomToolOutput({
      tools: [{ type: "custom", name: "exec" }],
      input: [{ ...result, type: "function_call_output" }],
    })).toBe(false);
  });

  test("detects lowered results when the current catalog is nested or supplied by additional_tools", () => {
    const result = { type: "custom_tool_call_output", call_id: "call_sample", output: "done" };
    const tool = { type: "custom", name: "exec", description: "Run JavaScript" };
    expect(hasUnmappedRoutedCustomToolOutput({
      tools: [{ type: "namespace", name: "functions", tools: [tool] }], input: [result],
    })).toBe(true);
    expect(hasUnmappedRoutedCustomToolOutput({
      input: [{ type: "additional_tools", tools: [tool] }, result],
    })).toBe(true);
  });

  test.each([
    ["absent", undefined],
    ["true", true],
  ] as const)("keeps apply_patch byte-identical when custom-tool support is %s", (_label, support) => {
    const raw = {
      tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "text" } }],
      input: [
        { type: "custom_tool_call", id: "ctc_patch", call_id: "call_patch", name: "apply_patch", input: "noop" },
        { type: "custom_tool_call_output", call_id: "call_patch", output: "done" },
      ],
    };
    const before = JSON.stringify(raw);

    const rewritten = rewriteRoutedCustomToolsForUpstream(raw, support);

    expect(rewritten.body).toBe(raw);
    expect(JSON.stringify(rewritten.body)).toBe(before);
    expect(rewritten.names).toEqual(new Set());
    expect(rewritten.repairNames).toEqual(new Set(["apply_patch"]));
  });

  test("repairs apply_patch only when bare or in the reserved functions namespace", () => {
    const rewritten = rewriteRoutedCustomToolsForUpstream({
      tools: [
        {
          type: "namespace",
          name: "mcp",
          tools: [{ type: "custom", name: "apply_patch", description: "Remote patch grammar" }],
        },
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "custom", name: "apply_patch", description: "Built-in patch grammar" }],
        },
      ],
    });

    expect(rewritten.repairNames).toEqual(new Set(["apply_patch"]));
  });

  test.each([
    ["none", "none"],
    ["a forced other tool", { type: "function", name: "ordinary" }],
    ["a same-name function selector", { type: "function", name: "apply_patch" }],
    ["an allowlist exclusion", {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "ordinary" }],
    }],
    ["a same-name function allowlist", {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "apply_patch" }],
    }],
  ] as const)("does not arm apply_patch repair under %s", (_label, toolChoice) => {
    const rewritten = rewriteRoutedCustomToolsForUpstream({
      tools: [
        { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "text" } },
        { type: "function", name: "ordinary", parameters: { type: "object" } },
      ],
      tool_choice: toolChoice,
    });

    expect(rewritten.repairNames).toEqual(new Set());
  });

  test.each([
    { type: "custom", name: "apply_patch" },
    {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "custom", name: "apply_patch" }],
    },
  ] as const)("arms apply_patch repair when the selector authorizes it", toolChoice => {
    const rewritten = rewriteRoutedCustomToolsForUpstream({
      tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "text" } }],
      tool_choice: toolChoice,
    });

    expect(rewritten.repairNames).toEqual(new Set(["apply_patch"]));
  });

  test("lowers apply_patch declarations and replay items on an explicit capability denial", () => {
    const raw = {
      tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "text" } }],
      input: [
        { type: "custom_tool_call", id: "ctc_patch", call_id: "call_patch", name: "apply_patch", input: "noop" },
        { type: "custom_tool_call_output", call_id: "call_patch", output: "done" },
      ],
    };

    const rewritten = rewriteRoutedCustomToolsForUpstream(raw, false);
    const body = rewritten.body as typeof raw;

    expect(rewritten.names).toEqual(new Set(["apply_patch"]));
    expect(rewritten.repairNames).toEqual(new Set());
    expect(body.tools[0]).toMatchObject({
      type: "function",
      name: "apply_patch",
      parameters: { required: ["input"] },
    });
    expect(body.input[0]).toMatchObject({
      type: "function_call",
      call_id: "call_patch",
      name: "apply_patch",
      arguments: JSON.stringify({ input: "noop" }),
    });
    expect(body.input[1]).toMatchObject({
      type: "function_call_output",
      call_id: "call_patch",
      output: "done",
    });
  });

  test.each([undefined, true, false])("keeps lowering other custom tools when support is %p", support => {
    const rewritten = rewriteRoutedCustomToolsForUpstream({
      tools: [{ type: "custom", name: "review_patch", description: "Review", format: { type: "text" } }],
    }, support);
    const body = rewritten.body as { tools: Array<Record<string, unknown>> };

    expect(body.tools[0]).toMatchObject({ type: "function", name: "review_patch" });
    expect(rewritten.names).toEqual(new Set(["review_patch"]));
    expect(rewritten.repairNames).toEqual(new Set());
  });

  test("converted exec preserves the JavaScript input contract", () => {
    const description = convertedInputDescription("exec");
    expect(description).toContain("JavaScript");
    expect(description).toContain("tools.exec_command");
    expect(description).toContain("text(...)");
    expect(description).toContain("do not provide a bare shell command");
  });

  test("other converted custom tools keep the generic raw-input contract", () => {
    expect(convertedInputDescription("review_patch"))
      .toBe("Raw input for this client-executed custom tool.");
  });
});
