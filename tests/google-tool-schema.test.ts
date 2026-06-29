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
