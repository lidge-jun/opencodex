import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import type { OcxTool } from "../src/types";

function inputDescription(tool: OcxTool | undefined): string | undefined {
  const properties = tool?.parameters.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  const input = (properties as Record<string, unknown>).input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const description = (input as Record<string, unknown>).description;
  return typeof description === "string" ? description : undefined;
}

describe("Responses custom-tool guidance", () => {
  test("keeps apply_patch envelope guidance scoped to apply_patch", () => {
    const parsed = parseRequest({
      model: "routed/model",
      input: "Use the available tools.",
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          description: "Apply a patch.",
        },
        {
          type: "custom",
          name: "exec",
          description: "Run JavaScript. declare const tools: { apply_patch(input: string): Promise<unknown>; };",
        },
        {
          type: "custom",
          name: "render_diagram",
          description: "Render a diagram from freeform source.",
        },
      ],
    });

    const tools = new Map((parsed.context.tools ?? []).map(tool => [tool.name, tool]));
    const patch = inputDescription(tools.get("apply_patch"));
    const exec = inputDescription(tools.get("exec"));
    const diagram = inputDescription(tools.get("render_diagram"));

    expect(patch).toContain("*** Begin Patch");
    expect(exec).toBe("Raw freeform input for this tool.");
    expect(diagram).toBe("Raw freeform input for this tool.");
    expect(exec).not.toContain("apply_patch");
    expect(diagram).not.toContain("apply_patch");
  });
});
