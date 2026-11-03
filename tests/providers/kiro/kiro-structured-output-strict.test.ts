import { describe, expect, test } from "bun:test";
import { sanitizeKiroSchema } from "../../../src/adapters/kiro-tools";
import { kiroStructuredOutputSpec, kiroStructuredStopFailure, parseKiroStructuredText, parseKiroStructuredToolInput } from "../../../src/adapters/kiro/structured-output";
import { kiroDecimal, readKiroJson } from "../../../src/adapters/kiro/structured-output-json";
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
      error: `${FAIL}: expected a JSON string`,
    });
    expect(parseKiroStructuredToolInput(spec, '{"title":"x","extra":true}')).toEqual({
      error: `${FAIL}: an object has a property the schema does not allow`,
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
    [{ ...good, kind: "c" }, "expected one of the enum values"],
    [{ ...good, version: "v3" }, "expected the const value"],
    [{ ...good, note: 1 }, "expected a JSON string or null"],
    [{ ...good, tags: ["t", 1] }, "expected a JSON string"],
    [{ ...good, item: { id: "i", more: 1 } }, "an object has a property the schema does not allow"],
    [{ ...good, choice: 1.5 }, "matched no anyOf branch"],
    [{ ...good, tags: undefined }, "an object is missing a required property"],
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
      error: `${FAIL}: matched no anyOf branch`,
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
    const tooDeep = { error: expect.stringMatching(/^Kiro structured output did not match the requested format: the value nests deeper than strict validation allows$/) };
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
    expect(parseKiroStructuredToolInput(spec, '{"kind":"png"}')).toEqual({ error: `${FAIL}: expected the const value` });
    expect(parseKiroStructuredToolInput(spec, '{"mode":"b"}')).toEqual({ error: `${FAIL}: expected one of the enum values` });
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
    expect(parseKiroStructuredToolInput(spec, '{"m":10.0000000000000001}')).toEqual({ error: `${FAIL}: a number is above maximum` });
    expect(parseKiroStructuredToolInput(spec, '{"i":-0.0000000000000001}')).toEqual({ error: `${FAIL}: expected a JSON integer` });
    expect(parseKiroStructuredToolInput(spec, '{"i":1.0000000000000001}')).toEqual({ error: `${FAIL}: expected a JSON integer` });
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

describe("Kiro strict schema hardening", () => {
  test("a $ref beside an assertion has no single meaning and is refused; annotations and root $defs are fine", () => {
    const defs = { $defs: { n: { type: "integer" } } };
    expect(() => kiroStructuredOutputSpec(request({ type: "object", properties: { a: { $ref: "#/$defs/n", type: "string" } }, ...defs })))
      .toThrow(REFUSED + ' "$ref" cannot be enforced');
    expect(() => kiroStructuredOutputSpec(request({ type: "object", properties: { a: { $ref: "#/$defs/n", description: "count" } }, ...defs }))).not.toThrow();
    expect(() => kiroStructuredOutputSpec(request({ $ref: "#/$defs/n", ...defs }))).not.toThrow();
  });

  test("a schema past the node cap is refused quickly, and a wide accepted anyOf prepares in linear time", () => {
    const wide = (n: number) => ({ type: "object", properties: { a: { anyOf: Array.from({ length: n }, () => true) } } });
    expect(() => kiroStructuredOutputSpec(request(wide(64_000)))).toThrow(REFUSED);
    expect(() => kiroStructuredOutputSpec(request(wide(9_000)))).not.toThrow();
  }, 30_000);

  test("literal comparisons are charged to the validation budget", () => {
    const big = Array.from({ length: 5_000 }, () => "x");
    const schema = {
      type: "object",
      properties: { a: { anyOf: Array.from({ length: 2_000 }, () => ({ $ref: "#/$defs/big" })) } },
      $defs: { big: { const: big } },
    };
    const raw = JSON.stringify({ a: [...big.slice(1), "y"] });
    const document = readKiroJson(raw)!;
    const result = validateKiroStrictValue(schema, document.value, document.nodes);
    expect(result.problem).toContain("needs more work than strict validation allows");
    expect(result.visits).toBeLessThanOrEqual(result.budget + 1);
  }, 30_000);

  test("a literal larger than the schema-wide cap is refused before sending", () => {
    expect(() => kiroStructuredOutputSpec(request({ type: "object", properties: { a: { const: Array.from({ length: 20_000 }, () => "x") } } })))
      .toThrow(REFUSED + ' "const" cannot be enforced');
  });

  test("diagnostics and refusals carry no schema or answer text", () => {
    const spec = kiroStructuredOutputSpec(request(titleSchema))!;
    const result = parseKiroStructuredToolInput(spec, '{"title":"t","secret-model-key-123":1}');
    expect(result).toEqual({ error: FAIL + ": an object has a property the schema does not allow" });
    let message = "";
    try { kiroStructuredOutputSpec(request({ type: "object", "caller-key-xyz": true })); } catch (error) { message = String(error); }
    expect(message).toContain("uses a keyword that cannot be enforced");
    expect(message).not.toContain("caller-key-xyz");
  });
});

describe("Kiro schema sanitization keeps a __proto__ property", () => {
  test("a property or definition named __proto__ stays an own key", () => {
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"],"$defs":{"__proto__":{"type":"string"}}}');
    const out = sanitizeKiroSchema(schema) as { properties: object; $defs: object };
    expect(Object.keys(out.properties)).toEqual(["__proto__"]);
    expect(Object.keys(out.$defs)).toEqual(["__proto__"]);
    expect(JSON.stringify(out)).toContain('"properties":{"__proto__":{"type":"string"}}');
  });
});

describe("Kiro strict budget covers every per-node loop", () => {
  test("a long required list re-checked through failing anyOf branches stays within the budget", () => {
    const required = Array.from({ length: 5_000 }, (_, i) => "k" + i);
    const schema = {
      type: "object",
      properties: { a: { anyOf: Array.from({ length: 2_000 }, () => ({ $ref: "#/$defs/obj" })) } },
      $defs: { obj: { type: "object", required: [...required.slice(1), "missing"] } },
    };
    const raw = JSON.stringify({ a: Object.fromEntries(required.map(key => [key, 1])) });
    const document = readKiroJson(raw)!;
    const result = validateKiroStrictValue(schema, document.value, document.nodes);
    expect(result.problem).toContain("needs more work than strict validation allows");
  }, 30_000);

  test("a percent-encoded separator in $ref is a pointer segment, not part of a definition name", () => {
    const schema = {
      type: "object",
      properties: { v: { $ref: "#/$defs/a%2Fproperties%2Fb" } },
      $defs: { a: { type: "object", properties: { b: { type: "string" } } }, "a/properties/b": { type: "number" } },
    };
    expect(() => kiroStructuredOutputSpec(request(schema))).toThrow(REFUSED + ' "$ref" cannot be enforced');
    const named = { type: "object", properties: { v: { $ref: "#/$defs/x~1y" } }, $defs: { "x/y": { type: "number" } } };
    const spec = kiroStructuredOutputSpec(request(named))!;
    expect(parseKiroStructuredToolInput(spec, '{"v":1}')).toEqual({ json: '{"v":1}' });
    expect(parseKiroStructuredToolInput(spec, '{"v":"s"}')).toEqual({ error: FAIL + ": expected a JSON number" });
  });
});

describe("Kiro strict repeated string work and resource identifiers", () => {
  test("a long string re-checked by many length-constrained branches stays fast and bounded", () => {
    const schema = { type: "object", properties: { s: { anyOf: Array.from({ length: 9_000 }, () => ({ maxLength: 0 })) } } };
    const raw = JSON.stringify({ s: "x".repeat(1_000_000) });
    const document = readKiroJson(raw)!;
    const result = validateKiroStrictValue(schema, document.value, document.nodes);
    expect(result.problem).toBeDefined();
  }, 30_000);

  test("branches without a length constraint never walk the string", () => {
    const schema = { type: "object", properties: { s: { anyOf: [...Array.from({ length: 9_000 }, () => ({ type: "number" })), { type: "string" }] } } };
    const raw = JSON.stringify({ s: "x".repeat(1_000_000) });
    const document = readKiroJson(raw)!;
    expect(validateKiroStrictValue(schema, document.value, document.nodes).problem).toBeUndefined();
  }, 30_000);

  test("a nested $id or an anchor is refused; a root $id is kept", () => {
    const defs = { $defs: { x: { type: "string" } } };
    expect(() => kiroStructuredOutputSpec(request({ type: "object", properties: { a: { $id: "https://example.com/inner", type: "string" } }, ...defs })))
      .toThrow(REFUSED + ' "$id" cannot be enforced');
    expect(() => kiroStructuredOutputSpec(request({ type: "object", properties: { a: { $anchor: "here", type: "string" } } })))
      .toThrow(REFUSED + ' "$anchor" cannot be enforced');
    expect(() => kiroStructuredOutputSpec(request({ $id: "https://example.com/root", type: "object", properties: { a: { $ref: "#/$defs/x" } }, ...defs })))
      .not.toThrow();
  });
});

describe("Kiro strict numbers, types and wrapping edges", () => {
  test("a long number lexeme re-checked by many bounded branches is charged and stays within the budget", () => {
    const schema = { type: "object", properties: { n: { anyOf: Array.from({ length: 1_000 }, () => ({ maximum: 0 })) } } };
    const raw = '{"n":1e' + "9".repeat(100_000) + "}";
    const document = readKiroJson(raw)!;
    const result = validateKiroStrictValue(schema, document.value, document.nodes);
    expect(result.problem).toContain("needs more work than strict validation allows");
    expect(result.visits).toBeLessThanOrEqual(result.budget + 1_000);
  }, 30_000);

  test("an integer type check on a long lexeme is charged the same way", () => {
    const schema = { type: "object", properties: { n: { anyOf: Array.from({ length: 1_000 }, () => ({ type: ["integer", "null"], maximum: -1 })) } } };
    const raw = '{"n":' + "1".repeat(100_000) + "}";
    const document = readKiroJson(raw)!;
    expect(validateKiroStrictValue(schema, document.value, document.nodes).problem).toContain("needs more work than strict validation allows");
  }, 30_000);

  test("a type list with a repeated type is refused, so type lists stay short", () => {
    expect(() => kiroStructuredOutputSpec(request({ type: ["string", "string"] }))).toThrow(REFUSED + ' "type" cannot be enforced');
  });

  test("a strict format without an object schema is refused instead of becoming an unrestricted object", () => {
    const strictFalse = parseRequest({
      model: "kiro/claude-opus-5.5", input: "x", stream: true,
      text: { format: { type: "json_schema", name: "response", strict: true, schema: false } },
    } as never);
    expect(() => kiroStructuredOutputSpec(strictFalse)).toThrow("a strict format needs a JSON object schema");
    const looseFalse = parseRequest({
      model: "kiro/claude-opus-5.5", input: "x", stream: true,
      text: { format: { type: "json_schema", name: "response", strict: false, schema: false } },
    } as never);
    expect(kiroStructuredOutputSpec(looseFalse)).toMatchObject({ toolSchema: { type: "object" }, wrapped: false });
  });

  test("wrapping keeps an encoded $defs reference and a root $id at the wrapper root", () => {
    const spec = kiroStructuredOutputSpec(request({
      $id: "https://example.com/root",
      type: "array",
      items: { $ref: "#/%24defs/item" },
      $defs: { item: { type: "string" } },
    }))!;
    expect(spec.wrapped).toBe(true);
    const tool = spec.toolSchema as { $id?: string; $defs?: object; properties: { value: { $id?: string; items: { $ref: string } } } };
    expect(tool.$id).toBe("https://example.com/root");
    expect(tool.properties.value.$id).toBeUndefined();
    expect(tool.properties.value.items.$ref).toBe("#/%24defs/item");
    expect(tool.$defs).toEqual({ item: { type: "string" } });
  });

  test("a wrapped answer past the reader's nesting limit is refused rather than re-serialized", () => {
    const spec = kiroStructuredOutputSpec(request({ type: "array" }, false))!;
    expect(spec.wrapped).toBe(true);
    const deep = "[".repeat(520) + "9007199254740993" + "]".repeat(520);
    expect(parseKiroStructuredToolInput(spec, '{"value":' + deep + "}"))
      .toEqual({ error: FAIL + ": the value nests deeper than the proxy can relay exactly" });
  });
});

describe("Kiro decimal and wrapped reference edges", () => {
  test("a long run of zeros inside a number is normalized in linear time", () => {
    const lexeme = "1" + "0".repeat(200_000) + "1";
    const decimal = kiroDecimal(lexeme);
    expect(decimal.digits.length).toBe(200_002);
    expect(kiroDecimal("1" + "0".repeat(200_000)).digits).toBe("1");
  }, 30_000);

  test("an encoded root-relative reference is re-pointed under value when wrapping", () => {
    const spec = kiroStructuredOutputSpec(request({ type: "array", items: { anyOf: [{ type: "string" }, { $ref: "#%2Fitems" }] } }, false))!;
    expect(spec.wrapped).toBe(true);
    const tool = spec.toolSchema as { properties: { value: { items: { anyOf: Array<{ $ref?: string }> } } } };
    expect(tool.properties.value.items.anyOf[1]!.$ref).toBe("#/properties/value%2Fitems");
  });

  test("references inside a nested $id resource are left relative to that resource", () => {
    const spec = kiroStructuredOutputSpec(request({
      type: "array",
      items: { $id: "https://example.com/inner", type: "object", properties: { x: { type: "string" }, y: { $ref: "#/properties/x" } } },
    }, false))!;
    const tool = spec.toolSchema as { properties: { value: { items: { properties: { y: { $ref: string } } } } } };
    expect(tool.properties.value.items.properties.y.$ref).toBe("#/properties/x");
  });

  test("an exponent millions of digits long saturates, and bounds still judge the number correctly", () => {
    const huge = "1e" + "9".repeat(2_000_000);
    expect(kiroDecimal(huge).exponent).toBe(10n ** 15n + 1n);
    expect(kiroDecimal("-1e-" + "9".repeat(2_000_000)).exponent).toBe(1n - 10n ** 15n);
    const over = readKiroJson(huge)!;
    expect(validateKiroStrictValue({ type: "number", maximum: 100 }, over.value, over.nodes).problem).toBeDefined();
    expect(validateKiroStrictValue({ type: "integer" }, over.value, over.nodes).problem).toBeUndefined();
    const tiny = readKiroJson("1e-" + "9".repeat(2_000_000))!;
    expect(validateKiroStrictValue({ type: "number", minimum: 0, maximum: 1 }, tiny.value, tiny.nodes).problem).toBeUndefined();
    expect(validateKiroStrictValue({ type: "integer" }, tiny.value, tiny.nodes).problem).toBeDefined();
  }, 30_000);

  test("wrapping keeps references to the definition containers themselves at the wrapper root", () => {
    for (const ref of ["#/$defs", "#/%24defs", "#/definitions", "#%2F%24defs"]) {
      const spec = kiroStructuredOutputSpec(request({ type: "array", items: { $ref: ref }, $defs: { not: false } }, false))!;
      const tool = spec.toolSchema as { properties: { value: { items: { $ref: string } } } };
      expect(tool.properties.value.items.$ref).toBe(ref);
    }
  });

  test("a strict $ref with a JSON Pointer escape other than ~0 or ~1 is refused", () => {
    const schema = (ref: string, name: string) => ({
      type: "object", properties: { a: { $ref: ref } }, required: ["a"], additionalProperties: false, $defs: { [name]: { type: "string" } },
    });
    expect(() => kiroStructuredOutputSpec(request(schema("#/$defs/a~2b", "a~2b")))).toThrow(REFUSED + ' "$ref" cannot be enforced');
    expect(() => kiroStructuredOutputSpec(request(schema("#/$defs/a~", "a~")))).toThrow(REFUSED + ' "$ref" cannot be enforced');
    expect(kiroStructuredOutputSpec(request(schema("#/$defs/a~0b", "a~b")))?.strict).toBe(true);
  });

  test("a retry stop diagnostic names only stop reasons Kiro documents", () => {
    expect(kiroStructuredStopFailure("MAX_TOKENS")).toContain("stopped with MAX_TOKENS");
    const unknown = kiroStructuredStopFailure("UPSTREAM_SUPPLIED_TEXT");
    expect(unknown).not.toContain("UPSTREAM_SUPPLIED_TEXT");
    expect(unknown).toContain("stopped before a complete answer");
  });
});
