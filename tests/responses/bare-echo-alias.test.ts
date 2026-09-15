import { describe, expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import { buildToolBridgeMaps } from "../../src/server/responses";

function collabRequest(bareName: string) {
  return parseRequest({
    model: "meta/muse-spark-1.3-contributor",
    input: [
      { type: "additional_tools", role: "developer", tools: [
        { type: "namespace", name: "collaboration", tools: [
          { type: "function", name: bareName, description: bareName, strict: false, parameters: { type: "object", properties: {}, required: [] } },
        ] },
      ] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
    ],
  } as any);
}

describe("bare echo alias for namespaced tools (#4679)", () => {
  test("an unambiguous bare name is declared and restores to the namespaced identity", () => {
    const maps = buildToolBridgeMaps(collabRequest("list_agents") as any);
    expect(maps.declaredToolNames.has("list_agents")).toBe(true);
    expect(maps.toolNsMap.get("list_agents")).toEqual({ namespace: "collaboration", name: "list_agents" });
  });

  test("a bare name claimed by two namespaces stays undeclared (no hijack)", () => {
    const parsed = parseRequest({
      model: "meta/muse-spark-1.3-contributor",
      input: [
        { type: "additional_tools", role: "developer", tools: [
          { type: "namespace", name: "collaboration", tools: [
            { type: "function", name: "list_agents", description: "a", strict: false, parameters: { type: "object", properties: {}, required: [] } },
          ] },
          { type: "namespace", name: "other__ns", tools: [
            { type: "function", name: "list_agents", description: "b", strict: false, parameters: { type: "object", properties: {}, required: [] } },
          ] },
        ] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
      ],
    } as any);
    const maps = buildToolBridgeMaps(parsed as any);
    expect(maps.declaredToolNames.has("list_agents")).toBe(false);
    expect(maps.toolNsMap.has("list_agents")).toBe(false);
    // Both canonical spellings remain declared.
    expect(maps.declaredToolNames.has("collaboration__list_agents")).toBe(true);
    expect(maps.declaredToolNames.has("other__ns__list_agents")).toBe(true);
  });

  test("a bare name that equals another tool's canonical spelling stays undeclared", () => {
    const parsed = parseRequest({
      model: "meta/muse-spark-1.3-contributor",
      input: [
        { type: "additional_tools", role: "developer", tools: [
          { type: "namespace", name: "collaboration", tools: [
            { type: "function", name: "list_agents", description: "a", strict: false, parameters: { type: "object", properties: {}, required: [] } },
          ] },
          { type: "namespace", name: "mcp__x", tools: [
            { type: "function", name: "collaboration.list_agents", description: "b", strict: false, parameters: { type: "object", properties: {}, required: [] } },
          ] },
        ] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
      ],
    } as any);
    const maps = buildToolBridgeMaps(parsed as any);
    // Tool B's bare name ("collaboration.list_agents") collides with tool A's dotted
    // spelling and vice versa — the mutual ambiguity poisons BOTH spellings, so no echo
    // can be mis-attributed; only the canonical flats stay declared.
    expect(maps.declaredToolNames.has("collaboration.list_agents")).toBe(false);
    expect(maps.toolNsMap.has("collaboration.list_agents")).toBe(false);
    expect(maps.declaredToolNames.has("collaboration__list_agents")).toBe(true);
    expect(maps.declaredToolNames.has("mcp__x__collaboration.list_agents")).toBe(true);
  });
});
