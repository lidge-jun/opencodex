import { describe, expect, test } from "bun:test";
import { isAnthropicOutputSchema, satisfiesOpenAiStrictSchema } from "../../src/adapters/anthropic-output-schema";
import { anthropicToResponsesBody } from "../../src/claude/inbound";
import { formatFromOutputConfig } from "../../src/claude/inbound-model-options";
import { parseRequest } from "../../src/responses/parser";

type Schema = Record<string, unknown>;

function closedObject(properties: Schema = {}): Schema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

function expectTranslatedStrict(schema: Schema, strict: boolean): void {
  const before = structuredClone(schema);
  // Acceptance normalizes a clone; strict eligibility must describe the ORIGINAL wire schema.
  expect(isAnthropicOutputSchema(schema)).toBe(true);
  const format = formatFromOutputConfig({ format: { type: "json_schema", schema } });
  expect(format).toEqual({ type: "json_schema", name: "response", schema, strict });
  expect(format?.schema).toBe(schema);
  const body = anthropicToResponsesBody({
    model: "claude-sonnet-5", max_tokens: 256,
    messages: [{ role: "user", content: "Return JSON" }],
    output_config: { format: { type: "json_schema", schema } },
  });
  expect(parseRequest(body).options.textFormat).toEqual({ type: "json_schema", name: "response", schema, strict });
  expect(schema).toEqual(before);
}

describe("translated Anthropic structured output strict eligibility (#5901 follow-up)", () => {
  test.each([
    { type: "object" },
    { type: "object", additionalProperties: false, required: [] },
    { type: "object", properties: null, additionalProperties: false, required: [] },
    { type: "object", properties: [], additionalProperties: false, required: [] },
    { type: "object", properties: "invalid", additionalProperties: false, required: [] },
    { type: "object", properties: {} },
    { type: "object", properties: {}, required: [] },
    { type: "object", properties: {}, required: [], additionalProperties: true },
    { type: "object", properties: {}, additionalProperties: false },
  ])("does not certify an incomplete object: %j", schema => {
    expect(satisfiesOpenAiStrictSchema(schema)).toBe(false);
    expectTranslatedStrict(schema, false);
  });

  test.each([undefined, null, "answer", [], ["answer", "extra"], ["answer", "answer"], [123]]
    .map(required => ({ required })))(
    "requires exactly the declared property names: %j", ({ required }) => {
      const schema = { ...closedObject({ answer: { type: "string" } }), required };
      expect(satisfiesOpenAiStrictSchema(schema)).toBe(false);
      expectTranslatedStrict(schema, false);
    },
  );

  test.each([
    { payload: null },
    { payload: { type: "object" } },
    { payload: { type: ["object", "null"] } },
    { payload: { type: "array", items: { type: "object" } } },
    { payload: { anyOf: [{ type: "null" }, { type: "object" }] } },
    { payload: { anyOf: [null, { type: "string" }] } },
  ])("checks object contracts in nested schema positions: %j", properties => {
    const schema = closedObject(properties);
    expect(satisfiesOpenAiStrictSchema(schema)).toBe(false);
    expectTranslatedStrict(schema, false);
  });

  test("checks object contracts inside referenced definitions", () => {
    const schema = {
      ...closedObject({ payload: { $ref: "#/$defs/payload" } }),
      $defs: { payload: { type: "object" } },
    };
    expectTranslatedStrict(schema, false);
  });

  test.each(["allOf", "oneOf", "not", "dependentRequired", "dependentSchemas", "if", "then", "else",
    "additionalItems", "contains", "minContains", "maxContains", "prefixItems", "uniqueItems",
    "propertyNames", "minProperties", "maxProperties", "unevaluatedItems", "unevaluatedProperties"])(
    "does not claim unsupported strict keyword %s at a schema node", keyword => {
      const unsupported = {
        ...closedObject(),
        [keyword]: keyword === "allOf" ? [closedObject()] : keyword === "uniqueItems" ? true : {},
      };
      expectTranslatedStrict(unsupported, false);
      expectTranslatedStrict(closedObject({ payload: { type: "array", items: unsupported } }), false);
    },
  );

  test("an unsupported array constraint on a property survives with strict disabled", () => {
    const schema = closedObject({
      tags: { type: "array", items: { type: "string" }, uniqueItems: true },
    });
    expectTranslatedStrict(schema, false);
  });

  test("unknown schema keywords fail closed instead of waiting for another denylist entry", () => {
    for (const property of [
      { type: "string", contentEncoding: "base64" },
      { type: "string", minLength: 1 },
      { type: "string", default: "value" },
      { type: "string", examples: ["value"] },
      { type: "string", readOnly: true },
    ]) {
      expectTranslatedStrict(closedObject({ value: property }), false);
    }
  });

  test("OpenAI strict string formats use the documented subset without changing Anthropic acceptance", () => {
    const uriSchema = closedObject({ resource: { type: "string", format: "uri" } });
    expectTranslatedStrict(uriSchema, false);
    expect((uriSchema.properties as Schema).resource).toEqual({ type: "string", format: "uri" });

    for (const format of [
      "date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid",
    ]) {
      expectTranslatedStrict(closedObject({ value: { type: "string", format } }), true);
    }
  });

  test("keeps complete empty, nested, array and nullable objects strict", () => {
    expectTranslatedStrict(closedObject(), true);
    const schema = {
      ...closedObject({
        empty: closedObject(),
        rows: { type: "array", items: closedObject({ answer: { type: "string" } }) },
        optionalValue: { ...closedObject(), type: ["object", "null"] },
        choice: { anyOf: [closedObject(), { type: "null" }] },
        referenced: { $ref: "#/$defs/payload" },
      }),
      $defs: { payload: closedObject({ next: { $ref: "#/$defs/payload" } }) },
    };
    expectTranslatedStrict(schema, true);
  });

  test("keeps documented type-specific constraints strict", () => {
    expectTranslatedStrict(closedObject({
      text: { type: "string", pattern: "^[a-z]+$", format: "hostname" },
      count: { type: "integer", minimum: 0, exclusiveMaximum: 10, multipleOf: 2 },
      rows: { type: "array", items: { type: "boolean" }, minItems: 1, maxItems: 3 },
    }), true);
  });

  test.each([0, -2])("does not certify a non-positive multipleOf: %d", multipleOf => {
    const schema = closedObject({ count: { type: "integer", multipleOf } });
    expect(satisfiesOpenAiStrictSchema(schema)).toBe(false);
    expect(satisfiesOpenAiStrictSchema(closedObject({ count: { type: "integer", multipleOf: 2 } }))).toBe(true);
  });

  test("fine-tuned targets preserve unsupported constraints with strict disabled", () => {
    const schema = closedObject({
      nested: {
        anyOf: [
          { type: "string", pattern: "^[a-z]+$" },
          { type: "array", items: { type: "integer", minimum: 0 }, maxItems: 3 },
        ],
      },
      mapped: { $ref: "#/$defs/mapped" },
    });
    schema.$defs = {
      mapped: {
        type: "object", properties: {}, required: [], additionalProperties: false,
        patternProperties: { "^x-": { type: "string" } },
      },
    };
    const before = structuredClone(schema);

    for (const model of ["ft:gpt-4.1-nano:org::name", "openai/ft:gpt-4.1-nano:org::name"]) {
      expect(formatFromOutputConfig({ format: { type: "json_schema", schema } }, model))
        .toEqual({ type: "json_schema", name: "response", schema, strict: false });
    }
    expect(formatFromOutputConfig({ format: { type: "json_schema", schema } }, "gpt-4.1-nano"))
      .toEqual({ type: "json_schema", name: "response", schema, strict: true });
    expect(schema).toEqual(before);
  });

  test("resolved modelMap targets control fine-tuned strict eligibility", () => {
    const constrained = closedObject({ value: { type: "string", format: "email" } });
    const raw = {
      model: "claude-sonnet-5", max_tokens: 256,
      messages: [{ role: "user", content: "Return JSON" }],
      output_config: { format: { type: "json_schema", schema: constrained } },
    };
    const fineTuned = anthropicToResponsesBody(raw, {
      modelMap: { "claude-sonnet-5": "openai/ft:gpt-4.1-nano:org::name" },
    });
    expect((fineTuned.text as { format: { strict: boolean } }).format.strict).toBe(false);
    expect(fineTuned.model).toBe("openai/ft:gpt-4.1-nano:org::name");

    const ordinary = anthropicToResponsesBody({ ...raw, output_config: {
      format: { type: "json_schema", schema: closedObject({ value: { type: "string" } }) },
    } }, {
      modelMap: { "claude-sonnet-5": "openai/ft:gpt-4.1-nano:org::name" },
    });
    expect((ordinary.text as { format: { strict: boolean } }).format.strict).toBe(true);
  });

  test("property names and literal data are not mistaken for schema keywords", () => {
    const schema = closedObject({
      not: { type: "string" }, allOf: { type: "string" }, properties: { type: "string" },
      example: {
        ...closedObject({ type: { type: "string" } }),
        enum: [{ type: "object", not: {}, properties: null }],
      },
    });
    expectTranslatedStrict(schema, true);
  });

  test.each(["anyOf", "oneOf"])("a root %s stays non-strict even with an explicit object type", keyword => {
    expectTranslatedStrict({ ...closedObject(), [keyword]: [closedObject()] }, false);
  });

  test.each([{ type: "string" }, { type: "array", items: { type: "string" } }])(
    "keeps non-object root behavior: %j", schema => expectTranslatedStrict(schema, false),
  );

  test("preserves optional fields and unsupported-schema rejection", () => {
    expectTranslatedStrict({ ...closedObject({ answer: { type: "string" } }), required: [] }, false);
    expect(formatFromOutputConfig({ format: { type: "json_schema", schema: { description: "no type" } } }))
      .toBeUndefined();
    expect(formatFromOutputConfig({ format: { type: "json_object" } })).toBeUndefined();
  });
});
