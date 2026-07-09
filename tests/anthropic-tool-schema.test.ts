import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "apiKey" } as unknown as OcxProviderConfig;

function toolSchema(parameters: unknown): Record<string, unknown> {
  const { body } = createAnthropicAdapter(provider).buildRequest({
    modelId: "anthropic/claude-opus-4.1",
    stream: false,
    options: {},
    context: {
      messages: [{ role: "user", content: "use the tool", timestamp: 0 }],
      tools: [{ name: "sample_tool", description: "Sample", parameters }],
    },
  } as unknown as OcxParsedRequest);
  const parsed = JSON.parse(body as string) as { tools: Array<{ input_schema: Record<string, unknown> }> };
  return parsed.tools[0].input_schema;
}

describe("anthropic tool input_schema normalization", () => {
  test("missing root type becomes an object schema with properties", () => {
    expect(toolSchema({ properties: { query: { type: "string" } }, required: ["query"] })).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(toolSchema({})).toEqual({ type: "object", properties: {} });
  });

  test("root oneOf and anyOf are flattened without promoting branch required fields", () => {
    const anyOf = toolSchema({
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    expect(anyOf.anyOf).toBeUndefined();
    expect(anyOf.oneOf).toBeUndefined();
    expect(anyOf.allOf).toBeUndefined();
    expect(anyOf).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
    });

    const oneOf = toolSchema({
      oneOf: [
        { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      ],
    });
    expect(oneOf).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });

  test("root allOf merges required fields and preserves sibling schema metadata", () => {
    expect(toolSchema({
      title: "Search options",
      additionalProperties: false,
      properties: { existing: { type: "string" } },
      required: ["existing"],
      allOf: [
        { type: "object", properties: { limit: { type: "number" } }, required: ["limit"] },
        { type: "object", properties: { sort: { type: "string" } } },
      ],
    })).toEqual({
      title: "Search options",
      additionalProperties: false,
      type: "object",
      properties: {
        existing: { type: "string" },
        limit: { type: "number" },
        sort: { type: "string" },
      },
      required: ["existing", "limit"],
    });
  });

  test("nested composition under properties is preserved", () => {
    expect(toolSchema({
      properties: {
        value: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
    })).toEqual({
      type: "object",
      properties: {
        value: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
    });
  });
});
