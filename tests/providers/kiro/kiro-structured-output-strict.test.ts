import { describe, expect, test } from "bun:test";
import { sanitizeKiroSchema } from "../../../src/adapters/kiro-tools";
import { kiroStructuredOutputSpec, parseKiroStructuredText, parseKiroStructuredToolInput } from "../../../src/adapters/kiro/structured-output";
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
      version: { const: 2 },
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
  const good = { kind: "a", version: 2, note: null, tags: ["t"], item: { id: "i" }, choice: { x: true } };
  test.each([
    [good, undefined],
    [{ ...good, choice: 3 }, undefined],
    [{ ...good, kind: "c" }, "$.kind: expected one of the enum values"],
    [{ ...good, version: 3 }, "$.version: expected the const value"],
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

  test("a root self-reference is rewritten to the wrapped root", () => {
    const spec = kiroStructuredOutputSpec(request(tree))!;
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

  test("a strict recursive schema validates against the original root", () => {
    const spec = kiroStructuredOutputSpec(request(tree))!;
    expect(parseKiroStructuredToolInput(spec, '{"value":["a",["b"]]}')).toEqual({ json: '["a",["b"]]' });
    expect(parseKiroStructuredToolInput(spec, '{"value":["a",[1]]}')).toEqual({
      error: `${FAIL}: $: matched no anyOf branch`,
    });
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
