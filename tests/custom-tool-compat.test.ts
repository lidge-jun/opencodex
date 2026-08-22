import { describe, expect, test } from "bun:test";
import { rewriteRoutedCustomToolsForUpstream } from "../src/responses/custom-tool-compat";

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
