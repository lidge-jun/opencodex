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
