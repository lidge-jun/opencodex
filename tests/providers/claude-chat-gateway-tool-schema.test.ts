import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const unionRoot = {
  oneOf: [
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  ],
};

const gateway: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://gateway.example.test/v1",
  apiKey: "test-key",
  authMode: "key",
};

function toolFor(modelId: string, provider: OcxProviderConfig = gateway, wireModelOverride?: string, parameters: Record<string, unknown> = unionRoot) {
  const parsed: OcxParsedRequest = {
    modelId,
    ...(wireModelOverride ? { _wireModelOverride: wireModelOverride } : {}),
    context: {
      messages: [{ role: "user", content: "Use the tool", timestamp: 0 }],
      tools: [{ name: "automation_update", namespace: "mcp__codex_app", description: "Update an automation", parameters, strict: true }],
    },
    stream: false,
    options: {},
  };
  const body = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body) as {
    tools: Array<{ function: Record<string, unknown> }>;
  };
  return body.tools[0].function;
}

describe("Claude behind a Chat Completions gateway: tool schema root", () => {
  test.each(["oneOf", "anyOf"])("flattens a %s root without promoting branch required fields", composition => {
    const fn = toolFor("claude-sonnet-5-5", gateway, undefined, { [composition]: unionRoot.oneOf });
    const parameters = fn.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.required).toBeUndefined();
    expect(parameters.properties).toMatchObject({ id: { type: "string" }, name: { type: "string" } });
    for (const key of ["oneOf", "anyOf", "allOf"]) expect(parameters[key]).toBeUndefined();
  });

  test("allOf merges root and branch required fields and preserves root metadata", () => {
    const schema = {
      title: "Lookup", additionalProperties: false,
      properties: { existing: { type: "boolean" } }, required: ["existing"],
      allOf: unionRoot.oneOf,
    };
    expect(toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters).toEqual({
      title: "Lookup", additionalProperties: false, type: "object",
      properties: { existing: { type: "boolean" }, id: { type: "string" }, name: { type: "string" } },
      required: ["existing", "id", "name"],
    });
  });

  test.each([false, true])("preserves nested schemas, literals and caller input (root union: %s)", rootUnion => {
    const properties = {
      value: { type: ["string", "number"] },
      nullable: { type: ["string", "null"] },
      nested: { anyOf: [{ type: "string" }, { type: "number" }] },
      payload: {
        type: "object",
        default: { encrypted: true, type: ["string", "number"], required: [] },
        examples: [{ encrypted: true, type: ["string", "null"] }],
      },
    };
    const schema = rootUnion
      ? { anyOf: [{ type: "object", properties }] }
      : { type: "object", properties };
    const before = structuredClone(schema);
    const fn = toolFor("claude-sonnet-5-5", gateway, undefined, schema);
    expect(fn.parameters).toEqual({ type: "object", properties });
    expect(fn.strict).toBe(true);
    expect(schema).toEqual(before);
  });

  test("preserves an own __proto__ property when merging root composition", () => {
    const properties = JSON.parse('{"__proto__":{"type":"string"},"ordinary":{"type":"number"}}');
    for (const schema of [{ properties, anyOf: [{}] }, { anyOf: [{ properties }] }]) {
      const parameters = toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters as Record<string, unknown>;
      expect(Object.hasOwn(parameters.properties as object, "__proto__")).toBe(true);
      expect(parameters.properties).toEqual(properties);
    }
  });

  test.each(["oneOf", "anyOf", "allOf"])("resolves local references in root %s branches only", composition => {
    const nested = { anyOf: [{ $ref: "#/$defs/Value" }, { type: "null" }] };
    const schema = {
      $defs: {
        "Foo/Bar~": { properties: { value: nested }, required: ["value"] },
        Alias: { $ref: "#/$defs/Foo~1Bar~0" },
        Value: { type: "string" },
      },
      [composition]: [{ $ref: "#/$defs/Alias" }],
    };
    const before = structuredClone(schema);
    const parameters = toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters as Record<string, unknown>;
    expect(parameters.properties).toEqual({ value: nested });
    expect(parameters.required).toEqual(composition === "allOf" ? ["value"] : undefined);
    expect(parameters.$defs).toEqual(schema.$defs);
    expect(parameters[composition]).toBeUndefined();
    expect(schema).toEqual(before);
  });

  test("allOf uses branch-over-root and later-branch property precedence", () => {
    const schema = {
      properties: { value: { type: "boolean" } }, required: ["root"],
      $defs: { Base: { properties: { value: { type: "number" } }, required: ["base"] } },
      allOf: [
        { $ref: "#/$defs/Base", properties: { value: { type: "integer" } }, required: ["sibling"] },
        { properties: { value: { type: "string" } }, required: ["last", "root"] },
      ],
    };
    const parameters = toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters as Record<string, unknown>;
    expect(parameters.properties).toEqual({ value: { type: "string" } });
    expect(parameters.required).toEqual(["root", "base", "sibling", "last"]);
    const firstBranch = toolFor("claude-sonnet-5-5", gateway, undefined, { ...schema, allOf: schema.allOf.slice(0, 1) }).parameters as Record<string, unknown>;
    expect(firstBranch.properties).toEqual({ value: { type: "integer" } });
  });

  test("preserves root composition when branch references cannot be resolved safely", () => {
    for (const ref of ["#/$defs/Cycle", "#/$defs/Missing", "https://example.test/schema", "#/constructor", "#", "#/"]) {
      const schema = {
        $defs: { Cycle: { $ref: "#/$defs/Cycle", properties: { cycle: { type: "boolean" } } } },
        anyOf: [{ $ref: ref, properties: { inline: { type: "string" } } }],
      };
      const parameters = toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters as Record<string, unknown>;
      expect(parameters).toEqual({ ...schema, type: "object" });
    }
  });

  test("preserves composition for over-budget chains, repeated refs and referenced compositions", () => {
    const $defs: Record<string, unknown> = {};
    for (let i = 0; i < 65; i++) $defs[`Node${i}`] = i === 64
      ? { properties: { terminal: { type: "string" } } }
      : { $ref: `#/$defs/Node${i + 1}` };
    const withinBudget = { $defs, oneOf: [{ $ref: "#/$defs/Node1" }] };
    expect((toolFor("claude-sonnet-5-5", gateway, undefined, withinBudget).parameters as Record<string, unknown>).properties).toEqual({ terminal: { type: "string" } });
    for (const schema of [
      { $defs, oneOf: [{ $ref: "#/$defs/Node0" }] },
      { $defs, oneOf: Array.from({ length: 65 }, () => ({ $ref: "#/$defs/Node64" })) },
      { $defs: { Union: unionRoot }, oneOf: [{ $ref: "#/$defs/Union" }] },
      { $defs, oneOf: [{ $ref: "#/$defs/Node64", allOf: unionRoot.oneOf }] },
    ]) {
      expect(toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters).toEqual({ ...schema, type: "object" });
    }
  });

  test.each(["oneOf", "anyOf", "allOf"])("preserves %s roots with unread declarations inside inline compositions", outer => {
    for (const inner of ["oneOf", "anyOf", "allOf"]) {
      for (const declaration of [{ properties: { payload: { type: "string" } } }, { $ref: "#/$defs/Payload" }]) {
        for (const nested of [declaration, { allOf: [{ anyOf: [{ oneOf: [declaration] }] }] }]) {
          const schema = { $defs: { Payload: { properties: { payload: { type: "string" } } } }, [outer]: [{ [inner]: [nested] }] };
          const before = structuredClone(schema);
          expect(toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters).toEqual({ ...schema, type: "object" });
          expect(schema).toEqual(before);
        }
      }
    }
  });

  test("constraint-only compositions flatten without scanning property schemas or literal values", () => {
    const literal = { properties: { payload: { type: "string" } }, $ref: "#/missing" };
    const properties = { nested: { anyOf: [literal] }, literal: { default: literal, examples: [literal], const: literal } };
    const schema = { anyOf: [{ properties, allOf: [{ anyOf: [{ oneOf: [{ required: ["nested"], default: literal, const: literal, enum: [literal], examples: [literal] }] }] }] }] };
    expect(toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters).toEqual({ type: "object", properties });
  });

  test("empty property maps in constraint-only compositions do not block flattening", () => {
    for (const properties of [{}, Object.create(null)]) {
      const schema = { oneOf: [{ allOf: [{ properties, required: ["payload"] }] }] };
      expect(toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters).toEqual({ type: "object" });
    }
  });

  test("empty property maps do not hide deeper declarations or references", () => {
    for (const declaration of [{ properties: { payload: { type: "string" } } }, { $ref: "#/missing" }]) {
      const schema = { anyOf: [{ allOf: [{ properties: {}, oneOf: [declaration] }] }] };
      expect(toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters).toEqual({ ...schema, type: "object" });
    }
  });

  test("nonempty and invalid property maps retain the conservative fallback", () => {
    for (const properties of [JSON.parse('{"__proto__":{"type":"string"}}'), null, [], "", false, 0]) {
      const schema = { anyOf: [{ allOf: [{ properties }] }] };
      expect(toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters).toEqual({ ...schema, type: "object" });
    }
  });

  test("shared constraint-only nodes flatten after shared Chat normalization clones them", () => {
    // The adapter entry point cannot exercise the later guard's object-identity branch.
    const shared = { properties: {}, required: ["payload"] };
    const schema = { anyOf: [{ allOf: [shared], oneOf: [shared] }] };
    expect(schema.anyOf[0].allOf[0]).toBe(schema.anyOf[0].oneOf[0]);
    expect(toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters).toEqual({ type: "object" });
  });

  test("bounds inline composition inspection per schema, including depth and repeated branches", () => {
    const chain = (depth: number) => {
      let node: Record<string, unknown> = { required: ["payload"] };
      for (let i = 0; i < depth; i++) node = { allOf: [node] };
      return node;
    };
    const boundary = { anyOf: [chain(256)] };
    expect(toolFor("claude-sonnet-5-5", gateway, undefined, boundary).parameters).toEqual({ type: "object" });
    for (const schema of [
      { anyOf: [chain(257)] },
      { anyOf: [{ allOf: Array.from({ length: 257 }, () => ({ required: ["payload"] })) }] },
      { anyOf: Array.from({ length: 257 }, () => ({ allOf: [{ required: ["payload"] }] })) },
    ]) {
      expect(toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters).toEqual({ ...schema, type: "object" });
    }
  });

  test("a non-Claude wire override excludes a Claude request alias", () => {
    const fn = toolFor("claude-alias", gateway, "gpt-5.6-terra");
    expect(fn.parameters).toEqual({ ...unionRoot, type: "object" });
    expect(fn.strict).toBe(true);
  });

  test("recognises provider-prefixed and upper-case Claude ids", () => {
    for (const id of ["anthropic/claude-opus-5", "Claude-Opus-5-5"]) {
      const parameters = toolFor(id).parameters as Record<string, unknown>;
      expect(parameters.oneOf).toBeUndefined();
      expect(parameters.type).toBe("object");
    }
  });

  test("uses the wire model id when the request is rewritten", () => {
    const parameters = toolFor("alias-model", gateway, "claude-opus-5").parameters as Record<string, unknown>;
    expect(parameters.oneOf).toBeUndefined();
  });

  test("leaves non-Claude models on the same gateway unchanged", () => {
    for (const id of ["gpt-5.6-terra", "kimi-k3", "glm-5.3", "claude", "claude-proxy/gpt-5.6-terra"]) {
      const fn = toolFor(id);
      expect(fn.parameters).toEqual({ ...unionRoot, type: "object" });
      expect(fn.strict).toBe(true);
    }
  });
});
