import { describe, expect, test } from "bun:test";
import { sanitizeGeminiToolParameters } from "../src/adapters/google-tool-schema";

describe("sanitizeGeminiToolParameters", () => {
  test("drops JSON-Schema keywords outside Google's documented function-schema subset", () => {
    const out = sanitizeGeminiToolParameters({
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "x",
      $comment: "c",
      type: "object",
      properties: {
        a: { type: "string", examples: ["x"], pattern: "^a$" },
        b: { type: "array", items: { type: "string" }, uniqueItems: true },
      },
      patternProperties: { "^x": { type: "string" } },
      if: { x: 1 },
      then: { y: 2 },
    });
    expect(out.$schema).toBeUndefined();
    expect(out.$id).toBeUndefined();
    expect(out.$comment).toBeUndefined();
    expect(out.patternProperties).toBeUndefined();
    expect(out.if).toBeUndefined();
    expect(out.then).toBeUndefined();
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.a.examples).toBeUndefined();
    expect(props.a.pattern).toBeUndefined();
    expect(props.b.uniqueItems).toBeUndefined();
    expect((props.b.items as Record<string, unknown>).type).toBe("string");
  });

  test("drops Codex's Responses-only encrypted marker recursively (issue #85)", () => {
    // Upstream codex stamps `encrypted: true` on v2 collaboration tool schemas
    // (spawn_agent/send_message/followup_task `message`); CCA 400s on the unknown name.
    const input = {
      type: "object",
      properties: {
        message: { type: "string", description: "...", encrypted: true },
        nested: {
          type: "object",
          properties: { inner: { type: "string", encrypted: false } },
        },
        list: { type: "array", items: { type: "string", encrypted: true } },
      },
      required: ["message"],
    };
    const before = JSON.stringify(input);
    const out = sanitizeGeminiToolParameters(input);
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.message.encrypted).toBeUndefined();
    expect(props.message.type).toBe("string");
    const inner = (props.nested.properties as Record<string, Record<string, unknown>>).inner;
    expect(inner.encrypted).toBeUndefined(); // `encrypted: false` is equally unsupported
    expect((props.list.items as Record<string, unknown>).encrypted).toBeUndefined();
    expect(out.required).toEqual(["message"]);
    expect(JSON.stringify(input)).toBe(before); // input object is never mutated
  });

  test("drops MCP header annotations that CCA rejects recursively", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      properties: {
        token: { type: "string", "x-mcp-header": "Authorization" },
        nested: {
          type: "object",
          properties: {
            trace: { type: "string", "x-mcp-header": "X-Trace-Id" },
          },
        },
        headers: {
          type: "array",
          items: { type: "string", "x-mcp-header": true },
        },
      },
    });
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.token["x-mcp-header"]).toBeUndefined();
    const nested = props.nested.properties as Record<string, Record<string, unknown>>;
    expect(nested.trace["x-mcp-header"]).toBeUndefined();
    expect((props.headers.items as Record<string, unknown>)["x-mcp-header"]).toBeUndefined();
    expect(props.token.type).toBe("string");
  });

  test("drops draft 2020-12 keywords outside OpenAPI 3.0 subset", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      $vocabulary: { "https://json-schema.org/draft/2020-12/vocab/core": true },
      $anchor: "root",
      properties: {
        payload: {
          type: "string",
          contentMediaType: "application/json",
          contentEncoding: "base64",
          contentSchema: { type: "object" },
          deprecated: true,
        },
        tuple: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }],
          items: { type: "string" },
        },
        refLike: {
          $dynamicRef: "#node",
          $dynamicAnchor: "node",
          type: "object",
        },
      },
    });
    expect(out.$vocabulary).toBeUndefined();
    expect(out.$anchor).toBeUndefined();
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.payload.contentMediaType).toBeUndefined();
    expect(props.payload.contentEncoding).toBeUndefined();
    expect(props.payload.contentSchema).toBeUndefined();
    expect(props.payload.deprecated).toBeUndefined();
    expect(props.payload.type).toBe("string");
    expect(props.tuple.prefixItems).toBeUndefined();
    expect((props.tuple.items as Record<string, unknown>).type).toBe("string");
    expect(props.refLike.$dynamicRef).toBeUndefined();
    expect(props.refLike.$dynamicAnchor).toBeUndefined();
    expect(props.refLike.type).toBe("object");
  });

  test("collapses type arrays to a single nullable type", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      properties: { a: { type: ["string", "null"] } },
    });
    const a = (out.properties as Record<string, Record<string, unknown>>).a;
    expect(a.type).toBe("string");
    expect(a.nullable).toBe(true);
  });

  test("rewrites string const to enum and drops unsupported exclusive bounds", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      properties: {
        a: { const: "fixed" },
        n: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10 },
      },
    });
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.a.enum).toEqual(["fixed"]);
    expect(props.a.const).toBeUndefined();
    expect(props.n.minimum).toBeUndefined();
    expect(props.n.maximum).toBeUndefined();
    expect(props.n.exclusiveMinimum).toBeUndefined();
  });

  test("deduplicates required names for Claude-on-Antigravity", () => {
    expect(sanitizeGeminiToolParameters({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query", "query", 42],
    }).required).toEqual(["query"]);
  });

  test("drops size constraints outside the strict Google allowlist", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      properties: {
        text: { type: "string", minLength: -1, maxLength: -2 },
        list: { type: "array", minItems: -1, maxItems: -2, items: { type: "string" } },
        object: { type: "object", minProperties: -1, maxProperties: -2, properties: {} },
        zeroIsValid: { type: "string", minLength: 0 },
      },
    });
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.text.minLength).toBeUndefined();
    expect(props.text.maxLength).toBeUndefined();
    expect(props.list.minItems).toBeUndefined();
    expect(props.list.maxItems).toBeUndefined();
    expect(props.object.minProperties).toBeUndefined();
    expect(props.object.maxProperties).toBeUndefined();
    expect(props.zeroIsValid.minLength).toBeUndefined();
  });

  test("collapses same-type enum anyOf branches for Claude-on-Antigravity", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      properties: {
        status: {
          description: "New status for the task",
          anyOf: [
            { type: "string", enum: ["pending", "in_progress", "completed"] },
            { type: "string", enum: ["deleted"] },
          ],
        },
      },
    });
    const status = (out.properties as Record<string, Record<string, unknown>>).status;
    expect(status).toEqual({
      description: "New status for the task",
      type: "string",
      enum: ["pending", "in_progress", "completed", "deleted"],
    });
  });

  test("collapses Serena nullable anyOf schemas for Claude-on-Antigravity", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      properties: {
        occurrence_ids: {
          anyOf: [
            { type: "array", items: { type: "string" } },
            { type: "null" },
          ],
          default: null,
          title: "Occurrence Ids",
          description: "Optional occurrence ids from a dry run.",
        },
      },
    });
    const occurrenceIds = (out.properties as Record<string, Record<string, unknown>>).occurrence_ids;
    expect(occurrenceIds).toEqual({
      type: "array",
      items: { type: "string" },
      nullable: true,
      description: "Optional occurrence ids from a dry run.",
    });
  });

  test("widens unsupported typed anyOf unions instead of forwarding a request-breaking schema", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      properties: {
        value: {
          description: "A string or number.",
          anyOf: [
            { type: "string", minLength: 1 },
            { type: "number", minimum: 0 },
          ],
        },
      },
    });
    const value = (out.properties as Record<string, Record<string, unknown>>).value;
    expect(value).toEqual({ description: "A string or number." });
  });

  test("enforces an object root without composition for Claude tool input schemas", () => {
    expect(sanitizeGeminiToolParameters({})).toEqual({
      type: "object",
      properties: {},
    });
    expect(sanitizeGeminiToolParameters({
      anyOf: [
        { type: "string" },
        { type: "number" },
      ],
    })).toEqual({
      type: "object",
      properties: {},
    });
  });

  test("emits only the documented Google function-schema allowlist recursively", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      title: "Dropped root title",
      default: {},
      futureKeyword: { surprise: true },
      properties: {
        safe: {
          type: "string",
          description: "Kept description",
          format: "date-time",
          title: "Dropped nested title",
          default: "x",
          pattern: "^x$",
          minLength: 1,
          "x-future-keyword": true,
        },
        title: { type: "string" },
      },
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        safe: {
          type: "string",
          description: "Kept description",
          format: "date-time",
        },
        title: { type: "string" },
      },
    });
  });

  test("falls back to an open object schema when hostile refs cannot be decoded", () => {
    expect(sanitizeGeminiToolParameters({
      $ref: "#/$defs/%E0%A4%A",
      $defs: { safe: { type: "string" } },
    })).toEqual({
      type: "object",
      properties: {},
    });
  });

  test("never leaks the internal null type used while normalizing unions", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      properties: {
        impossible: {
          anyOf: [
            { type: "null", enum: ["x"] },
            { type: "null", enum: ["y"] },
          ],
        },
      },
    });
    expect((out.properties as Record<string, unknown>).impossible).toEqual({});
  });

  test("preserves property names that overlap JavaScript prototype keys", () => {
    const properties = JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"number"}}');
    const out = sanitizeGeminiToolParameters({ type: "object", properties });
    const sanitized = out.properties as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(sanitized, "__proto__")).toBe(true);
    expect(sanitized.__proto__).toEqual({ type: "string" });
    expect(sanitized.constructor).toEqual({ type: "number" });
  });

  test("inlines local $ref into $defs and removes the defs bag", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: { Node: { type: "object", properties: { id: { type: "string" } } } },
    });
    expect(out.$defs).toBeUndefined();
    const node = (out.properties as Record<string, Record<string, unknown>>).node;
    expect(node.type).toBe("object");
    expect((node.properties as Record<string, Record<string, unknown>>).id.type).toBe("string");
  });

  test("does not infinitely recurse on self-referential $defs", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      properties: { tree: { $ref: "#/$defs/Tree" } },
      $defs: { Tree: { type: "object", properties: { child: { $ref: "#/$defs/Tree" } } } },
    });
    expect(out.type).toBe("object");
    const tree = (out.properties as Record<string, Record<string, unknown>>).tree;
    expect(tree.type).toBe("object");
  });

  test("falls back to an object schema for non-object input", () => {
    expect(sanitizeGeminiToolParameters(undefined)).toEqual({ type: "object", properties: {} });
    expect(sanitizeGeminiToolParameters("nope")).toEqual({ type: "object", properties: {} });
  });
});
