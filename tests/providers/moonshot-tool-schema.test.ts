import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxTool } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createOpenAIChatAdapter = (
  ...args: Parameters<typeof createOpenAIChatAdapterProduction>
) => withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

function parsedRequest(tool: OcxTool): OcxParsedRequest {
  return {
    modelId: "k3",
    context: {
      messages: [{ role: "user", content: "run the tool", timestamp: 0 }],
      tools: [tool],
    },
    stream: true,
    options: {},
  };
}

function adapterFor(baseUrl: string) {
  return createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl, apiKey: "k" });
}

async function emittedParameters(
  baseUrl: string,
  tool: OcxTool,
): Promise<Record<string, unknown> | undefined> {
  const request = await adapterFor(baseUrl).buildRequest(parsedRequest(tool));
  const body = JSON.parse(request.body) as {
    tools?: { function: { parameters?: Record<string, unknown> } }[];
  };
  return body.tools?.[0]?.function.parameters;
}

/** Every node that carries $ref alongside any other key — what Moonshot rejects. */
function siblingRefPaths(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => siblingRefPaths(item, `${path}[${index}]`));
  }
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const keys = Object.keys(record);
  const found = keys.includes("$ref") && keys.length > 1 ? [path] : [];
  return [
    ...found,
    ...keys.flatMap(key => siblingRefPaths(record[key], `${path}.${key}`)),
  ];
}

/**
 * Reproduces issue #2673: Codex's deferred automation_update catalog deduplicates into
 * $defs.__schema* nodes that keep type/minLength/format beside a $ref. Moonshot reads $ref
 * as draft-07 (must stand alone) and 400s the whole request.
 */
const CODEX_STYLE_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    threadId: { $ref: "#/$defs/__schema20" },
    name: { $ref: "#/$defs/__schema5" },
    mode: { $ref: "#/$defs/__schema2" },
  },
  required: ["threadId"],
  additionalProperties: false,
  $defs: {
    __schema2: { type: "string", minLength: 1 },
    __schema5: { description: "Short automation name.", $ref: "#/$defs/__schema2" },
    __schema20: {
      type: "string",
      minLength: 1,
      format: "uuid",
      description: "Target thread UUID for heartbeat automations.",
      $ref: "#/$defs/__schema2",
    },
  },
};

const MOONSHOT_HOSTS = [
  "https://api.kimi.com/coding/v1",
  "https://api.moonshot.ai/v1",
  "https://api.moonshot.cn/v1",
];

describe("Moonshot tool schema normalization (issue #2673)", () => {
  for (const baseUrl of MOONSHOT_HOSTS) {
    test(`emits no $ref with sibling keywords for ${baseUrl}`, async () => {
      const parameters = await emittedParameters(baseUrl, {
        name: "automation_update",
        description: "Manage automations.",
        parameters: structuredClone(CODEX_STYLE_SCHEMA),
      });

      expect(parameters).toBeDefined();
      expect(siblingRefPaths(parameters)).toEqual([]);
    });
  }

  test("inlines the referenced schema under the node's own keywords", async () => {
    const parameters = await emittedParameters("https://api.kimi.com/coding/v1", {
      name: "automation_update",
      description: "Manage automations.",
      parameters: structuredClone(CODEX_STYLE_SCHEMA),
    });

    // The offending nodes are the definitions themselves, not the bare refs pointing at them,
    // so the repair lands inside the $defs bag.
    const defs = parameters?.$defs as Record<string, Record<string, unknown>>;
    // __schema20 narrowed the referenced string with format/minLength; 2020-12 says both apply,
    // so the constraints must survive rather than being stripped to satisfy the validator.
    expect(defs.__schema20).toEqual({
      type: "string",
      minLength: 1,
      format: "uuid",
      description: "Target thread UUID for heartbeat automations.",
    });
    // description-only siblings were already tolerated, but must still resolve to a real schema.
    expect(defs.__schema5).toEqual({
      type: "string",
      minLength: 1,
      description: "Short automation name.",
    });
  });

  test("leaves a bare $ref pointing at its definition", async () => {
    const parameters = await emittedParameters("https://api.kimi.com/coding/v1", {
      name: "automation_update",
      description: "Manage automations.",
      parameters: structuredClone(CODEX_STYLE_SCHEMA),
    });

    const properties = parameters?.properties as Record<string, Record<string, unknown>>;
    expect(properties.mode).toEqual({ $ref: "#/$defs/__schema2" });
    expect(parameters?.$defs).toBeDefined();
  });

  test("keeps a recursive $ref finite by dropping only the siblings on the cycle", async () => {
    const parameters = await emittedParameters("https://api.kimi.com/coding/v1", {
      name: "tree_tool",
      parameters: {
        type: "object",
        properties: { tree: { $ref: "#/$defs/Tree" } },
        $defs: {
          Tree: {
            type: "object",
            description: "Recursive node.",
            properties: { child: { description: "Nested.", $ref: "#/$defs/Tree" } },
          },
        },
      },
    });

    expect(siblingRefPaths(parameters)).toEqual([]);
    const tree = (parameters?.properties as Record<string, Record<string, unknown>>).tree;
    expect(tree).toEqual({ $ref: "#/$defs/Tree" });
    const defs = parameters?.$defs as Record<string, Record<string, unknown>>;
    const child = (defs.Tree.properties as Record<string, unknown>).child;
    // One expansion happens, then the cycle guard collapses the inner self-reference to a bare
    // ref. That is what keeps the walk finite instead of expanding Tree forever.
    expect(child).toEqual({
      type: "object",
      description: "Nested.",
      properties: { child: { $ref: "#/$defs/Tree" } },
    });
  });

  test("keeps an unresolvable $ref rather than silently discarding what it constrained", async () => {
    const parameters = await emittedParameters("https://api.kimi.com/coding/v1", {
      name: "remote_ref_tool",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string", $ref: "https://example.com/schema.json#/Thing" },
        },
      },
    });

    expect(siblingRefPaths(parameters)).toEqual([]);
    const properties = parameters?.properties as Record<string, Record<string, unknown>>;
    // Both outcomes are lossy. Dropping the ref keeps the node's own keywords but throws away
    // whatever the reference constrained, and nothing downstream can tell that happened. The
    // bare ref loses the siblings instead, which preserves the identity of what was asked for
    // and is still a shape Moonshot accepts.
    expect(properties.value).toEqual({ $ref: "https://example.com/schema.json#/Thing" });
  });


  test("composes duplicate required, properties, and same-key assertions", async () => {
    // The reviewer's first blocker. `$ref` under 2020-12 is an in-place applicator: the
    // node and its target BOTH apply. Overwriting made a tool that required `a` and `b`
    // ship requiring only `b`, and dropped `a` from properties entirely - a weaker contract
    // than either side asked for, emitted silently.
    const parameters = await emittedParameters("https://api.moonshot.ai/v1", {
      name: "conjunction_tool",
      parameters: {
        type: "object",
        $defs: {
          Base: {
            type: "object",
            required: ["a"],
            properties: { a: { type: "string", minLength: 2 } },
            enum: ["x", "y"],
          },
        },
        properties: {
          value: {
            $ref: "#/$defs/Base",
            required: ["b"],
            properties: { b: { type: "number" } },
            minLength: 5,
          },
        },
      },
    });

    expect(siblingRefPaths(parameters)).toEqual([]);
    const properties = parameters?.properties as Record<string, Record<string, unknown>>;
    const value = properties.value!;
    // Set-valued assertions compose: neither side loses a member.
    expect(value.required).toEqual(["a", "b"]);
    expect(Object.keys(value.properties as Record<string, unknown>).sort()).toEqual(["a", "b"]);
    // Scalar assertions keep the narrowing overwrite - the node means the tighter bound.
    expect(value.minLength).toBe(5);
    // A keyword only the target carries survives.
    expect(value.enum).toEqual(["x", "y"]);
  });

  // BUG-R6: "the node narrows the target" was asserted, never enforced.
  //
  // The test above uses a node whose minLength is TIGHTER than the target's, so a plain
  // overwrite and a real narrowing are indistinguishable there. When the node is LOOSER,
  // the two diverge and the overwrite ships the weaker contract - the opposite of what
  // the comment claims and of what `$ref` means under 2020-12, where the node and its
  // target both apply.
  test("a looser sibling assertion does not relax the target", async () => {
    const parameters = await emittedParameters("https://api.moonshot.ai/v1", {
      name: "loosening_tool",
      parameters: {
        type: "object",
        $defs: {
          Tight: {
            type: "string",
            minLength: 5,
            maxLength: 10,
            minimum: 10,
            maximum: 100,
          },
        },
        properties: {
          value: {
            $ref: "#/$defs/Tight",
            // Every one of these is weaker than the target's.
            minLength: 1,
            maxLength: 99,
            minimum: 0,
            maximum: 1_000,
          },
        },
      },
    });

    const value = (parameters?.properties as Record<string, Record<string, unknown>>).value!;
    // The intersection, per keyword direction: lower bounds take the max, upper bounds
    // take the min. Both sides apply, so the surviving constraint is the stricter one.
    expect(value.minLength).toBe(5);
    expect(value.minimum).toBe(10);
    expect(value.maxLength).toBe(10);
    expect(value.maximum).toBe(100);
  });

  test("a tighter sibling assertion still wins", async () => {
    // The other direction, so the fix cannot be "always prefer the target" - that would
    // discard a genuine narrowing, which is the mirror-image bug.
    const parameters = await emittedParameters("https://api.moonshot.ai/v1", {
      name: "tightening_tool",
      parameters: {
        type: "object",
        $defs: { Loose: { type: "string", minLength: 1, maxLength: 100 } },
        properties: { value: { $ref: "#/$defs/Loose", minLength: 5, maxLength: 10 } },
      },
    });

    const value = (parameters?.properties as Record<string, Record<string, unknown>>).value!;
    expect(value.minLength).toBe(5);
    expect(value.maxLength).toBe(10);
  });

  test("a deeply nested ref-free schema is bounded instead of exhausting the stack", async () => {
    // The second blocker: the expansion budget counts $ref inlines only, so a schema with
    // no refs at all walked unbounded. This nests far past any real tool.
    // 20k deep. A bounded walk returns; an unbounded one blows the JS stack, which is
    // exactly the provider-facing failure the budget exists to prevent.
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 20_000; i += 1) {
      deep = { type: "object", properties: { next: deep } };
    }
    const parameters = await emittedParameters("https://api.moonshot.ai/v1", {
      name: "deep_tool",
      parameters: { type: "object", properties: { root: deep } },
    });

    // It returns rather than throwing, and what it returns is still valid.
    expect(parameters?.type).toBe("object");
    expect(siblingRefPaths(parameters)).toEqual([]);
  });


  test("composes a property that both the target and the node define", async () => {
    // The same conjunction problem `required` had, one level down. Letting the sibling
    // win discarded the target's constraints for that member, so a property the tool
    // declared with minLength shipped without it.
    const parameters = await emittedParameters("https://api.moonshot.ai/v1", {
      name: "shared_property_tool",
      parameters: {
        type: "object",
        $defs: { Base: { type: "object", properties: { shared: { type: "string", minLength: 3 } } } },
        properties: { v: { $ref: "#/$defs/Base", properties: { shared: { type: "string" } } } },
      },
    });

    const v = (parameters?.properties as Record<string, Record<string, unknown>>).v!;
    const shared = (v.properties as Record<string, Record<string, unknown>>).shared!;
    expect(shared.minLength).toBe(3);
    expect(shared.type).toBe("string");
  });

  test("intersects bounds when both sides define the same property", async () => {
    const parameters = await emittedParameters("https://api.moonshot.ai/v1", {
      name: "shared_property_bounds_tool",
      parameters: {
        type: "object",
        $defs: {
          Base: {
            type: "object",
            properties: {
              looserSibling: { type: "string", minLength: 5, maxLength: 10 },
              tighterSibling: { type: "string", minLength: 1, maxLength: 100 },
            },
          },
        },
        properties: {
          value: {
            $ref: "#/$defs/Base",
            properties: {
              looserSibling: { type: "string", minLength: 1, maxLength: 99 },
              tighterSibling: { type: "string", minLength: 5, maxLength: 10 },
            },
          },
        },
      },
    });

    const value = (parameters?.properties as Record<string, Record<string, unknown>>).value!;
    const properties = value.properties as Record<string, Record<string, unknown>>;
    expect(properties.looserSibling).toMatchObject({ minLength: 5, maxLength: 10 });
    expect(properties.tighterSibling).toMatchObject({ minLength: 5, maxLength: 10 });
  });

  test("intersects bounds recursively inside shared object properties", async () => {
    const parameters = await emittedParameters("https://api.moonshot.ai/v1", {
      name: "nested_shared_property_bounds_tool",
      parameters: {
        type: "object",
        $defs: {
          Base: {
            type: "object",
            properties: {
              shared: {
                type: "object",
                properties: { leaf: { type: "string", minLength: 5, maxLength: 10 } },
              },
            },
          },
        },
        properties: {
          value: {
            $ref: "#/$defs/Base",
            properties: {
              shared: {
                type: "object",
                properties: { leaf: { type: "string", minLength: 1, maxLength: 99 } },
              },
            },
          },
        },
      },
    });

    const value = (parameters?.properties as Record<string, Record<string, unknown>>).value!;
    const shared = (value.properties as Record<string, Record<string, unknown>>).shared!;
    const leaf = (shared.properties as Record<string, Record<string, unknown>>).leaf!;
    expect(leaf).toMatchObject({ minLength: 5, maxLength: 10 });
  });

  test("leaves data-valued keywords alone, even when they look like schemas", async () => {
    // `enum` lists VALUES. Recursing into it treated a literal object carrying a "$ref"
    // string as a reference node and stripped the key, silently changing a value the tool
    // declared as legal.
    const parameters = await emittedParameters("https://api.moonshot.ai/v1", {
      name: "enum_data_tool",
      parameters: {
        type: "object",
        properties: { mode: { type: "object", enum: [{ $ref: "not-a-pointer", keep: 1 }] } },
      },
    });

    const mode = (parameters?.properties as Record<string, Record<string, unknown>>).mode!;
    expect(mode.enum).toEqual([{ $ref: "not-a-pointer", keep: 1 }]);
  });

  test("still stamps the root object type Moonshot requires (issue #228)", async () => {
    const parameters = await emittedParameters("https://api.moonshot.ai/v1", {
      name: "root_union_tool",
      parameters: {
        oneOf: [{ type: "object", properties: { mode: { type: "string" } } }],
      },
    });

    expect(parameters?.type).toBe("object");
    expect(parameters?.oneOf).toBeDefined();
  });

  test("preserves property names that overlap JavaScript prototype keys", async () => {
    const properties = JSON.parse('{"__proto__":{"type":"string","$ref":"#/$defs/S"}}');
    const parameters = await emittedParameters("https://api.kimi.com/coding/v1", {
      name: "proto_tool",
      parameters: { type: "object", properties, $defs: { S: { minLength: 2 } } },
    });

    const emitted = parameters?.properties as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(emitted, "__proto__")).toBe(true);
    expect(siblingRefPaths(parameters)).toEqual([]);
  });

  test("leaves non-Moonshot openai-chat providers untouched", async () => {
    const tool: OcxTool = {
      name: "automation_update",
      description: "Manage automations.",
      parameters: structuredClone(CODEX_STYLE_SCHEMA),
    };

    const parameters = await emittedParameters("https://api.deepseek.com/v1", tool);

    // The sibling-$ref nodes are Moonshot's problem alone; every other provider keeps the
    // schema Codex sent, including the $defs bag verbatim.
    expect(parameters?.$defs).toEqual(CODEX_STYLE_SCHEMA.$defs as Record<string, unknown>);
    expect(siblingRefPaths(parameters).length).toBeGreaterThan(0);
  });
});
