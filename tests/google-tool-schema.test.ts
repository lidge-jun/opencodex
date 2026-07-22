import { describe, expect, test } from "bun:test";
import { sanitizeGeminiToolParameters } from "../src/adapters/google-tool-schema";

describe("sanitizeGeminiToolParameters", () => {
  test("drops JSON-Schema keywords CCA rejects", () => {
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
    expect(props.a.pattern).toBe("^a$");
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

  test("collapses type arrays to a single nullable type", () => {
    const out = sanitizeGeminiToolParameters({
      type: "object",
      properties: { a: { type: ["string", "null"] } },
    });
    const a = (out.properties as Record<string, Record<string, unknown>>).a;
    expect(a.type).toBe("string");
    expect(a.nullable).toBe(true);
  });

  test("rewrites const to enum and exclusive bounds to inclusive", () => {
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
    expect(props.n.minimum).toBe(0);
    expect(props.n.maximum).toBe(10);
    expect(props.n.exclusiveMinimum).toBeUndefined();
  });

  test("deduplicates required names for Claude-on-Antigravity", () => {
    expect(sanitizeGeminiToolParameters({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query", "query", 42],
    }).required).toEqual(["query"]);
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
    expect(sanitizeGeminiToolParameters(undefined)).toEqual({ type: "object" });
    expect(sanitizeGeminiToolParameters("nope")).toEqual({ type: "object" });
  });
});
