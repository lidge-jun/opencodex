import { describe, expect, test } from "bun:test";
import { sanitizeKiroSchema } from "../../../src/adapters/kiro-tools";
import { kiroStructuredOutputSpec, parseKiroStructuredText, parseKiroStructuredToolInput } from "../../../src/adapters/kiro/structured-output";
import { readKiroJson } from "../../../src/adapters/kiro/structured-output-json";
import { validateKiroStrictValue } from "../../../src/adapters/kiro/structured-output-schema";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxParsedRequest } from "../../../src/types";

// Strict structured output (`strict: true`) promises the caller a value that conforms to the whole
// schema, so the emulation validates the full OpenAI strict subset before relaying a value, and
// refuses a strict schema that uses a keyword it cannot check. Non-strict formats keep the light
// root checks covered in kiro-structured-output.test.ts.

/** A parsed Responses request whose `text.format` is a json_schema with `schema` and `strict`. */
function request(schema: Record<string, unknown>, strict = true): OcxParsedRequest {
  return parseRequest({
    model: "kiro/claude-opus-5.5",
    input: "Answer in JSON",
    stream: true,
    text: { format: { type: "json_schema", name: "response", strict, schema } },
  } as never);
}
const FAIL = "Kiro structured output did not match the requested format";
const titleSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

describe("Kiro strict structured output validation", () => {
  const spec = kiroStructuredOutputSpec(request(titleSchema))!;

  test("a wrong property type and an extra property are refused under strict", () => {
    expect(parseKiroStructuredToolInput(spec, '{"title":42,"extra":true}')).toEqual({
      error: `${FAIL}: $.title: expected a JSON string`,
    });
    expect(parseKiroStructuredToolInput(spec, '{"title":"x","extra":true}')).toEqual({
      error: `${FAIL}: $: unexpected property "extra"`,
    });
    expect(parseKiroStructuredText(spec, '{"title":"x","extra":1}')).toBeUndefined();
    expect(parseKiroStructuredToolInput(spec, '{"title":"x"}')).toEqual({ json: '{"title":"x"}' });
  });

  test("the same value stays accepted when the format is not strict", () => {
    const loose = kiroStructuredOutputSpec(request(titleSchema, false))!;
    expect(parseKiroStructuredToolInput(loose, '{"title":42,"extra":true}')).toEqual({ json: '{"title":42,"extra":true}' });
  });

  const rich = {
    type: "object",
    properties: {
      kind: { enum: ["a", "b"] },
      version: { const: "v2" },
      note: { type: ["string", "null"] },
      tags: { type: "array", items: { type: "string" } },
      item: { $ref: "#/$defs/item" },
      choice: { anyOf: [{ type: "integer" }, { type: "object", properties: { x: { type: "boolean" } }, required: ["x"], additionalProperties: false }] },
    },
    required: ["kind", "version", "note", "tags", "item", "choice"],
    additionalProperties: false,
    $defs: { item: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  };
  const richSpec = kiroStructuredOutputSpec(request(rich))!;
  const good = { kind: "a", version: "v2", note: null, tags: ["t"], item: { id: "i" }, choice: { x: true } };
  test.each([
    [good, undefined],
    [{ ...good, choice: 3 }, undefined],
    [{ ...good, kind: "c" }, "$.kind: expected one of the enum values"],
    [{ ...good, version: "v3" }, "$.version: expected the const value"],
    [{ ...good, note: 1 }, "$.note: expected a JSON string or null"],
    [{ ...good, tags: ["t", 1] }, "$.tags[1]: expected a JSON string"],
    [{ ...good, item: { id: "i", more: 1 } }, '$.item: unexpected property "more"'],
    [{ ...good, choice: 1.5 }, "$.choice: matched no anyOf branch"],
    [{ ...good, tags: undefined }, '$: missing required property "tags"'],
  ])("%j -> %j", (value, problem) => {
    const raw = JSON.stringify(value);
    expect(parseKiroStructuredToolInput(richSpec, raw)).toEqual(problem === undefined ? { json: raw } : { error: `${FAIL}: ${problem}` });
  });

  test("a strict schema using a keyword the emulation cannot check is refused before sending", () => {
    expect(() => kiroStructuredOutputSpec(request({ ...titleSchema, properties: { title: { type: "string", format: "email" } } })))
      .toThrow('Kiro does not support Responses structured output: strict schema keyword "format" cannot be enforced');
    expect(() => kiroStructuredOutputSpec(request({ oneOf: [{ type: "string" }, { type: "integer" }] })))
      .toThrow('strict schema keyword "oneOf" cannot be enforced');
    // The same keywords stay acceptable without strict, where only the light checks apply.
    expect(kiroStructuredOutputSpec(request({ oneOf: [{ type: "string" }] }, false))?.wrapped).toBe(true);
  });
});

describe("Kiro structured-output wrapping keeps references on the original root", () => {
  const tree = { anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#" } }] };

  test("a root self-reference is rewritten to the wrapped root without strict", () => {
    const spec = kiroStructuredOutputSpec(request(tree, false))!;
    expect(spec.wrapped).toBe(true);
    const value = (spec.toolSchema.properties as Record<string, any>).value;
    expect(value.anyOf[1].items.$ref).toBe("#/properties/value");
    expect(spec.schema).toEqual(tree);
  });

  test("root-relative pointers move with the root, and hoisted definitions keep theirs", () => {
    const schema = {
      type: "array",
      items: { $ref: "#/$defs/node" },
      $defs: { node: { type: "object", properties: { kids: { $ref: "#" }, peer: { $ref: "#/items" } } } },
    };
    const spec = kiroStructuredOutputSpec(request(schema, false))!;
    const tool = spec.toolSchema as Record<string, any>;
    expect(tool.properties.value.items.$ref).toBe("#/$defs/node");
    expect(tool.$defs.node.properties.kids.$ref).toBe("#/properties/value");
    expect(tool.$defs.node.properties.peer.$ref).toBe("#/properties/value/items");
  });

  test("a strict recursive schema validates through a definition", () => {
    const spec = kiroStructuredOutputSpec(request({
      $ref: "#/$defs/tree",
      $defs: { tree: { anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#/$defs/tree" } }] } },
    }))!;
    expect(parseKiroStructuredToolInput(spec, '{"value":["a",["b"]]}')).toEqual({ json: '["a",["b"]]' });
    expect(parseKiroStructuredToolInput(spec, '{"value":["a",[1]]}')).toEqual({
      error: `${FAIL}: $: matched no anyOf branch`,
    });
  });
});

const REFUSED = "Kiro does not support Responses structured output: strict schema keyword";

describe("Kiro strict validation stays bounded", () => {
  // Three branches, two of them identical recursive arrays: an unbounded walk tries both at every
  // level, so a value 40 arrays deep that fails at the bottom costs about 2^40 visits.
  const branching = {
    $ref: "#/$defs/n",
    $defs: { n: { anyOf: [{ type: "null" }, { type: "array", items: { $ref: "#/$defs/n" } }, { type: "array", items: { $ref: "#/$defs/n" } }] } },
  };
  const nested = (depth: number, leaf: string): string => `${"[".repeat(depth)}${leaf}${"]".repeat(depth)}`;

  test("a recursive anyOf stops at the global visit budget instead of branching exponentially", () => {
    const spec = kiroStructuredOutputSpec(request(branching))!;
    const document = readKiroJson(nested(40, "1"))!;
    const result = validateKiroStrictValue(branching, document.value, document.nodes);
    expect(result.problem).toContain("needs more work than strict validation allows");
    expect(result.visits).toBeLessThanOrEqual(result.budget + 1);
    expect(parseKiroStructuredToolInput(spec, `{"value":${nested(40, "1")}}`)).toEqual({
      error: expect.stringContaining("needs more work than strict validation allows"),
    });
    expect(parseKiroStructuredToolInput(spec, `{"value":${nested(40, "null")}}`)).toEqual({ json: nested(40, "null") });
  });

  test("one depth limit spans items and properties, so a deep value cannot exhaust the stack", () => {
    const list = { $ref: "#/$defs/l", $defs: { l: { type: "array", items: { $ref: "#/$defs/l" } } } };
    const spec = kiroStructuredOutputSpec(request(list))!;
    const tooDeep = { error: expect.stringMatching(/^Kiro structured output did not match the requested format: \S+: the value nests deeper than strict validation allows$/) };
    // 200 levels pass the reader but not the validator; 100,000 levels stop at the reader.
    for (const depth of [200, 100_000]) {
      expect(parseKiroStructuredToolInput(spec, `{"value":${nested(depth, "")}}`)).toEqual(tooDeep);
    }
    expect(parseKiroStructuredToolInput(spec, `{"value":${nested(20, "")}}`)).toEqual({ json: nested(20, "") });
    // Alternating properties and items share the same counter, which used to restart at each.
    const chain = { $defs: { n: { type: "object", properties: { k: { type: "array", items: { $ref: "#/$defs/n" } } } } }, $ref: "#/$defs/n" };
    const chainSpec = kiroStructuredOutputSpec(request(chain))!;
    const deep = `${'{"k":['.repeat(150)}${"]}".repeat(150)}`;
    expect(parseKiroStructuredToolInput(chainSpec, `{"value":${deep}}`)).toEqual(tooDeep);
  });
});

describe("Kiro strict references", () => {
  test.each([
    ["#/default", { type: "object", default: { format: "email" }, properties: { a: { $ref: "#/default" } } }],
    ["#", { type: "object", properties: { a: { $ref: "#" } } }],
    ["#/properties/b", { type: "object", properties: { a: { $ref: "#/properties/b" }, b: { type: "string" } } }],
    ["a nested $defs", { type: "object", properties: { a: { $defs: { x: { type: "string" } } } } }],
    ["a missing definition", { type: "object", properties: { a: { $ref: "#/$defs/missing" } } }],
    ["a ref-only cycle", { $ref: "#/$defs/a", $defs: { a: { $ref: "#/$defs/b" }, b: { anyOf: [{ $ref: "#/$defs/a" }] } } }],
  ])("%s is refused before sending", (_label, schema) => {
    expect(() => kiroStructuredOutputSpec(request(schema as Record<string, unknown>))).toThrow(REFUSED);
  });

  test("an annotation's content is never validated through a reference", () => {
    // The pre-fix walker resolved #/default and enforced `format` nowhere, relaying any string.
    expect(() => kiroStructuredOutputSpec(request({ type: "object", default: { format: "email" }, properties: { a: { $ref: "#/default" } } })))
      .toThrow(`${REFUSED} "$ref" cannot be enforced`);
  });
});

describe("Kiro strict numbers", () => {
  // The request reaches the adapter already parsed, so a schema number written with more digits than
  // a double holds arrives rounded: 1.0000000000000001 is 1 by then. Exact-equality keywords on
  // numbers are therefore refused in strict mode.
  test.each([
    ["const", { const: 5 }],
    ["const", { const: JSON.parse("1.0000000000000001") }],
    ["const", { const: { limit: 1 } }],
    ["enum", { enum: [1, 2] }],
    ["enum", { enum: ["a", [3]] }],
  ])("a numeric %s literal is refused before sending", (keyword, property) => {
    expect(() => kiroStructuredOutputSpec(request({ type: "object", properties: { n: property } })))
      .toThrow(`${REFUSED} "${keyword}" cannot be enforced`);
  });

  test("const and enum without numbers are still enforced", () => {
    const spec = kiroStructuredOutputSpec(request({
      type: "object",
      properties: { kind: { const: "pdf" }, mode: { enum: ["a", null, true, { x: "y" }] } },
      additionalProperties: false,
    }))!;
    expect(parseKiroStructuredToolInput(spec, '{"kind":"pdf","mode":{"x":"y"}}')).toEqual({ json: '{"kind":"pdf","mode":{"x":"y"}}' });
    expect(parseKiroStructuredToolInput(spec, '{"kind":"png"}')).toEqual({ error: `${FAIL}: $.kind: expected the const value` });
    expect(parseKiroStructuredToolInput(spec, '{"mode":"b"}')).toEqual({ error: `${FAIL}: $.mode: expected one of the enum values` });
  });

  test("bounds accept safe integers and decimals up to 15 significant digits, and refuse past that edge", () => {
    for (const maximum of [100, -5, 0.123456789012345, 9007199254740991]) {
      expect(() => kiroStructuredOutputSpec(request({ type: "number", maximum }))).not.toThrow();
    }
    for (const maximum of [0.1234567890123456, 9007199254740992, 1e300]) {
      expect(() => kiroStructuredOutputSpec(request({ type: "number", maximum })))
        .toThrow(`${REFUSED} "maximum" cannot be enforced`);
    }
  });

  test("bounds judge the exact lexeme the client receives", () => {
    const spec = kiroStructuredOutputSpec(request({
      type: "object",
      properties: { m: { type: "number", maximum: 10 }, i: { type: "integer", minimum: 0 } },
      additionalProperties: false,
    }))!;
    expect(parseKiroStructuredToolInput(spec, '{"m":10.0}')).toEqual({ json: '{"m":10.0}' });
    expect(parseKiroStructuredToolInput(spec, '{"m":10.0000000000000001}')).toEqual({ error: `${FAIL}: $.m: above maximum` });
    expect(parseKiroStructuredToolInput(spec, '{"i":-0.0000000000000001}')).toEqual({ error: `${FAIL}: $.i: expected a JSON integer` });
    expect(parseKiroStructuredToolInput(spec, '{"i":1.0000000000000001}')).toEqual({ error: `${FAIL}: $.i: expected a JSON integer` });
    expect(parseKiroStructuredText(spec, '{"m":1e400}')).toBeUndefined();
  });

  test("the wrapped form relays the original bytes of value", () => {
    const spec = kiroStructuredOutputSpec(request({ type: "integer" }))!;
    expect(spec.wrapped).toBe(true);
    expect(parseKiroStructuredToolInput(spec, '{"value":12345678901234567890}')).toEqual({ json: "12345678901234567890" });
  });
});

describe("Kiro strict multipleOf and regular expressions are refused", () => {
  test.each([
    ["multipleOf", { type: "number", multipleOf: 3 }],
    ["multipleOf", { type: "number", multipleOf: 0.1 }],
    ["pattern", { type: "string", pattern: "^[a-z]+$" }],
    ["pattern", { type: "string", pattern: "(a+)+$" }],
    ["patternProperties", { type: "object", patternProperties: { "^x": { type: "string" } } }],
  ])("strict %s is refused before sending", (keyword, schema) => {
    expect(() => kiroStructuredOutputSpec(request(schema))).toThrow(`${REFUSED} "${keyword}" cannot be enforced`);
  });

  test("non-strict formats still accept them, with the light root checks", () => {
    for (const schema of [
      { type: "number", multipleOf: 3 },
      { type: "string", pattern: "(a+)+$" },
      { type: "object", properties: { n: { const: 5 } } },
    ]) {
      expect(() => kiroStructuredOutputSpec(request(schema, false))).not.toThrow();
    }
  });
});

describe("Kiro schema sanitization keeps literal values", () => {
  test("const, enum and default are data, so keyword-named keys inside them survive", () => {
    const schema = {
      type: "object",
      properties: {
        kind: { const: { format: "pdf" } },
        mode: { enum: [{ pattern: "x" }, "plain"] },
        opts: { type: "object", default: { additionalProperties: 1 } },
        name: { type: "string", format: "email" },
      },
    };
    expect(sanitizeKiroSchema(schema)).toEqual({
      type: "object",
      properties: {
        kind: { const: { format: "pdf" } },
        mode: { enum: [{ pattern: "x" }, "plain"] },
        opts: { type: "object", default: { additionalProperties: 1 } },
        name: { type: "string" },
      },
    });
  });
});
