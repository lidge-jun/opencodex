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
      ["collaboration__spawn_agent", { namespace: "collaboration", name: "spawn_agent", kind: "function" }],
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

  test("only arms response aliases authorized by tool_choice", () => {
    const tools = [{
      type: "namespace",
      name: "collaboration",
      tools: [
        { type: "function", name: "safe" },
        { type: "function", name: "excluded" },
      ],
    }];

    const allowed = rewriteRoutedNamespaceToolsForUpstream({
      tools,
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", namespace: "collaboration", name: "safe" }],
      },
    });
    expect([...allowed.aliases]).toEqual([
      ["collaboration__safe", { namespace: "collaboration", name: "safe", kind: "function" }],
    ]);
    expect(restoreRoutedNamespaceCalls({
      type: "function_call",
      name: "collaboration__excluded",
    }, allowed.aliases).changed).toBe(false);

    expect(rewriteRoutedNamespaceToolsForUpstream({
      tools,
      tool_choice: { type: "function", namespace: "collaboration", name: "safe" },
    }).aliases.has("collaboration__excluded")).toBe(false);
    expect(rewriteRoutedNamespaceToolsForUpstream({ tools, tool_choice: "none" }).aliases.size).toBe(0);
  });

  // The authorization boundary is per-request, and `allowed_tools` is where it was
  // leaking: entries are typed `{type: string}` by the schema, so the accepted set is
  // open-ended, and matching on `name` alone let a selector for a DIFFERENT KIND of
  // tool authorize a client namespace function call.
  //
  // This is not a naming nit. The upstream sees every flattened declaration even when
  // `tool_choice` narrows what may be called, so a non-canonical upstream can answer
  // with `{type: "function_call", name: "<wire-name>"}`; if the alias survived, the
  // restore path rewrites it into `{namespace, name}` and the client executes a tool
  // the caller never permitted. The undeclared-tool guard does not catch it either —
  // that guard authorizes from the declared catalog, not from `tool_choice`.
  describe("allowed_tools authorization is restricted by tool type", () => {
    const namespaceTools = [{
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "safe" }],
    }];
    const wireName = "collaboration__safe";

    // Every non-function/custom kind the runtime and schema know about, plus an
    // unknown future one. The whitelist has to close all of them, including kinds
    // nobody has written yet — which is exactly why it is a whitelist.
    test.each([
      "file_search",
      "web_search",
      "web_search_preview",
      "computer_use",
      "computer_use_preview",
      "code_interpreter",
      "image_generation",
      "image_gen",
      "mcp",
      "tool_search",
      "local_shell",
      "x_search",
      "namespace",
      "some_future_tool_kind",
    ])("a %s entry naming the wire tool authorizes nothing", kind => {
      const { aliases } = rewriteRoutedNamespaceToolsForUpstream({
        tools: namespaceTools,
        tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: kind, name: wireName }] },
      });
      expect(aliases.size).toBe(0);
      // The map is the whole authorization surface, so an upstream call carrying that
      // wire name must stay unrestored rather than becoming a namespaced client call.
      const restored = restoreRoutedNamespaceCalls({ type: "function_call", name: wireName }, aliases);
      expect(restored.changed).toBe(false);
      expect((restored.value as { namespace?: unknown }).namespace).toBeUndefined();
    });

    test.each(["function", "custom"])("a %s entry authorizes a tool declared that same kind", kind => {
      const { aliases } = rewriteRoutedNamespaceToolsForUpstream({
        tools: [{ type: "namespace", name: "collaboration", tools: [{ type: kind, name: "safe" }] }],
        tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: kind, name: wireName }] },
      });
      // Proving the whitelist is not deny-all: without this, a filter that rejected
      // everything would pass every test above.
      expect(aliases.get(wireName)).toEqual({ namespace: "collaboration", name: "safe", kind });
      expect(restoreRoutedNamespaceCalls({ type: "function_call", name: wireName }, aliases).changed).toBe(true);
    });

    // A wire name says WHICH tool, not what kind of call may carry it. Selecting a
    // tool as the wrong kind is the same name/kind mismatch as selecting it with a
    // foreign selector — narrower, but the same class, and reachable because
    // `allowed_tools[].type` accepts any string.
    test.each([
      ["function", "custom"],
      ["custom", "function"],
    ])("a tool declared %s is not authorized by a %s selector", (declared, selected) => {
      const build = (choice: unknown) => rewriteRoutedNamespaceToolsForUpstream({
        tools: [{ type: "namespace", name: "collaboration", tools: [{ type: declared, name: "safe" }] }],
        tool_choice: choice,
      }).aliases;

      const viaAllowed = build({ type: "allowed_tools", mode: "required", tools: [{ type: selected, name: wireName }] });
      expect(viaAllowed.size).toBe(0);
      expect(restoreRoutedNamespaceCalls({ type: "function_call", name: wireName }, viaAllowed).changed).toBe(false);

      // The forced-selector branch has to agree, or the narrowing only holds for
      // one of the two shapes a caller can write.
      const viaForced = build({ type: selected, name: wireName });
      expect(viaForced.size).toBe(0);
    });

    test("a foreign entry cannot ride alongside an authorized one", () => {
      const { aliases } = rewriteRoutedNamespaceToolsForUpstream({
        tools: [{
          type: "namespace",
          name: "collaboration",
          tools: [{ type: "function", name: "safe" }, { type: "function", name: "excluded" }],
        }],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [
            { type: "function", name: wireName },
            { type: "file_search", name: "collaboration__excluded" },
          ],
        },
      });
      expect([...aliases.keys()]).toEqual([wireName]);
    });
  });

  test("default and absent tool_choice keep every alias", () => {
    const tools = [{
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "safe" }, { type: "function", name: "other" }],
    }];
    // Narrowing only applies when the caller actually narrowed. These three are the
    // "no restriction stated" cases and must not be collapsed by the filter.
    for (const choice of [undefined, "auto", "required"]) {
      const { aliases } = rewriteRoutedNamespaceToolsForUpstream(
        choice === undefined ? { tools } : { tools, tool_choice: choice },
      );
      expect(aliases.size).toBe(2);
    }
    // A top-level selector for another tool kind states a restriction that no
    // namespace call satisfies, so it authorizes nothing.
    expect(rewriteRoutedNamespaceToolsForUpstream({
      tools,
      tool_choice: { type: "file_search" },
    }).aliases.size).toBe(0);
  });

  // A selector's `namespace` is either absent — meaning "unqualified, resolve the bare
  // name" — or a string naming the group. A present-but-malformed value is neither, and
  // treating it as absent let it resolve to a namespace wire name and authorize an alias
  // the caller never qualified. Fail closed instead: an unqualified selector is a
  // deliberate shape, a malformed one is not.
  describe("a malformed namespace field authorizes nothing", () => {
    const namespaceTools = [{
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "safe" }],
    }];
    const wireName = "collaboration__safe";

    test.each([
      ["a number", 1],
      ["null", null],
      ["an object", {}],
      ["an array", ["collaboration"]],
      ["a boolean", true],
    ])("a forced selector whose namespace is %s", (_label, namespace) => {
      const { aliases } = rewriteRoutedNamespaceToolsForUpstream({
        tools: namespaceTools,
        tool_choice: { type: "function", namespace, name: "safe" },
      });
      expect(aliases.size).toBe(0);
      expect(restoreRoutedNamespaceCalls({ type: "function_call", name: wireName }, aliases).changed).toBe(false);
    });

    test("an allowed_tools entry whose namespace is malformed", () => {
      const { aliases } = rewriteRoutedNamespaceToolsForUpstream({
        tools: namespaceTools,
        tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", namespace: 1, name: "safe" }] },
      });
      expect(aliases.size).toBe(0);
    });

    // Refusing to REWRITE a malformed selector is not enough on its own. If its name is
    // already the flattened wire name, it matches the alias map exactly and arms it
    // anyway — so authorization has to reject the selector itself, whatever name it
    // carries. Both selector shapes, because a caller can write either.
    test("a malformed selector already using the flattened wire name authorizes nothing", () => {
      const forced = rewriteRoutedNamespaceToolsForUpstream({
        tools: namespaceTools,
        tool_choice: { type: "function", namespace: 1, name: wireName },
      });
      expect(forced.aliases.size).toBe(0);
      expect(restoreRoutedNamespaceCalls({ type: "function_call", name: wireName }, forced.aliases).changed).toBe(false);

      const allowed = rewriteRoutedNamespaceToolsForUpstream({
        tools: namespaceTools,
        tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", namespace: 1, name: wireName }] },
      });
      expect(allowed.aliases.size).toBe(0);
    });

    test("an unqualified selector using the wire name still authorizes", () => {
      // The legitimate shape this must not break: no namespace field at all, naming
      // the flattened tool directly.
      const { aliases } = rewriteRoutedNamespaceToolsForUpstream({
        tools: namespaceTools,
        tool_choice: { type: "function", name: wireName },
      });
      expect(aliases.get(wireName)).toBeDefined();
    });

    test("a correctly qualified selector still authorizes, so this is not deny-all", () => {
      const { aliases } = rewriteRoutedNamespaceToolsForUpstream({
        tools: namespaceTools,
        tool_choice: { type: "function", namespace: "collaboration", name: "safe" },
      });
      expect(aliases.get(wireName)).toEqual({ namespace: "collaboration", name: "safe", kind: "function" });
    });

    test("an unqualified selector keeps resolving by bare name", () => {
      // The absent case is the one legitimate reason the fallback exists; narrowing
      // malformed values must not take it away.
      const { aliases } = rewriteRoutedNamespaceToolsForUpstream({
        tools: namespaceTools,
        tool_choice: { type: "function", name: "safe" },
      });
      expect(aliases.get(wireName)).toBeDefined();
    });
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

  // A catalog can be absent or change mid-session, but the client can still replay items this
  // layer's own restoration stamped with a private `namespace`.
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
      ["collaboration__spawn_agent", { namespace: "collaboration", name: "spawn_agent", kind: "function" }],
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
