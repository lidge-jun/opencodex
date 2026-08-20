import { describe, expect, test } from "bun:test";
import {
  createRoutedNamespaceCallRestoreRewrite,
  restoreRoutedNamespaceCalls,
  restoreRoutedNamespaceCallsInJson,
  rewriteRoutedNamespaceToolsForUpstream,
} from "../src/responses/namespace-tool-compat";

describe("Responses namespace tool compatibility", () => {
  test("flattens builtin and routed namespaces across declarations, selectors, and replay", () => {
    const rewritten = rewriteRoutedNamespaceToolsForUpstream({
      model: "routed-model",
      tools: [
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "custom", name: "exec", description: "run" }],
        },
        {
          type: "namespace",
          name: "collaboration",
          tools: [{ type: "function", name: "spawn_agent", parameters: {} }],
        },
      ],
      input: [
        {
          type: "function_call",
          namespace: "collaboration",
          name: "spawn_agent",
          call_id: "call_spawn",
          arguments: "{}",
        },
        {
          type: "custom_tool_call",
          namespace: "functions",
          name: "exec",
          call_id: "call_exec",
          input: "text(true)",
        },
      ],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [
          { type: "function", namespace: "collaboration", name: "spawn_agent" },
          { type: "custom", namespace: "functions", name: "exec" },
        ],
      },
    });
    const body = rewritten.body as {
      tools: Array<{ type: string; name: string }>;
      input: Array<{ namespace?: string; name: string }>;
      tool_choice: { tools: Array<{ namespace?: string; name: string }> };
    };

    expect(body.tools).toEqual([
      { type: "custom", name: "exec", description: "run" },
      { type: "function", name: "collaboration__spawn_agent", parameters: {} },
    ]);
    expect(body.input[0]).toMatchObject({ name: "collaboration__spawn_agent", call_id: "call_spawn" });
    expect(body.input[0]).not.toHaveProperty("namespace");
    expect(body.input[1]).toMatchObject({ name: "exec", call_id: "call_exec" });
    expect(body.input[1]).not.toHaveProperty("namespace");
    expect(body.tool_choice.tools).toEqual([
      { type: "function", name: "collaboration__spawn_agent" },
      { type: "custom", name: "exec" },
    ]);
    expect([...rewritten.aliases]).toEqual([
      ["collaboration__spawn_agent", { namespace: "collaboration", name: "spawn_agent" }],
    ]);
  });

  test("rewrites a unique bare selector but leaves an ambiguous one unchanged", () => {
    const unique = rewriteRoutedNamespaceToolsForUpstream({
      tools: [{
        type: "namespace",
        name: "one",
        tools: [{ type: "function", name: "read" }],
      }],
      tool_choice: { type: "function", name: "read" },
    }).body as { tool_choice: { name: string } };
    expect(unique.tool_choice.name).toBe("one__read");

    const ambiguous = rewriteRoutedNamespaceToolsForUpstream({
      tools: [
        { type: "namespace", name: "one", tools: [{ type: "function", name: "read" }] },
        { type: "namespace", name: "two", tools: [{ type: "function", name: "read" }] },
      ],
      tool_choice: { type: "function", name: "read" },
    }).body as { tool_choice: { name: string } };
    expect(ambiguous.tool_choice.name).toBe("read");

    const directCollision = rewriteRoutedNamespaceToolsForUpstream({
      tools: [
        { type: "function", name: "read" },
        { type: "namespace", name: "workspace", tools: [{ type: "function", name: "read" }] },
      ],
      tool_choice: { type: "function", name: "read" },
    }).body as {
      tools: Array<{ name: string }>;
      tool_choice: { name: string };
    };
    expect(directCollision.tools.map(tool => tool.name)).toEqual(["read", "workspace__read"]);
    expect(directCollision.tool_choice.name).toBe("read");
  });

  test("fails closed when flattening would collide with a declared wire name", () => {
    expect(() => rewriteRoutedNamespaceToolsForUpstream({
      tools: [
        { type: "function", name: "workspace__read" },
        { type: "namespace", name: "workspace", tools: [{ type: "function", name: "read" }] },
      ],
    })).toThrow('namespace tool wire-name collision for "workspace__read"');
  });

  test("preserves empty and malformed namespaces instead of dropping capabilities", () => {
    const body = {
      tools: [
        { type: "namespace", name: "empty", tools: [] },
        { type: "namespace", name: "nested", tools: [{ type: "namespace", name: "child", tools: [] }] },
      ],
    };
    expect(rewriteRoutedNamespaceToolsForUpstream(body).body).toEqual(body);
  });

  test("restores only aliases authorized by this request in JSON and SSE payloads", () => {
    const aliases = new Map([
      ["collaboration__spawn_agent", { namespace: "collaboration", name: "spawn_agent" }],
    ]);
    const payload = {
      type: "response.completed",
      response: {
        output: [
          { type: "function_call", name: "collaboration__spawn_agent", call_id: "call_1" },
          { type: "function_call", name: "untrusted__tool", call_id: "call_2" },
        ],
      },
    };

    expect(restoreRoutedNamespaceCalls(payload, aliases).value).toMatchObject({
      response: {
        output: [
          { type: "function_call", namespace: "collaboration", name: "spawn_agent" },
          { type: "function_call", name: "untrusted__tool" },
        ],
      },
    });
    const text = JSON.stringify(payload);
    expect(JSON.parse(restoreRoutedNamespaceCallsInJson(text, aliases))).toMatchObject({
      response: { output: [
        { namespace: "collaboration", name: "spawn_agent" },
        { name: "untrusted__tool" },
      ] },
    });
    expect(JSON.parse(createRoutedNamespaceCallRestoreRewrite(aliases)(text))).toMatchObject({
      response: { output: [
        { namespace: "collaboration", name: "spawn_agent" },
        { name: "untrusted__tool" },
      ] },
    });
    expect(restoreRoutedNamespaceCallsInJson("not-json", aliases)).toBe("not-json");
  });
});
