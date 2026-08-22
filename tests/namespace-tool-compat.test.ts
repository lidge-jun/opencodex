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

  // Relaying `type: "namespace"` is what the strict gateway rejects, and it rejects the request
  // rather than the tool — so a group this layer cannot represent costs every tool in the turn.
  // Dropping what cannot be expressed costs only that.
  test("lowers every namespace group rather than relaying the private shape", () => {
    const body = rewriteRoutedNamespaceToolsForUpstream({
      tools: [
        { type: "namespace", name: "empty", tools: [] },
        {
          type: "namespace",
          name: "partial",
          tools: [
            { type: "namespace", name: "nested", tools: [] },
            { type: "function", name: "", parameters: {} },
            { type: "function", name: "ok", parameters: {} },
          ],
        },
      ],
    }).body as { tools: Array<Record<string, unknown>> };

    expect(body.tools).toEqual([{ type: "function", name: "partial__ok", parameters: {} }]);
    expect(body.tools.some(tool => tool.type === "namespace")).toBe(false);
  });

  // The identity key joins namespace and name with NUL, so a name carrying one could otherwise
  // forge another tool's identity and silently take over its wire name.
  test("drops children whose names cannot become a wire name", () => {
    const NUL = String.fromCharCode(0);
    const body = rewriteRoutedNamespaceToolsForUpstream({
      tools: [
        { type: "namespace", name: "a", tools: [{ type: "function", name: `b${NUL}c` }] },
        { type: "namespace", name: `a${NUL}b`, tools: [{ type: "function", name: "c" }] },
        { type: "namespace", name: "ok", tools: [{ type: "function", name: "run" }] },
      ],
    }).body as { tools: Array<Record<string, unknown>> };

    expect(body.tools).toEqual([{ type: "function", name: "ok__run" }]);
  });

  // `buildTools` flattens the reserved group without a namespace, so the parser treats these as one
  // logical tool and tolerates the duplicate; `promoteClientLoadedTools` produces exactly this shape.
  test("treats a bare declaration and a functions child of the same name as one tool", () => {
    const rewritten = rewriteRoutedNamespaceToolsForUpstream({
      tools: [
        { type: "function", name: "exec", parameters: {} },
        { type: "namespace", name: "functions", tools: [{ type: "function", name: "exec", parameters: {} }] },
      ],
    });
    const body = rewritten.body as { tools: Array<Record<string, unknown>> };

    expect(body.tools).toEqual([{ type: "function", name: "exec", parameters: {} }]);
    expect([...rewritten.aliases]).toEqual([]);
  });

  test("chooses the bare declaration regardless of which tool container comes first", () => {
    const bare = {
      type: "function",
      name: "exec",
      description: "canonical bare declaration",
      parameters: { type: "object", properties: { input: { type: "string" } } },
    };
    const functionsGroup = {
      type: "namespace",
      name: "functions",
      tools: [{
        type: "function",
        name: "exec",
        description: "namespace duplicate",
        parameters: { type: "object", properties: {} },
      }],
    };
    const flatten = (bodyTools: unknown[], additionalTools: unknown[]) => {
      const rewritten = rewriteRoutedNamespaceToolsForUpstream({
        tools: bodyTools,
        input: [{ type: "additional_tools", role: "developer", tools: additionalTools }],
      }).body as {
        tools: Array<Record<string, unknown>>;
        input: Array<{ tools: Array<Record<string, unknown>> }>;
      };
      return [...rewritten.tools, ...rewritten.input[0]!.tools];
    };

    expect(flatten([bare], [functionsGroup])).toEqual([bare]);
    expect(flatten([functionsGroup], [bare])).toEqual([bare]);
  });

  // The routed compaction turn strips the whole tool surface before this runs, and a catalog can
  // change mid-session — but the client is still replaying items this layer's own restoration
  // stamped with a private `namespace`.
  test("lowers replayed calls even when this turn declares no namespace", () => {
    const body = rewriteRoutedNamespaceToolsForUpstream({
      input: [
        { type: "function_call", namespace: "collaboration", name: "spawn_agent", call_id: "c1", arguments: "{}" },
        { type: "custom_tool_call", namespace: "functions", name: "exec", call_id: "c2", input: "run" },
      ],
    }).body as { input: Array<Record<string, unknown>> };

    expect(body.input[0]).toEqual({
      type: "function_call",
      name: "collaboration__spawn_agent",
      call_id: "c1",
      arguments: "{}",
    });
    expect(body.input[1]).toEqual({
      type: "custom_tool_call",
      name: "exec",
      call_id: "c2",
      input: "run",
    });
    expect(JSON.stringify(body)).not.toContain("namespace");
  });

  // A history item records which tool actually ran. Resolving its bare name through a same-named
  // namespace child would rewrite that record on a coincidence rather than translate it.
  test("does not re-point a replayed bare-named call at a namespace child", () => {
    const body = rewriteRoutedNamespaceToolsForUpstream({
      tools: [{ type: "namespace", name: "workspace", tools: [{ type: "function", name: "read" }] }],
      input: [{ type: "function_call", name: "read", call_id: "c1", arguments: "{}" }],
      tool_choice: { type: "function", name: "read" },
    }).body as { input: Array<Record<string, unknown>>; tool_choice: { name: string } };

    expect(body.input[0].name).toBe("read");
    expect(body.tool_choice.name).toBe("workspace__read");
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
