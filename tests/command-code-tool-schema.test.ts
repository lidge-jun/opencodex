import { describe, expect, test } from "bun:test";
import { normalizeAnthropicInputSchema } from "../src/adapters/anthropic-input-schema";

describe("normalizeAnthropicInputSchema", () => {
  test("flattens a root-level oneOf into a single object schema", () => {
    const normalized = normalizeAnthropicInputSchema({
      oneOf: [
        { type: "object", properties: { code: { type: "string" } } },
        { type: "object", properties: { completion_summary: { type: "string" } } },
      ],
    });
    expect(normalized.oneOf).toBeUndefined();
    expect(normalized.type).toBe("object");
    expect(Object.keys(normalized.properties as Record<string, unknown>)).toEqual([
      "code",
      "completion_summary",
    ]);
  });

  test("preserves nested composition inside properties", () => {
    const nested = { oneOf: [{ type: "object", properties: { a: { type: "string" } } }] };
    const normalized = normalizeAnthropicInputSchema({
      type: "object",
      properties: { opts: nested },
    });
    const properties = normalized.properties as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(properties.opts))).toEqual(nested);
  });

  test("adds an object type when the root omits it", () => {
    const normalized = normalizeAnthropicInputSchema({ properties: { a: { type: "string" } } });
    expect(normalized.type).toBe("object");
  });

  test("merges required members from allOf branches", () => {
    const normalized = normalizeAnthropicInputSchema({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
      ],
    });
    expect(normalized.allOf).toBeUndefined();
    expect(normalized.required).toEqual(["a", "b"]);
  });

  test("resolves local $ref branches before flattening", () => {
    const normalized = normalizeAnthropicInputSchema({
      $defs: {
        Args: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      allOf: [{ $ref: "#/$defs/Args" }],
    });
    expect(normalized.allOf).toBeUndefined();
    expect(normalized.type).toBe("object");
    expect(Object.keys(normalized.properties as Record<string, unknown>)).toEqual(["path"]);
    expect(normalized.required).toEqual(["path"]);
  });

  test("keeps a parameter named __proto__ as data", () => {
    const schema = JSON.parse(
      '{"oneOf":[{"type":"object","properties":{"__proto__":{"type":"string"}}}]}',
    );
    const normalized = normalizeAnthropicInputSchema(schema);
    const properties = normalized.properties as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(properties, "__proto__")).toBe(true);
    expect(JSON.stringify(properties)).toContain('"__proto__"');
  });

  test("later branches win for same-named properties, as documented", () => {
    const normalized = normalizeAnthropicInputSchema({
      oneOf: [
        { type: "object", properties: { action: { enum: ["read"] } } },
        { type: "object", properties: { action: { enum: ["write"] } } },
      ],
    });
    const properties = normalized.properties as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(properties.action))).toEqual({ enum: ["write"] });
  });

  test("keeps referenced and sibling properties when a $ref has siblings", () => {
    const normalized = normalizeAnthropicInputSchema({
      $defs: {
        Base: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      allOf: [{
        $ref: "#/$defs/Base",
        properties: { mode: { type: "string" } },
        required: ["mode"],
      }],
    });
    const properties = normalized.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["mode", "path"]);
    expect(normalized.required).toEqual(["path", "mode"]);
  });

  test("conjoins constraints when a $ref sibling redeclares a property", () => {
    const normalized = normalizeAnthropicInputSchema({
      $defs: {
        Base: {
          type: "object",
          properties: { path: { type: "string", minLength: 1 } },
          required: ["path"],
        },
      },
      allOf: [{
        $ref: "#/$defs/Base",
        properties: { path: { type: "string", maxLength: 10 } },
      }],
    });
    const properties = normalized.properties as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(properties.path))).toEqual({
      allOf: [
        { type: "string", minLength: 1 },
        { type: "string", maxLength: 10 },
      ],
    });
  });

  test("unions required members from a $ref and its siblings without duplicates", () => {
    const normalized = normalizeAnthropicInputSchema({
      $defs: {
        Base: {
          type: "object",
          properties: { path: { type: "string" }, mode: { type: "string" } },
          required: ["path", "mode"],
        },
      },
      allOf: [{
        $ref: "#/$defs/Base",
        required: ["mode"],
      }],
    });
    expect(normalized.required).toEqual(["path", "mode"]);
  });
});

