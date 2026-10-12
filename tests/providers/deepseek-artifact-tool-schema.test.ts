import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import type { OcxParsedRequest } from "../../src/types";

const schema = {
  type: "object",
  properties: {
    id: { type: "string", pattern: "^(?!reserved)[a-z]+$" },
    content: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }] },
    files: { type: "array", items: { type: "string", pattern: "^[a-z]+$" } },
    pattern: { type: "string" },
    anyOf: { type: "string" },
    metadata: { type: "object", default: { pattern: "literal", anyOf: [1, 2] } },
  },
  required: ["id", "content"],
};

function build(baseUrl = "https://api.deepseek.com/v1", name = "Artifact", namespace?: string) {
  const parsed: OcxParsedRequest = {
    modelId: "deepseek-chat",
    context: {
      messages: [{ role: "user", content: "Create an artifact", timestamp: 0 }],
      tools: [{ name, ...(namespace ? { namespace } : {}), parameters: schema, strict: true }],
    },
    stream: false,
    options: {},
  };
  return JSON.parse(createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl, apiKey: "test-key" })
    .buildRequest(parsed).body).tools[0].function;
}

describe("DeepSeek built-in Artifact schema", () => {
  test("relaxes regex and union constraints in the outbound function without mutating input", () => {
    const original = structuredClone(schema);
    const fn = build();
    expect(fn.name).toBe("Artifact");
    expect(fn.parameters).toEqual({
      ...schema,
      properties: { ...schema.properties, id: { type: "string" }, content: {}, files: { type: "array", items: { type: "string" } } },
    });
    expect(fn.strict).toBeUndefined();
    expect(schema).toEqual(original);
  });

  test("leaves other targets and tools unchanged", () => {
    for (const fn of [build("https://api.openai.com/v1"), build("https://api.deepseek.com.example.test/v1"), build(undefined, "Other"), build(undefined, "Artifact", "mcp")]) {
      expect(fn.parameters).toEqual(schema);
      expect(fn.strict).toBe(true);
    }
  });
});
