import { describe, expect, test } from "bun:test";
import { collectResponsesToolGroups } from "../src/responses/tool-groups";

describe("Responses tool-group collection", () => {
  test("collects top-level and Responses Lite tools in wire order", () => {
    const topLevel = [{ type: "web_search" }];
    const firstNested = [{ type: "function", name: "image_gen.imagegen" }];
    const secondNested = [{ type: "function", name: "exec_command" }];
    const groups = collectResponsesToolGroups({
      tools: topLevel,
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "additional_tools", tools: firstNested },
        { type: "additional_tools", tools: "invalid" },
        { type: "additional_tools", tools: secondNested },
      ],
    });

    expect(groups).toHaveLength(3);
    expect(groups[0]).toBe(topLevel);
    expect(groups[1]).toBe(firstNested);
    expect(groups[2]).toBe(secondNested);
  });

  test("ignores malformed request containers", () => {
    expect(collectResponsesToolGroups(undefined)).toEqual([]);
    expect(collectResponsesToolGroups([])).toEqual([]);
    expect(collectResponsesToolGroups({ tools: {}, input: "invalid" })).toEqual([]);
  });
});
