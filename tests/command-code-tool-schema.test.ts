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
});

