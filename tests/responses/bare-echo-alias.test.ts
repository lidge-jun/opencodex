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

  test("Code Mode helper names never gain a bare alias", () => {
    const maps = buildToolBridgeMaps(collabRequest("exec") as any); // justified: parsed fixture matches the request wire shape
    expect(maps.declaredToolNames.has("collaboration__exec")).toBe(true);
    expect(maps.declaredToolNames.has("exec")).toBe(false);
    expect(maps.toolNsMap.has("exec")).toBe(false);
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

  test("a bare name that equals another tool's dotted spelling stays undeclared", () => {
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
    // spelling, so that bare alias is poisoned; tool A's dotted spelling is poisoned in
    // return by the pre-existing dotted rule. Tool B's own distinct dotted alias does not
    // collide with anything and stays declared, as do both canonical spellings.
    expect(maps.declaredToolNames.has("collaboration.list_agents")).toBe(false);
    expect(maps.toolNsMap.has("collaboration.list_agents")).toBe(false);
    expect(maps.declaredToolNames.has("mcp__x.collaboration.list_agents")).toBe(true);
    expect(maps.toolNsMap.get("mcp__x.collaboration.list_agents")).toEqual({ namespace: "mcp__x", name: "collaboration.list_agents" });
    expect(maps.declaredToolNames.has("collaboration__list_agents")).toBe(true);
    expect(maps.declaredToolNames.has("mcp__x__collaboration.list_agents")).toBe(true);
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
            { type: "function", name: "collaboration__list_agents", description: "b", strict: false, parameters: { type: "object", properties: {}, required: [] } },
          ] },
        ] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
      ],
    } as any);
    const maps = buildToolBridgeMaps(parsed as any);
    // Tool B's bare name ("collaboration__list_agents") is also tool A's declared canonical
    // spelling, so the bare alias is poisoned. The canonical spelling stays declared — but as
    // tool A's wire name, never as an alias of tool B — so assert the identity via toolNsMap.
    // Tool B's canonical and dotted spellings remain declared.
    expect(maps.toolNsMap.get("collaboration__list_agents")).toEqual({ namespace: "collaboration", name: "list_agents" });
    expect(maps.declaredToolNames.has("mcp__x__collaboration__list_agents")).toBe(true);
    expect(maps.declaredToolNames.has("mcp__x.collaboration__list_agents")).toBe(true);
    expect(maps.toolNsMap.get("mcp__x.collaboration__list_agents")).toEqual({ namespace: "mcp__x", name: "collaboration__list_agents" });
  });

  test("a bare-declared function owns its name and blocks the namespaced tool's bare alias", () => {
    const parsed = parseRequest({
      model: "meta/muse-spark-1.3-contributor",
      input: [
        { type: "additional_tools", role: "developer", tools: [
          { type: "namespace", name: "collaboration", tools: [
            { type: "function", name: "list_agents", description: "a", strict: false, parameters: { type: "object", properties: {}, required: [] } },
          ] },
          { type: "function", name: "list_agents", description: "b", strict: false, parameters: { type: "object", properties: {}, required: [] } },
        ] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
      ],
    } as any);
    const maps = buildToolBridgeMaps(parsed as any);
    // The bare-declared (no-namespace) function participates as an owner of "list_agents",
    // mirroring the tool_choice bare path's whole-catalog counting, so the namespaced tool
    // must not gain it as an echo alias. "list_agents" stays in declaredToolNames because the
    // bare function's own wire name IS that spelling; the alias check is toolNsMap, which
    // must never map the bare name to the namespaced identity.
    expect(maps.toolNsMap.has("list_agents")).toBe(false);
    expect(maps.declaredToolNames.has("collaboration__list_agents")).toBe(true);
  });
});
